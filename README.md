# Pact — Accountability Built Into Slack

Pact turns casual Slack promises into tracked commitments with automatic reminders.

## Features

- **`/pact [commitment] by [date]`** — Create a pact in any DM; both parties notified
- **🤝 React to turn any message into a pact** — React with 🤝 on any message to capture it as a pact. Pact sends you a pre-filled confirmation (with promiser/recipient roles you can swap) right in your DMs.
- **`/pacts`** — Traffic-light view of all open commitments (🟢 🟡 🔴)
- **`/done [id]`** — Mark complete; both parties notified
- **`/pact extend [id] to [date]`** — Renegotiate deadlines mutually
- **`/pact edit [id] [new text]`** — Update commitment description
- **Automatic reminders** — 24-hour window reminders + overdue nudges
- **Daily digest** — 9am ET summary of all open pacts
- **Conversational DM** — Message Pact in plain English to create pacts
- **Pro: Linear, Notion, Asana sync**

## Requirements

- Node.js 18+
- PostgreSQL database (Neon recommended)

## Environment Variables

- `DATABASE_URL` - pooled PostgreSQL connection string for the app runtime (required)
- `MIGRATE_DATABASE_URL` - direct PostgreSQL connection string for one-off migrations
- `SLACK_BOT_TOKEN` - Slack bot token
- `SLACK_SIGNING_SECRET` - Slack signing secret
- `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` - OAuth app credentials
- `SLACK_APP_ID` - Slack app ID for App Home links
- `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` - Stripe billing credentials
- `STRIPE_PRO_PAYMENT_LINK` - your Stripe Payment Link for the Pro subscription
- `CRON_SECRET` - bearer token for protected scheduler endpoints
- `ANTHROPIC_API_KEY` - required for AI-assisted Pact features
- `RESEND_API_KEY` / `EMAIL_FROM` - optional direct email sending via Resend
- `APP_URL` / `APP_BASE_URL` - public app URL
- `PORT` - Server port (default: 3000)

## Slack App Configuration

Required bot token scopes:
```
commands, chat:write, im:write, im:read, im:history, users:read,
reactions:read, channels:history, groups:history, mpim:history
```

Required event subscriptions:
- `message.im` — conversational DM
- `reaction_added` — emoji-reaction pact creation

## Local Development

```bash
npm install
DATABASE_URL="postgresql://..." npm run dev
```

## Testing

### Unit tests (no DB or Slack credentials required)

```bash
npm install
npm test
```

Uses Node.js 20's built-in test runner (`node:test`) — no external test framework needed. Tests mock all DB queries and Slack API calls.

Coverage:
- **`tests/unit/fuzzy.test.js`** — Levenshtein, tokenization, fuzzy pact matching (28 tests)
- **`tests/unit/done.test.js`** — `/done` command: empty, single pact, multi-select, ID completion, fuzzy match, multi-complete buttons (12 tests)
- **`tests/unit/slack-handlers.test.js`** — `/pact` channel rejection, DM detection, `/pacts` listing, overdue pacts, cross-channel fallback, emoji reaction flow (14 tests)
- **`tests/unit/tracker.test.js`** — token encryption, Pro-tier gating, Linear/tracker sync lifecycle, OAuth state (16 tests)

### E2E Slack tests (requires `SLACK_SIGNING_SECRET`)

```bash
SLACK_SIGNING_SECRET=xxx PACT_SERVER_URL=https://makepact.co \
  npm run test:slack
```

Sends signed HTTP requests directly to the server. Optional workspace tokens enable full DM-detection test coverage — see `tests/slack-e2e-runner.js` for full config options.

### CI

GitHub Actions runs unit tests on every PR and push to `main`. E2E tests run post-merge using the `SLACK_SIGNING_SECRET` secret configured in the repo.

## Deployment

### Vercel

Vercel hosts the HTTP app, Slack endpoints, Stripe webhook, static pages, and
scheduler endpoints through the single exported Express handler in `server.js`.
In-process timers are disabled in production; scheduled jobs run through
protected routes under `/api/crons/*`.

Configure these Slack/Stripe URLs after deployment:

- Slack Events API: `https://<deployment>/slack/events`
- Slack Interactivity: `https://<deployment>/slack/actions`
- Slack slash commands: `https://<deployment>/slack/commands`
- Stripe webhook: `https://<deployment>/stripe/webhook`

For Vercel Hobby accounts, use the included GitHub Actions scheduler instead
of Vercel Cron. Configure these GitHub repository secrets:

- `PACT_BASE_URL` - deployed app URL, for example `https://makepact.co`
- `CRON_SECRET` - same value as the app's `CRON_SECRET` environment variable

The migration runner applies the full checked-in `schema.sql`; after migrating
Neon, verify the live schema includes Pact's later tables and columns:

```sql
\d pacts
\d workspace_invites
\d workspace_admin_digest_prefs
```

Run database migrations explicitly after setting `MIGRATE_DATABASE_URL` or
`DATABASE_URL`:

```bash
npm run migrate
```

Production handoff checklist:

- Create a Slack app in your own Slack developer account, copy the manifest,
  and point all request URLs at the Vercel deployment.
- Turn off Slack Socket Mode. Do not copy `SLACK_APP_TOKEN` to Vercel.
- Create your own Stripe product, price, Payment Link, and webhook endpoint.
  Set the Payment Link as `STRIPE_PRO_PAYMENT_LINK`.
- If you use email digests or contact capture, set `RESEND_API_KEY` and
  `EMAIL_FROM`, or provide compatible `EMAIL_SEND_URL` settings.
