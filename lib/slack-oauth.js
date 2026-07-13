// lib/slack-oauth.js
// Owns: Slack OAuth install/callback flow, bot token persistence, post-install welcome DM, invite claim + starter pact
// Does NOT own: Slack command handlers, tracker OAuth, billing, page routes

'use strict';

const { WebClient } = require('@slack/web-api');
const { sendWelcomeDM, setBotUserId } = require('./slack-handlers');
const { appUrl } = require('./app-url');
const {
  claimInvite,
  recordInviteInstalled,
  getInviteByToken,
} = require('../db/invites');
const { createPact } = require('../db/pacts');

// OAuth scopes MUST include reactions:read + history scopes for emoji-reaction pact flow
function slackOAuthUrl() {
  const clientId = process.env.SLACK_CLIENT_ID;
  if (!clientId) return null;
  const redirectUri = appUrl('/slack/oauth/callback');
  return `https://slack.com/oauth/v2/authorize?client_id=${clientId}&scope=commands,chat:write,im:write,im:read,im:history,users:read,reactions:read,channels:history,groups:history,mpim:history&redirect_uri=${encodeURIComponent(redirectUri)}&user_scope=`;
}

async function registerSlackOAuthCallback(app, pool, slackApp) {
  const REDIRECT_URI = appUrl('/slack/oauth/callback');

  // Convenience endpoint: redirects to Slack OAuth for reinstalling
  // Useful when the bot token is stale after a scope change or admin reinstall
  app.get('/slack/reinstall', (req, res) => {
    const oauthUrl = slackOAuthUrl();
    if (!oauthUrl) {
      return res.status(503).send('Slack installation is not configured yet.');
    }
    res.redirect(oauthUrl);
  });

  app.get('/slack/oauth/callback', async (req, res) => {
    const { code, error: errorParam, state } = req.query;

    // User denied the request
    if (errorParam) {
      return res.redirect(`/slack-error.html?error=access_denied&message=${encodeURIComponent('You denied access to Pact. You can try again anytime.')}`);
    }

    if (!code) {
      return res.redirect('/slack-error.html?error=missing_code&message=' + encodeURIComponent('No authorization code received. Please try again.'));
    }

    const clientId = process.env.SLACK_CLIENT_ID;
    const clientSecret = process.env.SLACK_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      console.error('Slack OAuth: SLACK_CLIENT_ID or SLACK_CLIENT_SECRET not set');
      return res.redirect('/slack-error.html?error=configuration&message=' + encodeURIComponent('Slack is not configured. Contact the app administrator.'));
    }

    try {
      // Exchange code for token
      const params = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: REDIRECT_URI,
      });

      const response = await fetch('https://slack.com/api/oauth.v2.access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });

      const data = await response.json();

      if (!data.ok) {
        console.error('Slack OAuth exchange failed:', data.error, data.error_description);
        return res.redirect(`/slack-error.html?error=${encodeURIComponent(data.error || 'exchange_failed')}&message=${encodeURIComponent(data.error_description || 'Token exchange failed. Please try again.')}`);
      }

      const { team, authed_user, access_token, scope, bot_user_id: installedBotUserId } = data;
      const installerUserId = authed_user?.id || null;

      // Upsert installation — bot token, team info, and installer user ID
      await pool.query(
        `INSERT INTO installations (team_id, team_name, bot_token, bot_user_id, installer_user_id, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (team_id) DO UPDATE SET
           team_name = EXCLUDED.team_name,
           bot_token = EXCLUDED.bot_token,
           bot_user_id = EXCLUDED.bot_user_id,
           installer_user_id = COALESCE(installations.installer_user_id, EXCLUDED.installer_user_id),
           updated_at = NOW()`,
        [team.id, team.name, access_token, installedBotUserId || installerUserId, installerUserId]
      );

      console.log(`Slack workspace installed: ${team.name} (${team.id})`);
      console.log(`Bot user ID: ${installedBotUserId || '(not returned)'} | Scopes granted: ${scope || '(not returned)'}`);

      // Handle workspace invite token FIRST (sets inviterName for welcome DM personalization)
      let inviterName = null;
      if (state) {
        try {
          const parsed = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
          if (parsed.invite_token) {
            const claimed = await claimInvite({
              token: parsed.invite_token,
              claimedTeamId: team.id,
              claimedUserId: installerUserId,
            });
            if (claimed) {
              await recordInviteInstalled(parsed.invite_token, {
                claimed_team: team.name,
                installer_user_id: installerUserId,
              });
              console.log(`[INVITE] Token claimed by team=${team.name} (was invited by user=${claimed.inviter_user_id})`);

              // Fetch inviter info from their workspace to get display name
              try {
                const inviterInstallRow = await pool.query(
                  'SELECT bot_token FROM installations WHERE team_id = $1 LIMIT 1',
                  [claimed.inviter_team_id]
                );
                if (inviterInstallRow.rows[0]?.bot_token) {
                  const inviterClient = new WebClient(inviterInstallRow.rows[0].bot_token);
                  const inviterInfo = await inviterClient.users.info({ user: claimed.inviter_user_id });
                  inviterName = inviterInfo.user?.profile?.display_name
                    || inviterInfo.user?.profile?.real_name
                    || null;
                }
              } catch (invErr) {
                console.warn('[INVITE] Could not fetch inviter name:', invErr.message);
              }

              // Seed starter pact: new user → inviter (DM cross-workspace)
              if (installerUserId && claimed.inviter_user_id) {
                const starterPactDescription = `${inviterName || 'A teammate'} invited you to Pact — let's make your first commitment count.`;
                const nextWeek = new Date();
                nextWeek.setDate(nextWeek.getDate() + 7);
                nextWeek.setUTCHours(17, 0, 0, 0);

                try {
                  await createPact({
                    creatorSlackId: installerUserId,
                    creatorTeamId: team.id,
                    description: starterPactDescription,
                    dueDate: nextWeek.toISOString(),
                    counterpartySlackId: claimed.inviter_user_id,
                    counterpartyTeamId: claimed.inviter_team_id,
                    channelId: null,
                    creatorName: 'You',
                    counterpartyName: inviterName || 'Your inviter',
                    recurrenceRule: null,
                  });
                  console.log(`[INVITE] Starter pact created for new user=${installerUserId} with inviter=${claimed.inviter_user_id}`);

                  // Starter pact counts as "pact created within 7 days" for the new workspace.
                  // Mark it as a successful cross-workspace referral.
                  // We do this inline since the pact was just created; the normal hook
                  // (markInvitePactCreated called from pact creation) would also fire later
                  // but doing it here avoids a race condition.
                  const { markInvitePactCreated } = require('../db/invites');
                  markInvitePactCreated(team.id).catch(e =>
                    console.warn('[INVITE] markInvitePactCreated error:', e.message)
                  );
                } catch (pactErr) {
                  console.error('[INVITE] Failed to create starter pact:', pactErr.message);
                }
              }

            } else {
              console.log(`[INVITE] Token already claimed or invalid: ${parsed.invite_token}`);
            }
          }
        } catch (parseErr) {
          console.warn('[INVITE] Could not parse OAuth state:', parseErr.message);
        }
      }

      // Send welcome DM to the installer — non-blocking, won't block the redirect
      // inviterName is set if they came via an invite link
      if (installerUserId) {
        sendWelcomeDM(access_token, installerUserId, team.name, inviterName).catch((err) => {
          console.error(`[onboarding] Failed to send welcome DM for team ${team.id}:`, err.message);
        });
      }

      // Update global botUserId so DM detection stays accurate after reinstall
      const freshBotUserId = installedBotUserId || authed_user?.id || null;
      if (freshBotUserId) {
        setBotUserId(freshBotUserId);
        console.log(`Bot user ID updated to: ${freshBotUserId}`);
      }

      // Redirect to success page — include team_id and app_id for deep link
      // If invite was claimed, show a different message on the success page
      const appId = data.app_id || '';
      const successParams = new URLSearchParams({
        team: team.name,
        team_id: team.id,
        app_id: appId,
        ...(inviterName ? { invited_by: inviterName } : {}),
      });
      res.redirect(`/slack-success.html?${successParams.toString()}`);

    } catch (err) {
      console.error('Slack OAuth error:', err.message);
      res.redirect('/slack-error.html?error=server_error&message=' + encodeURIComponent('An unexpected error occurred. Please try again.'));
    }
  });
}

// ---------------------------------------------------------------------------
// Page Routes
// ---------------------------------------------------------------------------


module.exports = { registerSlackOAuthCallback };
