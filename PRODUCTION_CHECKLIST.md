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

- [ ] Anthropic AI: `ANTHROPIC_API_KEY`
- [ ] Transactional email: `RESEND_API_KEY`, `EMAIL_FROM`
- [ ] Tracker OAuth credentials and `TRACKER_ENCRYPTION_KEY`

## Release QA

- [x] `npm test`
- [x] `npm run build`
- [x] `GET /api/health` returns `200` with `slack:true`
- [x] `/`, `/privacy`, `/terms`, `/support`, `/llms.txt`, and `/sitemap.xml` return `200`
- [x] `/slack/reinstall` redirects to the correct Slack app and callback
- [x] Authenticated production smoke confirms the Neon-stored Slack token is valid
- [x] `/pact help`, `/pacts`, and `/done` return visible Slack responses
- [x] A pact can be created in a teammate DM and completed
- [x] A `message.im` event receives a bot response
- [x] Manual GitHub scheduled-jobs workflow succeeds
- [x] Production logs contain no new fatal or unhandled errors

## Deferred manual checks

- App Home rendering and its Help-button interactivity were explicitly deferred
  by the product owner on 2026-07-12 and are not release gates.

## Security follow-up

- [x] Previously exposed Neon credential rotated; post-rotation health, persisted
  data, Slack token loading, and authenticated scheduled jobs verified
- [x] Confirm legal pages identify the current independent operator
- [x] Confirm privacy subprocessors match the configured runtime providers
