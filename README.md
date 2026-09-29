# Kanabco Room Designer — developer handoff

**Status:** Standalone Next.js App Router implementation for the development team to integrate. Protected image edits passed locally with Cloudflare's development test keys and disposable Redis; these do not establish production readiness. The dedicated OpenAI key is stored only in the gitignored local environment, and the local service is bound to loopback. The feature has not been deployed or connected to Kanabco's live chatbot, price database, production Cloudflare WAF/Turnstile, or Upstash account. Keep `AI_FEATURE_ENABLED=false` in public deployment until the launch checks below pass. Start with the [forwardable team message](SEND-TO-DEVS.md), then use the [integration brief](HANDOFF.md) for product decisions.

The visitor uploads one room photo and chooses a concept category: sofa, bed and headboard, wardrobe, dresser, dressing room, or kitchen. They select a style, color, and material direction, complete Turnstile, and receive one AI-generated concept image. A sofa project may optionally use one of two local Kanabco sofa references. Every other category is a **custom-project idea**, even if Kanabco does not currently sell or make it. The generated image is an illustration, not a quote, measured plan, existing product, or promise that Kanabco can manufacture or install it. The team must verify the two sofa references before launch. All generated projects have `priceEgp: null`; a specialist must confirm feasibility and give any quote.

This package covers the photo feature through a separate multipart endpoint with image-specific limits. It does not modify the existing price chatbot, whose source was unavailable.

**Production integration blockers (audit on 29 September 2026):** No Room Designer project was found in the connected Vercel account, and the example hostname `custom.kanabco.net` had no DNS record. The live `kanabco.net` response came from Google Frontend and its public nameservers were registrar servers; a Cloudflare proxy/WAF for this feature was not observable. The live website repository and integration owner have not been identified. The team must choose the host and route, provision a production Cloudflare path and Upstash, and arrange fixed server egress before OpenAI project IP allowlisting. None of those external controls can be inferred from the successful loopback test.

## Request flow

```text
Browser / Turnstile
  -> Cloudflare WAF + trusted edge-header injection
  -> POST /api/room-design on the server
  -> Turnstile siteverify
  -> Upstash Redis (replay, concurrency, request and dollar reservations)
  -> OpenAI Moderations (photo + controlled prompt)
  -> OpenAI Images Edit (room photo; optional approved sofa reference)
  -> image re-encode -> browser preview/download
```

The browser never calls OpenAI or receives the API key. The sole paid image request is in `src/lib/openai-image.ts`. No user-supplied URL is fetched. There are no model tools, browsing, or client-selected OpenAI parameters. The server fixes the prompt, model snapshot, quality, output size and format. The Images Edit API uses a SHA-256 session hash in its `user` field for abuse attribution; this endpoint does not accept `safety_identifier`. A future Responses/Chat integration should set `safety_identifier` to a hash of the authenticated user ID or stable session ID.

## What is included

