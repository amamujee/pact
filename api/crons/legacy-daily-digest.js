'use strict';

const { createCronHandler } = require('../../lib/cron-handler');
const { runLegacyDailyDigest } = require('../../lib/jobs/legacyDailyDigest');

module.exports = createCronHandler(runLegacyDailyDigest);
