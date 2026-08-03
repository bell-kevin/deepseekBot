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
// Service-wide ceiling per window. Individual anonymous callers can never be
// identified perfectly, so this bounds total spend on the provider key even
// when per-caller identification fails.
const GLOBAL_RATE_LIMIT = Number.parseInt(Deno.env.get('GLOBAL_RATE_LIMIT') || '240', 10);
const RATE_LIMIT_RPC_TIMEOUT_MS = 2_000;
// Allowance applied per instance while the durable limit is unreachable. The
// service keeps answering, but a database outage degrades the ceiling instead
// of removing it.
const DEGRADED_RATE_LIMIT = 3;

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

// Origins allowed when ALLOWED_ORIGIN is not configured. Reflecting whatever
// origin the caller sent would let ANY web page spend the provider key using
// its visitors' browsers and read the streamed answer, so the unconfigured
// case falls back to this conservative list rather than to a wildcard.
const DEFAULT_ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/([a-z0-9-]+\.)*bolt\.host$/i,
  /^https:\/\/([a-z0-9-]+\.)*supabase\.co$/i,
  /^http:\/\/localhost(:\d+)?$/i,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/i,
];

// Returns the origin to echo back, or null when the caller's origin is not
// allowed. Fails CLOSED: an unrecognised origin resolves to null so no
// Access-Control-Allow-Origin is emitted and the request is refused.
function resolveAllowedOrigin(origin: string | null) {
  const configuredOrigin = Deno.env.get('ALLOWED_ORIGIN')?.replace(/\/$/, '');

  if (configuredOrigin) {
    return origin === configuredOrigin ? configuredOrigin : null;
  }

  // Non-browser callers send no Origin. They are not cross-origin, so there is
  // nothing to authorise and no CORS header is needed.
  if (!origin) return null;

  return DEFAULT_ALLOWED_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin)) ? origin : null;
}

function getCorsHeaders(allowedOrigin: string | null) {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
  if (allowedOrigin) headers['Access-Control-Allow-Origin'] = allowedOrigin;
  return headers;
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

// Identifies the caller for rate limiting. Getting this wrong is not a small
// error: if the value is not STABLE per caller, the per-caller limit can never
// accumulate and one attacker can consume the whole global allowance.
//
// `cf-connecting-ip` is set by the Cloudflare edge that fronts this runtime and
// holds the true client address. It is not caller-forgeable: requests that try
// to supply it themselves are refused at the edge before reaching this code.
//
// The rightmost `x-forwarded-for` entry must NOT be used. It is the inbound
// accelerator node, which is load balanced and therefore DIFFERENT on every
// request, so keying on it gives each request its own private bucket. The
// leftmost entry is the client address here because the edge overwrites this
// header rather than appending to it, discarding anything the caller supplied.
function getRequestId(request: Request) {
  const edgeClientIp = request.headers.get('cf-connecting-ip')?.trim();
  if (edgeClientIp) return edgeClientIp;

  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded
      .split(',')
      .map((hop) => hop.trim())
      .filter(Boolean)[0];
    if (first) return first;
  }

  return 'unknown';
}

// Local, per-instance pre-filter. It is cheap and catches the obvious floods
// without a round trip, but it is NOT the real limit: instances do not share
// memory and are recycled, so `claimSharedSlot` below is what actually bounds
// traffic across the whole service. `limit` is a parameter so the caller can
// enforce a tighter allowance when the durable limit is unavailable.
function isRateLimited(identifier: string, limit: number = RATE_LIMIT) {
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
    limited: bucket.count > limit,
    count: bucket.count,
    retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  };
}

