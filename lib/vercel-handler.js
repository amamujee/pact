'use strict';

const { getApp } = require('../server');

function withQuery(req, path) {
  if (path.includes('?')) return path;

  const url = req.url || '';
  const queryIndex = url.indexOf('?');
  return queryIndex === -1 ? path : `${path}${url.slice(queryIndex)}`;
}

async function dispatchToApp(req, res, path) {
  if (path) {
    req.url = withQuery(req, path);
  }

  const app = await getApp({ enableBackgroundJobs: false });
  return app(req, res);
}

module.exports = { dispatchToApp };
