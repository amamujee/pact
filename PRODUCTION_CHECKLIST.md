# Pact Production Handoff

Last updated: 2026-07-05

## Current State

- GitHub repo: `https://github.com/amamujee/pact`
- Vercel project: `pact-polsia`
- Production base URL: `https://pact-polsia.vercel.app`
- Neon is connected to Vercel Production as `DATABASE_URL`.
- Fresh Neon schema has been migrated and verified.
- GitHub Actions cron scheduler is configured for Vercel Hobby.
- Latest code is pushed to `main`.

## Verified So Far

- Unit tests pass: `npm test`
- Build passes: `npm run build`
- Checkout verifier passes: `node verify-checkout-fix.js`
- Neon schema verified: expected Pact tables and required `pacts` columns are present.
- Production `GET /api/health` returns `200` with `{"ok":true,"slack":false,...}`.
- Production `GET /health` returns `200` with `{"status":"healthy","slack":false}`.
- Production landing page `/` returns `200`.
- Production `GET /api/public-stats` returns `200` with fresh empty DB stats.
- Production `GET /api/checkout` returns `503` until `STRIPE_PRO_PAYMENT_LINK` is set.
- Production `GET /api/crons/hourly` returns `401` without `CRON_SECRET` auth.

The current `slack:false`, zero stats, and checkout `503` are expected until
Slack and Stripe are configured.

## Still Needed: Slack

Create/import the Slack app under your own Slack developer account.

Use these URLs:

- OAuth redirect URL: `https://pact-polsia.vercel.app/slack/oauth/callback`
- Event Subscriptions request URL: `https://pact-polsia.vercel.app/slack/events`
- Interactivity request URL: `https://pact-polsia.vercel.app/slack/actions`
- Slash commands request URL: `https://pact-polsia.vercel.app/slack/commands`

Create slash commands:

- `/pact`
- `/pacts`
- `/done`

Create a message shortcut:

- Name: `Make this a Pact`
- Callback ID: `make_this_a_pact`

Subscribe to bot events:

- `app_home_opened`
- `reaction_added`
- `message.im`

Bot token scopes:

- `commands`
- `chat:write`
- `im:write`
- `im:read`
- `im:history`
- `users:read`
- `reactions:read`
- `channels:history`
- `groups:history`
- `mpim:history`

Turn off Socket Mode. Do not add `SLACK_APP_TOKEN`.

Add these Vercel Production environment variables:

- `SLACK_SIGNING_SECRET`
- `SLACK_CLIENT_ID`
- `SLACK_CLIENT_SECRET`
- `SLACK_APP_ID`

After those are set and production is redeployed, install with:

`https://pact-polsia.vercel.app/slack/reinstall`

That install path saves the bot token into Neon. If needed later, `SLACK_BOT_TOKEN`
can also be set directly in Vercel, but the OAuth install flow is the cleaner path.

## Still Needed: Stripe

In Stripe, create:

- Product: `Pact Pro`
- Recurring monthly price
- Payment Link for that subscription

Set the Payment Link success URL to:

`https://pact-polsia.vercel.app/success?checkout_session_id={CHECKOUT_SESSION_ID}`

Create a Stripe webhook endpoint:

`https://pact-polsia.vercel.app/api/webhooks/stripe`

Subscribe it to:

- `checkout.session.completed`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.payment_failed`

Add these Vercel Production environment variables:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRO_PAYMENT_LINK`

## Optional Integrations

Add later if you want these features:

- `ANTHROPIC_API_KEY` for AI-assisted Pact features
- `RESEND_API_KEY` and `EMAIL_FROM` for email sending
- `LINEAR_CLIENT_ID` and `LINEAR_CLIENT_SECRET`
- `ASANA_CLIENT_ID` and `ASANA_CLIENT_SECRET`
- `NOTION_CLIENT_ID` and `NOTION_CLIENT_SECRET`
- `TRACKER_ENCRYPTION_KEY`
- `ANALYTICS_IP_SALT`

## Final Test Plan

After Slack and Stripe env vars are set and production is redeployed:

1. Visit `https://pact-polsia.vercel.app/api/health`.
2. Open `https://pact-polsia.vercel.app/slack/reinstall` and install Pact.
3. In Slack, test `/pact help`.
4. In a DM with a teammate, test `/pact test commitment by tomorrow`.
5. Test `/pacts`.
6. Test `/done`.
7. React with `🤝` to a message and confirm the pact flow.
8. Open the Pact App Home tab.
9. Visit `/api/checkout` after setting `STRIPE_PRO_PAYMENT_LINK`.
10. Create a small test subscription through Stripe test mode.
11. Confirm Stripe webhook events show `2xx` delivery in Stripe.
12. Trigger a protected cron manually with the GitHub/Vercel `CRON_SECRET`.

## Security Cleanup

Because the first Neon connection string was pasted into chat, rotate the Neon
password after setup is complete, then update Vercel `DATABASE_URL` and rerun
the schema verification.
