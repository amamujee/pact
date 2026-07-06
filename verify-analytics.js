/**
 * Verify analytics endpoints are working after deploy.
 * Usage: node verify-analytics.js <BASE_URL>
 */
const BASE_URL = process.argv[2] || 'http://localhost:3000';

async function verify() {
  console.log(`Verifying analytics at ${BASE_URL}...\n`);

  // 1. POST /api/events
  console.log('1. Testing POST /api/events...');
  try {
    const eventRes = await fetch(`${BASE_URL}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_type: 'test_verify',
        metadata: { source: 'verify-script' },
        session_id: 'verify-session-001',
      }),
    });
    const eventData = await eventRes.json();
    console.log(`   Status: ${eventRes.status}`);
    console.log(`   Response:`, eventData);
    if (eventRes.status !== 201) throw new Error('Expected 201');
    console.log('   PASS\n');
  } catch (err) {
    console.log(`   FAIL: ${err.message}\n`);
  }

  // 2. POST /api/events with bad data
  console.log('2. Testing POST /api/events (bad data)...');
  try {
    const badRes = await fetch(`${BASE_URL}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    console.log(`   Status: ${badRes.status}`);
    if (badRes.status !== 400) throw new Error('Expected 400');
    console.log('   PASS\n');
  } catch (err) {
    console.log(`   FAIL: ${err.message}\n`);
  }

  // 3. GET /api/analytics?days=7
  console.log('3. Testing GET /api/analytics?days=7...');
  try {
    const analyticsRes = await fetch(`${BASE_URL}/api/analytics?days=7`);
    const analyticsData = await analyticsRes.json();
    console.log(`   Status: ${analyticsRes.status}`);
    console.log(`   Keys:`, Object.keys(analyticsData));
    console.log(`   Total pageviews: ${analyticsData.total_pageviews}`);
    console.log(`   Unique visitors: ${analyticsData.unique_visitors}`);
    console.log(`   Top pages count: ${analyticsData.top_pages?.length}`);
    console.log(`   Top events count: ${analyticsData.top_events?.length}`);
    if (analyticsRes.status !== 200) throw new Error('Expected 200');
    if (!('total_pageviews' in analyticsData)) throw new Error('Missing total_pageviews');
    if (!('unique_visitors' in analyticsData)) throw new Error('Missing unique_visitors');
    if (!('top_pages' in analyticsData)) throw new Error('Missing top_pages');
    if (!('utm_sources' in analyticsData)) throw new Error('Missing utm_sources');
    console.log('   PASS\n');
  } catch (err) {
    console.log(`   FAIL: ${err.message}\n`);
  }

  // 4. GET /api/analytics?days=30
  console.log('4. Testing GET /api/analytics?days=30...');
  try {
    const analytics30Res = await fetch(`${BASE_URL}/api/analytics?days=30`);
    const analytics30Data = await analytics30Res.json();
    console.log(`   Status: ${analytics30Res.status}`);
    console.log(`   Period: ${analytics30Data.period_days} days`);
    if (analytics30Data.period_days !== 30) throw new Error('Expected period_days=30');
    console.log('   PASS\n');
  } catch (err) {
    console.log(`   FAIL: ${err.message}\n`);
  }

  // 5. Health check still works
  console.log('5. Testing GET /health...');
  try {
    const healthRes = await fetch(`${BASE_URL}/health`);
    const healthData = await healthRes.json();
    console.log(`   Status: ${healthRes.status}`);
    console.log(`   Response:`, healthData);
    if (healthRes.status !== 200) throw new Error('Expected 200');
    console.log('   PASS\n');
  } catch (err) {
    console.log(`   FAIL: ${err.message}\n`);
  }

  console.log('Verification complete.');
}

verify().catch(err => {
  console.error('Verification error:', err);
  process.exit(1);
});
