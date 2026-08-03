<a name="readme-top"></a>

# Flash Chat

https://dsllm.org

A tiny, anonymous chat page for **DeepSeek V4 Flash 0731** with reasoning enabled at maximum effort. There are no accounts, registrations, app-set cookies, analytics, or database records. Conversation history lives only in the open browser tab.

The application source is licensed under **AGPL-3.0-or-later**. It uses a vanilla browser client, one small server function, native `fetch`, and a single direct development dependency: MIT-licensed Vite.

## Model configuration

The server—not the browser—fixes the DeepSeek request to:

```json
{
  "model": "deepseek-v4-flash",
  "thinking": { "type": "enabled" },
  "reasoning_effort": "max",
  "stream": true,
  "max_tokens": 8192
}
```

DeepSeek's July 31, 2026 release updated the `deepseek-v4-flash` API alias to **DeepSeek-V4-Flash-0731**. `deepseek-v4-flash-0731` is not a public API identifier. See the official [release notes](https://api-docs.deepseek.com/updates/), [model list](https://api-docs.deepseek.com/api/list-models/), and [thinking-mode guide](https://api-docs.deepseek.com/guides/thinking_mode/).

## Publish with Bolt

1. Import this project into Bolt and run `npm install` if Bolt has not already done so.
2. Ask Bolt to deploy `supabase/functions/chat/index.ts` as the public `chat` server function. Keep `verify_jwt = false`; the app intentionally has no authentication.
3. Open **Database → Secrets** and create `DEEPSEEK_API_KEY` with your DeepSeek key. Never create a `VITE_DEEPSEEK_API_KEY`: variables prefixed with `VITE_` are public browser code.
4. Bolt normally injects `VITE_SUPABASE_URL` when its database/server functions are connected. If it does not, set `VITE_CHAT_ENDPOINT` to the full public URL ending in `/functions/v1/chat`.
5. Publish the site. Once its URL is final, add `ALLOWED_ORIGIN=https://your-site.bolt.host` as a server-function secret and redeploy the function.

No auth tables, user accounts, or application database tables are needed. Bolt documents server-side secrets and functions in its [Secrets](https://support.bolt.new/cloud/database/secrets) and [Server functions](https://support.bolt.new/cloud/database/server-functions) guides.

## Run locally

Requires Node 20.19 or newer.

```sh
npm ci
cp .env.example .env.local
# Put your key in .env.local, then:
npm run dev
```

Open <http://localhost:5173>. `.env.local` is ignored by Git.

For the portable production server:

```sh
npm run build
DEEPSEEK_API_KEY=your-key npm run serve
```

The production Node server has no package dependencies: it serves `dist/` and proxies `/api/chat`. Vite is loaded only by the development command. This makes the app self-hostable without Bolt or Supabase.

## Security and privacy

- The API key exists only in the server environment.
- The server accepts only `user` and `assistant` text, then adds its own system prompt.
- The model, upstream URL, reasoning mode, effort, and output cap cannot be changed by visitors.
- Request bytes, message count, per-message size, total history, generation time, and request frequency are bounded.
- Model output is inserted as text, never as HTML.
- Prompts are not logged or stored by this application. They are sent to DeepSeek and are subject to DeepSeek's own policies.

The included rate limiter is only best-effort because serverless instances do not share memory. **A public, no-login AI proxy can spend your API balance. Treat a persistent gateway limit and spend cap as launch requirements.** Before sharing widely, use a dedicated API key, keep a low prepaid balance, enable monitoring, and configure a persistent rate limit at Bolt, Supabase, or another reverse proxy. Origin checks and CORS are not substitutes for rate limiting.

## FLOSS notes

The original application code is AGPLv3-or-later, Vite is MIT, and the app avoids remote fonts, SDKs, analytics, proprietary UI libraries, and CDNs. Every build exposes the exact corresponding application source at `/source-code.txt` so a deployed visitor can inspect, modify, and run it.

Two unavoidable boundaries remain:

- Bolt Cloud is a hosted proprietary service chosen for deployment. The included Node server keeps the app portable to a FLOSS host.
- DeepSeek publishes V4 Flash model weights under the MIT license, but `api.deepseek.com` is a managed external service. The provider's service terms still apply.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the full [GNU AGPL license](LICENSE).

## Checks

```sh
npm run check
```

This runs the unit tests, production build, and corresponding-source generation.

see https://artificialanalysis.ai/ for cost, etc.

https://dsllm.org

<p align="right"><a href="#readme-top">back to top</a></p>
