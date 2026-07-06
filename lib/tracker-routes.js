// lib/tracker-routes.js
// Owns: tracker OAuth routes (Linear, Asana, Notion), project picker UI helpers, pending session management
// Does NOT own: Slack command handlers, billing, metrics, page routes

'use strict';

const express = require('express');
const crypto = require('crypto');
const tracker = require('../tracker');

// ---------------------------------------------------------------------------
// Tracker OAuth Routes
// ---------------------------------------------------------------------------

// In-memory pending sessions: pendingSession token → { teamId, userId, provider, accessToken }
const pendingSessions = new Map();

function generatePendingSession(data) {
  const token = require('crypto').randomBytes(24).toString('hex');
  pendingSessions.set(token, { ...data, expiresAt: Date.now() + 15 * 60 * 1000 });
  return token;
}

function consumePendingSession(token) {
  const data = pendingSessions.get(token);
  if (!data) return null;
  pendingSessions.delete(token);
  if (Date.now() > data.expiresAt) return null;
  return data;
}

function projectPickerHtml(provider, session, items, error) {
  const providerName = { linear: 'Linear', asana: 'Asana', notion: 'Notion' }[provider] || provider;
  const listItems = items.map(item =>
    `<button class="project-btn" onclick="selectProject('${item.id.replace(/'/g, "\\'")}', '${item.name.replace(/'/g, "\\'")}')">
      <span class="project-name">${item.name}</span>
    </button>`
  ).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Connect ${providerName} · Pact</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f4f5f7; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .card { background: white; border-radius: 12px; padding: 36px; max-width: 480px; width: 100%; box-shadow: 0 4px 24px rgba(0,0,0,0.10); }
    .logo { font-size: 28px; margin-bottom: 8px; }
    h1 { font-size: 20px; font-weight: 700; color: #1a1a2e; margin-bottom: 6px; }
    p { font-size: 14px; color: #666; margin-bottom: 24px; }
    .error { background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 12px; color: #b91c1c; font-size: 14px; margin-bottom: 16px; }
    .project-list { display: flex; flex-direction: column; gap: 8px; }
    .project-btn { background: #f8f9fa; border: 1.5px solid #e2e8f0; border-radius: 8px; padding: 14px 18px; cursor: pointer; text-align: left; transition: all 0.15s; font-size: 15px; color: #1a1a2e; }
    .project-btn:hover { border-color: #4f46e5; background: #eef2ff; }
    .project-btn.selected { border-color: #4f46e5; background: #eef2ff; }
    .saving { display: none; text-align: center; color: #4f46e5; margin-top: 16px; font-size: 14px; }
    .back { margin-top: 20px; font-size: 13px; text-align: center; color: #999; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">🔗</div>
    <h1>Pick a default ${providerName} project</h1>
    <p>Pacts will sync here automatically when created.</p>
    ${error ? `<div class="error">${error}</div>` : ''}
    <div class="project-list">${listItems || '<p style="color:#999">No projects found.</p>'}</div>
    <div class="saving" id="saving">Saving…</div>
    <p class="back">You can change this anytime with <code>/pact settings</code></p>
  </div>
  <script>
    function selectProject(id, name) {
      document.getElementById('saving').style.display = 'block';
      document.querySelectorAll('.project-btn').forEach(b => b.style.pointerEvents = 'none');
      fetch('/auth/${provider}/set-project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: '${session}', projectId: id, projectName: name })
      })
      .then(r => r.json())
      .then(data => {
        if (data.ok) {
          window.location.href = '/auth/tracker-success?provider=${providerName}';
        } else {
          window.location.href = '/auth/tracker-error?msg=' + encodeURIComponent(data.error || 'Unknown error');
        }
      })
      .catch(() => {
        window.location.href = '/auth/tracker-error?msg=Network+error';
      });
    }
  </script>
</body>
</html>`;
}

function trackerSuccessHtml(provider) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Connected · Pact</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f4f5f7; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .card { background: white; border-radius: 12px; padding: 40px; max-width: 400px; width: 100%; box-shadow: 0 4px 24px rgba(0,0,0,0.10); text-align: center; }
    .icon { font-size: 48px; margin-bottom: 16px; }
    h1 { font-size: 22px; font-weight: 700; color: #1a1a2e; margin-bottom: 10px; }
    p { font-size: 15px; color: #666; line-height: 1.5; }
    .code { background: #f4f5f7; border-radius: 6px; padding: 3px 8px; font-family: monospace; font-size: 14px; color: #4f46e5; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✅</div>
    <h1>${provider} connected!</h1>
    <p>New pacts will sync to your project automatically.<br>You can manage this with <span class="code">/pact settings</span> in Slack.</p>
  </div>
</body>
</html>`;
}

function trackerErrorHtml(msg) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Error · Pact</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f4f5f7; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .card { background: white; border-radius: 12px; padding: 40px; max-width: 400px; width: 100%; box-shadow: 0 4px 24px rgba(0,0,0,0.10); text-align: center; }
    .icon { font-size: 48px; margin-bottom: 16px; }
    h1 { font-size: 22px; font-weight: 700; color: #b91c1c; margin-bottom: 10px; }
    p { font-size: 15px; color: #666; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">❌</div>
    <h1>Connection failed</h1>
    <p>${msg || 'Something went wrong. Please try again from Slack with'} <code>/pact settings</code>.</p>
  </div>
</body>
</html>`;
}

async function registerTrackerRoutes(app, pool) {
  const PROVIDERS = {
    linear: {
      getAuthUrl: tracker.getLinearAuthUrl,
      exchangeCode: tracker.exchangeLinearCode,
      getProjects: async (accessToken) => {
        const teams = await tracker.getLinearTeamsAndProjects(accessToken);
        const items = [];
        for (const team of teams) {
          // Add team itself as a target
          items.push({ id: team.id, name: `${team.name} (team)` });
          // Add projects within team
          for (const project of (team.projects?.nodes || [])) {
            items.push({ id: `${team.id}::${project.id}`, name: `${team.name} / ${project.name}` });
          }
        }
        return items;
      },
      tokenToConnection: (tokenData, teamId, userId) => ({
        teamId,
        provider: 'linear',
        accessToken: tokenData.access_token,
        refreshToken: null,
        expiresAt: tokenData.expires_in ? new Date(Date.now() + tokenData.expires_in * 1000) : null,
        connectedBy: userId
      })
    },
    asana: {
      getAuthUrl: tracker.getAsanaAuthUrl,
      exchangeCode: tracker.exchangeAsanaCode,
      getProjects: async (accessToken) => {
        const workspacesAndProjects = await tracker.getAsanaWorkspacesAndProjects(accessToken);
        const items = [];
        for (const { workspace, projects } of workspacesAndProjects) {
          for (const proj of projects) {
            items.push({ id: proj.gid, name: `${workspace.name} / ${proj.name}` });
          }
        }
        return items;
      },
      tokenToConnection: (tokenData, teamId, userId) => ({
        teamId,
        provider: 'asana',
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token || null,
        expiresAt: tokenData.expires_in ? new Date(Date.now() + tokenData.expires_in * 1000) : null,
        connectedBy: userId
      })
    },
    notion: {
      getAuthUrl: tracker.getNotionAuthUrl,
      exchangeCode: tracker.exchangeNotionCode,
      getProjects: async (accessToken) => {
        const dbs = await tracker.getNotionDatabases(accessToken);
        return dbs.map(db => ({
          id: db.id,
          name: db.title?.[0]?.plain_text || db.id
        }));
      },
      tokenToConnection: (tokenData, teamId, userId) => ({
        teamId,
        provider: 'notion',
        accessToken: tokenData.access_token,
        refreshToken: null,
        expiresAt: null,
        connectedBy: userId
      })
    }
  };

  for (const [provider, config] of Object.entries(PROVIDERS)) {
    // Step 1: Start OAuth — validate state and redirect to provider
    app.get(`/auth/${provider}/start`, (req, res) => {
      const state = req.query.state;
      if (!state) {
        return res.status(400).send('Missing state parameter.');
      }
      const configured = tracker.getConfiguredProviders();
      if (!configured[provider]) {
        return res.send(trackerErrorHtml(`${provider.charAt(0).toUpperCase() + provider.slice(1)} integration is not yet configured. Please contact support.`));
      }
      const authUrl = config.getAuthUrl(state);
      res.redirect(authUrl);
    });

    // Step 2: OAuth callback — exchange code for tokens, show project picker
    app.get(`/auth/${provider}/callback`, async (req, res) => {
      const { code, state, error: oauthError } = req.query;

      if (oauthError || !code) {
        return res.send(trackerErrorHtml(`Authorization was denied or failed. Please try again.`));
      }

      const stateData = tracker.consumeState(state);
      if (!stateData || stateData.provider !== provider) {
        return res.send(trackerErrorHtml('Session expired. Please start over from Slack.'));
      }

      try {
        // Exchange code for tokens
        const tokenData = await config.exchangeCode(code);
        const connData = config.tokenToConnection(tokenData, stateData.teamId, stateData.userId);

        // Save connection (without project yet)
        await tracker.saveTrackerConnection(pool, connData);

        // Fetch projects for the picker
        let projects = [];
        let projectError = null;
        try {
          projects = await config.getProjects(tokenData.access_token);
        } catch (err) {
          console.error(`[tracker] ${provider} project list error:`, err.message);
          projectError = 'Could not load projects. You can set this up later.';
        }

        // Create a pending session for the project selection step
        const sessionToken = generatePendingSession({
          teamId: stateData.teamId,
          provider
        });

        res.send(projectPickerHtml(provider, sessionToken, projects, projectError));

      } catch (err) {
        console.error(`[tracker] ${provider} callback error:`, err.message);
        res.send(trackerErrorHtml(`Connection failed: ${err.message}`));
      }
    });

    // Step 3: Select default project
    app.post(`/auth/${provider}/set-project`, express.json(), async (req, res) => {
      const { session, projectId, projectName } = req.body || {};
      if (!session || !projectId) {
        return res.json({ ok: false, error: 'Missing session or project ID.' });
      }

      const sessionData = consumePendingSession(session);
      if (!sessionData) {
        return res.json({ ok: false, error: 'Session expired. Please reconnect from Slack.' });
      }

      try {
        await tracker.setDefaultProject(pool, sessionData.teamId, provider, projectId, projectName || projectId);

        // Fix 3: DM the user to confirm their tracker is connected
        const providerLabel = { linear: 'Linear', asana: 'Asana', notion: 'Notion' }[provider] || provider;
        const botTokenResult = await pool.query(
          'SELECT bot_token FROM installations WHERE team_id = $1',
          [sessionData.teamId]
        );
        const botToken = botTokenResult.rows[0]?.bot_token;
        if (botToken && sessionData.userId) {
          try {
            const { URL } = require('url');
            const https = require('https');
            await new Promise((resolve, reject) => {
              const body = JSON.stringify({
                channel: sessionData.userId,
                text: `✅ ${providerLabel} connected — syncing to ${projectName || projectId}`,
                unfurl_link: false
              });
              const req = https.request('https://slack.com/api/chat.postMessage', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${botToken}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
              }, (res) => {
                let data = '';
                res.on('data', c => { data += c; });
                res.on('end', () => { try { JSON.parse(data); } catch {} resolve(); });
              });
              req.on('error', () => {});
              req.write(body);
              req.end();
            });
          } catch {}
        }

        res.json({ ok: true });
      } catch (err) {
        console.error(`[tracker] set-project error:`, err.message);
        res.json({ ok: false, error: err.message });
      }
    });
  }

  // Success and error pages
  app.get('/auth/tracker-success', (req, res) => {
    res.send(trackerSuccessHtml(req.query.provider || 'Tracker'));
  });

  app.get('/auth/tracker-error', (req, res) => {
    res.send(trackerErrorHtml(req.query.msg || 'Something went wrong.'));
  });
}


module.exports = { registerTrackerRoutes };
