// routes/streak.js
// Owns: /streak/:token public share card page + /streak/:token/share analytics endpoint.
// Does NOT own: milestone detection, DM delivery, or Slack command handling.

'use strict';

const express = require('express');
const crypto = require('crypto');
const { getShareCard, logStreakAnalytics } = require('../db/streak-milestones');
const { getAppUrl } = require('../lib/app-url');

const router = express.Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function milestoneLabel(days) {
  if (days >= 100) return '100-day';
  if (days >= 30) return '30-day';
  if (days >= 7) return '7-day';
  return `${days}-day`;
}

function milestoneTagline(days) {
  if (days >= 100) return 'One hundred days of unbroken promises. Legendary.';
  if (days >= 30) return 'Thirty days. Every promise kept. No excuses.';
  return 'Seven days of kept promises — the streak has begun.';
}

function milestoneGradient(days) {
  if (days >= 100) return 'linear-gradient(135deg, #1a1a2e 0%, #16213e 40%, #0f3460 100%)';
  if (days >= 30) return 'linear-gradient(135deg, #1a0a00 0%, #2d1400 40%, #5c2800 100%)';
  return 'linear-gradient(135deg, #0a0a1a 0%, #0d1b2a 40%, #1a2d3a 100%)';
}

function milestoneAccent(days) {
  if (days >= 100) return '#7c6af7';
  if (days >= 30) return '#ff6b35';
  return '#3bb6f7';
}

function milestoneEmoji(days) {
  if (days >= 100) return '🏆';
  if (days >= 30) return '🔥';
  return '⚡';
}

