'use strict';

const { dispatchToApp } = require('../../lib/vercel-handler');

module.exports = async function slackCommands(req, res) {
  return dispatchToApp(req, res, '/slack/commands');
};
