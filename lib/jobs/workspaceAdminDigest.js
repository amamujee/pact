'use strict';

const { runWorkspaceAdminDigest } = require('../workspace-admin-digest');
const { ensureAppInitialized, runTasks } = require('./_helpers');

async function runWorkspaceAdminDigestJob() {
  await ensureAppInitialized();
  return runTasks([
    ['workspace-admin-digest', () => runWorkspaceAdminDigest()],
  ]);
}

module.exports = { runWorkspaceAdminDigestJob };
