var MongoClient = require('mongodb').MongoClient
const { GraphQLClient } = require('graphql-request')
const mongoURL = process.env.MONGO_URL || 'mongodb://localhost:27017/wfa'
const parts = mongoURL.split("/")
const DB_NAME = parts[parts.length - 1]
const yaml = require('js-yaml')
const fs   = require('fs')
const _ = require('lodash')
const os = require('os')
const cookieSession = require('cookie-session')
const reqPath = "/login"
const logoutPath = "/logout"

console.log("Bot SDK starting with MONGO_URL " + mongoURL)

// On startup, check to see if there's a configuration in the database.
// If there isn't, read the local YAML file (if any) and insert it
async function checkConfig() {
  const client = await MongoClient.connect(mongoURL).catch(err => {console.log("Mongo Client Connect error", err)})
  try {
    const db = client.db(DB_NAME)
    let configColl = db.collection('config')
    var config = await configColl.findOne()
    if (!config) {
      // read the yaml, convert to JSON
      // Stick it in the config database
      var doc = yaml.safeLoad(fs.readFileSync('./config.yaml', 'utf8'));
      await configColl.insertOne(doc);
      console.log("Initialized with config ", config)
    } else {
      console.log("Starting with config ", config)
    }
  } catch (err) {
    console.log(err);
  } finally {
    client.close();
  }
}

async function fetchConfig() {
  const client = await MongoClient.connect(mongoURL).catch(err => {console.log("Mongo Client Connect error", err)})
  try {
    const db = client.db(DB_NAME)
    let configColl = db.collection('config')
    var config = await configColl.findOne()
  } catch (err) {
    console.log(err);
  } finally {
    client.close();
  }
  return config
}

async function notify(dst, txt) {
  const client = await MongoClient.connect(mongoURL, { useNewUrlParser: true }).catch(err => {console.log("Mongo Client Connect error", err)})
  if (!client) {
    return;
  }
  try {
    const db = client.db(DB_NAME)
    let collection = db.collection('config')
    let systemConfig = await collection.findOne()
    const graphQLClient = new GraphQLClient(systemConfig.url, {
      headers: {
        "x-api-token": systemConfig.authorization,
        'Content-Type': 'application/json',
        'Host': systemConfig.host,
        },
    })

    const query =
      `
      mutation {
        addMessage(
          messageInput: {
            text: "${txt}",
            handle: "${systemConfig.networkHandle}",
            destination: "${dst}"
          }
        )
        {
          _id
        }
      }
      `
    graphQLClient.request(query)
      .then(data => console.log("GraphQL returns ", data))
      .catch(error => console.log("GraphQL error: ",JSON.stringify(error, undefined, 2)))

  } catch (err) {
    console.log("Error caught in notify function")
    console.log(err);
  } finally {
    client.close();
    console.log("Notify ends")
  }
}

var updateConfig = async function(request, response) {
  await saveConfigData(request.body)
  response.redirect("/config")
}

var updateConfigJson = async function(request, response) {
  var error = await saveConfigData(request.body)

  if (error) {
    response.sendStatus(500)
  }
  else {
    response.sendStatus(200)
  }
}

async function saveConfigData(json) {
  const client = await MongoClient.connect(mongoURL).catch(err => {console.log("Mongo Client Connect error", err)})
  var hasError = false;

  try {
    const db = client.db(DB_NAME)
    let configColl = db.collection('config')
    await configColl.updateMany({}, { $set: json} )
  } catch (err) {
    hasError = true;
    console.log(err);
  } finally {
    client.close();
  }

  return hasError
}

var getConfig = async function(request, response) {
  config = request.config
  delete config._id

  // iterate over the keys of the config object
  // and make a label for each one
  config.labels = {}
  for(const prop in config) {
    config.labels[prop] = _.startCase(prop)
  }
  response.render('config', { title: 'Workforce Automation Demo', config })
}

var getConfigJson = async function(request, response) {
  config = request.config
  delete config._id

  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(config))
}

var getMetaData = async function(request, response) {
  var metaData = require('./package.json')

  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(metaData))
}

var notifyReq = async function(request, response) {
  notify(request.body.cell, request.body.text)
  response.redirect("/")
  }

var configMiddleware = (req, res, next) => {
  var config = fetchConfig()
  config.then((config) => {
    req.config = config
    next()
  })
}

var trace = async (req, resp, next) => {
  if(req.config.trace && req.config.trace.toUpperCase().trim() != "TRUE") {
    return next()
  }

  const client = await MongoClient.connect(mongoURL, { useNewUrlParser: true }).catch(err => {console.log("Mongo Client Connect error", err)})
  if (!client) {
    return;
  }
  try {
    const db = client.db(DB_NAME)
    let msgColl = db.collection('messages')
    let custColl = db.collection('customers')
    let sessColl = db.collection('sessions')
    let teamColl = db.collection('teams')
    var inboundEvent = req.body
    if (inboundEvent.type == 'new_message') {
      msgColl.insertOne(inboundEvent.msg)
      custColl.update({_id: inboundEvent.customer._id}, inboundEvent.customer, {upsert: true})
      sessColl.insertOne({_id: inboundEvent.session._id}, inboundEvent.session, {upsert: true})
      teamColl.insertOne({_id: inboundEvent.team._id}, inboundEvent.team, {upsert: true})
    }
    next()
  } catch (err) {
    console.log("Error caught in trace function")
    console.log(err);
  } finally {
    client.close();
    console.log("Notify ends")
  }
}
module.exports.notify = notify
module.exports.log = console.log

 
const checkPassword = function (req, res, next) {
  if (req.config.password) {
    if (!req.session.authorized) {
      if (req.path != reqPath) {
        res.redirect(reqPath)
      }
    }
  }
  next()
}

const loginPage = function (req, res, next) {
  res.render('login')
}
 
const loginValidate = function (req, res, next) {
  if (req.body.password == req.config.password) {
    req.session.authorized = true
    res.redirect("/")
  } else {
    res.redirect(reqPath)
  }
  next()
}

const logout = function (req, res, next) {
  req.session = null
  res.redirect(reqPath)
}

module.exports.init = (app, http) => {
  checkConfig()
  app.set('trust proxy', 1) // trust first proxy
  app.use(cookieSession({
    name: 'session',
    keys: ['key1', 'key2']
  }))

  // We need to add our views directory
  var views = []
  views.push(app.get('views'))
  views.push('node_modules/greenbot-sdk/views')
  app.set('views', views)
  app.set(views)
  app.use(configMiddleware)
  app.post('/config', updateConfig)
  app.get('/config', getConfig)
  app.get('/config.json', getConfigJson)
  app.get('/metadata.json', getMetaData)
  app.post('/notify', notifyReq)
  app.post('/config.json', updateConfigJson)
  app.use('/', trace)
  app.get('/log', function(request, response) {
    response.render("log")
  })
  app.use(checkPassword)
  app.get(reqPath, loginPage)
  app.post(reqPath, loginValidate)
  app.get(logoutPath, logout)

}
