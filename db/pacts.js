// Pact entity queries. Owns: active pact lookups, completion, backfill.
// Does NOT own: pact creation, reminders, or billing checks.
const pool = require('./index');

/**
 * Get active pacts for a channel, falling back to user-scoped if none found.
 */
async function getActivePactsForDone(channelId, userId) {
  // Try channel-scoped first
  let result = await pool.query(
    `SELECT * FROM pacts
     WHERE channel_id = $1 AND status = 'active'
     ORDER BY due_date ASC NULLS LAST`,
    [channelId]
  );

  // Fall back to all user's active pacts if none in this channel
  // WHY: Users run /done from the bot DM or a different channel than where
  // the pact was created. Without this, overdue pacts can't be completed.
  if (result.rows.length === 0) {
    result = await pool.query(
      `SELECT * FROM pacts
       WHERE (creator_slack_id = $1 OR counterparty_slack_id = $1) AND status = 'active'
       ORDER BY due_date ASC NULLS LAST
       LIMIT 15`,
      [userId]
    );
  }

  return result.rows;
}

/**
 * Get all active pacts for a user (cross-channel).
 */
async function getUserActivePacts(userId) {
  const result = await pool.query(
    `SELECT * FROM pacts
     WHERE (creator_slack_id = $1 OR counterparty_slack_id = $1) AND status = 'active'
     ORDER BY due_date ASC NULLS LAST, created_at DESC
     LIMIT 15`,
    [userId]
  );
  return result.rows;
}

/**
 * Mark a pact as completed. Returns the completed pact row or null if not authorized/found.
 */
async function markPactCompleted(pactId, userId) {
  const result = await pool.query(
    `UPDATE pacts
     SET status = 'completed', completed_at = NOW(), completed_by = $1
     WHERE id = $2
       AND (creator_slack_id = $1 OR counterparty_slack_id = $1)
       AND status = 'active'
     RETURNING *`,
    [userId, pactId]
  );
  return result.rows[0] || null;
}

/**
 * Check why a pact completion failed (already done, wrong user, or not found).
 */
async function getPactCompletionError(pactId, userId) {
  const checkResult = await pool.query(
    `SELECT id, status, creator_slack_id, counterparty_slack_id FROM pacts WHERE id = $1`,
    [pactId]
  );
  if (checkResult.rows.length === 0) {
    return `:x: Pact #${pactId} not found or you don't have permission to complete it.`;
  }
  const p = checkResult.rows[0];
  if (p.status === 'completed') {
    return `:white_check_mark: Pact #${pactId} is already completed — nothing to do!`;
  }
  if (p.creator_slack_id !== userId && p.counterparty_slack_id !== userId) {
    return `:x: Pact #${pactId} doesn't belong to you.`;
  }
  return `:x: Pact #${pactId} not found or you don't have permission to complete it.`;
}

/**
 * Get a pact's channel_id by pact ID.
 */
async function getPactChannelId(pactId) {
  const result = await pool.query('SELECT channel_id FROM pacts WHERE id = $1', [pactId]);
  return result.rows[0]?.channel_id || null;
}

/**
 * Store the channel + ts of the confirmation message sent to the creator.
 * Called after pact creation when we have the message ts available.
 */
async function updatePactConfirmation(pactId, channel, ts) {
  await pool.query(
    `UPDATE pacts SET confirmation_channel = $1, confirmation_ts = $2 WHERE id = $3`,
    [channel, ts, pactId]
  );
}

/**
 * Look up an active pact by its creator confirmation message (channel + ts).
 * Returns the pact row, or null if not found / already completed.
 */
async function getPactByConfirmation(channel, ts) {
  const result = await pool.query(
    `SELECT * FROM pacts
     WHERE confirmation_channel = $1 AND confirmation_ts = $2 AND status = 'active'
     LIMIT 1`,
    [channel, ts]
  );
  return result.rows[0] || null;
}

/**
 * Backfill counterparty on pacts where it's unknown.
 * WHY: In DMs with 2 people, we can't always detect the counterparty at creation time.
 */
async function backfillCounterparty(channelId, userId, userName) {
  const result = await pool.query(
    `SELECT id, creator_slack_id FROM pacts
     WHERE channel_id = $1 AND counterparty_slack_id IS NULL AND status = 'active'`,
    [channelId]
  );
  if (result.rows.length === 0) return;

  const toUpdate = result.rows.filter(p => p.creator_slack_id !== userId);
  if (toUpdate.length === 0) return;

  for (const pact of toUpdate) {
    await pool.query(
      `UPDATE pacts SET counterparty_slack_id = $1, counterparty_name = $2 WHERE id = $3`,
      [userId, userName, pact.id]
    );
    console.log(`[BACKFILL] Pact #${pact.id}: counterparty set to ${userId} (${userName})`);
  }
}

