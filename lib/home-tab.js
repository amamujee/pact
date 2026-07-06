// lib/home-tab.js
// Owns: App Home Tab surface — building the Block Kit view and publishing it to Slack.
// Does NOT own: pact creation, completion logic, billing, or reminders.
//
// The home tab is the "daily retention surface" — visible when users click the Pact app
// in the Slack sidebar. Shows active pacts, analytics insights, and a promise score.
//
// Bulk actions: each section renders pacts as checkboxes (Block Kit checkboxes element).
// A sticky action bar at the top provides Complete / Snooze buttons that read
// view.state.values to find which pact IDs are checked — no server-side state needed.

'use strict';

const { recurrenceLabel } = require('./recurrence');
const {
  getPromiseStreak,
  getWeeklyTrend,
  getPersonalStats,
  getTeamPulse,
} = require('../db/pacts');
const {
  getPendingProposalsForCreator,
} = require('../db/reschedule-proposals');
const { isWelcomeDmSent } = require('../db/user-activation');
const { getTeamsJoinedCount, getSuccessfulInviteCount } = require('../db/invites');
const { getAppUrl } = require('./app-url');

// Injected via init()
let pool, formatDate, getUserTimezone, getTeamTier;

function init(deps) {
  pool = deps.pool;
  formatDate = deps.formatDate;
  getUserTimezone = deps.getUserTimezone;
  getTeamTier = deps.getTeamTier;
}

// ---------------------------------------------------------------------------
// Simple 60s in-memory cache keyed by userId
// WHY: Home tab data queries 5+ tables. Without caching, rapid re-opens
// (e.g. clicking the tab twice) would hammer the DB. 60s is short enough
// to reflect completions nearly immediately.
// ---------------------------------------------------------------------------

const _cache = new Map(); // userId → { ts, view }
const CACHE_TTL_MS = 60_000;

function getCached(userId) {
  const entry = _cache.get(userId);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { _cache.delete(userId); return null; }
  return entry.view;
}

function setCache(userId, view) {
  _cache.set(userId, { ts: Date.now(), view });
}

function invalidateCache(userId) {
  _cache.delete(userId);
}

// ---------------------------------------------------------------------------
// DB helpers — scoped to what the home tab needs; direct pool usage is allowed
// here because home-tab.js is a lib, not a route. All queries are read-only.
// ---------------------------------------------------------------------------

/** Pacts the user committed to (creator) that are still active */
async function getPactsIOwe(userId) {
  const { rows } = await pool.query(
    `SELECT id, description, due_date, status, counterparty_name, created_at, team_id,
            recurrence_rule, recurrence_group_id
     FROM pacts
     WHERE creator_slack_id = $1 AND status = 'active'
     ORDER BY
       CASE WHEN due_date < NOW() THEN 0 ELSE 1 END,
       due_date ASC NULLS LAST,
       created_at DESC
     LIMIT 20`,
    [userId]
  );
  return rows;
}

/** Pacts owed TO the user (they are the counterparty) */
async function getPactsOwedToMe(userId) {
  const { rows } = await pool.query(
    `SELECT id, description, due_date, status, creator_name, created_at, team_id,
            recurrence_rule, recurrence_group_id
     FROM pacts
     WHERE counterparty_slack_id = $1 AND status = 'active'
     ORDER BY
       CASE WHEN due_date < NOW() THEN 0 ELSE 1 END,
       due_date ASC NULLS LAST,
       created_at DESC
     LIMIT 20`,
    [userId]
  );
  return rows;
}

