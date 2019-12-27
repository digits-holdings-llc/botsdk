const MongoClient = require('mongodb').MongoClient;
const { GraphQLClient } = require('graphql-request');
const SUBDOMAIN = process.env.SUBDOMAIN;
const MONGO_CLUSTER_URL = process.env.MONGO_CLUSTER_URL;
const MONGO_URL = `${MONGO_CLUSTER_URL}/${SUBDOMAIN}/?retryWrites=true&w=majority` || `mongodb://localhost:27017/${SUBDOMAIN}`;
const yaml = require('js-yaml');
const fs = require('fs');
const _ = require('lodash');
const os = require('os');
const axios = require('axios');
const shortid = require('shortid');
const cookieSession = require('cookie-session');
const { spawn } = require('child_process');
const reqPath = '/login';
const logoutPath = '/logout';

console.log('Bot SDK starting with MONGO_URL ' + MONGO_URL);
const instanceId = shortid.generate();
console.log('Session starting with ID ', instanceId);
const startedAt = Date().toString();

// On startup, check to see if there's a configuration in the database.
// If there isn't, read the local YAML file (if any) and insert it
const client = new MongoClient(MONGO_URL, { useNewUrlParser: true, useUnifiedTopology: true });
module.exports.client = client;

async function checkConfig() {
  let config;
  try {
    await client
      .connect()
      .catch(err => {
        console.log('Mongo Client Connect error', err);
      })
      .then(result => {
        console.log('SDK Connected');
      });

    const db = client.db(SUBDOMAIN);
    const configColl = db.collection('config');
    config = await configColl.findOne();
    console.log(config);

    if (!config) {
      // read the yaml, convert to JSON
      // Stick it in the config database
      const doc = yaml.safeLoad(fs.readFileSync('./config.yaml', 'utf8'));

      // If there isn't a unique_id in the config, add one
      if (!doc.unique_id) {
        doc.unique_id = shortid.generate();
      }
      await configColl.insertOne(doc);
      config = doc;
    }
  } catch (err) {
    console.log(err);
  }
  return config;
}

async function fetchConfig() {
  let config;
  try {
    const db = client.db(SUBDOMAIN);
    const configColl = db.collection('config');
    config = await configColl.findOne();
  } catch (err) {
    console.log(err);
  }
  return config;
}

async function notify(dst, txt) {
  if (!client) {
    return;
  }
  try {
    const db = client.db(SUBDOMAIN);
    const collection = db.collection('config');
    const systemConfig = await collection.findOne();
    const graphQLClient = new GraphQLClient(systemConfig.url, {
      headers: {
        'x-api-token': systemConfig.authorization,
        'Content-Type': 'application/json',
        Host: systemConfig.host
      }
    });

    const query = `
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
      `;
    graphQLClient
      .request(query)
      .then(data => console.log('GraphQL returns ', data))
      .catch(error => console.log('GraphQL error: ', JSON.stringify(error, undefined, 2)));
  } catch (err) {
    console.log('Error caught in notify function');
    console.log(err);
  } finally {
    console.log('Notify ends');
  }
}

const updateConfig = async function(request, response) {
  await saveConfigData(request.body);
  response.redirect('/config');
};

const updateConfigJson = async function(request, response) {
  const error = await saveConfigData(request.body);

  if (error) {
    response.sendStatus(500);
  } else {
    response.sendStatus(200);
  }
};

async function saveConfigData(json) {
  let hasError = false;

  try {
    const db = client.db(SUBDOMAIN);
    const configColl = db.collection('config');
    await configColl.updateMany({}, { $set: json });
  } catch (err) {
    hasError = true;
    console.log(err);
  }

  return hasError;
}

const clearCollection = async function(request, response) {
  if (!client) {
    return;
  }
  try {
    const db = client.db(SUBDOMAIN);
    const col = await db.collection(request.params.collection);

    if (col) {
      await col.deleteMany({});
    }
  } catch (err) {
    console.log('Error caught in trace function');
    console.log(err);
  }

  response.redirect('/config');
};

const getConfig = async function(request, response) {
  config = request.config;
  delete config._id;

  // iterate over the keys of the config object
  // and make a label for each one
  config.labels = {};
  for (const prop in config) {
    config.labels[prop] = _.startCase(prop);
  }

  const collections = await getAllMongoCollections();

  response.render('config', { title: 'Workforce Automation Demo', config, collections: collections });
};