| Path | Purpose |
| --- | --- |
| `src/app/page.tsx`, `src/components/Turnstile.tsx` | Six concept categories, optional sofa reference, constrained style/color/material choices, Turnstile, disabled submit while in flight, comparison, download and advisor link. |
| `public/brand/`, `public/concepts/`, `public/fonts/` | Official Kanabco logo and sofa imagery, five generated concept-card images, and locally hosted Lato with its license. Concept images are not catalog media. |
| `src/app/api/room-design/route.ts` | Protected multipart API with the 13 ordered gates below. |
| `src/lib/redis-guards.ts` | Atomic Redis replay cache, concurrency slots, rolling request limits, daily dollar reservations and settlement. |
| `src/lib/images.ts` | MIME signature check, pixel/byte limits, decoding, EXIF removal, and safe JPEG output. |
| `src/lib/openai-image.ts` | Server-only moderation and image edit; fixed request parameters and usage-based cost estimate. |
| `src/lib/custom-projects.ts` | Six server-allowlisted project types and allowed color/material directions; no implied product or service catalog. |
| `src/lib/catalog.ts`, `public/products/` | Optional sofa references and local images only; verify against approved catalog media before launch. |
| `tests/security.test.ts` | Local checks for early rejection, model/reserve config, Turnstile failure, and image validation. |
| `tests/room-design-flow.test.ts` | Mocked full POST flow for a kitchen concept, optional sofa reference, and rejection before paid image edit. |
| `tests/gateway.test.ts` | Rejects unsafe AI Gateway URLs and checks separation of OpenAI and Cloudflare credentials. |
| `tests/redis-guards.integration.test.ts` | Runs the production Lua guards against an isolated real Redis 7 container. |
| `.github/workflows/ci.yml` | Production dependency audit, typecheck, tests, isolated Redis guard integration, and production build on GitHub pushes and pull requests. |
| `demo/index.html`, `demo/*.png`, `demo/paid-local-e2e-concept.jpg` | Offline fictional comparison plus the protected-route image result for review. The demo page makes no API calls and contains no credentials. |
| `scripts/paid-smoke.ts` | Explicit one-attempt provider smoke test using the fictional kitchen photo. It does not exercise the public API guards. |
| `scripts/local-e2e/` | Loopback-only edge proxy and Redis REST adapter for end-to-end developer tests without weakening the production route. |

### Offline visual demo

Open `demo/index.html` in a browser and drag the comparison control. The comparison uses two fictional images created with the built-in imagegen tool; a separate panel shows the real protected-route API result from the same fictional room. The static page does not call this application, OpenAI, Turnstile, or Redis. It illustrates the concept experience and one provider output; it does **not** prove consistent model quality, Kanabco's manufacturing ability, or a price. `demo/README.md` records the presentation-image prompts. The real protected flow remains behind `/api/room-design`.

### Product behavior and API shape

The browser sends exactly one multipart upload and these fields: `{ image, projectType, productId?, style, color, material, roomWidthCm?, turnstileToken }`. `projectType` is one of `sofa`, `bed`, `wardrobe`, `dresser`, `dressing-room`, `kitchen`. `productId` is optional and valid only with `sofa`; omitting it asks for a new sofa concept from the controlled design choices. Styles, colors, and materials are fixed server-side enums. The visitor cannot provide a free-text prompt, model, URL, additional file, or OpenAI parameters.

The browser decodes a selected photo and checks its size, pixel count, and aspect ratio before enabling submit, so an obviously invalid image does not consume a Turnstile token or request quota. These checks are only for feedback; the server independently verifies the file signature, dimensions, and decoded pixels at gate 9.

The response describes a `project` with `type`, `label`, `source` (`custom-concept` or `catalog-reference`), nullable product fields, `priceEgp: null`, and a specialist quote note. The image and disclaimer accompany it. A concept-only category has no product identity. The UI must never label a bed, wardrobe, dresser, dressing room, or kitchen concept as an available Kanabco product or confirmed Kanabco service. A specialist can discuss whether the idea is feasible and quote it after review.

### Exact API gate order

1. `AI_FEATURE_ENABLED=true`; otherwise 503.
2. POST handler, exact Origin/Referer and `X-Requested-With`, trusted edge header, multipart content type, bounded body.
3. Strict allowlist of `image`, `projectType`, optional `productId`, `style`, `color`, `material`, optional `roomWidthCm`, and `turnstileToken`; one value per field. The category and product compatibility check runs at gate 9.
4. Cloudflare Turnstile siteverify, expected hostname/action, then Redis single-use token cache (10 minutes).
5. Atomic per-IP and per-session concurrency slots.
6. Atomic sitewide concurrency slot in the same script.
7. Rolling minute and UTC-day IP/session/site request quotas.
8. Per-session and global daily USD reservations, using a code-enforced minimum reservation of $1 for each admitted image call.
9. Project/material allowlists, optional sofa product allowlist, image byte/signature/pixel checks, EXIF stripping, bounded room width, and 10-minute exact-repeat rejection.
10. OpenAI Moderations on the photo and server-built prompt; failure closes the route. Image moderation covers supported categories, not every private or unsafe detail in a photo.
11. One server-chosen `gpt-image-2.5-flare-2026-09-08` edit from the room photo and optional sofa reference: one output, low quality, approximately 1 MP in the source orientation, JPEG, no tools or retries.
12. Record reported image/text tokens, estimate cost from the dated model's current rates, keep at least the reserved $1 charged against the application quota, and emit `SPEND_SPIKE` from the separate estimated-spend counter when its threshold is crossed. The response must include consistent nonnegative integer `usage.input_tokens`, `usage.input_tokens_details.image_tokens`, `usage.input_tokens_details.text_tokens`, `usage.output_tokens`, and `usage.total_tokens`. If a field is missing or totals disagree, atomically stop new image calls until the next UTC day.
13. Re-encode pixels and return JSON with a plain disclaimer and a `project` object. Only a selected sofa reference may add product metadata; no response claims a price or availability. React renders text; no raw model HTML is inserted.

