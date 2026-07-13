// lib/contact-routes.js
// Owns: contact form rate limiting, POST /api/contact-submissions, GET /api/contact-submissions.
// Does NOT own: pageview analytics, error tracking, Slack handlers, or domain pact logic.

const express = require('express');
const { getClientIP } = require('./analytics');
const { registerContact, sendEmail } = require('./email-client');
const { createAdminAuth } = require('./admin-auth');

const requireContactAdmin = createAdminAuth({
  envVars: ['ADMIN_SECRET', 'CONTACT_ADMIN_TOKEN'],
  queryKeys: ['secret', 'token'],
});

// In-memory rate limiter for contact submissions: max 5 per IP per 15 minutes
const contactRateMap = new Map(); // ip -> { count, resetAt }
const CONTACT_RATE_LIMIT = 5;
const CONTACT_RATE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

function checkContactRateLimit(ip) {
  const now = Date.now();
  const entry = contactRateMap.get(ip);
  if (!entry || now > entry.resetAt) {
    contactRateMap.set(ip, { count: 1, resetAt: now + CONTACT_RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= CONTACT_RATE_LIMIT) return false;
  entry.count++;
  return true;
}

// Periodically clean expired entries (every 30 min)
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of contactRateMap) {
    if (now > entry.resetAt) contactRateMap.delete(ip);
  }
}, 30 * 60 * 1000).unref();

function registerContactRoutes(app, pool) {
  app.use(express.json());

  // POST /api/contact-submissions — store a contact form submission
  app.post('/api/contact-submissions', async (req, res) => {
    try {
      const { name, email, message, website } = req.body || {};

      // Honeypot check — bots fill the hidden 'website' field
      if (website && website.length > 0) {
        // Silently reject — don't give bots any signal
        return res.status(201).json({ ok: true });
      }

      // Rate limit by IP
      const clientIP = getClientIP(req) || 'unknown';
      if (!checkContactRateLimit(clientIP)) {
        return res.status(429).json({ error: 'Too many submissions. Please try again later.' });
      }

      if (!name || !email || !message) {
        return res.status(400).json({ error: 'name, email, and message are required' });
      }

      // Basic email format validation
      const atIndex = email.indexOf('@');
      const dotLast = email.lastIndexOf('.');
      if (atIndex < 1 || dotLast < atIndex + 2 || dotLast === email.length - 1) {
        return res.status(400).json({ error: 'Invalid email address' });
      }

      // Sanitize name and message
      const sanitizedName = String(name).trim().substring(0, 255);
      const sanitizedEmail = String(email).trim().toLowerCase().substring(0, 255);
      const sanitizedMessage = String(message).trim().substring(0, 5000);

      if (!sanitizedName || !sanitizedMessage) {
        return res.status(400).json({ error: 'Name and message cannot be empty' });
      }

      await pool.query(
        `INSERT INTO contact_submissions (name, email, message) VALUES ($1, $2, $3)`,
        [sanitizedName, sanitizedEmail, sanitizedMessage]
      );

      registerContact({ email: sanitizedEmail, name: sanitizedName, source: 'contact_form' })
        .catch(e => console.error('[contact] register-contact error:', e.message));

      sendEmail({
        to: process.env.CONTACT_NOTIFY_EMAIL || 'hello@makepact.co',
        subject: `New contact form message from ${sanitizedName}`,
        body: `Name: ${sanitizedName}\nEmail: ${sanitizedEmail}\n\n${sanitizedMessage}`,
        html: `<p><strong>Name:</strong> ${sanitizedName.replace(/</g,'&lt;')}</p><p><strong>Email:</strong> <a href="mailto:${sanitizedEmail}">${sanitizedEmail}</a></p><p style="white-space:pre-wrap">${sanitizedMessage.replace(/</g,'&lt;')}</p>`,
      }).catch(e => console.error('[contact] email-notify error:', e.message));

      res.status(201).json({ ok: true });
    } catch (err) {
      console.error('Contact submission error:', err.message);
      res.status(500).json({ error: 'Failed to save contact submission' });
    }
  });

  // GET /api/contact-submissions — retrieve recent submissions (for monitoring)
  app.get('/api/contact-submissions', requireContactAdmin, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 50, 200);

      const result = await pool.query(
        `SELECT id, name, email, message, read, created_at
         FROM contact_submissions
         ORDER BY created_at DESC
         LIMIT $1`,
        [limit]
      );

      res.json({ submissions: result.rows });
    } catch (err) {
      console.error('Contact retrieval error:', err.message);
      res.status(500).json({ error: 'Failed to retrieve submissions' });
    }
  });
}

module.exports = { registerContactRoutes };