function hashIp(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '';
  return crypto.createHash('sha256').update(ip + 'pact-streak-salt').digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Share card HTML
// ---------------------------------------------------------------------------

function renderShareCard(card) {
  const { token, display_name, milestone_days, pacts_kept, on_time_pct } = card;
  const days = milestone_days;
  const label = milestoneLabel(days);
  const tagline = milestoneTagline(days);
  const bg = milestoneGradient(days);
  const accent = milestoneAccent(days);
  const emoji = milestoneEmoji(days);
  const name = display_name ? display_name.split(' ')[0] : null;
  const baseUrl = getAppUrl();
  const cardUrl = `${baseUrl}/streak/${token}`;
  const ogImage = `${baseUrl}/streak-og.png`; // static fallback OG image

  const titleText = name
    ? `${name}'s ${label} promise streak — Pact`
    : `${label} promise streak — Pact`;

  const descText = `${pacts_kept} pacts kept · ${on_time_pct}% on time · ${days} consecutive days of kept promises`;

  const twitterUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(`Just hit a ${label} promise streak on @PactHQ 🤝 every commitment I made to a coworker, kept on time. ${cardUrl}`)}`;
  const liUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(cardUrl)}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escHtml(titleText)}</title>

  <!-- Open Graph -->
  <meta property="og:type" content="website" />
  <meta property="og:url" content="${escHtml(cardUrl)}" />
  <meta property="og:title" content="${escHtml(titleText)}" />
  <meta property="og:description" content="${escHtml(descText)}" />
  <meta property="og:image" content="${escHtml(ogImage)}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:site_name" content="Pact" />

  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escHtml(titleText)}" />
  <meta name="twitter:description" content="${escHtml(descText)}" />
  <meta name="twitter:image" content="${escHtml(ogImage)}" />

  <!-- Robots: let this be indexed (organic distribution) -->
  <meta name="robots" content="index, follow" />

  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;900&display=swap" rel="stylesheet" />

  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'Inter', sans-serif;
      background: ${bg};
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      color: #fff;
    }

    .card {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 24px;
      max-width: 560px;
      width: 100%;
      padding: 48px 40px;
      text-align: center;
      backdrop-filter: blur(12px);
      box-shadow: 0 32px 64px rgba(0,0,0,0.4);
    }

    .emoji-badge {
      font-size: 72px;
      line-height: 1;
      margin-bottom: 20px;
      display: block;
    }

    .streak-number {
      font-size: 80px;
      font-weight: 900;
      color: ${accent};
      line-height: 1;
      letter-spacing: -2px;
    }

    .streak-label {
      font-size: 22px;
      font-weight: 700;
      color: rgba(255,255,255,0.9);
      margin-top: 6px;
      text-transform: uppercase;
      letter-spacing: 3px;
    }

    .name-line {
      font-size: 15px;
      color: rgba(255,255,255,0.5);
      margin-top: 8px;
      font-weight: 400;
    }

    .divider {
      height: 1px;
      background: rgba(255,255,255,0.08);
      margin: 28px 0;
    }

    .stats {
      display: flex;
      justify-content: center;
      gap: 40px;
    }

    .stat {
      text-align: center;
    }

    .stat-value {
      font-size: 28px;
      font-weight: 800;
      color: ${accent};
      line-height: 1;
    }

    .stat-label {
      font-size: 12px;
      color: rgba(255,255,255,0.45);
      margin-top: 4px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .tagline {
      font-size: 15px;
      color: rgba(255,255,255,0.55);
      margin-top: 28px;
      line-height: 1.5;
      font-style: italic;
    }

    .share-row {
      margin-top: 36px;
      display: flex;
      gap: 12px;
      justify-content: center;
      flex-wrap: wrap;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 12px 22px;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 600;
      text-decoration: none;
      cursor: pointer;
      border: none;
      transition: opacity 0.15s, transform 0.1s;
    }

    .btn:hover { opacity: 0.85; transform: translateY(-1px); }
    .btn:active { transform: translateY(0); }

    .btn-twitter { background: #1da1f2; color: #fff; }
    .btn-linkedin { background: #0a66c2; color: #fff; }
    .btn-copy {
      background: rgba(255,255,255,0.1);
      color: rgba(255,255,255,0.8);
      border: 1px solid rgba(255,255,255,0.15);
    }

    .wordmark {
      margin-top: 36px;
      font-size: 13px;
      color: rgba(255,255,255,0.25);
    }

    .wordmark a {
      color: ${accent};
      text-decoration: none;
      font-weight: 600;
    }

    .copy-feedback {
      font-size: 12px;
      color: #4caf50;
      margin-top: 8px;
      min-height: 18px;
    }
  </style>
</head>
<body>
  <div class="card">
    <span class="emoji-badge">${emoji}</span>

    <div class="streak-number">${days}</div>
    <div class="streak-label">day streak</div>
    ${name ? `<div class="name-line">${escHtml(name)}'s promise record</div>` : ''}

    <div class="divider"></div>

    <div class="stats">
      <div class="stat">
        <div class="stat-value">${pacts_kept}</div>
        <div class="stat-label">pacts kept</div>
      </div>
      <div class="stat">
        <div class="stat-value">${on_time_pct}%</div>
        <div class="stat-label">on time</div>
      </div>
      <div class="stat">
        <div class="stat-value">${days}</div>
        <div class="stat-label">day streak</div>
      </div>
    </div>

    <div class="tagline">${escHtml(tagline)}</div>

    <div class="share-row">
      <a class="btn btn-twitter" href="${twitterUrl}" target="_blank" rel="noopener"
         onclick="logShare('twitter')">
        🐦 Tweet this
      </a>
      <a class="btn btn-linkedin" href="${liUrl}" target="_blank" rel="noopener"
         onclick="logShare('linkedin')">
        💼 Share on LinkedIn
      </a>
      <button class="btn btn-copy" onclick="copyLink()">
        🔗 Copy link
      </button>
    </div>
    <div class="copy-feedback" id="copy-msg"></div>

    <div class="wordmark">
      Tracked with <a href="${escHtml(baseUrl)}" target="_blank">Pact</a> — keep the promises that matter
    </div>
  </div>

  <script>
    const CARD_URL = ${JSON.stringify(cardUrl)};
    const TOKEN = ${JSON.stringify(token)};

    async function logShare(platform) {
      try {
        await fetch('/streak/' + TOKEN + '/share?p=' + platform, { method: 'POST' });
      } catch (_) {}
    }

    async function copyLink() {
      try {
        await navigator.clipboard.writeText(CARD_URL);
        document.getElementById('copy-msg').textContent = '✓ Link copied!';
        setTimeout(() => { document.getElementById('copy-msg').textContent = ''; }, 2500);
        await logShare('copy');
      } catch (e) {
        document.getElementById('copy-msg').textContent = CARD_URL;
      }
    }

    // Log view once per session
    (async () => {
      try {
        await fetch('/streak/' + TOKEN + '/view', { method: 'POST' });
      } catch (_) {}
    })();
  </script>
</body>
</html>`;
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /streak/:token — render the share card page
 */
router.get('/:token', async (req, res) => {
  const { token } = req.params;

  if (!token || !/^[A-Za-z0-9_-]{8,16}$/.test(token)) {
    return res.status(404).send('<h1>Not found</h1>');
  }

  try {
    const card = await getShareCard(token);
    if (!card) {
      return res.status(404).send(`<!DOCTYPE html><html><head><title>Not found</title></head>
        <body style="font-family:sans-serif;text-align:center;padding:60px;color:#666;">
          <h2>This streak card has expired or doesn't exist.</h2>
          <p><a href="${getAppUrl()}">Learn more about Pact →</a></p>
        </body></html>`);
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // No aggressive caching — card data can change (stats refresh)
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(renderShareCard(card));
  } catch (err) {
    console.error(`[STREAK] GET /streak/${token} error: ${err.message}`);
    res.status(500).send('<h1>Error loading streak card</h1>');
  }
});

/**
 * POST /streak/:token/view — log a card view (fire-and-forget, never blocks)
 */
router.post('/:token/view', async (req, res) => {
  const { token } = req.params;
  if (!token || !/^[A-Za-z0-9_-]{8,16}$/.test(token)) return res.status(204).end();

  const ipHash = hashIp(req);
  logStreakAnalytics(token, 'viewed', { ipHash }).catch(() => {});
  res.status(204).end();
});

/**
 * POST /streak/:token/share?p=platform — log a share click
 */
router.post('/:token/share', async (req, res) => {
  const { token } = req.params;
  const platform = ['twitter', 'linkedin', 'copy'].includes(req.query.p) ? req.query.p : null;

  if (!token || !/^[A-Za-z0-9_-]{8,16}$/.test(token)) return res.status(204).end();

  logStreakAnalytics(token, 'shared', { platform }).catch(() => {});
  res.status(204).end();
});

module.exports = router;
