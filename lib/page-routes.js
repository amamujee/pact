// lib/page-routes.js
// Owns: static page route registrations and favicon redirect

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

  // Slack App Directory listing page — mirrors directory format, pre-positions for directory submission
  app.get('/slack-app-directory', (req, res) => {
    res.sendFile(path.join(publicDir, 'slack-app-directory.html'));
  });
}

module.exports = { registerPageRoutes };
