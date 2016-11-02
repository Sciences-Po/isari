'use strict'

const express = require('express')
const cors = require('cors')
const logger = require('morgan')
const session = require('express-session')
const MongoStore = require('connect-mongo')(session)
const config = require('config')
const routes = require('./routes')

// Loaded right here to force schema validation at boot time
const chalk = require('chalk')
const { getFrontSchema, getMongooseSchema } = require('./lib/schemas')
const { getLayout } = require('./lib/layouts')
let errors = []
Object.keys(config.collections).forEach(name => {
	try {
		getMongooseSchema(name)
	} catch (e) {
		process.stderr.write(`\n\n${chalk.bold.red(`Fatal error in schema (mongoose) "${name}"`)}:\n${chalk.red(e.message)}\n\n`)
		errors.push(name)
	}
	try {
		getFrontSchema(name)
	} catch (e) {
		process.stderr.write(`\n\n${chalk.bold.red(`Fatal error in schema (front) "${name}"`)}:\n${chalk.red(e.message)}\n\n`)
		errors.push(name)
	}
	try {
		getLayout(name)
	} catch (e) {
		process.stderr.write(`\n\n${chalk.bold.red(`Fatal error in layout "${name}"`)}:\n${chalk.red(e.message)}\n\n`)
		errors.push(name)
	}
})
if (errors.length > 0) {
	process.stderr.write(`\n\n${chalk.bold.red(`Fatal error in following schemas: ${errors.join(', ')}`)}\n${chalk.red('Check errors above')}\n\n`)
	process.exit(1)
}


const app = module.exports = express()

app.settings['x-powered-by'] = false

app.use(cors({
	origin: true,
	credentials: true
}))

if (config.log.format) {
	app.use(logger(config.log.format))
}

app.use(session({
	secret: config.session.secret,
	resave: true,
	saveUninitialized: false,
	store: new MongoStore({
		url: config.mongo.url,
		ttl: config.session.ttl
	})
}))

// Dev only: to be replaced by NG2 version
app.use('/login', (req, res) => res.sendfile(__dirname + '/login.html'))

app.use('/', routes.index)
app.use('/auth', routes.auth)
app.use('/people', routes.people)
app.use('/organizations', routes.organizations)
app.use('/activities', routes.activities)
app.use('/schemas', routes.schemas)
app.use('/layouts', routes.layouts)
app.use('/enums', routes.enums)
app.use('/columns', routes.columns)

// Error handlers
app.use(routes.errors.notFound)
app.use(routes.errors.serverError(config.http.detailedErrors))
