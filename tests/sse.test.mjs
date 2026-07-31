import assert from 'node:assert/strict';
import test from 'node:test';
import { createSseParser } from '../src/sse.js';

test('parses DeepSeek SSE events split across arbitrary chunks', () => {
  const events = [];
  const parser = createSseParser((data) => events.push(data));

  parser.push('data: {"choices":[{"delta":{"reason');
  parser.push('ing_content":"Think"}}]}\n\n');
  parser.push(': keepalive\r\ndata: {"choices":[{"delta":{"content":"Answer"}}]}\r\n');
  parser.push('\r\ndata: [DONE]\n\n');
  parser.finish();

  assert.deepEqual(events, [
    '{"choices":[{"delta":{"reasoning_content":"Think"}}]}',
    '{"choices":[{"delta":{"content":"Answer"}}]}',
    '[DONE]',
  ]);
});

test('joins multi-line SSE data fields', () => {
  const events = [];
  const parser = createSseParser((data) => events.push(data));
  parser.push('data: first\ndata: second\n\n');
  parser.finish();
  assert.deepEqual(events, ['first\nsecond']);
});
