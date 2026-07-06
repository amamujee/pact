const fs = require('fs');
const content = fs.readFileSync('server.js', 'utf8');

const newFn = `async function start() {
  let expressApp;

  // Determine Slack readiness:
  // - If env vars are set, use them directly
  // - Otherwise, try to load bot_token from the installations table
  let botToken = process.env.SLACK_BOT_TOKEN || null;
  let signingSecret = process.env.SLACK_SIGNING_SECRET || null;

  if (!botToken && signingSecret) {
    // Signing secret is in env vars but no bot token — load from DB
    try {
      const result = await pool.query(
        'SELECT bot_token FROM installations ORDER BY updated_at DESC LIMIT 1'
      );
      if (result.rows.length > 0 && result.rows[0].bot_token) {
        botToken = result.rows[0].bot_token;
        console.log('Loaded bot_token from installations table');
      }
    } catch (err) {
      console.error('Failed to load bot_token from DB:', err.message);
    }
  }

  if (botToken && signingSecret) {
    const { App, ExpressReceiver } = require('@slack/bolt');

    const receiver = new ExpressReceiver({
      signingSecret: signingSecret,
    });

    const slackApp = new App({
      token: botToken,
      receiver,
    });

    expressApp = receiver.app;

    // Register Slack interactions
    slackApp.command('/pact', handleCreatePact);
    slackApp.command('/pacts', handleListPacts);
    slackApp.command('/done', handleDoneCommand);
    slackApp.action('select_pact_complete', handleSelectPactComplete);

    // Analytics middleware (before static files so we track page hits)
    expressApp.use(pageviewMiddleware(pool));

    // Analytics API routes
    registerAnalyticsRoutes(expressApp, pool);

    // Slack OAuth callback
    await registerSlackOAuthCallback(expressApp, pool);

    // Serve static files
    expressApp.use(express.static(path.join(__dirname, 'public')));

    // Health check
    receiver.router.get('/health', (req, res) => {
      res.json({ status: 'healthy', slack: true });
    });

    // API: get pact stats (for landing page or dashboard)
    receiver.router.get('/api/stats', async (req, res) => {
      try {
        const stats = await pool.query(\`
          SELECT
            COUNT(*) FILTER (WHERE status = 'active') AS active,
            COUNT(*) FILTER (WHERE status = 'completed') AS completed,
            COUNT(*) AS total
          FROM pacts
        \`);
        res.json(stats.rows[0]);
      } catch (err) {
        res.status(500).json({ error: 'Failed to load stats' });
      }
    });

    await slackApp.start(port);
    console.log("⚡ Pact is running on port " + port + " with Slack integration");

    // Start reminder checker
    startReminderChecker(slackApp.client);

  } else {
    // Check what's missing
    if (!signingSecret) {
      console.warn('WARNING: SLACK_SIGNING_SECRET is not set — Slack interactivity disabled');
    }
    if (!botToken) {
      console.warn('WARNING: No bot_token found — set SLACK_BOT_TOKEN env var or install a workspace via /slack/oauth/callback');
    }

    expressApp = express();

    // Analytics middleware (before static files so we track page hits)
    expressApp.use(pageviewMiddleware(pool));

    // Analytics API routes
    registerAnalyticsRoutes(expressApp, pool);

    // Slack OAuth callback
    await registerSlackOAuthCallback(expressApp, pool);

    expressApp.use(express.static(path.join(__dirname, 'public')));

    expressApp.get('/health', (req, res) => {
      res.json({ status: 'healthy', slack: false });
    });

    expressApp.get('/api/stats', async (req, res) => {
      try {
        const stats = await pool.query(\`
          SELECT
            COUNT(*) FILTER (WHERE status = 'active') AS active,
            COUNT(*) FILTER (WHERE status = 'completed') AS completed,
            COUNT(*) AS total
          FROM pacts
        \`);
        res.json(stats.rows[0]);
      } catch (err) {
        res.status(500).json({ error: 'Failed to load stats' });
      }
    });

    expressApp.listen(port, () => {
      console.log("Server running on port " + port + " (web only — set SLACK_BOT_TOKEN + SLACK_SIGNING_SECRET to enable Slack)");
    });
  }
}
`;

const startMarker = 'async function start() {';
const endMarker = 'start().catch';
const startIdx = content.indexOf(startMarker);
const endIdx = content.indexOf(endMarker);

const newContent = content.substring(0, startIdx) + newFn + content.substring(endIdx);

fs.writeFileSync('server.js', newContent);
console.log('Replacement done. New file length:', newContent.length);
console.log('Old fn length:', endIdx - startIdx, 'chars');
console.log('New fn length:', newFn.length, 'chars');