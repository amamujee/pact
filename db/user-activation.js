// db/user-activation.js
// Owns: user_activation state + activation_events analytics queries.
// Does NOT own: pact creation, Slack messaging, or billing state.

'use strict';

const pool = require('./index');

/**
 * Find installer users whose workspace was installed 22–26 hours ago,
 * haven't created any pacts, and haven't received an activation DM yet.
 * Returns rows with: team_id, user_id, team_name, bot_token, installed_at
 */
async function getEligibleActivationUsers() {
  const { rows } = await pool.query(`
    SELECT
      i.team_id,
      i.installer_user_id AS user_id,
      i.team_name,
      i.bot_token,
      i.updated_at AS installed_at
    FROM installations i
    LEFT JOIN user_activation ua
      ON ua.team_id = i.team_id AND ua.user_id = i.installer_user_id
    LEFT JOIN pacts p
      ON p.team_id = i.team_id AND p.creator_slack_id = i.installer_user_id
    WHERE
      i.installer_user_id IS NOT NULL
      AND i.bot_token IS NOT NULL
      AND i.updated_at >= NOW() - INTERVAL '26 hours'
      AND i.updated_at <= NOW() - INTERVAL '22 hours'
      AND p.id IS NULL
      AND (ua.id IS NULL OR ua.activation_dm_sent_at IS NULL)
  `);
  return rows;
}

/**
 * Upsert a user_activation row and mark the activation DM as sent.
 * Idempotent — safe to call multiple times (ON CONFLICT DO UPDATE).
 */
async function markActivationDmSent(teamId, userId) {
  await pool.query(`
    INSERT INTO user_activation (team_id, user_id, activation_dm_sent_at, updated_at)
    VALUES ($1, $2, NOW(), NOW())
    ON CONFLICT (team_id, user_id) DO UPDATE SET
      activation_dm_sent_at = COALESCE(user_activation.activation_dm_sent_at, NOW()),
      updated_at = NOW()
  `, [teamId, userId]);
}

/**
 * Mark that a user clicked the activation DM CTA (opened the pact modal).
 * Only records the first click — subsequent clicks are ignored.
 */
async function markActivationDmClicked(teamId, userId) {
  await pool.query(`
    INSERT INTO user_activation (team_id, user_id, activation_dm_clicked_at, updated_at)
    VALUES ($1, $2, NOW(), NOW())
    ON CONFLICT (team_id, user_id) DO UPDATE SET
      activation_dm_clicked_at = COALESCE(user_activation.activation_dm_clicked_at, NOW()),
      updated_at = NOW()
  `, [teamId, userId]);
}

/**
 * Log the result of a Slack postMessage call for the activation DM.
 * Stores the full API response (ok, ts, error) as metadata on the event.
 * event_type: 'activation_dm_delivered' | 'activation_dm_failed' | 'activation_dm_attempted'
 */
async function logActivationDelivery(teamId, userId, eventType, slackResponse) {
  const metadata = {
    ok: slackResponse?.ok ?? false,
    ts: slackResponse?.ts ?? null,
    error: slackResponse?.error ?? null,
    channel: slackResponse?.channel ?? null,
  };
  await pool.query(`
    INSERT INTO activation_events (team_id, user_id, event_type, metadata)
    VALUES ($1, $2, $3, $4)
  `, [teamId, userId, eventType, JSON.stringify(metadata)]);
}

/**
 * Mark that a user created a pact from the activation DM flow.
 */
async function markActivationPactCreated(teamId, userId) {
  await pool.query(`
    INSERT INTO user_activation (team_id, user_id, activation_pact_created_at, updated_at)
    VALUES ($1, $2, NOW(), NOW())
    ON CONFLICT (team_id, user_id) DO UPDATE SET
      activation_pact_created_at = COALESCE(user_activation.activation_pact_created_at, NOW()),
      updated_at = NOW()
  `, [teamId, userId]);
}

/**
 * Record a funnel event for analytics.
 * event_type: 'activation_dm_sent' | 'activation_dm_clicked' | 'activation_pact_created'
 */
async function recordActivationEvent(teamId, userId, eventType, metadata = null) {
  await pool.query(`
    INSERT INTO activation_events (team_id, user_id, event_type, metadata)
    VALUES ($1, $2, $3, $4)
  `, [teamId, userId, eventType, metadata ? JSON.stringify(metadata) : null]);
}

/**
 * Funnel data for /admin/activation dashboard.
 * Returns daily counts: installs, DMs sent, DM clicks, pacts created from DM.
 */
