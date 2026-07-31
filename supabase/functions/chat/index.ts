// Flash Chat — AGPL-3.0-or-later
// Bolt/Supabase-compatible public edge function. No SDK dependency is needed.

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const MODEL_ID = 'deepseek-v4-flash'; // Currently DeepSeek-V4-Flash-0731.
const MAX_REQUEST_BYTES = 96_000;
const MAX_MESSAGES = 24;
const MAX_USER_MESSAGE_CHARS = 12_000;
const MAX_ASSISTANT_MESSAGE_CHARS = 32_000;
const MAX_TOTAL_CHARS = 50_000;
const RATE_LIMIT = 8;
const RATE_WINDOW_MS = 60_000;

const SYSTEM_PROMPT = `You are a helpful AI assistant powered by DeepSeek V4 Flash 0731.
Answer the user's request directly and accurately. Prefer clear, concise language, but include detail when it is useful. If you are uncertain, say so. Never invent sources or claim to have capabilities you do not have.`;

type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

type Bucket = {
  count: number;
  resetAt: number;
};

class RequestError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
  }
}

const buckets = new Map<string, Bucket>();

function getCorsHeaders(origin: string | null) {
  const configuredOrigin = Deno.env.get('ALLOWED_ORIGIN')?.replace(/\/$/, '');
  return {
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Origin': configuredOrigin || origin || '*',
    Vary: 'Origin',
  };
}

function jsonResponse(status: number, body: { error: string }, headers: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...headers,
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function getRequestId(request: Request) {
  return (
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'
  );
}

function isRateLimited(identifier: string) {
  const now = Date.now();
  let bucket = buckets.get(identifier);

  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_WINDOW_MS };
    buckets.set(identifier, bucket);
  }

  bucket.count += 1;

  if (buckets.size > 5_000) {
    for (const [key, value] of buckets) {
      if (now >= value.resetAt) buckets.delete(key);
    }
  }

  return {
    limited: bucket.count > RATE_LIMIT,
    retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  };
}

async function readBodyWithLimit(request: Request) {
  if (!request.body) return '';

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new RequestError('The request body is too large.', 413);
    }
    chunks.push(value);
  }

  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function validateMessages(value: unknown): ChatMessage[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { messages?: unknown }).messages)) {
    throw new RequestError('A messages array is required.');
  }

  const input = (value as { messages: unknown[] }).messages;
  if (input.length < 1 || input.length > MAX_MESSAGES) {
    throw new RequestError(`Send between 1 and ${MAX_MESSAGES} messages.`);
  }

  let totalCharacters = 0;
  const messages = input.map((item): ChatMessage => {
    if (!item || typeof item !== 'object') {
      throw new RequestError('Every message must be an object.');
    }

    const message = item as { role?: unknown; content?: unknown };
    if (message.role !== 'user' && message.role !== 'assistant') {
      throw new RequestError('Only user and assistant messages are accepted.');
    }
    if (typeof message.content !== 'string') {
      throw new RequestError('Every message must contain text.');
    }

    const content = message.content.trim();
    const characterLimit =
      message.role === 'user' ? MAX_USER_MESSAGE_CHARS : MAX_ASSISTANT_MESSAGE_CHARS;
    if (!content || content.length > characterLimit) {
      throw new RequestError(
        `${message.role === 'user' ? 'User' : 'Assistant'} messages must be 1–${characterLimit} characters.`,
      );
    }

    totalCharacters += content.length;
    if (totalCharacters > MAX_TOTAL_CHARS) {
      throw new RequestError('The conversation is too long. Start a new chat and try again.');
    }

    return { role: message.role, content };
  });

  if (messages.at(-1)?.role !== 'user') {
    throw new RequestError('The final message must be from the user.');
  }

  return messages;
}

function providerError(status: number) {
  if (status === 401 || status === 403) return 'DeepSeek rejected the server API key.';
  if (status === 402) return 'The DeepSeek account has insufficient balance.';
  if (status === 429) return 'DeepSeek is rate limited. Please try again shortly.';
  return 'DeepSeek could not complete the request.';
}

Deno.serve(async (request) => {
  const origin = request.headers.get('origin')?.replace(/\/$/, '') || null;
  const configuredOrigin = Deno.env.get('ALLOWED_ORIGIN')?.replace(/\/$/, '');
  const corsHeaders = getCorsHeaders(origin);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed.' }, { ...corsHeaders, Allow: 'POST, OPTIONS' });
  }

  if (configuredOrigin && origin && origin !== configuredOrigin) {
    return jsonResponse(403, { error: 'Origin not allowed.' }, corsHeaders);
  }

  const declaredSize = Number.parseInt(request.headers.get('content-length') || '0', 10);
  if (declaredSize > MAX_REQUEST_BYTES) {
    return jsonResponse(413, { error: 'The request body is too large.' }, corsHeaders);
  }

  const limit = isRateLimited(getRequestId(request));
  if (limit.limited) {
    return jsonResponse(
      429,
      { error: 'Too many requests. Please wait a moment and try again.' },
      { ...corsHeaders, 'Retry-After': String(limit.retryAfter) },
    );
  }

  const apiKey = Deno.env.get('DEEPSEEK_API_KEY');
  if (!apiKey) {
    return jsonResponse(503, { error: 'The server is missing DEEPSEEK_API_KEY.' }, corsHeaders);
  }

  try {
    const rawBody = await readBodyWithLimit(request);

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new RequestError('The request body must be valid JSON.');
    }

    const messages = validateMessages(body);
    const upstream = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL_ID,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
        stream: true,
        thinking: { type: 'enabled' },
        reasoning_effort: 'max',
        max_tokens: 8192,
      }),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(180_000)]),
    });

    if (!upstream.ok || !upstream.body) {
      await upstream.body?.cancel();
      const status = upstream.status === 429 ? 429 : 502;
      return jsonResponse(status, { error: providerError(upstream.status) }, corsHeaders);
    }

    return new Response(upstream.body, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Cache-Control': 'no-cache, no-store',
        'Content-Type': 'text/event-stream; charset=utf-8',
        'X-Accel-Buffering': 'no',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      return jsonResponse(504, { error: 'DeepSeek took too long to respond.' }, corsHeaders);
    }
    if (error instanceof RequestError) {
      return jsonResponse(error.status, { error: error.message }, corsHeaders);
    }
    return jsonResponse(502, { error: 'The chat service could not complete the request.' }, corsHeaders);
  }
});
