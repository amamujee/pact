'use strict';

const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createAdminAuth } = require('../../lib/admin-auth');

const originalAdminSecret = process.env.ADMIN_SECRET;
const originalContactToken = process.env.CONTACT_ADMIN_TOKEN;

function restore(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function invoke(middleware, { headers = {}, query = {} } = {}) {
  const result = { statusCode: null, body: null, nextCalled: false };
  const req = { headers, query };
  const res = {
    status(code) {
      result.statusCode = code;
      return this;
    },
    json(body) {
      result.body = body;
      return this;
    },
  };
  middleware(req, res, () => { result.nextCalled = true; });
  return result;
}

afterEach(() => {
  restore('ADMIN_SECRET', originalAdminSecret);
  restore('CONTACT_ADMIN_TOKEN', originalContactToken);
});

describe('admin auth middleware', () => {
  it('fails closed when no admin secret is configured', () => {
    delete process.env.ADMIN_SECRET;
    const result = invoke(createAdminAuth());
    assert.equal(result.statusCode, 503);
    assert.equal(result.nextCalled, false);
  });

  it('rejects a missing or incorrect credential', () => {
    process.env.ADMIN_SECRET = 'correct-secret';
    assert.equal(invoke(createAdminAuth()).statusCode, 401);
    assert.equal(invoke(createAdminAuth(), { headers: { 'x-admin-secret': 'wrong' } }).statusCode, 401);
  });

  it('accepts the admin header, bearer token, and legacy secret query', () => {
    process.env.ADMIN_SECRET = 'correct-secret';
    const middleware = createAdminAuth();

    assert.equal(invoke(middleware, { headers: { 'x-admin-secret': 'correct-secret' } }).nextCalled, true);
    assert.equal(invoke(middleware, { headers: { authorization: 'Bearer correct-secret' } }).nextCalled, true);
    assert.equal(invoke(middleware, { query: { secret: 'correct-secret' } }).nextCalled, true);
  });

  it('supports a configured legacy contact token without a hardcoded fallback', () => {
    delete process.env.ADMIN_SECRET;
    process.env.CONTACT_ADMIN_TOKEN = 'configured-contact-token';
    const middleware = createAdminAuth({
      envVars: ['ADMIN_SECRET', 'CONTACT_ADMIN_TOKEN'],
      queryKeys: ['secret', 'token'],
    });

    assert.equal(invoke(middleware, { query: { token: 'configured-contact-token' } }).nextCalled, true);
  });
});
