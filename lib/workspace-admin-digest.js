/**
 * Workspace admin digest — callable from server.js startup or HTTP trigger.
 * Standalone version lives in scripts/workspace-admin-digest.js for manual runs.
 * Production invokes this function through the protected Vercel cron endpoint.
 */

const digestDb = require('../db/workspace-admin-digest');
const { sendEmail: sendProviderEmail } = require('./email-client');
const { getAppUrl } = require('./app-url');

function isDigestDue(row) {
  const tz = 'UTC';
  const now = new Date();

  let localDay, localHour;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      hour: 'numeric',
      hour12: false,
    }).formatToParts(now);

    const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dayStr = parts.find(p => p.type === 'weekday')?.value;
    localDay = weekdays.indexOf(dayStr);

    const hourStr = parts.find(p => p.type === 'hour')?.value;
    localHour = parseInt(hourStr, 10);
    if (localHour === 24) localHour = 0;
  } catch {
    localDay = now.getUTCDay();
    localHour = now.getUTCHours();
  }

  return localDay === row.send_day && localHour === row.send_hour;
}

function formatDate(isoStr) {
  if (!isoStr) return 'No due date';
  return new Date(isoStr).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function buildEmailText(stats, overdue, recent, teamName) {
  const lines = [
    `Hi ${teamName} admin,`,
    '',
    `Here's your weekly Pact summary for the ${teamName} workspace.`,
    '',
    `━━━ THIS WEEK ━━━`,
    `  Pacts created:   ${stats.created_this_week}`,
    `  Pacts completed:  ${stats.completed_this_week}`,
    '',
    `━━━ CURRENT STATUS ━━━`,
    `  Active pacts:    ${stats.active_count}`,
    `  Due next 7 days: ${stats.upcoming_next_7d}`,
    `  Overdue:         ${stats.overdue_count}`,
    '',
  ];

  if (overdue.length > 0) {
    lines.push('━━━ OVERDUE ━━━');
    for (const p of overdue) {
      const creator = p.creator_name ? ` (${p.creator_name})` : '';
      lines.push(`  • ${p.description}${creator} — was due ${formatDate(p.due_date)}`);
    }
    lines.push('');
  }

  if (recent.length > 0) {
    lines.push('━━━ RECENTLY COMPLETED ━━━');
    for (const p of recent) {
      lines.push(`  ✓ ${p.description} — completed ${formatDate(p.completed_at)}`);
    }
    lines.push('');
  }

  if (stats.overdue_count === 0 && stats.created_this_week === 0) {
    lines.push('No pact activity this week. Your team may need a nudge to make some promises!');
    lines.push('');
  }

  lines.push('— The Pact team');
  lines.push(getAppUrl());

  return lines.join('\n');
}

function buildEmailHtml(stats, overdue, recent, teamName) {
  const overdueRows = overdue.length ? overdue.map(p => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;color:#ef4444;">🔴</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">${p.description}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;color:#666;">${formatDate(p.due_date)}</td>
    </tr>
  `).join('') : '<tr><td colspan="3" style="padding:8px 12px;color:#666;">None — looking good!</td></tr>';

  const recentRows = recent.length ? recent.map(p => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;color:#22c55e;">✓</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">${p.description}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;color:#666;">${formatDate(p.completed_at)}</td>
    </tr>
  `).join('') : '<tr><td colspan="3" style="padding:8px 12px;color:#666;">Nothing completed this week.</td></tr>';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Pact Weekly Digest</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#222;">
  <div style="background:#f9fafb;border-radius:12px;padding:24px;margin-bottom:24px;">
    <h1 style="margin:0 0 4px;font-size:20px;color:#111;">📋 Weekly Pact Digest</h1>
    <p style="margin:0;color:#666;font-size:14px;">${teamName} workspace · week of ${new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}</p>
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:24px;">
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;text-align:center;">
      <div style="font-size:28px;font-weight:700;color:#16a34a;">${stats.completed_this_week}</div>
      <div style="font-size:12px;color:#166534;margin-top:2px;">Completed</div>
    </div>
    <div style="background:#fefce8;border:1px solid #fef08a;border-radius:8px;padding:16px;text-align:center;">
      <div style="font-size:28px;font-weight:700;color:#ca8a04;">${stats.created_this_week}</div>
      <div style="font-size:12px;color:#854d0e;margin-top:2px;">Created</div>
    </div>
    <div style="background:#fef9c3;border:1px solid #fde047;border-radius:8px;padding:16px;text-align:center;">
      <div style="font-size:28px;font-weight:700;color:#a16207;">${stats.upcoming_next_7d}</div>
      <div style="font-size:12px;color:#92400e;margin-top:2px;">Due next 7 days</div>
    </div>
    <div style="${stats.overdue_count > 0 ? 'background:#fef2f2;border:1px solid #fecaca;' : 'background:#f9fafb;border:1px solid #e5e7eb;'}border-radius:8px;padding:16px;text-align:center;">
      <div style="font-size:28px;font-weight:700;color:${stats.overdue_count > 0 ? '#dc2626' : '#6b7280'};">${stats.overdue_count}</div>
      <div style="font-size:12px;color:${stats.overdue_count > 0 ? '#991b1b' : '#374151'};margin-top:2px;">Overdue</div>
    </div>
  </div>
  <table style="width:100%;border-collapse:collapse;margin-bottom:24px;font-size:14px;">
    <thead><tr style="background:#f9fafb;"><th style="padding:8px 12px;text-align:left;font-weight:600;border-bottom:2px solid #e5e7eb;" colspan="3">🔴 Overdue Pacts</th></tr></thead>
    <tbody>${overdueRows}</tbody>
  </table>
  <table style="width:100%;border-collapse:collapse;margin-bottom:24px;font-size:14px;">
    <thead><tr style="background:#f9fafb;"><th style="padding:8px 12px;text-align:left;font-weight:600;border-bottom:2px solid #e5e7eb;" colspan="3">✓ Recently Completed</th></tr></thead>
    <tbody>${recentRows}</tbody>
  </table>
  <p style="font-size:13px;color:#6b7280;margin-bottom:16px;">
    You're receiving this because you're the admin for the <strong>${teamName}</strong> workspace on Pact.
    <a href="mailto:${process.env.CONTACT_NOTIFY_EMAIL || 'hello@makepact.co'}?subject=Unsubscribe+admin+digest+${teamName}" style="color:#6b7280;">Unsubscribe</a>
  </p>
  <p style="font-size:13px;color:#6b7280;"><a href="${getAppUrl()}" style="color:#6366f1;">Open Pact →</a></p>
</body>
</html>`;
}

async function sendEmail(to, subject, body, html) {
  return sendProviderEmail({ to, subject, body, html });
}

/**
 * Run the workspace admin digest check and send emails.
 * Returns a summary object for HTTP response logging.
 */
async function runWorkspaceAdminDigest() {
  console.log('[workspace-admin-digest] Running...');
  const workspaces = await digestDb.getWorkspacesDueForDigest();
  if (workspaces.length === 0) {
    console.log('[workspace-admin-digest] No workspaces due.');
    return { sent: 0, skipped: 0 };
  }

  const dueNow = workspaces.filter(isDigestDue);
  console.log(`[workspace-admin-digest] ${dueNow.length}/${workspaces.length} due now`);

  let sent = 0, skipped = 0;
  for (const ws of dueNow) {
    if (!ws.admin_email) { skipped++; continue; }
    try {
      const [stats, overdue, recent] = await Promise.all([
        digestDb.getWorkspaceDigestStats(ws.team_id),
        digestDb.getOverduePactsForDigest(ws.team_id),
        digestDb.getRecentCompletedPacts(ws.team_id),
      ]);

      if (stats.active_count === 0 && stats.completed_this_week === 0) {
        await digestDb.markDigestSent(ws.team_id);
        skipped++;
        continue;
      }

      const teamName = ws.team_name || 'Pact';
      await sendEmail(
        ws.admin_email,
        `📋 ${teamName} — Weekly Pact Digest`,
        buildEmailText(stats, overdue, recent, teamName),
        buildEmailHtml(stats, overdue, recent, teamName)
      );
      await digestDb.markDigestSent(ws.team_id);
      sent++;
      console.log(`  Sent to ${ws.admin_email} (${ws.team_id})`);
    } catch (err) {
      console.error(`  Failed for ${ws.team_id}: ${err.message}`);
      skipped++;
    }
  }

  console.log(`[workspace-admin-digest] Done — sent: ${sent}, skipped: ${skipped}`);
  return { sent, skipped };
}

module.exports = { runWorkspaceAdminDigest };
