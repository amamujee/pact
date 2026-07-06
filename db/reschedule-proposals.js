// db/reschedule-proposals.js
// Owns: reschedule_proposals table — counterparty-initiated date-change requests.
// Does NOT own: pact status transitions (markPactCompleted), reminders, or billing.

'use strict';

const pool = require('./index');

/**
 * Create a new pending reschedule proposal.
 * Returns the new proposal row (with id, pact_id, proposed_by, proposed_date, status).
 */
async function createRescheduleProposal(pactId, proposedBy, proposedDate) {
  // Expire any existing pending proposals for this pact before creating a new one.
  // WHY: Only one active proposal at a time prevents notification storms. Old
  // proposals are marked declined so the audit trail is complete.
  await pool.query(
    `UPDATE reschedule_proposals
     SET status = 'declined', resolved_at = NOW(), resolved_by = $1
     WHERE pact_id = $2 AND status = 'pending'`,
    [proposedBy, pactId]
  );

  const result = await pool.query(
    `INSERT INTO reschedule_proposals (pact_id, proposed_by, proposed_date)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [pactId, proposedBy, proposedDate]
  );
  return result.rows[0];
}

/**
 * Fetch the single pending proposal for a pact, or null if none.
 */
async function getPendingProposal(pactId) {
  const result = await pool.query(
    `SELECT * FROM reschedule_proposals
     WHERE pact_id = $1 AND status = 'pending'
     ORDER BY created_at DESC
     LIMIT 1`,
    [pactId]
  );
  return result.rows[0] || null;
}

/**
 * Fetch a proposal by its ID (used to resolve action callbacks).
 */
async function getProposalById(proposalId) {
  const result = await pool.query(
    `SELECT * FROM reschedule_proposals WHERE id = $1 LIMIT 1`,
    [proposalId]
  );
  return result.rows[0] || null;
}

/**
 * Mark a proposal accepted or declined.
 * Returns the updated row, or null if it was already resolved (idempotent guard).
 */
async function resolveProposal(proposalId, resolvedBy, status) {
  const result = await pool.query(
    `UPDATE reschedule_proposals
     SET status = $1, resolved_at = NOW(), resolved_by = $2
     WHERE id = $3 AND status = 'pending'
     RETURNING *`,
    [status, resolvedBy, proposalId]
  );
  return result.rows[0] || null;
}

/**
 * Accept a proposal: update the pact due_date, reset last_reminded_at,
 * and mark the proposal accepted — all in one transaction.
 * Returns { proposal, pact } on success, null if proposal was already resolved.
 */
async function acceptProposal(proposalId, acceptedBy) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock + resolve the proposal
    const proposalResult = await client.query(
      `UPDATE reschedule_proposals
       SET status = 'accepted', resolved_at = NOW(), resolved_by = $1
       WHERE id = $2 AND status = 'pending'
       RETURNING *`,
      [acceptedBy, proposalId]
    );
    const proposal = proposalResult.rows[0];
    if (!proposal) {
      await client.query('ROLLBACK');
      return null; // already resolved — idempotent
    }

    // Update the pact's due_date and reset reminder cadence
    const pactResult = await client.query(
      `UPDATE pacts
       SET due_date = $1, last_reminded_at = NOW()
       WHERE id = $2 AND status = 'active'
       RETURNING *`,
      [proposal.proposed_date, proposal.pact_id]
    );
    const pact = pactResult.rows[0];

    await client.query('COMMIT');
    return { proposal, pact };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Fetch all pending proposals for pacts where the given user is the creator.
 * Used to show "awaiting your response" indicators on the Home Tab.
 */
async function getPendingProposalsForCreator(creatorUserId) {
  const result = await pool.query(
    `SELECT rp.*, p.description, p.due_date AS current_due_date,
            p.counterparty_name, p.creator_slack_id
     FROM reschedule_proposals rp
     JOIN pacts p ON p.id = rp.pact_id
     WHERE p.creator_slack_id = $1
       AND rp.status = 'pending'
       AND p.status = 'active'
     ORDER BY rp.created_at DESC`,
    [creatorUserId]
  );
  return result.rows;
}

module.exports = {
  createRescheduleProposal,
  getPendingProposal,
  getProposalById,
  resolveProposal,
  acceptProposal,
  getPendingProposalsForCreator,
};
