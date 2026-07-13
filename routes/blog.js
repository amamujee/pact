// routes/blog.js
// Owns: /blog and /blog/:slug canonical article pages for SEO.
// Does NOT own: homepage, Slack routes, billing pages.

'use strict';

const express = require('express');
const router = express.Router();

const CANONICAL_DEVTO_URL = 'https://dev.to/amamujee/why-informal-promises-between-devs-fail';
const SLUG = 'why-informal-promises-between-devs-fail';

// Article content — matches the dev.to article exactly
const ARTICLE_HTML = `
<h1>Why Informal Promises Between Devs Fail — and How We Fixed It</h1>
<p class="subtitle">A Slack bot that turns informal promises into tracked commitments</p>

<h2>The Problem Nobody Talks About</h2>
<p>You've been there. A teammate drops a message in Slack: "I'll review that PR by Friday." You say thanks, maybe add a thumbs-up reaction, and move on.</p>
<p>Friday arrives. No review. No message. You send a gentle nudge. They apologize, blame it on a meeting. You review it yourself. The relationship gets just a little bit frostier.</p>
<p>This happens everywhere in engineering teams. Estimates slip. PRs languish. Onboarding tasks never finish. Deadlines vanish into Slack scrollback like they never existed.</p>
<p>The numbers are brutal: <strong>Solo accountability tools have a 65% success rate.</strong> You commit to yourself, and two-thirds of the time you follow through. But two-party commitments—where someone else is counting on you—hit <strong>95% completion rates.</strong></p>
<p>Solo accountability is lonely. Multiplayer accountability works.</p>

<h2>The Insight: Two-Party Commitments Change Everything</h2>
<p>This isn't new psychology. It's why gyms work better with a partner. Why code reviews require a reviewer. Why "let me know when it's done" fails but "I'm waiting for you" doesn't.</p>
<p>The gap is accountability. When you make a promise to yourself, you're competing against your own priorities. When you make a promise to someone else—someone who's visibly waiting—you follow through.</p>
<p>But here's the gap: Most productivity tools are built for solo players. Notion databases. Todoist. Asana. They're all "you commit, you track, you complete." None of them capture the thing that actually matters: <strong>someone else is counting on you.</strong></p>

<h2>What We Built: Pact</h2>
<p>We're a Slack bot that turns informal promises into two-way commitments.</p>
<p><strong>The commitment:</strong> You're in Slack. Someone says, "I'll get that done by end of week." Instead of hoping they remember, you react with 🤝 (pact emoji). Both people get a notification: "Pact created: Review designs by Friday, May 17."</p>
<p><strong>The confirmation:</strong> Both parties confirm. It's lightweight, but it matters—you've both acknowledged the commitment exists.</p>
<p><strong>The tracking:</strong> Daily digest: "You have 3 active pacts. 1 is overdue." Overdue nudges at 9am. No shame, just a reminder: someone's waiting.</p>
<p><strong>The completion:</strong> When it's done, react with ✅. Both get notified. Your streak continues.</p>
<p><strong>The data:</strong> Weekly team pulse. "90% of commitments completed on time." "Sarah's team averages 4.2 days."</p>

<h2>Why This Is Different</h2>
<p><strong>Focusmate is sync.</strong> You book a 50-minute co-working session and work side-by-side. Works great for solo makers. Doesn't work for async teams across time zones. Pact is <strong>async-first.</strong></p>
<p><strong>Asana and Notion live in their own app.</strong> You have to context-switch, copy tasks from Slack, remember to update them. Pact <strong>lives in Slack.</strong></p>
<p><strong>Solo tools are one-way.</strong> You set a goal. You track it. You win or fail alone. Pact is <strong>two-way.</strong> Your counterparty can propose new dates. You negotiate in Slack.</p>
<p><strong>Linear integration:</strong> Pact watches your PRs and issues. "Hey, this PR has been open 5 days—want to make a pact on when it ships?"</p>

<h2>The Product</h2>
<ul>
  <li><strong>/pact command:</strong> /pact Review my designs by Friday → Your teammate confirms → Pact created.</li>
  <li><strong>Daily digest:</strong> All your active pacts, overdue status, completion rate.</li>
  <li><strong>Overdue nudges:</strong> 9am reminder if something's due today and not marked complete.</li>
  <li><strong>Streaks:</strong> Track consecutive weeks of 100% completion.</li>
  <li><strong>Team pulse:</strong> Org-wide completion rates, most reliable teams, trending pacts.</li>
  <li><strong>Pro AI feature:</strong> (Coming soon) Auto-detect commitments from Slack messages.</li>
</ul>

<h2>Why We Built This</h2>
<p>Solo accountability tools exist because they're easy to build. Track your own goals. That's simple.</p>
<p>But teams don't fail because individuals aren't disciplined. Teams fail because promises die in Slack. Trust erodes because commitment is invisible. Dates are never locked down until someone says "wait, when exactly?"</p>
<p>Pact makes commitment visible and two-way. It's the difference between "I said I'd do it" and "We both agreed on this."</p>

<h2>Get Started</h2>
<p>Pact is free to start. We're running a beta for engineering teams.</p>
<p><strong><a href="https://makepact.co">Add Pact to Slack</a></strong> — takes about two minutes. The Free plan requires no credit card.</p>
`;

