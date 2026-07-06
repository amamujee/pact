// lib/billing-routes.js
// Owns: Stripe billing integration, plan tier lookup, checkout/subscription webhooks, billing portal routes
// Does NOT own: Slack handlers, metrics dashboard, page routes, tracker routes

'use strict';

const express = require('express');
const path = require('path');
const { getAppUrl } = require('./app-url');
const { registerContact, sendEmail } = require('./email-client');

// pool is set via init() so getTeamTier and getMonthlyPactCount can use it as a module-level dep
let pool;

function init(deps) {
  pool = deps.pool;
}

// ---------------------------------------------------------------------------
// Billing Helpers
// ---------------------------------------------------------------------------

// Plan limits: max active pacts a team can create per calendar month.
// null = unlimited
// 2-tier model: Free (100/month) + Pro (unlimited)
const PLAN_MONTHLY_LIMITS = { free: 100, pro: null };

async function getTeamTier(teamId) {
  try {
    const result = await pool.query(
      'SELECT tier FROM installations WHERE team_id = $1',
      [teamId]
    );
    return result.rows[0]?.tier || 'free';
  } catch (err) {
    console.error('[billing] getTeamTier error:', err.message);
    return 'free';
  }
}

// Returns a short plan badge string for inline use in Slack mrkdwn.
// Pro: gold star + "Pro ✦" — Free: muted "Free"
function planBadge(tier) {
  return tier === 'pro' ? '*Pro ✦*' : '_Free_';
}

// Count active pacts created by this team in the current calendar month
async function getMonthlyPactCount(teamId) {
  try {
    const result = await pool.query(
      `SELECT COUNT(*) AS cnt FROM pacts
       WHERE team_id = $1
         AND status = 'active'
         AND created_at >= date_trunc('month', CURRENT_TIMESTAMP)`,
      [teamId]
    );
    return parseInt(result.rows[0]?.cnt || '0', 10);
  } catch (err) {
    console.error('[billing] getMonthlyPactCount error:', err.message);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Billing Routes
// ---------------------------------------------------------------------------

const STRIPE_LINKS = {
  // Recurring subscription link ($10/mo) with success_url that includes session_id
  // for auto-activation. Recreated 2026-05-07 with correct success_url containing
  // {CHECKOUT_SESSION_ID} so the success page can auto-activate the subscription.
  // Old link (7sYeVdfYK0rN437eSh2ZO03) was missing the session_id redirect param.
  pro: 'https://buy.stripe.com/00w5kDdQCcav2Z3fWl2ZO04',
};

async function fetchStripeCheckoutSession(sessionId) {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return null;

  const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { Authorization: `Bearer ${stripeKey}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Stripe session lookup failed (${res.status}): ${body}`);
  }
  return res.json();
}

function isPaidStripeSession(session) {
  return session && (session.payment_status === 'paid' || session.status === 'complete');
}

// ---------------------------------------------------------------------------
// Stripe webhook event handlers
// ---------------------------------------------------------------------------

/**
 * checkout.session.completed — auto-activate Pro for the workspace that paid.
 * The client_reference_id is "{team_id}__{user_id}" (embedded by the upgrade button).
 */
async function handleCheckoutCompleted(session, pool) {
  const ref = session.client_reference_id || '';
  const [teamId, userId] = ref.split('__');

  // Fallback: check session metadata for slack_team_id if client_reference_id is missing
  const resolvedTeamId = teamId || (session.metadata && session.metadata.slack_team_id) || '';
  const resolvedUserId = userId || '';

  if (!resolvedTeamId) {
    console.warn('[stripe-webhook] checkout.session.completed: missing client_reference_id AND metadata.slack_team_id — cannot auto-activate. Session:', session.id);
    return;
  }

  const sessionId = session.id;
  const customerEmail = session.customer_details?.email || null;
  const stripeCustomerId = session.customer || null;

  console.log(`[stripe-webhook] checkout.session.completed: team=${resolvedTeamId} user=${resolvedUserId || 'unknown'} session=${sessionId}`);

  // Idempotency: skip if this session was already processed
  const existing = await pool.query(
    'SELECT id FROM subscriptions WHERE stripe_session_id = $1',
    [sessionId]
  );
  if (existing.rows.length > 0) {
    console.log(`[stripe-webhook] session ${sessionId} already activated — skipping`);
    return;
  }

  // Verify the workspace exists
  const installCheck = await pool.query(
    'SELECT team_name, bot_token FROM installations WHERE team_id = $1',
    [resolvedTeamId]
  );
  if (installCheck.rows.length === 0) {
    console.warn(`[stripe-webhook] team_id=${resolvedTeamId} not found in installations — cannot activate`);
    return;
  }

  const { team_name: teamName, bot_token: botToken } = installCheck.rows[0];
  const periodEnd = new Date();
  periodEnd.setDate(periodEnd.getDate() + 30);

  // Upsert subscription record
  await pool.query(
    `INSERT INTO subscriptions
       (team_id, plan, seat_count, status, stripe_session_id, billing_email,
        stripe_customer_id, purchaser_slack_id, current_period_end)
     VALUES ($1, 'pro', 1, 'active', $2, $3, $4, $5, $6)
     ON CONFLICT (stripe_session_id) WHERE stripe_session_id IS NOT NULL DO NOTHING`,
    [resolvedTeamId, sessionId, customerEmail, stripeCustomerId, resolvedUserId || null, periodEnd]
  );

  // Upgrade the installation tier
  await pool.query(
    'UPDATE installations SET tier = $1, updated_at = NOW() WHERE team_id = $2',
    ['pro', resolvedTeamId]
  );

  console.log(`[stripe-webhook] Pro activated: team=${resolvedTeamId} (${teamName})`);

  // Send confirmation DM to the purchaser
  if (resolvedUserId && botToken) {
    try {
      const { WebClient } = require('@slack/web-api');
      const slackClient = new WebClient(botToken);
      const dm = await slackClient.conversations.open({ users: resolvedUserId });
      await slackClient.chat.postMessage({
        channel: dm.channel.id,
        text: `:tada: *Pact Pro is active for ${teamName}!*`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `:tada: *Pact Pro is active for ${teamName}!*\n\n*Unlocked:*\n• AI-powered \`/done\` — infers your most likely pact from context\n• Workflow Builder steps (pact_create, pact_summary)\n• Tracker sync: Linear, Notion, Asana\n• Unlimited pacts, no monthly limits\n\nManage billing anytime with \`/pact billing\`.`
            }
          },
          {
            type: 'context',
            elements: [
              { type: 'mrkdwn', text: `Receipt sent to ${customerEmail || 'your email'} · Questions: hello@makepact.co` }
            ]
          }
        ]
      });
    } catch (dmErr) {
      console.warn(`[stripe-webhook] DM failed for user=${resolvedUserId}:`, dmErr.message);
    }
  }
}

