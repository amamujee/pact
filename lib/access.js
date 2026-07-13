'use strict';

// Pact is free for every workspace. The legacy `pro` value is returned only so
// existing feature checks enable every capability without a data migration.
const PLAN_MONTHLY_LIMITS = { free: null, pro: null };

async function getTeamTier() { return 'pro'; }
function planBadge() { return '*Free · all features*'; }

async function getMonthlyPactCount(teamId, pool) {
  if (!pool) return 0;
  try {
    const result = await pool.query(
      `SELECT COUNT(*) AS cnt FROM pacts WHERE team_id = $1 AND status = 'active'
       AND created_at >= date_trunc('month', CURRENT_TIMESTAMP)`, [teamId]
    );
    return parseInt(result.rows[0]?.cnt || '0', 10);
  } catch (err) {
    console.error('[access] getMonthlyPactCount error:', err.message);
    return 0;
  }
}

module.exports = { getTeamTier, planBadge, getMonthlyPactCount, PLAN_MONTHLY_LIMITS };
