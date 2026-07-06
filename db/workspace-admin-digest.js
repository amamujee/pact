// db/workspace-admin-digest.js
// Owns: workspace_admin_digest_prefs table and workspace-level pact stats aggregation.
// Does NOT own: sending emails (handled by the cron script), Slack digests, or user-level prefs.

const db = require('./index');

/**
 * Get workspace digest prefs, with upsert to bootstrap enabled workspaces.
 * Returns null if team has no row (not installed yet).
 */
async function getPrefs(teamId) {
  const { rows } = await db.query(
    `SELECT * FROM workspace_admin_digest_prefs WHERE team_id = $1`,
    [teamId]
  );
  return rows[0] || null;
}

/**
 * Get or initialize digest prefs for a workspace.
 * Used by manual trigger endpoints to bootstrap a workspace's prefs.
 */
async function getOrCreatePrefs(teamId, adminEmail, adminName) {
  const { rows } = await db.query(`
    INSERT INTO workspace_admin_digest_prefs (team_id, admin_email, admin_name)
    VALUES ($1, $2, $3)
    ON CONFLICT (team_id) DO UPDATE SET updated_at = NOW()
    RETURNING *
  `, [teamId, adminEmail, adminName]);
  return rows[0];
}

/**
 * Get all workspaces due for a weekly admin digest.
 * Fires every hour; filters by local day/hour in JS for the same reason as user digests.
 * Excludes workspaces where send is not enabled or last_sent is within 6 days.
 */
async function getWorkspacesDueForDigest() {
  const { rows } = await db.query(`
    SELECT w.team_id, w.admin_email, w.admin_name, w.send_day, w.send_hour,
           w.last_sent_at, i.team_name
    FROM workspace_admin_digest_prefs w
    JOIN installations i ON i.team_id = w.team_id
    WHERE w.enabled = true
      AND (w.last_sent_at IS NULL OR w.last_sent_at < NOW() - INTERVAL '6 days')
  `);
  return rows;
}

/**
 * Mark digest as sent for a workspace.
 */
async function markDigestSent(teamId) {
  await db.query(`
    UPDATE workspace_admin_digest_prefs
    SET last_sent_at = NOW(), updated_at = NOW()
    WHERE team_id = $1
  `, [teamId]);
}

/**
 * Get workspace-level pact stats for the email digest.
 * Returns counts for the past 7 days and current snapshot.
 */
async function getWorkspaceDigestStats(teamId) {
  const { rows } = await db.query(`
    SELECT
      (SELECT COUNT(*) FROM pacts WHERE team_id = $1 AND created_at >= NOW() - INTERVAL '7 days') AS created_this_week,
      (SELECT COUNT(*) FROM pacts WHERE team_id = $1 AND status = 'completed' AND completed_at >= NOW() - INTERVAL '7 days') AS completed_this_week,
      (SELECT COUNT(*) FROM pacts WHERE team_id = $1 AND status = 'active' AND due_date < NOW()) AS overdue_count,
      (SELECT COUNT(*) FROM pacts WHERE team_id = $1 AND status = 'active') AS active_count,
      (SELECT COUNT(*) FROM pacts WHERE team_id = $1 AND status = 'completed') AS total_completed,
      (SELECT COUNT(*) FROM pacts WHERE team_id = $1 AND due_date >= NOW() AND due_date <= NOW() + INTERVAL '7 days' AND status = 'active') AS upcoming_next_7d
  `, [teamId]);
  return rows[0];
}

/**
 * Get top overdue pacts for the digest email (with creator name).
 */
async function getOverduePactsForDigest(teamId, limit = 5) {
  const { rows } = await db.query(`
    SELECT p.id, p.description, p.due_date, p.creator_name, p.created_at
    FROM pacts p
    WHERE p.team_id = $1
      AND p.status = 'active'
      AND p.due_date < NOW()
    ORDER BY p.due_date ASC NULLS LAST
    LIMIT $2
  `, [teamId, limit]);
  return rows;
}

/**
 * Get recent completed pacts for the digest email.
 */
async function getRecentCompletedPacts(teamId, limit = 3) {
  const { rows } = await db.query(`
    SELECT p.id, p.description, p.completed_at, p.creator_name
    FROM pacts p
    WHERE p.team_id = $1
      AND p.status = 'completed'
      AND p.completed_at >= NOW() - INTERVAL '7 days'
    ORDER BY p.completed_at DESC
    LIMIT $2
  `, [teamId, limit]);
  return rows;
}

module.exports = {
  getPrefs,
  getOrCreatePrefs,
  getWorkspacesDueForDigest,
  markDigestSent,
  getWorkspaceDigestStats,
  getOverduePactsForDigest,
  getRecentCompletedPacts,
};