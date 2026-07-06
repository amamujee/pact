'use strict';

function sendJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function isCronAuthorized(req, res) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    if (process.env.NODE_ENV === 'production' || process.env.VERCEL) {
      sendJson(res, 500, { error: 'CRON_SECRET is not configured' });
      return false;
    }
    console.warn('[cron] CRON_SECRET not set; allowing request outside production');
    return true;
  }

  const actual = req.headers.authorization || '';
  if (actual !== `Bearer ${expected}`) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return false;
  }
  return true;
}

function createCronHandler(runJob) {
  return async function cronHandler(req, res) {
    if (!isCronAuthorized(req, res)) return;

    try {
      const result = await runJob();
      sendJson(res, 200, { ok: true, result });
    } catch (err) {
      const statusCode = err.statusCode || 500;
      console.error('[cron] handler failed:', err.message);
      sendJson(res, statusCode, { ok: false, error: err.message, results: err.results });
    }
  };
}

module.exports = { createCronHandler, isCronAuthorized, sendJson };
