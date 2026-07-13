'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { getTeamTier, planBadge, PLAN_MONTHLY_LIMITS } = require('../../lib/access');

describe('free access', () => {
  it('gives every workspace unlimited free access', async () => {
    assert.equal(await getTeamTier('T_ANY_WORKSPACE'), 'free');
    assert.equal(PLAN_MONTHLY_LIMITS.free, null);
    assert.match(planBadge('free'), /Free · all features/);
  });
});
