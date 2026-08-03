import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import {
  ChatInputError,
  DEEPSEEK_URL,
  MAX_REQUEST_BYTES,
  createDeepSeekPayload,
  createRateLimiter,
  providerError,
  validateChatRequest,
} from './server/chat-core.mjs';

const isDevelopment = process.argv.includes('--dev');
const mode = isDevelopment ? 'development' : 'production';
let createViteServer;
let fileEnvironment = {};
if (isDevelopment) {
  const viteModule = await import('vite');
  createViteServer = viteModule.createServer;
  fileEnvironment = viteModule.loadEnv(mode, process.cwd(), '');
}
const environment = { ...fileEnvironment, ...process.env };
const port = Number.parseInt(environment.PORT || '5173', 10);
const host = environment.HOST || '0.0.0.0';
const allowedOrigin = environment.ALLOWED_ORIGIN?.replace(/\/$/, '');
// Forwarded headers are caller-supplied unless a proxy we control overwrites
// them, so they are only consulted when the operator opts in explicitly.
const trustProxy = /^(1|true|yes)$/i.test(environment.TRUST_PROXY || '');
const distDirectory = resolve(process.cwd(), 'dist');
const rateLimit = createRateLimiter();

const securityHeaders = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://*.supabase.co https://*.bolt.host; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
};

function sendJson(response, status, body, extraHeaders = {}) {
  response.writeHead(status, {
    ...securityHeaders,
    ...extraHeaders,
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
}

function getRequestIp(request) {
  // The TCP peer address cannot be forged by the caller, so it is the default.
  //
  // Behind a proxy the peer is the proxy itself, so a forwarded header has to be
  // consulted instead — but only when the operator opts in, because these
  // headers are caller-supplied unless something in front overwrites them.
  //
  // Which entry is correct depends on what is in front. A CDN such as Cloudflare
  // OVERWRITES the forwarded header and publishes the client address in its own
  // header, and its rightmost forwarded entry is a load-balanced edge node that
  // differs on every request — keying on that would give each request its own
  // bucket and the per-caller limit would never accumulate at all. A plain
  // single reverse proxy such as nginx APPENDS, making the rightmost entry the
  // address it observed and the leftmost caller-controlled.
  //
  // So: prefer an explicitly named client-IP header, then Cloudflare's, then
  // fall back to the rightmost forwarded entry for the plain single-proxy case.
  if (trustProxy) {
    const headerName = (environment.CLIENT_IP_HEADER || 'cf-connecting-ip').toLowerCase();
    const named = request.headers[headerName];
    if (typeof named === 'string' && named.trim()) {
      return named.split(',')[0].trim();
    }

    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      const hops = forwarded
        .split(',')
        .map((hop) => hop.trim())
        .filter(Boolean);
      if (hops.length > 0) return hops[hops.length - 1];
    }
  }
  return request.socket.remoteAddress || 'unknown';
}

async function readJsonBody(request) {
  const declaredSize = Number.parseInt(request.headers['content-length'] || '0', 10);
  if (declaredSize > MAX_REQUEST_BYTES) {
    throw new ChatInputError('The request body is too large.', 413);
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new ChatInputError('The request body is too large.', 413);
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ChatInputError('The request body must be valid JSON.');
  }
}

function corsHeaders(originToAllow) {
  const headers = {
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
  if (originToAllow) headers['Access-Control-Allow-Origin'] = originToAllow;
  return headers;
}

// Returns the origin to echo back, or null when it is not allowed. Fails
// CLOSED. Reflecting the caller's own origin would let any web page spend this
// instance's provider key through its visitors' browsers and read the answer,
// so when ALLOWED_ORIGIN is not configured only this server's own origin is
// accepted, which is all the bundled front end ever needs.
function resolveAllowedOrigin(request) {
  const origin = request.headers.origin?.replace(/\/$/, '');
  if (!origin) return null;

  if (allowedOrigin) return origin === allowedOrigin ? allowedOrigin : null;

  const host = request.headers.host;
  if (!host) return null;
  return origin === `http://${host}` || origin === `https://${host}` ? origin : null;
}

async function handleChat(request, response) {
  const requestOrigin = request.headers.origin?.replace(/\/$/, '');
  const resolvedOrigin = resolveAllowedOrigin(request);
  const cors = corsHeaders(resolvedOrigin);

  if (request.method === 'OPTIONS') {
    response.writeHead(204, { ...securityHeaders, ...cors });
    response.end();
    return;
  }

  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'Method not allowed.' }, { ...cors, Allow: 'POST, OPTIONS' });
    return;
  }

  // A browser always sends Origin on a cross-origin request. If one is present
  // and did not resolve to an allowed value, refuse before any provider spend.
  if (requestOrigin && !resolvedOrigin) {
    sendJson(response, 403, { error: 'Origin not allowed.' }, cors);
    return;
  }

  const limit = rateLimit(getRequestIp(request));
  if (!limit.allowed) {
    sendJson(
      response,
      429,
      { error: 'Too many requests. Please wait a moment and try again.' },
      { ...cors, 'Retry-After': String(limit.retryAfter) },
    );
    return;
  }

  const apiKey = environment.DEEPSEEK_API_KEY;
  if (!apiKey) {
    // The operator needs this detail; the caller does not.
    console.error('Chat request rejected: DEEPSEEK_API_KEY is not set in the environment.');
    sendJson(response, 503, { error: 'The chat service is temporarily unavailable.' }, cors);
    return;
  }

  try {
    const messages = validateChatRequest(await readJsonBody(request));
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 180_000);
    response.on('close', () => {
      if (!response.writableEnded) abortController.abort();
    });

    try {
      const upstream = await fetch(DEEPSEEK_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(createDeepSeekPayload(messages)),
        signal: abortController.signal,
      });

      if (!upstream.ok || !upstream.body) {
        await upstream.body?.cancel();
        const error = providerError(upstream.status);
        sendJson(response, error.status, { error: error.message }, cors);
        return;
      }

      response.writeHead(200, {
        ...securityHeaders,
        ...cors,
        'Cache-Control': 'no-cache, no-store',
        'Content-Type': 'text/event-stream; charset=utf-8',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      for await (const chunk of upstream.body) {
        if (!response.write(chunk)) {
          await new Promise((resolveDrain) => response.once('drain', resolveDrain));
        }
      }
      response.end();
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    if (response.headersSent) {
      response.end();
      return;
    }
    if (error instanceof ChatInputError) {
      sendJson(response, error.status, { error: error.message }, cors);
      return;
    }
    if (error?.name === 'AbortError') {
      sendJson(response, 504, { error: 'The chat service took too long to respond.' }, cors);
      return;
    }
    sendJson(response, 502, { error: 'The chat service could not complete the request.' }, cors);
  }
}

