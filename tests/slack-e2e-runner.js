#!/usr/bin/env node
/**
 * Pact Slack E2E Test Runner
 *
 * Simulates Slack slash commands by sending signed HTTP requests directly to
 * the Pact server — exactly what Slack sends in production. No real workspace
 * required for the automated scenarios.
 *
 * How it works:
 *   1. Spins up a local HTTP server to act as the Slack `response_url` endpoint
 *   2. Sends signed payloads to PACT_SERVER_URL/slack/commands
 *   3. Captures the message Pact sends back via response_url
 *   4. Asserts the response matches expectations
 *
 * Usage:
 *   SLACK_SIGNING_SECRET=xxx PACT_SERVER_URL=https://makepact.co \
 *     node tests/slack-e2e-runner.js
 *
 * With real Slack tokens (for bot DM / peer DM distinction tests):
 *   SLACK_SIGNING_SECRET=xxx PACT_SERVER_URL=... \
 *   SLACK_TEST_BOT_TOKEN=xoxb-... \
 *   SLACK_TEST_WORKSPACE_ID=T... \
 *   SLACK_TEST_USER_1_ID=U... \
 *   SLACK_TEST_USER_2_ID=U... \
 *   SLACK_TEST_DM_CHANNEL_ID=D... \
 *   SLACK_TEST_BOT_DM_CHANNEL_ID=D... \
 *     node tests/slack-e2e-runner.js
 */

'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URLSearchParams } = require('url');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const PACT_SERVER_URL = process.env.PACT_SERVER_URL || 'https://makepact.co';
const RESPONSE_CAPTURE_PORT = parseInt(process.env.RESPONSE_CAPTURE_PORT || '9123', 10);
const TEST_TIMEOUT_MS = 8000;

// Test workspace tokens (optional — enables additional scenarios)
// Supports both QA_SLACK_* (task spec) and SLACK_TEST_* (original script) prefixes
const BOT_TOKEN = process.env.QA_SLACK_BOT_TOKEN || process.env.SLACK_TEST_BOT_TOKEN;
const WORKSPACE_ID = process.env.QA_SLACK_WORKSPACE_ID || process.env.SLACK_TEST_WORKSPACE_ID || 'T00000000';
const USER_1_ID = process.env.QA_SLACK_USER1_ID || process.env.SLACK_TEST_USER_1_ID || 'U00000001';
const USER_2_ID = process.env.QA_SLACK_USER2_ID || process.env.SLACK_TEST_USER_2_ID || 'U00000002';
const DM_CHANNEL_ID = process.env.QA_SLACK_DM_USER_USER || process.env.SLACK_TEST_DM_CHANNEL_ID;         // real peer DM channel
const BOT_DM_CHANNEL_ID = process.env.QA_SLACK_DM_USER_BOT || process.env.SLACK_TEST_BOT_DM_CHANNEL_ID; // real bot DM channel
const CHANNEL_ID = process.env.QA_SLACK_CHANNEL_PUBLIC || process.env.SLACK_TEST_CHANNEL_ID || 'C00CHANNEL';
const GROUP_DM_CHANNEL_ID = process.env.QA_SLACK_GROUP_DM || process.env.SLACK_TEST_GROUP_DM_CHANNEL_ID || 'G00GROUPDM';

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function signPayload(body, signingSecret) {
  const timestamp = Math.floor(Date.now() / 1000);
  const sigBase = `v0:${timestamp}:${body}`;
  const signature = 'v0=' + crypto
    .createHmac('sha256', signingSecret)
    .update(sigBase, 'utf8')
    .digest('hex');
  return { timestamp: String(timestamp), signature };
}

function buildPayload(fields) {
  const params = new URLSearchParams({
    command: '/pact',
    text: '',
    user_id: USER_1_ID,
    team_id: WORKSPACE_ID,
    channel_id: 'D00TESTBOT', // default; overridden per test
    channel_name: 'directmessage',
    user_name: 'testuser1',
    ...fields,
  });
  return params.toString();
}

/**
 * Start a local HTTP server that captures the first POST to /response_url.
 * Returns a promise that resolves with the captured body, and a cleanup fn.
 */
function createResponseCapture() {
  let resolver;
  let rejecter;
  const promise = new Promise((res, rej) => {
    resolver = res;
    rejecter = rej;
  });

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      res.writeHead(200).end('OK');
      try {
        resolver(JSON.parse(body));
      } catch {
        resolver({ raw: body });
      }
    });
  });

  const timeout = setTimeout(() => {
    rejecter(new Error(`Timeout: no response_url callback received in ${TEST_TIMEOUT_MS}ms`));
    server.close();
  }, TEST_TIMEOUT_MS);

  const cleanup = () => {
    clearTimeout(timeout);
    server.close();
  };

  return new Promise((res) => {
    server.listen(RESPONSE_CAPTURE_PORT, () => {
      res({ capture: promise, cleanup, server });
    });
  });
}

