'use strict';

const digestRoutes = require('../../routes/digest');
const { requireSlackClient, runTasks } = require('./_helpers');

async function runWeeklyDigest() {
  const slackClient = await requireSlackClient();
  return runTasks([
    ['weekly-digest', () => digestRoutes.runWeeklyDigestCheck(slackClient)],
  ]);
}

module.exports = { runWeeklyDigest };
