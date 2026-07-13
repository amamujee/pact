# Pact

## What this app does
Pact turns casual Slack promises into tracked commitments with automatic reminders, overdue nudges, and completion tracking. Users create pacts via `/pact`, emoji reactions, or DM — and close them with `/done`.

## Stack
Node.js + Express + PostgreSQL (Neon) + Slack Bolt SDK, deployed on Vercel.

## Directory map
- `server.js` — wiring only (260 lines): imports, init, start()
- `lib/slack-handlers.js` — all Slack command/action/event handlers, reminders, DM, reactions
- `lib/workflow-builder.js` — Workflow Builder steps: pact_create, pact_summary
- `lib/access.js` — free-for-all feature access compatibility helpers
- `lib/metrics-routes.js` — internal metrics dashboard routes
- `lib/analytics.js` — IP hashing, UTM extraction, pageview middleware, analytics routes
- `lib/helpers.js` — formatDate, getUserTimezone, parseDueDate, getUserName, status helpers
- `lib/counterparty.js` — BOT_DM/PEER_DM sentinels, getDMCounterparty, backfillCounterparty
- `lib/error-tracker.js` — in-memory error counting, threshold alerting, /health/errors route
- `lib/tracker-routes.js` — Linear/Notion/Asana OAuth routes
- `lib/slack-oauth.js` — Slack OAuth install callback
- `lib/slack-diagnostics.js` — /slack/status, /slack/verify-events diagnostic routes
- `lib/contact-routes.js` — contact form rate limiting and submission routes
- `lib/page-routes.js` — static page routes
- `lib/streak-milestones.js` — milestone detection cron, celebration DM builder, /pact share card generation
- `lib/workspace-admin-digest.js` — workspace admin weekly email digest; standalone scheduler entry in `scripts/workspace-admin-digest.js`
- `lib/activation-dm.js` — 24h partner-invite DM: cron (checkActivationDue), Block Kit builder, action handlers (activation_pact_create, activation_dismiss, activation_how_it_works, activation_pick_teammate)
- `lib/welcome-dm.js` — immediate first-install welcome DM: trigger on app_home_opened, Block Kit content, action handlers (welcome_make_pact, welcome_dismiss, welcome_how_it_works); idempotent via welcome_dm_sent_at in installations
- `lib/first-pact-dm.js` — first-pact celebration DM: fires on 0→1 pact transition, Block Kit content, "Make another pact" CTA; idempotent via activation_events (first_pact_celebrated event)
- `lib/home-tab.js` — App Home Tab surface: builds Block Kit view (active pacts, score, quick-create) and publishes via views.publish
- `lib/bulk-actions.js` — bulk complete + snooze handlers triggered from Home Tab checkboxes; reads view.state.values for checked pact IDs
- `lib/reschedule-proposals.js` — counterparty-initiated reschedule proposal lifecycle: propose/accept/decline/counter handlers
- `lib/fuzzy.js` — lightweight fuzzy matching (token-based, Levenshtein, subsequence)
- `lib/ai-client.js` — direct Anthropic chat wrapper (chat() calls via @anthropic-ai/sdk)
- `lib/ai-done.js` — AI context inference for /done: fetch recent messages, rank pacts, build suggestion blocks
- `lib/ai-commitment.js` — AI commitment detection: regex pre-filter, Anthropic analysis, ephemeral suggest-a-pact blocks, rate-limit + snooze helpers
- `lib/recurrence.js` — pure recurrence logic: nextDueDate(rule, fromDate), recurrenceLabel(rule)
- `routes/done.js` — /done command handler: multi-complete, fuzzy matching, pact picker
- `routes/digest.js` — weekly standup digest: scheduler, Block Kit builder, inline action handlers
- `routes/streak.js` — /streak/:token public share card page with OG tags + analytics endpoints
- `routes/activation.js` — /admin/activation funnel dashboard: daily install→DM→pact conversion table
- `routes/activate.js` — GET /activate click-tracking redirect: logs activation_dm_clicked, populates activation_dm_clicked_at, redirects to app with ?open_activation=true
- `routes/public-stats.js` — GET /api/public-stats: workspaces/pacts_kept/on_time_pct, 60s in-memory cache; exports getPublicStats() for SSR homepage injection
- `routes/invite.js` — GET /invite/:token (landing page), POST /api/invite/gen (create link), GET /api/invite/count (teams joined count)
- `db/index.js` — database connection singleton (only file that constructs Pool)
- `db/invites.js` — workspace_invites CRUD: create, claim, event logging (invite_created/clicked/installed), leaderboard
- `db/pacts.js` — pact entity queries: lookups, completion, backfill
- `db/reschedule-proposals.js` — reschedule_proposals CRUD: create, resolve (accept/decline), pending lookups
- `db/digest.js` — user_digest_prefs queries and digest data aggregation
- `db/workspace-admin-digest.js` — workspace_admin_digest_prefs queries and workspace-level pact stats
- `db/streak-milestones.js` — streak_milestones, streak_share_cards, streak_analytics queries
- `db/user-activation.js` — user_activation state + activation_events analytics queries
- `tracker.js` — Linear / Notion / Asana sync for all workspaces
- `public/` — static HTML: landing page, dashboard, legal
- `migrations/` — JS-based schema migrations (node-pg-migrate pattern via migrate.js)
- `test-fixtures/` — test payloads for Slack events

