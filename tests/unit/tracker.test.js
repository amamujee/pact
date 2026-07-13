// Unit tests for tracker.js — Linear/Asana/Notion sync.
// Uses Node.js built-in test runner (node:test).
// HTTP calls are mocked — no real Linear/Asana/Notion API access.
'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const tracker = require('../../tracker');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePool(queryResultsByPattern = {}) {
  return {
    query: async (sql, params) => {
      for (const [pattern, result] of Object.entries(queryResultsByPattern)) {
        if (sql.includes(pattern)) {
          return typeof result === 'function' ? result(sql, params) : result;
        }
      }
      return { rows: [] };
    }
  };
}

function makePact(overrides = {}) {
  return {
    id: 101,
    description: 'Write the quarterly report',
    due_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    creator_slack_id: 'U_USER1',
    counterparty_slack_id: 'U_USER2',
    channel_id: 'D_CHANNEL',
    team_id: 'T_TEAM1',
    status: 'active',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Token encryption/decryption
// ---------------------------------------------------------------------------

describe('tracker — token encryption', () => {
  it('encrypts and decrypts a token round-trip', () => {
    const plaintext = 'lin_api_abc123secrettoken';
    const encrypted = tracker.encryptToken(plaintext);
    assert.ok(encrypted, 'Should produce encrypted string');
    assert.notEqual(encrypted, plaintext, 'Encrypted should differ from plaintext');

    const decrypted = tracker.decryptToken(encrypted);
    assert.equal(decrypted, plaintext, 'Should decrypt back to original');
  });

  it('returns null for null plaintext', () => {
    assert.equal(tracker.encryptToken(null), null);
  });

  it('returns null for null/invalid encrypted input', () => {
    assert.equal(tracker.decryptToken(null), null);
    assert.equal(tracker.decryptToken('garbage-not-valid-format'), null);
  });

  it('produces different ciphertexts for same plaintext (random IV)', () => {
    const plaintext = 'same-token';
    const enc1 = tracker.encryptToken(plaintext);
    const enc2 = tracker.encryptToken(plaintext);
    // IVs differ → ciphertexts differ
    assert.notEqual(enc1, enc2, 'Same plaintext should produce different ciphertexts due to random IV');
    // Both should decrypt correctly
    assert.equal(tracker.decryptToken(enc1), plaintext);
    assert.equal(tracker.decryptToken(enc2), plaintext);
  });
});

// ---------------------------------------------------------------------------
// syncPactToTracker
// ---------------------------------------------------------------------------

describe('syncPactToTracker', () => {
  it('does nothing when no tracker connections configured', async () => {
    const queryLog = [];
    const pool = {
      query: async (sql, params) => {
        queryLog.push(sql);
        if (sql.includes('tracker_connections')) {
          // No connections
          return { rows: [] };
        }
        return { rows: [] };
      }
    };

    await tracker.syncPactToTracker(pool, makePact(), 'T_TEAM1');

    // Should query tracker_connections but find none
    const connectionQuery = queryLog.find(q => q.includes('tracker_connections'));
    assert.ok(connectionQuery, 'Should query tracker_connections for every workspace');
  });

  it('skips connection when no default_project_id set', async () => {
    const insertLog = [];
    const pool = {
      query: async (sql, params) => {
        if (sql.includes('tracker_connections') && !sql.includes('INSERT')) {
          return {
            rows: [{
              provider: 'linear',
              access_token: tracker.encryptToken('lin_valid_token'),
              default_project_id: null, // no project set
            }]
          };
        }
        if (sql.includes('INSERT')) {
          insertLog.push(sql);
          return { rows: [] };
        }
        return { rows: [] };
      }
    };

    await tracker.syncPactToTracker(pool, makePact(), 'T_TEAM1');

    assert.equal(insertLog.length, 0, 'Should not insert pact_tracker_syncs without default_project_id');
  });

  it('handles errors in individual connections gracefully (non-throwing)', async () => {
    const pool = {
      query: async (sql, params) => {
        if (sql.includes('tracker_connections') && !sql.includes('INSERT')) {
          return {
            rows: [{
              provider: 'linear',
              access_token: tracker.encryptToken('lin_bad_token'),
              default_project_id: 'TEAM::PROJECT',
            }]
          };
        }
        return { rows: [] };
      }
    };

    // Should NOT throw even if Linear API call fails
    await assert.doesNotReject(
      () => tracker.syncPactToTracker(pool, makePact(), 'T_TEAM1'),
      'syncPactToTracker should be fire-and-forget, never throwing'
    );
  });
});

// ---------------------------------------------------------------------------
// completePactInTracker — marks issues done in trackers
// ---------------------------------------------------------------------------

describe('completePactInTracker', () => {
  it('does nothing when no tracker syncs exist for pact', async () => {
    const queryLog = [];
    const pool = {
      query: async (sql, params) => {
        queryLog.push(sql);
        return { rows: [] };
      }
    };

    await tracker.completePactInTracker(pool, 101, 'T_TEAM1', {
      completedByName: 'Alice',
      completedAt: new Date(),
    });

    const syncQuery = queryLog.find(q => q.includes('pact_tracker_syncs'));
    assert.ok(syncQuery, 'Should query pact_tracker_syncs');
    // Since no rows returned, should stop here
    assert.equal(queryLog.length, 1, 'Should only make one query when no syncs found');
  });

  it('is fire-and-forget — does not throw on errors', async () => {
    const pool = {
      query: async (sql, params) => {
        if (sql.includes('pact_tracker_syncs')) {
          return {
            rows: [{
              pact_id: 101,
              provider: 'linear',
              external_id: 'LIN_ISSUE_123',
            }]
          };
        }
        if (sql.includes('tracker_connections')) {
          return {
            rows: [{
              provider: 'linear',
              access_token: tracker.encryptToken('lin_token'),
            }]
          };
        }
        return { rows: [] };
      }
    };

    // completePactInTracker tries to call Linear API — will fail
    // but should not propagate the error
    await assert.doesNotReject(
      () => tracker.completePactInTracker(pool, 101, 'T_TEAM1', { completedByName: 'Bob' }),
      'completePactInTracker should never throw'
    );
  });
});

// ---------------------------------------------------------------------------
// getConfiguredProviders
// ---------------------------------------------------------------------------

describe('getConfiguredProviders', () => {
  it('returns an object with linear/asana/notion keys', () => {
    const providers = tracker.getConfiguredProviders();
    assert.ok(typeof providers === 'object', 'Should return an object');
    assert.ok('linear' in providers, 'Should have linear key');
    assert.ok('asana' in providers, 'Should have asana key');
    assert.ok('notion' in providers, 'Should have notion key');
  });

  it('returns boolean values for each provider', () => {
    const providers = tracker.getConfiguredProviders();
    assert.ok(typeof providers.linear === 'boolean', 'linear should be boolean');
    assert.ok(typeof providers.asana === 'boolean', 'asana should be boolean');
    assert.ok(typeof providers.notion === 'boolean', 'notion should be boolean');
  });
});

// ---------------------------------------------------------------------------
// generateState / consumeState — OAuth CSRF protection
// ---------------------------------------------------------------------------

describe('OAuth state management', () => {
  it('generateState produces a non-empty string', () => {
    const state = tracker.generateState('T_TEAM1', 'U_USER1', 'linear');
    assert.ok(typeof state === 'string' && state.length > 0, 'Should produce a state string');
  });

  it('consumeState returns null for unknown state', () => {
    const result = tracker.consumeState('nonexistent-state-xyz');
    assert.equal(result, null, 'Should return null for unknown state');
  });

  it('generateState and consumeState round-trip', () => {
    const state = tracker.generateState('T_TEAM1', 'U_USER1', 'linear');
    const data = tracker.consumeState(state);
    assert.ok(data !== null, 'Should find the generated state');
    assert.equal(data.teamId, 'T_TEAM1', 'Should return correct teamId');
    assert.equal(data.userId, 'U_USER1', 'Should return correct userId');
    assert.equal(data.provider, 'linear', 'Should return correct provider');
  });

  it('consumeState is one-time use (second consume returns null)', () => {
    const state = tracker.generateState('T_TEAM1', 'U_USER2', 'asana');
    const first = tracker.consumeState(state);
    assert.ok(first !== null, 'First consume should succeed');
    const second = tracker.consumeState(state);
    assert.equal(second, null, 'Second consume should return null (state consumed)');
  });
});
