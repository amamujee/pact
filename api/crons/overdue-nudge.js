'use strict';

const { createCronHandler } = require('../../lib/cron-handler');
const { runOverdueNudge } = require('../../lib/jobs/overdueNudge');

module.exports = createCronHandler(runOverdueNudge);
