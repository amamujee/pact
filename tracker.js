/**
 * tracker.js — Tracker integration module (Linear, Asana, Notion)
 *
 * Pro-tier feature. Syncs pacts to connected trackers when created/completed.
 */
'use strict';

const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { URL } = require('url');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const APP_URL = process.env.APP_URL || 'https://makepact.co';
const ENCRYPTION_KEY_HEX = process.env.TRACKER_ENCRYPTION_KEY || '';

// In-memory OAuth state store (state → { teamId, userId, provider, expiresAt })
const oauthStates = new Map();

// ---------------------------------------------------------------------------
// Encryption helpers (AES-256-GCM)
// ---------------------------------------------------------------------------
function getEncryptionKey() {
  if (!ENCRYPTION_KEY_HEX || ENCRYPTION_KEY_HEX.length < 32) {
    // Fallback: derive a key from a constant — not production-safe,
    // but allows the app to start without crashing in dev.
    return crypto.scryptSync('pact-tracker-fallback-key', 'salt', 32);
  }
  const key = Buffer.from(ENCRYPTION_KEY_HEX, 'hex');
  if (key.length !== 32) {
    return crypto.scryptSync(ENCRYPTION_KEY_HEX, 'salt', 32);
  }
  return key;
}

function encryptToken(plaintext) {
  if (!plaintext) return null;
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

function decryptToken(encrypted) {
  if (!encrypted) return null;
  try {
    const [ivHex, authTagHex, data] = encrypted.split(':');
    const key = getEncryptionKey();
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(data, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error('[tracker] Token decryption failed:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTTP helper (no external dependencies)
// ---------------------------------------------------------------------------
function httpRequest(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const lib = parsed.protocol === 'https:' ? https : http;
    const body = options.body ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : null;

    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + (parsed.search || ''),
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(options.headers || {}),
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {})
      }
    };

    const req = lib.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data), raw: data });
        } catch {
          resolve({ status: res.statusCode, body: data, raw: data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// OAuth state management
// ---------------------------------------------------------------------------
function generateState(teamId, userId, provider) {
  const token = crypto.randomBytes(24).toString('hex');
  oauthStates.set(token, {
    teamId,
    userId,
    provider,
    expiresAt: Date.now() + 10 * 60 * 1000 // 10 min
  });
  return token;
}

function consumeState(token) {
  const state = oauthStates.get(token);
  if (!state) return null;
  oauthStates.delete(token);
  if (Date.now() > state.expiresAt) return null;
  return state;
}

// ---------------------------------------------------------------------------
// Pro tier check
// ---------------------------------------------------------------------------
async function isProTeam(pool, teamId) {
  try {
    const result = await pool.query(
      'SELECT tier FROM installations WHERE team_id = $1',
      [teamId]
    );
    const tier = result.rows[0]?.tier || 'free';
    return tier === 'pro';
  } catch (err) {
    console.error('[tracker] tier check error:', err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// LINEAR
// ---------------------------------------------------------------------------
const LINEAR_CLIENT_ID = process.env.LINEAR_CLIENT_ID || '';
const LINEAR_CLIENT_SECRET = process.env.LINEAR_CLIENT_SECRET || '';
const LINEAR_REDIRECT_URI = `${APP_URL}/auth/linear/callback`;

function getLinearAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: LINEAR_CLIENT_ID,
    redirect_uri: LINEAR_REDIRECT_URI,
    response_type: 'code',
    scope: 'read,write',
    state,
    actor: 'user',
    prompt: 'consent'
  });
  return `https://linear.app/oauth/authorize?${params}`;
}

async function exchangeLinearCode(code) {
  const res = await httpRequest('https://api.linear.app/oauth/token', {
    method: 'POST',
    body: {
      code,
      redirect_uri: LINEAR_REDIRECT_URI,
      client_id: LINEAR_CLIENT_ID,
      client_secret: LINEAR_CLIENT_SECRET,
      grant_type: 'authorization_code'
    }
  });
  if (res.status !== 200) throw new Error(`Linear token exchange failed: ${res.raw}`);
  return res.body; // { access_token, token_type, expires_in, scope }
}

async function getLinearTeamsAndProjects(accessToken) {
  const query = `
    query {
      teams {
        nodes {
          id
          name
          projects {
            nodes {
              id
              name
            }
          }
        }
      }
    }
  `;
  const res = await httpRequest('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}` },
    body: { query }
  });
  if (res.status !== 200) throw new Error(`Linear teams query failed: ${res.raw}`);
  return res.body?.data?.teams?.nodes || [];
}

async function createLinearIssue(accessToken, teamId, projectId, pact) {
  const dueDate = pact.due_date ? new Date(pact.due_date).toISOString().split('T')[0] : null;

  // Build description body with promiser/recipient context
  const descParts = [];
  if (pact.creator_name) descParts.push(`Promiser: ${pact.creator_name}`);
  if (pact.counterparty_name) descParts.push(`Recipient: ${pact.counterparty_name}`);
  if (dueDate) descParts.push(`Due: ${dueDate}`);
  descParts.push('_Created via Pact_');
  const descriptionBody = descParts.join('  \n');

  const mutationParts = [
    `teamId: \"${teamId}\"`,
    `title: \"${escapeGraphQL(pact.description)}\"`,
    `description: \"${escapeGraphQL(descriptionBody)}\"`,
  ];
  if (dueDate) mutationParts.push(`dueDate: \"${dueDate}\"`);
  if (projectId) mutationParts.push(`projectId: \"${projectId}\"`);

  const mutation = `
    mutation {
      issueCreate(input: { ${mutationParts.join(', ')} }) {
        success
        issue {
          id
          identifier
          url
        }
      }
    }
  `;

  const res = await httpRequest('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}` },
    body: { query: mutation }
  });

  if (res.status !== 200 || !res.body?.data?.issueCreate?.success) {
    throw new Error(`Linear issue creation failed: ${res.raw}`);
  }
  return res.body.data.issueCreate.issue;
}

async function completeLinearIssue(accessToken, issueId) {
  // Get the &quot;Done&quot; state for this issue's team
  const query = `
    query {
      issue(id: \"${issueId}\") {
        team {
          states {
            nodes { id name type }
          }
        }
      }
    }
  `;
  const statesRes = await httpRequest('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}` },
    body: { query }
  });

  const states = statesRes.body?.data?.issue?.team?.states?.nodes || [];
  const doneState = states.find(s => s.type === 'completed') || states.find(s => s.name.toLowerCase() === 'done');

  if (!doneState) {
    console.warn('[tracker] Linear: no Done state found for issue', issueId);
    return;
  }

  const mutation = `
    mutation {
      issueUpdate(id: \"${issueId}\", input: { stateId: \"${doneState.id}\" }) {
        success
      }
    }
  `;
  await httpRequest('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}` },
    body: { query: mutation }
  });
}

