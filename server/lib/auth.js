'use strict'

const config = require('config')
const { connect, search, bind, unbind } = require('./ldap')
const { People } = require('./model')


module.exports = config.ldap.skip ? magicAuth() : connectedAuth()


function magicAuth () {
	return login => Promise.resolve(login).then(ldapUidToPeople)
}

function connectedAuth () {
	const baseClient = connect()

	return (login, password) => baseClient
		// Search for user
		.then(search(config.ldap.dn, { scope: 'sub', filter: `(uid=${login})` }))
		// Found user?
		.then(entries => entries.length === 0
			? Promise.reject(Error('LDAP User Not Found'))
			: entries.find(e => e.uid === login)
		)
		// Is user active?
		.then(entry => !Number(entry[config.ldap.activeFlag])
			? Promise.reject(Error('User Not Active'))
			: entry
		)
		// Try to use user's password to bind a new client
		.then(entry => connect().then(bind(entry.dn, password)).then(unbind))
		// Then try to find associated People entry
		.then(() => ldapUidToPeople(login))
}

function ldapUidToPeople (ldapUid) {
	return People.findOne({ ldapUid }).then(found => found || Promise.reject(Error('People Not Found')))
}