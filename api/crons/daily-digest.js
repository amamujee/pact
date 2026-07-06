'use strict';

const { createCronHandler } = require('../../lib/cron-handler');
const { runDailyDigest } = require('../../lib/jobs/dailyDigest');

module.exports = createCronHandler(runDailyDigest);
