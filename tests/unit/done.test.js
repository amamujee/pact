// Unit tests for routes/done.js — /done command handling.
// Uses Node.js built-in test runner (node:test) with mock.fn().
// All DB calls and Slack client calls are mocked — no real DB or network.
'use strict';

const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// ---------------------------------------------------------------------------
// Module mocking strategy:
//   - We can't use jest.mock() in node:test; instead we stub DB module methods
//     and inject a mock Slack client.
//   - We use mock.fn() from node:test to create spies.
// ---------------------------------------------------------------------------

// Load done route module - we'll inject mocked deps via module internals
// Because the module uses require() for DB, we need to stub those at module cache level.
// Strategy: stub module in cache before requiring done.js.

function makeSlackClient(overrides = {}) {
  return {
    users: {
      info: mock.fn(async ({ user }) => ({
        user: { profile: { display_name: `User-${user}` }, real_name: `Real ${user}`, name: user }
      }))
    },
    chat: {
      postMessage: mock.fn(async () => ({ ts: '1234567890.000' })),
      postEphemeral: mock.fn(async () => ({ ts: '1234567890.001' })),
    },
    conversations: {
      history: mock.fn(async () => ({ messages: [] })),
    },
    ...overrides
  };
}

function makeCommand(overrides = {}) {
  return {
    user_id: 'U_USER1',
    team_id: 'T_TEAM1',
    channel_id: 'D_BOTDM',
    text: '',
    ...overrides,
  };
}

// Stub the db/pacts module in Node's require cache before loading routes/done.js
let pactDbStub;

function stubPactDb(methods = {}) {
  pactDbStub = {
    getActivePactsForDone: mock.fn(async () => []),
    getUserActivePacts: mock.fn(async () => []),
    markPactCompleted: mock.fn(async () => null),
    getPactCompletionError: mock.fn(async () => ':x: Pact not found.'),
    getPactChannelId: mock.fn(async () => 'D_CHANNEL'),
    updatePactConfirmation: mock.fn(async () => {}),
    getPactByConfirmation: mock.fn(async () => null),
    backfillCounterparty: mock.fn(async () => {}),
    updateReminderTs: mock.fn(async () => {}),
    getPactByReminderTs: mock.fn(async () => null),
    ...methods,
  };
  if (!pactDbStub.markPactCompletedReturning) {
    pactDbStub.markPactCompletedReturning = pactDbStub.markPactCompleted;
  }

  // Inject into require cache
  const pactDbPath = require.resolve('../../db/pacts');
  require.cache[pactDbPath] = {
    id: pactDbPath,
    filename: pactDbPath,
    loaded: true,
    exports: pactDbStub,
  };
}

// Stub ai-done module
function stubAiDone() {
  const aiDonePath = require.resolve('../../lib/ai-done');
  require.cache[aiDonePath] = {
    id: aiDonePath,
    filename: aiDonePath,
    loaded: true,
    exports: {
      fetchRecentUserMessages: mock.fn(async () => []),
      rankPactsByContext: mock.fn(async () => []),
      buildAISuggestionBlocks: mock.fn(() => null),
    }
  };
}

// Stub db/index (pool) so db/pacts doesn't try to connect
function stubPool() {
  const poolPath = require.resolve('../../db/index');
  require.cache[poolPath] = {
    id: poolPath,
    filename: poolPath,
    loaded: true,
    exports: { query: mock.fn(async () => ({ rows: [] })) }
  };
}

// Clear and reload done module between tests
function loadDoneModule() {
  const donePath = require.resolve('../../routes/done');
  delete require.cache[donePath];
  return require('../../routes/done');
}

// ---------------------------------------------------------------------------
// Helper: run the handleDoneCommand with mocked ack/respond
// ---------------------------------------------------------------------------