Any guard-store, Turnstile, moderation, or config failure before step 11 blocks the image call. OpenAI moderation itself may run at step 10, but the image edit does not. A quota-store failure during settlement after step 11 can return 503 even though the image edit was billed; the `UNSETTLED_IMAGE_ATTEMPT` log flags that case. There is no queue: a full concurrency bucket returns 429.

## Set up locally

1. Use Node.js 20 or newer. Run `npm ci`.
2. Copy `.env.example` to `.env.local`; fill it with a dedicated **test project** key and the loopback settings in [`scripts/local-e2e/README.md`](scripts/local-e2e/README.md). Use different random 32+ character secrets for `SESSION_SIGNING_KEY`, `AI_EDGE_SHARED_SECRET`, and the local Redis REST token.
3. Run the documented loopback edge proxy and disposable Redis adapter. Even local API requests require the edge secret; the proxy injects it. Do not put that secret into browser code.
4. Run `npm run typecheck`, `npm test`, and `npm run build`. The included GitHub Actions workflow also runs the Redis Lua tests in an isolated container; provider and infrastructure checks still require staging.
5. After infrastructure, approved photo notice, and live integration checks pass, set `AI_FEATURE_ENABLED=true` in server environment configuration. Set it back to `false` to disable image calls. A hosting platform may need to restart or refresh functions after an environment change; the application code does not need to change.

The loopback development server permits `unsafe-eval` in its Content Security Policy because React uses it for development debugging. The production build omits it. If an already open preview tab reports an `eval()` console error after a configuration change, restart Next.js and reload that tab; the production policy is not relaxed.

When enabled, `/api/config` issues a signed `HttpOnly`, `Secure` in production, `SameSite=Lax` cookie and returns the widget site key and approved photo-notice URL. When disabled, it returns 503 so the UI does not show an active verification control. `/api/catalog` exposes only optional sofa-reference metadata. `/api/room-design` requires the cookie and a fresh Turnstile token. The UI sends multipart data containing only the allowed fields above; it cannot set the OpenAI body. A selected sofa image is loaded from the server's own catalog, never from a visitor URL. For the other five categories, the customer's room photo is the only input image. Style, color, and material are visual directions, not an approved manufacturing specification.

To run the atomic Redis guards locally, use a **disposable** Redis 7 container from the package directory. The integration test calls `FLUSHDB` inside that container and refuses names that do not begin `kanabco-redis-test`:

```sh
docker run -d --name kanabco-redis-test redis:7-alpine redis-server --save '' --appendonly no
KANABCO_REDIS_TEST_CONTAINER=kanabco-redis-test node --import tsx --test tests/redis-guards.integration.test.ts
docker rm -f kanabco-redis-test
```

### Paid local tests — completed

On 28 September 2026, the owner bought $10 in organization-level prepaid API credits, turned auto-reload off, and set an enforced $50 monthly spend limit on the dedicated Kanabco project. Alerts are set at 50% ($25), 80% ($40), 95% ($47.50), plus the default 100% ($50). A restricted, user-owned project key named **Kanabco Website Server** permits only Images Request and Moderations Request. It has no expiry and is stored only in the gitignored, mode-600 `.env.local`; do not copy it into the handoff or send it to the team. Project IP allowlisting awaits the deployment server's known egress IP.

