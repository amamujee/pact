'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { registerSlackDiagnostics } = require('../../lib/slack-diagnostics');

function makeRouter() {
  const routes = new Map();
  return {
    get(path, handler) {
      routes.set(path, handler);
    },
    routes,
  };
}

function makeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(body) {
      this.body = body || '';
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = JSON.stringify(value);
      return this;
    },
  };
}

describe('Slack diagnostic routes', () => {
  it('rejects public access to workspace diagnostics', async () => {
    const originalSecret = process.env.CRON_SECRET;
    process.env.CRON_SECRET = 'test-cron-secret';

    try {
      const router = makeRouter();
      const pool = {
        query() {
          throw new Error('Database must not be queried before authorization');
        },
      };
      const slackApp = { client: {} };
      registerSlackDiagnostics(router, pool, slackApp);

      for (const path of ['/slack/status', '/slack/verify-events']) {
        const res = makeResponse();
        await router.routes.get(path)({ headers: {} }, res);
        assert.equal(res.statusCode, 401);
        assert.deepEqual(JSON.parse(res.body), { error: 'Unauthorized' });
      }
    } finally {
      if (originalSecret == null) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = originalSecret;
    }
  });
});