async function addLinearIssueComment(accessToken, issueId, body) {
  const mutation = `
    mutation {
      commentCreate(input: { issueId: \"${escapeGraphQL(issueId)}\", body: \"${escapeGraphQL(body)}\" }) {
        success
      }
    }
  `;
  await httpRequest('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}` },
    body: { query: mutation }
  });
}

// ---------------------------------------------------------------------------
// ASANA
// ---------------------------------------------------------------------------
const ASANA_CLIENT_ID = process.env.ASANA_CLIENT_ID || '';
const ASANA_CLIENT_SECRET = process.env.ASANA_CLIENT_SECRET || '';
const ASANA_REDIRECT_URI = `${APP_URL}/auth/asana/callback`;

function getAsanaAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: ASANA_CLIENT_ID,
    redirect_uri: ASANA_REDIRECT_URI,
    response_type: 'code',
    state
  });
  return `https://app.asana.com/-/oauth_authorize?${params}`;
}

async function exchangeAsanaCode(code) {
  const res = await httpRequest('https://app.asana.com/-/oauth_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      redirect_uri: ASANA_REDIRECT_URI,
      client_id: ASANA_CLIENT_ID,
      client_secret: ASANA_CLIENT_SECRET,
      grant_type: 'authorization_code'
    }).toString()
  });
  if (res.status !== 200) throw new Error(`Asana token exchange failed: ${res.raw}`);
  return res.body; // { access_token, refresh_token, token_type, expires_in, data }
}

async function getAsanaWorkspacesAndProjects(accessToken) {
  const wsRes = await httpRequest('https://app.asana.com/api/1.0/workspaces', {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });
  const workspaces = wsRes.body?.data || [];

  const result = [];
  for (const ws of workspaces) {
    try {
      const projRes = await httpRequest(
        `https://app.asana.com/api/1.0/projects?workspace=${ws.gid}&limit=50`,
        { headers: { 'Authorization': `Bearer ${accessToken}` } }
      );
      const projects = projRes.body?.data || [];
      result.push({ workspace: ws, projects });
    } catch (err) {
      console.error('[tracker] Asana project fetch error:', err.message);
    }
  }
  return result;
}

