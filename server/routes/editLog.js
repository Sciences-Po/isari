'use strict'

const { Router } = require('express')
const { UnauthorizedError, NotFoundError, ServerError } = require('../lib/errors')
const { EditLog, flattenDiff } = require('../lib/edit-logs')
const { requiresAuthentication, scopeOrganizationMiddleware } = require('../lib/permissions')
const models = require('../lib/model')
const { fillIncompleteDate } = require('../export/helpers')
const { getAccessMonitoringPaths, computeConfidentialPaths } = require('../lib/schemas')
const config = require('config')


const mongoose = require('mongoose')
const _ = require('lodash')

const debug = require('debug')('isari:EditLog')

const ObjectId = mongoose.Types.ObjectId

// UTILS

const formatKind = kind => {
// edit logs object kind attribute formatting
	if (kind === 'E')
		return 'update'
	if (kind === 'D')
		return 'delete'
	if (kind === 'N')
		return 'create'
	//by default fall back to update
	return 'update'
}


const editLogsPathFilter = path =>
	// blacklisting weird diff generated by edtiLogs middleware or internal fields
	// This filtering should be done in mongo direclty to avoid problems with pagination
	// Turning those filter in mongo might be possible with $filter
	// This doesn't work :
	//  $filter:{
	//    input:'$diff',
	//    as:'d',
	//    cond:{$not:{$and:[
	//        {'$$d.path.3':{$exists: true}},
	//        {'$$d.path.0':'academicMemberships'},
	//        {'$$d.path.2':'organization'}
	//        ]}}
	// }
	path[0] !== 'latestChangeBy'


const editLogsDataKeysBlacklist = ['_id', 'latestChangeBy']


const routeParamToModel = param => ({
	activities: 'Activity',
	organizations: 'Organization',
	people: 'People',
}[param])


const validateParams = ({ model, itemID, req }) => Promise.resolve()
	// Check validity of model param
	.then(() => {
		if (!model) {
			throw new NotFoundError({ title: 'Invalid model' })
		}
	})
	// User has to be central admin to access editLog list feature
	.then(() => {
		if (!itemID && req.userCentralRole !== 'admin'){
			throw new UnauthorizedError({ title: 'EditLog is restricted to central admin users'})
		}
	})
	// User has to have write access on an object to access its editlog
	.then(() => {
		if (itemID) {
			return models[model].findById(itemID).then(req['userCanEdit' + model]).then(ok => {
				if (!ok) {
					throw new UnauthorizedError({ title: 'Write access is mandatory to access EditLog'})
				}
			})
		}
	})


const findWhoIds = query => () => {
	if (query.isariLab || query.isariRole) {
		//need to retrieve list of targeted creators first
		const mongoQueryPeople = {}
		if (query.isariLab)
			mongoQueryPeople['isariAuthorizedCenters.organization'] = ObjectId(query.isariLab)
		if (query.isariRole)
			mongoQueryPeople['isariAuthorizedCenters.isariRole'] = query.isariRole

		return models.People.aggregate([
			{$match:mongoQueryPeople},
			{$project:{_id:1}}
		]).then(whos => whos.map(r => r._id))
	} else {
		return undefined
	}
}


const getOrgIdsCentral = () =>
	models.Organization
	.find({isariMonitored: true}, {_id: 1})
	.then(orgs => orgs.map(o => o._id))

const getOrgIdsRoles = userRoles =>
	models.Organization
	.find({ _id: { $in: Object.keys(userRoles).map(ObjectId) }}, {_id: 1})
	.then(orgs => orgs.map(o => o._id))

const getOrgIds = req =>
	Promise.resolve(req.userScopeOrganizationId && ObjectId(req.userScopeOrganizationId))
	.then(orgId => orgId
		? [orgId] // Scoped: limit to people from this organization
		: req.userCentralRole
			? getOrgIdsCentral() // Central user: access to EVERYTHING
			: getOrgIdsRoles(req.userRoles) // Limit to people from organizations he has access to
	)


const getDateQuery = (date, fieldPrefix) => {
	if (!date) return null
	const field = fieldPrefix + 'Date'
	return { $or: [
		{[field]: {$exists: false}},
		{$and: [{[field]: {$regex: /^.{4}$/}}, {[field]: {$gte: date.slice(0, 4)}}]},
		{$and: [{[field]: {$regex: /^.{7}$/}}, {[field]: {$gte: date.slice(0, 7)}}]},
		{$and: [{[field]: {$regex: /^.{10}$/}}, {[field]: {$gte: date.slice(0, 10)}}]}
	]}
}


