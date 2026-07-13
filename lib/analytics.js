// lib/analytics.js
// Owns: IP hashing, UTM extraction, pageview tracking middleware, analytics API routes.
// Does NOT own: error tracking, contact form handling, Slack handlers, or any domain logic.

const crypto = require('crypto');
const express = require('express');
const { requireAdminAuth } = require('./admin-auth');

function hashIP(ip) {
  const salt = process.env.ANALYTICS_IP_SALT?.trim();
  if (!ip || !salt) return null;
  return crypto.createHmac('sha256', salt).update(ip).digest('hex').substring(0, 16);
}

function getClientIP(req) {
  // Vercel and other reverse proxies set x-forwarded-for.
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || null;
}

function extractUTM(query) {
  return {
    utm_source: query.utm_source || query.ref || null,
    utm_medium: query.utm_medium || null,
    utm_campaign: query.utm_campaign || null,
  };
}

// Skip tracking for static assets and API calls
const SKIP_EXTENSIONS = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|map|json)$/i;
const SKIP_PREFIXES = ['/api/', '/health', '/slack/'];

function shouldTrackPageview(reqPath) {
  if (SKIP_EXTENSIONS.test(reqPath)) return false;
  for (const prefix of SKIP_PREFIXES) {
    if (reqPath.startsWith(prefix)) return false;
  }
  return true;
}

// Non-blocking pageview insert
function recordPageview(pool, data) {
  pool.query(
    `INSERT INTO pageviews (path, referrer, utm_source, utm_medium, utm_campaign, user_agent, ip_hash, session_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [data.path, data.referrer, data.utm_source, data.utm_medium, data.utm_campaign, data.user_agent, data.ip_hash, data.session_id]
  ).catch(err => console.error('Pageview tracking error:', err.message));
}

// Pageview tracking middleware
function pageviewMiddleware(pool) {
  return (req, res, next) => {
    if (req.method === 'GET' && shouldTrackPageview(req.path)) {
      const utm = extractUTM(req.query);
      recordPageview(pool, {
        path: req.path,
        referrer: req.headers['referer'] || req.headers['referrer'] || null,
        utm_source: utm.utm_source,
        utm_medium: utm.utm_medium,
        utm_campaign: utm.utm_campaign,
        user_agent: (req.headers['user-agent'] || '').substring(0, 512),
        ip_hash: hashIP(getClientIP(req)),
        session_id: req.query.sid || null,
      });
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// Analytics API Routes
// ---------------------------------------------------------------------------
function registerAnalyticsRoutes(app, pool) {
  // JSON body parsing for events endpoint
  app.use('/api/events', express.json());

  // POST /api/events — track custom events
  app.post('/api/events', async (req, res) => {
    try {
      const { event_type, metadata, session_id } = req.body || {};

      if (!event_type || typeof event_type !== 'string') {
        return res.status(400).json({ error: 'event_type is required' });
      }

      // Sanitize event_type: lowercase, alphanumeric + underscores, max 255 chars
      const cleanType = event_type.toLowerCase().replace(/[^a-z0-9_]/g, '_').substring(0, 255);
      const utm = extractUTM(req.query);
      const ipHash = hashIP(getClientIP(req));

      await pool.query(
        `INSERT INTO events (event_type, metadata, session_id, ip_hash, referrer, utm_source, utm_medium, utm_campaign)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          cleanType,
          JSON.stringify(metadata || {}),
          session_id || null,
          ipHash,
          req.headers['referer'] || null,
          utm.utm_source,
          utm.utm_medium,
          utm.utm_campaign,
        ]
      );

      res.status(201).json({ ok: true, event_type: cleanType });
    } catch (err) {
      console.error('Event tracking error:', err.message);
      res.status(500).json({ error: 'Failed to track event' });
    }
  });

  // GET /api/analytics — dashboard summary
  app.get('/api/analytics', requireAdminAuth, async (req, res) => {
    try {
      const days = parseInt(req.query.days) || 7;
      const safeDays = Math.min(Math.max(days, 1), 90);
      const since = `NOW() - INTERVAL '${safeDays} days'`;

      // Run all queries in parallel
      const [
        pvCountResult,
        uniqueVisitorsResult,
        topPagesResult,
        topReferrersResult,
        topEventsResult,
        dailyPvResult,
        utmSourcesResult,
      ] = await Promise.all([
        // Total pageviews
        pool.query(`SELECT COUNT(*) AS total FROM pageviews WHERE created_at >= ${since}`),
        // Unique visitors (by ip_hash)
        pool.query(`SELECT COUNT(DISTINCT ip_hash) AS unique_visitors FROM pageviews WHERE created_at >= ${since} AND ip_hash IS NOT NULL`),
        // Top pages
        pool.query(`
          SELECT path, COUNT(*) AS views
          FROM pageviews
          WHERE created_at >= ${since}
          GROUP BY path
          ORDER BY views DESC
          LIMIT 20
        `),
        // Top referrers (excluding empty/null)
        pool.query(`
          SELECT referrer, COUNT(*) AS count
          FROM pageviews
          WHERE created_at >= ${since} AND referrer IS NOT NULL AND referrer != ''
          GROUP BY referrer
          ORDER BY count DESC
          LIMIT 20
        `),
        // Top events
        pool.query(`
          SELECT event_type, COUNT(*) AS count
          FROM events
          WHERE created_at >= ${since}
          GROUP BY event_type
          ORDER BY count DESC
          LIMIT 20
        `),
        // Daily pageview trend
        pool.query(`
          SELECT DATE(created_at) AS day, COUNT(*) AS views, COUNT(DISTINCT ip_hash) AS unique_visitors
          FROM pageviews
          WHERE created_at >= ${since}
          GROUP BY DATE(created_at)
          ORDER BY day ASC
        `),
        // UTM sources breakdown
        pool.query(`
          SELECT utm_source, utm_medium, utm_campaign, COUNT(*) AS count
          FROM pageviews
          WHERE created_at >= ${since} AND utm_source IS NOT NULL
          GROUP BY utm_source, utm_medium, utm_campaign
          ORDER BY count DESC
          LIMIT 20
        `),
      ]);

      res.json({
        period_days: safeDays,
        total_pageviews: parseInt(pvCountResult.rows[0].total),
        unique_visitors: parseInt(uniqueVisitorsResult.rows[0].unique_visitors),
        top_pages: topPagesResult.rows.map(r => ({ path: r.path, views: parseInt(r.views) })),
        top_referrers: topReferrersResult.rows.map(r => ({ referrer: r.referrer, count: parseInt(r.count) })),
        top_events: topEventsResult.rows.map(r => ({ event_type: r.event_type, count: parseInt(r.count) })),
        daily_trend: dailyPvResult.rows.map(r => ({
          day: r.day,
          views: parseInt(r.views),
          unique_visitors: parseInt(r.unique_visitors),
        })),
        utm_sources: utmSourcesResult.rows.map(r => ({
          source: r.utm_source,
          medium: r.utm_medium,
          campaign: r.utm_campaign,
          count: parseInt(r.count),
        })),
      });
    } catch (err) {
      console.error('Analytics query error:', err.message);
      res.status(500).json({ error: 'Failed to load analytics' });
    }
  });
}

module.exports = {
  hashIP,
  getClientIP,
  extractUTM,
  SKIP_EXTENSIONS,
  SKIP_PREFIXES,
  shouldTrackPageview,
  recordPageview,
  pageviewMiddleware,
  registerAnalyticsRoutes,
};