async function createAsanaTask(accessToken, projectId, pact) {
  const body = {
    data: {
      name: pact.description,
      projects: [projectId],
      ...(pact.due_date ? { due_on: new Date(pact.due_date).toISOString().split('T')[0] } : {})
    }
  };
  const res = await httpRequest('https://app.asana.com/api/1.0/tasks', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}` },
    body
  });
  if (res.status !== 201) throw new Error(`Asana task creation failed: ${res.raw}`);
  return res.body.data; // { gid, permalink_url, ... }
}

async function completeAsanaTask(accessToken, taskId) {
  const res = await httpRequest(`https://app.asana.com/api/1.0/tasks/${taskId}`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${accessToken}` },
    body: { data: { completed: true } }
  });
  if (res.status !== 200) {
    console.warn('[tracker] Asana task complete failed:', res.raw);
  }
}

// ---------------------------------------------------------------------------
// NOTION
// ---------------------------------------------------------------------------
const NOTION_CLIENT_ID = process.env.NOTION_CLIENT_ID || '';
const NOTION_CLIENT_SECRET = process.env.NOTION_CLIENT_SECRET || '';
const NOTION_REDIRECT_URI = `${APP_URL}/auth/notion/callback`;

function getNotionAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: NOTION_CLIENT_ID,
    redirect_uri: NOTION_REDIRECT_URI,
    response_type: 'code',
    owner: 'user',
    state
  });
  return `https://api.notion.com/v1/oauth/authorize?${params}`;
}

async function exchangeNotionCode(code) {
  const credentials = Buffer.from(`${NOTION_CLIENT_ID}:${NOTION_CLIENT_SECRET}`).toString('base64');
  const res = await httpRequest('https://api.notion.com/v1/oauth/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${credentials}` },
    body: {
      grant_type: 'authorization_code',
      code,
      redirect_uri: NOTION_REDIRECT_URI
    }
  });
  if (res.status !== 200) throw new Error(`Notion token exchange failed: ${res.raw}`);
  return res.body; // { access_token, token_type, bot_id, workspace_id, workspace_name, ... }
}

async function getNotionDatabases(accessToken) {
  const res = await httpRequest('https://api.notion.com/v1/search', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Notion-Version': '2022-06-28'
    },
    body: {
      filter: { value: 'database', property: 'object' },
      page_size: 50
    }
  });
  if (res.status !== 200) throw new Error(`Notion database list failed: ${res.raw}`);
  return res.body?.results || [];
}

async function createNotionPage(accessToken, databaseId, pact) {
  const properties = {
    'Name': {
      title: [{ text: { content: pact.description } }]
    },
    'Status': {
      select: { name: 'Active' }
    }
  };

  if (pact.due_date) {
    properties['Due Date'] = {
      date: { start: new Date(pact.due_date).toISOString().split('T')[0] }
    };
  }

  const res = await httpRequest('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Notion-Version': '2022-06-28'
    },
    body: {
      parent: { database_id: databaseId },
      properties
    }
  });

  if (res.status !== 200) throw new Error(`Notion page creation failed: ${res.raw}`);
  return res.body; // { id, url, ... }
}

async function completeNotionPage(accessToken, pageId) {
  const res = await httpRequest(`https://api.notion.com/v1/pages/${pageId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Notion-Version': '2022-06-28'
    },
    body: {
      properties: {
        'Status': { select: { name: 'Complete' } }
      }
    }
  });
  if (res.status !== 200) {
    console.warn('[tracker] Notion page update failed:', res.raw);
  }
}

// ---------------------------------------------------------------------------
// Main sync functions
// ---------------------------------------------------------------------------
const PROVIDER_LABELS = { linear: 'Linear', asana: 'Asana', notion: 'Notion' };

/**
 * Send a Slack DM via the bot token. Returns true on success, false on failure.
 */
async function sendSlackDM(botToken, userId, text) {
  if (!botToken || !userId) return false;
  try {
    const res = await httpRequest('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${botToken}`,
        'Content-Type': 'application/json'
      },
      body: { channel: userId, text, unfurl_link: false }
    });
    return res.status === 200 && res.body?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Sync a newly-created pact to ALL connected trackers for the team.
 * Fire-and-forget — do not throw on failure.
 *
 * Fix 1: Loops through ALL connections (no LIMIT 1)
 * Fix 2: Token-presence check instead of env var guard
 * Fix 4: DM pact creator with tracker link on success
 * Fix 5: DM pact creator with error on failure
 *
 * @param {object} options
 * @param {string} [options.creatorSlackId]  — Slack user ID for DM notifications
 */