const findPeopleItemIds = (query, req) => {
	const orgIdsP = getOrgIds(req)
	const endQuery = getDateQuery(query.startDate, 'end')
	const startQuery = getDateQuery(query.endDate, 'start')

	const academicMembershipsQueryP = orgIdsP.then(orgIds => ({ $elemMatch: {
		$and: [{organization: {$in: orgIds}}]
			//.concat([{membershipType: {$in: membershipTypes}}]),
			.concat(startQuery ? [startQuery] : [])
			.concat(endQuery ? [endQuery] : [])
	}}))

	const deletedEditsP = academicMembershipsQueryP.then(q => models.EditLog.find({
		model: 'People',
		action: 'delete',
		'data.academicMemberships': q,
	}, {item:1}))

	const peopleP = academicMembershipsQueryP.then(q => models.People.find({
		academicMemberships: q,
	}, {_id:1}))

	return Promise.all([peopleP, deletedEditsP]).then(([people, deletedEdits]) => {
		return people.map(p => p._id)
			.concat(deletedEdits.map(e => e.item))
	})
}


const findActivityItemIds = (query, req) => {
	const orgIdsP = getOrgIds(req)

	const getQuery = isEditLog => {
		const prefix = isEditLog ? 'data.' : ''
		const endQuery = getDateQuery(query.startDate, prefix + 'end')
		const startQuery = getDateQuery(query.endDate, prefix + 'start')
		const orgField = prefix + 'organizations.organization'
		return orgIdsP.then(orgIds => ({ $and:
			[{[orgField]: {$in: orgIds}}]
			.concat(startQuery ? [startQuery] : [])
			.concat(endQuery ? [endQuery] : [])
		}))
	}

	const deletedEditsP = getQuery(true).then(q => models.EditLog.find(Object.assign({
		model: 'Activity',
		action: 'delete',
	}, q), {item:1}))

	const activitiesP = getQuery(false).then(q => models.Activity.find(q, {_id:1}))

	return Promise.all([activitiesP, deletedEditsP]).then(([activities, deletedEdits]) => {
		return activities.map(p => p._id)
			.concat(deletedEdits.map(e => e.item))
	})
}


const findItemIds = (query, model, req) => () => {
	//prepare Item filter organisation scope mongoQuery
	//focusing on one item, scope has been checked earlier
	if (query.itemID)
		return ObjectId(query.itemID)
	// scope doesn't apply on organizations
	if (model === 'Organization')
		return undefined
	// scope on people => start/end on academicMemberships
	else if (model === 'People')
		return findPeopleItemIds(query, req)
	// scope on activities => start/end on activity + organizations
	else if (model === 'Activity')
		return findActivityItemIds(query, req)
	// should not happen, invalid name of model
	else
		return Promise.reject(Error('Invalid model "' + model + '" in findItemIds'))
}


const EMPTY_RESULT = { count: 0, logs: [] }


