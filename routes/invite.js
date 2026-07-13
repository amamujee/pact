// routes/invite.js
// Owns: /invite/:token landing page, /api/invite/gen (create link), /api/invite/count (teams joined).
// Does NOT own: OAuth callback (passes token to slack-oauth), pact seeding (calls db/pacts).

'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { appUrl } = require('../lib/app-url');

const {
  createInvite,
  getInviteByToken,
  recordInviteClicked,
  getTeamsJoinedCount,
} = require('../db/invites');

// ---------------------------------------------------------------------------
// GET /invite/:token — Landing page with Add to Slack button
// ---------------------------------------------------------------------------

router.get('/:token', async (req, res) => {
  const { token } = req.params;

  // Validate token format (base64url, 32+ chars)
  if (!token || token.length < 20) {
    return res.status(404).send('Invalid invite link.');
  }

  const invite = await getInviteByToken(token);
  if (!invite) {
    return res.status(404).send('This invite link has expired or is invalid.');
  }

  // Record click event (non-blocking)
  recordInviteClicked(token, {
    ip_hash: req.ip ? require('crypto').createHash('sha256').update(req.ip).digest('hex').slice(0, 16) : null,
    user_agent: req.get('User-Agent') || '',
  }).catch(() => {});

  // Build OAuth URL with invite token stamped in state
  const state = Buffer.from(JSON.stringify({ invite_token: token })).toString('base64url');
  const oauthUrl = buildOAuthUrl(state);
  if (!oauthUrl) {
    return res.status(503).send('Slack installation is not configured yet.');
  }

  // Serve invite landing page
  const html = buildInviteLandingHtml({ oauthUrl, invite, baseUrl: appUrl('/invite') });
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// ---------------------------------------------------------------------------
// POST /api/invite/gen — Generate a new invite link (called from App Home)
// Body: { userId, teamId }
// Returns: { link, inviteId }
// ---------------------------------------------------------------------------

router.post('/gen', async (req, res) => {
  const { userId, teamId } = req.body;

  if (!userId || !teamId) {
    return res.status(400).json({ error: 'userId and teamId are required' });
  }

  // Token format validated at DB level (UNIQUE constraint)
  const invite = await createInvite({
    inviterUserId: userId,
    inviterTeamId: teamId,
  });

  res.json({
    link: invite.invite_link,
    inviteId: invite.id,
    token: invite.token,
  });
});

// ---------------------------------------------------------------------------
// GET /api/invite/count/:teamId/:userId — How many teams joined through this user
// ---------------------------------------------------------------------------

router.get('/count/:teamId/:userId', async (req, res) => {
  const { teamId, userId } = req.params;
  const count = await getTeamsJoinedCount(userId, teamId);
  res.json({ teamsJoined: count });
});

// ---------------------------------------------------------------------------
// OAuth URL builder
// ---------------------------------------------------------------------------

function buildOAuthUrl(state) {
  const clientId = process.env.SLACK_CLIENT_ID;
  if (!clientId) return null;
  const redirectUri = encodeURIComponent(appUrl('/slack/oauth/callback'));
  const scopes = 'commands,chat:write,im:write,im:read,im:history,users:read,reactions:read,channels:history,groups:history,mpim:history';

  return `https://slack.com/oauth/v2/authorize?client_id=${clientId}&scope=${scopes}&redirect_uri=${redirectUri}&state=${encodeURIComponent(state)}`;
}

// ---------------------------------------------------------------------------
// Invite landing page HTML (no external dependencies, all inline)
// ---------------------------------------------------------------------------

function buildInviteLandingHtml({ oauthUrl, invite, baseUrl }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>You're invited to Pact</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f172a;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 16px;
      padding: 48px 40px;
      max-width: 440px;
      width: 100%;
      text-align: center;
    }
    .logo { font-size: 48px; margin-bottom: 8px; }
    h1 {
      color: #f8fafc;
      font-size: 26px;
      font-weight: 700;
      margin-bottom: 12px;
      line-height: 1.3;
    }
    .sub {
      color: #94a3b8;
      font-size: 15px;
      line-height: 1.6;
      margin-bottom: 32px;
    }
    .cta {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      background: #4f46e5;
      color: #fff;
      padding: 14px 28px;
      border-radius: 8px;
      font-size: 15px;
      font-weight: 600;
      text-decoration: none;
      transition: background 0.15s;
      border: none;
      cursor: pointer;
    }
    .cta:hover { background: #4338ca; }
    .cta svg { flex-shrink: 0; }
    .note {
      color: #64748b;
      font-size: 12px;
      margin-top: 16px;
      line-height: 1.5;
    }
    .divider {
      border: none;
      border-top: 1px solid #334155;
      margin: 28px 0;
    }
    .features {
      text-align: left;
      margin-bottom: 32px;
    }
    .features li {
      color: #cbd5e1;
      font-size: 14px;
      margin-bottom: 10px;
      padding-left: 24px;
      position: relative;
    }
    .features li::before {
      content: '✓';
      position: absolute;
      left: 0;
      color: #4ade80;
      font-weight: 700;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">🤝</div>
    <h1>A teammate wants you<br>to try Pact</h1>
    <p class="sub">
      Pact turns Slack promises into tracked commitments — automatic reminders, overdue nudges, and streaks.
      Free to start, works with your existing team.
    </p>

    <a href="${oauthUrl}" class="cta">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" fill="#e8e8e8"/>
      </svg>
      Add Pact to Slack
    </a>

    <p class="note">
      No credit card required &nbsp;·&nbsp; Free plan available<br>
      Your team's data stays in Slack
    </p>

    <hr class="divider">

    <ul class="features">
      <li>Track commitments with automatic reminders</li>
      <li>Overdue nudges so nothing slips through</li>
      <li>Streak tracking to build accountability habits</li>
    </ul>
  </div>
</body>
</html>`;
}

module.exports = router;
