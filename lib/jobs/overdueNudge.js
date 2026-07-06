'use strict';

const pool = require('../../db/index');
const slackHandlers = require('../slack-handlers');
const { requireSlackClient, runTasks } = require('./_helpers');

async function runOverdueNudge() {
  await requireSlackClient();
  return runTasks([
    ['first-pact-nudge', () => slackHandlers.checkNudgeDue(pool)],
    ['overdue-pacts', () => slackHandlers.checkOverduePacts(pool)],
    ['counterparty-nudges', () => slackHandlers.checkCounterpartyNudges(pool)],
    ['streak-milestones', () => slackHandlers.checkStreakMilestones()],
  ]);
}

module.exports = { runOverdueNudge };
