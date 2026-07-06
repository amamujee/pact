const express = require('express');
const path = require('path');
const fs = require('fs');
const tracker = require('./tracker');
const doneRoutes = require('./routes/done');
const digestRoutes = require('./routes/digest');
const streakRoutes = require('./routes/streak');
const activationRoutes = require('./routes/activation');
const activateRouter = require('./routes/activate');
const publicStatsRouter = require('./routes/public-stats');
const { getPublicStats } = require('./routes/public-stats');
const inviteRouter = require('./routes/invite');
const blogRouter = require('./routes/blog');

const port = process.env.PORT || 3000;

let App, ExpressReceiver;
try {
  const bolt = require('@slack/bolt');
  App = bolt.App;
  ExpressReceiver = bolt.ExpressReceiver;
  console.log('Slack/Bolt module pre-loaded OK');
} catch (err) {
  console.error('FATAL: Failed to load @slack/bolt:', err.message);
  throw err;
}

if (!process.env.DATABASE_URL) {
  console.warn('WARNING: DATABASE_URL is not set. Database-backed routes will fail until it is configured.');
}

// Pool singleton lives in db/index.js; only that file constructs Pool.
const pool = require('./db/index');

// ---------------------------------------------------------------------------
// Module imports
// ---------------------------------------------------------------------------
const { pageviewMiddleware, registerAnalyticsRoutes } = require('./lib/analytics');
const { initErrorTracker, trackError, registerErrorRoutes } = require('./lib/error-tracker');
const { registerContactRoutes } = require('./lib/contact-routes');
const { formatDate, getUserTimezone, parseDueDate, getUserName, getStatusEmoji, getStatusLabel } = require('./lib/helpers');
const { BOT_DM, PEER_DM, getDMCounterparty, backfillCounterparty, resolveNullCounterparties } = require('./lib/counterparty');
const slackHandlers = require('./lib/slack-handlers');
const { registerMetricsRoutes } = require('./lib/metrics-routes');
const { init: initBilling, registerBillingRoutes, getTeamTier, planBadge } = require('./lib/billing-routes');
const { registerTrackerRoutes } = require('./lib/tracker-routes');
const { registerPageRoutes } = require('./lib/page-routes');
const { registerSlackOAuthCallback } = require('./lib/slack-oauth');
const { registerSlackDiagnostics } = require('./lib/slack-diagnostics');
const workflowBuilder = require('./lib/workflow-builder');

initBilling({ pool });
doneRoutes.init({ getTeamTier, formatDate });

slackHandlers.init({
  pool, tracker, doneRoutes, digestRoutes,
  pactsDb: require('./db/pacts'),
  formatDate, getUserTimezone, parseDueDate, getUserName, getStatusEmoji, getStatusLabel,
  BOT_DM, PEER_DM, getDMCounterparty, backfillCounterparty, resolveNullCounterparties,
  trackError,
});

workflowBuilder.init({ pool, parseDueDate, formatDate, getUserName, getUserTimezone, getTeamTier });

const {
  registerSlackHandlers,
  startReminderChecker,
  startDailyDigest,
  checkReminders,
  sendDailyDigest,
  checkNudgeDue,
  checkOverduePacts,
  checkCounterpartyNudges,
  setBotUserId,
  checkStreakMilestones,
  checkActivationDue,
} = slackHandlers;

let appPromise;
let currentSlackClient = null;

