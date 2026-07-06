/**
 * Verification script for the checkout flow fix.
 * Tests that:
 * 1. The Stripe checkout link is configured from this deployment's environment
 * 2. The success page auto-activation works with just the cookie (no sessionId required)
 * 3. The billing page upgrade link doesn't have target="_blank"
 * 4. The checkout.html skip link has skip_lookup=1
 */

const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

console.log('\n=== Checkout Flow Verification ===\n');

// Read files
const serverJs = [
  fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8'),
  fs.readFileSync(path.join(__dirname, 'lib', 'billing-routes.js'), 'utf8'),
].join('\n');
const billingHtml = fs.readFileSync(path.join(__dirname, 'public', 'billing.html'), 'utf8');
const checkoutHtml = fs.readFileSync(path.join(__dirname, 'public', 'checkout.html'), 'utf8');
const successHtml = fs.readFileSync(path.join(__dirname, 'public', 'subscription-success.html'), 'utf8');

console.log('1. Stripe checkout link configuration');
test('Reads Pro Payment Link from env', () => {
  assert(
    serverJs.includes('STRIPE_PRO_PAYMENT_LINK') && serverJs.includes('STRIPE_PAYMENT_LINK_PRO'),
    'Checkout should read the Pro Payment Link from the environment'
  );
});

test('Does not hardcode Stripe Payment Links', () => {
  assert(
    !serverJs.includes('buy.stripe.com'),
    'Stripe Payment Links should come from env, not from a hardcoded account'
  );
});

test('Checkout fails closed when unconfigured', () => {
  assert(
    serverJs.includes('Stripe checkout is not configured'),
    'Checkout should return a configuration error if no Stripe link is set'
  );
});

console.log('\n2. Billing page upgrade link');
test('Upgrade link goes to /api/checkout', () => {
  assert(
    billingHtml.includes('href="/api/checkout"'),
    'Upgrade link should point to /api/checkout'
  );
});

test('Upgrade link does NOT have target="_blank"', () => {
  const lines = billingHtml.split('\n');
  const buttonLine = lines.find(l => l.includes('href="/api/checkout"'));
  assert(buttonLine, 'Could not find the Upgrade to Pro anchor tag');
  assert(
    !buttonLine.includes('target="_blank"'),
    'Upgrade link should NOT open in a new tab'
  );
});

console.log('\n3. Success page auto-activation');
test('Auto-activation works with just the cookie (no sessionId required)', () => {
  // The condition should be `if (checkoutCtx)` not `if (checkoutCtx && sessionId)`
  assert(
    !successHtml.includes('if (checkoutCtx && sessionId)'),
    'Should NOT require both cookie and sessionId for auto-activation'
  );
  assert(
    successHtml.includes("if (checkoutCtx)"),
    'Should attempt activation with just the cookie'
  );
});

test('Session ID is passed when available but optional', () => {
  assert(
    successHtml.includes("session_id: sessionId || undefined"),
    'session_id should be passed when available, undefined when not'
  );
});

console.log('\n4. Checkout form (checkout.html)');
test('Skip link in help text includes skip_lookup=1', () => {
  // Check the help text Option 3 link
  const option3Line = checkoutHtml.split('\n').find(l => l.includes('Option 3') && l.includes('Skip this step'));
  assert(option3Line, 'Could not find Option 3 skip link');
  assert(
    option3Line.includes('/api/checkout?skip_lookup=1'),
    'Option 3 skip link should include skip_lookup=1'
  );
});

console.log('\n5. Server-side checkout endpoint');
test('GET /api/checkout sets pact_checkout_ctx cookie', () => {
  assert(
    serverJs.includes("res.cookie('pact_checkout_ctx'"),
    'Checkout endpoint should set the pact_checkout_ctx cookie'
  );
});

test('Cookie includes team_id and user_id', () => {
  assert(
    serverJs.includes("const ref = user_id ? `${team_id}__${user_id}` : team_id"),
    'Cookie ref should include both team_id and user_id'
  );
});

test('Checkout appends client_reference_id to Stripe URL', () => {
  assert(
    serverJs.includes('client_reference_id='),
    'Should append client_reference_id to the Stripe Payment Link'
  );
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
