// lib/ai-client.js
// Owns: direct Anthropic chat calls used by AI-assisted Pact features.
// Does NOT own: domain logic or Slack handler orchestration.
'use strict';

const Anthropic = require('@anthropic-ai/sdk');

let anthropic;

function getAnthropicClient() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is required for AI features');
  }
  if (!anthropic) {
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropic;
}

/**
 * Simple Claude chat call.
 * @param {string} message - User message content
 * @param {Object} options - { system, maxTokens }
 * @returns {Promise<string>} model text response
 */
async function chat(message, options = {}) {
  const response = await getAnthropicClient().messages.create({
    model: process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-latest',
    max_tokens: options.maxTokens || 1024,
    messages: [{ role: 'user', content: message }],
    system: options.system,
  });
  return response.content[0].text;
}

module.exports = { chat };
