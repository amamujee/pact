'use strict';

const { createCronHandler } = require('../../lib/cron-handler');
const { runReminders } = require('../../lib/jobs/reminders');

module.exports = createCronHandler(runReminders);
