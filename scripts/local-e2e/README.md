# Local browser-to-API test harness

These two scripts make the existing protected route testable on one Mac. They are not imported by the Next.js application. Both listen on `127.0.0.1` only. The edge proxy removes browser-supplied edge/IP headers and injects its own values. The Redis adapter forwards the application's existing `SET` and `EVAL` commands to an isolated Redis 7 container; it does not mock quota decisions. Neither script calls or mocks OpenAI.

## Prerequisites

- Node.js 20+, Docker/Colima, and the project's installed packages (`npm ci`).
- A dedicated OpenAI project key in the gitignored `.env.local`, with its project spend limit already enforced.
- Cloudflare's public **development-only** Turnstile site/secret pair. The server still calls Siteverify and stores a single-use token hash in Redis. A real widget pair remains required in staging and production.
- Network access from the Next.js process to Cloudflare Siteverify and OpenAI. In a restricted Codex shell, commands may need `require_escalated` because sandboxed DNS and Colima socket access can fail.

Cloudflare's public testing pair is sitekey `1x00000000000000000000AA` and secret `1x0000000000000000000000000000000AA`. A live Siteverify probe returned `success: true`, `hostname: "example.com"`, a test-key marker, and no `action`. In development on loopback, the local verification button requests a short-lived, session-bound test token from the server. Each room-design request verifies Cloudflare's exact fixed dummy token with Siteverify, then consumes the unique local token in Redis. The local route requires `KANABCO_LOCAL_TURNSTILE_TEST=true`, exact dummy keys, `NODE_ENV=development`, a loopback `ALLOWED_ORIGIN`, and a signed session. Production still requires a real Turnstile token, configured hostname, and `room_design` action. Do not deploy the dummy pair. See [Cloudflare's test-key documentation](https://developers.cloudflare.com/turnstile/troubleshooting/testing/).

Next.js development uses React debugging code that requires `unsafe-eval`; the app's CSP allows it only while `NODE_ENV=development`. The production CSP remains strict. Restart Next.js and reload the browser tab after changing this configuration.

## Run

1. Put local-only values in `.env.local` without changing the production defaults in `.env.example`:

   ```text
   AI_FEATURE_ENABLED=false
   ALLOWED_ORIGIN=http://127.0.0.1:3460
   AI_TRUSTED_CLIENT_IP_HEADER=cf-connecting-ip
   AI_EDGE_SHARED_SECRET=<a new unquoted 32+ character random value>
   SESSION_SIGNING_KEY=<a different unquoted 32+ character random value>
   TURNSTILE_SITE_KEY=1x00000000000000000000AA
   TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA
   TURNSTILE_EXPECTED_HOSTNAME=127.0.0.1
   KANABCO_LOCAL_TURNSTILE_TEST=true
   UPSTASH_REDIS_REST_URL=http://127.0.0.1:6391
   UPSTASH_REDIS_REST_TOKEN=<a third unquoted 32+ character random value>
   AI_IMAGE_RESERVED_USD=1.00
   AI_DAILY_SESSION_USD_CAP=7.00
   AI_DAILY_GLOBAL_USD_CAP=7.00
   AI_REQ_PER_MIN_PER_IP=3
   AI_REQ_PER_DAY_PER_IP=7
   AI_REQ_PER_DAY_PER_SESSION=7
   AI_REQ_PER_DAY_GLOBAL=7
   AI_MAX_INFLIGHT_PER_IP=1
   AI_MAX_INFLIGHT_PER_SESSION=1
   AI_MAX_INFLIGHT_GLOBAL=1
   ```

   Preserve the already stored `OPENAI_API_KEY` and fixed `OPENAI_IMAGE_MODEL`. Never copy the key to the proxy, adapter, browser, repository, or a command argument. Use separate terminal windows for the next three long-running commands.

2. Start a disposable Redis container. It publishes **no** TCP port:

   ```sh
   docker run -d --rm --name kanabco-redis-e2e redis:7-alpine redis-server --save '' --appendonly no
   ```

3. Start the Redis REST adapter. This shell substitution passes only the local Redis test token to that process:

   ```sh
   LOCAL_REDIS_REST_TOKEN="$(sed -n 's/^UPSTASH_REDIS_REST_TOKEN=//p' .env.local)" node scripts/local-e2e/redis-rest.mjs
   ```

4. Start Next.js, bound to loopback. Its normal `.env.local` loading gives the app its server-only key:

   ```sh
   npm run dev -- -H 127.0.0.1 -p 3461
   ```

5. Start the edge proxy. This process receives only the edge secret, not the OpenAI key:

   ```sh
   AI_EDGE_SHARED_SECRET="$(sed -n 's/^AI_EDGE_SHARED_SECRET=//p' .env.local)" node scripts/local-e2e/edge-proxy.mjs
   ```

6. Visit **`http://127.0.0.1:3460/`**. The preview at port 3457 is a separate static demo. Set `AI_FEATURE_ENABLED=true` in `.env.local` and restart Next.js only after all local dependencies are ready. In the loopback development UI, choose **Kitchen**, upload the included fictional `demo/kitchen-before.png`, click **Use local test verification**, and submit. Cloudflare's widget itself can fail in embedded browsers. The button obtains a fresh local token bound to the browser session; the server still verifies the fixed dummy with Cloudflare Siteverify, checks Redis replay, and applies every other gate. After a completed attempt, click the button again to test a different room or category. The bounded local quota allows up to seven admitted generations per UTC day and charges a conservative $1 reservation against the $7 local cap for each success. Check that the image appears, the Redis counters advance, and the audit shows image-edit usage/cost. Reusing the same local token inside the 10-minute replay window returns 403. Do not retry automatically after a timeout: first inspect OpenAI project usage and application logs.

7. Set `AI_FEATURE_ENABLED=false` again, restart Next.js if needed, stop the proxy and adapter, then remove only this disposable Redis container:

   ```sh
   docker rm -f kanabco-redis-e2e
   ```

## Guard checks before a paid request

- Direct access to `http://127.0.0.1:3461/api/room-design` must fail the edge-secret check when the feature is enabled, even if a caller supplies a forged client IP.
- The proxy must strip incoming `x-kanabco-edge-secret` and `cf-connecting-ip` values; it injects its own values for `/api/room-design` only.
- Missing Origin/custom header, malformed multipart, oversized body, invalid Turnstile token, and disabled kill switch should fail before an image edit. Existing `tests/security.test.ts` covers these early failures without paid calls.
- `tests/redis-guards.integration.test.ts` exercises replay, concurrency, rolling quotas, budget reservations, settlement, and fail-closed behavior against a separate disposable Redis container. It calls `FLUSHDB`, so **never** point it at this E2E container or any shared Redis.
- A request admitted by the Redis quota can consume a daily slot even if image validation or moderation later blocks it. The local UI checks file size and dimensions before sending, but the server remains authoritative. For a paid browser test, use a fresh local test token. Never clear a shared quota store to get another paid attempt.

For the development team, replace this local proxy with the approved Cloudflare edge configuration and replace this local adapter with Upstash Redis REST. Recheck the real deployment's Origin, trusted IP, edge-secret injection, WAF, Turnstile hostname, server egress allowlist, and project spend limit before enabling the public route.
