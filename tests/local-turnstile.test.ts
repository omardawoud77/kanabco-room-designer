import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { POST as mintToken } from "../src/app/api/local-turnstile/route";
import { publicConfig, serverConfig } from "../src/lib/config";
import { newSessionCookie } from "../src/lib/identity";
import { verifyTurnstile } from "../src/lib/turnstile";

const ORIGIN = "http://127.0.0.1:3460";
const ENV_KEYS = [
  "NODE_ENV", "AI_FEATURE_ENABLED", "KANABCO_LOCAL_TURNSTILE_TEST", "ALLOWED_ORIGIN",
  "AI_TRUSTED_CLIENT_IP_HEADER", "SESSION_SIGNING_KEY", "AI_EDGE_SHARED_SECRET",
  "TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY", "TURNSTILE_EXPECTED_HOSTNAME", "OPENAI_API_KEY", "AI_PHOTO_PRIVACY_URL",
] as const;

function configureLocal() {
  Reflect.set(process.env, "NODE_ENV", "development");
  process.env.AI_FEATURE_ENABLED = "true";
  process.env.KANABCO_LOCAL_TURNSTILE_TEST = "true";
  process.env.ALLOWED_ORIGIN = ORIGIN;
  process.env.AI_TRUSTED_CLIENT_IP_HEADER = "cf-connecting-ip";
  process.env.SESSION_SIGNING_KEY = "test-only-session-signing-key-with-more-than-32-characters";
  process.env.AI_EDGE_SHARED_SECRET = "test-only-edge-secret-with-more-than-32-characters";
  process.env.TURNSTILE_SITE_KEY = "1x00000000000000000000AA";
  process.env.TURNSTILE_SECRET_KEY = "1x0000000000000000000000000000000AA";
  process.env.TURNSTILE_EXPECTED_HOSTNAME = "127.0.0.1";
  process.env.OPENAI_API_KEY = "test-key-not-real";
}

function request(cookie?: string, origin = ORIGIN, url = `${ORIGIN}/api/local-turnstile`, body?: string) {
  return new NextRequest(url, {
    method: "POST",
    body,
    headers: {
      origin,
      host: new URL(url).host,
      "x-requested-with": "website",
      ...(cookie ? { cookie } : {}),
    },
  });
}

test("local tokens are fresh, session-bound, short-lived, and verified with only Cloudflare's fixed dummy token", async () => {
  const prior = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  configureLocal();
  try {
    const config = serverConfig();
    assert.equal(publicConfig(config).localTestMode, true);
    const session = newSessionCookie(config);
    const cookie = `${session.name}=${session.value}`;
    const sessionId = session.value.split(".")[0];
    assert.equal((await mintToken(request())).status, 401);
    assert.equal((await mintToken(request(cookie, "http://localhost:3460"))).status, 403);
    assert.equal((await mintToken(request(cookie, ORIGIN, "http://localhost:3460/api/local-turnstile"))).status, 404);
    const forgedHost = request(cookie, ORIGIN, "http://example.com/api/local-turnstile");
    forgedHost.headers.set("host", "127.0.0.1:3461");
    assert.equal((await mintToken(forgedHost)).status, 404);

    assert.equal((await mintToken(request(cookie, ORIGIN, `${ORIGIN}/api/local-turnstile`, ""))).status, 200);
    assert.equal((await mintToken(request(cookie, ORIGIN, `${ORIGIN}/api/local-turnstile`, "data"))).status, 400);
    assert.equal((await mintToken(request(cookie, ORIGIN, `${ORIGIN}/api/local-turnstile`, "123456789"))).status, 413);

    const first = await mintToken(request(cookie));
    const second = await mintToken(request(cookie));
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const firstToken = (await first.json() as { token: string }).token;
    const secondToken = (await second.json() as { token: string }).token;
    assert.match(firstToken, /^localtest\.v1\./);
    assert.notEqual(firstToken, secondToken);

    const providerBodies: Array<{ response: string }> = [];
    globalThis.fetch = async (_input, init) => {
      providerBodies.push(JSON.parse(String(init?.body)) as { response: string });
      return new Response(JSON.stringify({ success: true, hostname: "example.com", metadata: { result_with_testing_key: true } }), { status: 200 });
    };
    assert.equal(await verifyTurnstile(firstToken, "127.0.0.1", config, sessionId), true);
    assert.equal(await verifyTurnstile(secondToken, "127.0.0.1", config, sessionId), true);
    assert.deepEqual(providerBodies.map(({ response }) => response), ["XXXX.DUMMY.TOKEN.XXXX", "XXXX.DUMMY.TOKEN.XXXX"]);

    assert.equal(await verifyTurnstile(firstToken, "127.0.0.1", config, "other-session"), false);
    const changedEnd = firstToken.endsWith("A") ? "B" : "A";
    assert.equal(await verifyTurnstile(`${firstToken.slice(0, -1)}${changedEnd}`, "127.0.0.1", config, sessionId), false);
    assert.equal(await verifyTurnstile("XXXX.DUMMY.TOKEN.XXXX", "127.0.0.1", config, sessionId), false);
    assert.equal(await verifyTurnstile(firstToken, "203.0.113.4", config, sessionId), false);
    assert.equal(providerBodies.length, 2);

    Date.now = () => originalNow() + 6 * 60_000;
    assert.equal(await verifyTurnstile(firstToken, "127.0.0.1", config, sessionId), false);
    Date.now = originalNow;

    Reflect.set(process.env, "NODE_ENV", "production");
    process.env.ALLOWED_ORIGIN = "https://kanabco.net";
    process.env.AI_PHOTO_PRIVACY_URL = "https://kanabco.net/photo-privacy";
    assert.equal((await mintToken(request(cookie))).status, 404);
    assert.equal(await verifyTurnstile(firstToken, "127.0.0.1", config, sessionId), false);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    for (const key of ENV_KEYS) {
      const value = prior[key];
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else Reflect.set(process.env, key, value);
    }
  }
});
