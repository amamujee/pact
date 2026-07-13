// lib/error-tracker.js
// Owns: in-memory error counting, threshold alerting, DB upsert for error_logs, /health/errors route.
// Does NOT own: pageview tracking, contact forms, Slack handlers, or domain logic.

// In-memory counter per normalized error key.
// When the same error fires 5+ times within 1 hour → ALERT log + DB record.
// /health/errors endpoint serves a 24h summary from the DB for dashboard monitoring.

const { requireAdminAuth } = require('./admin-auth');

const ERROR_ALERT_THRESHOLD = 5;      // fires after Nth occurrence
const ERROR_WINDOW_MS = 60 * 60 * 1000; // 1 hour sliding window

// Map of error_key -> { count, windowStart, alerted }
const errorCounters = new Map();

// Normalize an error message to a stable key:
//   - lowercase
//   - strip UUIDs, IDs, numbers that vary per-call
//   - truncate to 120 chars
function normalizeErrorKey(message) {
  return String(message)
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>') // UUIDs
    .replace(/\b[0-9]{4,}\b/g, '<n>') // long numbers (IDs, timestamps)
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 120);
}

// Call this wherever console.error is used for recurring errors.
// dbPool is the pg Pool — passed so this module stays self-contained.
// slackClient is optional (@slack/bolt client) for DM alerting.
let _errorPool = null;
let _errorSlackClient = null;

function initErrorTracker(dbPool, slackClient) {
  _errorPool = dbPool;
  _errorSlackClient = slackClient || null;
}

async function trackError(message, { tag = '' } = {}) {
  const key = (tag ? tag + ':' : '') + normalizeErrorKey(message);
  const now = Date.now();

  let entry = errorCounters.get(key);
  if (!entry || now - entry.windowStart > ERROR_WINDOW_MS) {
    // Start a fresh window
    entry = { count: 0, windowStart: now, alerted: false };
    errorCounters.set(key, entry);
  }
  entry.count++;

  // Persist to DB (non-blocking) — upsert on error_key
  if (_errorPool) {
    _errorPool.query(
      `INSERT INTO error_logs (error_key, message, count, first_seen_at, last_seen_at)
       VALUES ($1, $2, 1, NOW(), NOW())
       ON CONFLICT (error_key) DO UPDATE SET
         count = error_logs.count + 1,
         last_seen_at = NOW(),
         message = EXCLUDED.message`,
      [key, String(message).substring(0, 2000)]
    ).catch(e => console.error('[error-tracker] DB upsert failed:', e.message));
  }

  // Check threshold — fire alert once per window
  if (entry.count === ERROR_ALERT_THRESHOLD && !entry.alerted) {
    entry.alerted = true;
    const alertMsg = `[ALERT] Error "${key}" has fired ${entry.count}+ times in the last hour`;
    console.error(alertMsg);

    // Update alerted_at in DB
    if (_errorPool) {
      _errorPool.query(
        `UPDATE error_logs SET alerted_at = NOW() WHERE error_key = $1`,
        [key]
      ).catch(e => console.error('[error-tracker] alert DB update failed:', e.message));
    }

    // Optional: DM via Slack (requires SLACK_ALERT_USER_ID env var)
    const alertUserId = process.env.SLACK_ALERT_USER_ID;
    if (_errorSlackClient && alertUserId) {
      _errorSlackClient.chat.postMessage({
        channel: alertUserId,
        text: `:rotating_light: *Error alert* — \`${key}\` has fired *${entry.count}+ times* in the last hour. Check server logs.`,
      }).catch(e => console.error('[error-tracker] Slack alert failed:', e.message));
    }
  }
}

// ---------------------------------------------------------------------------
// Error Routes — /health/errors
// ---------------------------------------------------------------------------
function registerErrorRoutes(app, pool) {
  app.get('/health/errors', requireAdminAuth, async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT error_key, message, count, first_seen_at, last_seen_at, alerted_at
        FROM error_logs
        WHERE last_seen_at >= NOW() - INTERVAL '24 hours'
        ORDER BY count DESC
        LIMIT 50
      `);

      const total24h = result.rows.reduce((sum, r) => sum + (parseInt(r.count) || 0), 0);
      const alerted = result.rows.filter(r => r.alerted_at).length;

      res.json({
        period: '24h',
        total_errors: total24h,
        distinct_errors: result.rows.length,
        alerted_errors: alerted,
        errors: result.rows.map(r => ({
          key: r.error_key,
          message: r.message,
          count: parseInt(r.count),
          first_seen_at: r.first_seen_at,
          last_seen_at: r.last_seen_at,
          alerted_at: r.alerted_at || null,
        })),
        generated_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error('[health/errors] query failed:', err.message);
      res.status(500).json({ error: 'Failed to load error stats' });
    }
  });
}

module.exports = { initErrorTracker, trackError, registerErrorRoutes };
