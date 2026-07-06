// lib/counterparty.js
// Owns: DM counterparty detection (bot vs peer), counterparty backfill on interaction,
//       display-time resolution of null counterparties via DB cross-ref and Slack API.
// Does NOT own: pact creation/completion logic, Slack command handling, analytics, or helpers beyond getUserName.

const { getUserName } = require('./helpers');

// Sentinel returned when the DM is between the user and the Pact bot (no human counterparty).
const BOT_DM = '__BOT_DM__';
// Sentinel returned when we detect a 2-person DM but can't identify the counterparty
// (Slack Bot API can't read members of DMs the bot isn't in).
const PEER_DM = '__PEER_DM__';

// getDMCounterparty accepts botUserId as a 4th param so callers pass in the
// module-level value from server.js rather than this module holding its own copy.
async function getDMCounterparty(client, channelId, currentUserId, botUserId) {
  // Strategy 1: Try conversations.members (works for DMs the bot IS in, e.g. bot DMs)
  try {
    const result = await client.conversations.members({ channel: channelId });
    // Filter out Slackbot and the Pact bot itself
    const humans = result.members.filter(m => {
      if (m === 'USLACKBOT') return false;
      if (botUserId && m === botUserId) return false;
      return true;
    });
    console.log(`getDMCounterparty[S1]: members=${result.members.length}, humans=${humans.length} for channel=${channelId}`);
    // Only current user remaining → this is a bot DM
    if (humans.length === 1 && humans[0] === currentUserId) return BOT_DM;
    if (humans.length !== 2) return null;
    return humans.find(m => m !== currentUserId) || null;
  } catch (err) {
    // channel_not_found: bot can't see this DM (expected for 2-person DMs)
    console.log(`getDMCounterparty[S1]: conversations.members failed (${err.data?.error || err.message}), trying fallbacks`);
  }

  // Strategy 2: Try conversations.info — for im channels it returns a `user` field
  try {
    const info = await client.conversations.info({ channel: channelId });
    if (info.channel && info.channel.is_im && info.channel.user) {
      const otherUser = info.channel.user;
      console.log(`getDMCounterparty[S2]: is_im=true, user=${otherUser}, currentUser=${currentUserId}, botUser=${botUserId}`);
      // If the "other user" is our bot, this is a bot DM
      if (botUserId && otherUser === botUserId) return BOT_DM;
      // If the user field equals the command invoker, this is ambiguous —
      // Slack may return the invoker as the `user` for DMs the bot can't fully read.
      // Fall through to Strategy 3 for definitive bot-DM check instead of
      // incorrectly classifying a real 2-person DM as a bot DM.
      if (otherUser === currentUserId) {
        console.log(`getDMCounterparty[S2]: user===currentUser, ambiguous — deferring to S3`);
        // Fall through to Strategy 3
      } else {
        return otherUser;
      }
    } else {
      console.log(`getDMCounterparty[S2]: conversations.info returned non-im or missing user field`);
    }
  } catch (err) {
    console.log(`getDMCounterparty[S2]: conversations.info failed (${err.data?.error || err.message}), trying final fallback`);
  }

  // Strategy 3: Bot can't see this DM — distinguish bot DM from peer DM
  // by comparing channel IDs with the bot's own DM to this user
  try {
    const botDm = await client.conversations.open({ users: currentUserId });
    console.log(`getDMCounterparty[S3]: botDm.channel.id=${botDm.channel?.id}, channelId=${channelId}`);
    if (botDm.channel.id === channelId) {
      return BOT_DM;
    }
    // Different channel → user is in a 1:1 DM with another human (not the bot)
    return PEER_DM;
  } catch (err) {
    // If we reach here, Strategies 1 and 2 already failed to identify a bot DM.
    // The bot IS always a member of its own DMs, so if S1 failed with
    // channel_not_found, this channel is NOT a bot DM — it's a peer DM.
    // Return PEER_DM (safe default) instead of null (which rejects the command).
    console.error(`getDMCounterparty[S3]: conversations.open failed (${err.data?.error || err.message}), defaulting to PEER_DM`);
    return PEER_DM;
  }
}

