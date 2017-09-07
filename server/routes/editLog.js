'use strict'

const { Router } = require('express')
const { UnauthorizedError } = require('../lib/errors')
const { EditLog, flattenDiff } = require('../lib/edit-logs')
const { requiresAuthentication, scopeOrganizationMiddleware } = require('../lib/permissions')
const models = require('../lib/model')
const { fillIncompleteDate } = require('../export/helpers')
const { getAccessMonitoringPaths } = require('../lib/schemas')


const mongoose = require('mongoose')
const _ = require('lodash')

const async = require('async')
const debug = require('debug')('isari:EditLog')

const ObjectId = mongoose.Types.ObjectId

// UTILS

function formatKind(kind){
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

function editLogsPathFilter(path){
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
	return path[0] !== 'latestChangeBy'
}


const editLogsDataKeysBlacklist = ['_id', 'latestChangeBy']




module.exports = Router().get('/:model', requiresAuthentication, scopeOrganizationMiddleware, getEditLog)

function getEditLog(req, res){
	let model = req.params.model
	// params
	const itemID = req.query.itemID
	const query = req.query

	// User has to be central admin to access editLog list feature
	if (!itemID && req.userCentralRole !== 'admin'){
		res.send(UnauthorizedError({ title: 'EditLog is restricted to central admin users'}))
	}

	// User has to have write access on an object to access its editlog
	if(
			(model === 'people' && itemID && !req.userCanEditPeople(itemID)) ||
			(model === 'activity' && itemID && !req.userCanEditActivity(itemID)) ||
			(model === 'organization' && itemID && !req.userCanEditOrganization(itemID))
	){
		res.send(UnauthorizedError({ title: 'Write access is mandatory to access EditLog'}))
	}



	async.waterfall([
		next => {
			if (!query.whoID && (query.isariLab || query.isariRole)){
				//need to retrieve list of targeted creators first
				const mongoQueryPeople = {}
				if (query.isariLab)
					mongoQueryPeople['isariAuthorizedCenters.organization'] = ObjectId(query.isariLab)
				if (query.isariRole)
					mongoQueryPeople['isariAuthorizedCenters.isariRole'] = query.isariRole

				models.People.aggregate([
					{$match:mongoQueryPeople},
					{$project:{_id:1}}
				]).then(whoIds => next(null, whoIds.map(r => r._id)))
			}
			else{
				next(null, undefined)
			}
		},
		(whoIds, next) =>{
			//prepare Item filter organisation scope mongoQuery


			//focusing on one item, scope has been checked earlier
			if (query.itemID)
				return next(null, {whoIds, itemIds: ObjectId(query.itemID)})
			// scope doesn't apply on organizations
			if (model === 'organizations')
				return next(null, {whoIds})
			// scope on people => start/end on academicMemberships
			if (model === 'people'){
				let options = {}
				if (query.startDate || query.endDate){
					options = {includeRange:true,membershipStart:query.startDate,membershipEnd:query.endDate, includeExternals:false, includeMembers:false}
				}
				else
					options = {includeMembers:true, includeRange:false, includeExternals:false}

				req.userListViewablePeople(options).then(ids => {
					debug(ids.query.getQuery())
					return next(null, {whoIds, itemIds: ids.query.getQuery()._id})	
				})
				
			}
			// scope on activities => start/end on activity + organizations
			if (model === 'activities'){
				let options = {}
				if (query.startDate || query.endDate){
					options = {range:true,startDate:query.startDate,endDate:query.endDate}
				}
				else
					options = {range:false}

				req.userListViewableActivities(options).then(mongoquery => {
					if (query.startDate || query.endDate)
						return next(null, {whoIds, itemIds: mongoquery.query.getQuery()['organizations.organization']})	
					else
						mongoquery.query.then(activities => {
							return next(null, {whoIds, itemIds: {$in: activities.map(a => a._id)}})
						})
				})
			}
		},
		(whoIdsItemIds, next) =>{
			// build the mongo query to editLog collection
			const mongoModel = model === 'people' ? 'People' : (model === 'organizations' ? 'Organization' : 'Activity')
			const mongoQuery = {model: mongoModel }
			if (whoIdsItemIds.itemIds)
				mongoQuery.item = whoIdsItemIds.itemIds

			if (query.whoID)
				mongoQuery['whoID'] = ObjectId(query.whoID)
			else
				if (whoIdsItemIds.whoIds)
					mongoQuery['whoID'] = {$in: whoIdsItemIds.whoIds}

			if (query.path || query.accessMonitoring) {
				const paths = getAccessMonitoringPaths(mongoModel, query.accessMonitoring)
					.concat(query.path ? [query.path] : [])
				debug({paths})
				mongoQuery['diff'] = {'$elemMatch': {'$or': paths.map(path=>({path})) }}
			}

			if (query.action)
				mongoQuery['action'] = query.action

			//dates
			if (query.startDate)
				mongoQuery['date'] = {'$gte': new Date(fillIncompleteDate(query.startDate, true))}

			if (query.endDate){
				const endDate = new Date(fillIncompleteDate(query.endDate, false))
				endDate.setHours(23)
				endDate.setMinutes(59)
				if (mongoQuery['date'])
					mongoQuery['date']['$lte'] = endDate
				else
					mongoQuery['date']= {'$lte': endDate}
			}
			let aggregationPipeline = [
				{'$match':mongoQuery},
				{'$lookup':{
					from: 'people',
					localField: 'whoID',
					foreignField: '_id',
					as: 'creator'
				}},
				{'$lookup':{
					from: model === 'people' ? 'people' : (model === 'organizations' ? 'organizations' : 'activities'),
					localField: 'item',
					foreignField: '_id',
					as: 'itemObject'
				}},
				// TODO : project to only usefull fields to limit payload
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

			//count
			if (query.count)
				aggregationPipeline.push({
					'$group': {
						'_id' : null,
						'count' : {$sum : 1}
					}
				})

			// skip and limit
			if (!query.count && query.skip)
				aggregationPipeline.push({'$skip':+query.skip})
			if (!query.count && query.limit)
				aggregationPipeline.push({'$limit':+query.limit})

			EditLog.aggregate(aggregationPipeline)
			.then(data => {
				if (query.count)
					return next(null, data[0])

				next(null, formatEdits(data, model))
			})
		}
	],
		(error,edits) =>{
			if (error) res.status(500).send(error)

			return res.status(200).send(edits)
		}
	)
}

function formatItemName(data, model){
	if (model === 'people' && data){
		return (data.firstName ? data.firstName+' ': '')+ data.name
	}
	else
			if (data)
				return data.acronym || data.name
	return undefined
}

function formatEdits(data, model){
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
		}
		else{
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

		// if (edit.diff.length === 0){
		// 	debug('empty diff in :')
		// 	debug(edit)
		// }
		// else
		edits.push(edit)
	})
	return edits

}

