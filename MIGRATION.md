# Pact — Self-Hosted Migration Guide

This guide covers everything needed to migrate Pact from the Polsia-managed
Render deployment to a self-hosted setup using Vercel + Neon (free tier).

---

## 1. Repository

The repo is at **https://github.com/Polsia-Inc/pact**.

To take ownership, fork it on GitHub:

1. Go to https://github.com/Polsia-Inc/pact
2. Click **Fork** → choose your account (`amamujee`)
3. All branches and commit history are preserved automatically
4. Update `lib/slack-oauth.js` line 10 and 13: replace the hardcoded
   `https://pact-537l.polsia.app` redirect URI with your new domain

---

## 2. Database Export

### Option A — Migrate existing data (preserve workspaces and pacts)

Run this against the current Neon database (credentials in your `.env`):

```bash
pg_dump \
  "REDACTED/neondb?sslmode=require" \
  --no-owner \
  --no-acl \
  --schema-only \
  -f schema.sql

pg_dump \
  "REDACTED/neondb?sslmode=require" \
  --no-owner \
  --no-acl \
  --data-only \
  -f data.sql
```

Then restore into your new Neon database:

```bash
psql "REDACTED/neondb?sslmode=require" -f schema.sql
psql "REDACTED/neondb?sslmode=require" -f data.sql
```

### Option B — Fresh start (no data migration)

Skip the export. Point `DATABASE_URL` at a new Neon database and run:

```bash
npm run migrate
```

The migration runner creates all tables idempotently. New workspaces will
install fresh when teams re-add the Slack app.

### Tables in the database

| Table | What it stores |
|-------|----------------|
| `pacts` | Core pact entity: description, due date, status, creator/counterparty, recurrence rule |
| `installations` | Slack workspace installs: bot tokens, team IDs, config |
| `subscriptions` | Stripe billing state per workspace |
| `user_digest_prefs` | Per-user digest settings (frequency, timezone, opt-out) |
| `workflow_step_executions` | Workflow Builder step execution log |
| `pageviews` | Landing page analytics |
| `contact_submissions` | Contact form entries |
| `feedback` | `/pact feedback` submissions |
| `error_logs` | Application error tracking |
| `tracker_connections` | OAuth tokens for Linear/Notion/Asana (AES-256 encrypted) |
| `tracker_projects` | Project mappings for tracker sync |
| `reschedule_proposals` | Counterparty-proposed date changes and status |
| `streak_milestones` | Awarded milestone records (7/30/100-day) |
| `streak_share_cards` | Token → user/milestone/stats for public streak cards |
| `streak_analytics` | Streak card view/share events |
| `user_activation` | Per-user activation DM state |
| `activation_events` | Funnel analytics for install→DM→pact |
| `_migrations` | Migration run log (internal) |

---

## 3. Environment Variables

Copy `.env.example` to `.env` and fill in every value. See `.env.example`
for the full reference with descriptions and where to get each value.

**Required to start:**
- `DATABASE_URL`
- `SLACK_SIGNING_SECRET`

**Required for full bot operation:**
- `SLACK_BOT_TOKEN` (or install a workspace via OAuth — the app loads it from the DB)
- `SLACK_CLIENT_ID` + `SLACK_CLIENT_SECRET`

