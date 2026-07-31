import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_ASSISTANT_CHARACTERS,
  MAX_CONTEXT_BYTES,
  MAX_CONTEXT_CHARACTERS,
  MAX_CONTEXT_MESSAGES,
  prepareRequestHistory,
  storeAssistantMessage,
} from '../src/history.js';

test('keeps the newest complete turns inside server context limits', () => {
  const history = [];
  for (let turn = 0; turn < 20; turn += 1) {
    history.push({ role: 'user', content: `Question ${turn}` });
    history.push({ role: 'assistant', content: `Answer ${turn}` });
  }
  history.push({ role: 'user', content: 'Newest question' });

  const result = prepareRequestHistory(history);
  assert.ok(result.length <= MAX_CONTEXT_MESSAGES);
  assert.equal(result[0].role, 'user');
  assert.equal(result.at(-1).content, 'Newest question');
  assert.ok(result.reduce((total, message) => total + message.content.length, 0) <= MAX_CONTEXT_CHARACTERS);
});

test('caps assistant context without truncating the displayed response', () => {
  const stored = storeAssistantMessage('x'.repeat(MAX_ASSISTANT_CHARACTERS + 500));
  assert.equal(stored.role, 'assistant');
  assert.equal(stored.content.length, MAX_ASSISTANT_CHARACTERS);
});

test('drops an orphaned assistant message when character trimming splits a turn', () => {
  const result = prepareRequestHistory([
    { role: 'user', content: 'Old question' },
    { role: 'assistant', content: 'x'.repeat(32_000) },
    { role: 'user', content: 'y'.repeat(12_000) },
    { role: 'assistant', content: 'z'.repeat(10_000) },
    { role: 'user', content: 'Newest' },
  ]);

  assert.equal(result[0].role, 'user');
  assert.equal(result.at(-1).content, 'Newest');
});

test('trims multibyte history to the server byte limit', () => {
  const history = [];
  for (let turn = 0; turn < 5; turn += 1) {
    history.push({ role: 'user', content: '你'.repeat(1_000) });
    history.push({ role: 'assistant', content: '界'.repeat(8_000) });
  }
  history.push({ role: 'user', content: '继续' });

  const result = prepareRequestHistory(history);
  const bytes = new TextEncoder().encode(JSON.stringify({ messages: result })).byteLength;

  assert.ok(bytes <= MAX_CONTEXT_BYTES);
  assert.equal(result[0].role, 'user');
  assert.equal(result.at(-1).content, '继续');
  assert.ok(result.length < history.length);
});
