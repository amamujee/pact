'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function collectTextFiles(relativePath, output = []) {
  const fullPath = path.join(root, relativePath);
  const stat = fs.statSync(fullPath);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(fullPath)) {
      if (entry === 'node_modules' || entry === '.git') continue;
      collectTextFiles(path.join(relativePath, entry), output);
    }
  } else if (/\.(?:js|json|md|html|txt|ya?ml)$/.test(relativePath)) {
    if (!relativePath.endsWith('tests/unit/content-consistency.test.js')) output.push(relativePath);
  }
  return output;
}

describe('public content and runtime consistency', () => {
  it('contains no legacy operator, host, or provider references', () => {
    const files = [
      'README.md',
      'MIGRATION.md',
      'PRODUCTION_CHECKLIST.md',
      ...collectTextFiles('public'),
      ...collectTextFiles('docs'),
      ...collectTextFiles('lib'),
      ...collectTextFiles('routes'),
      ...collectTextFiles('scripts'),
    ];
    const forbidden = [
      /\bPolsia\b/i,
      /pact-537l\.polsia\.app/i,
      /api\.render\.com/i,
      /\bPostmark\b/i,
      /\bOpenAI\b/i,
    ];

    for (const relativePath of files) {
      const contents = read(relativePath);
      for (const pattern of forbidden) {
        assert.doesNotMatch(contents, pattern, `${relativePath} still matches ${pattern}`);
      }
    }
  });

  it('describes the unlimited free feature model consistently', () => {
    const homepage = read('public/index.html');
    const directory = read('public/slack-app-directory.html');
    const llms = read('public/llms.txt');
    const access = read('lib/access.js');
    const slackHandlers = read('lib/slack-handlers.js');

    assert.equal(fs.existsSync(path.join(root, 'lib/billing-routes.js')), false);
    assert.match(access, /PLAN_MONTHLY_LIMITS = \{ free: null \}/);
    assert.match(access, /getTeamTier\(\) \{ return 'free'; \}/);
    assert.match(directory, /Unlimited active pacts/);
    assert.match(llms, /Every feature is free, with unlimited pacts/);

    const paidLanguage = /\/pact (?:upgrade|billing)|Pro · Early access|Stripe|billing portal|paid upgrade/i;
    assert.doesNotMatch(homepage, paidLanguage);
    assert.doesNotMatch(directory, paidLanguage);
    assert.doesNotMatch(llms, paidLanguage);
    assert.doesNotMatch(slackHandlers, paidLanguage);
    assert.doesNotMatch(homepage, /doubles the number of commitments met/i);
    assert.match(homepage, /<!--SSR_STATS_START-->[\s\S]*<!--SSR_STATS_END-->/);
  });

  it('uses the production domain and provider names across install and policy surfaces', () => {
    const manifest = JSON.parse(read('slack-app-manifest.json'));
    const privacy = read('public/privacy.html');
    const checklist = read('PRODUCTION_CHECKLIST.md');

    assert.deepEqual(manifest.oauth_config.redirect_urls, [
      'https://makepact.co/slack/oauth/callback',
    ]);
    assert.equal(manifest.settings.event_subscriptions.request_url, 'https://makepact.co/slack/events');
    assert.equal(manifest.settings.interactivity.request_url, 'https://makepact.co/slack/actions');
    for (const command of manifest.features.slash_commands) {
      assert.equal(command.url, 'https://makepact.co/slack/commands');
    }

    assert.match(privacy, />Vercel</);
    assert.match(privacy, />Neon</);
    assert.match(privacy, />Anthropic</);
    assert.match(privacy, />Resend</);
    assert.match(checklist, /https:\/\/makepact\.co/);
  });

  it('uses a correctly sized PNG for social previews', () => {
    const pages = [
      'public/index.html',
      'public/privacy.html',
      'public/terms.html',
      'public/support.html',
      'public/slack-app-directory.html',
    ];

    for (const page of pages) {
      const html = read(page);
      assert.match(html, /property="og:image" content="https:\/\/makepact\.co\/og-image\.png"/);
      assert.match(html, /property="og:image:type" content="image\/png"/);
      assert.match(html, /name="twitter:image" content="https:\/\/makepact\.co\/og-image\.png"/);
      assert.doesNotMatch(html, /og-hero\.png/);
    }

    const image = fs.readFileSync(path.join(root, 'public/og-image.png'));
    assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(image.readUInt32BE(16), 1200);
    assert.equal(image.readUInt32BE(20), 630);
  });
});