The first direct provider smoke test used `gpt-image-2.5-flare-2026-09-08` and a fictional kitchen photo. Its copy is `demo/paid-kitchen-concept.jpg`; the output changed the window and part of the room geometry, so it proved provider connectivity but did not pass the photo-fidelity criterion. Reported usage was 1,452 image input tokens, 238 text input tokens, and 196 output tokens, estimated at about $0.02.

The server was then revised to request an approximately 1 MP output matching the normalized photo's orientation and to protect permanent geometry in the prompt. Paid edits passed through the local proxy, real Redis guards, Cloudflare's **development test** Siteverify, moderation, and the protected API route. Early recorded edits reported about 1,775 input tokens and 144 output tokens, estimated at about $0.02 each. The saved result `demo/paid-local-e2e-concept.jpg` broadly preserves the doorway and window proportions on visual inspection. It still requires representative staging tests across all six categories, including a sofa reference. Inputs outside the provider's 1:3–3:1 aspect range fail before any paid call.

The first protected-route edit occurred during a negative test because Cloudflare's always-pass test secret accepted a non-dummy token in practice. The **development-only** flow now gives the browser a fresh, signed, five-minute token bound to its session. The server checks that token, sends only Cloudflare's exact official dummy token to Siteverify, and consumes the signed token once in Redis. Production continues to require a real Turnstile token, the configured hostname, and the `room_design` action. The local test harness and exact steps are in [`scripts/local-e2e/README.md`](scripts/local-e2e/README.md). It uses no mock OpenAI response or in-memory quota substitute.

On 29 September local time, browser tests with the same fictional room photo generated Kitchen and Wardrobe concepts with fresh local tokens. These returned before/after results through the protected route at about $0.02 estimated provider cost per result. The loopback-only configuration permits seven admitted requests and reserves $7 total per UTC day; remaining slots change as tests run. The production example limits are unchanged. The UI also distinguishes invalid photo/selection errors from verification errors. Automated route tests cover all six custom categories; paid, production-protected quality is not established for the other categories.

For a separately authorized future smoke test with a separate test project and hard limit, this is the one-attempt command:

```sh
PAID_SMOKE_CONFIRM=one-generation node --import tsx scripts/paid-smoke.ts
```

The one-attempt script is retained for a separately authorized future provider check. It does not exercise the protected route. The loopback test mode must never be deployed publicly; keep `AI_FEATURE_ENABLED=false` in the production environment until the real Cloudflare and Upstash setup passes staging acceptance.

## Environment variables

Copy `.env.example` and use exact values for the deployment. Every credential field in the example is blank so copying it cannot accidentally activate a public secret. Dollar amounts are USD, measured approximately against the application budget; all Redis cost counters are integer cents.

