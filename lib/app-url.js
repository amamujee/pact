'use strict';

function getAppUrl() {
  const vercelUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null;
  const url = process.env.APP_URL || vercelUrl || `http://localhost:${process.env.PORT || 3000}`;
  return url.replace(/\/+$/, '');
}

function appUrl(path = '') {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${getAppUrl()}${normalizedPath}`;
}

module.exports = { getAppUrl, appUrl };
