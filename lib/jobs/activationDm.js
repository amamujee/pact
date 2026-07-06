'use strict';

const slackHandlers = require('../slack-handlers');
const { requireSlackClient, runTasks } = require('./_helpers');

async function runActivationDm() {
  await requireSlackClient();
  return runTasks([
    ['activation-dm', () => slackHandlers.checkActivationDue()],
  ]);
}

module.exports = { runActivationDm };
