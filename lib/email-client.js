'use strict';

async function postJson(url, apiKey, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Email provider request failed (${res.status}): ${text}`);
  }

  return res.json().catch(() => ({}));
}

async function sendEmail({ to, subject, body, html }) {
  const url = process.env.EMAIL_SEND_URL;
  if (!url) {
    console.warn('[email] EMAIL_SEND_URL not set; skipping outbound email');
    return { skipped: true };
  }

  return postJson(url, process.env.EMAIL_API_KEY, { to, subject, body, html });
}

async function registerContact({ email, name, source }) {
  const url = process.env.EMAIL_CONTACTS_URL;
  if (!url) return { skipped: true };

  return postJson(url, process.env.EMAIL_API_KEY, { email, name, source });
}

module.exports = { sendEmail, registerContact };
