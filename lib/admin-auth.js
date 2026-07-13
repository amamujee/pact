'use strict';

const crypto = require('crypto');

function nonEmptySecret(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function configuredSecrets(envVars) {
  return [...new Set(envVars.map(name => nonEmptySecret(process.env[name])).filter(Boolean))];
}

function suppliedCredentials(req, queryKeys) {
  const values = [];
  const adminHeader = nonEmptySecret(req.headers?.['x-admin-secret']);
  const authorization = nonEmptySecret(req.headers?.authorization);

  if (adminHeader) values.push(adminHeader);
  if (authorization?.toLowerCase().startsWith('bearer ')) {
    const bearer = nonEmptySecret(authorization.slice(7));
    if (bearer) values.push(bearer);
  }

  for (const key of queryKeys) {
    const value = nonEmptySecret(req.query?.[key]);
    if (value) values.push(value);
  }

  return values;
}

function secretsEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function createAdminAuth({
  envVars = ['ADMIN_SECRET'],
  queryKeys = ['secret'],
} = {}) {
  return function requireAdminAuth(req, res, next) {
    const expected = configuredSecrets(envVars);
    if (expected.length === 0) {
      return res.status(503).json({ error: 'Admin access is not configured' });
    }

    const supplied = suppliedCredentials(req, queryKeys);
    const authorized = supplied.some(candidate => expected.some(secret => secretsEqual(candidate, secret)));
    if (!authorized) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    return next();
  };
}

const requireAdminAuth = createAdminAuth();

module.exports = { createAdminAuth, requireAdminAuth };