/**
 * Store the channel + ts of the reminder DM sent to the creator.
 * Called after sending a reminder so thread replies can resolve back to this pact.
 */
async function updateReminderTs(pactId, channel, ts) {
  await pool.query(
    `UPDATE pacts SET reminder_channel = $1, reminder_ts = $2 WHERE id = $3`,
    [channel, ts, pactId]
  );
}

/**
 * Look up an active pact by its reminder message thread (channel + ts).
 * Returns the pact row, or null if not found / already completed.
 */
async function getPactByReminderTs(channel, ts) {
  const result = await pool.query(
    `SELECT * FROM pacts
     WHERE reminder_channel = $1 AND reminder_ts = $2 AND status = 'active'
     LIMIT 1`,
    [channel, ts]
  );
  return result.rows[0] || null;
}

/**
 * Update the due_date of an active pact for snooze/reschedule.
 * Only the creator can snooze — counterparty is not notified (too noisy).
 * Returns the updated pact row, or null if not authorized/found.
 */
async function snoozePactDueDate(pactId, userId, newDueDate) {
  const result = await pool.query(
    `UPDATE pacts
     SET due_date = $1, last_reminded_at = NOW()
     WHERE id = $2
       AND creator_slack_id = $3
       AND status = 'active'
     RETURNING *`,
    [newDueDate, pactId, userId]
  );
  return result.rows[0] || null;
}

/**
 * Fetch a single active pact by ID (no user restriction — used to display in ephemeral).
 */
async function getPactById(pactId) {
  const result = await pool.query(
    `SELECT * FROM pacts WHERE id = $1 LIMIT 1`,
    [pactId]
  );
  return result.rows[0] || null;
}

/**
 * Mark a pact completed and return the full row. Used by completion flows that
 * need recurrence_rule + recurrence_group_id to spawn the next instance.
 */
async function markPactCompletedReturning(pactId, userId) {
  const result = await pool.query(
    `UPDATE pacts
     SET status = 'completed', completed_at = NOW(), completed_by = $1
     WHERE id = $2
       AND (creator_slack_id = $1 OR counterparty_slack_id = $1)
       AND status = 'active'
     RETURNING *`,
    [userId, pactId]
  );
  return result.rows[0] || null;
}

/**
 * Insert a new pact. Used by OAuth callback for cross-workspace starter pacts.
 * Supports counterparty_team_id for pacts that span workspaces (no channel_id).
 */
async function createPact({
  creatorSlackId, creatorTeamId, creatorName = 'Unknown',
  counterpartySlackId, counterpartyTeamId = null, counterpartyName = 'Unknown',
  description, dueDate, channelId = null, recurrenceRule = null,
}) {
  const result = await pool.query(
    `INSERT INTO pacts (team_id, channel_id, creator_slack_id, creator_name,
                        counterparty_slack_id, counterparty_team_id, counterparty_name,
                        description, due_date, status, recurrence_rule)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', $10)
     RETURNING *`,
    [
      creatorTeamId, channelId, creatorSlackId, creatorName,
      counterpartySlackId, counterpartyTeamId, counterpartyName,
      description, dueDate,
      recurrenceRule ? JSON.stringify(recurrenceRule) : null,
    ]
  );
  return result.rows[0];
}

/**
 * Insert a new pact as the next instance of a recurring series.
 * Copies creator/counterparty/team/channel/description from the parent pact;
 * overwrites due_date, recurrence_rule, and recurrence_group_id.
 */
async function createRecurringInstance({ teamId, channelId, creatorSlackId, creatorName,
  counterpartySlackId, counterpartyName, description, dueDate,
  recurrenceRule, recurrenceGroupId }) {
  const result = await pool.query(
    `INSERT INTO pacts (team_id, channel_id, creator_slack_id, creator_name,
                        counterparty_slack_id, counterparty_name, description,
                        due_date, status, recurrence_rule, recurrence_group_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9, $10)
     RETURNING id`,
    [teamId, channelId, creatorSlackId, creatorName,
     counterpartySlackId, counterpartyName, description,
     dueDate, JSON.stringify(recurrenceRule), recurrenceGroupId]
  );
  return result.rows[0];
}

/**
 * Fetch all active pacts in a recurrence group (for display grouping).
 */