async function getAllMongoCollections() {
  if (!client) {
    return;
  }
  try {
    const db = client.db(SUBDOMAIN);
    const result = await db.listCollections().toArray();

    for (let i = 0; i < result.length; i++) {
      const name = result[i].name;
      const col = await db.collection(name);
      result[i] = await col.stats();
      result[i].name = name;
      result[i].size = (result[i].size / 1024 / 1024).toFixed(3);
    }

    return result.sort(function(a, b) {
      return a.name > b.name ? 1 : a.name < b.name ? -1 : 0;
    });
  } catch (err) {
    console.log('Error caught in trace function');
    console.log(err);
  }
}

const getConfigJson = async function(request, response) {
  config = request.config;
  delete config._id;

  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(config));
};

const getMetaData = async function(request, response) {
  const metaData = require('./package.json');

  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(metaData));
};

const notifyReq = async function(request, response) {
  notify(request.body.cell, request.body.text);
  response.redirect('/');
};

const configMiddleware = (req, res, next) => {
  const config = fetchConfig();
  config.then(config => {
    req.config = config;
    next();
  });
};

const trace = async (req, resp, next) => {
  if (req.config.trace && req.config.trace.toUpperCase().trim() != 'TRUE') {
    return next();
  }

  if (!client) {
    return;
  }
  try {
    const db = client.db(SUBDOMAIN);
    const msgColl = db.collection('messages');
    const custColl = db.collection('customers');
    const sessColl = db.collection('sessions');
    const teamColl = db.collection('teams');
    const { type, msg, customer, session, team } = req.body;
    if (type == 'new_message') {
      msgColl.insertOne(msg);
      custColl.updateOne({ _id: customer._id }, { $set: { customer } }, { upsert: true });
      sessColl.updateOne({ _id: session._id }, { $set: { session } }, { upsert: true });
      teamColl.updateOne({ _id: team._id }, { $set: { team } }, { upsert: true });
    }
    next();
  } catch (err) {
    console.log('Error caught in trace function');
    console.log(err);
  } finally {
    console.log('Notify ends');
  }
};
module.exports.notify = notify;
module.exports.log = console.log;

const checkPassword = function(req, res, next) {
  if (req.config.password) {
    if (!req.session.authorized) {
      if (req.path != reqPath) {
        res.redirect(reqPath);
      }
    }
  }
  next();
};

const loginPage = function(req, res, next) {
  res.render('login');
};

const loginValidate = function(req, res, next) {
  if (req.body.password == req.config.password) {
    req.session.authorized = true;
    res.redirect('/');
  } else {
    res.redirect(reqPath);
  }
  next();
};

const logout = function(req, res, next) {
  req.session = null;
  res.redirect(reqPath);
};

async function registerBot(config) {
  // See if there's any configuration item called "server"
  if (!config.server) {
    // No one to register with. Go home
    return;
  }
  config.server.split(',').forEach(server => {
    serverUrl = server.trim();
    const metaData = require('./package.json');
    serverData = {
      config,
      metaData,
      instanceId,
      startedAt
    };
    axios
      .post(serverUrl, serverData)
      .then(res => {
        console.log('Registered automation with ', serverUrl);
      })
      .catch(error => {
        console.log('Error registering with ', serverUrl);
        console.error(error);
      });
  });
}

module.exports.init = async (app, http) => {
  // On startup, check to see if we have a config
  // document in config collection in the database. If we do not,
  // read the local config.yaml and create one.
  let config = checkConfig();

  // Need cookies for authentication
  app.set('trust proxy', 1); // trust first proxy
  app.use(
    cookieSession({
      name: 'session',
      keys: ['key1', 'key2']
    })
  );

  // We need to add our views directory
  const views = [];
  views.push(app.get('views'));
  views.push('node_modules/greenbot-sdk/views');
  app.set('views', views);
  app.set(views);

  // Register the handler that adds the configuration
  // to the request object
  app.use(configMiddleware);

  // Register SDK routes in the web server
  app.post('/config', updateConfig);
  app.get('/config', getConfig);
  app.get('/config.json', getConfigJson);
  app.get('/config/clear/:collection', clearCollection);
  app.get('/metadata.json', getMetaData);
  app.post('/notify', notifyReq);
  app.post('/config.json', updateConfigJson);
  app.use('/', trace);
  app.get('/log', function(request, response) {
    response.render('log');
  });

  // Sets up the password middleware.
  // if a password entry is found in the "config",
  // check visitors at the door
  app.use(checkPassword);
  app.get(reqPath, loginPage);
  app.post(reqPath, loginValidate);
  app.get(logoutPath, logout);

  // See if there are servers we have to register with
  registerBot(config);
  config.then(result => {
    // Finally, if there is a server_heartbeat parameter, setup a
    // periodic timer to register the bot
    if (result.server_heartbeat) {
      const intervalSec = parseInt(result.server_heartbeat);
      console.log('Periodically registering every ', intervalSec, ' seconds.');
      setInterval(registerBot, intervalSec * 1000);
    }
  });
};
