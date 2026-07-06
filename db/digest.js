// db/digest.js
// Owns: user_digest_prefs table queries and digest-related pact aggregation.
// Does NOT own: pact creation, reminder logic, or Slack message dispatch.

const db = require('./index');

/**
 * Get or create digest prefs for a user.
 * Upserts with defaults on first access so every user gets a row.
 */
async function getOrCreateDigestPrefs(userId, teamId, timezone = 'America/New_York') {
  const { rows } = await db.query(`
    INSERT INTO user_digest_prefs (user_id, team_id, timezone)
    VALUES ($1, $2, $3)
    ON CONFLICT (user_id, team_id) DO UPDATE SET updated_at = NOW()
    RETURNING *
  `, [userId, teamId, timezone]);
  return rows[0];
}

/**
 * Update digest prefs for a user.
 * Partial update — only supplied fields are changed.
 */
async function updateDigestPrefs(userId, teamId, updates) {
  const fields = [];
  const values = [];
  let i = 1;

  const allowed = ['frequency', 'send_day', 'send_hour', 'timezone', 'digest_snoozed_until', 'digest_opt_out'];
  for (const key of allowed) {
    if (key in updates) {
      fields.push(`${key} = $${i}`);
      values.push(updates[key]);
      i++;
    }
  }

  if (fields.length === 0) return;

  fields.push(`updated_at = NOW()`);
  values.push(userId, teamId);

  const { rows } = await db.query(`
    UPDATE user_digest_prefs
    SET ${fields.join(', ')}
    WHERE user_id = $${i} AND team_id = $${i + 1}
    RETURNING *
  `, values);
  return rows[0];
}

/**
 * Mark digest as sent for a user.
 */
async function markDigestSent(userId, teamId) {
  await db.query(`
    UPDATE user_digest_prefs
    SET last_digest_sent_at = NOW(), updated_at = NOW()
    WHERE user_id = $1 AND team_id = $2
  `, [userId, teamId]);
}

/**
 * Get all users who are due for a weekly digest right now.
 * "Due" = opted in, not snoozed, and either never sent or sent > 6 days ago.
 * Returns rows with user_id, team_id, timezone, send_day, send_hour.
 */
async function getUsersDueForWeeklyDigest() {
  // We check all users with weekly frequency, then filter by local day/hour in JS
  // to avoid complex timezone math in SQL. This runs every 30 min so drift is acceptable.
  const { rows } = await db.query(`
    SELECT u.user_id, u.team_id, u.timezone, u.send_day, u.send_hour,
           u.last_digest_sent_at, u.digest_snoozed_until
    FROM user_digest_prefs u
    WHERE u.frequency = 'weekly'
      AND u.digest_opt_out = false
      AND (u.last_digest_sent_at IS NULL OR u.last_digest_sent_at < NOW() - INTERVAL '6 days')
      AND (u.digest_snoozed_until IS NULL OR u.digest_snoozed_until < NOW())
  `);
  return rows;
}

/**
 * Get all users with active pacts (for first-time digest prefs creation).
 * Returns distinct (user_id, team_id) pairs.
 */
async function getActiveUsers() {
  const { rows } = await db.query(`
    SELECT DISTINCT u AS user_id, team_id
    FROM pacts,
         unnest(ARRAY[creator_slack_id, counterparty_slack_id]) AS u
    WHERE status = 'active'
      AND u IS NOT NULL
  `);
  return rows;
}

/**
 * Get pact activity summary for a user for the weekly digest:
 * - activePacts: pacts currently active (the user is creator or counterparty)
 * - overduePacts: subset of active that are past due_date
 * - completedThisWeek: pacts completed in the last 7 days by this user
 */
