# Pact Deployment and Operations Guide

Pact is self-hosted from `https://github.com/amamujee/pact` with this production stack:

- Application hosting: Vercel
- Vercel project: `makepact`
- Public URL: `https://makepact.co`
- PostgreSQL: Neon
- Slack delivery: HTTPS Events API and OAuth
- Scheduled jobs: GitHub Actions calling authenticated Vercel endpoints

## Runtime configuration

Required Vercel Production variables:

- `DATABASE_URL` — pooled Neon connection string
- `SLACK_SIGNING_SECRET`
- `SLACK_CLIENT_ID`
- `SLACK_CLIENT_SECRET`
- `SLACK_APP_ID`
- `CRON_SECRET`
- `APP_URL=https://makepact.co`
- `APP_BASE_URL=https://makepact.co`
- `NODE_ENV=production`

The OAuth install flow stores workspace bot tokens in Neon. Do not set a global
`SLACK_BOT_TOKEN` in Production unless deliberately overriding the database token.

Optional integrations:

- `MIGRATE_DATABASE_URL` — direct Neon connection for schema migrations
- `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` — AI-assisted features
- `RESEND_API_KEY`, `EMAIL_FROM` — transactional email
- Linear, Asana, and Notion OAuth credentials — tracker sync
- `TRACKER_ENCRYPTION_KEY` — encryption for tracker OAuth tokens
- `ANALYTICS_IP_SALT` — private keyed analytics hashing salt

## Database setup

For a new Neon database:

```bash
npm install
MIGRATE_DATABASE_URL="postgresql://..." npm run migrate
```

`migrate.js` applies the checked-in `schema.sql` idempotently and records completed
migrations. The runtime uses `DATABASE_URL`; migrations should prefer Neon’s direct
connection string through `MIGRATE_DATABASE_URL`.

## Slack configuration

Configure the existing Slack app with:

- OAuth redirect: `https://makepact.co/slack/oauth/callback`
- Event subscriptions: `https://makepact.co/slack/events`
- Interactivity: `https://makepact.co/slack/actions`
- `/pact`, `/pacts`, `/done`: `https://makepact.co/slack/commands`

Required bot events:

- `app_home_opened`
- `message.im`
- `reaction_added`

Required bot scopes:

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

Socket Mode must remain off. Install or refresh a workspace at
`https://makepact.co/slack/reinstall`.

## Scheduled jobs

GitHub Actions workflow `.github/workflows/pact-crons.yml` calls the protected
`/api/crons/*` routes. Repository secrets:

- `PACT_BASE_URL=https://makepact.co`
- `CRON_SECRET` — identical to Vercel Production

Use the workflow’s manual dispatch for production smoke tests after deployment.

## Deployment

Push tested changes to `main`, then deploy the linked Vercel project. Vercel routes
`makepact.co`, `www.makepact.co`, and the platform fallback URL to the latest
Production deployment.

Minimum release gates:

```bash
npm test
npm run build
```

Then verify the web routes, Slack commands/events/actions, OAuth reinstall, and the
manual scheduled-jobs workflow.

## Security operations

- Rotate any database or OAuth credential that has been shared outside its provider.
- Keep secrets only in Vercel/GitHub provider settings, never in the repository.
- Keep the admin migrate route disabled; database changes go through `migrate.js`.
- Review Vercel runtime logs after every production release.
