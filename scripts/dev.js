'use strict';

process.env.LOCAL_DEV = process.env.LOCAL_DEV || 'true';

const { start } = require('../server');

start().catch(err => {
  console.error('Failed to start local dev server:', err);
  process.exit(1);
});