async function getUserDigestData(userId) {
  const [activeResult, completedResult] = await Promise.all([
    db.query(`
      SELECT *
      FROM pacts
      WHERE status = 'active'
        AND (creator_slack_id = $1 OR counterparty_slack_id = $1)
      ORDER BY due_date ASC NULLS LAST
    `, [userId]),
    db.query(`
      SELECT *
      FROM pacts
      WHERE status = 'completed'
        AND completed_by = $1
        AND completed_at >= NOW() - INTERVAL '7 days'
      ORDER BY completed_at DESC
    `, [userId])
  ]);

  const activePacts = activeResult.rows;
  const now = new Date();
  const overduePacts = activePacts.filter(p => p.due_date && new Date(p.due_date) < now);

  return {
    activePacts,
    overduePacts,
    completedThisWeek: completedResult.rows,
  };
}

/**
 * Get a single pact by ID (for extend/snooze action validation).
 */
async function getPactById(pactId) {
  const { rows } = await db.query(`SELECT * FROM pacts WHERE id = $1`, [pactId]);
  return rows[0] || null;
}

/**
 * Extend a pact's due date.
 */
async function extendPactDueDate(pactId, newDueDate) {
  const { rows } = await db.query(`
    UPDATE pacts SET due_date = $2 WHERE id = $1 RETURNING *
  `, [pactId, newDueDate]);
  return rows[0] || null;
}

/**
 * Get pact activity for a user's daily morning digest:
 * - pactsDueToday: active pacts with due_date within the next 24 hours (but not overdue)
 * - overduePacts: active pacts already past due_date
 * - dueSoon: active pacts due in the next 48 hours (for context)
 */
async function getUserDailyDigestData(userId) {
  const [activeResult] = await Promise.all([
    db.query(`
      SELECT *
      FROM pacts
      WHERE status = 'active'
        AND (creator_slack_id = $1 OR counterparty_slack_id = $1)
      ORDER BY due_date ASC NULLS LAST
    `, [userId])
  ]);

  const now = new Date();
  const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const allActive = activeResult.rows;

  const overduePacts = allActive.filter(p => p.due_date && new Date(p.due_date) < now);
  const pactsDueToday = allActive.filter(p => {
    if (!p.due_date) return false;
    const d = new Date(p.due_date);
    return d >= now && d <= in24h;
  });
  // "Coming up" = due in 1-7 days, not today, not overdue
  const upcomingPacts = allActive.filter(p => {
    if (!p.due_date) return false;
    const d = new Date(p.due_date);
    const in7d = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    return d > in24h && d <= in7d;
  });

  return { allActive, pactsDueToday, overduePacts, upcomingPacts };
}

/**
 * Get all users eligible for a daily morning digest right now.
 * "Eligible" = frequency = 'daily', opted in, not snoozed, not sent in the last 20 hours.
 */
async function getUsersDueForDailyDigest() {
  const { rows } = await db.query(`
    SELECT u.user_id, u.team_id, u.timezone, u.send_hour,
           u.daily_last_sent_at, u.digest_snoozed_until
    FROM user_digest_prefs u
    WHERE u.frequency = 'daily'
      AND u.digest_opt_out = false
      AND (u.daily_last_sent_at IS NULL OR u.daily_last_sent_at < NOW() - INTERVAL '20 hours')
      AND (u.digest_snoozed_until IS NULL OR u.digest_snoozed_until < NOW())
  `);
  return rows;
}

/**
 * Mark daily digest as sent for a user.
 */
async function markDailyDigestSent(userId, teamId) {
  await db.query(`
    UPDATE user_digest_prefs
    SET daily_last_sent_at = NOW(), updated_at = NOW()
    WHERE user_id = $1 AND team_id = $2
  `, [userId, teamId]);
}

module.exports = {
  getOrCreateDigestPrefs,
  updateDigestPrefs,
  markDigestSent,
  getUsersDueForWeeklyDigest,
  getActiveUsers,
  getUserDigestData,
  getUserDailyDigestData,
  getUsersDueForDailyDigest,
  markDailyDigestSent,
  getPactById,
  extendPactDueDate,
};