/** Promise score: completed/(completed+broken) over last 30 days for pacts user created */
async function getPromiseScore(userId) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'completed') AS kept,
       COUNT(*) FILTER (WHERE status = 'active' AND due_date < NOW()) AS overdue,
       COUNT(*) AS total
     FROM pacts
     WHERE creator_slack_id = $1
       AND created_at > NOW() - INTERVAL '30 days'`,
    [userId]
  );
  const r = rows[0];
  return {
    kept: parseInt(r.kept, 10),
    overdue: parseInt(r.overdue, 10),
    total: parseInt(r.total, 10),
  };
}

// ---------------------------------------------------------------------------
// Block Kit builders
// ---------------------------------------------------------------------------

function isOverdue(dueDate) {
  if (!dueDate) return false;
  return new Date(dueDate) < new Date();
}

function daysOverdue(dueDate) {
  if (!dueDate) return 0;
  const now = new Date();
  const due = new Date(dueDate);
  if (due >= now) return 0;
  return Math.floor((now - due) / 86400000);
}

function dueDateText(dueDate, tz) {
  if (!dueDate) return '_no deadline_';
  const label = formatDate(dueDate, tz);
  const days = daysOverdue(dueDate);
  if (days > 0) return `*🔴 ${days} day${days === 1 ? '' : 's'} overdue (was ${label})*`;
  return `Due: ${label}`;
}

/**
 * Build a single checkbox option for a pact.
 * Used in the bulk-select checkboxes element.
 */
function pactCheckboxOption(pact, role, tz, pendingProposalDate) {
  const overdue = isOverdue(pact.due_date);
  const days = daysOverdue(pact.due_date);
  const dateText = pact.due_date
    ? (days > 0
        ? `${days}d overdue`
        : `due ${formatDate(pact.due_date, tz)}`)
    : 'no deadline';

  const partyLabel = role === 'owe'
    ? (pact.counterparty_name ? ` → ${pact.counterparty_name}` : '')
    : (pact.creator_name ? ` by ${pact.creator_name}` : '');

  const rule = pact.recurrence_rule
    ? (typeof pact.recurrence_rule === 'string' ? JSON.parse(pact.recurrence_rule) : pact.recurrence_rule)
    : null;
  const recurSuffix = rule ? ` 🔄` : '';

  const prefix = overdue ? '🔴 ' : '🤝 ';
  const label = `${prefix}#${pact.id}: ${pact.description.substring(0, 50)}${partyLabel} (${dateText})${recurSuffix}`;

  const option = {
    text: { type: 'mrkdwn', text: label.substring(0, 150) },
    value: String(pact.id),
  };

  // Show pending reschedule proposal as description
  if (pendingProposalDate) {
    option.description = {
      type: 'plain_text',
      text: `📅 Proposed: ${formatDate(new Date(pendingProposalDate), tz)}`.substring(0, 75),
    };
  }

  return option;
}

/**
 * Build an "owed to me" row block (non-checkable — counterparty can't bulk-complete or bulk-snooze).
 * Still shown as section with "Propose date" button on overdue rows.
 */
function pactOwedBlock(pact, tz) {
  const overdue = isOverdue(pact.due_date);
  const dateText = dueDateText(pact.due_date, tz);
  const rule = pact.recurrence_rule
    ? (typeof pact.recurrence_rule === 'string' ? JSON.parse(pact.recurrence_rule) : pact.recurrence_rule)
    : null;
  const recurSuffix = rule ? `  🔄 _${recurrenceLabel(rule)}_` : '';
  const descText = overdue
    ? `:red_circle: *#${pact.id}* ${pact.description}`
    : `:handshake: *#${pact.id}* ${pact.description}`;
  const partyLabel = pact.creator_name ? `by *${pact.creator_name}*` : '';

  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `${descText}\n${dateText}${partyLabel ? '  ' + partyLabel : ''}${recurSuffix}`,
    },
    ...(overdue ? {
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: '📅 Propose date', emoji: true },
        action_id: 'propose_reschedule',
        value: String(pact.id),
      },
    } : {}),
  };
}

function scoreBar(score) {
  if (score.total === 0) return null;
  const kept = score.kept;
  const broken = score.overdue;
  const denominator = kept + broken;
  if (denominator === 0) return null;
  const pct = Math.round((kept / denominator) * 100);
  const stars = Math.round(pct / 20);
  const barFilled = '█'.repeat(stars);
  const barEmpty = '░'.repeat(5 - stars);
  const emoji = pct >= 80 ? ':trophy:' : pct >= 60 ? ':chart_with_upwards_trend:' : ':chart_with_downwards_trend:';
  return `${emoji} *Promise score (30 days):* ${barFilled}${barEmpty}  ${pct}% kept  _(${kept} kept, ${broken} overdue)_`;
}

