// db/streak-milestones.js
// Owns: streak_milestones, streak_share_cards, streak_analytics queries.
// Does NOT own: pact queries, billing, Slack API calls, or HTML rendering.

'use strict';

const pool = require('./index');
const { randomBytes } = require('crypto');

/**
 * Check whether a milestone has already been awarded for this user + workspace + day count.
 * Returns true if already awarded (prevents double-DM).
 */
async function hasMilestoneBeenAwarded(userId, teamId, milestoneDays) {
  const { rows } = await pool.query(
    `SELECT 1 FROM streak_milestones
     WHERE user_id = $1 AND slack_team_id = $2 AND milestone_days = $3
     LIMIT 1`,
    [userId, teamId, milestoneDays]
  );
  return rows.length > 0;
}

/**
 * Record a awarded milestone. No-op if already recorded (UNIQUE constraint).
 * Returns the inserted row or null if it was a duplicate.
 */
async function recordMilestone(userId, teamId, milestoneDays) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO streak_milestones (user_id, slack_team_id, milestone_days)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, slack_team_id, milestone_days) DO NOTHING
       RETURNING *`,
      [userId, teamId, milestoneDays]
    );
    return rows[0] || null;
  } catch (err) {
    // Non-fatal — log and continue so the DM can still send
    console.error(`[STREAK] recordMilestone error user=${userId} days=${milestoneDays}:`, err.message);
    return null;
  }
}

/**
 * Create a share card record for a user + milestone.
 * Generates a random opaque token (12 chars, URL-safe base64).
 * Returns the token so it can be embedded in the DM.
 */
async function createShareCard({ userId, teamId, milestoneDays, displayName, pactsKept, onTimePct }) {
  // 12-byte random → 16-char base64url (no padding, URL-safe)
  const token = randomBytes(9).toString('base64url').slice(0, 12);

  await pool.query(
    `INSERT INTO streak_share_cards
       (token, user_id, slack_team_id, milestone_days, display_name, pacts_kept, on_time_pct)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (token) DO NOTHING`,
    [token, userId, teamId, milestoneDays, displayName || null, pactsKept, onTimePct]
  );

  return token;
}

/**
 * Get a share card by token. Returns null if not found or expired.
 */
async function getShareCard(token) {
  const { rows } = await pool.query(
    `SELECT * FROM streak_share_cards
     WHERE token = $1 AND expires_at > NOW()
     LIMIT 1`,
    [token]
  );
  return rows[0] || null;
}

/**
 * Get the most recent non-expired share card for a user, regardless of milestone.
 * Used by /pact share to find an existing card to reuse.
 */
async function getLatestShareCardForUser(userId, teamId) {
  const { rows } = await pool.query(
    `SELECT * FROM streak_share_cards
     WHERE user_id = $1 AND slack_team_id = $2 AND expires_at > NOW()
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, teamId]
  );
  return rows[0] || null;
}

/**
 * Log a card analytics event (viewed or shared).
 * ip_hash is optional — only used for view dedup.
 */
async function logStreakAnalytics(token, event, { platform = null, ipHash = null } = {}) {
  try {
    await pool.query(
      `INSERT INTO streak_analytics (token, event, platform, ip_hash)
       VALUES ($1, $2, $3, $4)`,
      [token, event, platform, ipHash]
    );
  } catch (err) {
    // Non-fatal analytics failure — never block the user experience
    console.error(`[STREAK] logStreakAnalytics error token=${token} event=${event}:`, err.message);
  }
}

/**
 * Get all active Slack user IDs + team IDs that have at least one completed pact today
 * but have not yet been processed for milestone detection.
 * WHY: We scan ALL users with completions — the milestone check is idempotent (ON CONFLICT DO NOTHING)
 * so it's safe to call on users that have no new milestones.
 */
async function getUsersWithRecentCompletions() {
  const { rows } = await pool.query(
    `SELECT DISTINCT creator_slack_id AS user_id, team_id AS slack_team_id
     FROM pacts
     WHERE status = 'completed'
       AND completed_at >= NOW() - INTERVAL '2 days'
     LIMIT 500`
  );
  return rows;
}

module.exports = {
  hasMilestoneBeenAwarded,
  recordMilestone,
  createShareCard,
  getShareCard,
  getLatestShareCardForUser,
  logStreakAnalytics,
  getUsersWithRecentCompletions,
};