## Database
- `pacts` — core entity: description, due_date, status (active/completed/cancelled), creator/counterparty Slack IDs, channel_id; `recurrence_rule` JSONB + `recurrence_group_id` UUID for recurring series; `overdue_nudge_sent_at` (promiser nudge tracking); `counterparty_nudged_at` (3-day counterparty nudge tracking)
- `user_digest_prefs` — per-user digest settings: frequency (weekly/daily), send_day, send_hour, timezone, opt-out, snooze, last_digest_sent_at, daily_last_sent_at
- `workspace_admin_digest_prefs` — per-workspace admin email digest settings: admin_email, enabled, send_day/send_hour (UTC), last_sent_at; one row per workspace, backfilled from installer on migration 031
- `workflow_step_executions` — Workflow Builder step execution log (team_id, step, inputs/outputs, status)
- `installations` — Slack workspace installs, trigger_emoji config; `welcome_dm_sent_at` (TIMESTAMPTZ) for immediate welcome DM idempotency
- `pageviews` — landing page analytics
- `contact_submissions` — contact form entries
- `feedback` — user feedback via `/pact feedback`
- `error_logs` — application error tracking
- `tracker_connections` / `tracker_projects` — OAuth + project mappings for Linear/Notion/Asana
- `installations.commitment_last_suggested_at` — JSONB map {userId: ISO ts} for per-user 1/hr rate limit on commitment suggestions
- `installations.commitment_snoozed_channels` — JSONB array of channel IDs where suggestions are silenced
- `reschedule_proposals` — counterparty-proposed date changes: pact_id, proposed_by, proposed_date, status (pending/accepted/declined), resolved_at
- `streak_milestones` — awarded milestone records: user_id, slack_team_id, milestone_days (7/30/100); UNIQUE prevents double-award
- `streak_share_cards` — opaque token → user/milestone/stats; expires_at 90 days; powers /streak/:token
- `streak_analytics` — streak_card_viewed + streak_card_shared events with platform + ip_hash
- `user_activation` — per-user activation DM state: activation_dm_sent_at, activation_dm_clicked_at, activation_pact_created_at; UNIQUE (team_id, user_id)
- `activation_events` — funnel analytics: event_type (activation_dm_attempted/delivered/failed/clicked/pact_created/dismissed) per user+team with occurred_at + metadata; metadata stores Slack API response (ok, ts, error) for delivery confirmation
- `workspace_invites` — cross-workspace invite links: inviter_user_id, token, invite_link, claimed_at, claimed_team_id; `pact_created_within_7d` quality flag; `pro_grant_counted` idempotency flag; UNIQUE on token
- `invite_events` — invite funnel analytics: token, event_type (invite_created/clicked/installed), occurred_at, metadata

## External integrations
- **Slack** — Bolt SDK for commands, events, interactive messages
- **Linear / Notion / Asana** — optional tracker sync, included for free

## Recent changes
- 2026-06-11: Weekly workspace admin email digest — sends HTML + plain-text email to workspace admins (installer email) summarizing pacts created/completed/overdue for the week; `workspace_admin_digest_prefs` table (migration 031); `db/workspace-admin-digest.js` for stats queries; `lib/workspace-admin-digest.js` for server startup trigger; `scripts/workspace-admin-digest.js` for scheduler runs; `GET /api/digest/admin` manual trigger endpoint guarded by `CRON_SECRET`.