function buildBlogHtml(slug) {
  const baseUrl = 'https://makepact.co/blog/' + SLUG;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Why Informal Promises Between Devs Fail — and How We Fixed It</title>
  <meta name="description" content="A Slack bot that turns informal promises into tracked commitments. 95% completion rate vs 65% solo." />

  <!-- Canonical + SEO -->
  <link rel="canonical" href="${CANONICAL_DEVTO_URL}" />
  <meta name="robots" content="index, follow" />

  <!-- Open Graph -->
  <meta property="og:type" content="article" />
  <meta property="og:title" content="Why Informal Promises Between Devs Fail — and How We Fixed It" />
  <meta property="og:description" content="A Slack bot that turns informal promises into tracked commitments. 95% completion rate vs 65% solo." />
  <meta property="og:image" content="https://makepact.co/og-image.png" />
  <meta property="og:url" content="${baseUrl}" />
  <meta property="og:site_name" content="Pact" />

  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="Why Informal Promises Between Devs Fail — and How We Fixed It" />
  <meta name="twitter:description" content="A Slack bot that turns informal promises into tracked commitments. 95% completion rate vs 65% solo." />
  <meta name="twitter:image" content="https://makepact.co/og-image.png" />

  <!-- Article meta -->
  <meta property="article:published_time" content="2026-05-24" />
  <meta property="article:author" content="Mamuje" />

  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.7;
      color: #1a1a2e;
      background: #fafafa;
    }
    .container {
      max-width: 680px;
      margin: 0 auto;
      padding: 60px 24px 80px;
    }
    .nav {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 48px;
      text-decoration: none;
      color: #555;
      font-size: 14px;
    }
    .nav:hover { color: #1a1a2e; }
    .nav svg { width: 16px; height: 16px; }
    h1 {
      font-size: 2rem;
      font-weight: 700;
      line-height: 1.25;
      color: #1a1a2e;
      margin-bottom: 12px;
      letter-spacing: -0.02em;
    }
    .subtitle {
      font-size: 1.125rem;
      color: #666;
      margin-bottom: 40px;
      font-style: italic;
    }
    article h2 {
      font-size: 1.35rem;
      font-weight: 600;
      color: #1a1a2e;
      margin: 40px 0 16px;
      letter-spacing: -0.01em;
    }
    article p {
      margin-bottom: 20px;
      color: #333;
      font-size: 1.0625rem;
    }
    article strong { color: #1a1a2e; font-weight: 600; }
    article ul {
      margin: 16px 0 24px 20px;
    }
    article ul li {
      margin-bottom: 10px;
      font-size: 1.0625rem;
      color: #333;
    }
    article a {
      color: #4f46e5;
      text-decoration: underline;
    }
    article a:hover { color: #3730a3; }
    .cta-bar {
      margin-top: 56px;
      padding-top: 32px;
      border-top: 1px solid #e5e7eb;
      text-align: center;
    }
    .cta-btn {
      display: inline-block;
      background: #4f46e5;
      color: #fff;
      padding: 14px 32px;
      border-radius: 8px;
      font-weight: 600;
      font-size: 1rem;
      text-decoration: none;
      transition: background 0.15s;
    }
    .cta-btn:hover { background: #4338ca; }
    .cta-sub {
      margin-top: 12px;
      font-size: 0.875rem;
      color: #888;
    }
    .canonical-note {
      margin-top: 32px;
      font-size: 0.8rem;
      color: #aaa;
      text-align: center;
    }
    .canonical-note a { color: #bbb; }
  </style>
</head>
<body>
  <div class="container">
    <a href="https://makepact.co" class="nav">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M15 18l-6-6 6-6"/>
      </svg>
      Back to Pact
    </a>

    <article>
      ${ARTICLE_HTML}
    </article>

    <div class="cta-bar">
      <a href="https://makepact.co" class="cta-btn">Add to Slack — Free</a>
      <p class="cta-sub">Takes 30 seconds. No credit card.</p>
    </div>

    <p class="canonical-note">
      This article was first published on
      <a href="${CANONICAL_DEVTO_URL}" rel="noopener noreferrer">dev.to</a>.
    </p>
  </div>
</body>
</html>`;
}

// GET /blog  → redirect to the canonical slug
router.get('/', (req, res) => {
  res.redirect(301, '/blog/' + SLUG);
});

// GET /blog/:slug  → serve the article page
router.get('/:slug', (req, res) => {
  const { slug } = req.params;

  // Only serve the known article slug
  if (slug !== SLUG) {
    return res.status(404).send('Article not found.');
  }

  const html = buildBlogHtml(slug);
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

module.exports = router;
