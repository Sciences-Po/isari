'use strict'

const { restRouter } = require('../lib/rest-utils')
const { People } = require('../lib/model')
const { format } = require('../lib/model-utils')
const { getPermissions } = require('../lib/permissions')


const formatObject = (p, perms) => format('People', p, perms)

// Default ?include = members + externals
const buildListQuery = (req) => req.userListViewablePeople({
	includeExternals: !req.query.include || req.query.include === 'both' || req.query.include === 'externals',
	includeMembers: !req.query.include || req.query.include === 'both' || req.query.include === 'members'
})

module.exports = restRouter(People, formatObject, 'people', getPermissions.People, buildListQuery)