async function serveStatic(request, response, pathname) {
  let requestedPath;
  try {
    requestedPath = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
  } catch {
    sendJson(response, 400, { error: 'Invalid URL.' });
    return;
  }
  let filePath = resolve(distDirectory, `.${requestedPath}`);

  if (filePath !== distDirectory && !filePath.startsWith(`${distDirectory}${sep}`)) {
    sendJson(response, 403, { error: 'Forbidden.' });
    return;
  }

  try {
    const fileStats = await stat(filePath);
    if (!fileStats.isFile()) throw new Error('Not a file');
  } catch {
    filePath = resolve(distDirectory, 'index.html');
  }

  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      ...securityHeaders,
      'Cache-Control': filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600',
      'Content-Type': mimeTypes[extname(filePath)] || 'application/octet-stream',
    });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch {
    sendJson(response, 404, { error: 'Not found.' });
  }
}

const vite = isDevelopment
  ? await createViteServer({
      appType: 'spa',
      server: { middlewareMode: true },
    })
  : null;

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

  if (requestUrl.pathname === '/api/chat') {
    await handleChat(request, response);
    return;
  }

  if (isDevelopment) {
    vite.middlewares(request, response, (error) => {
      if (error) {
        vite.ssrFixStacktrace(error);
        sendJson(response, 500, { error: 'Internal server error.' });
      } else if (!response.writableEnded) {
        sendJson(response, 404, { error: 'Not found.' });
      }
    });
    return;
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, { error: 'Method not allowed.' }, { Allow: 'GET, HEAD' });
    return;
  }

  await serveStatic(request, response, requestUrl.pathname);
});

server.listen(port, host, () => {
  console.log(`Flash Chat running at http://localhost:${port}`);
  if (!environment.DEEPSEEK_API_KEY) {
    console.log('Chat is disabled until DEEPSEEK_API_KEY is configured.');
  }
});