/**
 * customer.subscription.updated — keep current_period_end and tier in sync.
 * When Stripe renews a subscription it fires this event with the new period end.
 */
async function handleSubscriptionUpdated(subscription, pool) {
  const stripeCustomerId = subscription.customer;
  if (!stripeCustomerId) return;

  console.log(`[stripe-webhook] customer.subscription.updated: customer=${stripeCustomerId} status=${subscription.status}`);

  const periodEnd = subscription.current_period_end
    ? new Date(subscription.current_period_end * 1000)
    : null;

  // Update current_period_end on the subscription record
  const updateResult = await pool.query(
    `UPDATE subscriptions
       SET current_period_end = $1, updated_at = NOW()
     WHERE stripe_customer_id = $2 AND status = 'active'`,
    [periodEnd, stripeCustomerId]
  );

  if (updateResult.rowCount > 0) {
    console.log(`[stripe-webhook] Updated period_end for customer=${stripeCustomerId} → ${periodEnd}`);
  }
}

/**
 * invoice.payment_failed — mark subscription as past_due but keep tier=pro until period end.
 * The workspace stays on Pro until the subscription is actually cancelled (deleted event).
 */
async function handleInvoicePaymentFailed(invoice, pool) {
  const stripeCustomerId = invoice.customer;
  if (!stripeCustomerId) return;

  console.log(`[stripe-webhook] invoice.payment_failed: customer=${stripeCustomerId}`);

  // Mark payment_status=past_due — keeps tier=pro until period ends and subscription.deleted fires
  const updateResult = await pool.query(
    `UPDATE subscriptions
       SET payment_status = 'past_due', updated_at = NOW()
     WHERE stripe_customer_id = $1 AND status = 'active'`,
    [stripeCustomerId]
  );

  if (updateResult.rowCount > 0) {
    console.log(`[stripe-webhook] Marked past_due for customer=${stripeCustomerId}`);

    // DM the purchaser so they know to update their payment method
    const subResult = await pool.query(
      `SELECT team_id, purchaser_slack_id FROM subscriptions
       WHERE stripe_customer_id = $1 AND status = 'active' LIMIT 1`,
      [stripeCustomerId]
    );
    if (subResult.rows.length > 0) {
      const { team_id: teamId, purchaser_slack_id: userId } = subResult.rows[0];
      if (userId) {
        try {
          const installRow = await pool.query('SELECT bot_token FROM installations WHERE team_id = $1', [teamId]);
          const botToken = installRow.rows[0]?.bot_token;
          if (botToken) {
            const { WebClient } = require('@slack/web-api');
            const slackClient = new WebClient(botToken);
            const dm = await slackClient.conversations.open({ users: userId });
            const APP_BASE = getAppUrl();
            const portalUrl = `${APP_BASE}/api/billing-portal?team_id=${encodeURIComponent(teamId)}&user_id=${encodeURIComponent(userId)}`;
            await slackClient.chat.postMessage({
              channel: dm.channel.id,
              text: ':warning: Payment failed for your Pact Pro subscription. Please update your payment method.',
              blocks: [
                {
                  type: 'section',
                  text: {
                    type: 'mrkdwn',
                    text: ':warning: *Payment failed for your Pact Pro subscription.*\n\nYour workspace stays on Pro for now, but please update your payment method to avoid losing access.\n\nQuestions: hello@makepact.co'
                  },
                  accessory: {
                    type: 'button',
                    text: { type: 'plain_text', text: 'Update Payment ↗', emoji: true },
                    url: portalUrl,
                    action_id: 'update_payment_past_due'
                  }
                }
              ]
            });
          }
        } catch (dmErr) {
          console.warn(`[stripe-webhook] Past-due DM failed for user=${userId}:`, dmErr.message);
        }
      }
    }
  }
}