const findEdits = (model, query, whoIds, itemIds, canViewConfidential) => {
	// build the mongo query to editLog collection
	const mongoQuery = {model}

	if (itemIds)
		mongoQuery.item = {$in: itemIds}

	if (whoIds) {
		if (query.whoID && !whoIds.some(id => String(id) === query.whoID)) {
			// Conflicting filters: return empty result
			return EMPTY_RESULT
		}
		mongoQuery['whoID'] = {$in: whoIds}
	} else if (query.whoID) {
		mongoQuery['whoID'] = ObjectId(query.whoID)
	}

	if (query.path || query.accessMonitoring) {
		const paths1 = query.accessMonitoring ? getAccessMonitoringPaths(model, query.accessMonitoring) : []
		const paths2 = query.path ? [query.path] : []
		const paths = paths1.concat(paths2)
		debug({paths})
		if (paths.length > 0){
			if (query.action === 'create' || query.action === 'delete') {
				// Append to existing root $or conditions (or create new one)
				mongoQuery['$or'] = (mongoQuery['$or'] || []).concat(paths.map(path => ({ ['data.' + path]: {$exists: true} })))
			} else {
				mongoQuery['diff'] = {'$elemMatch': {'$or': paths.map(path=>({path})) }}
			}
		}
		else
			// accessMonitoring filter on but no fields in schema => return  nothing
			return EMPTY_RESULT
	}

	// Filter diffs which contain ONLY confidential changes
	// Note: we don't check for create/delete, assuming there can't be creation involving ONLY confidential fields
	if (!canViewConfidential && (!query.action || query.action === 'update')) {
		/*
		The main difficulty here is dealing with paths as arrays. Let's write it all down to make it simpler.
		confidential paths = [ 'x.*.y', 'm.n' ]
		We want to EXLUDE all edits whose diff contains ONLY changes on confidential paths
		(thank you mongodb for the headache)

		I want edits whose NOT ALL changes are confidential
		.find({ subdocs: { $elemMatch: matchPath } }) → all edits with SOME confidential changes
		.find({ subdocs: { $not: { $elemMatch: matchPath } }) → all edits with NOT confidential change

		Final query:
		{ diff: { $not: { $elemMatch: { $or: [
			{ 'path.0': 'x', 'path.2': 'y' },
			{ 'path.0': 'm', 'path.1': 'n' },
		]}}}}

		Note that there can already be a query on 'diff', just merge it.
		{ diff: { old, $not: … }}
		If there is already a query on diff.$not, we'll have to merge it smartly:
		!x && !y → !(x || y), so it becomes:
		{ diff: { $not: { $or: [oldquery, newquery] }}}
		*/
		// [ 'p1.*.p2', 'p3.p4' ] → [ {$or:[path.0≠p1, path.2≠p2]}, {$or:[path.0≠p3, path.1≠p4]} ]
		const matchPathString = path =>
			path.split('.')
			.reduce((q, p, i) => p === '*' ? q : Object.assign(q, { ['path.' + i]: p }), {})

		const isConfidential = {
			'$or': computeConfidentialPaths(model).map(matchPathString)
		}

		if (!mongoQuery['diff']) {
			mongoQuery['diff'] = { '$not': { '$elemMatch': isConfidential } }
		} else if (!mongoQuery['diff']['$not']) {
			mongoQuery['diff']['$not'] = { '$elemMatch': isConfidential }
		} else {
			const oldCond = mongoQuery['diff']['$not']
			mongoQuery['diff']['$not'] = { '$or': [ isConfidential, oldCond ] }
		}
	}

	if (query.action)
		mongoQuery['action'] = query.action

	//dates
	if (query.startDate){
		const sd = new Date(fillIncompleteDate(query.startDate, true))
		mongoQuery['date'] = {'$gte': sd}
		if (!query.endDate) {
			const ed = new Date(sd.getTime())
			ed.setHours(23)
			ed.setMinutes(59)
			mongoQuery['date']['$lte'] = ed
		}
	}

	if (query.endDate){
		const endDate = new Date(fillIncompleteDate(query.endDate, false))
		endDate.setHours(23)
		endDate.setMinutes(59)
		if (mongoQuery['date'])
			mongoQuery['date']['$lte'] = endDate
		else
			mongoQuery['date']= {'$lte': endDate}
	}

	debug('Query', mongoQuery)
	let aggregationPipeline = [
		{'$match':mongoQuery},
		{'$lookup':{
			from: 'people',
			localField: 'whoID',
			foreignField: '_id',
			as: 'creator'
		}},
		{'$lookup':{
			from: config.collections[model],
			localField: 'item',
			foreignField: '_id',
			as: 'itemObject'
		}},
		{'$project':{
			whoID:1,
			date:1,
			item:1,
			diff:1,
			data:1,
			action:1,
			'itemObject.name':1,
			'itemObject.firstName':1,
			'itemObject.acronym':1,
			'creator.firstName':1,
			'creator.name':1,
			'creator.isariAuthorizedCenters':1
		}},
		{'$sort':{date:-1}}
	]

	// skip and limit
	const resultsPipeline = aggregationPipeline
		.concat(query.skip ? [{'$skip':+query.skip}] : [])
		.concat(query.limit ? [{'$limit':+query.limit}] : [])

	// count
	const countPipeline = aggregationPipeline
		.concat([{'$group': { '_id' : null, 'count' : {$sum : 1} }}])

	const countP = EditLog.aggregate(countPipeline)
		.then(data => (data && data[0] && data[0].count) || 0)
	const resultsP = EditLog.aggregate(resultsPipeline)
		.then(data => formatEdits(data, model, !canViewConfidential))

	return Promise.all([ countP, resultsP ])
		.then(([ count, results ]) => ({ count, results }))
}


const formatItemName = (data, model) => {
	if (model === 'People' && data) {
		return (data.firstName ? data.firstName+' ': '')+ data.name
	} else if (data) {
		return data.acronym || data.name
	} else {
		return undefined
	}
}


