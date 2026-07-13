# Pact Production Checklist

Last updated: 2026-07-12

## Current production state

- GitHub: `https://github.com/amamujee/pact`
- Public website and application: `https://makepact.co`
- Vercel project: `makepact`
- Hosting: Vercel
- Database: Neon PostgreSQL
- Slack app: existing Make Pact app, connected over HTTPS
- Scheduled jobs: GitHub Actions with authenticated Vercel cron routes

## Required Vercel Production variables

- [x] `DATABASE_URL`
- [x] `SLACK_SIGNING_SECRET`
- [x] `SLACK_CLIENT_ID`
- [x] `SLACK_CLIENT_SECRET`
- [x] `SLACK_APP_ID`
- [x] `CRON_SECRET`
- [x] `APP_URL=https://makepact.co`
- [x] `APP_BASE_URL=https://makepact.co`
- [x] `NODE_ENV=production`
- [x] No global `SLACK_BOT_TOKEN` override; OAuth tokens load from Neon

## Slack settings

- [x] OAuth redirect: `https://makepact.co/slack/oauth/callback`
- [x] Events: `https://makepact.co/slack/events`
- [x] Interactivity: `https://makepact.co/slack/actions`
- [x] `/pact`, `/pacts`, `/done`: `https://makepact.co/slack/commands`
- [x] Bot events: `app_home_opened`, `message.im`, `reaction_added`
- [x] Socket Mode disabled
- [x] Workspace reinstalled; bot token stored in Neon

## Scheduler

- [x] GitHub secret `PACT_BASE_URL=https://makepact.co`
- [x] GitHub and Vercel `CRON_SECRET` values match
- [x] Manual scheduled-jobs workflow succeeds

## Optional capabilities

These are not required for the free core product and must not be presented as
self-service until their variables are configured:

- [ ] Stripe self-service billing: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRO_PAYMENT_LINK`
- [ ] Anthropic AI: `ANTHROPIC_API_KEY`
- [ ] Transactional email: `RESEND_API_KEY`, `EMAIL_FROM`
- [ ] Tracker OAuth credentials and `TRACKER_ENCRYPTION_KEY`

## Release QA

- [ ] `npm test`
- [ ] `npm run build`
- [ ] `node verify-checkout-fix.js`
- [ ] `GET /api/health` returns `200` with `slack:true`
- [ ] `/`, `/privacy`, `/terms`, `/support`, `/llms.txt`, and `/sitemap.xml` return `200`
- [ ] `/slack/reinstall` redirects to the correct Slack app and callback
- [ ] `/pact help`, `/pacts`, and `/done` return visible Slack responses
- [ ] A pact can be created in a teammate DM and completed
- [ ] App Home loads
- [ ] A `message.im` event receives a bot response
- [ ] Interactivity buttons reach `/slack/actions`
- [ ] Manual GitHub scheduled-jobs workflow succeeds
- [ ] Production logs contain no new fatal or unhandled errors

## Security follow-up

- [ ] Confirm the previously exposed Neon credential has been rotated
- [ ] Confirm legal pages identify the current independent operator
- [ ] Confirm privacy subprocessors match the configured runtime providers