async function syncPactToTracker(pool, pact, teamId, options = {}) {
  const { creatorSlackId } = options;

  try {
    const isPro = await isProTeam(pool, teamId);
    if (!isPro) return;

    // Fix 1: Fetch ALL tracker connections (no LIMIT 1)
    const connResult = await pool.query(
      'SELECT * FROM tracker_connections WHERE slack_team_id = $1',
      [teamId]
    );
    if (connResult.rows.length === 0) return;

    // Fetch bot token for Slack DMs (Fix 4/5)
    const botTokenResult = await pool.query(
      'SELECT bot_token FROM installations WHERE team_id = $1',
      [teamId]
    );
    const botToken = botTokenResult.rows[0]?.bot_token || null;

    for (const conn of connResult.rows) {
      try {
        const accessToken = decryptToken(conn.access_token);
        // Fix 2: check token presence, not env vars
        if (!accessToken) continue;

        if (!conn.default_project_id) {
          console.log(`[tracker] ${conn.provider}: no default project set for team ${teamId}`);
          continue;
        }

        let externalId, externalUrl;

        if (conn.provider === 'linear') {
          // default_project_id format: &quot;teamId::projectId&quot; or just &quot;teamId&quot;
          const [linearTeamId, linearProjectId] = conn.default_project_id.split('::');
          const issue = await createLinearIssue(accessToken, linearTeamId, linearProjectId || null, pact);
          externalId = issue.id;
          externalUrl = issue.url;

        } else if (conn.provider === 'asana') {
          const task = await createAsanaTask(accessToken, conn.default_project_id, pact);
          externalId = task.gid;
          externalUrl = task.permalink_url;

        } else if (conn.provider === 'notion') {
          const page = await createNotionPage(accessToken, conn.default_project_id, pact);
          externalId = page.id;
          externalUrl = page.url;
        }

        if (externalId) {
          await pool.query(
            `INSERT INTO pact_tracker_syncs (pact_id, provider, external_id, external_url, sync_status)
             VALUES ($1, $2, $3, $4, 'synced')
             ON CONFLICT (pact_id, provider) DO UPDATE
               SET external_id = EXCLUDED.external_id,
                   external_url = EXCLUDED.external_url,
                   sync_status = 'synced',
                   last_synced_at = NOW()`,
            [pact.id, conn.provider, externalId, externalUrl || null]
          );
          console.log(`[tracker] ${conn.provider}: synced pact #${pact.id} → ${externalId}`);

          // Fix 4: DM the pact creator with the tracker link
          if (creatorSlackId && botToken && externalUrl) {
            const label = PROVIDER_LABELS[conn.provider] || conn.provider;
            await sendSlackDM(botToken, creatorSlackId, `📎 Synced to ${label}: ${externalUrl}`);
          }
        }

      } catch (connErr) {
        console.error(`[tracker] ${conn.provider} sync error for pact #${pact.id}:`, connErr.message);

        // Fix 5: Send error DM to pact creator
        if (creatorSlackId && botToken) {
          const label = PROVIDER_LABELS[conn.provider] || conn.provider;
          await sendSlackDM(botToken, creatorSlackId, `⚠️ Couldn't sync to ${label}. Check /pact settings.`);
        }
      }
    }

  } catch (err) {
    console.error(`[tracker] sync error for pact #${pact.id}:`, err.message);
  }
}

/**
 * Mark a pact as complete in ALL connected trackers.
 * Fire-and-forget — do not throw on failure.
 */
