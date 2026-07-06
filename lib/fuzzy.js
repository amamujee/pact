// Lightweight fuzzy matching for pact descriptions.
// Owns: token-based matching, substring scoring, Levenshtein distance.
// Does NOT own: pact queries, Slack UI, or command parsing.

/**
 * Compute Levenshtein distance between two strings.
 */
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

/**
 * Tokenize a string: lowercase, split on whitespace and punctuation.
 */
function tokenize(str) {
  return str.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

/**
 * Score how well a query matches a pact description.
 * Returns 0-1 where 1 is a perfect match.
 *
 * Strategy:
 * 1. Exact substring match → 1.0
 * 2. Token containment (all query tokens appear in description) → 0.8-0.9
 * 3. Partial token matching with Levenshtein tolerance → 0.4-0.7
 * 4. Prefix matching on tokens → 0.3-0.6
 */
function scoreMatch(query, description) {
  const queryLower = query.toLowerCase().trim();
  const descLower = description.toLowerCase().trim();

  // Exact substring match
  if (descLower.includes(queryLower)) {
    return 1.0;
  }

  const queryTokens = tokenize(query);
  const descTokens = tokenize(description);

  if (queryTokens.length === 0 || descTokens.length === 0) return 0;

  let matchedTokens = 0;
  let totalScore = 0;

  for (const qt of queryTokens) {
    let bestTokenScore = 0;

    for (const dt of descTokens) {
      // Exact token match
      if (dt === qt) {
        bestTokenScore = 1.0;
        break;
      }

      // Substring containment (query token is part of a description token)
      // WHY: Require the shorter string to be at least 40% of the longer one
      // to avoid false positives like "do" matching "doctor"
      if (dt.includes(qt) || qt.includes(dt)) {
        const ratio = Math.min(qt.length, dt.length) / Math.max(qt.length, dt.length);
        if (ratio >= 0.4) {
          bestTokenScore = Math.max(bestTokenScore, 0.7 + (ratio * 0.2));
          continue;
        }
      }

      // Prefix match (user typed beginning of a word)
      // WHY: Only match when the shorter token is a prefix of the longer one,
      // and the shorter must be at least 3 chars to avoid false positives like "do"→"doctor"
      const shorter = qt.length <= dt.length ? qt : dt;
      const longer = qt.length <= dt.length ? dt : qt;
      if (shorter.length >= 3 && longer.startsWith(shorter)) {
        const ratio = shorter.length / longer.length;
        bestTokenScore = Math.max(bestTokenScore, 0.6 + (ratio * 0.2));
        continue;
      }

      // Abbreviation match: short query token shares first char with longer desc token
      // WHY: "dr" → "doctor", "inv" → "invoice" — common natural language abbreviations
      if (qt.length >= 2 && dt.length > qt.length && dt[0] === qt[0]) {
        // Check how many chars from query appear in order within desc token
        let matchPos = 0;
        for (let i = 0; i < dt.length && matchPos < qt.length; i++) {
          if (dt[i] === qt[matchPos]) matchPos++;
        }
        if (matchPos === qt.length) {
          // All chars of query appear in sequence in desc token
          const ratio = qt.length / dt.length;
          bestTokenScore = Math.max(bestTokenScore, 0.5 + (ratio * 0.3));
          continue;
        }
      }

      // Levenshtein distance — allow typos
      if (qt.length >= 3) {
        const dist = levenshtein(qt, dt);
        const maxDist = Math.floor(Math.max(qt.length, dt.length) * 0.4);
        if (dist <= maxDist) {
          const score = 1 - (dist / Math.max(qt.length, dt.length));
          bestTokenScore = Math.max(bestTokenScore, score * 0.7);
        }
      }
    }

    // Downweight very short tokens (stop words like "to", "a", "in")
    const tokenWeight = qt.length <= 2 ? 0.3 : 1.0;
    if (bestTokenScore > 0.2) matchedTokens++;
    totalScore += bestTokenScore * tokenWeight;
  }

  // Weight by proportion of query tokens matched
  const coverageRatio = matchedTokens / queryTokens.length;
  const totalWeight = queryTokens.reduce((sum, qt) => sum + (qt.length <= 2 ? 0.3 : 1.0), 0);
  const avgScore = totalScore / totalWeight;

  return avgScore * coverageRatio;
}

/**
 * Fuzzy-match a query against a list of pacts.
 * Returns matches sorted by score (descending), filtered to score > 0.2.
 */
function fuzzyMatchPacts(query, pacts) {
  if (!query || query.trim().length === 0) return [];

  const scored = pacts.map(pact => ({
    pact,
    score: scoreMatch(query, pact.description)
  }));

  return scored
    .filter(m => m.score > 0.2)
    .sort((a, b) => b.score - a.score);
}

module.exports = { fuzzyMatchPacts, scoreMatch, levenshtein, tokenize };