/**
 * customer.subscription.deleted — downgrade workspace back to free when subscription cancels.
 * Looks up the workspace by stripe_customer_id stored during activation.
 */
async function handleSubscriptionDeleted(subscription, pool) {
  const stripeCustomerId = subscription.customer;
  if (!stripeCustomerId) {
    console.warn('[stripe-webhook] customer.subscription.deleted: no customer ID');
    return;
  }

  console.log(`[stripe-webhook] customer.subscription.deleted: customer=${stripeCustomerId}`);

  // Find the subscription record
  const subResult = await pool.query(
    `SELECT team_id, purchaser_slack_id FROM subscriptions
     WHERE stripe_customer_id = $1 AND status = 'active'
     ORDER BY activated_at DESC LIMIT 1`,
    [stripeCustomerId]
  );

  if (subResult.rows.length === 0) {
    console.warn(`[stripe-webhook] No active subscription found for customer=${stripeCustomerId}`);
    return;
  }

  const { team_id: teamId, purchaser_slack_id: userId } = subResult.rows[0];

  // Mark subscription cancelled
  await pool.query(
    `UPDATE subscriptions SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
     WHERE stripe_customer_id = $1 AND status = 'active'`,
    [stripeCustomerId]
  );

  // Downgrade installation tier to free
  await pool.query(
    'UPDATE installations SET tier = $1, updated_at = NOW() WHERE team_id = $2',
    ['free', teamId]
  );

  console.log(`[stripe-webhook] Downgraded to free: team=${teamId}`);

  // Notify the workspace
  if (userId) {
    try {
      const installRow = await pool.query('SELECT bot_token FROM installations WHERE team_id = $1', [teamId]);
      const botToken = installRow.rows[0]?.bot_token;
      if (botToken) {
        const { WebClient } = require('@slack/web-api');
        const slackClient = new WebClient(botToken);
        const dm = await slackClient.conversations.open({ users: userId });
        await slackClient.chat.postMessage({
          channel: dm.channel.id,
          text: 'Your Pact Pro subscription has ended — workspace is back on the free plan.',
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: ':information_source: *Your Pro subscription has ended.*\n\nYour workspace is now back on the Free plan (100 pacts/month). To reactivate Pro, use `/pact upgrade`. Questions: hello@makepact.co'
              }
            }
          ]
        });
      }
    } catch (dmErr) {
      console.warn(`[stripe-webhook] Downgrade DM failed for user=${userId}:`, dmErr.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Stripe webhook signature verification (manual HMAC — no SDK required)
// ---------------------------------------------------------------------------
function verifyStripeSignature(rawBody, sigHeader, secret) {
  // Stripe-Signature format: t=TIMESTAMP,v1=HASH[,v0=HASH]
  const parts = sigHeader.split(',');
  const tPart = parts.find(p => p.startsWith('t='));
  const v1Parts = parts.filter(p => p.startsWith('v1='));
  if (!tPart || v1Parts.length === 0) return false;

  const timestamp = tPart.slice(2);
  const payload = `${timestamp}.${rawBody}`;
  const expected = require('crypto').createHmac('sha256', secret).update(payload).digest('hex');

  return v1Parts.some(v1 => {
    const hash = v1.slice(3);
    try {
      return require('crypto').timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expected, 'hex'));
    } catch {
      return false;
    }
  });
}