async function completePactInTracker(pool, pactId, teamId, options = {}) {
  const { completedByName, completedAt } = options;
  try {
    const syncResult = await pool.query(
      'SELECT * FROM pact_tracker_syncs WHERE pact_id = $1',
      [pactId]
    );
    if (syncResult.rows.length === 0) return;

    for (const sync of syncResult.rows) {
      try {
        const connResult = await pool.query(
          'SELECT * FROM tracker_connections WHERE slack_team_id = $1 AND provider = $2',
          [teamId, sync.provider]
        );
        if (connResult.rows.length === 0) continue;

        const conn = connResult.rows[0];
        const accessToken = decryptToken(conn.access_token);
        if (!accessToken) continue;

        if (sync.provider === 'linear') {
          await completeLinearIssue(accessToken, sync.external_id);
          // Add a comment noting who completed the pact and when
          try {
            const dateStr = completedAt
              ? new Date(completedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
              : new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
            const commenter = completedByName || 'a team member';
            await addLinearIssueComment(accessToken, sync.external_id, `Pact completed by ${commenter} on ${dateStr}`);
          } catch (commentErr) {
            console.warn(`[tracker] Linear: comment failed for issue ${sync.external_id}:`, commentErr.message);
          }
        } else if (sync.provider === 'asana') {
          await completeAsanaTask(accessToken, sync.external_id);
        } else if (sync.provider === 'notion') {
          await completeNotionPage(accessToken, sync.external_id);
        }

        await pool.query(
          `UPDATE pact_tracker_syncs
           SET sync_status = 'completed', last_synced_at = NOW()
           WHERE id = $1`,
          [sync.id]
        );
        console.log(`[tracker] ${sync.provider}: completed pact #${pactId} → ${sync.external_id}`);

      } catch (err) {
        console.error(`[tracker] complete error for pact #${pactId} (${sync.provider}):`, err.message);
      }
    }

  } catch (err) {
    console.error(`[tracker] completePactInTracker error:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// Settings helpers (called from server.js)
// ---------------------------------------------------------------------------

/**
 * Get the current tracker connection status for a team.
 */
async function getTrackerStatus(pool, teamId) {
  try {
    const result = await pool.query(
      'SELECT provider, default_project_name, updated_at FROM tracker_connections WHERE slack_team_id = $1',
      [teamId]
    );
    const connected = {};
    for (const row of result.rows) {
      connected[row.provider] = {
        projectName: row.default_project_name,
        connectedAt: row.updated_at
      };
    }
    return connected;
  } catch (err) {
    return {};
  }
}

/**
 * Remove a tracker connection for a team.
 */
async function disconnectTracker(pool, teamId, provider) {
  await pool.query(
    'DELETE FROM tracker_connections WHERE slack_team_id = $1 AND provider = $2',
    [teamId, provider]
  );
}

/**
 * Save a tracker connection.
 */
async function saveTrackerConnection(pool, { teamId, provider, accessToken, refreshToken, expiresAt, connectedBy }) {
  const encAccess = encryptToken(accessToken);
  const encRefresh = refreshToken ? encryptToken(refreshToken) : null;
  await pool.query(
    `INSERT INTO tracker_connections
       (slack_team_id, provider, access_token, refresh_token, token_expires_at, connected_by_user_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (slack_team_id, provider) DO UPDATE
       SET access_token = EXCLUDED.access_token,
           refresh_token = COALESCE(EXCLUDED.refresh_token, tracker_connections.refresh_token),
           token_expires_at = EXCLUDED.token_expires_at,
           connected_by_user_id = EXCLUDED.connected_by_user_id,
           updated_at = NOW()`,
    [teamId, provider, encAccess, encRefresh, expiresAt || null, connectedBy || null]
  );
}

/**
 * Set the default project for a tracker connection.
 */
async function setDefaultProject(pool, teamId, provider, projectId, projectName) {
  await pool.query(
    `UPDATE tracker_connections
     SET default_project_id = $3, default_project_name = $4, updated_at = NOW()
     WHERE slack_team_id = $1 AND provider = $2`,
    [teamId, provider, projectId, projectName]
  );
}

// ---------------------------------------------------------------------------
// Provider configuration check
// ---------------------------------------------------------------------------
/**
 * Returns which providers have OAuth credentials configured in env vars.
 * Providers without credentials will show as "coming soon" in the settings UI
 * instead of a broken Connect button.
 */
function getConfiguredProviders() {
  return {
    linear: !!(LINEAR_CLIENT_ID && LINEAR_CLIENT_SECRET),
    asana: !!(ASANA_CLIENT_ID && ASANA_CLIENT_SECRET),
    notion: !!(NOTION_CLIENT_ID && NOTION_CLIENT_SECRET),
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  // OAuth
  generateState,
  consumeState,
  getLinearAuthUrl,
  getAsanaAuthUrl,
  getNotionAuthUrl,
  exchangeLinearCode,
  exchangeAsanaCode,
  exchangeNotionCode,
  // Project lists
  getLinearTeamsAndProjects,
  getAsanaWorkspacesAndProjects,
  getNotionDatabases,
  // DB helpers
  isProTeam,
  saveTrackerConnection,
  setDefaultProject,
  getTrackerStatus,
  disconnectTracker,
  // Config
  getConfiguredProviders,
  // Sync
  syncPactToTracker,
  completePactInTracker,
  // Encryption (exported for testing)
  encryptToken,
  decryptToken,
};

// ---------------------------------------------------------------------------
// Util
// ---------------------------------------------------------------------------
function escapeGraphQL(str) {
  if (!str) return '';
  return str.replace(/\\/g, '\\\\').replace(/&quot;/g, '\\&quot;').replace(/\n/g, '\\n');
}