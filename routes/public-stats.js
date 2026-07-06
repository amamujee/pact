// Public stats endpoint — owns: aggregate pact metrics for homepage social proof.
// Does NOT own: per-user data, authentication, billing state.
const express = require('express');
const { getPublicStatsRaw } = require('../db/pacts');

const router = express.Router();

// In-memory 5-minute cache — avoids DB hit on every homepage load
let _cache = null;
let _cacheAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function fetchStats() {
  const now = Date.now();
  if (_cache && now - _cacheAt < CACHE_TTL_MS) return _cache;
  _cache = await getPublicStatsRaw();
  _cacheAt = now;
  return _cache;
}

// GET /api/public-stats — used by homepage SSR and client-side refresh
router.get('/', async (req, res) => {
  try {
    const stats = await fetchStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: 'stats unavailable' });
  }
});

// Exported so server.js can SSR stats into the homepage HTML
async function getPublicStats() {
  try {
    return await fetchStats();
  } catch {
    return null;
  }
}

module.exports = router;
module.exports.getPublicStats = getPublicStats;
