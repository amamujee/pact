'use strict';

const { dispatchToApp } = require('../lib/vercel-handler');

function getOriginalPath(req) {
  const url = new URL(req.url || '/', 'http://localhost');
  const queryPath = req.query?.path ?? url.searchParams.get('path');
  if (queryPath == null) return undefined;

  const rawPath = Array.isArray(queryPath) ? queryPath[0] : String(queryPath);
  const normalizedPath = `/${rawPath.replace(/^\/+/, '')}`;
  url.searchParams.delete('path');

  const query = url.searchParams.toString();
  return query ? `${normalizedPath}?${query}` : normalizedPath;
}

module.exports = async function handler(req, res) {
  return dispatchToApp(req, res, getOriginalPath(req));
};