/**
 * Send a signed slash command payload to the Pact server.
 */
function sendSlashCommand(body) {
  const { timestamp, signature } = signPayload(body, SIGNING_SECRET);
  const serverUrl = new URL('/slack/commands', PACT_SERVER_URL);
  const transport = serverUrl.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const options = {
      hostname: serverUrl.hostname,
      port: serverUrl.port || (serverUrl.protocol === 'https:' ? 443 : 80),
      path: serverUrl.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'X-Slack-Request-Timestamp': timestamp,
        'X-Slack-Signature': signature,
      },
    };

    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Test Framework (minimal)
// ---------------------------------------------------------------------------

const results = [];
let passed = 0;
let failed = 0;
let skipped = 0;

async function test(id, name, fn) {
  process.stdout.write(`  ${id.padEnd(3)} ${name} ... `);
  try {
    const result = await fn();
    if (result === 'SKIP') {
      console.log('\x1b[33mSKIP\x1b[0m');
      skipped++;
      results.push({ id, name, status: 'skip' });
    } else {
      console.log('\x1b[32mPASS\x1b[0m');
      passed++;
      results.push({ id, name, status: 'pass' });
    }
  } catch (err) {
    console.log(`\x1b[31mFAIL\x1b[0m — ${err.message}`);
    failed++;
    results.push({ id, name, status: 'fail', error: err.message });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertContains(text, substring, label) {
  if (typeof text !== 'string') text = JSON.stringify(text);
  if (!text.includes(substring)) {
    throw new Error(`${label || 'Response'} does not contain "${substring}"\nGot: ${text.substring(0, 200)}`);
  }
}

/**
 * Run a full slash-command test:
 *   1. Spin up response_url capture server
 *   2. Send the signed payload (with response_url pointing at capture server)
 *   3. Wait for capture, return the response body
 */
async function runCommand(fields) {
  const { capture, cleanup, server } = await createResponseCapture();
  try {
    const responseUrl = `http://localhost:${RESPONSE_CAPTURE_PORT}/response_url`;
    const body = buildPayload({ ...fields, response_url: responseUrl });
    const httpResp = await sendSlashCommand(body);
    if (httpResp.status !== 200) {
      throw new Error(`Server returned HTTP ${httpResp.status}: ${httpResp.body.substring(0, 100)}`);
    }
    return await capture;
  } finally {
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runAll() {
  if (!SIGNING_SECRET) {
    console.error('\n\x1b[31mERROR: SLACK_SIGNING_SECRET is required.\x1b[0m');
    console.error('Set it via: export SLACK_SIGNING_SECRET=your_signing_secret\n');
    process.exit(1);
  }

  console.log('\n\x1b[1mPact Slack E2E Test Runner\x1b[0m');
  console.log(`Server: ${PACT_SERVER_URL}`);
  console.log(`Capture port: ${RESPONSE_CAPTURE_PORT}`);
  console.log(`Workspace tokens: ${BOT_TOKEN ? '\x1b[32mConfigured\x1b[0m' : '\x1b[33mNot set (DM-detection tests will be skipped)\x1b[0m'}\n`);

  // ---
  console.log('\x1b[1m/pact — Channel type rejections\x1b[0m');
  // ---

  await test('A3', '/pact in public channel → reject', async () => {
    const resp = await runCommand({ command: '/pact', channel_id: CHANNEL_ID, text: 'Finish the report by Friday' });
    const text = JSON.stringify(resp);
    assertContains(text, 'DMs', 'Response');
    return true;
  });

  await test('A4', '/pact in group DM → reject', async () => {
    const resp = await runCommand({ command: '/pact', channel_id: GROUP_DM_CHANNEL_ID, text: 'Finish the report by Friday' });
    const text = JSON.stringify(resp);
    assertContains(text, 'DMs', 'Response');
    return true;
  });

  // ---
  console.log('\n\x1b[1m/pact — Input validation (in DM context)\x1b[0m');
  // ---

  await test('A5', '/pact with no text → usage instructions', async () => {
    // Use the bot DM channel if available, else use a fake DM (D-prefixed ID)
    const dmChannel = BOT_DM_CHANNEL_ID || `DBOTTEST1`;
    const resp = await runCommand({ command: '/pact', channel_id: dmChannel, text: '' });
    const text = JSON.stringify(resp);
    // When no text, usage block is returned
    assertContains(text, 'Usage', 'Response');
    return true;
  });

  await test('A6', '/pact with text but no date → date prompt', async () => {
    // Note: this test requires no Slack API calls IF we use a fake channel ID
    // The server hits Slack API to detect peer/bot DM — skip if no tokens
    if (!BOT_TOKEN || !DM_CHANNEL_ID) return 'SKIP';
    const resp = await runCommand({ command: '/pact', channel_id: DM_CHANNEL_ID, text: 'Write the quarterly report' });
    const text = JSON.stringify(resp);
    assertContains(text, 'done by', 'Response');
    return true;
  });

  // ---
  console.log('\n\x1b[1m/pact — DM type detection (requires test tokens)\x1b[0m');
  // ---

  await test('A1', '/pact in 2-person peer DM → proposal block', async () => {
    if (!BOT_TOKEN || !DM_CHANNEL_ID) return 'SKIP';
    const resp = await runCommand({ command: '/pact', channel_id: DM_CHANNEL_ID, text: 'Ship the feature by Friday 5pm' });
    const text = JSON.stringify(resp);
    // Should either show proposal (PEER_DM) or create directly (known counterparty)
    assert(
      text.includes('pact') || text.includes('proposes') || text.includes('Accept'),
      'Expected pact proposal or creation message'
    );
    return true;
  });

  await test('A2', '/pact in bot DM → helpful error', async () => {
    if (!BOT_TOKEN || !BOT_DM_CHANNEL_ID) return 'SKIP';
    const resp = await runCommand({ command: '/pact', channel_id: BOT_DM_CHANNEL_ID, text: 'Do something by Friday' });
    const text = JSON.stringify(resp);
    assertContains(text, 'teammate', 'Response');
    return true;
  });

  // ---
  console.log('\n\x1b[1m/pacts command\x1b[0m');
  // ---

  await test('B2', '/pacts in empty DM → no pacts message', async () => {
    const dmChannel = BOT_DM_CHANNEL_ID || 'DEMPTYDM1';
    const resp = await runCommand({ command: '/pacts', channel_id: dmChannel });
    const text = JSON.stringify(resp);
    assertContains(text, 'pact', 'Response');
    return true;
  });

  await test('B3', '/pacts in channel → shows (likely empty) pacts', async () => {
    const resp = await runCommand({ command: '/pacts', channel_id: CHANNEL_ID });
    const text = JSON.stringify(resp);
    // Should not error out — either "no pacts" or a list
    assert(text.length > 10, 'Expected a non-empty response');
    return true;
  });

  // ---
  console.log('\n\x1b[1m/done command\x1b[0m');
  // ---

  await test('C1', '/done in empty DM → no pacts to complete', async () => {
    const dmChannel = BOT_DM_CHANNEL_ID || 'DEMPTYDM2';
    const resp = await runCommand({ command: '/done', channel_id: dmChannel });
    const text = JSON.stringify(resp);
    assertContains(text, 'pact', 'Response');
    return true;
  });

  // ---
  console.log('\n\x1b[1mServer health\x1b[0m');
  // ---

  await test('H1', 'GET /slack/status returns valid token info', async () => {
    const url = new URL('/slack/status', PACT_SERVER_URL);
    const transport = url.protocol === 'https:' ? https : http;
    const resp = await new Promise((res, rej) => {
      transport.get(url.toString(), (r) => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => res({ status: r.statusCode, body: d }));
      }).on('error', rej);
    });
    assert(resp.status === 200, `Expected 200, got ${resp.status}`);
    assertContains(resp.body, 'token', '/slack/status response');
    return true;
  });

  // ---
  // Summary
  // ---

  console.log('\n' + '─'.repeat(50));
  console.log(`\x1b[1mResults: ${passed} passed, ${failed} failed, ${skipped} skipped\x1b[0m`);

  if (failed > 0) {
    console.log('\n\x1b[31mFailed tests:\x1b[0m');
    results.filter(r => r.status === 'fail').forEach(r => {
      console.log(`  ${r.id} ${r.name}`);
      console.log(`     → ${r.error}`);
    });
    console.log('');
    process.exit(1);
  } else if (skipped > 0) {
    console.log('\n\x1b[33mNote:\x1b[0m Some tests were skipped (no test workspace tokens configured).');
    console.log('Set SLACK_TEST_BOT_TOKEN, SLACK_TEST_DM_CHANNEL_ID, SLACK_TEST_BOT_DM_CHANNEL_ID');
    console.log('to enable full test coverage.\n');
  } else {
    console.log('\n\x1b[32mAll tests passed.\x1b[0m\n');
  }
}

runAll().catch(err => {
  console.error('\nUnhandled error:', err.message);
  process.exit(1);
});
