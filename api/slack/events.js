'use strict';

const { dispatchToApp } = require('../../lib/vercel-handler');

module.exports = async function slackEvents(req, res) {
  return dispatchToApp(req, res, '/slack/events');
};
