'use strict';

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeConnectionString(connectionString) {
  if (!connectionString) return connectionString;

  // pg currently treats sslmode=require as verify-full and warns that this will
  // change in its next major version. Make the intended certificate validation
  // explicit so Neon connections stay secure and warning-free.
  return connectionString.replace(
    /([?&])sslmode=require(?=(&|$))/gi,
    '$1sslmode=verify-full'
  );
}

function buildPoolConfig(env = process.env) {
  const rawConnectionString = env.DATABASE_URL;
  const connectionString = normalizeConnectionString(rawConnectionString);
  const isLocal = /(?:localhost|127\.0\.0\.1)/i.test(rawConnectionString || '');
  const hasSslMode = /[?&]sslmode=/i.test(connectionString || '');

  const config = {
    connectionString,
    // Slack can deliver several events close together. Two clients prevent a
    // non-critical background query from blocking the user-facing event.
    max: positiveInteger(env.PG_POOL_MAX, 2),
    // Vercel commonly reuses an invocation after tens of seconds. Keeping the
    // pooled Neon connection warm avoids reconnecting for every Slack message.
    idleTimeoutMillis: positiveInteger(env.PG_IDLE_TIMEOUT_MS, 300000),
    connectionTimeoutMillis: positiveInteger(env.PG_CONNECTION_TIMEOUT_MS, 5000),
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
  };

  if (isLocal) config.ssl = false;
  else if (!hasSslMode) config.ssl = { rejectUnauthorized: true };

  return config;
}

module.exports = { buildPoolConfig, normalizeConnectionString, positiveInteger };