**Required for billing:**
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`

**Required for AI features:**
- `POLSIA_API_KEY` (Polsia proxy) — replace with your own Anthropic key + update `lib/polsia-ai.js`

**All variables are listed in `.env.example`** with source instructions.

---

## 4. Vercel Migration Guide

### Important: Pact is an Express + long-running process app

Pact was built for a **persistent Node.js server**, not serverless functions.
It relies on:

- **In-memory cron jobs** (`setInterval`) for reminders, digests, nudges,
  activation DMs, and streak milestones
- **Persistent Bolt SDK WebSocket/polling** for Slack event handling
- **Module-level state** (bot user ID, billing pool, error tracker)

Deploying to Vercel serverless **as-is will not work** for these reasons.

### Recommended approach: Vercel + a background worker

Deploy the Express app to Vercel for HTTP routes only, and handle crons
separately.

#### `vercel.json` (for Express on Vercel)

```json
{
  "version": 2,
  "builds": [
    {
      "src": "server.js",
      "use": "@vercel/node"
    }
  ],
  "routes": [
    {
      "src": "/(.*)",
      "dest": "/server.js"
    }
  ]
}
```

> **Timeout warning:** Vercel free tier enforces a **10-second function
> timeout**. Vercel Pro raises this to 60 seconds. Slack slash commands
> require a response in **3 seconds** — Pact already handles this correctly
> by responding immediately and doing work asynchronously. Long-running
> operations (digest generation) may hit the 60s Pro limit.

#### Slack's 3-second requirement — how Pact handles it

Slack requires your endpoint to return HTTP 200 within 3 seconds.
Pact already does this everywhere:

1. Slash command handler calls `respond({ ... })` immediately with an
   ephemeral acknowledgement
2. Heavy work (AI inference, DB lookups, multi-step messages) runs **after**
   the 200 is sent via `setImmediate` or fire-and-forget async calls

No changes needed for this constraint.

### Cron jobs that need an external scheduler

These `setInterval` jobs in `server.js` **won't run** on serverless:

| Job | Frequency | Purpose |
|-----|-----------|---------|
| `checkNudgeDue` | hourly | First-pact onboarding nudge |
| `checkOverduePacts` | hourly | Overdue pact reminder DMs |
| `checkCounterpartyNudges` | hourly | 3-day overdue counterparty nudge |
| `checkStreakMilestones` | hourly | 7/30/100-day streak celebration DMs |
| `checkActivationDue` | hourly | 24h partner-invite DM for new installs |
| `startDailyDigest` | daily | Daily morning digest |
| `digestRoutes.startWeeklyDigestScheduler` | weekly | Weekly standup digest |
| `digestRoutes.startDailyMorningScheduler` | daily | Daily digest per user preferences |
| `startReminderChecker` | every 5 min | Reminder thread messages |

**Options for replacing crons on Vercel:**

1. **Vercel Cron** (Pro plan) — add `crons` to `vercel.json` and create
   `/api/cron/nudge`, `/api/cron/overdue` etc. as thin HTTP routes that
   call the internal check functions. Protect with a `CRON_SECRET` header.

2. **GitHub Actions scheduled workflows** — free, runs every hour, hits
   your Vercel deployment's cron endpoints.

3. **External cron service** (cron-job.org, EasyCron) — point at HTTP
   endpoints you expose, secured with a secret token.

4. **Keep one small server running** (Railway, Fly.io free tier) — run
   only the cron process (`node cron-worker.js`), point it at your
   Vercel app's public endpoints. Cheapest path that keeps crons intact.

---

## 5. Slack App Manifest — URLs to Update

After deploying, update every URL in the Slack developer portal at
**https://api.slack.com/apps → Your App**:

### OAuth & Permissions

| Setting | Value |
|---------|-------|
| **Redirect URLs** | `https://yourdomain.com/slack/oauth/callback` |

Also update the hardcoded redirect URI in:
- `lib/slack-oauth.js` line 10 (the `SLACK_OAUTH_URL` constant)
- `lib/slack-oauth.js` line 13 (the `REDIRECT_URI` constant)

### Slash Commands

Each slash command needs its **Request URL** updated:

| Command | Request URL |
|---------|------------|
| `/pact` | `https://yourdomain.com/slack/commands` |
| `/done` | `https://yourdomain.com/slack/commands` |
| `/streak` | `https://yourdomain.com/slack/commands` |

> All slash commands route to `/slack/commands` — that's the single Bolt
> endpoint registered via `endpoints: { commands: '/slack/commands' }`.

### Event Subscriptions

| Setting | Value |
|---------|-------|
| **Request URL** | `https://yourdomain.com/slack/events` |

Verify the URL — Slack sends a `url_verification` challenge that Bolt
handles automatically.

### Interactivity & Shortcuts

| Setting | Value |
|---------|-------|
| **Request URL** | `https://yourdomain.com/slack/events` |

> Bolt routes interactive payloads (button clicks, modals, action callbacks)
> through the same `/slack/events` endpoint as event subscriptions.

### App Home

No URL changes needed for App Home — it's driven by `app_home_opened`
events, not a URL.

### Workflow Steps (if using Workflow Builder)

If you have Workflow Builder steps registered:

| Setting | Value |
|---------|-------|
| **Step callback URLs** | Already handled by `/slack/events` |

### Support URL (Slack App Directory)

| Setting | Value |
|---------|-------|
| **Support URL** | `https://yourdomain.com/support` |

---

## 6. Stripe Webhook

After deploying, register your Stripe webhook:

1. Go to https://dashboard.stripe.com → Developers → Webhooks → **Add endpoint**
2. Endpoint URL: `https://yourdomain.com/api/webhooks/stripe`
3. Events to listen to:
   - `checkout.session.completed`
   - `customer.subscription.deleted`
   - `invoice.payment_failed`
4. Copy the **Signing secret** → set `STRIPE_WEBHOOK_SECRET` env var

---

## 7. Checklist Before Going Live

- [ ] Fork repo to `amamujee/pact`
- [ ] Create Neon free tier database at https://neon.tech
- [ ] Run `npm run migrate` against new DB (or restore from dump)
- [ ] Set all required env vars in Vercel dashboard
- [ ] Update `lib/slack-oauth.js` hardcoded URLs (lines 10 and 13)
- [ ] Update Slack app redirect URL in developer portal
- [ ] Update slash command Request URLs in Slack portal
- [ ] Update Event Subscriptions Request URL in Slack portal
- [ ] Update Interactivity Request URL in Slack portal
- [ ] Register Stripe webhook endpoint, set `STRIPE_WEBHOOK_SECRET`
- [ ] Reinstall Slack app (`/slack/reinstall`) to get a fresh bot token
- [ ] Set up cron jobs for hourly/daily/weekly scheduled tasks
- [ ] Test: `/pact hello @someone tomorrow` in Slack
- [ ] Test: `/done` to complete a pact
- [ ] Verify `/health` returns `{"status":"healthy","slack":true}`
