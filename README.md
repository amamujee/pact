# Pact

Pact turns promises made in Slack into shared, trackable commitments. Each pact
has an owner, a teammate, and a due date; Pact keeps both people informed with
reminders, overdue nudges, and completion updates.

[Website](https://makepact.co) · [Support](https://makepact.co/support) ·
[Privacy](https://makepact.co/privacy)

## What Pact does

- Creates pacts from `/pact`, a 🤝 reaction, a message shortcut, or a bot DM
- Shows active, due-soon, and overdue commitments in Slack
- Sends reminders and daily or weekly digests
- Completes pacts with `/done`, a ✅ reaction, a thread reply, or bulk Home Tab actions
- Supports recurring commitments and two-way deadline changes
- Connects optional Linear, Notion, and Asana trackers
- Includes AI-assisted commitment detection and Slack Workflow Builder steps

Pact is free for every workspace, with unlimited pacts and no credit card.

## Quick start

### Prerequisites

- Node.js 20+
- PostgreSQL (Neon works well)
- A Slack app with the configuration described below

### Run locally

```bash
npm install
cp .env.example .env
# Add at least DATABASE_URL and the required Slack credentials to .env
node --env-file=.env migrate.js
node --env-file=.env scripts/dev.js
```

The app starts on `http://localhost:3000` unless `PORT` is set.

## Configuration

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Pooled PostgreSQL connection used by the app |
| `MIGRATE_DATABASE_URL` | Optional direct connection for migrations; falls back to `DATABASE_URL` |
| `SLACK_SIGNING_SECRET` | Verifies requests from Slack |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` | Slack OAuth credentials |
| `SLACK_APP_ID` | Slack app ID used for App Home links |
| `SLACK_BOT_TOKEN` | Optional single-workspace development override |
| `CRON_SECRET` | Bearer token for scheduled-job endpoints |
| `ANTHROPIC_API_KEY` | Enables AI-assisted features |
| `APP_URL` / `APP_BASE_URL` | Public base URL of the deployment |
| `RESEND_API_KEY` / `EMAIL_FROM` | Optional email delivery through Resend |
| `PORT` | Local HTTP port; defaults to `3000` |

See [.env.example](.env.example) for the complete template.

## Slack setup

The checked-in [slack-app-manifest.json](slack-app-manifest.json) is the source of
truth for scopes, commands, events, and interactivity. The primary bot scopes are:

```text
commands, chat:write, im:write, im:read, im:history, users:read,
reactions:read, channels:history, groups:history, mpim:history
```

Pact subscribes to `message.im` for conversational bot DMs and `reaction_added`
for reaction-based creation. Point these Slack surfaces at your deployment:

- Events: `https://<host>/slack/events`
- Interactivity: `https://<host>/slack/actions`
- Slash commands: `https://<host>/slack/commands`
- OAuth redirect: `https://<host>/slack/oauth/callback`

## Commands

```text
/pact @person review the launch plan by Friday
/pacts
/done 42
/pact edit 42 Review the final launch plan
/pact extend 42 to next Tuesday
```

Run `/pact help` in Slack for the full command reference.

## Tests

```bash
npm test             # unit and consistency tests
npm run test:slack   # signed HTTP E2E checks against a running deployment
```

Unit tests use Node's built-in test runner and do not require live Slack or
database credentials. Slack E2E tests require `SLACK_SIGNING_SECRET`; optional
workspace tokens unlock additional DM coverage. See
[tests/slack-e2e-runner.js](tests/slack-e2e-runner.js) for supported settings.

## Architecture

Pact is a Node.js/Express app using Slack Bolt and PostgreSQL. It runs as one
Vercel handler, with scheduled work exposed through protected routes under
`/api/crons/*`.

- `server.js` wires the HTTP app and shared routes
- `lib/slack-handlers.js` handles Slack commands, actions, and events
- `db/` contains database queries; `schema.sql` defines the schema
- `routes/` contains page and feature routes
- `public/` contains the landing page, dashboard, and policy pages
- `api/` contains Vercel and scheduled-job entry points

For operational details, see [PRODUCTION_CHECKLIST.md](PRODUCTION_CHECKLIST.md).
For database handoff and migration notes, see [MIGRATION.md](MIGRATION.md).

## Deployment

1. Configure the environment variables above in Vercel.
2. Run `npm run migrate` with a direct database URL when available.
3. Deploy the Express handler using the included `vercel.json`.
4. Update the Slack Events, Interactivity, Commands, and OAuth URLs.
5. Configure the GitHub Actions scheduler with `PACT_BASE_URL` and `CRON_SECRET`
   when Vercel Cron is unavailable.

Do not enable Slack Socket Mode for the Vercel deployment.

## License

[MIT](LICENSE)