// The durable, service-wide limit. State lives in the database so every
// instance counts against the same totals, and the claim is atomic so two
// simultaneous requests cannot both take the last remaining slot.
//
// Fails OPEN rather than offline, but reports 'degraded' instead of 'ok' so the
// caller can tell "the shared counter allowed this" apart from "the shared
// counter could not be consulted". Returning 'ok' for both is what previously
// let the service-wide ceiling disappear entirely during a database outage.
async function claimSharedSlot(
  identifier: string,
): Promise<'ok' | 'caller' | 'global' | 'degraded'> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) {
    console.error('Rate limit degraded: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set.');
    return 'degraded';
  }

  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/claim_chat_request`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        p_bucket_key: identifier,
        p_limit: RATE_LIMIT,
        p_window_seconds: Math.ceil(RATE_WINDOW_MS / 1000),
        p_global_limit: GLOBAL_RATE_LIMIT,
      }),
      signal: AbortSignal.timeout(RATE_LIMIT_RPC_TIMEOUT_MS),
    });

    if (!response.ok) {
      await response.body?.cancel();
      return 'degraded';
    }

    const verdict = await response.json();
    if (verdict === 'caller' || verdict === 'global') return verdict;
    return verdict === 'ok' ? 'ok' : 'degraded';
  } catch {
    return 'degraded';
  }
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

// Upstream failures are the operator's problem, not the caller's. Never
// disclose which provider is used, whether its key was rejected, or whether
// the account has run out of credit.
function providerError(status: number) {
  if (status === 429) return 'The chat service is busy. Please try again shortly.';
  return 'The chat service could not complete the request. Please try again.';
}

Deno.serve(async (request) => {
  const origin = request.headers.get('origin')?.replace(/\/$/, '') || null;
  const allowedOrigin = resolveAllowedOrigin(origin);
  const corsHeaders = getCorsHeaders(allowedOrigin);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed.' }, { ...corsHeaders, Allow: 'POST, OPTIONS' });
  }

  // A browser always sends Origin on a cross-origin request. If one is present
  // and did not resolve to an allowed value, refuse before any provider spend.
  if (origin && !allowedOrigin) {
    return jsonResponse(403, { error: 'Origin not allowed.' }, corsHeaders);
  }

  const declaredSize = Number.parseInt(request.headers.get('content-length') || '0', 10);
  if (declaredSize > MAX_REQUEST_BYTES) {
    return jsonResponse(413, { error: 'The request body is too large.' }, corsHeaders);
  }

  const requestId = getRequestId(request);
  const localLimit = isRateLimited(requestId);
  if (localLimit.limited) {
    return jsonResponse(
      429,
      { error: 'Too many requests. Please wait a moment and try again.' },
      { ...corsHeaders, 'Retry-After': String(localLimit.retryAfter) },
    );
  }

  const sharedLimit = await claimSharedSlot(requestId);

  if (sharedLimit === 'global' || sharedLimit === 'caller') {
    return jsonResponse(
      429,
      {
        error:
          sharedLimit === 'global'
            ? 'The chat service is busy right now. Please try again shortly.'
            : 'Too many requests. Please wait a moment and try again.',
      },
      { ...corsHeaders, 'Retry-After': String(Math.ceil(RATE_WINDOW_MS / 1000)) },
    );
  }

  // The durable ceiling could not be consulted. Keep serving, but fall back to
  // a much tighter per-instance allowance so an outage degrades the limit
  // rather than removing it. The local counter was already incremented above,
  // so this only re-tests the count that was recorded.
  if (sharedLimit === 'degraded' && localLimit.count > DEGRADED_RATE_LIMIT) {
    return jsonResponse(
      429,
      { error: 'The chat service is busy right now. Please try again shortly.' },
      { ...corsHeaders, 'Retry-After': String(localLimit.retryAfter) },
    );
  }

  const apiKey = Deno.env.get('DEEPSEEK_API_KEY');
  if (!apiKey) {
    return jsonResponse(503, { error: 'The chat service is temporarily unavailable.' }, corsHeaders);
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
      return jsonResponse(504, { error: 'The chat service took too long to respond.' }, corsHeaders);
    }
    if (error instanceof RequestError) {
      return jsonResponse(error.status, { error: error.message }, corsHeaders);
    }
    return jsonResponse(502, { error: 'The chat service could not complete the request.' }, corsHeaders);
  }
});
