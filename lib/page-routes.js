// lib/page-routes.js
// Owns: static page route registrations (privacy, terms, billing pages, favicon redirect)
// Does NOT own: billing API, metrics, Slack handlers, tracker routes

'use strict';

const path = require('path');

function registerPageRoutes(app) {
  // Redirect /favicon.ico to the PNG favicon (avoids 404 in browsers that fall back from SVG)
  app.get('/favicon.ico', (req, res) => {
    res.redirect(301, '/logo-36.png');
  });

  // Public dir is one level up from lib/
  const publicDir = path.join(__dirname, '..', 'public');

  // Support page — required by Slack App Directory submission
  app.get('/support', (req, res) => {
    res.sendFile(path.join(publicDir, 'support.html'));
  });

  // Privacy policy — served at /privacy (the HTML file is privacy.html)
  app.get('/privacy', (req, res) => {
    res.sendFile(path.join(publicDir, 'privacy.html'));
  });

  // Terms of service — served at /terms
  app.get('/terms', (req, res) => {
    res.sendFile(path.join(publicDir, 'terms.html'));
  });

  // Subscription success page — after Stripe checkout redirect
  app.get('/subscription/success', (req, res) => {
    res.sendFile(path.join(publicDir, 'subscription-success.html'));
  });

  // /success — Stripe Payment Link redirects here after checkout completion.
  // Serves the same subscription-success page which handles auto-activation
  // via the pact_checkout_ctx cookie set before the Stripe redirect.
  app.get('/success', (req, res) => {
    res.sendFile(path.join(publicDir, 'subscription-success.html'));
  });

  // /billing — billing management page (fallback when portal session unavailable)
  app.get('/billing', (req, res) => {
    res.sendFile(path.join(publicDir, 'billing.html'));
  });

  // /billing-return — return destination after Stripe Billing Portal session
  app.get('/billing-return', (req, res) => {
    res.sendFile(path.join(publicDir, 'billing-return.html'));
  });

  // Slack App Directory listing page — mirrors directory format, pre-positions for directory submission
  app.get('/slack-app-directory', (req, res) => {
    res.sendFile(path.join(publicDir, 'slack-app-directory.html'));
  });
}

module.exports = { registerPageRoutes };
