'use strict';

const { dispatchToApp } = require('../../lib/vercel-handler');

module.exports = async function slackActions(req, res) {
  return dispatchToApp(req, res, '/slack/actions');
};
