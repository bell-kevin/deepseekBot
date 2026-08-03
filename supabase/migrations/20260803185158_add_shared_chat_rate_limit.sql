/*
# Shared rate limit state for the public chat function

## Why this exists

The public chat edge function proxies requests to a paid model provider using a
secret API key. Until now it counted requests in an in-memory map inside the
function instance. Serverless instances do not share memory and are recycled
constantly, so that counter was neither global nor durable: parallel callers
landed on different instances, each enforcing its own private allowance, and a
cold instance always started a caller from zero. There was therefore no ceiling
at all on how much the provider key could be spent.

This migration moves that counter into the database, where every function
instance sees the same numbers, and adds a second global counter so total
traffic is bounded even when individual callers cannot be told apart.

## 1. New Tables

- `chat_rate_limits` — one row per counter.
  - `bucket_key` (text, primary key) — either `__global__` for the service-wide
    counter or `ip:<address>` for a single caller.
  - `window_start` (timestamptz, not null) — when the current counting window
    began.
  - `request_count` (integer, not null) — requests seen in the current window.

## 2. New Functions

- `claim_chat_request(p_bucket_key, p_limit, p_window_seconds, p_global_limit)`
  returns text. Claims one request slot against the global counter and the
  per-caller counter and returns `ok`, `global` or `caller`. Each claim is a
  single `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`, so the increment and
  the test happen under one row lock and two simultaneous requests cannot both
  pass a limit that only has room for one. The global counter is always claimed
  first so concurrent calls always take row locks in the same order and cannot
  deadlock. Old rows are pruned opportunistically so the table stays small.

## 3. Security

- Row level security is ENABLED on `chat_rate_limits` and NO policies are
  created, which denies all access through the public data API. This is
  deliberate: the counters are internal infrastructure, and a visitor who could
  read them would learn traffic patterns while a visitor who could write them
  could simply reset their own allowance and remove the limit.
- All privileges on the table are revoked from `anon` and `authenticated`.
- `claim_chat_request` is `SECURITY DEFINER` so it can maintain the counters
  despite row level security, and `EXECUTE` on it is revoked from `PUBLIC`,
  `anon` and `authenticated` so only the service role used by the edge function
  can call it. Its `search_path` is pinned to avoid resolution hijacking.

## 4. Important notes

1. The edge function fails OPEN if this function cannot be reached, so a
   database problem degrades the limit rather than taking chat offline.
2. No existing data is read or modified by this migration.
*/

CREATE TABLE IF NOT EXISTS public.chat_rate_limits (
  bucket_key text PRIMARY KEY,
  window_start timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 0
);

ALTER TABLE public.chat_rate_limits ENABLE ROW LEVEL SECURITY;

-- Internal infrastructure: no policies, and no direct privileges for the
-- roles the browser can reach. Deny by default.
REVOKE ALL ON public.chat_rate_limits FROM anon, authenticated;

CREATE INDEX IF NOT EXISTS chat_rate_limits_window_start_idx
  ON public.chat_rate_limits (window_start);

CREATE OR REPLACE FUNCTION public.claim_chat_request(
  p_bucket_key text,
  p_limit integer,
  p_window_seconds integer,
  p_global_limit integer
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_global integer;
  v_caller integer;
  v_cutoff timestamptz := now() - make_interval(secs => p_window_seconds);
BEGIN
  -- Keep the table bounded without paying for a delete on every request.
  IF random() < 0.01 THEN
    DELETE FROM public.chat_rate_limits
    WHERE window_start < now() - interval '1 hour';
  END IF;

  -- Global counter first so every caller takes row locks in the same order.
  INSERT INTO public.chat_rate_limits AS t (bucket_key, window_start, request_count)
  VALUES ('__global__', now(), 1)
  ON CONFLICT (bucket_key) DO UPDATE
    SET request_count = CASE
          WHEN t.window_start < v_cutoff THEN 1
          ELSE t.request_count + 1
        END,
        window_start = CASE
          WHEN t.window_start < v_cutoff THEN now()
          ELSE t.window_start
        END
  RETURNING t.request_count INTO v_global;

  INSERT INTO public.chat_rate_limits AS t (bucket_key, window_start, request_count)
  VALUES ('ip:' || coalesce(p_bucket_key, 'unknown'), now(), 1)
  ON CONFLICT (bucket_key) DO UPDATE
    SET request_count = CASE
          WHEN t.window_start < v_cutoff THEN 1
          ELSE t.request_count + 1
        END,
        window_start = CASE
          WHEN t.window_start < v_cutoff THEN now()
          ELSE t.window_start
        END
  RETURNING t.request_count INTO v_caller;

  IF v_global > p_global_limit THEN
    RETURN 'global';
  END IF;

  IF v_caller > p_limit THEN
    RETURN 'caller';
  END IF;

  RETURN 'ok';
END;
$$;

REVOKE ALL ON FUNCTION public.claim_chat_request(text, integer, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_chat_request(text, integer, integer, integer) FROM anon;
REVOKE ALL ON FUNCTION public.claim_chat_request(text, integer, integer, integer) FROM authenticated;
