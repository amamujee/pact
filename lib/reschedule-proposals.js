// lib/reschedule-proposals.js
// Owns: counterparty-initiated reschedule proposal lifecycle.
// Counterparty proposes a new date → creator accepts/declines/counter-proposes → both parties notified.
// Does NOT own: creator-side snooze (lib/slack-handlers.js), pact completion, or billing.

'use strict';

const {
  createRescheduleProposal,
  getProposalById,
  resolveProposal,
  acceptProposal,
  getPendingProposal,
} = require('../db/reschedule-proposals');
const { getPactById } = require('../db/pacts');

// Injected via init()
let formatDate, getUserTimezone, homeTab;

function init(deps) {
  formatDate = deps.formatDate;
  getUserTimezone = deps.getUserTimezone;
  homeTab = deps.homeTab; // lib/home-tab module ref (may be null until after home-tab init)
}

// ---------------------------------------------------------------------------
// "Propose new date" — counterparty taps button, modal opens
// Trigger: action_id = 'propose_reschedule', value = pact_id
// ---------------------------------------------------------------------------

async function handleProposeReschedule({ ack, action, body, client }) {
  await ack();

  const pactId = parseInt(action.value, 10);
  const userId = body.user?.id;
  if (!pactId || !userId || !body.trigger_id) return;

  const pact = await getPactById(pactId);
  if (!pact || pact.status !== 'active') return;

  // Guard: only the counterparty can propose a reschedule
  if (pact.counterparty_slack_id !== userId) return;

  // Default initial date: tomorrow
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);

  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'reschedule_proposal_modal',
        private_metadata: JSON.stringify({
          pactId,
          channelId: body.channel?.id || body.container?.channel_id,
        }),
        title: { type: 'plain_text', text: 'Propose New Date', emoji: true },
        submit: { type: 'plain_text', text: '📅 Send Proposal', emoji: true },
        close: { type: 'plain_text', text: 'Cancel', emoji: true },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Propose a new due date for:*\n_${pact.description}_\n\n<@${pact.creator_slack_id}> will be notified and can accept, decline, or suggest another date.`,
            },
          },
          {
            type: 'input',
            block_id: 'proposed_date_block',
            label: { type: 'plain_text', text: 'Proposed new due date' },
            element: {
              type: 'datepicker',
              action_id: 'proposed_date_input',
              initial_date: tomorrowStr,
              placeholder: { type: 'plain_text', text: 'Select a date' },
            },
          },
        ],
      },
    });
  } catch (err) {
    console.error('[reschedule] Failed to open proposal modal:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Modal submitted — persist proposal, DM the creator
// ---------------------------------------------------------------------------

async function handleRescheduleProposalSubmit({ ack, body, view, client }) {
  await ack();

  let meta;
  try {
    meta = JSON.parse(view.private_metadata);
  } catch {
    return;
  }

  const { pactId } = meta;
  const userId = body.user?.id;
  const proposedDate = view.state?.values?.proposed_date_block?.proposed_date_input?.selected_date;

  if (!pactId || !userId || !proposedDate) return;

  const pact = await getPactById(pactId);
  if (!pact || pact.status !== 'active') {
    // Pact completed between modal open and submit — just silently drop
    return;
  }

  // Guard: only the counterparty can propose
  if (pact.counterparty_slack_id !== userId) return;

  let proposal;
  try {
    proposal = await createRescheduleProposal(pactId, userId, proposedDate);
  } catch (err) {
    console.error('[reschedule] Failed to create proposal:', err.message);
    return;
  }

  // DM the creator with the proposal + Accept / Decline / Counter-propose buttons
  const creatorTz = await getUserTimezone(client, pact.creator_slack_id).catch(() => 'UTC');
  const cpTz = await getUserTimezone(client, userId).catch(() => 'UTC');

  const oldDateStr = pact.due_date ? formatDate(new Date(pact.due_date), creatorTz) : 'no deadline';
  const newDateStr = formatDate(new Date(proposedDate), creatorTz);
  const proposerName = pact.counterparty_name || `<@${userId}>`;

  try {
    const creatorDM = await client.conversations.open({ users: pact.creator_slack_id });
    await client.chat.postMessage({
      channel: creatorDM.channel.id,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `📅 *${proposerName}* is asking to move:\n\n*"${pact.description}"*\n\nFrom *${oldDateStr}* → *${newDateStr}*`,
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: '✅ Accept', emoji: true },
              style: 'primary',
              action_id: 'reschedule_accept',
              value: String(proposal.id),
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: '❌ Decline', emoji: true },
              style: 'danger',
              action_id: 'reschedule_decline',
              value: String(proposal.id),
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: '💬 Counter-propose', emoji: true },
              action_id: 'reschedule_counter',
              value: String(proposal.id),
            },
          ],
        },
      ],
      text: `${proposerName} wants to move "${pact.description}" to ${newDateStr}.`,
    });
  } catch (err) {
    console.error('[reschedule] Failed to DM creator:', err.message);
  }

  // Confirm to proposer
  try {
    const cpDM = await client.conversations.open({ users: userId });
    const newDateForCp = formatDate(new Date(proposedDate), cpTz);
    await client.chat.postMessage({
      channel: cpDM.channel.id,
      text: `✅ Your proposal to move *"${pact.description}"* to *${newDateForCp}* has been sent to <@${pact.creator_slack_id}>. I'll let you know when they respond.`,
    });
  } catch (err) {
    // Non-fatal — proposer will see the ack but won't get the confirmation DM
    console.error('[reschedule] Failed to confirm to proposer:', err.message);
  }

  // Refresh home tab for both parties
  if (homeTab) {
    homeTab.publishHomeTab(client, pact.creator_slack_id, { bustCache: true }).catch(() => {});
    homeTab.publishHomeTab(client, userId, { bustCache: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Creator accepts the proposal
// ---------------------------------------------------------------------------

async function handleRescheduleAccept({ ack, action, body, client }) {
  await ack();

  const proposalId = parseInt(action.value, 10);
  const userId = body.user?.id;
  if (!proposalId || !userId) return;

  let result;
  try {
    result = await acceptProposal(proposalId, userId);
  } catch (err) {
    console.error('[reschedule] acceptProposal error:', err.message);
    return;
  }

  if (!result) {
    // Already resolved (double-click or race condition) — silently ignore
    return;
  }

  const { proposal, pact } = result;
  if (!pact) {
    // Pact completed between query and accept — unusual but possible
    return;
  }

  const creatorTz = await getUserTimezone(client, pact.creator_slack_id).catch(() => 'UTC');
  const cpTz = await getUserTimezone(client, proposal.proposed_by).catch(() => 'UTC');
  const newDateForCreator = formatDate(new Date(proposal.proposed_date), creatorTz);
  const newDateForCp = formatDate(new Date(proposal.proposed_date), cpTz);

  // Confirm to the creator (the one who just clicked Accept)
  const channelId = body.channel?.id || body.container?.channel_id;
  if (channelId) {
    try {
      await client.chat.postEphemeral({
        token: process.env.SLACK_BOT_TOKEN,
        channel: channelId,
        user: userId,
        text: `✅ Done — *"${pact.description}"* is now due *${newDateForCreator}*.`,
      });
    } catch (err) {
      console.error('[reschedule] Failed to send accept ephemeral:', err.message);
    }
  }

  // DM the counterparty that their proposal was accepted
  try {
    const cpDM = await client.conversations.open({ users: proposal.proposed_by });
    await client.chat.postMessage({
      channel: cpDM.channel.id,
      text: `✅ <@${pact.creator_slack_id}> accepted your proposal — *"${pact.description}"* is now due *${newDateForCp}*. I'll remind both of you on the new date.`,
    });
  } catch (err) {
    console.error('[reschedule] Failed to DM counterparty on accept:', err.message);
  }

  // Refresh home tab for both parties
  if (homeTab) {
    homeTab.publishHomeTab(client, pact.creator_slack_id, { bustCache: true }).catch(() => {});
    homeTab.publishHomeTab(client, proposal.proposed_by, { bustCache: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Creator declines the proposal
// ---------------------------------------------------------------------------

async function handleRescheduleDecline({ ack, action, body, client }) {
  await ack();

  const proposalId = parseInt(action.value, 10);
  const userId = body.user?.id;
  if (!proposalId || !userId) return;

  const proposal = await getProposalById(proposalId);
  if (!proposal || proposal.status !== 'pending') return;

  const resolved = await resolveProposal(proposalId, userId, 'declined');
  if (!resolved) return; // race — already resolved

  const pact = await getPactById(proposal.pact_id);
  if (!pact) return;

  // Confirm to creator
  const channelId = body.channel?.id || body.container?.channel_id;
  if (channelId) {
    try {
      await client.chat.postEphemeral({
        token: process.env.SLACK_BOT_TOKEN,
        channel: channelId,
        user: userId,
        text: `❌ Declined. The original due date on *"${pact.description}"* stands.`,
      });
    } catch (err) {
      console.error('[reschedule] Failed to send decline ephemeral:', err.message);
    }
  }

  // Notify counterparty of the decline
  try {
    const cpDM = await client.conversations.open({ users: proposal.proposed_by });
    const cpTz = await getUserTimezone(client, proposal.proposed_by).catch(() => 'UTC');
    const originalDate = pact.due_date ? formatDate(new Date(pact.due_date), cpTz) : 'no deadline set';
    await client.chat.postMessage({
      channel: cpDM.channel.id,
      text: `❌ <@${pact.creator_slack_id}> declined your reschedule request — *"${pact.description}"* stays due *${originalDate}*.`,
    });
  } catch (err) {
    console.error('[reschedule] Failed to DM counterparty on decline:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Creator counter-proposes — opens their own date picker modal
// ---------------------------------------------------------------------------

async function handleRescheduleCounter({ ack, action, body, client }) {
  await ack();

  const proposalId = parseInt(action.value, 10);
  const userId = body.user?.id;
  if (!proposalId || !userId || !body.trigger_id) return;

  const proposal = await getProposalById(proposalId);
  if (!proposal || proposal.status !== 'pending') return;

  const pact = await getPactById(proposal.pact_id);
  if (!pact || pact.status !== 'active') return;

  // Guard: only the creator can counter-propose (they are the recipient of the original proposal)
  if (pact.creator_slack_id !== userId) return;

  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);

  const cpName = pact.counterparty_name || `<@${proposal.proposed_by}>`;

  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'reschedule_counter_modal',
        private_metadata: JSON.stringify({
          originalProposalId: proposalId,
          pactId: pact.id,
          channelId: body.channel?.id || body.container?.channel_id,
        }),
        title: { type: 'plain_text', text: 'Counter-propose Date', emoji: true },
        submit: { type: 'plain_text', text: '💬 Send Counter', emoji: true },
        close: { type: 'plain_text', text: 'Cancel', emoji: true },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Suggest a different date to ${cpName}:*\n_${pact.description}_\n\n${cpName} proposed: *${formatDate(new Date(proposal.proposed_date))}*`,
            },
          },
          {
            type: 'input',
            block_id: 'counter_date_block',
            label: { type: 'plain_text', text: 'Your proposed date' },
            element: {
              type: 'datepicker',
              action_id: 'counter_date_input',
              initial_date: tomorrowStr,
              placeholder: { type: 'plain_text', text: 'Select a date' },
            },
          },
        ],
      },
    });
  } catch (err) {
    console.error('[reschedule] Failed to open counter modal:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Counter-proposal modal submitted — decline old proposal, create new one
// ---------------------------------------------------------------------------

async function handleRescheduleCounterSubmit({ ack, body, view, client }) {
  await ack();

  let meta;
  try {
    meta = JSON.parse(view.private_metadata);
  } catch {
    return;
  }

  const { originalProposalId, pactId } = meta;
  const userId = body.user?.id;
  const counterDate = view.state?.values?.counter_date_block?.counter_date_input?.selected_date;

  if (!pactId || !userId || !counterDate) return;

  const pact = await getPactById(pactId);
  if (!pact || pact.status !== 'active') return;

  // Guard: only the creator can counter-propose
  if (pact.creator_slack_id !== userId) return;

  const originalProposal = await getProposalById(originalProposalId);
  if (!originalProposal) return;

  // Mark the original proposal as declined (creator is counter-proposing)
  await resolveProposal(originalProposalId, userId, 'declined').catch(() => {});

  // Create a NEW proposal FROM the creator (they are now the proposer)
  // WHY: Re-using createRescheduleProposal expiry logic keeps state clean.
  // The counterparty (original proposer) now becomes the one who needs to respond.
  // We store this as a new proposal with proposed_by = creator_slack_id, so the
  // counterparty can accept/decline. A bit non-standard — see note below.
  //
  // Note: In this implementation the role of "proposer" is the person who most
  // recently proposed. The Home Tab shows pending proposals to whoever is the pact
  // creator (who sees "awaiting your response"). Counter-proposals flip that flow
  // to a DM-to-counterparty path, which is what users expect.
  let newProposal;
  try {
    newProposal = await createRescheduleProposal(pactId, userId, counterDate);
  } catch (err) {
    console.error('[reschedule] Counter proposal DB error:', err.message);
    return;
  }

  // Notify the counterparty of the counter-proposal
  const counterpartyId = originalProposal.proposed_by;
  const cpTz = await getUserTimezone(client, counterpartyId).catch(() => 'UTC');
  const creatorTz = await getUserTimezone(client, userId).catch(() => 'UTC');
  const newDateForCp = formatDate(new Date(counterDate), cpTz);
  const theirProposedDateStr = formatDate(new Date(originalProposal.proposed_date), cpTz);
  const creatorName = pact.creator_name || `<@${userId}>`;

  try {
    const cpDM = await client.conversations.open({ users: counterpartyId });
    await client.chat.postMessage({
      channel: cpDM.channel.id,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `💬 *${creatorName}* suggested a different date for:\n\n*"${pact.description}"*\n\nYou proposed: *${theirProposedDateStr}* → They propose: *${newDateForCp}*`,
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: '✅ Accept', emoji: true },
              style: 'primary',
              action_id: 'reschedule_accept',
              value: String(newProposal.id),
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: '❌ Decline', emoji: true },
              style: 'danger',
              action_id: 'reschedule_decline',
              value: String(newProposal.id),
            },
          ],
        },
      ],
      text: `${creatorName} counter-proposed ${newDateForCp} for "${pact.description}".`,
    });
  } catch (err) {
    console.error('[reschedule] Failed to DM counterparty on counter-proposal:', err.message);
  }

  // Confirm to creator
  const channelId = meta.channelId;
  if (channelId) {
    try {
      const newDateForCreator = formatDate(new Date(counterDate), creatorTz);
      await client.chat.postEphemeral({
        token: process.env.SLACK_BOT_TOKEN,
        channel: channelId,
        user: userId,
        text: `💬 Counter-proposal sent — you suggested *${newDateForCreator}* to <@${counterpartyId}>. I'll let you know when they respond.`,
      });
    } catch (err) {
      console.error('[reschedule] Failed to confirm counter to creator:', err.message);
    }
  }

  // Refresh home tabs
  if (homeTab) {
    homeTab.publishHomeTab(client, userId, { bustCache: true }).catch(() => {});
    homeTab.publishHomeTab(client, counterpartyId, { bustCache: true }).catch(() => {});
  }
}

module.exports = {
  init,
  handleProposeReschedule,
  handleRescheduleProposalSubmit,
  handleRescheduleAccept,
  handleRescheduleDecline,
  handleRescheduleCounter,
  handleRescheduleCounterSubmit,
};
