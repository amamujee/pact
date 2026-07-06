'use strict';

const { getApp, getSlackClient } = require('../../server');

async function ensureAppInitialized() {
  await getApp({ enableBackgroundJobs: false });
}

async function requireSlackClient() {
  const slackClient = await getSlackClient();
  if (!slackClient) {
    const err = new Error('Slack client is not configured');
    err.statusCode = 503;
    throw err;
  }
  return slackClient;
}

async function runTasks(tasks) {
  const results = [];
  for (const [name, task] of tasks) {
    try {
      const result = await task();
      results.push({ name, ok: true, result: result || null });
    } catch (err) {
      console.error(`[cron] ${name} failed:`, err.message);
      results.push({ name, ok: false, error: err.message });
    }
  }

  if (results.some(result => !result.ok)) {
    const err = new Error('One or more cron tasks failed');
    err.results = results;
    throw err;
  }

  return results;
}

module.exports = { ensureAppInitialized, requireSlackClient, runTasks };