// ---------------------------------------------------------------------------
// Counterparty Backfill
// ---------------------------------------------------------------------------
// When the bot can't resolve the counterparty at pact creation (PEER_DM),
// we backfill the counterparty when they interact with the pact later.
async function backfillCounterparty(channelId, userId, client, pool) {
  try {
    const result = await pool.query(
      `SELECT id, creator_slack_id FROM pacts
       WHERE channel_id = $1 AND counterparty_slack_id IS NULL AND status = 'active'`,
      [channelId]
    );
    if (result.rows.length === 0) return;

    // If the current user is NOT the creator, they must be the counterparty
    const toUpdate = result.rows.filter(p => p.creator_slack_id !== userId);
    if (toUpdate.length === 0) return;

    const userName = await getUserName(client, userId);
    for (const pact of toUpdate) {
      await pool.query(
        `UPDATE pacts SET counterparty_slack_id = $1, counterparty_name = $2 WHERE id = $3`,
        [userId, userName, pact.id]
      );
      console.log(`[BACKFILL] Pact #${pact.id}: counterparty set to ${userId} (${userName})`);
    }
  } catch (err) {
    console.error('Counterparty backfill error:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Counterparty Resolution (display-time)
// ---------------------------------------------------------------------------
// Resolves null counterparty_slack_id by:
// 1. Cross-referencing other pacts in the same channel (DB lookup)
// 2. Trying conversations.members via Slack API (works if bot is now in the channel)
// 3. Trying conversations.info via Slack API
// Updates pacts in-place and backfills DB.
async function resolveNullCounterparties(pacts, currentUserId, client, pool, botUserId) {
  const unknownPacts = pacts.filter(p => !p.counterparty_slack_id);
  if (unknownPacts.length === 0) return;

  const unknownChannels = [...new Set(unknownPacts.map(p => p.channel_id))];

  // Strategy 1: Cross-reference DB — find other known users in the same channels
  try {
    const result = await pool.query(
      `SELECT channel_id, creator_slack_id, counterparty_slack_id
       FROM pacts
       WHERE channel_id = ANY($1)`,
      [unknownChannels]
    );

    const channelUsers = {};
    for (const row of result.rows) {
      if (!channelUsers[row.channel_id]) channelUsers[row.channel_id] = new Set();
      if (row.creator_slack_id) channelUsers[row.channel_id].add(row.creator_slack_id);
      if (row.counterparty_slack_id) channelUsers[row.channel_id].add(row.counterparty_slack_id);
    }

    for (const pact of unknownPacts) {
      if (pact.counterparty_slack_id) continue;
      const users = channelUsers[pact.channel_id];
      if (!users) continue;
      const others = [...users].filter(u => u !== pact.creator_slack_id);
      if (others.length === 1) {
        pact.counterparty_slack_id = others[0];
        if (client) {
          try { pact.counterparty_name = await getUserName(client, others[0]); } catch {}
        }
        pool.query(
          'UPDATE pacts SET counterparty_slack_id = $1, counterparty_name = $2 WHERE id = $3 AND counterparty_slack_id IS NULL',
          [pact.counterparty_slack_id, pact.counterparty_name || null, pact.id]
        ).catch(() => {});
        console.log(`[RESOLVE] Pact #${pact.id}: counterparty resolved via DB cross-ref to ${pact.counterparty_slack_id}`);
      }
    }
  } catch (err) {
    console.error('Counterparty DB cross-ref error:', err.message);
  }

  // Strategy 2: Try Slack API for remaining unresolved
  if (!client) return;
  for (const pact of unknownPacts) {
    if (pact.counterparty_slack_id) continue;
    // Try conversations.members
    try {
      const membersResult = await client.conversations.members({ channel: pact.channel_id });
      const humans = membersResult.members.filter(m => m !== 'USLACKBOT' && (!botUserId || m !== botUserId));
      const other = humans.find(m => m !== pact.creator_slack_id);
      if (other) {
        const name = await getUserName(client, other);
        pact.counterparty_slack_id = other;
        pact.counterparty_name = name;
        pool.query(
          'UPDATE pacts SET counterparty_slack_id = $1, counterparty_name = $2 WHERE id = $3 AND counterparty_slack_id IS NULL',
          [other, name, pact.id]
        ).catch(() => {});
        console.log(`[RESOLVE] Pact #${pact.id}: counterparty resolved via conversations.members to ${other}`);
        continue;
      }
    } catch {}
    // Try conversations.info
    try {
      const info = await client.conversations.info({ channel: pact.channel_id });
      if (info.channel && info.channel.is_im && info.channel.user) {
        const otherUser = info.channel.user;
        if (otherUser !== pact.creator_slack_id && otherUser !== botUserId) {
          const name = await getUserName(client, otherUser);
          pact.counterparty_slack_id = otherUser;
          pact.counterparty_name = name;
          pool.query(
            'UPDATE pacts SET counterparty_slack_id = $1, counterparty_name = $2 WHERE id = $3 AND counterparty_slack_id IS NULL',
            [otherUser, name, pact.id]
          ).catch(() => {});
          console.log(`[RESOLVE] Pact #${pact.id}: counterparty resolved via conversations.info to ${otherUser}`);
        }
      }
    } catch {}
  }
}

module.exports = { BOT_DM, PEER_DM, getDMCounterparty, backfillCounterparty, resolveNullCounterparties };
