// lib/slack-diagnostics.js
// Owns: Slack diagnostic HTTP endpoints (/slack/status, /slack/verify-events)
// Does NOT own: Slack command handlers, billing, metrics, page routes

'use strict';

const { appUrl } = require('./app-url');
const { isCronAuthorized } = require('./cron-handler');

function registerSlackDiagnostics(router, pool, slackApp) {
  // Diagnostic endpoint — verify bot token and scopes
  router.get('/slack/status', async (req, res) => {
    if (!isCronAuthorized(req, res)) return;

    try {
      const row = await pool.query(
        'SELECT team_id, team_name, bot_user_id, updated_at FROM installations ORDER BY updated_at DESC LIMIT 1'
      );
      const installation = row.rows[0] || null;

      // Reload token from DB before testing (in case hot-swap diverged)
      if (installation) {
        const tokenRow = await pool.query(
          'SELECT bot_token FROM installations WHERE team_id = $1',
          [installation.team_id]
        );
        if (tokenRow.rows[0]?.bot_token) {
          slackApp.client.token = tokenRow.rows[0].bot_token;
        }
      }

      // Call auth.test to verify the token is still valid
      let authTest = null;
      try {
        authTest = await slackApp.client.auth.test();
      } catch (e) {
        authTest = { ok: false, error: e.message };
      }

      res.json({
        server: 'running',
        slack_integration: true,
        installation: installation ? {
          team_id: installation.team_id,
          team_name: installation.team_name,
          bot_user_id: installation.bot_user_id,
          installed_at: installation.updated_at,
        } : null,
        auth_test: authTest,
        required_scopes: ['commands', 'chat:write', 'im:write', 'im:read', 'im:history', 'users:read'],
        endpoints: {
          commands: appUrl('/slack/commands'),
          events: appUrl('/slack/events'),
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Diagnostic: check if emoji-reaction event subscriptions are properly configured
  router.get('/slack/verify-events', async (req, res) => {
    if (!isCronAuthorized(req, res)) return;

    try {
      const authResult = await slackApp.client.auth.test();
      const scopes = authResult.response_metadata?.scopes || [];
      const requiredScopes = ['reactions:read', 'channels:history', 'groups:history', 'mpim:history', 'im:history'];
      const missingScopes = requiredScopes.filter(s => !scopes.includes(s));

      const setup = {
        bot_scopes_ok: missingScopes.length === 0,
        missing_scopes: missingScopes,
        current_scopes: scopes,
        event_endpoint: appUrl('/slack/events'),
        handler_registered: true,
        setup_instructions: {
          step_1: 'Go to https://api.slack.com/apps → select your app',
          step_2: 'Click "Event Subscriptions" in the left sidebar',
          step_3: 'Toggle "Enable Events" to ON',
          step_4: `Set Request URL to: ${appUrl('/slack/events')}`,
          step_5: 'Under "Subscribe to bot events", add: reaction_added',
          step_6: 'Click "Save Changes" at the bottom',
          step_7: missingScopes.length > 0
            ? `Reinstall app to get missing scopes: ${appUrl('/slack/reinstall')}`
            : 'Scopes are OK — no reinstall needed',
        },
      };

      res.json(setup);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerSlackDiagnostics };
