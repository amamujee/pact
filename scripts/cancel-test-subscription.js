/**
 * One-off admin script: cancel the active Stripe subscription for the test account.
 * Updates the local DB immediately rather than waiting for the webhook.
 * Usage: node scripts/cancel-test-subscription.js
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;

function log(msg) {
  console.log(`[cancel-sub] ${msg}`);
}

async function main() {
  if (!STRIPE_KEY) {
    console.error('[cancel-sub] STRIPE_SECRET_KEY is not set');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('[cancel-sub] DATABASE_URL is not set');
    process.exit(1);
  }

  // 1. Find the active subscription row
  const subResult = await pool.query(
    `SELECT id, team_id, stripe_customer_id, billing_email
     FROM subscriptions
     WHERE status = 'active'`
  );

  if (subResult.rows.length === 0) {
    log('No active subscriptions found in DB — nothing to cancel.');
    process.exit(0);
  }

  if (subResult.rows.length > 1) {
    log(`WARNING: found ${subResult.rows.length} active subscriptions — expected 1. Rows:`);
    subResult.rows.forEach(r => log(JSON.stringify(r)));
    console.error('[cancel-sub] Aborting: ambiguous state. Cancel manually or narrow the query.');
    process.exit(1);
  }

  const { id: subRowId, team_id: teamId, stripe_customer_id: customerId, billing_email: email } = subResult.rows[0];
  log(`Found active subscription row: id=${subRowId} team_id=${teamId} customer=${customerId} email=${email}`);

  // 2. List active Stripe subscriptions for that customer
  const listUrl = `https://api.stripe.com/v1/subscriptions?customer=${encodeURIComponent(customerId)}&status=active&limit=10`;
  const listRes = await fetch(listUrl, {
    headers: { 'Authorization': `Bearer ${STRIPE_KEY}` },
  });

  if (!listRes.ok) {
    const body = await listRes.json().catch(() => ({}));
    console.error(`[cancel-sub] Stripe list error ${listRes.status}: ${body?.error?.message}`);
    process.exit(1);
  }

  const listData = await listRes.json();
  const stripeSubscriptions = listData.data || [];
  log(`Stripe active subscriptions for customer ${customerId}: [${stripeSubscriptions.map(s => s.id).join(', ')}]`);

  if (stripeSubscriptions.length === 0) {
    log('No active Stripe subscriptions found — updating DB only.');
  }

  // 3. Cancel each subscription immediately (no prorate = no refund)
  for (const stripeSub of stripeSubscriptions) {
    log(`Cancelling Stripe subscription ${stripeSub.id}...`);
    const cancelRes = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(stripeSub.id)}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${STRIPE_KEY}` },
    });

    const cancelData = await cancelRes.json().catch(() => ({}));
    if (!cancelRes.ok) {
      console.error(`[cancel-sub] Stripe cancel error ${cancelRes.status}: ${cancelData?.error?.message}`);
      process.exit(1);
    }
    log(`Stripe subscription ${stripeSub.id} status: ${cancelData.status}`);
  }

  // 4. Update local DB — mirror handleSubscriptionDeleted
  await pool.query(
    `UPDATE subscriptions SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [subRowId]
  );
  log(`DB subscriptions row ${subRowId} marked cancelled`);

  await pool.query(
    `UPDATE installations SET tier = 'free', updated_at = NOW() WHERE team_id = $1`,
    [teamId]
  );
  log(`DB installations team ${teamId} downgraded to free`);

  log('Done.');
}

main()
  .catch(err => {
    console.error('[cancel-sub] Unexpected error:', err);
    process.exit(1);
  })
  .finally(() => pool.end());