async function getRecurrenceGroupPacts(recurrenceGroupId) {
  const result = await pool.query(
    `SELECT * FROM pacts
     WHERE recurrence_group_id = $1 AND status = 'active'
     ORDER BY due_date ASC NULLS LAST`,
    [recurrenceGroupId]
  );
  return result.rows;
}

/**
 * Promise streak: consecutive calendar days (in given timezone) with at least one
 * pact completed, walking back from today. Returns 0 if no completion today/yesterday.
 * WHY: We use UTC dates anchored to the user's local calendar day so the streak
 * reflects actual days they acted, not UTC midnight boundaries.
 */
async function getPromiseStreak(userId, tz = 'UTC') {
  // Fetch all completion dates in user's timezone, ordered most-recent first.
  // AT TIME ZONE converts completed_at to the user's tz so the date boundary
  // matches what the user sees on their calendar.
  const { rows } = await pool.query(
    `SELECT DISTINCT DATE(completed_at AT TIME ZONE $2) AS day
     FROM pacts
     WHERE creator_slack_id = $1
       AND status = 'completed'
       AND completed_at IS NOT NULL
     ORDER BY day DESC`,
    [userId, tz]
  );
  if (rows.length === 0) return 0;

  const today = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  today.setHours(0, 0, 0, 0);

  let streak = 0;
  let expected = new Date(today);

  for (const { day } of rows) {
    const d = new Date(day);
    d.setHours(0, 0, 0, 0);
    const diff = Math.round((expected - d) / 86400000);
    // Allow today or yesterday as first entry (streak still alive)
    if (streak === 0 && diff > 1) break;
    if (diff <= 1) {
      streak++;
      expected = d; // next expected = one day earlier
    } else {
      break;
    }
  }
  return streak;
}

/**
 * Weekly completion counts for the last 4 completed weeks (Mon–Sun).
 * Returns array of { week_start, count } oldest-first for sparkline rendering.
 */
async function getWeeklyTrend(userId) {
  const { rows } = await pool.query(
    `SELECT DATE_TRUNC('week', completed_at) AS week_start,
            COUNT(*) AS count
     FROM pacts
     WHERE creator_slack_id = $1
       AND status = 'completed'
       AND completed_at >= NOW() - INTERVAL '28 days'
     GROUP BY week_start
     ORDER BY week_start ASC`,
    [userId]
  );
  return rows.map(r => ({ weekStart: r.week_start, count: parseInt(r.count, 10) }));
}

/**
 * Personal all-time stats: total created, total completed, avg completion time,
 * on-time rate (completed before due_date).
 */
async function getPersonalStats(userId) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) AS total_created,
       COUNT(*) FILTER (WHERE status = 'completed') AS total_completed,
       AVG(
         EXTRACT(EPOCH FROM (completed_at - created_at)) / 3600.0
       ) FILTER (WHERE status = 'completed' AND completed_at IS NOT NULL) AS avg_hours,
       COUNT(*) FILTER (
         WHERE status = 'completed'
           AND due_date IS NOT NULL
           AND completed_at <= due_date
       ) AS on_time_count
     FROM pacts
     WHERE creator_slack_id = $1`,
    [userId]
  );
  const r = rows[0];
  const totalCreated = parseInt(r.total_created, 10);
  const totalCompleted = parseInt(r.total_completed, 10);
  const avgHours = r.avg_hours != null ? parseFloat(r.avg_hours) : null;
  const onTimeCount = parseInt(r.on_time_count, 10);
  return { totalCreated, totalCompleted, avgHours, onTimeCount };
}

/**
 * Team pulse for the workspace: pacts made + kept this week across all users.
 * Only returns data when 3+ distinct users have active or completed pacts.
 * Returns null when workspace doesn't qualify (privacy guard).
 */
async function getTeamPulse(teamId) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE created_at >= DATE_TRUNC('week', NOW())) AS made_this_week,
       COUNT(*) FILTER (
         WHERE status = 'completed'
           AND completed_at >= DATE_TRUNC('week', NOW())
       ) AS kept_this_week,
       COUNT(DISTINCT creator_slack_id) AS active_users
     FROM pacts
     WHERE team_id = $1
       AND created_at >= NOW() - INTERVAL '30 days'`,
    [teamId]
  );
  const r = rows[0];
  const activeUsers = parseInt(r.active_users, 10);
  if (activeUsers < 3) return null;
  return {
    madeThisWeek: parseInt(r.made_this_week, 10),
    keptThisWeek: parseInt(r.kept_this_week, 10),
    activeUsers,
  };
}

/**
 * Full personal stats for /pact stats command.
 * Returns: pacts created, completed, active, overdue; completion rate; current streak.
 * Current streak = consecutive days with a completed_on_time pact (from getPromiseStreak).
 */