const formatEdits = (data, model, removeConfidential) => {
	const edits = []
	data.forEach(d => {
		const edit = {}
		edit.who = {
			id: d.whoID
		}
		if (d.creator.length){
			edit.who.name = (d.creator[0].firstName ? d.creator[0].firstName+' ': '')+ d.creator[0].name
			edit.who.roles = d.creator[0].isariAuthorizedCenters ?
							d.creator[0].isariAuthorizedCenters.map(iac =>({lab:iac.organization,role:iac.isariRole})):
							[]
		}

		edit.date = d.date
		edit.item = { id:d.item}
		edit.item.name = formatItemName(d.itemObject[0], model)

		edit.action = d.action

		if (edit.action === 'update'){
			edit.diff = flattenDiff(d.diff)
									.filter(dd => editLogsPathFilter(dd.path))
									.map(dd => {
										// remove index of element in array from path
										const diff = {path: dd.path.filter(e => isNaN(parseInt(e)))}

										if (dd.kind === 'A'){
											//array case...
											if (dd.item.lhs)
												diff.valueBefore = dd.item.lhs
											if(dd.item.rhs)
												diff.valueAfter = dd.item.rhs
											diff.editType = formatKind(dd.item.kind)
										}
										else {
											if (dd.lhs)
												diff.valueBefore = dd.lhs
											if( dd.rhs)
												diff.valueAfter = dd.rhs
											diff.editType = formatKind(dd.kind)
										}
										return diff
									})
		} else {
			edit.diff = []
			// in case of create or delete diff data is stored in data
			if (!edit.item.name)
				edit.item.name = formatItemName(d.data, model)
			_.forOwn(d.data, (value,key) => {
				// we filter tecnical fields
				if (!editLogsDataKeysBlacklist.includes(key)){
					const diff = {
						editType: d.action,
						path: [key]
					}
					// store in value After or Before as other diffs
					diff[d.action === 'create' ? 'valueAfter' : 'valueBefore'] = value
					edit.diff.push(diff)
				}
			})
		}

		// Handle confidential changes
		const test = isNotConfidentialChange(model)
		if (removeConfidential) {
			edit.diff = edit.diff.filter(test)
		}
		edit.diff = edit.diff.map(change => test(change)
			? change
			: Object.assign({}, change, { confidential: true }))

		// Handle accessMonitoring on changes
		edit.diff = getAccessMonitorings(model, edit.diff)

		// TEMPFIX FOR CLIENT
		edit.accessMonitorings = Array.from(edit.diff.reduce((vs, d) => d.accessMonitoring ? vs.add(d.accessMonitoring) : vs, new Set()))

		// if (edit.diff.length === 0){
		// 	debug('empty diff in :')
		// 	debug(edit)
		// }
		// else
		edits.push(edit)
	})
	debug(edits)
	return edits
}


const getAccessMonitorings = (model, formattedDiff) => {
	const paths = getAccessMonitoringPaths(model)
	return formattedDiff.map(change => Object.assign({}, change, {
		accessMonitoring: paths[change.path[0]]
	}))
}


const isNotConfidentialChange = model => {
	const paths = computeConfidentialPaths(model)
		// Remove all '.*' from schema path, as collection indices won't appear in formatted change
		// Also add a final dot to compare proper paths and avoid confusion with field with same prefix
		.map(path => path.replace(/\.\*/g, '') + '.')
	return change => {
		const currPath = change.path.join('.') + '.'
		const isConfidential = paths.some(confidentialPath => {
			//console.log({confidentialPath, currPath, matches: currPath.startsWith(confidentialPath)})
			return currPath.startsWith(confidentialPath)
		})
		if (isConfidential) {
			debug('Filtered confidential change', change)
		}
		return !isConfidential
	}
}


const getEditLogs = (req, res) => {
	const model = routeParamToModel(req.params.model)
	const query = req.query

	const validParamsP = validateParams({ model, itemID: req.query.itemID, req })
	const whoIdsP = validParamsP.then(findWhoIds(query))
	const itemIdsP = validParamsP.then(findItemIds(query, model, req))

	// Mainly for debugging purpose, you can force confidential fields filtering
	// by adding ?noConfidential=1
	const canViewConfidentialP = query.noConfidential
		? Promise.resolve(false)
		: req.userCanViewConfidentialFields()

	return Promise.all([ whoIdsP, itemIdsP, canViewConfidentialP ])
		.then(([whoIds, itemIds, canViewConfidential]) => findEdits(model, query, whoIds, itemIds, canViewConfidential))
		.then(edits => res.status(200).send(edits))
		.catch(err => {
			console.error(err) // eslint-disable-line no-console
			if (!err.status) {
				err = new ServerError({ title: err.message })
			}
			res.status(err.status).send(err)
		})
}



module.exports = Router().get('/:model', requiresAuthentication, scopeOrganizationMiddleware, getEditLogs)
