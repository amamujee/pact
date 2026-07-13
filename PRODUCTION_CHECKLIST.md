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
- Neon schema verified: expected Pact tables and required `pacts` columns are present.
- Production `GET /api/health` returns `200` with `{"ok":true,"slack":false,...}`.
- Production `GET /health` returns `200` with `{"status":"healthy","slack":false}`.
- Production landing page `/` returns `200`.
- Production `GET /api/public-stats` returns `200` with fresh empty DB stats.
- Production `GET /api/crons/hourly` returns `401` without `CRON_SECRET` auth.

The current `slack:false` and zero stats are expected until Slack is configured.

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

After Slack environment variables are set and production is redeployed:

1. Visit `https://pact-polsia.vercel.app/api/health`.
2. Open `https://pact-polsia.vercel.app/slack/reinstall` and install Pact.
3. In Slack, test `/pact help`.
4. In a DM with a teammate, test `/pact test commitment by tomorrow`.
5. Test `/pacts`.
6. Test `/done`.
7. React with `🤝` to a message and confirm the pact flow.
8. Open the Pact App Home tab.
9. Trigger a protected cron manually with the GitHub/Vercel `CRON_SECRET`.

## Security Cleanup

- [x] Rotate the exposed Neon role password. Completed July 12, 2026.
- [x] Confirm Vercel `DATABASE_URL` uses the rotated credential and rerun the
  schema verification.