async function getUserPactStats(userId) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) AS total_created,
       COUNT(*) FILTER (WHERE status = 'completed') AS total_completed,
       COUNT(*) FILTER (WHERE status = 'active') AS total_active,
       COUNT(*) FILTER (
         WHERE status = 'active'
           AND due_date IS NOT NULL
           AND due_date < NOW()
       ) AS overdue_count
     FROM pacts
     WHERE creator_slack_id = $1`,
    [userId]
  );
  const r = rows[0];
  const totalCreated   = parseInt(r.total_created, 10)    || 0;
  const totalCompleted = parseInt(r.total_completed, 10)  || 0;
  const totalActive    = parseInt(r.total_active, 10)      || 0;
  const overdueCount   = parseInt(r.overdue_count, 10)    || 0;
  const closedCount    = totalCreated - totalActive;
  const completionRate = closedCount > 0
    ? Math.round((totalCompleted / closedCount) * 100)
    : 0;
  return { totalCreated, totalCompleted, totalActive, overdueCount, completionRate };
}

/**
 * All-time best streak: longest run of consecutive completed-on-time days ever achieved.
 * Unlike getPromiseStreak which only counts the current tail, this scans every completed
 * pact date and picks the longest consecutive run.
 */
async function getBestStreak(userId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT DATE(completed_at AT TIME ZONE 'UTC') AS day
     FROM pacts
     WHERE creator_slack_id = $1
       AND status = 'completed'
       AND completed_at IS NOT NULL
       AND completed_at <= due_date
     ORDER BY day DESC`,
    [userId]
  );
  if (rows.length === 0) return 0;

  let best = 0;
  let current = 0;
  let prevDay = null;

  for (const { day } of rows) {
    const d = new Date(day);
    d.setHours(0, 0, 0, 0);
    if (prevDay === null) {
      current = 1;
    } else {
      const diff = Math.round((prevDay - d) / 86400000);
      if (diff === 1) {
        current++;
      } else {
        if (current > best) best = current;
        current = 1;
      }
    }
    prevDay = d;
  }
  if (current > best) best = current;
  return best;
}

async function getPublicStatsRaw() {
  const { rows } = await pool.query(`
    SELECT
      COUNT(DISTINCT team_id)                                       AS workspaces,
      COUNT(DISTINCT team_id) FILTER (
        WHERE EXISTS (SELECT 1 FROM pacts p2 WHERE p2.team_id = pacts.team_id AND p2.completed_at >= NOW() - INTERVAL '30 days')
      )                                                            AS active_workspaces,
      COUNT(*)                                                      AS total_commitments,
      COUNT(*) FILTER (WHERE completed_at IS NOT NULL)              AS pacts_kept,
      COUNT(*) FILTER (
        WHERE completed_at IS NOT NULL
          AND due_date IS NOT NULL
          AND completed_at::date <= due_date
          AND completed_at >= NOW() - INTERVAL '90 days'
      )                                                            AS on_time,
      COUNT(*) FILTER (
        WHERE completed_at IS NOT NULL
          AND due_date IS NOT NULL
          AND completed_at >= NOW() - INTERVAL '90 days'
      )                                                            AS completions_with_due
    FROM pacts
    WHERE team_id IS NOT NULL
  `);
  const r = rows[0];
  const workspaces       = parseInt(r.workspaces, 10)        || 0;
  const active_workspaces = parseInt(r.active_workspaces, 10)|| 0;
  const pacts_kept       = parseInt(r.pacts_kept, 10)        || 0;
  const total_commitments = parseInt(r.total_commitments, 10)|| 0;
  const on_time          = parseInt(r.on_time, 10)           || 0;
  const with_due         = parseInt(r.completions_with_due, 10)|| 0;
  return {
    workspaces,
    active_workspaces,
    pacts_kept,
    total_commitments,
    on_time_pct: with_due > 0 ? Math.round((on_time / with_due) * 100) : 0,
  };
}

module.exports = {
  getActivePactsForDone,
  getUserActivePacts,
  markPactCompleted,
  markPactCompletedReturning,
  createPact,
  createRecurringInstance,
  getRecurrenceGroupPacts,
  getPactCompletionError,
  getPactChannelId,
  updatePactConfirmation,
  getPactByConfirmation,
  backfillCounterparty,
  updateReminderTs,
  getPactByReminderTs,
  snoozePactDueDate,
  getPactById,
  getPromiseStreak,
  getWeeklyTrend,
  getPersonalStats,
  getTeamPulse,
  getPublicStatsRaw,
  getUserPactStats,
  getBestStreak,
};
