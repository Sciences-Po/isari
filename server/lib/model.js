'use strict'

const mongoose = require('mongoose')
const { getSchema } = require('./schemas')
const config = require('config')

// Use native promises with Mongoose
mongoose.Promise = Promise


module.exports = {
	People:       model('People'),
	Activity:     model('Activity'),
	Organization: model('Organization'),
	connect
}


function model (name) {
	const desc = getSchema(name)
	const schema = new mongoose.Schema(desc, {
		strict: 'throw'
	})
	return mongoose.model(name, schema)
}

function connect (url = null) {
	return new Promise((resolve, reject) => {
		mongoose.connect(url || config.mongo.url, e => e ? reject(e) : resolve(mongoose.connection))
	})
}
