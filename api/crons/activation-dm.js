'use strict';

const { createCronHandler } = require('../../lib/cron-handler');
const { runActivationDm } = require('../../lib/jobs/activationDm');

module.exports = createCronHandler(runActivationDm);
