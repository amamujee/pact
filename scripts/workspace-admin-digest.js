/**
 * Workspace Admin Digest — weekly email summary for workspace admins.
 * Kept for long-running hosts that still invoke a script scheduler.
 */

const { runWorkspaceAdminDigest } = require('../lib/workspace-admin-digest');
const pool = require('../db/index');

runWorkspaceAdminDigest()
  .catch(err => {
    console.error('[workspace-admin-digest] Failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
