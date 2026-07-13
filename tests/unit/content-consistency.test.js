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

  it('describes the implemented Free and Pro feature model consistently', () => {
    const homepage = read('public/index.html');
    const directory = read('public/slack-app-directory.html');
    const llms = read('public/llms.txt');
    const billing = read('lib/billing-routes.js');
    const slackHandlers = read('lib/slack-handlers.js');

    assert.match(billing, /PLAN_MONTHLY_LIMITS = \{ free: 100, pro: null \}/);
    assert.match(homepage, /Up to 100 new active pacts per month/);
    assert.match(directory, /Up to 100 new active pacts per month/);
    assert.match(llms, /100 newly created active pacts per workspace/);
    assert.match(homepage, /Pro · Early access/);
    assert.match(directory, /Pro · Early access/);
    assert.match(slackHandlers, /Pro is currently in early access/);
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
});
