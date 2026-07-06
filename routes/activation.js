// routes/activation.js
// Owns: admin funnel dashboard at /admin/activation (HTML) + /admin/activation-funnel (JSON API).
// Does NOT own: sending DMs, pact creation, or Slack action handlers.

'use strict';

const express = require('express');
const { getActivationFunnel, getActivationTotals } = require('../db/user-activation');
const { getInviteFunnelTotals } = require('../db/invites');

const router = express.Router();

// Simple admin secret via env var — avoids adding an auth dependency
function isAuthorized(req) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return true; // open if not configured
  return req.query.secret === secret || req.headers['x-admin-secret'] === secret;
}

router.get('/', async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).send('Unauthorized');
  }

  try {
    const [funnel, totals, inviteTotals] = await Promise.all([
      getActivationFunnel(30),
      getActivationTotals(),
      getInviteFunnelTotals(),
    ]);

    const attempted = totals.total_dms_attempted || 0;
    const delivered = totals.total_dms_sent || 0;
    const failed = totals.total_dms_failed || 0;
    const clicks = totals.total_clicks || 0;
    const conversions = totals.total_conversions || 0;
    const inviteSent = parseInt(inviteTotals.invite_sent_count || 0, 10);
    const inviteClaimed = parseInt(inviteTotals.invite_claimed_count || 0, 10);
    const proGranted = parseInt(inviteTotals.pro_granted_count || 0, 10);

    const deliveryRate = attempted > 0 ? Math.round((delivered / attempted) * 100) : 0;
    const clickRate = delivered > 0 ? Math.round((clicks / delivered) * 100) : 0;
    const conversionRate = delivered > 0 ? Math.round((conversions / delivered) * 100) : 0;

    const rows = funnel.map((row) => {
      const dmAttemptRate = row.new_installs > 0 ? Math.round((row.dms_attempted / row.new_installs) * 100) : '-';
      const deliveryRate = row.dms_attempted > 0 ? Math.round((row.dms_sent / row.dms_attempted) * 100) : '-';
      const clickRate = row.dms_sent > 0 ? Math.round((row.dm_clicks / row.dms_sent) * 100) : '-';
      const pactRate = row.dms_sent > 0 ? Math.round((row.pacts_created / row.dms_sent) * 100) : '-';
      const day = new Date(row.day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      return `
        <tr>
          <td>${day}</td>
          <td>${row.new_installs}</td>
          <td>${row.dms_attempted}</td>
          <td>
            <span style="color:${row.dms_failed > 0 ? '#f87171' : 'inherit'}">${row.dms_sent}</span>
            ${row.dms_failed > 0 ? `<span style="color:#f87171;font-size:11px"> (${row.dms_failed} failed)</span>` : ''}
          </td>
          <td>${clickRate}${clickRate !== '-' ? '%' : ''}</td>
          <td>${pactRate}${pactRate !== '-' ? '%' : ''}</td>
        </tr>`;
    }).join('');

    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Activation Funnel — Pact Admin</title>
  <style>
    body { font-family: -apple-system, sans-serif; background: #0f0f0f; color: #e5e5e5; margin: 0; padding: 24px; }
    h1 { font-size: 20px; font-weight: 600; margin-bottom: 4px; }
    .subtitle { color: #888; font-size: 14px; margin-bottom: 32px; }
    .summary { display: flex; gap: 16px; margin-bottom: 32px; flex-wrap: wrap; }
    .stat { background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 14px 20px; min-width: 130px; }
    .stat-label { font-size: 11px; color: #888; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
    .stat-value { font-size: 26px; font-weight: 700; color: #fff; }
    .stat-sub { font-size: 12px; color: #f59e0b; margin-top: 2px; }
    .stat-sub.red { color: #f87171; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th { text-align: left; padding: 10px 12px; background: #1a1a1a; color: #888; font-weight: 500; border-bottom: 1px solid #333; }
    td { padding: 10px 12px; border-bottom: 1px solid #1f1f1f; }
    tr:hover td { background: #1a1a1a; }
    .section-title { font-size: 14px; font-weight: 600; margin-bottom: 12px; margin-top: 28px; }
    .updated { font-size: 12px; color: #555; margin-top: 32px; }
  </style>
</head>
<body>
  <h1>Activation Funnel</h1>
  <p class="subtitle">Install → 24h DM → First Pact · Last 30 days · Updated ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })} UTC</p>

  <div class="summary">
    <div class="stat">
      <div class="stat-label">DM Attempted</div>
      <div class="stat-value">${attempted}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Delivered</div>
      <div class="stat-value">${delivered}</div>
      <div class="stat-sub">${deliveryRate}% delivery rate</div>
    </div>
    <div class="stat">
      <div class="stat-label">Failed</div>
      <div class="stat-value" style="color:${failed > 0 ? '#f87171' : '#fff'}">${failed}</div>
      ${failed > 0 ? '<div class="stat-sub red">API errors — check logs</div>' : ''}
    </div>
    <div class="stat">
      <div class="stat-label">Clicked</div>
      <div class="stat-value">${clickRate}%</div>
      <div class="stat-sub">${clicks} clicks</div>
    </div>
    <div class="stat">
      <div class="stat-label">Converted</div>
      <div class="stat-value">${conversionRate}%</div>
      <div class="stat-sub">${conversions} pacts from DM</div>
    </div>
  </div>

  <div class="section-title">Invite Loop</div>
  <div class="summary">
    <div class="stat">
      <div class="stat-label">Links Sent</div>
      <div class="stat-value">${inviteSent}</div>
      <div class="stat-sub">invite links created</div>
    </div>
    <div class="stat">
      <div class="stat-label">Claimed</div>
      <div class="stat-value">${inviteClaimed}</div>
      <div class="stat-sub">${inviteSent > 0 ? Math.round((inviteClaimed / inviteSent) * 100) : 0}% claim rate</div>
    </div>
    <div class="stat">
      <div class="stat-label">Pro Granted</div>
      <div class="stat-value" style="color:${proGranted > 0 ? '#4ade80' : '#fff'}">${proGranted}</div>
      <div class="stat-sub">30-day grants earned</div>
    </div>
  </div>

  <div class="section-title">Daily Breakdown</div>
  <table>
    <thead>
      <tr>
        <th>Day</th>
        <th>Installs</th>
        <th>Attempted</th>
        <th>Delivered (Failed)</th>
        <th>Click Rate</th>
        <th>Pact Created</th>
      </tr>
    </thead>
    <tbody>${rows || '<tr><td colspan="6" style="color:#888;padding:20px">No data yet — run activation cron to populate</td></tr>'}</tbody>
  </table>
</body>
</html>`);
  } catch (err) {
    console.error('[ADMIN/ACTIVATION] Route error:', err.message);
    res.status(500).send('Internal error: ' + err.message);
  }
});

// JSON funnel endpoint — returns 7-day rollup for programmatic consumption.
// Auth-gated same as HTML dashboard (ADMIN_SECRET env var or x-admin-secret header).
router.get('/funnel', async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const [funnel, totals, inviteTotals] = await Promise.all([
      getActivationFunnel(7),
      getActivationTotals(),
      getInviteFunnelTotals(),
    ]);

    const attempted = parseInt(totals.total_dms_attempted, 10) || 0;
    const delivered = parseInt(totals.total_dms_sent, 10) || 0;
    const failed = parseInt(totals.total_dms_failed, 10) || 0;
    const clicks = parseInt(totals.total_clicks, 10) || 0;
    const conversions = parseInt(totals.total_conversions, 10) || 0;
    const inviteSent = parseInt(inviteTotals.invite_sent_count || 0, 10);
    const inviteClaimed = parseInt(inviteTotals.invite_claimed_count || 0, 10);
    const proGranted = parseInt(inviteTotals.pro_granted_count || 0, 10);

    const deliveryRate = attempted > 0 ? +((delivered / attempted) * 100).toFixed(1) : null;
    const clickRate = delivered > 0 ? +((clicks / delivered) * 100).toFixed(1) : null;
    const pactCreationRate = delivered > 0 ? +((conversions / delivered) * 100).toFixed(1) : null;
    const inviteClaimRate = inviteSent > 0 ? +((inviteClaimed / inviteSent) * 100).toFixed(1) : null;

    res.json({
      window: '7d',
      generated_at: new Date().toISOString(),
      totals_all_time: {
        dms_attempted: attempted,
        dms_delivered: delivered,
        dms_failed: failed,
        clicks,
        pacts_created: conversions,
      },
      rates_all_time: {
        delivery_pct: deliveryRate,
        click_pct: clickRate,
        pact_creation_pct: pactCreationRate,
      },
      invite_loop: {
        invite_sent_count: inviteSent,
        invite_claimed_count: inviteClaimed,
        pro_granted_count: proGranted,
        claim_rate_pct: inviteClaimRate,
      },
      daily: funnel.map((row) => ({
        day: row.day,
        new_installs: parseInt(row.new_installs, 10) || 0,
        dms_attempted: parseInt(row.dms_attempted, 10) || 0,
        dms_delivered: parseInt(row.dms_sent, 10) || 0,
        dms_failed: parseInt(row.dms_failed, 10) || 0,
        clicks: parseInt(row.dm_clicks, 10) || 0,
        pacts_created: parseInt(row.pacts_created, 10) || 0,
      })),
    });
  } catch (err) {
    console.error('[ADMIN/ACTIVATION-FUNNEL] Route error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
