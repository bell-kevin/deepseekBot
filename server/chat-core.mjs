export const MODEL_ID = 'deepseek-v4-flash';
export const MODEL_VERSION = 'DeepSeek-V4-Flash-0731';
export const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
export const MAX_MESSAGES = 24;
export const MAX_USER_MESSAGE_CHARS = 12_000;
export const MAX_ASSISTANT_MESSAGE_CHARS = 32_000;
export const MAX_TOTAL_CHARS = 50_000;
export const MAX_REQUEST_BYTES = 96_000;

const SYSTEM_PROMPT = `You are a helpful AI assistant powered by DeepSeek V4 Flash 0731.
Answer the user's request directly and accurately. Prefer clear, concise language, but include detail when it is useful. If you are uncertain, say so. Never invent sources or claim to have capabilities you do not have.`;

export class ChatInputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ChatInputError';
    this.status = status;
  }
}

export function validateChatRequest(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) {
    throw new ChatInputError('A messages array is required.');
  }

  if (body.messages.length < 1 || body.messages.length > MAX_MESSAGES) {
    throw new ChatInputError(`Send between 1 and ${MAX_MESSAGES} messages.`);
  }

  let totalCharacters = 0;
  const messages = body.messages.map((message) => {
    if (!message || typeof message !== 'object') {
      throw new ChatInputError('Every message must be an object.');
    }

    if (message.role !== 'user' && message.role !== 'assistant') {
      throw new ChatInputError('Only user and assistant messages are accepted.');
    }

    if (typeof message.content !== 'string') {
      throw new ChatInputError('Every message must contain text.');
    }

    const content = message.content.trim();
    const characterLimit =
      message.role === 'user' ? MAX_USER_MESSAGE_CHARS : MAX_ASSISTANT_MESSAGE_CHARS;
    if (!content || content.length > characterLimit) {
      throw new ChatInputError(
        `${message.role === 'user' ? 'User' : 'Assistant'} messages must be 1–${characterLimit} characters.`,
      );
    }

    totalCharacters += content.length;
    if (totalCharacters > MAX_TOTAL_CHARS) {
      throw new ChatInputError('The conversation is too long. Start a new chat and try again.');
    }

    return { role: message.role, content };
  });

  if (messages.at(-1)?.role !== 'user') {
    throw new ChatInputError('The final message must be from the user.');
  }

  return messages;
}

export function createDeepSeekPayload(messages) {
  return {
    model: MODEL_ID,
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
    stream: true,
    thinking: { type: 'enabled' },
    reasoning_effort: 'max',
    max_tokens: 8192,
  };
}

export function createRateLimiter({ limit = 8, windowMs = 60_000 } = {}) {
  const buckets = new Map();

  return (identifier, now = Date.now()) => {
    let bucket = buckets.get(identifier);

    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(identifier, bucket);
    }

    bucket.count += 1;

    if (buckets.size > 5_000) {
      for (const [key, value] of buckets) {
        if (now >= value.resetAt) buckets.delete(key);
      }
    }

    return {
      allowed: bucket.count <= limit,
      retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      remaining: Math.max(0, limit - bucket.count),
    };
  };
}

// Upstream failures are the operator's problem, not the caller's. Never
// disclose which provider is used, whether its key was rejected, or whether
// the account has run out of credit.
export function providerError(status) {
  if (status === 429) {
    return { status: 429, message: 'The chat service is busy. Please try again shortly.' };
  }
  return {
    status: 502,
    message: 'The chat service could not complete the request. Please try again.',
  };
}
