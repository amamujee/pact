'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildPoolConfig,
  normalizeConnectionString,
  positiveInteger,
} = require('../../db/pool-config');

describe('serverless database pool configuration', () => {
  it('keeps Neon connections warm and permits short Slack event bursts', () => {
    const config = buildPoolConfig({
      DATABASE_URL: 'postgresql://role:secret@ep-test-pooler.neon.tech/neondb?sslmode=require',
    });

    assert.equal(config.max, 2);
    assert.equal(config.idleTimeoutMillis, 300000);
    assert.equal(config.connectionTimeoutMillis, 5000);
    assert.equal(config.keepAlive, true);
    assert.equal(config.ssl, undefined);
  });

  it('makes Neon certificate verification explicit', () => {
    const normalized = normalizeConnectionString(
      'postgresql://role:secret@ep-test-pooler.neon.tech/neondb?sslmode=require&channel_binding=require'
    );

    assert.match(normalized, /sslmode=verify-full/);
    assert.doesNotMatch(normalized, /sslmode=require/);
  });

  it('keeps local development SSL disabled and honors valid overrides', () => {
    const config = buildPoolConfig({
      DATABASE_URL: 'postgresql://localhost/pact',
      PG_POOL_MAX: '4',
      PG_IDLE_TIMEOUT_MS: '60000',
      PG_CONNECTION_TIMEOUT_MS: '2500',
    });

    assert.equal(config.ssl, false);
    assert.equal(config.max, 4);
    assert.equal(config.idleTimeoutMillis, 60000);
    assert.equal(config.connectionTimeoutMillis, 2500);
  });

  it('falls back when an override is missing or invalid', () => {
    assert.equal(positiveInteger(undefined, 2), 2);
    assert.equal(positiveInteger('0', 2), 2);
    assert.equal(positiveInteger('not-a-number', 2), 2);
  });
});
