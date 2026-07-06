'use strict';

const { dispatchToApp } = require('../../lib/vercel-handler');

module.exports = async function stripeWebhook(req, res) {
  return dispatchToApp(req, res, '/api/webhooks/stripe');
};