function streakText(streak) {
  if (streak === 0) return null;
  const flame = streak >= 7 ? '🔥' : streak >= 3 ? '⚡' : '✨';
  return `${flame} *${streak}-day streak* — keep it going!`;
}

/**
 * Build the streak section block, optionally with a "Share" accessory button.
 * The share button appears at milestone-eligible streaks (7+ days).
 */
function streakBlock(streak) {
  if (streak === 0) return null;
  const text = streakText(streak);
  const block = { type: 'section', text: { type: 'mrkdwn', text } };
  // Only show share button at milestone-eligible thresholds so it feels earned
  if (streak >= 7) {
    block.accessory = {
      type: 'button',
      text: { type: 'plain_text', text: '🔗 Share streak', emoji: true },
      action_id: 'streak_share_home',
      value: String(streak),
    };
  }
  return block;
}

/**
 * Render 4-week text sparkline.
 * Each bar is up to 5 blocks wide: ░ = 0, █ = max completion count in period.
 * WHY text-based: Slack Block Kit doesn't support chart images inline without
 * external hosting. Pure mrkdwn keeps this dependency-free.
 */
function trendSparkline(weeks) {
  if (!weeks || weeks.length === 0) return null;

  // Fill in missing weeks with 0 so we always show 4 slots
  const filled = fillWeekGaps(weeks, 4);
  const maxCount = Math.max(...filled.map(w => w.count), 1);

  const bars = filled.map((w, i) => {
    const pct = w.count / maxCount;
    const filled5 = Math.round(pct * 5);
    const bar = '█'.repeat(filled5) + '░'.repeat(5 - filled5);
    return `Wk${i + 1}: ${bar} ${w.count}`;
  });

  return `📈 *Trend (4 weeks):*  ${bars.join('  |  ')}`;
}

function fillWeekGaps(weeks, count) {
  // Build a map by week_start ISO string
  const byWeek = {};
  for (const w of weeks) {
    const key = new Date(w.weekStart).toISOString().slice(0, 10);
    byWeek[key] = w.count;
  }

  // Generate last N week starts (Monday-aligned, UTC)
  const result = [];
  const now = new Date();
  // Roll back to last Monday
  const monday = new Date(now);
  monday.setUTCHours(0, 0, 0, 0);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));

  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(monday);
    d.setUTCDate(d.getUTCDate() - i * 7);
    const key = d.toISOString().slice(0, 10);
    result.push({ weekStart: d, count: byWeek[key] || 0 });
  }
  return result;
}

function personalStatsBlock(stats) {
  if (stats.totalCreated === 0) return null;

  const onTimePct = stats.totalCompleted > 0
    ? Math.round((stats.onTimeCount / stats.totalCompleted) * 100)
    : 0;

  let avgTimeText = '—';
  if (stats.avgHours != null) {
    if (stats.avgHours < 24) {
      avgTimeText = `${Math.round(stats.avgHours)}h`;
    } else {
      avgTimeText = `${(stats.avgHours / 24).toFixed(1)}d`;
    }
  }

  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: [
        '*📊 Your stats (all time)*',
        `• *${stats.totalCreated}* pacts created   •  *${stats.totalCompleted}* completed`,
        `• Avg completion time: *${avgTimeText}*   •  On-time rate: *${onTimePct}%*`,
      ].join('\n'),
    },
  };
}

function teamPulseBlock(pulse) {
  if (!pulse) return null;
  const keptPct = pulse.madeThisWeek > 0
    ? Math.round((pulse.keptThisWeek / pulse.madeThisWeek) * 100)
    : 0;
  return {
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `🏢 *Team this week:* ${pulse.madeThisWeek} promises made, ${pulse.keptThisWeek} kept (${keptPct}%)`,
    }],
  };
}

// ---------------------------------------------------------------------------
// Bulk action bar
// Shown when there are any pacts (owe or owed).
// Checkboxes are in actions blocks in each pact section.
// ---------------------------------------------------------------------------