| Variable | Example / role |
| --- | --- |
| `AI_FEATURE_ENABLED` | `false` until launch; server route kill switch. |
| `ALLOWED_ORIGIN` | `https://custom.kanabco.net`; exact frontend origin, no trailing slash. |
| `AI_TRUSTED_CLIENT_IP_HEADER` | `cf-connecting-ip`; trust only after the Cloudflare/origin setup below. |
| `AI_EDGE_SHARED_SECRET` | Unique 32+ character secret injected **only by Cloudflare** into origin requests. |
| `SESSION_SIGNING_KEY` | Different unique 32+ character server secret for signed anonymous cookies and private IP hashes. |
| `TURNSTILE_SITE_KEY` | Public widget key; the only Turnstile value sent to the browser. |
| `TURNSTILE_SECRET_KEY` | Server-only siteverify secret. |
| `TURNSTILE_EXPECTED_HOSTNAME` | `custom.kanabco.net`; must match siteverify response. |
| `AI_PHOTO_PRIVACY_URL` | Approved public HTTPS notice for room-photo processing and retention. Required whenever the AI feature is enabled in production; `/api/config` and the image route fail closed if missing. The UI links it beside the upload control. |
| `KANABCO_LOCAL_TURNSTILE_TEST` | `false` in deployment. `true` is accepted only with exact Cloudflare dummy keys, `NODE_ENV=development`, loopback origin, and loopback client IP. The local button gets a unique, session-bound test token; the server still calls Siteverify with the official dummy token and uses the Redis replay cache. |
| `OPENAI_API_KEY` | Project-scoped server-only key; never use `NEXT_PUBLIC_`, `VITE_`, or another public prefix. |
| `OPENAI_IMAGE_MODEL` | Only `gpt-image-2.5-flare-2026-09-08` is accepted for this anonymous route. |
| `OPENAI_IMAGE_TIMEOUT_MS` | `150000`, maximum `180000`; image edits can take longer than text chat. The route has a 240-second host duration. |
| `CLOUDFLARE_AI_GATEWAY_URL` | Optional provider-native base such as `https://gateway.ai.cloudflare.com/v1/ACCOUNT_ID/GATEWAY_ID/openai`; replace `ACCOUNT_ID` with its 32-hex value and `GATEWAY_ID` with its slug. Only this Cloudflare host and path shape are accepted. Leave empty for direct OpenAI. The application still applies every own guard. |
| `CF_AIG_TOKEN` | Optional server-only Cloudflare AI Gateway token for an authenticated gateway; never send it to the browser. Leave empty for a gateway without Cloudflare authentication or when the gateway is disabled. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Private Upstash REST connection; both required once requests run. |
| `AI_MAX_BODY_BYTES`, `AI_MAX_IMAGE_BYTES`, `AI_MAX_IMAGE_PIXELS` | `4000000`, `3500000`, `12000000`; request body, photo file, and decoded image limits. The server rejects overrides above these body/file ceilings so a common 4.5 MB function payload limit cannot be bypassed. |
| `AI_REQ_PER_MIN_PER_IP`, `AI_REQ_PER_DAY_PER_IP` | `2`, `10`; rolling minute and UTC day. |
| `AI_REQ_PER_DAY_PER_SESSION`, `AI_REQ_PER_DAY_GLOBAL` | `2`, `100`; cookie and sitewide quotas. |
| `AI_MAX_INFLIGHT_PER_IP`, `AI_MAX_INFLIGHT_PER_SESSION`, `AI_MAX_INFLIGHT_GLOBAL` | `1`, `1`, `2`; atomic Redis slots. |
| `AI_IMAGE_RESERVED_USD` | `1.00`, minimum enforced in code; capacity reserved before each paid edit. Calibrate **upward** from real token usage before expanding traffic. |
| `AI_DAILY_SESSION_USD_CAP`, `AI_DAILY_GLOBAL_USD_CAP` | `2.00`, `10.00`; UTC-day application circuit breakers. |
| `ALERT_SPEND_USD_PER_10MIN` | `2.00`; logs `SPEND_SPIKE` when estimated spend across ten one-minute buckets crosses this amount. Connect a real alert sink. |
| `LOG_PROMPTS` | `false`; only the server-built prompt can be logged if explicitly set true. Customer images are never logged. |

The earlier **text chatbot** variables such as `OPENAI_MODEL`, `OPENAI_MAX_TOKENS`, and `AI_TOKENS_PER_DAY_PER_IP` belong to its separate text endpoint. This image endpoint uses a server-selected aspect-matched output size, fixed quality, and dollar reservations instead of a text `max_tokens` parameter. Apply the text controls to the existing chatbot when its repository is available.

## OpenAI dashboard status and remaining setup

The owner completed the dedicated project, server-only restricted key, $50 enforced monthly hard limit, spend alerts, $10 prepaid purchase, and auto-reload-off setting. The development team must preserve those controls in production and finish the remaining dashboard and deployment work:

