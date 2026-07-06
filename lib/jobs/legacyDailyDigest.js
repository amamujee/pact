'use strict';

const slackHandlers = require('../slack-handlers');
const { requireSlackClient, runTasks } = require('./_helpers');

async function runLegacyDailyDigest() {
  const slackClient = await requireSlackClient();
  return runTasks([
    ['legacy-daily-digest', () => slackHandlers.sendDailyDigest(slackClient)],
  ]);
}

module.exports = { runLegacyDailyDigest };