function bulkActionBar(totalOwePacts) {
  if (totalOwePacts === 0) return null;

  return {
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: '✅ Complete selected', emoji: true },
        style: 'primary',
        action_id: 'bulk_complete',
        value: 'complete',
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '⏭ Tomorrow', emoji: true },
        action_id: 'bulk_snooze_tomorrow',
        value: 'snooze_tomorrow',
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '⏩ +3 Days', emoji: true },
        action_id: 'bulk_snooze_3days',
        value: 'snooze_3days',
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '📅 Pick date', emoji: true },
        action_id: 'bulk_snooze_pick_date',
        value: 'snooze_pick_date',
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Home view builder
// ---------------------------------------------------------------------------

async function buildHomeView(userId, client, { selectAllOverdue = false, teamId: teamIdHint = null } = {}) {
  const tz = await getUserTimezone(client, userId);

  // Fan out all DB calls in parallel for speed
  const [pactsIOwe, pactsOwedToMe, score, streak, trend, stats, pendingProposals] = await Promise.all([
    getPactsIOwe(userId),
    getPactsOwedToMe(userId),
    getPromiseScore(userId),
    getPromiseStreak(userId, tz),
    getWeeklyTrend(userId),
    getPersonalStats(userId),
    getPendingProposalsForCreator(userId),
  ]);

  // Build a lookup map: pact_id → proposed_date for pending proposals (creator view)
  const pendingProposalByPact = {};
  for (const p of pendingProposals) {
    pendingProposalByPact[p.pact_id] = p.proposed_date;
  }

  // Team pulse needs a team_id — prefer hint from event body (available for new users with no pacts),
  // fall back to deriving from pact data.
  const teamId = teamIdHint || (pactsIOwe[0] || pactsOwedToMe[0])?.team_id || null;
  const pulse = teamId ? await getTeamPulse(teamId) : null;

  // IDs of overdue "owe" pacts — used for selectAllOverdue pre-check
  const overdueOweIds = new Set(
    pactsIOwe.filter(p => isOverdue(p.due_date)).map(p => String(p.id))
  );

  const blocks = [];

  // ── Header
  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: '🤝 My Pacts', emoji: true },
  });

  // ── Streak (top, prominent) — shows share button at 7+ days
  const sBlock = streakBlock(streak);
  if (sBlock) {
    blocks.push(sBlock);
  }

  // ── Quick Actions
  blocks.push(
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*⚡ Quick Actions*' },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '📊 My Stats', emoji: true },
          action_id: 'home_stats',
          value: 'stats',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '🤝 Make Pact', emoji: true },
          action_id: 'home_make_pact',
          value: 'make',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '❓ Help', emoji: true },
          action_id: 'home_help',
          value: 'help',
        },
      ],
    },
    { type: 'divider' }
  );

  // ── Promise score + trend sparkline
  const scoreText = scoreBar(score);
  const trendText = trendSparkline(trend);
  if (scoreText || trendText) {
    const combinedText = [scoreText, trendText].filter(Boolean).join('\n');
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: combinedText } });
    blocks.push({ type: 'divider' });
  }

  // ── Getting Started card — for first-time users with zero pacts and no welcome DM yet
  if (pactsIOwe.length === 0 && pactsOwedToMe.length === 0 && teamId) {
    const dmSent = await isWelcomeDmSent(teamId, userId);
    if (!dmSent) {
      blocks.push(
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '*🚀 Getting started with Pact*' },
          accessory: {
            type: 'button',
            action_id: 'home_getting_started_pact',
            text: { type: 'plain_text', text: 'Make your first pact', emoji: true },
            style: 'primary',
            value: 'create_first',
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '_Pact turns promises into tracked commitments so nothing falls through the cracks._',
          },
        },
        { type: 'divider' }
      );
    }
  }

  // ── Bulk action bar (only when there are pacts I owe — only those are checkboxable)
  const actionBar = bulkActionBar(pactsIOwe.length);
  if (actionBar) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '_Check boxes below then use the buttons to act on multiple pacts at once:_' }],
    });
    blocks.push(actionBar);
    blocks.push({ type: 'divider' });
  }

  // ── Pacts I owe (overdue first, then upcoming)
  const overdueIOwe = pactsIOwe.filter(p => isOverdue(p.due_date));
  const upcomingIOwe = pactsIOwe.filter(p => !isOverdue(p.due_date));

  // Split recurring from one-off
  const overdueOneOff     = overdueIOwe.filter(p => !p.recurrence_rule);
  const overdueRecurring  = overdueIOwe.filter(p => p.recurrence_rule);
  const upcomingOneOff    = upcomingIOwe.filter(p => !p.recurrence_rule);
  const upcomingRecurring = upcomingIOwe.filter(p => p.recurrence_rule);

  // Sort overdue by most overdue first
  overdueOneOff.sort((a, b) => new Date(a.due_date) - new Date(b.due_date));
  overdueRecurring.sort((a, b) => new Date(a.due_date) - new Date(b.due_date));

  // Section header for "Promises I owe"
  const oweHeaderElements = [
    {
      type: 'mrkdwn',
      text: pactsIOwe.length > 0
        ? `*Promises I owe* (${pactsIOwe.length})`
        : `*Promises I owe*`,
    },
  ];

  // "Select all overdue" button — only shown when there are overdue pacts
  if (overdueIOwe.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: pactsIOwe.length > 0 ? `*Promises I owe* (${pactsIOwe.length})` : `*Promises I owe*`,
      },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: `☑ Select ${overdueIOwe.length} overdue`, emoji: true },
        action_id: 'select_all_overdue',
        value: 'select_all_overdue',
      },
    });
  } else {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: pactsIOwe.length > 0 ? `*Promises I owe* (${pactsIOwe.length})` : `*Promises I owe*`,
      },
    });
  }

  if (pactsIOwe.length === 0) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: "_Nothing active — you're clean! Use `/pact` in a DM to make one._" }],
    });
  } else {
    // Build one-off pacts (overdue + upcoming) as checkboxes
    const oneOffPacts = [...overdueOneOff, ...upcomingOneOff];
    if (oneOffPacts.length > 0) {
      const options = oneOffPacts.map(p =>
        pactCheckboxOption(p, 'owe', tz, pendingProposalByPact[p.id] || null)
      );
      // Pre-select all overdue if selectAllOverdue was requested
      const initialOptions = selectAllOverdue
        ? options.filter(opt => overdueOweIds.has(opt.value))
        : undefined;

      const checkboxBlock = {
        type: 'actions',
        block_id: 'bulk_owe_checks',
        elements: [{
          type: 'checkboxes',
          action_id: 'bulk_checkbox_change',
          options,
          ...(initialOptions && initialOptions.length > 0 ? { initial_options: initialOptions } : {}),
        }],
      };
      blocks.push(checkboxBlock);
    }

    // Recurring pacts section (separate visual group)
    const allRecurring = [...overdueRecurring, ...upcomingRecurring];
    if (allRecurring.length > 0) {
      if (oneOffPacts.length > 0) blocks.push({ type: 'divider' });
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `🔄 *Recurring* (${allRecurring.length})` }],
      });
      const recurOptions = allRecurring.map(p =>
        pactCheckboxOption(p, 'owe', tz, pendingProposalByPact[p.id] || null)
      );
      const initialRecurOptions = selectAllOverdue
        ? recurOptions.filter(opt => overdueOweIds.has(opt.value))
        : undefined;
      blocks.push({
        type: 'actions',
        block_id: 'bulk_owe_recur_checks',
        elements: [{
          type: 'checkboxes',
          action_id: 'bulk_checkbox_change',
          options: recurOptions,
          ...(initialRecurOptions && initialRecurOptions.length > 0 ? { initial_options: initialRecurOptions } : {}),
        }],
      });
    }
  }

  blocks.push({ type: 'divider' });

  // ── Pacts owed to me (non-checkable — counterparty can't complete/snooze others' pacts)
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: pactsOwedToMe.length > 0
        ? `*Promises owed to me* (${pactsOwedToMe.length})`
        : `*Promises owed to me*`,
    },
  });

  if (pactsOwedToMe.length === 0) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '_Nothing pending — no one owes you right now._' }],
    });
  } else {
    for (const pact of pactsOwedToMe) {
      blocks.push(pactOwedBlock(pact, tz));
    }
  }

  blocks.push({ type: 'divider' });

  // ── Personal stats card
  const statsBlock = personalStatsBlock(stats);
  if (statsBlock) {
    blocks.push(statsBlock);
    blocks.push({ type: 'divider' });
  }

  // ── Team pulse (workspace-level aggregate, no individual names)
  const pulseBlock = teamPulseBlock(pulse);
  if (pulseBlock) {
    blocks.push(pulseBlock);
  }

  // ── Viral invite section — shown for free users with 3+ total pacts created
  // Invite 2 workspaces → 30 days Pro free. Hides once Pro is active.
  if (stats.totalCreated >= 3 && teamId) {
    const currentTier = await getTeamTier(teamId);
    const successfulCount = await getSuccessfulInviteCount(userId, teamId);
    const remaining = Math.max(0, 2 - successfulCount);

    // Show incentive card for free users. Pro users see a lighter "bring teammates" nudge.
    const progressBar = successfulCount >= 2
      ? '🟩🟩 Complete!'
      : successfulCount === 1
        ? '🟩⬜ 1 / 2 workspaces'
        : '⬜⬜ 0 / 2 workspaces';

    const incentiveHeadline = currentTier === 'pro'
      ? `*🤝 Bring another team onto Pact*`
      : `*🎁 Invite 2 teams → get 30 days of Pro free*`;

    const incentiveBody = currentTier === 'pro'
      ? `Share your link — when a teammate from another company installs Pact, they become your cross-workspace pact partner.`
      : `Invite ${remaining > 0 ? `${remaining} more workspace${remaining === 1 ? '' : 's'}` : 'teammates'} and earn 30 days of Pro on us.\n\nProgress: ${progressBar}`;

    const socialText = encodeURIComponent(
      `invite 2 teammates' workspaces and get 30 days of Pact Pro on us. track commitments in Slack with automatic reminders → ${getAppUrl()}`
    );
    const twitterUrl = `https://twitter.com/intent/tweet?text=${socialText}`;

    blocks.push(
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: incentiveHeadline,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: incentiveBody,
        },
        accessory: {
          type: 'button',
          action_id: 'home_invite_get_link',
          text: { type: 'plain_text', text: 'Get invite link', emoji: true },
          style: currentTier !== 'pro' ? 'primary' : undefined,
          value: JSON.stringify({ userId, teamId }),
        },
      },
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `<${twitterUrl}|Share on Twitter> · Your link never expires · <slack://open|/pact invite> for details`
        }],
      }
    );
  }

  // ── Quick-create prompt
  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: '💡 Create a pact: open a DM with someone and type `/pact [what you\'ll do] by [date]`',
    }],
  });

  return { type: 'home', blocks };
}

// ---------------------------------------------------------------------------
// Publish — called from event handler and after pact state changes
// ---------------------------------------------------------------------------

async function publishHomeTab(client, userId, { bustCache = false, selectAllOverdue = false, teamId = null } = {}) {
  try {
    // selectAllOverdue bypasses cache so we always render with pre-checked state
    if (bustCache || selectAllOverdue) invalidateCache(userId);

    // Only use cache for default (no selectAllOverdue) renders
    if (!selectAllOverdue) {
      const cached = getCached(userId);
      if (cached) {
        await client.views.publish({ user_id: userId, view: cached });
        return;
      }
    }

    const view = await buildHomeView(userId, client, { selectAllOverdue, teamId });
    // Only cache default renders — selectAllOverdue views are one-time
    if (!selectAllOverdue) setCache(userId, view);
    await client.views.publish({ user_id: userId, view });
    console.log(`[HOME-TAB] Published for user=${userId} selectAllOverdue=${selectAllOverdue}`);
  } catch (err) {
    console.error(`[HOME-TAB] Failed to publish for user=${userId}: ${err.message}`);
    // Fail-open: don't crash the caller
  }
}

module.exports = { init, publishHomeTab, buildHomeView, invalidateHomeTabCache: invalidateCache };
