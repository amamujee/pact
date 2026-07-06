'use strict';

const { createCronHandler } = require('../../lib/cron-handler');
const { runWeeklyDigest } = require('../../lib/jobs/weeklyDigest');

module.exports = createCronHandler(runWeeklyDigest);
