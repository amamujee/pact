'use strict';

const { createCronHandler } = require('../../lib/cron-handler');
const { runWorkspaceAdminDigestJob } = require('../../lib/jobs/workspaceAdminDigest');

module.exports = createCronHandler(runWorkspaceAdminDigestJob);
