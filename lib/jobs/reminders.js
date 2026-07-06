'use strict';

const slackHandlers = require('../slack-handlers');
const { requireSlackClient, runTasks } = require('./_helpers');

async function runReminders() {
  const slackClient = await requireSlackClient();
  return runTasks([
    ['reminders', () => slackHandlers.checkReminders(slackClient)],
  ]);
}

module.exports = { runReminders };
