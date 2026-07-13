// Database connection singleton.
// Only this file may construct Pool. All other modules import from here.
const { Pool } = require('pg');
const { buildPoolConfig } = require('./pool-config');

const pool = new Pool(buildPoolConfig());

// Idle network errors should not become uncaught EventEmitter errors that tear
// down an otherwise healthy serverless invocation. The next query will acquire
// a fresh pooled connection automatically.
pool.on('error', (err) => {
  console.warn('[db] Idle client error; the pool will reconnect:', err.message);
});

module.exports = pool;