1. Arrange a fixed deployment egress IP, then allowlist only the server's egress IPs for this key. Dynamic serverless egress cannot satisfy this control. Leave AI Gateway disabled unless its outbound path can also satisfy the project's IP allowlist; moderation still calls OpenAI directly from the server.
2. Transfer project access through the organization's access controls, or create a deployment secret directly in the hosting platform. Do not share the long-lived key through GitHub, chat, the handoff ZIP, or the frontend.
3. Keep the $50 hard limit and 50%/80%/95% alerts under review; change the amount only with the owner's decision. Keep prepaid auto-reload off while anonymous access is public.
4. Revoke and rotate the key immediately if it appears in a repository, client bundle, browser network response, or log. Never commit `.env.local`.

The OpenAI project limit is the final bill backstop, but [OpenAI states enforcement can lag slightly](https://developers.openai.com/api/docs/guides/spend-limits); prepaid depletion can also overshoot. The configured $50 is therefore **not an exact maximum possible charge**. No application reservation can guarantee an exact maximum charge for a call whose image-token total is unknown until it finishes. Raise the project hard limit only with the owner's decision after real usage is measured.

In staging, inspect the actual Images Edit response with a test project before public traffic. Confirm that `usage.input_tokens`, `usage.input_tokens_details.image_tokens`, `usage.input_tokens_details.text_tokens`, `usage.output_tokens`, and `usage.total_tokens` are present as consistent nonnegative integers for both a room-only concept and a sofa-reference concept. The code emits `USAGE_UNKNOWN_DAILY_BREAKER` and refuses further image calls until the next UTC day when a field is missing or totals disagree. Resolve provider-response differences and recalibrate `AI_IMAGE_RESERVED_USD` before launch.

## Cloudflare and origin: human setup

1. Proxy the feature's public hostname through Cloudflare and create a Turnstile widget restricted to that hostname. Configure the public site key and server secret. The UI uses action `room_design`; the server rejects a different hostname/action and replays.
2. Add a WAF rate-limit rule for `POST /api/room-design`, for example 10 requests/minute/IP followed by managed challenge or block. Add a separate rule for repeated abusive traffic if needed. Enable Bot Fight Mode or Super Bot Fight Mode where available. The raw API route needs WAF even though the form has Turnstile.
3. Add a **Request Header Transform Rule** for the feature hostname and API path that unconditionally **sets/overwrites** `X-Kanabco-Edge-Secret` to the `AI_EDGE_SHARED_SECRET` value on the origin request. Apply it to POST and OPTIONS. Never send this value in frontend code, CORS allowed headers, or a response. The origin rejects missing/wrong values.
4. Ensure the origin cannot be reached without Cloudflare where hosting permits it: lock origin firewall/ingress to Cloudflare or disable the default direct origin URL. If a direct hosting URL remains, its requests still fail without the edge secret. Do not trust `CF-Connecting-IP` unless the request passed that trusted edge; the header is otherwise spoofable.
5. Restrict the Turnstile site key to the feature hostname and serve only over HTTPS. The provided CSP allows Cloudflare's challenge script/frame and denies other frames. Review it alongside any sitewide CSP before merging.
6. Verify a raw origin POST with forged `Origin` and `CF-Connecting-IP`, but **without** the injected secret, gets 403. Verify the proxied public path works with a valid token. Inspect WAF and application logs before turning on `AI_FEATURE_ENABLED`.

The optional AI Gateway applies only to the image edit; the moderation request goes directly from the server to OpenAI. Use the [provider-native OpenAI gateway base](https://developers.cloudflare.com/ai-gateway/usage/providers/openai/) and `CF_AIG_TOKEN` if [gateway authentication](https://developers.cloudflare.com/ai-gateway/configuration/authentication/) is enabled. Smoke-test both the gateway request and OpenAI key IP allowlisting with the final egress route before setting `CLOUDFLARE_AI_GATEWAY_URL`. If the allowlist cannot be satisfied, leave this option empty.

## Failure modes

| Condition | Visitor sees | Paid Images Edit called? |
| --- | --- | --- |
| Flag off or config missing | Temporary unavailability (503) | No |
| Bad origin/edge header/content type, oversized body, malformed fields | Generic verification or size error (403/415/413/400) | No |
| Invalid/reused/expired Turnstile token | Verification error (403) | No |
| Redis down or quota store unavailable before the image edit | Temporary unavailability (503) | No |
| Concurrency, request, repeat, dollar cap, or unknown-usage daily breaker | Busy/free-limit message (429, `Retry-After` where known) | No |
| Invalid image, category/material choice, sofa reference, or moderation rejection | Generic validation/verification error | No |
| OpenAI image timeout/failure after call starts | Temporary unavailability (503) | **May have been called and billed** |
| Quota-store settlement fails after a successful image edit | Temporary unavailability (503); `UNSETTLED_IMAGE_ATTEMPT` log | **Yes; may have been billed** |
| Valid result | Before/after concept view, download, advisor link | Yes, once |

Moderation failures are deliberately generic. The API does not return provider stack traces, key fragments, or quota internals. Automated photo moderation covers its supported categories and cannot guarantee detection of every private detail, unsafe image, or impractical design. Every attempt is logged with time, route, masked IP, hashed session, input character and image byte counts, model, token counts when available, approximate USD cents, Turnstile result, reason and latency. Full visitor photos and text are not retained by this package; browser preview URLs are local to the page session. OpenAI receives the photo for processing under the project's API data controls. Set log retention and the public privacy notice with the team's privacy policy.

Before launch, approve a photo-processing and retention notice with the privacy owner and link its public URL beside the upload control. Approve the official brand and sofa reference media, test a clear manual path from the downloaded concept to a specialist, and have product specialists review representative staging outputs for all six categories. Record cost and photo fidelity for each category; a successful API response alone is not a quality acceptance.

## Abuse checks before launch

Use a staging Cloudflare hostname and test project, with `AI_FEATURE_ENABLED=true` **only in staging**. Use browser DevTools to capture a valid same-origin multipart request; do not put the edge secret into `curl` from a laptop. Cloudflare must inject it upstream. Check the app logs or a mocked provider to confirm blocked cases do not reach Images Edit.

| Test | Expected |
| --- | --- |
| Raw `curl -i -X POST https://STAGING_HOST/api/room-design` with no Origin or token | 403 at the origin check, no image call. Also test a correctly formed same-origin multipart request without `turnstileToken`: 400, no image call. |
| Replay a valid captured request with its already-used Turnstile token | 403, no image call. |
| Send `Content-Length` over `AI_MAX_BODY_BYTES`, then stream a truly oversized body | 413, no image call. |
| POST with no `Origin` header or a foreign origin | 403, no image call. |
| POST to the raw origin URL with forged IP and Origin but no edge secret | 403, no image call. |
| Burst fresh-token requests beyond IP/minute, session/day, or global slots | 429, no further image calls. |
| Submit `projectType=kitchen` with any `productId`, or an unlisted material for that category | 400, no image call. |
| Set `AI_FEATURE_ENABLED=false` | 503, no image call. |
| Stop Redis or Turnstile siteverify in staging | 503 or 403, no image call. |
| Use a mocked Images Edit response without any required detailed usage field | One image call may complete; `USAGE_UNKNOWN_DAILY_BREAKER` logs and later image calls stop until the next UTC day. |

Check `Retry-After` on 429s and confirm `ROOM_DESIGN_ATTEMPT`, `SPEND_SPIKE`, `USAGE_UNKNOWN_DAILY_BREAKER`, and `UNSETTLED_IMAGE_ATTEMPT` are routed to monitored logs. Run `rg -n 'sk-' . --glob '!package-lock.json' --glob '!README.md'` and your organization's secret scanner before committing. Enable GitHub secret scanning and push protection if the source is on GitHub.

## Known product and deployment decisions

- **Category scope:** The six selectors are idea types, not a claim that Kanabco stocks or produces all six. Current confirmed made-to-order policy covers sofas/chairs; the team must separately approve any claim about beds, wardrobes, dressers, dressing rooms, or kitchens. A kitchen visual does not assess plumbing, electrical, ventilation, structure, or installation. Keep the concept disclaimer visible before and after generation.
- **Advisor handoff:** The current UI downloads the concept and opens Kanabco's homepage, where the visitor can find contact options. The visitor shares the image/reference manually if they wish. There is no automatic lead attachment, photo storage, or advisor message. To add an automatic handoff, create a server-side flow with explicit consent, access controls, short retention, and a private advisor view. Do not expose generated images through public URLs.
- **Pricing:** Every generated project returns `priceEgp: null`, including projects with a sofa reference. Do not show a numerical price until an authoritative live SKU/variant source and tax/delivery rules are connected. For concept-only categories, a specialist must first decide whether Kanabco can make the proposed item, then scope dimensions, materials, availability, installation where relevant, and final price. The image is not an order specification.
- **Anonymous quota:** A user can delete the cookie and receive a new session. IP and global caps still apply, but “two per person” is not a guarantee. Add a login or verified phone gate before raising image allowances.
- **Image cost:** OpenAI publishes token rates for GPT Image 2.5 but not a fixed worst-case price for every room-photo edit, with or without a sofa reference. The $1 reserve is deliberately conservative, yet provisional. Run a small paid staging sample across all six categories, inspect usage, and raise the reserve if necessary before public launch. Never lower it below the enforced floor to gain throughput.
- **Hosting timeout:** The photo call defaults to 150 seconds and permits up to 180 seconds. Choose a Node.js host/function with at least 240 seconds total duration and enough memory for image decoding. A short-timeout serverless plan will return failures. The route uses `maxDuration=240`; the UI waits up to 250 seconds for transit and response handling.
- **Hosting payload:** Both the multipart request and generated-image JSON response are capped at 4 MB, leaving headroom under common 4.5 MB function payload limits. The server photo file limit is 3.5 MB. The browser accepts photos up to 8 MB and resizes/re-encodes larger files locally before upload; an uncompressible photo receives a clear error. Confirm your chosen host's actual request and response limits before launch.
- **Self-host build:** Run `npm ci && npm run build && npm start` from the source checkout. Do not deploy `.next/standalone` alone; it lacks the static assets and brand media needed by this app.
- **Catalog:** The two local sofa images came from a Kanabco catalog kit; confirm photo rights/accuracy and replace them with storefront-approved media. They are optional references for the sofa selector only. The five other categories work without SKUs, product photos, or catalog entries. Add a new reference only after the product and its claims have been approved.
- **Repository handoff:** The private `omardawoud77/kanabco-room-designer` repository holds this standalone package for review. GitHub Actions checks typecheck, unit tests, real Redis Lua guards, and build, but it cannot prove live OpenAI usage fields, Cloudflare policy, WAF enforcement, egress IP allowlisting, or catalog accuracy. Integrate into the actual live site repository after its stack and ownership are confirmed.

## Phase 2

Add a verified login gate before the first generation, then per-user ID rate limits and SHA-256 `safety_identifier` for any Responses/Chat request. Offer paid quota or customer-owned API keys (BYOK) only after billing and support rules are designed. An AI Gateway can add another spend control but does not replace application limits. Use SMS step-up selectively for suspicious usage, not on every request. Add an advisor-side lead workflow, consent and retention controls, and validated product pricing when the live site interfaces are available.

## Reference documentation

- [OpenAI image generation and pricing behavior](https://developers.openai.com/api/docs/guides/image-generation)
- [OpenAI Images Edit API parameters](https://developers.openai.com/api/reference/typescript/resources/images/methods/edit)
- [OpenAI GPT Image 2.5 Flare model rates](https://developers.openai.com/api/docs/models/gpt-image-2.5-flare)
- [OpenAI project spend limits](https://developers.openai.com/api/docs/guides/spend-limits)
- [Cloudflare Turnstile server validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
- [Cloudflare request-header transform rules](https://developers.cloudflare.com/rules/transform/request-header-modification/)
- [Cloudflare origin protection](https://developers.cloudflare.com/fundamentals/security/protect-your-origin-server/)
