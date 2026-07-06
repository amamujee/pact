// db/invites.js
// Owns: workspace_invites CRUD, invite event logging, invite link generation.
// Does NOT own: OAuth callback logic (receives token for validation/claim).

'use strict';

const pool = require('./index');
const { appUrl } = require('../lib/app-url');

// ---------------------------------------------------------------------------
// Token & link generation
// ---------------------------------------------------------------------------

function generateToken() {
  const bytes = require('crypto').randomBytes(24);
  return bytes.toString('base64url');
}

function buildInviteLink(token) {
  return appUrl(`/invite/${token}`);
}

// ---------------------------------------------------------------------------
// Create invite
// ---------------------------------------------------------------------------

/**
 * Creates a workspace invite. Generates token + link if none provided.
 * Returns the invite row.
 */
async function createInvite({ inviterUserId, inviterTeamId, token = null, metadata = {} }) {
  const tok = token || generateToken();
  const link = buildInviteLink(tok);

  const { rows } = await pool.query(
    `INSERT INTO workspace_invites (inviter_user_id, inviter_team_id, token, invite_link)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [inviterUserId, inviterTeamId, tok, link]
  );

  // Log creation event
  await logInviteEvent({ token: tok, eventType: 'invite_created', metadata });

  return rows[0];
}

// ---------------------------------------------------------------------------
// Get invite by token
// ---------------------------------------------------------------------------

async function getInviteByToken(token) {
  const { rows } = await pool.query(
    'SELECT * FROM workspace_invites WHERE token = $1',
    [token]
  );
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// Claim invite (mark as used)
// ---------------------------------------------------------------------------

/**
 * Marks an invite as claimed. Only claims if not already claimed.
 * Returns the invite row, or null if not found / already claimed.
 */
async function claimInvite({ token, claimedTeamId, claimedUserId }) {
  const { rows } = await pool.query(
    `UPDATE workspace_invites
       SET claimed_at = NOW(), claimed_team_id = $2, claimed_user_id = $3
     WHERE token = $1 AND claimed_at IS NULL
     RETURNING *`,
    [token, claimedTeamId, claimedUserId]
  );
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// Invite link copy (regenerate link URL for existing invite)
// ---------------------------------------------------------------------------

async function getInviteLink(token) {
  const invite = await getInviteByToken(token);
  return invite ? invite.invite_link : null;
}

// ---------------------------------------------------------------------------
// My invites (all invites created by a user)
// ---------------------------------------------------------------------------

async function getInvitesByUser(inviterUserId, inviterTeamId) {
  const { rows } = await pool.query(
    `SELECT vi.*,
            (SELECT COUNT(*) FROM workspace_invites v2
               WHERE v2.inviter_user_id = vi.inviter_user_id
                 AND v2.inviter_team_id = vi.inviter_team_id
                 AND v2.claimed_at IS NOT NULL) AS teams_joined_total,
            COUNT(ie.id) FILTER (WHERE ie.event_type = 'invite_clicked') AS total_clicks
     FROM workspace_invites vi
     LEFT JOIN invite_events ie ON ie.token = vi.token
     WHERE vi.inviter_user_id = $1 AND vi.inviter_team_id = $2
     GROUP BY vi.id
     ORDER BY vi.created_at DESC`,
    [inviterUserId, inviterTeamId]
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Stats: total teams joined through a user
// ---------------------------------------------------------------------------

async function getTeamsJoinedCount(inviterUserId, inviterTeamId) {
  const { rows } = await pool.query(
    `SELECT COUNT(DISTINCT claimed_team_id) AS count
     FROM workspace_invites
     WHERE inviter_user_id = $1 AND inviter_team_id = $2 AND claimed_at IS NOT NULL`,
    [inviterUserId, inviterTeamId]
  );
  return parseInt(rows[0]?.count || 0, 10);
}

// ---------------------------------------------------------------------------
// Event logging
// ---------------------------------------------------------------------------

async function logInviteEvent({ token, eventType, metadata = {} }) {
  try {
    await pool.query(
      `INSERT INTO invite_events (token, event_type, metadata)
       VALUES ($1, $2, $3)`,
      [token, eventType, JSON.stringify(metadata)]
    );
  } catch (err) {
    console.error('[INVITES] Failed to log event:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Record click (called when someone visits /invite/:token)
// ---------------------------------------------------------------------------

async function recordInviteClicked(token, metadata = {}) {
  await logInviteEvent({ token, eventType: 'invite_clicked', metadata });
}

// ---------------------------------------------------------------------------
// Record installation (called after OAuth completes with invite token)
// ---------------------------------------------------------------------------

async function recordInviteInstalled(token, metadata = {}) {
  await logInviteEvent({ token, eventType: 'invite_installed', metadata });
}

// ---------------------------------------------------------------------------
// Leaderboard: top inviters by teams joined
// ---------------------------------------------------------------------------

async function getInviteLeaderboard(limit = 10) {
  const { rows } = await pool.query(
    `SELECT inviter_user_id, inviter_team_id,
            COUNT(DISTINCT claimed_team_id) AS teams_joined,
            COUNT(*) FILTER (WHERE claimed_at IS NOT NULL) AS total_invites
     FROM workspace_invites
     WHERE claimed_at IS NOT NULL
     GROUP BY inviter_user_id, inviter_team_id
     ORDER BY teams_joined DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Successful invite count (installs where new workspace created ≥1 pact in 7d,
// and haven't been counted yet toward a Pro grant).
// Called from pact-creation hook to backfill pact_created_within_7d flag.
// ---------------------------------------------------------------------------

/**
 * Mark a claimed invite as "pact created within 7 days" so it counts
 * toward the inviter's Pro grant threshold. Only marks if:
 *   1. Invite was claimed by claimedTeamId
 *   2. Claimed within last 7 days
 *   3. Not already marked
 * Returns true if row was updated (first time marking), false otherwise.
 */
async function markInvitePactCreated(claimedTeamId) {
  try {
    const { rowCount } = await pool.query(
      `UPDATE workspace_invites
         SET pact_created_within_7d = TRUE
       WHERE claimed_team_id = $1
         AND claimed_at IS NOT NULL
         AND claimed_at > NOW() - INTERVAL '7 days'
         AND pact_created_within_7d = FALSE`,
      [claimedTeamId]
    );
    return rowCount > 0;
  } catch (err) {
    console.error('[INVITES] markInvitePactCreated error:', err.message);
    return false;
  }
}

/**
 * Get qualifying successful invites for an inviter that haven't been granted Pro yet.
 * Returns rows that are: claimed, pact_created_within_7d=true, pro_grant_counted=false,
 * and claimed by a *different* workspace than the inviter.
 */
async function getUncountedSuccessfulInvites(inviterUserId, inviterTeamId) {
  const { rows } = await pool.query(
    `SELECT id, claimed_team_id
     FROM workspace_invites
     WHERE inviter_user_id = $1
       AND inviter_team_id = $2
       AND claimed_at IS NOT NULL
       AND pact_created_within_7d = TRUE
       AND pro_grant_counted = FALSE
       AND claimed_team_id IS NOT NULL
       AND claimed_team_id != $2`,
    [inviterUserId, inviterTeamId]
  );
  return rows;
}

/**
 * Get total count of successful invites for an inviter (including already-counted ones).
 * Used for progress display ("X / 2 workspaces invited").
 */
async function getSuccessfulInviteCount(inviterUserId, inviterTeamId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS count
     FROM workspace_invites
     WHERE inviter_user_id = $1
       AND inviter_team_id = $2
       AND claimed_at IS NOT NULL
       AND pact_created_within_7d = TRUE
       AND claimed_team_id IS NOT NULL
       AND claimed_team_id != $2`,
    [inviterUserId, inviterTeamId]
  );
  return parseInt(rows[0]?.count || 0, 10);
}

/**
 * Mark invite rows as counted (pro_grant_counted=true) after a Pro grant is issued.
 * Idempotent — safe to call multiple times.
 */
async function markInvitesGrantCounted(inviteIds) {
  if (!inviteIds || inviteIds.length === 0) return;
  await pool.query(
    `UPDATE workspace_invites
       SET pro_grant_counted = TRUE
     WHERE id = ANY($1::uuid[])`,
    [inviteIds]
  );
}

// ---------------------------------------------------------------------------
// Pro grants (Stripe-less time-bounded Pro)
// ---------------------------------------------------------------------------

/**
 * Create a pro_grant row and upgrade the team's tier to 'pro'.
 * Idempotent if a grant already exists for the same reason + team.
 * Returns { granted: boolean, expiresAt: Date }.
 */
async function grantProForInvites({ teamId, grantedToUserId, days = 30 }) {
  // Idempotency: check if this team already has an active invite-incentive grant
  const existing = await pool.query(
    `SELECT id, expires_at FROM pro_grants
     WHERE team_id = $1 AND granted_by = 'invite_incentive' AND expires_at > NOW()
     LIMIT 1`,
    [teamId]
  );
  if (existing.rows.length > 0) {
    // Already granted — return existing
    return { granted: false, expiresAt: existing.rows[0].expires_at };
  }

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + days);

  await pool.query(
    `INSERT INTO pro_grants (team_id, granted_by, granted_to, reason, days, expires_at, redeemed, redeemed_at)
     VALUES ($1, 'invite_incentive', $2, 'Invited 2 workspaces to Pact', $3, $4, TRUE, NOW())`,
    [teamId, grantedToUserId, days, expiresAt]
  );

  // Upgrade tier in installations
  await pool.query(
    `UPDATE installations SET tier = 'pro', updated_at = NOW() WHERE team_id = $1`,
    [teamId]
  );

  console.log(`[INVITE-PRO] Pro granted to team=${teamId} user=${grantedToUserId} for ${days} days (expires ${expiresAt.toISOString()})`);
  return { granted: true, expiresAt };
}

/**
 * Check if a pro_grant for invite_incentive exists and is still active.
 * Used to expire Pro when the grant period ends (future cron).
 */
async function getActiveInviteGrant(teamId) {
  const { rows } = await pool.query(
    `SELECT id, expires_at, days FROM pro_grants
     WHERE team_id = $1 AND granted_by = 'invite_incentive' AND expires_at > NOW()
     LIMIT 1`,
    [teamId]
  );
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// Admin funnel metrics
// ---------------------------------------------------------------------------

/**
 * Returns invite funnel totals for admin dashboard.
 * invite_sent_count = distinct invite links created
 * invite_claimed_count = invite links that resulted in a completed install
 * pro_granted_count = teams that received invite-incentive Pro grants
 */
async function getInviteFunnelTotals() {
  const { rows } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM workspace_invites) AS invite_sent_count,
      (SELECT COUNT(*) FROM workspace_invites WHERE claimed_at IS NOT NULL) AS invite_claimed_count,
      (SELECT COUNT(*) FROM pro_grants WHERE granted_by = 'invite_incentive') AS pro_granted_count
  `);
  return rows[0] || { invite_sent_count: 0, invite_claimed_count: 0, pro_granted_count: 0 };
}

module.exports = {
  generateToken,
  buildInviteLink,
  createInvite,
  getInviteByToken,
  claimInvite,
  getInviteLink,
  getInvitesByUser,
  getTeamsJoinedCount,
  logInviteEvent,
  recordInviteClicked,
  recordInviteInstalled,
  getInviteLeaderboard,
  markInvitePactCreated,
  getUncountedSuccessfulInvites,
  getSuccessfulInviteCount,
  markInvitesGrantCounted,
  grantProForInvites,
  getActiveInviteGrant,
  getInviteFunnelTotals,
};
