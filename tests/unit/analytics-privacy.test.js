'use strict';

const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { hashIP } = require('../../lib/analytics');

const originalSalt = process.env.ANALYTICS_IP_SALT;

afterEach(() => {
  if (originalSalt === undefined) delete process.env.ANALYTICS_IP_SALT;
  else process.env.ANALYTICS_IP_SALT = originalSalt;
});

describe('analytics IP privacy', () => {
  it('does not persist an IP-derived identifier without a private salt', () => {
    delete process.env.ANALYTICS_IP_SALT;
    assert.equal(hashIP('203.0.113.42'), null);
  });

  it('creates stable keyed hashes when a private salt is configured', () => {
    process.env.ANALYTICS_IP_SALT = 'deployment-private-salt';
    const first = hashIP('203.0.113.42');
    const second = hashIP('203.0.113.42');

    assert.equal(first, second);
    assert.match(first, /^[a-f0-9]{16}$/);
    assert.notEqual(first, hashIP('203.0.113.43'));
  });
});