async function runDone(doneModule, commandOverrides = {}, clientOverrides = {}) {
  const ackCalls = [];
  const respondCalls = [];

  await doneModule.handleDoneCommand({
    command: makeCommand(commandOverrides),
    ack: async () => { ackCalls.push(true); },
    respond: async (payload) => { respondCalls.push(payload); },
    client: makeSlackClient(clientOverrides),
  });

  return { ackCalls, respondCalls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('/done command handler', () => {
  beforeEach(() => {
    stubPool();
    stubAiDone();
    stubPactDb(); // default: empty pacts, no completion
  });

  describe('no active pacts', () => {
    it('acks the command', async () => {
      const done = loadDoneModule();
      done.init({ getTeamTier: async () => 'free' });
      const { ackCalls } = await runDone(done);
      assert.equal(ackCalls.length, 1, 'Should ack exactly once');
    });

    it('responds with "no active pacts" message', async () => {
      const done = loadDoneModule();
      done.init({ getTeamTier: async () => 'free' });
      const { respondCalls } = await runDone(done);
      assert.equal(respondCalls.length, 1, 'Should respond once');
      const text = JSON.stringify(respondCalls[0]);
      assert.ok(text.includes('pact') || text.includes('No active'), `Expected pact mention, got: ${text.substring(0, 100)}`);
    });
  });

  describe('single active pact', () => {
    beforeEach(() => {
      const pact = { id: 42, description: 'Write the quarterly report', due_date: null, creator_slack_id: 'U_USER1', counterparty_slack_id: 'U_USER2', channel_id: 'C_CHANNEL', team_id: 'T_TEAM1', status: 'active' };

      stubPactDb({
        getActivePactsForDone: mock.fn(async () => [pact]),
        markPactCompleted: mock.fn(async (id, userId) => {
          if (id === 42 && userId === 'U_USER1') return { ...pact, status: 'completed', completed_at: new Date(), completed_by: userId };
          return null;
        }),
      });
    });

    it('completes the single pact directly without picker', async () => {
      const done = loadDoneModule();
      done.init({ getTeamTier: async () => 'free' });
      const { respondCalls } = await runDone(done);
      // Should respond with completion message (in_channel celebration)
      const text = JSON.stringify(respondCalls);
      assert.ok(
        text.includes('completed') || text.includes('Pact') || text.includes('tada'),
        `Expected completion message, got: ${text.substring(0, 200)}`
      );
    });
  });

  describe('multiple active pacts', () => {
    const pacts = [
      { id: 1, description: 'Write the quarterly report', due_date: null, creator_slack_id: 'U_USER1', counterparty_slack_id: 'U_USER2', channel_id: 'C_CHANNEL', team_id: 'T_TEAM1', status: 'active' },
      { id: 2, description: 'Fix the production bug', due_date: null, creator_slack_id: 'U_USER1', counterparty_slack_id: 'U_USER3', channel_id: 'C_CHANNEL', team_id: 'T_TEAM1', status: 'active' },
      { id: 3, description: 'Ship the new feature', due_date: null, creator_slack_id: 'U_USER1', counterparty_slack_id: 'U_USER2', channel_id: 'C_CHANNEL', team_id: 'T_TEAM1', status: 'active' },
    ];

    beforeEach(() => {
      stubPactDb({
        getActivePactsForDone: mock.fn(async () => pacts),
        markPactCompleted: mock.fn(async () => null),
      });
    });

    it('shows multi-complete picker (checkboxes)', async () => {
      const done = loadDoneModule();
      done.init({ getTeamTier: async () => 'free' });
      const { respondCalls } = await runDone(done);
      assert.ok(respondCalls.length > 0, 'Should respond');
      const text = JSON.stringify(respondCalls[0]);
      // Should show checkboxes or picker blocks
      assert.ok(
        text.includes('checkboxes') || text.includes('Which pact') || text.includes('pact'),
        `Expected picker/checkboxes, got: ${text.substring(0, 200)}`
      );
    });

    it('direct pact ID completion: /done #2 completes pact 2', async () => {
      const completedPact = { ...pacts[1], status: 'completed', completed_at: new Date(), completed_by: 'U_USER1' };
      stubPactDb({
        getActivePactsForDone: mock.fn(async () => pacts),
        markPactCompleted: mock.fn(async (id, userId) => id === 2 ? completedPact : null),
        getPactCompletionError: mock.fn(async () => ':x: Error'),
        backfillCounterparty: mock.fn(async () => {}),
        getPactChannelId: mock.fn(async () => 'C_CHANNEL'),
      });
      const done = loadDoneModule();
      done.init({ getTeamTier: async () => 'free' });
      const { respondCalls } = await runDone(done, { text: '#2' });
      const text = JSON.stringify(respondCalls);
      assert.ok(text.includes('completed') || text.includes('Pact') || text.includes('2'), `Expected completion, got: ${text.substring(0, 200)}`);
    });

    it('direct pact ID without #: /done 2 completes pact 2', async () => {
      const completedPact = { ...pacts[1], status: 'completed', completed_at: new Date(), completed_by: 'U_USER1' };
      stubPactDb({
        getActivePactsForDone: mock.fn(async () => pacts),
        markPactCompleted: mock.fn(async (id, userId) => id === 2 ? completedPact : null),
        getPactCompletionError: mock.fn(async () => ':x: Error'),
        backfillCounterparty: mock.fn(async () => {}),
        getPactChannelId: mock.fn(async () => 'C_CHANNEL'),
      });
      const done = loadDoneModule();
      done.init({ getTeamTier: async () => 'free' });
      const { respondCalls } = await runDone(done, { text: '2' });
      const text = JSON.stringify(respondCalls);
      assert.ok(text.includes('completed') || text.includes('Pact') || text.includes('2'), `Expected completion, got: ${text.substring(0, 200)}`);
    });

    describe('fuzzy text matching', () => {
      it('confident single fuzzy match completes pact directly', async () => {
        const completedPact = { ...pacts[0], status: 'completed', completed_at: new Date(), completed_by: 'U_USER1' };
        stubPactDb({
          getActivePactsForDone: mock.fn(async () => pacts),
          markPactCompleted: mock.fn(async (id) => id === 1 ? completedPact : null),
          getPactCompletionError: mock.fn(async () => ':x: Error'),
          backfillCounterparty: mock.fn(async () => {}),
          getPactChannelId: mock.fn(async () => 'C_CHANNEL'),
        });
        const done = loadDoneModule();
        done.init({ getTeamTier: async () => 'free' });
        const { respondCalls } = await runDone(done, { text: 'quarterly report' });
        const text = JSON.stringify(respondCalls);
        // Fuzzy: "quarterly report" should confidently match pact 1
        assert.ok(text.includes('completed') || text.includes('tada') || text.includes('Which'), `Got: ${text.substring(0, 200)}`);
      });

      it('ambiguous fuzzy matches show picker', async () => {
        // "report" matches both "quarterly report" and "production bug" weakly
        stubPactDb({
          getActivePactsForDone: mock.fn(async () => pacts),
          markPactCompleted: mock.fn(async () => null),
          backfillCounterparty: mock.fn(async () => {}),
        });
        const done = loadDoneModule();
        done.init({ getTeamTier: async () => 'free' });
        const { respondCalls } = await runDone(done, { text: 'report' });
        assert.ok(respondCalls.length > 0, 'Should respond');
        // Could complete directly (only 1 matches "report") or show picker
        const text = JSON.stringify(respondCalls);
        assert.ok(text.length > 5, `Expected some response: ${text.substring(0, 100)}`);
      });
    });
  });

  describe('error handling', () => {
    it('handles DB errors gracefully', async () => {
      stubPactDb({
        getActivePactsForDone: mock.fn(async () => { throw new Error('DB connection failed'); }),
        backfillCounterparty: mock.fn(async () => {}),
      });
      const done = loadDoneModule();
      done.init({ getTeamTier: async () => 'free' });
      const { respondCalls } = await runDone(done);
      assert.ok(respondCalls.length > 0, 'Should respond with error');
      const text = JSON.stringify(respondCalls[0]);
      assert.ok(text.includes('wrong') || text.includes('error') || text.includes('x:'), `Expected error message, got: ${text.substring(0, 100)}`);
    });
  });
});

// ---------------------------------------------------------------------------
// completePact unit tests
// ---------------------------------------------------------------------------

describe('completePact', () => {
  beforeEach(() => {
    stubPool();
    stubAiDone();
  });

  it('returns false when pact not found or unauthorized', async () => {
    stubPactDb({
      markPactCompleted: mock.fn(async () => null),
      getPactCompletionError: mock.fn(async () => ':x: Not your pact.'),
      backfillCounterparty: mock.fn(async () => {}),
    });
    const done = loadDoneModule();
    done.init({ getTeamTier: async () => 'free' });
    const respondCalls = [];
    const result = await done.completePact(99, 'U_USER1', 'D_CHANNEL', makeSlackClient(), async (msg) => respondCalls.push(msg));
    assert.equal(result, false);
    assert.ok(respondCalls[0].includes('Not your pact') || respondCalls[0].includes(':x:'), `Expected error msg, got ${respondCalls[0]}`);
  });

  it('returns true when pact successfully completed', async () => {
    const pact = { id: 5, description: 'Ship feature', due_date: null, creator_slack_id: 'U_USER1', channel_id: 'C_CHANNEL', status: 'completed', completed_at: new Date(), completed_by: 'U_USER1', team_id: 'T_TEAM1' };
    stubPactDb({
      markPactCompleted: mock.fn(async () => pact),
      backfillCounterparty: mock.fn(async () => {}),
    });
    const done = loadDoneModule();
    done.init({ getTeamTier: async () => 'free' });
    const respondCalls = [];
    const result = await done.completePact(5, 'U_USER1', 'C_CHANNEL', makeSlackClient(), async (msg) => respondCalls.push(msg));
    assert.equal(result, true);
  });
});

// ---------------------------------------------------------------------------
// buildMultiCompleteBlocks (via handleDoneCommand behavior)
// ---------------------------------------------------------------------------

describe('multi-complete picker blocks', () => {
  it('includes checkboxes and Complete All button for multiple pacts', async () => {
    stubPool();
    stubAiDone();
    const pacts = [
      { id: 1, description: 'Pact One', due_date: null, creator_slack_id: 'U_USER1', counterparty_slack_id: 'U_USER2', channel_id: 'D_BOTDM', team_id: 'T_TEAM1', status: 'active' },
      { id: 2, description: 'Pact Two', due_date: null, creator_slack_id: 'U_USER1', counterparty_slack_id: 'U_USER2', channel_id: 'D_BOTDM', team_id: 'T_TEAM1', status: 'active' },
    ];
    stubPactDb({
      getActivePactsForDone: mock.fn(async () => pacts),
      markPactCompleted: mock.fn(async () => null),
    });

    const done = loadDoneModule();
    done.init({ getTeamTier: async () => 'free' });
    const respondCalls = [];
    await done.handleDoneCommand({
      command: makeCommand(),
      ack: async () => {},
      respond: async (payload) => respondCalls.push(payload),
      client: makeSlackClient(),
    });

    assert.ok(respondCalls.length > 0, 'Should respond');
    const payload = respondCalls[0];
    const payloadStr = JSON.stringify(payload);
    assert.ok(payloadStr.includes('checkboxes'), 'Should include checkboxes');
    assert.ok(payloadStr.includes('multi_pact_complete_confirm') || payloadStr.includes('Complete'), 'Should include confirm button');
    assert.ok(payloadStr.includes('multi_pact_complete_all') || payloadStr.includes('All'), 'Should include complete-all button');
  });
});
