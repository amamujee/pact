// routes/activate.js
// Owns: activation DM click tracking redirect.
// Does NOT own: pact modal UI or Slack action handling.

'use strict';

const express = require('express');
const { markActivationDmClicked, recordActivationEvent, logActivationDelivery } = require('../db/user-activation');
const { getAppUrl } = require('../lib/app-url');

const router = express.Router();

const APP_BASE_URL = process.env.APP_BASE_URL || getAppUrl();

/**
 * GET /activate?ref=activation_dm&user_id=X&team_id=Y&ts=...
 *
 * Redirect target for UTM-tagged buttons in the activation DM.
 * Logs the click to activation_events + populates activation_dm_clicked_at,
 * then redirects to the homepage with a client-side modal trigger param.
 *
 * The client (public/index.html or Slack deeplink) reads ?open_activation=true
 * and triggers the pact creation modal if the user_id matches.
 */
router.get('/', async (req, res) => {
  const { user_id: userId, team_id: teamId, ts } = req.query;

  // Basic validation — we need at least user_id and team_id to attribute the click
  if (!userId || !teamId) {
    console.warn('[ACTIVATE] Missing params — redirecting to app');
    return res.redirect(APP_BASE_URL);
  }

  try {
    // Idempotent: markActivationDmClicked only records the first click per user
    await markActivationDmClicked(teamId, userId);
    await recordActivationEvent(teamId, userId, 'activation_dm_clicked', {
      ts: ts || null,
      ref: req.query.ref || 'activation_dm',
      source: 'utm_redirect',
    });

    console.log(`[ACTIVATE] Click logged user=${userId} team=${teamId}`);
  } catch (err) {
    console.error('[ACTIVATE] Failed to log click:', err.message);
    // Don't block the redirect — log and move on
  }

  // Redirect to homepage with client-side modal trigger
  // The frontend reads ?open_activation=true and ?user_id=... to open the modal
  const redirectUrl = `${APP_BASE_URL}/?open_activation=true&user_id=${encodeURIComponent(userId)}&team_id=${encodeURIComponent(teamId)}`;
  res.redirect(302, redirectUrl);
});

module.exports = router;