async function getActivationFunnel(days = 30) {
  const { rows } = await pool.query(`
    WITH daily AS (
      SELECT
        DATE_TRUNC('day', ae.occurred_at) AS day,
        COUNT(*) FILTER (WHERE ae.event_type = 'activation_dm_attempted') AS dms_attempted,
        COUNT(*) FILTER (WHERE ae.event_type = 'activation_dm_delivered') AS dms_sent,
        COUNT(*) FILTER (WHERE ae.event_type = 'activation_dm_failed') AS dms_failed,
        COUNT(*) FILTER (WHERE ae.event_type = 'activation_dm_clicked') AS dm_clicks,
        COUNT(*) FILTER (WHERE ae.event_type = 'activation_pact_created') AS pacts_created
      FROM activation_events ae
      WHERE ae.occurred_at >= NOW() - INTERVAL '${days} days'
      GROUP BY 1
    ),
    installs AS (
      SELECT
        DATE_TRUNC('day', i.updated_at) AS day,
        COUNT(*) AS new_installs
      FROM installations i
      WHERE i.updated_at >= NOW() - INTERVAL '${days} days'
      GROUP BY 1
    )
    SELECT
      COALESCE(installs.day, daily.day) AS day,
      COALESCE(installs.new_installs, 0) AS new_installs,
      COALESCE(daily.dms_attempted, 0) AS dms_attempted,
      COALESCE(daily.dms_sent, 0) AS dms_sent,
      COALESCE(daily.dms_failed, 0) AS dms_failed,
      COALESCE(daily.dm_clicks, 0) AS dm_clicks,
      COALESCE(daily.pacts_created, 0) AS pacts_created
    FROM daily
    FULL OUTER JOIN installs ON installs.day = daily.day
    ORDER BY day DESC
    LIMIT ${days}
  `);
  return rows;
}

/**
 * Upsert welcome_dm_sent_at in the installations row.
 * Idempotent — safe to call multiple times (ON CONFLICT DO UPDATE).
 */
async function markWelcomeDmSent(teamId, userId) {
  await pool.query(`
    UPDATE installations
    SET welcome_dm_sent_at = NOW()
    WHERE team_id = $1 AND installer_user_id = $2
  `, [teamId, userId]);
}

/**
 * Check whether the welcome DM has already been sent for this installer.
 */
async function isWelcomeDmSent(teamId, userId) {
  const { rows } = await pool.query(`
    SELECT welcome_dm_sent_at
    FROM installations
    WHERE team_id = $1 AND installer_user_id = $2
  `, [teamId, userId]);
  return rows[0]?.welcome_dm_sent_at != null;
}

/**
 * Check whether the first-pact celebration DM has already been sent for a user.
 * Uses the activation_events table for idempotency.
 */
async function isFirstPactCelebrated(teamId, userId) {
  const { rows } = await pool.query(`
    SELECT id FROM activation_events
    WHERE team_id = $1 AND user_id = $2 AND event_type = 'first_pact_celebrated'
    LIMIT 1
  `, [teamId, userId]);
  return rows.length > 0;
}

/**
 * Record that the first-pact celebration DM was sent.
 */
async function recordFirstPactCelebrated(teamId, userId) {
  await pool.query(`
    INSERT INTO activation_events (team_id, user_id, event_type)
    VALUES ($1, $2, 'first_pact_celebrated')
  `, [teamId, userId]);
}

/**
 * Totals for the admin dashboard summary row.
 */
async function getActivationTotals() {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE event_type = 'activation_dm_attempted') AS total_dms_attempted,
      COUNT(*) FILTER (WHERE event_type = 'activation_dm_delivered') AS total_dms_sent,
      COUNT(*) FILTER (WHERE event_type = 'activation_dm_failed') AS total_dms_failed,
      COUNT(*) FILTER (WHERE event_type = 'activation_dm_clicked') AS total_clicks,
      COUNT(*) FILTER (WHERE event_type = 'activation_pact_created') AS total_conversions
    FROM activation_events
  `);
  return rows[0] || { total_dms_attempted: 0, total_dms_sent: 0, total_dms_failed: 0, total_clicks: 0, total_conversions: 0 };
}

module.exports = {
  getEligibleActivationUsers,
  markActivationDmSent,
  markActivationDmClicked,
  markActivationPactCreated,
  recordActivationEvent,
  logActivationDelivery,
  getActivationFunnel,
  getActivationTotals,
  markWelcomeDmSent,
  isWelcomeDmSent,
  isFirstPactCelebrated,
  recordFirstPactCelebrated,
};
