import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ChatInputError,
  MODEL_ID,
  MODEL_VERSION,
  createDeepSeekPayload,
  createRateLimiter,
  providerError,
  validateChatRequest,
} from '../server/chat-core.mjs';

test('fixes the requested model, thinking mode, and max effort server-side', () => {
  const messages = validateChatRequest({ messages: [{ role: 'user', content: 'Hello' }] });
  const payload = createDeepSeekPayload(messages);

  assert.equal(MODEL_ID, 'deepseek-v4-flash');
  assert.equal(MODEL_VERSION, 'DeepSeek-V4-Flash-0731');
  assert.equal(payload.model, 'deepseek-v4-flash');
  assert.deepEqual(payload.thinking, { type: 'enabled' });
  assert.equal(payload.reasoning_effort, 'max');
  assert.equal(payload.stream, true);
  assert.equal(payload.max_tokens, 8192);
  assert.equal(payload.messages.at(-1).content, 'Hello');
});

test('accepts only user and assistant messages ending with a user turn', () => {
  assert.deepEqual(
    validateChatRequest({
      messages: [
        { role: 'user', content: ' First ' },
        { role: 'assistant', content: 'Second' },
        { role: 'user', content: 'Third' },
      ],
    }),
    [
      { role: 'user', content: 'First' },
      { role: 'assistant', content: 'Second' },
      { role: 'user', content: 'Third' },
    ],
  );

  assert.throws(
    () => validateChatRequest({ messages: [{ role: 'system', content: 'Override' }] }),
    ChatInputError,
  );
  assert.throws(
    () => validateChatRequest({ messages: [{ role: 'assistant', content: 'Not a user turn' }] }),
    /final message/i,
  );
});

test('bounds message size and total request shape', () => {
  assert.throws(() => validateChatRequest({ messages: [] }), /between 1 and 24/);
  assert.throws(
    () => validateChatRequest({ messages: [{ role: 'user', content: 'x'.repeat(12_001) }] }),
    /User messages must be 1–12000 characters/,
  );
  assert.doesNotThrow(() =>
    validateChatRequest({
      messages: [
        { role: 'assistant', content: 'x'.repeat(12_001) },
        { role: 'user', content: 'Continue' },
      ],
    }),
  );
  assert.throws(
    () =>
      validateChatRequest({
        messages: [
          { role: 'assistant', content: 'x'.repeat(32_001) },
          { role: 'user', content: 'Continue' },
        ],
      }),
    /Assistant messages must be 1–32000 characters/,
  );
});

test('rate limiter resets after its window', () => {
  const limit = createRateLimiter({ limit: 2, windowMs: 1000 });
  assert.equal(limit('visitor', 0).allowed, true);
  assert.equal(limit('visitor', 10).allowed, true);
  assert.equal(limit('visitor', 20).allowed, false);
  assert.equal(limit('visitor', 1000).allowed, true);
});

test('provider errors do not expose upstream response bodies or account state', () => {
  // The caller must not learn which provider is used, whether its key was
  // rejected, or whether the account is out of credit.
  assert.deepEqual(providerError(401), {
    status: 502,
    message: 'The chat service could not complete the request. Please try again.',
  });
  assert.deepEqual(providerError(402), {
    status: 502,
    message: 'The chat service could not complete the request. Please try again.',
  });
  assert.equal(providerError(500).status, 502);
  assert.equal(providerError(429).status, 429);

  for (const status of [401, 402, 429, 500, 503]) {
    assert.doesNotMatch(providerError(status).message, /deepseek|api key|balance/i);
  }
});