function registerBillingRoutes(app, pool) {
  // ---------------------------------------------------------------------------
  // POST /api/webhooks/stripe — Stripe event listener
  // IMPORTANT: registered BEFORE express.json() so we can read the raw body
  // for HMAC signature verification.
  // ---------------------------------------------------------------------------
  app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    const sig = req.headers['stripe-signature'];

    let event;
    try {
      const rawBody = req.body; // Buffer (express.raw gives us Buffer)

      if (webhookSecret) {
        if (!sig) {
          console.warn('[stripe-webhook] Missing stripe-signature header — rejecting');
          return res.status(400).json({ error: 'Missing stripe-signature header' });
        }
        if (!verifyStripeSignature(rawBody.toString(), sig, webhookSecret)) {
          console.warn('[stripe-webhook] Signature verification failed');
          return res.status(400).json({ error: 'Invalid signature' });
        }
      } else {
        console.warn('[stripe-webhook] STRIPE_WEBHOOK_SECRET not set — skipping signature verification (set env var after registering webhook in Stripe dashboard)');
      }

      event = JSON.parse(rawBody.toString());
    } catch (err) {
      console.error('[stripe-webhook] Parse/verify error:', err.message);
      return res.status(400).json({ error: 'Webhook processing failed' });
    }

    // Acknowledge immediately — Stripe expects a 2xx within 5s
    res.json({ received: true });

    // Process asynchronously so we don't block the response
    setImmediate(async () => {
      try {
        if (event.type === 'checkout.session.completed') {
          await handleCheckoutCompleted(event.data.object, pool);
        } else if (event.type === 'customer.subscription.updated') {
          await handleSubscriptionUpdated(event.data.object, pool);
        } else if (event.type === 'customer.subscription.deleted') {
          await handleSubscriptionDeleted(event.data.object, pool);
        } else if (event.type === 'invoice.payment_failed') {
          await handleInvoicePaymentFailed(event.data.object, pool);
        } else {
          console.log(`[stripe-webhook] Unhandled event type: ${event.type}`);
        }
      } catch (err) {
        console.error(`[stripe-webhook] Handler error for ${event.type}:`, err.message);
      }
    });
  });

  app.use(express.json());

  // ---------------------------------------------------------------------------
  // GET /api/checkout/lookup — find a workspace by name (case-insensitive)
  // Used by the pre-checkout form to resolve a workspace name → team_id
  // ---------------------------------------------------------------------------
  app.get('/api/checkout/lookup', async (req, res) => {
    try {
      const q = (req.query.q || '').trim();
      if (!q || q.length < 2) {
        return res.status(400).json({ error: 'Query too short.' });
      }
      const result = await pool.query(
        `SELECT team_id, team_name FROM installations
         WHERE LOWER(team_name) = LOWER($1) LIMIT 1`,
        [q]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'No workspace found.' });
      }
      const row = result.rows[0];
      res.json({ team_id: row.team_id, team_name: row.team_name });
    } catch (err) {
      console.error('[checkout/lookup] error:', err.message);
      res.status(500).json({ error: 'Lookup failed.' });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /api/checkout — generate a Stripe checkout URL with workspace context
  // Accepts: ?team_id=TXXXXX&user_id=UXXXXX (both optional)
  // - With team_id: validates workspace exists, sets cookie, redirects to Stripe
  //   with client_reference_id so webhook can auto-activate Pro
  // - Without team_id: serves a pre-checkout form to collect workspace context
  //   (unless skip_lookup=1 for manual activation path)
  // ---------------------------------------------------------------------------
  app.get('/api/checkout', async (req, res) => {
    try {
      const { team_id, user_id, skip_lookup } = req.query;
      const APP_BASE = getAppUrl();
      let checkoutUrl = STRIPE_LINKS.pro;

      if (team_id) {
        // Validate team_id format
        if (!team_id.startsWith('T')) {
          return res.status(400).json({ error: 'Invalid team_id — must start with T.' });
        }

        // Verify the workspace is installed
        const installCheck = await pool.query(
          'SELECT team_id, team_name FROM installations WHERE team_id = $1',
          [team_id]
        );
        if (installCheck.rows.length === 0) {
          return res.status(404).json({
            error: 'Workspace not found. Make sure Pact is installed first.',
          });
        }

        // Build client_reference_id: "{team_id}__{user_id}" or just "{team_id}"
        const ref = user_id ? `${team_id}__${user_id}` : team_id;
        checkoutUrl = `${STRIPE_LINKS.pro}?client_reference_id=${encodeURIComponent(ref)}`;

        // Set a cookie so the success page can auto-activate without waiting for the
        // webhook (which requires Stripe dashboard registration). The cookie survives
        // the Stripe redirect because both pages are on the same origin.
        res.cookie('pact_checkout_ctx', ref, {
          maxAge: 3600000, // 1 hour
          httpOnly: false, // must be readable by success-page JS
          sameSite: 'lax',
          secure: process.env.NODE_ENV === 'production',
          path: '/',
        });

        console.log(`[checkout] Redirecting team=${team_id} user=${user_id || 'anon'} → Stripe`);
      } else if (skip_lookup) {
        // User explicitly chose to skip workspace lookup — proceed to bare Stripe link
        console.log('[checkout] No team_id, skip_lookup=1 — redirecting to bare Stripe link');
      } else {
        // No team_id and no skip — serve the pre-checkout workspace selection form
        console.log('[checkout] No team_id — serving pre-checkout form');
        return res.sendFile(path.join(__dirname, 'public', 'checkout.html'));
      }

      res.redirect(303, checkoutUrl);
    } catch (err) {
      console.error('[checkout] error:', err.message);
      res.status(500).json({ error: 'Failed to generate checkout URL.' });
    }
  });

  // POST /api/subscription/activate — link a Stripe subscription to a Slack workspace
  app.post('/api/subscription/activate', async (req, res) => {
    try {
      const { team_id, plan, session_id, email, user_id } = req.body || {};

      if (!team_id || !plan || !['pro'].includes(plan)) {
        return res.status(400).json({ error: 'team_id and plan (pro) are required.' });
      }

      if (!team_id.startsWith('T')) {
        return res.status(400).json({ error: 'Invalid workspace ID — must start with T.' });
      }

      // Verify the team exists in our installations
      const installCheck = await pool.query(
        'SELECT team_id, team_name FROM installations WHERE team_id = $1',
        [team_id]
      );
      if (installCheck.rows.length === 0) {
        return res.status(404).json({
          error: 'Workspace not found. Make sure Pact is installed in your Slack workspace first.',
        });
      }

      // Prevent duplicate activation of the same Stripe session
      if (session_id) {
        const existing = await pool.query(
          'SELECT id FROM subscriptions WHERE stripe_session_id = $1',
          [session_id]
        );
        if (existing.rows.length > 0) {
          return res.status(409).json({ error: 'This payment session has already been activated.' });
        }

        if (process.env.STRIPE_SECRET_KEY) {
          try {
            const session = await fetchStripeCheckoutSession(session_id);
            if (!isPaidStripeSession(session)) {
              console.warn(`[billing] Payment not verified for session=${session_id}`);
              return res.status(402).json({ error: 'Payment not verified. Please complete checkout first.' });
            }
            console.log(`[billing] Payment verified for session=${session_id}`);
          } catch (verifyErr) {
            console.warn(`[billing] Payment verification failed: ${verifyErr.message} — proceeding without verification`);
          }
        } else {
          console.warn('[billing] STRIPE_SECRET_KEY not configured — proceeding without direct payment verification');
        }
      }

      // Set current_period_end to 30 days from now (approximation for monthly billing)
      const periodEnd = new Date();
      periodEnd.setDate(periodEnd.getDate() + 30);

      // Insert subscription record
      await pool.query(
        `INSERT INTO subscriptions
           (team_id, plan, seat_count, status, stripe_session_id, billing_email,
            stripe_customer_id, purchaser_slack_id, current_period_end)
         VALUES ($1, $2, 1, 'active', $3, $4, NULL, $5, $6)
         ON CONFLICT DO NOTHING`,
        [team_id, plan, session_id || null, email || null, user_id || null, periodEnd]
      );

      // Upgrade the installation tier
      await pool.query(
        `UPDATE installations SET tier = $1, updated_at = NOW() WHERE team_id = $2`,
        [plan, team_id]
      );

      const teamName = installCheck.rows[0].team_name;
      console.log(`[billing] Subscription activated: team=${team_id} (${teamName}) plan=${plan}`);

      // Send a confirmation DM to the purchaser if we have their Slack user_id
      if (user_id) {
        try {
          const installRow = await pool.query(
            'SELECT bot_token FROM installations WHERE team_id = $1',
            [team_id]
          );
          const botToken = installRow.rows[0]?.bot_token;
          if (botToken) {
            const { WebClient } = require('@slack/web-api');
            const slackClient = new WebClient(botToken);
            const dm = await slackClient.conversations.open({ users: user_id });
            await slackClient.chat.postMessage({
              channel: dm.channel.id,
              text: `:white_check_mark: *${teamName} is now on Pro!*`,
              blocks: [
                {
                  type: 'section',
                  text: {
                    type: 'mrkdwn',
                    text: `:rocket: *${teamName} is now on Pro!*\n\nUnlimited pacts, tracker sync (Linear, Notion, Asana), and no monthly limits are all active. Thanks for upgrading!`,
                  },
                },
                {
                  type: 'context',
                  elements: [
                    { type: 'mrkdwn', text: `Receipt sent to ${email || 'your email'} · Questions: hello@makepact.co` },
                  ],
                },
              ],
            });
            console.log(`[billing] DM sent to user=${user_id} for team=${team_id}`);
          }
        } catch (dmErr) {
          console.warn(`[billing] DM failed for user=${user_id}:`, dmErr.message);
        }
      }

      // Send receipt email if we have a billing email
      if (email) {
        const activationDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
        const receiptHtml = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;background:#09090B;color:#E4E4E7;padding:40px 32px;border-radius:12px;">
  <div style="text-align:center;margin-bottom:32px;">
    <span style="font-size:1.4rem;font-weight:800;letter-spacing:-0.03em;color:#E4E4E7;">Pact<span style="color:#F59E0B;">.</span></span>
  </div>
  <div style="background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.2);border-radius:10px;padding:20px;text-align:center;margin-bottom:28px;">
    <div style="font-size:1.8rem;margin-bottom:8px;">🎉</div>
    <div style="font-weight:700;font-size:1.1rem;color:#34D399;">Pro plan activated!</div>
  </div>
  <table style="width:100%;border-collapse:collapse;margin-bottom:28px;">
    <tr style="border-bottom:1px solid rgba(255,255,255,0.08);">
      <td style="padding:12px 0;color:#71717A;font-size:0.88rem;">Workspace</td>
      <td style="padding:12px 0;text-align:right;font-weight:600;font-size:0.88rem;">${teamName} <span style="color:#71717A;font-weight:400;">(${team_id})</span></td>
    </tr>
    <tr style="border-bottom:1px solid rgba(255,255,255,0.08);">
      <td style="padding:12px 0;color:#71717A;font-size:0.88rem;">Plan</td>
      <td style="padding:12px 0;text-align:right;font-weight:600;font-size:0.88rem;">Pro</td>
    </tr>
    <tr style="border-bottom:1px solid rgba(255,255,255,0.08);">
      <td style="padding:12px 0;color:#71717A;font-size:0.88rem;">Amount</td>
      <td style="padding:12px 0;text-align:right;font-weight:600;font-size:0.88rem;">$10.00 / month</td>
    </tr>
    <tr>
      <td style="padding:12px 0;color:#71717A;font-size:0.88rem;">Date</td>
      <td style="padding:12px 0;text-align:right;font-weight:600;font-size:0.88rem;">${activationDate}</td>
    </tr>
  </table>
  <div style="background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.2);border-radius:8px;padding:16px;margin-bottom:24px;font-size:0.85rem;color:#71717A;line-height:1.6;">
    <strong style="color:#F59E0B;">What's included:</strong> Unlimited pacts, tracker sync (Linear, Notion, Asana), and no monthly limits. Your workspace is upgraded and ready to use.
  </div>
  <div style="text-align:center;margin-bottom:24px;">
    <a href="https://makepact.co" style="display:inline-block;background:#F59E0B;color:#09090B;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:700;font-size:0.9rem;">Go to Pact</a>
  </div>
  <div style="text-align:center;font-size:0.8rem;color:#71717A;">
    Questions? Reply to this email or reach us at <a href="mailto:hello@makepact.co" style="color:#F59E0B;">hello@makepact.co</a>
  </div>
</div>`;
        const receiptText = `Pro plan activated for ${teamName}!\n\nWorkspace: ${teamName} (${team_id})\nPlan: Pro\nAmount: $10.00 / month\nDate: ${activationDate}\n\nUnlimited pacts, tracker sync (Linear, Notion, Asana), and no monthly limits are now active.\n\nQuestions? Email hello@makepact.co`;

        (async () => {
          try {
            await registerContact({ email, source: 'purchase' });
          } catch (_) { /* non-blocking */ }
          try {
            await sendEmail({
              to: email,
              subject: `Your Pact Pro receipt — ${teamName}`,
              body: receiptText,
              html: receiptHtml,
            });
            console.log(`[billing] Receipt email sent to ${email} for team=${team_id}`);
          } catch (emailErr) {
            console.warn(`[billing] Receipt email failed: ${emailErr.message}`);
          }
        })();
      }

      res.json({
        ok: true,
        team_id,
        team_name: teamName,
        plan,
        message: `${plan.charAt(0).toUpperCase() + plan.slice(1)} plan activated for ${teamName}.`,
      });
    } catch (err) {
      console.error('[billing] activate error:', err.message);
      res.status(500).json({ error: 'Activation failed. Please try again or email hello@makepact.co' });
    }
  });

  // GET /api/billing/status?team_id=XXX — get current subscription for a workspace
  app.get('/api/billing/status', async (req, res) => {
    try {
      const { team_id } = req.query;
      if (!team_id) return res.status(400).json({ error: 'team_id required' });

      const [installResult, subResult] = await Promise.all([
        pool.query('SELECT tier FROM installations WHERE team_id = $1', [team_id]),
        pool.query(
          `SELECT plan, seat_count, status, activated_at, current_period_end
           FROM subscriptions WHERE team_id = $1 ORDER BY activated_at DESC LIMIT 1`,
          [team_id]
        ),
      ]);

      const tier = installResult.rows[0]?.tier || 'free';
      const subscription = subResult.rows[0] || null;
      const limit = PLAN_MONTHLY_LIMITS[tier];

      res.json({
        team_id,
        tier,
        monthly_pact_limit: limit,
        subscription: subscription ? {
          plan: subscription.plan,
          seat_count: subscription.seat_count,
          status: subscription.status,
          activated_at: subscription.activated_at,
          current_period_end: subscription.current_period_end,
        } : null,
      });
    } catch (err) {
      console.error('[billing] status error:', err.message);
      res.status(500).json({ error: 'Failed to load billing status' });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /api/billing-portal?team_id=XXX&user_id=XXX
  // Creates a Stripe Billing Portal session so users can manage their subscription
  // (cancel, change plan, update payment, download invoices) without leaving Slack.
  // Requires STRIPE_SECRET_KEY env var. Falls back to a helpful page if unavailable.
  // ---------------------------------------------------------------------------
  app.get('/api/billing-portal', async (req, res) => {
    try {
      const { team_id, user_id } = req.query;
      const APP_BASE = getAppUrl();
      const returnUrl = `${APP_BASE}/billing-return`;

      // Look up the stripe_customer_id for this workspace
      let stripeCustomerId = null;
      if (team_id) {
        const subResult = await pool.query(
          `SELECT stripe_customer_id FROM subscriptions
           WHERE team_id = $1 AND status = 'active'
           ORDER BY activated_at DESC LIMIT 1`,
          [team_id]
        );
        stripeCustomerId = subResult.rows[0]?.stripe_customer_id || null;
      }

      const stripeKey = process.env.STRIPE_SECRET_KEY;

      // If we have both a customer ID and Stripe key, create a real portal session
      if (stripeCustomerId && stripeKey) {
        const portalRes = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${stripeKey}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            customer: stripeCustomerId,
            return_url: returnUrl,
          }).toString(),
        });

        if (portalRes.ok) {
          const session = await portalRes.json();
          console.log(`[billing-portal] Created portal session for team=${team_id} customer=${stripeCustomerId}`);
          return res.redirect(303, session.url);
        } else {
          const errBody = await portalRes.json().catch(() => ({}));
          console.warn(`[billing-portal] Stripe error: ${portalRes.status} ${errBody?.error?.message}`);
        }
      }

      // Fallback: redirect to a static billing management page
      console.log(`[billing-portal] Fallback for team=${team_id} (no customer_id or no Stripe key)`);
      return res.redirect(303, 'https://makepact.co/billing');
    } catch (err) {
      console.error('[billing-portal] error:', err.message);
      return res.redirect(303, 'https://makepact.co/billing');
    }
  });

  // GET /api/billing/session-status?session_id=XXX — check if a Stripe session was
  // already auto-activated by the webhook (used by success page to skip manual form)
  app.get('/api/billing/session-status', async (req, res) => {
    try {
      const { session_id } = req.query;
      if (!session_id) return res.status(400).json({ error: 'session_id required' });

      const result = await pool.query(
        `SELECT s.team_id, s.status, i.team_name
         FROM subscriptions s
         LEFT JOIN installations i ON i.team_id = s.team_id
         WHERE s.stripe_session_id = $1
         LIMIT 1`,
        [session_id]
      );

      if (result.rows.length > 0 && result.rows[0].status === 'active') {
        res.json({
          activated: true,
          team_id: result.rows[0].team_id,
          team_name: result.rows[0].team_name,
        });
      } else {
        res.json({ activated: false });
      }
    } catch (err) {
      console.error('[billing] session-status error:', err.message);
      res.status(500).json({ error: 'Failed to check session status' });
    }
  });

  // GET /api/billing/session-info?session_id=XXX — retrieve checkout session details
  // (customer email, workspace) so the success page can pre-fill fields and
  // auto-activate without relying on the cookie.
  // Uses Stripe directly when STRIPE_SECRET_KEY is configured.
  app.get('/api/billing/session-info', async (req, res) => {
    try {
      const { session_id } = req.query;
      if (!session_id) return res.status(400).json({ error: 'session_id required' });

      // Validate session_id format (Stripe checkout sessions start with cs_)
      if (!session_id.startsWith('cs_')) {
        return res.status(400).json({ error: 'Invalid session_id format' });
      }

      if (!process.env.STRIPE_SECRET_KEY) {
        console.warn('[billing] session-info: STRIPE_SECRET_KEY not configured');
        return res.status(503).json({ error: 'Payment verification not configured' });
      }

      let customerEmail = null;
      let paymentVerified = false;
      let sessionTeamId = null;
      let sessionUserId = null;
      try {
        const session = await fetchStripeCheckoutSession(session_id);
        paymentVerified = isPaidStripeSession(session);
        customerEmail = session.customer_details?.email || session.customer_email || null;
        if (session.client_reference_id) {
          const [teamFromRef, userFromRef] = session.client_reference_id.split('__');
          sessionTeamId = teamFromRef || null;
          sessionUserId = userFromRef || null;
        }
      } catch (verifyErr) {
        console.warn(`[billing] session-info: Stripe lookup error: ${verifyErr.message}`);
      }

      // Check if already activated (subscription exists for this session)
      let alreadyActivated = false;
      let teamId = null;
      let teamName = null;
      let userId = null;
      const subResult = await pool.query(
        `SELECT s.team_id, s.status, s.billing_email, s.purchaser_slack_id,
                i.team_name
         FROM subscriptions s
         LEFT JOIN installations i ON i.team_id = s.team_id
         WHERE s.stripe_session_id = $1
         LIMIT 1`,
        [session_id]
      );
      if (subResult.rows.length > 0) {
        const sub = subResult.rows[0];
        alreadyActivated = sub.status === 'active';
        teamId = sub.team_id;
        teamName = sub.team_name;
        userId = sub.purchaser_slack_id;
        // Use billing email from subscription if Stripe didn't return one
        if (!customerEmail && sub.billing_email) {
          customerEmail = sub.billing_email;
        }
      }

      if (!teamId && sessionTeamId?.startsWith('T')) {
        teamId = sessionTeamId;
        userId = sessionUserId || null;
        const installResult = await pool.query(
          'SELECT team_name FROM installations WHERE team_id = $1',
          [teamId]
        );
        teamName = installResult.rows[0]?.team_name || null;
      }

      // If no team_id from subscription yet, try to find it from the cookie value
      // that was passed as client_reference_id to Stripe. The cookie reader on the
      // client side handles this, but we also check the request cookie server-side
      // as a belt-and-suspenders approach.
      if (!teamId) {
        const cookieHeader = req.headers.cookie || '';
        const cookieMatch = cookieHeader.split('; ').find(c => c.startsWith('pact_checkout_ctx='));
        const cookieVal = cookieMatch ? decodeURIComponent(cookieMatch.split('=').slice(1).join('=')) : '';
        if (cookieVal) {
          const parts = cookieVal.split('__');
          if (parts[0] && parts[0].startsWith('T')) {
            teamId = parts[0];
            userId = parts[1] || null;
            // Look up team name
            const installResult = await pool.query(
              'SELECT team_name FROM installations WHERE team_id = $1',
              [teamId]
            );
            teamName = installResult.rows[0]?.team_name || null;
          }
        }
      }

      console.log(`[billing] session-info: session=${session_id} email=${customerEmail || 'none'} team=${teamId || 'none'} activated=${alreadyActivated} verified=${paymentVerified}`);

      res.json({
        email: customerEmail,
        team_id: teamId || null,
        team_name: teamName,
        user_id: userId || null,
        activated: alreadyActivated,
        payment_verified: paymentVerified,
      });
    } catch (err) {
      console.error('[billing] session-info error:', err.message);
      res.status(500).json({ error: 'Failed to fetch session info' });
    }
  });
}

// ---------------------------------------------------------------------------
// Metrics / Analytics Dashboard Routes
// ---------------------------------------------------------------------------

module.exports = { init, registerBillingRoutes, getTeamTier, planBadge, getMonthlyPactCount, PLAN_MONTHLY_LIMITS };
