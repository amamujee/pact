// lib/metrics-routes.js
// Owns: internal metrics/analytics dashboard routes (/api/metrics, /metrics HTML page)
// Does NOT own: public analytics, billing, Slack handlers, page routes

'use strict';

const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');

function registerMetricsRoutes(app, pool) {
  app.get('/api/metrics', async (req, res) => {
    try {
      const now = new Date();
      const today7 = new Date(now - 7 * 24 * 60 * 60 * 1000);
      const today30 = new Date(now - 30 * 24 * 60 * 60 * 1000);
      const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const weekStart = new Date(now - 7 * 24 * 60 * 60 * 1000);

      const [
        pactsCreatedTotal,
        pactsCreated7d,
        pactsCreated30d,
        pactsCompletedTotal,
        pactsCompleted7d,
        pactsCompleted30d,
        activePacts,
        overduePacts,
        users7d,
        landingVisitors7d,
        landingVisitors30d,
        totalInstallations,
        orgsWithPacts,
        orgsNeverPacts,
        proSubs,
        subscriptions,
        weeklyRetention,
        lastMonthOrgs,
        firstCompleterOrgs,
        medianTimeToFirstPact,
        medianTimeToFirstCompletion,
        funnelTrend_installs,
        funnelTrend_activations,
        funnelTrend_completions,
        stalledInstalls,
      ] = await Promise.all([
        // Pacts created total
        pool.query(`SELECT COUNT(*) AS count FROM pacts`),
        // Pacts created in last 7d
        pool.query(`SELECT COUNT(*) AS count FROM pacts WHERE created_at >= $1`, [today7]),
        // Pacts created in last 30d
        pool.query(`SELECT COUNT(*) AS count FROM pacts WHERE created_at >= $1`, [today30]),
        // Pacts completed total
        pool.query(`SELECT COUNT(*) AS count FROM pacts WHERE status = 'completed'`),
        // Pacts completed in last 7d
        pool.query(`SELECT COUNT(*) AS count FROM pacts WHERE status = 'completed' AND completed_at >= $1`, [today7]),
        // Pacts completed in last 30d
        pool.query(`SELECT COUNT(*) AS count FROM pacts WHERE status = 'completed' AND completed_at >= $1`, [today30]),
        // Active pacts
        pool.query(`SELECT COUNT(*) AS count FROM pacts WHERE status = 'active'`),
        // Overdue pacts (active + past due)
        pool.query(`SELECT COUNT(*) AS count FROM pacts WHERE status = 'active' AND due_date < NOW()`),
        // Active users in last 7d (distinct slack users who created or completed a pact)
        pool.query(`
          SELECT COUNT(DISTINCT user_id) AS count FROM (
            SELECT creator_slack_id AS user_id FROM pacts WHERE created_at >= $1
            UNION
            SELECT completed_by AS user_id FROM pacts WHERE completed_at >= $1 AND completed_by IS NOT NULL
          ) u
        `, [today7]),
        // Landing page visitors last 7d
        pool.query(`SELECT COUNT(DISTINCT ip_hash) AS count FROM pageviews WHERE path IN ('/', '/index.html') AND created_at >= $1 AND ip_hash IS NOT NULL`, [today7]),
        // Landing page visitors last 30d
        pool.query(`SELECT COUNT(DISTINCT ip_hash) AS count FROM pageviews WHERE path IN ('/', '/index.html') AND created_at >= $1 AND ip_hash IS NOT NULL`, [today30]),
        // Total org installations
        pool.query(`SELECT COUNT(*) AS count FROM installations`),
        // Org installations with at least 1 pact created
        pool.query(`SELECT COUNT(DISTINCT team_id) AS count FROM pacts`),
        // Installed orgs with zero pacts
        pool.query(`
          SELECT COUNT(*) AS count FROM installations i
          WHERE NOT EXISTS (SELECT 1 FROM pacts p WHERE p.team_id = i.team_id)
        `),
        // Pro subscriptions (active)
        pool.query(`SELECT COUNT(*) AS count FROM subscriptions WHERE plan = 'pro' AND status = 'active'`),
        // All active subscriptions (for MRR calculation)
        pool.query(`SELECT plan, status, current_period_end FROM subscriptions WHERE status = 'active'`),
        // Org retention: orgs active this month vs last month
        pool.query(`
          SELECT COUNT(DISTINCT team_id) AS count FROM pacts
          WHERE created_at >= $1 OR completed_at >= $1
        `, [thisMonthStart]),
        // Orgs active last month
        pool.query(`
          SELECT COUNT(DISTINCT team_id) AS count FROM pacts
          WHERE created_at >= $1 AND created_at < $2
        `, [lastMonthStart, thisMonthStart]),
        // Orgs that completed ≥1 pact (first-completion count)
        pool.query(`SELECT COUNT(DISTINCT team_id) AS count FROM pacts WHERE status = 'completed'`),
        // Median minutes from install to first pact
        pool.query(`
          SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (
            ORDER BY EXTRACT(EPOCH FROM (first_pact - install_time)) / 60
          ) AS median_minutes
          FROM (
            SELECT i.team_id, i.created_at AS install_time, MIN(p.created_at) AS first_pact
            FROM installations i
            JOIN pacts p ON p.team_id = i.team_id
            GROUP BY i.team_id, i.created_at
          ) sub
        `),
        // Median minutes from install to first completion
        pool.query(`
          SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (
            ORDER BY EXTRACT(EPOCH FROM (first_completion - install_time)) / 60
          ) AS median_minutes
          FROM (
            SELECT i.team_id, i.created_at AS install_time, MIN(p.completed_at) AS first_completion
            FROM installations i
            JOIN pacts p ON p.team_id = i.team_id AND p.status = 'completed'
            GROUP BY i.team_id, i.created_at
          ) sub
        `),
        // Daily new installs over last 7 days
        pool.query(`
          SELECT DATE(created_at) AS day, COUNT(*) AS count
          FROM installations
          WHERE created_at >= NOW() - INTERVAL '7 days'
          GROUP BY DATE(created_at)
          ORDER BY day ASC
        `),
        // Daily new first-pact activations over last 7 days
        pool.query(`
          SELECT DATE(first_pact_at) AS day, COUNT(*) AS count
          FROM (
            SELECT team_id, MIN(created_at) AS first_pact_at FROM pacts GROUP BY team_id
          ) sub
          WHERE first_pact_at >= NOW() - INTERVAL '7 days'
          GROUP BY DATE(first_pact_at)
          ORDER BY day ASC
        `),
        // Daily new first-completions over last 7 days
        pool.query(`
          SELECT DATE(first_completion_at) AS day, COUNT(*) AS count
          FROM (
            SELECT team_id, MIN(completed_at) AS first_completion_at
            FROM pacts WHERE status = 'completed' GROUP BY team_id
          ) sub
          WHERE first_completion_at >= NOW() - INTERVAL '7 days'
          GROUP BY DATE(first_completion_at)
          ORDER BY day ASC
        `),
        // Stalled installs: installed 48+ hours ago, never created a pact
        pool.query(`
          SELECT i.team_id, i.team_name, i.created_at,
            ROUND(EXTRACT(EPOCH FROM (NOW() - i.created_at)) / 3600) AS hours_since_install
          FROM installations i
          WHERE i.created_at < NOW() - INTERVAL '48 hours'
          AND NOT EXISTS (SELECT 1 FROM pacts p WHERE p.team_id = i.team_id)
          ORDER BY i.created_at DESC
          LIMIT 50
        `),
      ]);

      const createdTotal = parseInt(pactsCreatedTotal.rows[0]?.count || 0);
      const created7d = parseInt(pactsCreated7d.rows[0]?.count || 0);
      const created30d = parseInt(pactsCreated30d.rows[0]?.count || 0);
      const completedTotal = parseInt(pactsCompletedTotal.rows[0]?.count || 0);
      const completed7d = parseInt(pactsCompleted7d.rows[0]?.count || 0);
      const completed30d = parseInt(pactsCompleted30d.rows[0]?.count || 0);
      const activeCount = parseInt(activePacts.rows[0]?.count || 0);
      const overdueCount = parseInt(overduePacts.rows[0]?.count || 0);
      const usersCount = parseInt(users7d.rows[0]?.count || 0);
      const landing7d = parseInt(landingVisitors7d.rows[0]?.count || 0);
      const landing30d = parseInt(landingVisitors30d.rows[0]?.count || 0);
      const totalInstalls = parseInt(totalInstallations.rows[0]?.count || 0);
      const activatedOrgs = parseInt(orgsWithPacts.rows[0]?.count || 0);
      const neverPactOrgs = parseInt(orgsNeverPacts.rows[0]?.count || 0);
      const proCount = parseInt(proSubs.rows[0]?.count || 0);

      // MRR: Pro is $10/mo flat
      const mrr = proCount * 10;

      // Week-over-week org retention
      const thisMonthOrgs = parseInt(weeklyRetention.rows[0]?.count || 0);
      const lastMonthOrgsCount = parseInt(lastMonthOrgs.rows[0]?.count || 0);
      const retentionRate = lastMonthOrgsCount > 0
        ? Math.round((thisMonthOrgs / lastMonthOrgsCount) * 100)
        : null;

      // Drop-off signals
      const installedNeverPactPct = totalInstalls > 0
        ? Math.round((neverPactOrgs / totalInstalls) * 100)
        : 0;
      const overduePct = activeCount > 0
        ? Math.round((overdueCount / activeCount) * 100)
        : 0;

      // Created but never completed: orgs with pacts but no completions
      const [createdNeverCompletedOrgs] = await Promise.all([
        pool.query(`
          SELECT COUNT(DISTINCT p.team_id) AS count
          FROM pacts p
          WHERE NOT EXISTS (
            SELECT 1 FROM pacts c
            WHERE c.team_id = p.team_id AND c.status = 'completed'
          )
        `)
      ]);
      const createdNeverCompleted = parseInt(createdNeverCompletedOrgs.rows[0]?.count || 0);
      const createdNeverCompletedPct = activatedOrgs > 0
        ? Math.round((createdNeverCompleted / activatedOrgs) * 100)
        : 0;

      // Conversion funnel stats
      const firstCompleters = parseInt(firstCompleterOrgs.rows[0]?.count || 0);
      const activationRate = totalInstalls > 0 ? Math.round((activatedOrgs / totalInstalls) * 100) : 0;
      const firstCompletionRate = activatedOrgs > 0 ? Math.round((firstCompleters / activatedOrgs) * 100) : 0;
      const medianMinutesToFirstPact = medianTimeToFirstPact.rows[0]?.median_minutes != null
        ? Math.round(medianTimeToFirstPact.rows[0].median_minutes)
        : null;
      const medianMinutesToFirstCompletion = medianTimeToFirstCompletion.rows[0]?.median_minutes != null
        ? Math.round(medianTimeToFirstCompletion.rows[0].median_minutes)
        : null;

      // Build unified 7-day funnel trend (merge 3 sparse series by day)
      const trendDays = {};
      const last7 = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const key = d.toISOString().substring(0, 10);
        trendDays[key] = { day: key, installs: 0, activations: 0, completions: 0 };
        last7.push(key);
      }
      for (const row of funnelTrend_installs.rows) {
        const k = (row.day instanceof Date ? row.day.toISOString() : String(row.day)).substring(0, 10);
        if (trendDays[k]) trendDays[k].installs = parseInt(row.count || 0);
      }
      for (const row of funnelTrend_activations.rows) {
        const k = (row.day instanceof Date ? row.day.toISOString() : String(row.day)).substring(0, 10);
        if (trendDays[k]) trendDays[k].activations = parseInt(row.count || 0);
      }
      for (const row of funnelTrend_completions.rows) {
        const k = (row.day instanceof Date ? row.day.toISOString() : String(row.day)).substring(0, 10);
        if (trendDays[k]) trendDays[k].completions = parseInt(row.count || 0);
      }
      const funnelTrend = last7.map(k => trendDays[k]);

      // Stalled installs list
      const stalledList = stalledInstalls.rows.map(r => ({
        team_id: r.team_id,
        team_name: r.team_name,
        installed_at: r.created_at,
        hours_since_install: parseInt(r.hours_since_install || 0),
      }));

      res.json({
        // North star
        pacts_created: {
          total: createdTotal,
          trailing_7d: created7d,
          trailing_30d: created30d,
        },
        pacts_completed: {
          total: completedTotal,
          trailing_7d: completed7d,
          trailing_30d: completed30d,
        },
        completion_rate: createdTotal > 0 ? Math.round((completedTotal / createdTotal) * 100) : 0,

        // Funnel
        landing_visitors: {
          trailing_7d: landing7d,
          trailing_30d: landing30d,
        },
        total_installations: totalInstalls,
        activated_orgs: activatedOrgs,
        active_users_7d: usersCount,
        week_over_week_retention: retentionRate,
        pro_subscribers: proCount,
        mrr: mrr,

        // Drop-off signals
        installed_never_created_pact: { count: neverPactOrgs, pct: installedNeverPactPct },
        created_never_completed: { count: createdNeverCompleted, pct: createdNeverCompletedPct },
        overdue_pacts: { count: overdueCount, pct: overduePct },

        // Active pacts
        active_pacts: activeCount,
        overdue_pacts_count: overdueCount,

        // Conversion funnel
        conversion_funnel: {
          installs: totalInstalls,
          activated: activatedOrgs,
          activation_rate: activationRate,
          first_completers: firstCompleters,
          first_completion_rate: firstCompletionRate,
          median_minutes_to_first_pact: medianMinutesToFirstPact,
          median_minutes_to_first_completion: medianMinutesToFirstCompletion,
        },
        funnel_trend_7d: funnelTrend,
        stalled_installs: stalledList,

        generated_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error('[metrics] error:', err.message);
      res.status(500).json({ error: 'Failed to load metrics' });
    }
  });

  // GET /api/metrics/daily — daily time-series for pact creation/completion
  app.get('/api/metrics/daily', async (req, res) => {
    try {
      const days = parseInt(req.query.days) || 30;
      const since = `NOW() - INTERVAL '${Math.min(days, 90)} days'`;

      const result = await pool.query(`
        SELECT
          DATE(created_at) AS day,
          COUNT(*) FILTER (WHERE status = 'created') AS created,
          COUNT(*) FILTER (WHERE status = 'completed') AS completed,
          COUNT(*) FILTER (WHERE status = 'active') AS active
        FROM pacts
        WHERE created_at >= ${since}
        GROUP BY DATE(created_at)
        ORDER BY day ASC
      `);

      res.json({
        days: result.rows.map(r => ({
          day: r.day,
          created: parseInt(r.created || 0),
          completed: parseInt(r.completed || 0),
          active: parseInt(r.active || 0),
        })),
      });
    } catch (err) {
      console.error('[metrics/daily] error:', err.message);
      res.status(500).json({ error: 'Failed to load daily metrics' });
    }
  });

  // GET /dashboard — HTML analytics dashboard
  app.get('/dashboard', (req, res) => {
    // Serve the static dashboard.html — funnel math and visual overhaul live there
    res.sendFile('dashboard.html', { root: path.join(PROJECT_ROOT, 'public') });
  });

  /* ── DEAD: legacy inline dashboard removed (was ~330 lines of template literal).
     The static public/dashboard.html is now the single source of truth.
     Old code calculated funnel percentages against total installs (all bars ≈ same height).
     New dashboard.html calculates step-over-step: each stage % = count / previous_stage_count. ── */
  if (false) { /* eslint-disable */
  const __legacyDashboardStub = `<!DOCTYPE html>
<html lang=\"en\">
<head>
  <meta charset=\"UTF-8\">
  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">
  <title>Pact Analytics</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0d1117; color: #e6edf3; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 32px 24px; }
    h1 { font-size: 22px; font-weight: 600; margin-bottom: 4px; color: #fff; }
    .subtitle { color: #7d8590; font-size: 13px; margin-bottom: 28px; }
    .refresh-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 28px; }
    .refresh-label { font-size: 12px; color: #7d8590; }
    .refresh-label span { color: #3fb950; }
    section { margin-bottom: 36px; }
    .section-title { font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #7d8590; margin-bottom: 12px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; }
    .card-label { font-size: 12px; color: #7d8590; margin-bottom: 6px; }
    .card-value { font-size: 28px; font-weight: 700; color: #fff; }
    .card-value.sm { font-size: 20px; }
    .card-sub { font-size: 11px; color: #7d8590; margin-top: 4px; }
    .card-sub .pct { color: #58a6ff; }
    .card-sub .pct.warn { color: #d29922; }
    .card-sub .pct.danger { color: #f85149; }
    .card-sub .pct.good { color: #3fb950; }
    .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; }
    .status-dot.good { background: #3fb950; }
    .status-dot.warn { background: #d29922; }
    .status-dot.danger { background: #f85149; }
    .error-state { background: #2d1117; border: 1px solid #f85149; border-radius: 8px; padding: 24px; text-align: center; color: #f85149; }
    .loading { color: #7d8590; text-align: center; padding: 24px; }
    @media (max-width: 600px) { .grid { grid-template-columns: 1fr 1fr; } }
    /* Funnel waterfall */
    .funnel { display: flex; flex-direction: column; gap: 0; background: #161b22; border: 1px solid #30363d; border-radius: 8px; overflow: hidden; }
    .funnel-step { display: flex; align-items: center; gap: 16px; padding: 14px 20px; border-bottom: 1px solid #21262d; position: relative; }
    .funnel-step:last-child { border-bottom: none; }
    .funnel-bar-wrap { flex: 1; height: 8px; background: #21262d; border-radius: 4px; overflow: hidden; }
    .funnel-bar { height: 100%; border-radius: 4px; transition: width 0.4s ease; }
    .funnel-bar.install { background: #58a6ff; }
    .funnel-bar.activate { background: #3fb950; }
    .funnel-bar.complete { background: #d29922; }
    .funnel-label { font-size: 13px; color: #e6edf3; min-width: 130px; }
    .funnel-count { font-size: 20px; font-weight: 700; color: #fff; min-width: 48px; text-align: right; }
    .funnel-pct { font-size: 12px; color: #7d8590; min-width: 64px; text-align: right; }
    .funnel-drop { font-size: 11px; color: #f85149; text-align: center; padding: 4px 20px; background: #1a0a0a; }
    /* Trend mini chart */
    .trend-wrap { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; overflow-x: auto; }
    .trend-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .trend-table th { color: #7d8590; font-weight: 500; text-align: left; padding: 4px 8px; border-bottom: 1px solid #21262d; }
    .trend-table td { padding: 5px 8px; color: #e6edf3; border-bottom: 1px solid #21262d; }
    .trend-table tr:last-child td { border-bottom: none; }
    .trend-table .num { text-align: right; font-variant-numeric: tabular-nums; }
    .trend-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; }
    .trend-dot.i { background: #58a6ff; }
    .trend-dot.a { background: #3fb950; }
    .trend-dot.c { background: #d29922; }
    /* Stalled installs table */
    .stalled-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .stalled-table th { color: #7d8590; font-weight: 500; text-align: left; padding: 6px 12px; border-bottom: 1px solid #21262d; }
    .stalled-table td { padding: 7px 12px; color: #e6edf3; border-bottom: 1px solid #21262d; }
    .stalled-table tr:last-child td { border-bottom: none; }
    .stalled-table .hours { color: #f85149; font-weight: 600; }
    .stalled-empty { color: #7d8590; padding: 16px; font-size: 13px; }
  </style>
</head>
<body>
  <div class=\"refresh-bar\">
    <div>
      <h1>Pact Analytics</h1>
      <div class=\"subtitle\">Business metrics — updates every 60s</div>
    </div>
    <div class=\"refresh-label\">Auto-refresh: <span id=\"countdown\">60</span>s</div>
  </div>

  <div id=\"loading\" class=\"loading\">Loading metrics…</div>
  <div id=\"error\" style=\"display:none\"></div>
  <div id=\"content\" style=\"display:none\"></div>

  <script>
    let countdown = 60;
    const countdownEl = document.getElementById('countdown');
    const loadingEl = document.getElementById('loading');
    const errorEl = document.getElementById('error');
    const contentEl = document.getElementById('content');

    function pctClass(pct, warnThreshold, dangerThreshold) {
      if (pct === null || pct === undefined) return '';
      if (pct >= dangerThreshold) return 'danger';
      if (pct >= warnThreshold) return 'warn';
      return 'good';
    }

    function fmtDuration(minutes) {
      if (minutes === null || minutes === undefined) return '—';
      if (minutes < 60) return minutes + 'm';
      if (minutes < 1440) return Math.round(minutes / 60) + 'h';
      return Math.round(minutes / 1440) + 'd';
    }

    function renderFunnel(m) {
      const cf = m.conversion_funnel;
      if (!cf) return '<div class="stalled-empty">No funnel data.</div>';
      const installs = cf.installs;
      const activated = cf.activated;
      const completers = cf.first_completers;
      const activationPct = cf.activation_rate;
      const completionPct = cf.first_completion_rate;
      const installBar = 100;
      const activateBar = installs > 0 ? Math.round((activated / installs) * 100) : 0;
      const completeBar = installs > 0 ? Math.round((completers / installs) * 100) : 0;
      const dropToActivate = installs > 0 ? (100 - activationPct) : null;
      const dropToComplete = activated > 0 ? Math.round(((activated - completers) / activated) * 100) : null;
      const medianPact = fmtDuration(cf.median_minutes_to_first_pact);
      const medianCompletion = fmtDuration(cf.median_minutes_to_first_completion);
      return '<div class="funnel">' +
        '<div class="funnel-step">' +
          '<div class="funnel-label"><span class="trend-dot i"></span>Installs</div>' +
          '<div class="funnel-bar-wrap"><div class="funnel-bar install" style="width:' + installBar + '%"></div></div>' +
          '<div class="funnel-count">' + installs + '</div>' +
          '<div class="funnel-pct" style="color:#58a6ff">100%</div>' +
        '</div>' +
        (dropToActivate !== null ? '<div class="funnel-drop">▼ ' + dropToActivate + '% drop-off</div>' : '') +
        '<div class="funnel-step">' +
          '<div class="funnel-label"><span class="trend-dot a"></span>Activated (≥1 pact)</div>' +
          '<div class="funnel-bar-wrap"><div class="funnel-bar activate" style="width:' + activateBar + '%"></div></div>' +
          '<div class="funnel-count">' + activated + '</div>' +
          '<div class="funnel-pct" style="color:#3fb950">' + activationPct + '%</div>' +
        '</div>' +
        (dropToComplete !== null ? '<div class="funnel-drop">▼ ' + dropToComplete + '% drop-off</div>' : '') +
        '<div class="funnel-step">' +
          '<div class="funnel-label"><span class="trend-dot c"></span>First Completion</div>' +
          '<div class="funnel-bar-wrap"><div class="funnel-bar complete" style="width:' + completeBar + '%"></div></div>' +
          '<div class="funnel-count">' + completers + '</div>' +
          '<div class="funnel-pct" style="color:#d29922">' + completionPct + '%</div>' +
        '</div>' +
      '</div>' +
      '<div class="grid" style="margin-top:12px">' +
        '<div class="card"><div class="card-label">Median → First Pact</div><div class="card-value sm">' + medianPact + '</div><div class="card-sub">From install to first pact created</div></div>' +
        '<div class="card"><div class="card-label">Median → First Completion</div><div class="card-value sm">' + medianCompletion + '</div><div class="card-sub">From install to first pact done</div></div>' +
      '</div>';
    }

    function renderFunnelTrend(m) {
      const trend = m.funnel_trend_7d;
      if (!trend || trend.length === 0) return '<div class="stalled-empty">No trend data yet.</div>';
      const rows = trend.map(d => {
        const dayLabel = new Date(d.day + 'T12:00:00Z').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
        return '<tr><td>' + dayLabel + '</td>' +
          '<td class="num"><span class="trend-dot i"></span>' + (d.installs || 0) + '</td>' +
          '<td class="num"><span class="trend-dot a"></span>' + (d.activations || 0) + '</td>' +
          '<td class="num"><span class="trend-dot c"></span>' + (d.completions || 0) + '</td>' +
          '</tr>';
      }).join('');
      return '<div class="trend-wrap"><table class="trend-table"><thead><tr>' +
        '<th>Day</th>' +
        '<th class="num"><span class="trend-dot i"></span>Installs</th>' +
        '<th class="num"><span class="trend-dot a"></span>Activations</th>' +
        '<th class="num"><span class="trend-dot c"></span>First Completions</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table></div>';
    }

    function renderStalledInstalls(m) {
      const list = m.stalled_installs;
      if (!list || list.length === 0) return '<div class="stalled-empty">✓ No stalled installs — all workspaces have created a pact within 48h.</div>';
      const rows = list.map(s => {
        const installedDate = new Date(s.installed_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        const hoursClass = s.hours_since_install >= 168 ? 'danger' : s.hours_since_install >= 72 ? 'warn' : '';
        return '<tr><td>' + (s.team_name || s.team_id) + '</td>' +
          '<td>' + installedDate + '</td>' +
          '<td class="hours ' + hoursClass + '">' + s.hours_since_install + 'h ago</td>' +
          '</tr>';
      }).join('');
      return '<div style="background:#161b22;border:1px solid #30363d;border-radius:8px;overflow:hidden">' +
        '<table class="stalled-table"><thead><tr>' +
        '<th>Workspace</th><th>Installed</th><th>Stalled For</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
        '<div style="font-size:11px;color:#7d8590;margin-top:8px">' + list.length + ' workspace' + (list.length !== 1 ? 's' : '') + ' installed but never started</div>';
    }

    function renderMetrics(m) {
      const cr = m.completion_rate;
      const crClass = pctClass(cr, 60, 40);

      const overPct = m.overdue_pacts?.pct;
      const overClass = pctClass(overPct, 20, 40);

      const installNeverPct = m.installed_never_created_pact?.pct;
      const installNeverClass = pctClass(installNeverPct, 50, 75);

      const createdNeverPct = m.created_never_completed?.pct;
      const createdNeverClass = pctClass(createdNeverPct, 50, 75);

      contentEl.innerHTML = \"
        <section>
          <div class=\"section-title\">North Star</div>
          <div class=\"grid\">
            <div class=\"card\">
              <div class=\"card-label\">Pacts Created (Total)</div>
              <div class=\"card-value\">\" + m.pacts_created.total + \"</div>
              <div class=\"card-sub\">\" + m.pacts_created.trailing_7d + \" in last 7d &nbsp;|&nbsp; \" + m.pacts_created.trailing_30d + \" in last 30d</div>
            </div>
            <div class=\"card\">
              <div class=\"card-label\">Pacts Completed (Total)</div>
              <div class=\"card-value\">\" + m.pacts_completed.total + \"</div>
              <div class=\"card-sub\">\" + m.pacts_completed.trailing_7d + \" in last 7d &nbsp;|&nbsp; \" + m.pacts_completed.trailing_30d + \" in last 30d</div>
            </div>
            <div class=\"card\">
              <div class=\"card-label\">Completion Rate</div>
              <div class=\"card-value\">\" + (cr !== null ? cr + '%' : '—') + \"</div>
              <div class=\"card-sub\"><span class=\"status-dot \" + (cr !== null && cr >= 40 ? 'good' : 'warn') + \"\"></span>\" + (cr !== null && cr >= 40 ? 'Healthy' : cr !== null && cr >= 20 ? 'Needs attention' : 'Critical') + \"</div>
            </div>
          </div>
        </section>

        <section>
          <div class=\"section-title\">Funnel</div>
          <div class=\"grid\">
            <div class=\"card\">
              <div class=\"card-label\">Landing Visitors (7d)</div>
              <div class=\"card-value sm\">\" + m.landing_visitors.trailing_7d + \"</div>
              <div class=\"card-sub\">\" + m.landing_visitors.trailing_30d + \" in last 30d</div>
            </div>
            <div class=\"card\">
              <div class=\"card-label\">Total Installations</div>
              <div class=\"card-value sm\">\" + m.total_installations + \"</div>
              <div class=\"card-sub\">Total org installs</div>
            </div>
            <div class=\"card\">
              <div class=\"card-label\">Activated Orgs</div>
              <div class=\"card-value sm\">\" + m.activated_orgs + \"</div>
              <div class=\"card-sub\">Orgs that created &ge;1 pact</div>
            </div>
            <div class=\"card\">
              <div class=\"card-label\">Active Users (7d)</div>
              <div class=\"card-value sm\">\" + m.active_users_7d + \"</div>
              <div class=\"card-sub\">Distinct users active in last 7 days</div>
            </div>
            <div class=\"card\">
              <div class=\"card-label\">WoW Retention</div>
              <div class=\"card-value sm\">\" + (m.week_over_week_retention !== null ? m.week_over_week_retention + '%' : '—') + \"</div>
              <div class=\"card-sub\">Orgs active this vs last month</div>
            </div>
            <div class=\"card\">
              <div class=\"card-label\">Pro Subscribers</div>
              <div class=\"card-value sm\">\" + m.pro_subscribers + \"</div>
              <div class=\"card-sub\">MRR: $\" + m.mrr + \"</div>
            </div>
          </div>
        </section>

        <section>
          <div class=\"section-title\">Drop-off Signals</div>
          <div class=\"grid\">
            <div class=\"card\">
              <div class=\"card-label\">Installed, Never Created Pact</div>
              <div class=\"card-value sm\">\" + m.installed_never_created_pact.count + \"</div>
              <div class=\"card-sub\"><span class=\"pct \" + installNeverClass + \">\" + m.installed_never_created_pact.pct + \"% of installs</span> — need activation</div>
            </div>
            <div class=\"card\">
              <div class=\"card-label\">Created, Never Completed</div>
              <div class=\"card-value sm\">\" + m.created_never_completed.count + \"</div>
              <div class=\"card-sub\"><span class=\"pct \" + createdNeverClass + \">\" + m.created_never_completed.pct + \"% of activated orgs</span> — conversion gap</div>
            </div>
            <div class=\"card\">
              <div class=\"card-label\">Active Pacts</div>
              <div class=\"card-value sm\">\" + m.active_pacts + \"</div>
              <div class=\"card-sub\">\" + m.overdue_pacts_count + \" overdue (<span class=\"pct \" + overClass + \">\" + overPct + \"%</span>)</div>
            </div>
          </div>
        </section>

        <section>
          <div class=\"section-title\">Conversion Funnel</div>
          \" + renderFunnel(m) + \"
        </section>

        <section>
          <div class=\"section-title\">7-Day Funnel Trend</div>
          \" + renderFunnelTrend(m) + \"
        </section>

        <section>
          <div class=\"section-title\">Stalled Installs <span style='font-size:11px;color:#7d8590;font-weight:400;text-transform:none;letter-spacing:0'>(installed 48h+ ago, no pact)</span></div>
          \" + renderStalledInstalls(m) + \"
        </section>

        <section>
          <div class=\"section-title\">Data</div>
          <div class=\"card\" style=\"max-width:400px\">
            <div class=\"card-sub\">Generated at \" + new Date(m.generated_at).toLocaleString() + \"</div>
          </div>
        </section>
      \";
    }

    async function load() {
      try {
        const r = await fetch('/api/metrics');
        if (!r.ok) throw new Error('API returned ' + r.status);
        const data = await r.json();
        loadingEl.style.display = 'none';
        contentEl.style.display = 'block';
        renderMetrics(data);
      } catch (err) {
        loadingEl.style.display = 'none';
        errorEl.style.display = 'block';
        errorEl.innerHTML = '<div class=\"error-state\">Failed to load metrics: ' + err.message + '</div>';
      }
    }

    function tick() {
      countdown--;
      countdownEl.textContent = countdown;
      if (countdown <= 0) {
        countdown = 60;
        load();
      }
    }

    setInterval(tick, 1000);
    load();
  </script>
</body>
</html>`;
  } /* end dead legacy dashboard */
}

module.exports = { registerMetricsRoutes };
