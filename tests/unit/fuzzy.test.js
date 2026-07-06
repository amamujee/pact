// Unit tests for lib/fuzzy.js — fuzzy pact description matching.
// Uses Node.js built-in test runner (node:test) — no external dependencies.
'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { fuzzyMatchPacts, scoreMatch, levenshtein, tokenize } = require('../../lib/fuzzy');

// ---------------------------------------------------------------------------
// levenshtein
// ---------------------------------------------------------------------------

describe('levenshtein', () => {
  it('returns 0 for identical strings', () => {
    assert.equal(levenshtein('hello', 'hello'), 0);
  });

  it('returns string length for empty target', () => {
    assert.equal(levenshtein('hello', ''), 5);
  });

  it('returns string length for empty source', () => {
    assert.equal(levenshtein('', 'hello'), 5);
  });

  it('computes single substitution', () => {
    assert.equal(levenshtein('cat', 'bat'), 1);
  });

  it('computes insertions', () => {
    assert.equal(levenshtein('abc', 'abcd'), 1);
  });

  it('computes deletions', () => {
    assert.equal(levenshtein('abcd', 'abc'), 1);
  });
});

// ---------------------------------------------------------------------------
// tokenize
// ---------------------------------------------------------------------------

describe('tokenize', () => {
  it('lowercases and splits on whitespace', () => {
    assert.deepEqual(tokenize('Hello World'), ['hello', 'world']);
  });

  it('removes punctuation', () => {
    assert.deepEqual(tokenize('hello, world!'), ['hello', 'world']);
  });

  it('filters empty tokens', () => {
    const result = tokenize('  foo   bar  ');
    assert.deepEqual(result, ['foo', 'bar']);
  });

  it('handles empty string', () => {
    assert.deepEqual(tokenize(''), []);
  });
});

// ---------------------------------------------------------------------------
// scoreMatch
// ---------------------------------------------------------------------------

describe('scoreMatch', () => {
  it('exact substring match scores 1.0', () => {
    const score = scoreMatch('quarterly report', 'Write the quarterly report by Friday');
    assert.equal(score, 1.0);
  });

  it('exact match regardless of case scores 1.0', () => {
    const score = scoreMatch('QUARTERLY REPORT', 'Write the quarterly report by Friday');
    assert.equal(score, 1.0);
  });

  it('no match returns low score', () => {
    const score = scoreMatch('xyzzy nonsense', 'Write the quarterly report by Friday');
    assert.ok(score < 0.3, `Expected < 0.3, got ${score}`);
  });

  it('abbreviation matching works for "dr" → "doctor"', () => {
    // "dr" should match tokens starting with 'd' where subsequence exists
    const score = scoreMatch('dr one', 'deliver feature one to doctor');
    assert.ok(score > 0.2, `Expected > 0.2, got ${score}`);
  });

  it('prefix match for partial tokens', () => {
    const score = scoreMatch('repo', 'Submit the report by end of week');
    assert.ok(score > 0.3, `Expected > 0.3, got ${score}`);
  });

  it('typo tolerance via Levenshtein', () => {
    const score = scoreMatch('reprot', 'Write the report');
    assert.ok(score > 0.2, `Expected typo tolerance, got ${score}`);
  });

  it('returns 1.0 for empty query (empty string is substring of everything)', () => {
    // WHY: the code uses String.includes() — empty string is always a substring.
    // This is a documented behavior of the implementation.
    const score = scoreMatch('', 'Write the report');
    assert.equal(score, 1.0);
  });

  it('exact substring "to" scores 1.0 (substring match takes priority)', () => {
    // "to" is a substring of "submit the report to the manager" → exact match → 1.0
    const score = scoreMatch('to', 'submit the report to the manager');
    assert.equal(score, 1.0);
  });
});

// ---------------------------------------------------------------------------
// fuzzyMatchPacts
// ---------------------------------------------------------------------------

describe('fuzzyMatchPacts', () => {
  const pacts = [
    { id: 1, description: 'Write the quarterly report by Friday' },
    { id: 2, description: 'Fix the production bug in checkout' },
    { id: 3, description: 'Ship the new feature by end of month' },
    { id: 4, description: 'Review the design mockups with the team' },
    { id: 5, description: 'Deliver the doctor report to the client' },
  ];

  it('returns empty array for empty query', () => {
    assert.deepEqual(fuzzyMatchPacts('', pacts), []);
  });

  it('returns empty array for null query', () => {
    assert.deepEqual(fuzzyMatchPacts(null, pacts), []);
  });

  it('finds exact substring match first', () => {
    const results = fuzzyMatchPacts('quarterly report', pacts);
    assert.ok(results.length > 0, 'Should find at least one match');
    assert.equal(results[0].pact.id, 1);
    assert.equal(results[0].score, 1.0);
  });

  it('finds production bug match', () => {
    const results = fuzzyMatchPacts('production bug', pacts);
    assert.ok(results.length > 0, 'Should find a match');
    assert.equal(results[0].pact.id, 2);
  });

  it('sorts results by score descending', () => {
    const results = fuzzyMatchPacts('report', pacts);
    for (let i = 1; i < results.length; i++) {
      assert.ok(
        results[i - 1].score >= results[i].score,
        `Score at ${i - 1} should be >= score at ${i}`
      );
    }
  });

  it('filters out very low score matches (score <= 0.2)', () => {
    const results = fuzzyMatchPacts('xyzzy nothing matches', pacts);
    assert.equal(results.length, 0);
  });

  it('fuzzy match for "/done quarterly" finds the quarterly report pact', () => {
    // Simulates a user typing partial description after /done
    const results = fuzzyMatchPacts('quarterly', pacts);
    const qPact = results.find(r => r.pact.id === 1);
    assert.ok(qPact, 'Should find quarterly report pact by keyword');
    assert.ok(qPact.score >= 0.6, `Expected high confidence score, got ${qPact.score}`);
  });

  it('fuzzy match for "production" finds the production bug pact', () => {
    const results = fuzzyMatchPacts('production', pacts);
    const prodPact = results.find(r => r.pact.id === 2);
    assert.ok(prodPact, 'Should find production bug pact');
  });

  it('handles pacts with empty descriptions gracefully', () => {
    const edgePacts = [{ id: 99, description: '' }];
    const results = fuzzyMatchPacts('something', edgePacts);
    assert.equal(results.length, 0);
  });

  it('returns results with both pact and score fields', () => {
    const results = fuzzyMatchPacts('quarterly', pacts);
    assert.ok(results.length > 0, 'Should have results');
    assert.ok('pact' in results[0], 'Each result should have pact field');
    assert.ok('score' in results[0], 'Each result should have score field');
    assert.ok(typeof results[0].score === 'number', 'score should be a number');
  });
});
