'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

function loadAnalyticsWithSalt(value) {
  const modulePath = require.resolve('../../lib/analytics');
  delete require.cache[modulePath];
  if (value == null) delete process.env.ANALYTICS_IP_SALT;
  else process.env.ANALYTICS_IP_SALT = value;
  return require('../../lib/analytics');
}

describe('analytics IP privacy', () => {
  it('does not retain an IP-derived identifier without a private salt', () => {
    const original = process.env.ANALYTICS_IP_SALT;
    try {
      const { hashIP } = loadAnalyticsWithSalt(null);
      assert.equal(hashIP('203.0.113.9'), null);
    } finally {
      if (original == null) delete process.env.ANALYTICS_IP_SALT;
      else process.env.ANALYTICS_IP_SALT = original;
    }
  });

  it('creates stable keyed hashes when a private salt is configured', () => {
    const original = process.env.ANALYTICS_IP_SALT;
    try {
      const { hashIP } = loadAnalyticsWithSalt('private-test-key');
      const first = hashIP('203.0.113.9');
      assert.equal(first, hashIP('203.0.113.9'));
      assert.notEqual(first, hashIP('203.0.113.10'));
      assert.equal(first.length, 16);
    } finally {
      if (original == null) delete process.env.ANALYTICS_IP_SALT;
      else process.env.ANALYTICS_IP_SALT = original;
    }
  });
});