// ---------------------------------------------------------------------------
// SSR homepage
// ---------------------------------------------------------------------------
async function serveHomepage(req, res) {
  try {
    const stats = await getPublicStats();
    let html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    const show = stats && stats.workspaces >= 10 && stats.pacts_kept >= 10;
    const statsHtml = show
      ? `<span class="stat-val">${stats.workspaces.toLocaleString()}</span> workspaces&ensp;·&ensp;<span class="stat-val">${stats.pacts_kept.toLocaleString()}</span> pacts kept&ensp;·&ensp;<span class="stat-val">${stats.on_time_pct}%</span> on-time rate`
      : 'Just launched — be one of the first teams';
    html = html.replace('<!--SSR_STATS-->', statsHtml);
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
}

function registerSharedRoutes(app, slackApp) {
  app.use(pageviewMiddleware(pool));
  registerAnalyticsRoutes(app, pool);
  registerMetricsRoutes(app, pool);
  registerErrorRoutes(app, pool);
  registerContactRoutes(app, pool);
  registerBillingRoutes(app, pool);
  void registerSlackOAuthCallback(app, pool, slackApp);
  void registerTrackerRoutes(app, pool);
  registerPageRoutes(app);
  app.use('/streak', streakRoutes);
  app.use('/admin/activation', activationRoutes);
  if (process.env.ENABLE_ADMIN_MIGRATE === 'true') {
    const adminMigrateRouter = require('./routes/admin-migrate');
    app.use('/admin/migrate', adminMigrateRouter);
  }
  app.use('/activate', activateRouter);
  app.use('/api/public-stats', publicStatsRouter);
  app.get('/api/digest/admin', async (req, res) => {
    if (!isCronAuthorized(req, res)) return;
    const { runWorkspaceAdminDigest } = require('./lib/workspace-admin-digest');
    const result = await runWorkspaceAdminDigest();
    res.json(result);
  });
  app.use('/invite', inviteRouter);
  app.use('/api/invite', inviteRouter);
  app.use('/blog', blogRouter);
  app.get('/', serveHomepage);
  app.use(express.static(path.join(__dirname, 'public')));
}

function isCronAuthorized(req, res) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    if (process.env.NODE_ENV === 'production' || process.env.VERCEL) {
      res.status(500).json({ error: 'CRON_SECRET is not configured' });
      return false;
    }
    console.warn('[cron] CRON_SECRET not set; allowing request outside production');
    return true;
  }

  const actual = req.headers.authorization || '';
  if (actual !== `Bearer ${expected}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

async function runCronTasks(tasks) {
  const results = [];
  for (const [name, task] of tasks) {
    try {
      const result = await task();
      results.push({ name, ok: true, result });
    } catch (err) {
      console.error(`[cron] ${name} failed:`, err.message);
      results.push({ name, ok: false, error: err.message });
    }
  }
  return results;
}

function sendCronResponse(res, results) {
  const ok = results.every(result => result.ok);
  res.status(ok ? 200 : 500).json({ ok, results });
}

function requireSlackClient(slackClient, res) {
  if (slackClient) return true;
  res.status(503).json({ error: 'Slack client is not configured' });
  return false;
}

function registerCronRoutes(app, slackClient) {
  app.all('/api/crons/reminders', async (req, res) => {
    if (!isCronAuthorized(req, res) || !requireSlackClient(slackClient, res)) return;
    const results = await runCronTasks([
      ['reminders', () => checkReminders(slackClient)],
    ]);
    sendCronResponse(res, results);
  });

  app.all('/api/crons/digests', async (req, res) => {
    if (!isCronAuthorized(req, res) || !requireSlackClient(slackClient, res)) return;
    const results = await runCronTasks([
      ['weekly-digest', () => digestRoutes.runWeeklyDigestCheck(slackClient)],
      ['daily-morning-digest', () => digestRoutes.runDailyMorningCheck(slackClient)],
    ]);
    sendCronResponse(res, results);
  });

  app.all('/api/crons/weekly-digest', async (req, res) => {
    if (!isCronAuthorized(req, res) || !requireSlackClient(slackClient, res)) return;
    const results = await runCronTasks([
      ['weekly-digest', () => digestRoutes.runWeeklyDigestCheck(slackClient)],
    ]);
    sendCronResponse(res, results);
  });

  app.all('/api/crons/daily-digest', async (req, res) => {
    if (!isCronAuthorized(req, res) || !requireSlackClient(slackClient, res)) return;
    const results = await runCronTasks([
      ['daily-morning-digest', () => digestRoutes.runDailyMorningCheck(slackClient)],
    ]);
    sendCronResponse(res, results);
  });

  app.all('/api/crons/hourly', async (req, res) => {
    if (!isCronAuthorized(req, res)) return;
    const results = await runCronTasks([
      ['first-pact-nudge', () => checkNudgeDue(pool)],
      ['overdue-pacts', () => checkOverduePacts(pool)],
      ['counterparty-nudges', () => checkCounterpartyNudges(pool)],
      ['streak-milestones', () => checkStreakMilestones()],
      ['activation-dm', () => checkActivationDue()],
    ]);
    sendCronResponse(res, results);
  });

  app.all('/api/crons/overdue-nudge', async (req, res) => {
    if (!isCronAuthorized(req, res)) return;
    const results = await runCronTasks([
      ['first-pact-nudge', () => checkNudgeDue(pool)],
      ['overdue-pacts', () => checkOverduePacts(pool)],
      ['counterparty-nudges', () => checkCounterpartyNudges(pool)],
      ['streak-milestones', () => checkStreakMilestones()],
    ]);
    sendCronResponse(res, results);
  });

  app.all('/api/crons/activation-dm', async (req, res) => {
    if (!isCronAuthorized(req, res)) return;
    const results = await runCronTasks([
      ['activation-dm', () => checkActivationDue()],
    ]);
    sendCronResponse(res, results);
  });

  app.all('/api/crons/legacy-daily-digest', async (req, res) => {
    if (!isCronAuthorized(req, res) || !requireSlackClient(slackClient, res)) return;
    const results = await runCronTasks([
      ['legacy-daily-digest', () => sendDailyDigest(slackClient)],
    ]);
    sendCronResponse(res, results);
  });

  app.all('/api/crons/workspace-admin-digest', async (req, res) => {
    if (!isCronAuthorized(req, res)) return;
    const { runWorkspaceAdminDigest } = require('./lib/workspace-admin-digest');
    const results = await runCronTasks([
      ['workspace-admin-digest', () => runWorkspaceAdminDigest()],
    ]);
    sendCronResponse(res, results);
  });
}

async function loadBotToken(signingSecret) {
  let botToken = process.env.SLACK_BOT_TOKEN || null;
  if (botToken || !signingSecret) return botToken;

  try {
    const result = await pool.query(
      'SELECT bot_token FROM installations ORDER BY updated_at DESC LIMIT 1'
    );
    if (result.rows[0]?.bot_token) {
      botToken = result.rows[0].bot_token;
      console.log('Loaded bot_token from installations table');
    }
  } catch (err) {
    console.error('Failed to load bot_token from DB:', err.message);
  }

  return botToken;
}

async function primeSlackIdentity(slackClient) {
  try {
    const row = await pool.query('SELECT bot_user_id FROM installations ORDER BY updated_at DESC LIMIT 1');
    if (row.rows[0]?.bot_user_id) setBotUserId(row.rows[0].bot_user_id);
  } catch (err) {
    console.warn('[slack] Could not load bot_user_id from DB:', err.message);
  }

  if (process.env.SLACK_AUTH_TEST_ON_BOOT !== 'true') return;

  try {
    const auth = await slackClient.auth.test();
    if (auth.ok) {
      setBotUserId(auth.user_id || null);
      console.log(`Bot token valid — team: ${auth.team}, bot: ${auth.user}, bot_user_id: ${auth.user_id}`);
      const scopes = auth.response_metadata?.scopes || [];
      const missing = ['reactions:read', 'channels:history', 'groups:history', 'mpim:history', 'im:history']
        .filter(s => !scopes.includes(s));
      if (missing.length > 0) {
        console.warn(`[REACTION] WARNING: Missing scopes: ${missing.join(', ')}`);
      }
    }
  } catch (authErr) {
    console.error('WARNING: Bot token is invalid (auth.test failed):', authErr.message);
  }
}

function shouldEnableInProcessCrons() {
  if (process.env.LOCAL_DEV) return true;
  if (process.env.IN_PROCESS_CRONS_ENABLED != null) {
    return process.env.IN_PROCESS_CRONS_ENABLED === 'true';
  }
  return !process.env.VERCEL && process.env.NODE_ENV !== 'production';
}

function startBackgroundJobs(slackClient) {
  startReminderChecker(slackClient);
  startDailyDigest(slackClient);
  digestRoutes.startWeeklyDigestScheduler(slackClient);
  digestRoutes.startDailyMorningScheduler(slackClient);

  setInterval(() => checkNudgeDue(pool).catch(err => trackError(err.message, { tag: 'onboarding-cron' })), 60 * 60 * 1000);
  setTimeout(() => checkNudgeDue(pool).catch(err => trackError(err.message, { tag: 'onboarding-cron' })), 30 * 1000);

  setInterval(() => checkOverduePacts(pool).catch(err => trackError(err.message, { tag: 'overdue-cron' })), 60 * 60 * 1000);
  setTimeout(() => checkOverduePacts(pool).catch(err => trackError(err.message, { tag: 'overdue-cron' })), 45 * 1000);

  setInterval(() => checkCounterpartyNudges(pool).catch(err => trackError(err.message, { tag: 'cp-nudge-cron' })), 60 * 60 * 1000);
  setTimeout(() => checkCounterpartyNudges(pool).catch(err => trackError(err.message, { tag: 'cp-nudge-cron' })), 60 * 1000);

  setInterval(() => checkStreakMilestones().catch(err => trackError(err.message, { tag: 'streak-cron' })), 60 * 60 * 1000);
  setTimeout(() => checkStreakMilestones().catch(err => trackError(err.message, { tag: 'streak-cron' })), 90 * 1000);

  setInterval(() => checkActivationDue().catch(err => trackError(err.message, { tag: 'activation-cron' })), 60 * 60 * 1000);
  setTimeout(() => checkActivationDue().catch(err => trackError(err.message, { tag: 'activation-cron' })), 120 * 1000);
}

async function createExpressApp({ enableBackgroundJobs = false } = {}) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET || null;
  const botToken = await loadBotToken(signingSecret);

  if (botToken && signingSecret) {
    const receiver = new ExpressReceiver({
      signingSecret,
      endpoints: {
        commands: '/slack/commands',
        events: '/slack/events',
        actions: '/slack/actions',
      },
    });
    const slackApp = new App({ token: botToken, receiver });
    currentSlackClient = slackApp.client;

    slackApp.use(async ({ body, next }) => {
      if (body?.type === 'event_callback' || body?.event) {
        console.log(`[BOLT EVENT] type=${body.event?.type || body.type} team=${body.team_id || 'unknown'}`);
      }
      await next();
    });
    slackApp.error(async (error) => {
      console.error('[SLACK ERROR]', error.code || 'unknown', error.message);
      if (error.original) console.error('[SLACK ERROR] Original:', error.original.message);
    });

    digestRoutes.init({
      formatDate, getUserTimezone, getTeamTier, planBadge,
      completePact: doneRoutes.completePact,
    });

    registerSlackHandlers(slackApp);
    workflowBuilder.registerWorkflowSteps(slackApp);
    initErrorTracker(pool, slackApp.client);
    registerSharedRoutes(receiver.app, slackApp);
    receiver.app.get('/health', (req, res) => res.json({ status: 'healthy', slack: true }));
    receiver.app.get('/api/health', (req, res) => res.json({ ok: true, slack: true, ts: Date.now() }));
    registerSlackDiagnostics(receiver.app, pool, slackApp);
    registerCronRoutes(receiver.app, slackApp.client);

    await primeSlackIdentity(slackApp.client);

    if (enableBackgroundJobs) startBackgroundJobs(slackApp.client);

    console.log(`Pact initialized with Slack integration${enableBackgroundJobs ? ' and in-process crons' : ''}`);
    return receiver.app;
  }

  if (!signingSecret) console.warn('WARNING: SLACK_SIGNING_SECRET is not set — Slack interactivity disabled');
  if (!botToken) console.warn('WARNING: No bot_token found — set SLACK_BOT_TOKEN or install a workspace');

  currentSlackClient = null;
  const app = express();
  initErrorTracker(pool, null);
  registerSharedRoutes(app, null);
  app.get('/health', (req, res) => res.json({ status: 'healthy', slack: false }));
  app.get('/api/health', (req, res) => res.json({ ok: true, slack: false, ts: Date.now() }));
  registerCronRoutes(app, null);
  return app;
}

function getApp(options = {}) {
  if (!appPromise) {
    appPromise = createExpressApp(options);
  }
  return appPromise;
}

async function getSlackClient() {
  await getApp({ enableBackgroundJobs: false });
  return currentSlackClient;
}

async function start() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is required');
  }
  const app = await getApp({ enableBackgroundJobs: shouldEnableInProcessCrons() });
  app.listen(port, () => {
    console.log(`Pact listening on port ${port}`);
  });
}

async function handler(req, res) {
  const app = await getApp({ enableBackgroundJobs: false });
  return app(req, res);
}

module.exports = handler;
module.exports.getApp = getApp;
module.exports.getSlackClient = getSlackClient;
module.exports.start = start;

if (require.main === module) {
  start().catch(err => {
    console.error('Failed to start:', err);
    process.exit(1);
  });
}
