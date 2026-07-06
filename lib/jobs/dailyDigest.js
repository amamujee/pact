'use strict';

const digestRoutes = require('../../routes/digest');
const { requireSlackClient, runTasks } = require('./_helpers');

async function runDailyDigest() {
  const slackClient = await requireSlackClient();
  return runTasks([
    ['daily-morning-digest', () => digestRoutes.runDailyMorningCheck(slackClient)],
  ]);
}

module.exports = { runDailyDigest };