function staffMongoQuery(Organization, centerId, reportPeriod, gradeStatusBlacklist, membershipTypes, callback) {

  async.waterfall([
      next => {// org filter
        let orgFilter = false;
        if (centerId) {
          orgFilter = {organization: ObjectId(centerId)};
          next(null, orgFilter);
        }
        else {
          Organization.aggregate([
            {$match: {isariMonitored: true}},
            {$project: {_id: 1}}
          ]).then(orgs => {
              orgFilter = {organization: {$in: orgs.map(o => o._id)}};
              next(null, orgFilter);
          }
          );
        }
      },
      (orgFilter, next) => {
          const mongoEndDateQuery = {$or: [
                {endDate: {$exists: false}},
                {$and: [{endDate: {$regex: /^.{4}$/}}, {endDate: {$gte: reportPeriod.startDate.slice(0, 4)}}]},
                {$and: [{endDate: {$regex: /^.{7}$/}}, {endDate: {$gte: reportPeriod.startDate.slice(0, 7)}}]},
                {$and: [{endDate: {$regex: /^.{10}$/}}, {endDate: {$gte: reportPeriod.startDate.slice(0, 10)}}]}
                ]};
          const mongoStartDateQuery = {$or: [
                        {startDate: {$exists: false}},
                        {$and: [{startDate: {$regex: /^.{4}$/}}, {startDate: {$lte: reportPeriod.endDate.slice(0, 4)}}]},
                        {$and: [{startDate: {$regex: /^.{7}$/}}, {startDate: {$lte: reportPeriod.endDate.slice(0, 7)}}]},
                        {$and: [{startDate: {$regex: /^.{10}$/}}, {startDate: {$lte: reportPeriod.endDate.slice(0, 10)}}]}
                        ]};
          const gradeStatusQuery = {gradeStatus: {$not: {$in: gradeStatusBlacklist.gradeStatus ? gradeStatusBlacklist.gradeStatus : []}}};
          const gradeQuery = {grade: {$not: {$in: gradeStatusBlacklist.grade ? gradeStatusBlacklist.grade : []}}};
          return next(null, {
                    $and: [
                      {academicMemberships: {
                        $elemMatch: {
                          $and: [
                            orgFilter,
                            {membershipType: {$in: membershipTypes}},
                            mongoStartDateQuery,
                            mongoEndDateQuery
                          ]
                        }
                      }},
                      {grades: {
                        $elemMatch: {
                          $and: [
                            gradeQuery,
                            gradeStatusQuery,
                            mongoStartDateQuery,
                            mongoEndDateQuery
                          ]
                        }
                      }}
                    ]
                  });
        }
    ], (err, query) => {
      callback(err, query);
    });
}