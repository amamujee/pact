-- Schema generated from Pact migrations (001-031)
-- Run `npm run migrate` instead of this file for new deployments.
-- Use this file as a reference or for manual inspection.

-- =============================================================================
-- Migration tracking table (migrate.js bootstrap)
-- =============================================================================

CREATE TABLE IF NOT EXISTS _migrations (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(255) NOT NULL UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =============================================================================
-- Core tables (migrate.js runCoreMigrations — always idempotent)
-- =============================================================================

CREATE TABLE IF NOT EXISTS users (
  id                       SERIAL PRIMARY KEY,
  email                    VARCHAR(255) NOT NULL,
  name                     VARCHAR(255),
  password_hash            VARCHAR(255),
  created_at               TIMESTAMPTZ DEFAULT NOW(),
  updated_at               TIMESTAMPTZ DEFAULT NOW(),
  -- Subscription fields synced when a customer subscribes
  stripe_subscription_id   VARCHAR(255),
  subscription_status      VARCHAR(50),
  subscription_plan        VARCHAR(255),
  subscription_expires_at  TIMESTAMPTZ,
  subscription_updated_at  TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx
  ON users (LOWER(email));

CREATE INDEX IF NOT EXISTS users_stripe_subscription_id_idx
  ON users (stripe_subscription_id);

-- =============================================================================
-- Migration: create_pacts  (001_create_pacts.js)
-- =============================================================================

CREATE TABLE IF NOT EXISTS pacts (
  id                    SERIAL PRIMARY KEY,
  team_id               VARCHAR(255) NOT NULL,
  channel_id            VARCHAR(255) NOT NULL,
  creator_slack_id      VARCHAR(255) NOT NULL,
  creator_name          VARCHAR(255) NOT NULL,
  counterparty_slack_id VARCHAR(255) NOT NULL,
  counterparty_name     VARCHAR(255) NOT NULL,
  description           TEXT NOT NULL,
  due_date              DATE,
  status                VARCHAR(50) DEFAULT 'active' NOT NULL,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  completed_at          TIMESTAMPTZ,
  completed_by          VARCHAR(255),
  last_reminded_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS pacts_channel_status_idx
  ON pacts (channel_id, status);

CREATE INDEX IF NOT EXISTS pacts_due_date_status_idx
  ON pacts (due_date, status)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS pacts_team_id_idx
  ON pacts (team_id);

-- =============================================================================
-- Migration: create_analytics  (002_create_analytics.js)
-- =============================================================================

CREATE TABLE IF NOT EXISTS pageviews (
  id           SERIAL PRIMARY KEY,
  path         VARCHAR(2048) NOT NULL,
  referrer     VARCHAR(2048),
  utm_source   VARCHAR(255),
  utm_medium   VARCHAR(255),
  utm_campaign VARCHAR(255),
  user_agent   TEXT,
  ip_hash      VARCHAR(64),
  session_id   VARCHAR(64),
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pageviews_created_at_idx ON pageviews (created_at);
CREATE INDEX IF NOT EXISTS pageviews_path_idx       ON pageviews (path);
CREATE INDEX IF NOT EXISTS pageviews_ip_hash_idx    ON pageviews (ip_hash);

CREATE TABLE IF NOT EXISTS events (
  id           SERIAL PRIMARY KEY,
  event_type   VARCHAR(255) NOT NULL,
  metadata     JSONB DEFAULT '{}',
  session_id   VARCHAR(64),
  ip_hash      VARCHAR(64),
  referrer     VARCHAR(2048),
  utm_source   VARCHAR(255),
  utm_medium   VARCHAR(255),
  utm_campaign VARCHAR(255),
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS events_event_type_idx ON events (event_type);
CREATE INDEX IF NOT EXISTS events_created_at_idx ON events (created_at);
CREATE INDEX IF NOT EXISTS events_session_id_idx ON events (session_id);

-- =============================================================================
-- Migration: create_installations  (003_create_installations.js)
-- =============================================================================

CREATE TABLE IF NOT EXISTS installations (
  id           SERIAL PRIMARY KEY,
  team_id      VARCHAR(255) NOT NULL,
  team_name    VARCHAR(255) NOT NULL,
  bot_token    TEXT NOT NULL,
  bot_user_id  VARCHAR(255),
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS installations_team_id_idx
  ON installations (team_id);

-- =============================================================================
-- Migration: due_date_timestamptz  (004_due_date_timestamptz.js)
-- =============================================================================

ALTER TABLE pacts
  ALTER COLUMN due_date TYPE TIMESTAMPTZ
  USING due_date::timestamptz;

-- =============================================================================
-- Migration: nullable_counterparty  (005_nullable_counterparty.js)
-- =============================================================================

-- Make counterparty fields nullable so pacts can be created immediately
-- in peer DMs where the bot can't resolve the counterparty's Slack ID.
ALTER TABLE pacts ALTER COLUMN counterparty_slack_id DROP NOT NULL;
ALTER TABLE pacts ALTER COLUMN counterparty_name DROP NOT NULL;
ALTER TABLE pacts ALTER COLUMN channel_id DROP NOT NULL;

-- =============================================================================
-- Migration: tracker_tables  (006_tracker_tables.js)
-- =============================================================================

ALTER TABLE installations
  ADD COLUMN IF NOT EXISTS tier VARCHAR(20) DEFAULT 'free';

CREATE TABLE IF NOT EXISTS tracker_connections (
  id                   SERIAL PRIMARY KEY,
  slack_team_id        VARCHAR(255) NOT NULL,
  provider             VARCHAR(50) NOT NULL,
  access_token         TEXT NOT NULL,
  refresh_token        TEXT,
  token_expires_at     TIMESTAMPTZ,
  default_project_id   VARCHAR(500),
  default_project_name VARCHAR(500),
  connected_by_user_id VARCHAR(255),
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS tracker_connections_team_provider_idx
  ON tracker_connections (slack_team_id, provider);

CREATE TABLE IF NOT EXISTS pact_tracker_syncs (
  id             SERIAL PRIMARY KEY,
  pact_id        INTEGER NOT NULL REFERENCES pacts(id) ON DELETE CASCADE,
  provider       VARCHAR(50) NOT NULL,
  external_id    VARCHAR(500) NOT NULL,
  external_url   TEXT,
  sync_status    VARCHAR(50) DEFAULT 'synced',
  last_synced_at TIMESTAMPTZ DEFAULT NOW(),
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS pact_tracker_syncs_pact_provider_idx
  ON pact_tracker_syncs (pact_id, provider);

CREATE INDEX IF NOT EXISTS pact_tracker_syncs_pact_id_idx
  ON pact_tracker_syncs (pact_id);

-- =============================================================================
-- Migration: contact_submissions  (007_contact_submissions.js)
-- =============================================================================

CREATE TABLE IF NOT EXISTS contact_submissions (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(255) NOT NULL,
  email      VARCHAR(255) NOT NULL,
  message    TEXT NOT NULL,
  read       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS contact_submissions_created_at_idx
  ON contact_submissions (created_at DESC);

CREATE INDEX IF NOT EXISTS contact_submissions_read_idx
  ON contact_submissions (read);

-- =============================================================================
-- Migration: create_subscriptions  (008_create_subscriptions.js)
-- =============================================================================

CREATE TABLE IF NOT EXISTS subscriptions (
  id                   SERIAL PRIMARY KEY,
  team_id              VARCHAR(255) NOT NULL,
  plan                 VARCHAR(20) NOT NULL,
  seat_count           INTEGER NOT NULL DEFAULT 3,
  status               VARCHAR(20) NOT NULL DEFAULT 'active',
  stripe_session_id    VARCHAR(500),
  billing_email        VARCHAR(255),
  activated_at         TIMESTAMPTZ DEFAULT NOW(),
  current_period_end   TIMESTAMPTZ,
  cancelled_at         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS subscriptions_team_id_idx
  ON subscriptions (team_id);

CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_stripe_session_idx
  ON subscriptions (stripe_session_id)
  WHERE stripe_session_id IS NOT NULL;

-- Monthly pact counters — tracks usage per team per month for limit enforcement
CREATE TABLE IF NOT EXISTS pact_monthly_counts (
  id          SERIAL PRIMARY KEY,
  team_id     VARCHAR(255) NOT NULL,
  year_month  VARCHAR(7) NOT NULL,
  pact_count  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS pact_monthly_counts_team_month_idx
  ON pact_monthly_counts (team_id, year_month);

-- =============================================================================
-- Migration: first_pact_onboarding  (009_first_pact_onboarding.js)
-- =============================================================================

ALTER TABLE installations
  ADD COLUMN IF NOT EXISTS installer_user_id VARCHAR(255);

ALTER TABLE installations
  ADD COLUMN IF NOT EXISTS first_pact_created BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE installations
  ADD COLUMN IF NOT EXISTS nudge_sent_at TIMESTAMPTZ;

-- =============================================================================
-- Migration: pact_modifications  (009_pact_modifications.js)
-- =============================================================================

-- Track pact modification events — edits and deadline extensions
CREATE TABLE IF NOT EXISTS pact_modifications (
  id               SERIAL PRIMARY KEY,
  pact_id          INTEGER NOT NULL REFERENCES pacts(id) ON DELETE CASCADE,
  modified_by      VARCHAR(255) NOT NULL,
  modified_by_name VARCHAR(255),
  modification_type VARCHAR(50) NOT NULL,  -- 'description' or 'due_date'
  old_value        TEXT,
  new_value        TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pact_modifications_pact_id_idx
  ON pact_modifications (pact_id);

ALTER TABLE pacts
  ADD COLUMN IF NOT EXISTS last_modified_at TIMESTAMPTZ;

-- =============================================================================
-- Migration: overdue_nudge  (010_overdue_nudge.js)
-- =============================================================================

-- Track when overdue nudge was sent so we only nudge once per pact.
ALTER TABLE pacts
  ADD COLUMN IF NOT EXISTS overdue_nudge_sent_at TIMESTAMPTZ;

-- =============================================================================
-- Migration: subscriptions_stripe_customer  (011_subscriptions_stripe_customer.js)
-- =============================================================================

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS purchaser_slack_id VARCHAR(255);

CREATE INDEX IF NOT EXISTS subscriptions_stripe_customer_id_idx
  ON subscriptions (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

-- =============================================================================
-- Migration: error_logs  (012_error_logs.js)
-- =============================================================================

CREATE TABLE IF NOT EXISTS error_logs (
  id           SERIAL PRIMARY KEY,
  error_key    VARCHAR(255) NOT NULL,
  message      TEXT NOT NULL,
  count        INTEGER NOT NULL DEFAULT 1,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  alerted_at   TIMESTAMPTZ,
  CONSTRAINT error_logs_key_unique UNIQUE (error_key)
);

CREATE INDEX IF NOT EXISTS error_logs_last_seen_idx
  ON error_logs (last_seen_at DESC);

-- =============================================================================
-- Migration: feedback  (013_feedback.js)
-- =============================================================================

CREATE TABLE IF NOT EXISTS feedback (
  id            SERIAL PRIMARY KEY,
  team_id       VARCHAR(255),
  user_slack_id VARCHAR(255),
  message       TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- Migration: trigger_emoji  (014_trigger_emoji.js)
-- =============================================================================

-- Configurable trigger emoji per workspace (default: handshake)
ALTER TABLE installations
  ADD COLUMN IF NOT EXISTS trigger_emoji VARCHAR(100) NOT NULL DEFAULT 'handshake';

-- =============================================================================
-- Migration: pact_confirmation_ts  (015_pact_confirmation_ts.js)
-- =============================================================================

-- Store the channel + ts of the pact confirmation message sent to the creator.
ALTER TABLE pacts
  ADD COLUMN IF NOT EXISTS confirmation_channel VARCHAR(255),
  ADD COLUMN IF NOT EXISTS confirmation_ts VARCHAR(255);

CREATE INDEX IF NOT EXISTS pacts_confirmation_ts_idx
  ON pacts (confirmation_channel, confirmation_ts)
  WHERE confirmation_ts IS NOT NULL;

-- =============================================================================
-- Migration: user_digest_prefs  (016_user_digest_prefs.js)
-- =============================================================================

CREATE TABLE IF NOT EXISTS user_digest_prefs (
  id                   SERIAL PRIMARY KEY,
  user_id              VARCHAR(255) NOT NULL,
  team_id              VARCHAR(255) NOT NULL,
  frequency            VARCHAR(20) DEFAULT 'weekly' NOT NULL,
  send_day             SMALLINT DEFAULT 1 NOT NULL,
  send_hour            SMALLINT DEFAULT 9 NOT NULL,
  timezone             VARCHAR(100) DEFAULT 'America/New_York' NOT NULL,
  digest_snoozed_until TIMESTAMPTZ,
  digest_opt_out       BOOLEAN DEFAULT false NOT NULL,
  last_digest_sent_at  TIMESTAMPTZ,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, team_id)
);

CREATE INDEX IF NOT EXISTS user_digest_prefs_team_idx
  ON user_digest_prefs (team_id);

-- =============================================================================
-- Migration: workflow_steps  (017_workflow_steps.js)
-- =============================================================================

-- Logs every Workflow Builder step execution for Pro-tier analytics.
CREATE TABLE IF NOT EXISTS workflow_step_executions (
  id                   SERIAL PRIMARY KEY,
  team_id              VARCHAR(255) NOT NULL,
  step_callback_id     VARCHAR(100) NOT NULL,
  workflow_id          VARCHAR(255),
  executed_by_user_id  VARCHAR(255),
  inputs               JSONB DEFAULT '{}',
  outputs              JSONB DEFAULT '{}',
  status               VARCHAR(50) DEFAULT 'completed' NOT NULL,
  error_message        TEXT,
  executed_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS workflow_step_executions_team_idx
  ON workflow_step_executions (team_id, executed_at DESC);

-- =============================================================================
-- Migration: daily_digest_tracking  (018_daily_digest_tracking.js)
-- =============================================================================

-- Track when the daily morning digest was last sent, separate from weekly cadence.
ALTER TABLE user_digest_prefs
  ADD COLUMN IF NOT EXISTS daily_last_sent_at TIMESTAMPTZ;

-- =============================================================================
-- Migration: reminder_thread_ts  (019_reminder_thread_ts.js)
-- =============================================================================

-- Store channel + ts of the bot's reminder DM for thread-reply matching.
ALTER TABLE pacts
  ADD COLUMN IF NOT EXISTS reminder_channel VARCHAR(255),
  ADD COLUMN IF NOT EXISTS reminder_ts VARCHAR(255);

CREATE INDEX IF NOT EXISTS pacts_reminder_ts_idx
  ON pacts (reminder_channel, reminder_ts)
  WHERE reminder_ts IS NOT NULL;

-- =============================================================================
-- Migration: subscriptions_payment_status  (020_subscriptions_payment_status.js)
-- =============================================================================

-- Add payment_status to subscriptions for past_due tracking.
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20) DEFAULT 'ok';

-- =============================================================================
-- Migration: commitment_detection_snoozed  (021_commitment_detection_snoozed.js)
-- =============================================================================

-- commitment_last_suggested_at: JSONB map { userId: ISO timestamp } for 1/hr rate limit
-- commitment_snoozed_channels:  JSONB array of channel IDs where suggestions are silenced
ALTER TABLE installations
  ADD COLUMN IF NOT EXISTS commitment_last_suggested_at JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS commitment_snoozed_channels  JSONB DEFAULT '[]'::jsonb;

-- =============================================================================
-- Migration: recurring_pacts  (022_recurring_pacts.js)
-- =============================================================================

-- recurrence_rule: JSONB storing { frequency, day, dayOfMonth } — null for one-off pacts.
-- recurrence_group_id: UUID linking all instances of the same recurring series.
ALTER TABLE pacts
  ADD COLUMN IF NOT EXISTS recurrence_rule      JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS recurrence_group_id  UUID DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_pacts_recurrence_group
  ON pacts (recurrence_group_id)
  WHERE recurrence_group_id IS NOT NULL;

-- =============================================================================
-- Migration: counterparty_nudge  (023_counterparty_nudge.js)
-- =============================================================================

-- Tracks when the "3+ days overdue" nudge was sent to the counterparty.
-- Separate from overdue_nudge_sent_at (which tracks the promiser nudge).
ALTER TABLE pacts
  ADD COLUMN IF NOT EXISTS counterparty_nudged_at TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS counterparty_team_id VARCHAR(255);

-- =============================================================================
-- Migration: reschedule_proposals  (024_reschedule_proposals.js)
-- =============================================================================

-- Tracks counterparty-initiated date change requests on active pacts.
-- Lifecycle: pending -> accepted | declined.
CREATE TABLE IF NOT EXISTS reschedule_proposals (
  id           SERIAL PRIMARY KEY,
  pact_id      INTEGER NOT NULL REFERENCES pacts(id) ON DELETE CASCADE,
  proposed_by  VARCHAR(64) NOT NULL,    -- Slack user ID of proposer (counterparty)
  proposed_date DATE NOT NULL,          -- The new due date being proposed
  status       VARCHAR(16) NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at  TIMESTAMPTZ DEFAULT NULL,
  resolved_by  VARCHAR(64) DEFAULT NULL -- Slack user ID who accepted/declined
);

CREATE INDEX IF NOT EXISTS idx_reschedule_proposals_pact_id
  ON reschedule_proposals (pact_id);

CREATE INDEX IF NOT EXISTS idx_reschedule_proposals_pending
  ON reschedule_proposals (pact_id, status)
  WHERE status = 'pending';

-- =============================================================================
-- Migration: streak_milestones  (025_streak_milestones.js)
-- =============================================================================

-- streak_milestones: one row per user/milestone awarded (prevents double-DM).
CREATE TABLE IF NOT EXISTS streak_milestones (
  id             SERIAL PRIMARY KEY,
  user_id        VARCHAR(64) NOT NULL,   -- Slack user ID
  slack_team_id  VARCHAR(64) NOT NULL,   -- Slack workspace ID
  milestone_days INTEGER NOT NULL,       -- 7, 30, or 100
  awarded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, slack_team_id, milestone_days)
);

CREATE INDEX IF NOT EXISTS idx_streak_milestones_user
  ON streak_milestones (user_id, slack_team_id);

-- streak_share_cards: opaque token -> user/milestone/stats for the public /streak/:token page.
CREATE TABLE IF NOT EXISTS streak_share_cards (
  id             SERIAL PRIMARY KEY,
  token          VARCHAR(16) NOT NULL UNIQUE,
  user_id        VARCHAR(64) NOT NULL,
  slack_team_id  VARCHAR(64) NOT NULL,
  milestone_days INTEGER NOT NULL,
  display_name   VARCHAR(128),           -- user's first name or display name
  pacts_kept     INTEGER NOT NULL DEFAULT 0,
  on_time_pct    INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at     TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '90 days')
);

CREATE INDEX IF NOT EXISTS idx_streak_share_cards_token
  ON streak_share_cards (token);

-- streak_analytics: tracks card views and social share clicks.
CREATE TABLE IF NOT EXISTS streak_analytics (
  id          SERIAL PRIMARY KEY,
  token       VARCHAR(16) NOT NULL,
  event       VARCHAR(32) NOT NULL,   -- 'viewed' or 'shared'
  platform    VARCHAR(32),            -- 'twitter', 'linkedin', 'copy' (null for viewed)
  ip_hash     VARCHAR(64),            -- hashed visitor IP for dedup (views only)
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_streak_analytics_token
  ON streak_analytics (token);

-- =============================================================================
-- Migration: user_activation  (026_user_activation.js)
-- =============================================================================

-- Per-user activation DM state. Separate from installations (per-workspace)
-- because activation is a per-user lifecycle event.
CREATE TABLE IF NOT EXISTS user_activation (
  id                        SERIAL PRIMARY KEY,
  team_id                   VARCHAR(255) NOT NULL,
  user_id                   VARCHAR(255) NOT NULL,
  activation_dm_sent_at     TIMESTAMPTZ,
  activation_dm_clicked_at  TIMESTAMPTZ,
  activation_pact_created_at TIMESTAMPTZ,
  created_at                TIMESTAMPTZ DEFAULT NOW(),
  updated_at                TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (team_id, user_id)
);

CREATE INDEX IF NOT EXISTS user_activation_team_user_idx
  ON user_activation (team_id, user_id);

-- activation_events: funnel analytics for admin dashboard
CREATE TABLE IF NOT EXISTS activation_events (
  id          SERIAL PRIMARY KEY,
  team_id     VARCHAR(255) NOT NULL,
  user_id     VARCHAR(255) NOT NULL,
  event_type  VARCHAR(64) NOT NULL,
  occurred_at TIMESTAMPTZ DEFAULT NOW(),
  metadata    JSONB
);

CREATE INDEX IF NOT EXISTS activation_events_team_occurred_idx
  ON activation_events (team_id, occurred_at DESC);

-- =============================================================================
-- Migration: workspace_invites  (030_workspace_invites.js)
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS workspace_invites (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inviter_user_id          VARCHAR(255) NOT NULL,
  inviter_team_id          VARCHAR(255) NOT NULL,
  token                    VARCHAR(255) NOT NULL UNIQUE,
  invite_link              TEXT NOT NULL,
  claimed_at               TIMESTAMPTZ,
  claimed_team_id          VARCHAR(255),
  claimed_user_id          VARCHAR(255),
  pact_created_within_7d   BOOLEAN NOT NULL DEFAULT FALSE,
  pro_grant_counted        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at               TIMESTAMPTZ DEFAULT NOW(),
  updated_at               TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS workspace_invites_inviter_idx
  ON workspace_invites (inviter_user_id, inviter_team_id);

CREATE INDEX IF NOT EXISTS workspace_invites_claimed_team_idx
  ON workspace_invites (claimed_team_id)
  WHERE claimed_team_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS invite_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token       VARCHAR(255) NOT NULL,
  event_type  VARCHAR(64) NOT NULL,
  metadata    JSONB DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS invite_events_token_idx
  ON invite_events (token);

CREATE INDEX IF NOT EXISTS invite_events_type_created_idx
  ON invite_events (event_type, created_at DESC);

CREATE TABLE IF NOT EXISTS pro_grants (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id      VARCHAR(255) NOT NULL,
  granted_by   VARCHAR(64) NOT NULL,
  granted_to   VARCHAR(255),
  reason       TEXT,
  days         INTEGER NOT NULL DEFAULT 30,
  expires_at   TIMESTAMPTZ NOT NULL,
  redeemed     BOOLEAN NOT NULL DEFAULT FALSE,
  redeemed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pro_grants_team_active_idx
  ON pro_grants (team_id, expires_at DESC);

-- =============================================================================
-- Migration: workspace_admin_digest  (031_workspace_admin_digest.js)
-- =============================================================================

CREATE TABLE IF NOT EXISTS workspace_admin_digest_prefs (
  id            SERIAL PRIMARY KEY,
  team_id       VARCHAR(255) NOT NULL UNIQUE,
  admin_email   VARCHAR(255),
  admin_name    VARCHAR(255),
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  send_day      SMALLINT NOT NULL DEFAULT 1,
  send_hour     SMALLINT NOT NULL DEFAULT 9,
  last_sent_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS workspace_admin_digest_due_idx
  ON workspace_admin_digest_prefs (enabled, send_day, send_hour, last_sent_at);
