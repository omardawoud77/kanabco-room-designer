import assert from "node:assert/strict";
import test from "node:test";
import { ConfigurationError, serverConfig } from "../src/lib/config";
import { editRoomImage, moderateRoomImage } from "../src/lib/openai-image";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const GATEWAY_BASE = `https://gateway.ai.cloudflare.com/v1/${ACCOUNT_ID}/kanabco-room/openai`;

function configure(): void {
  process.env.ALLOWED_ORIGIN = "https://kanabco.net";
  process.env.AI_TRUSTED_CLIENT_IP_HEADER = "cf-connecting-ip";
  process.env.SESSION_SIGNING_KEY = "test-only-session-signing-key-with-more-than-32-characters";
  process.env.AI_EDGE_SHARED_SECRET = "test-only-edge-secret-with-more-than-32-characters";
  process.env.TURNSTILE_SITE_KEY = "test-site-key";
  process.env.TURNSTILE_SECRET_KEY = "test-secret-key";
  process.env.TURNSTILE_EXPECTED_HOSTNAME = "kanabco.net";
  process.env.OPENAI_API_KEY = "test-key-not-real";
  delete process.env.OPENAI_IMAGE_MODEL;
  delete process.env.AI_IMAGE_RESERVED_USD;
  delete process.env.CLOUDFLARE_AI_GATEWAY_URL;
  delete process.env.CF_AIG_TOKEN;
}

function imageResponse(): Response {
  return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("fake-image").toString("base64") }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function callEdit(): Promise<void> {
  await editRoomImage({
    config: serverConfig(),
    room: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    prompt: "Test room design",
    safetyUserHash: "a".repeat(64),
  });
}

test("gateway URL accepts only the documented Cloudflare OpenAI provider base", () => {
  configure();
  process.env.CLOUDFLARE_AI_GATEWAY_URL = GATEWAY_BASE;
  assert.equal(serverConfig().gatewayBaseUrl, GATEWAY_BASE);

  const rejected = [
    "http://gateway.ai.cloudflare.com/v1/" + ACCOUNT_ID + "/kanabco-room/openai",
    "https://gateway.ai.cloudflare.com.evil.invalid/v1/" + ACCOUNT_ID + "/kanabco-room/openai",
    "https://user:password@gateway.ai.cloudflare.com/v1/" + ACCOUNT_ID + "/kanabco-room/openai",
    "https://gateway.ai.cloudflare.com:443/v1/" + ACCOUNT_ID + "/kanabco-room/openai",
    "https://gateway.ai.cloudflare.com/v1/" + ACCOUNT_ID + "/kanabco-room/openai?target=evil",
    "https://gateway.ai.cloudflare.com/v1/" + ACCOUNT_ID + "/kanabco-room/openai#fragment",
    "https://gateway.ai.cloudflare.com/v1/" + ACCOUNT_ID + "/kanabco-room/compat",
    "https://gateway.ai.cloudflare.com/v1/" + ACCOUNT_ID + "/kanabco-room/openai/",
    "https://gateway.ai.cloudflare.com/v1/" + ACCOUNT_ID + "/kanabco-room/%6fpenai",
    "https://gateway.ai.cloudflare.com/v1/not-an-account/kanabco-room/openai",
    "https://gateway.ai.cloudflare.com/v1/" + ACCOUNT_ID + "/../openai",
    "not-a-url",
  ];
  for (const value of rejected) {
    process.env.CLOUDFLARE_AI_GATEWAY_URL = value;
    assert.throws(() => serverConfig(), ConfigurationError, value);
  }
});

test("image edit uses the gateway path and separate Cloudflare authorization", async () => {
  configure();
  process.env.CLOUDFLARE_AI_GATEWAY_URL = GATEWAY_BASE;
  process.env.CF_AIG_TOKEN = "test-cloudflare-token-not-real";
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls++;
    assert.equal(String(input), `${GATEWAY_BASE}/images/edits`);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer test-key-not-real");
    assert.equal(headers.get("cf-aig-authorization"), "Bearer test-cloudflare-token-not-real");
    assert.ok(init?.body instanceof FormData);
    return imageResponse();
  };
  try {
    await callEdit();
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Cloudflare token is never sent to direct OpenAI endpoints", async () => {
  configure();
  process.env.CF_AIG_TOKEN = "test-cloudflare-token-not-real";
  const originalFetch = globalThis.fetch;
  const destinations: string[] = [];
  globalThis.fetch = async (input, init) => {
    const destination = String(input);
    destinations.push(destination);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer test-key-not-real");
    assert.equal(headers.get("cf-aig-authorization"), null);
    if (destination.endsWith("/moderations")) {
      return new Response(JSON.stringify({ results: [{ flagged: false }] }), { status: 200 });
    }
    return imageResponse();
  };
  try {
    await callEdit();
    process.env.CLOUDFLARE_AI_GATEWAY_URL = GATEWAY_BASE;
    assert.equal(await moderateRoomImage(serverConfig(), Buffer.from("room"), "Test room design"), true);
    assert.deepEqual(destinations, ["https://api.openai.com/v1/images/edits", "https://api.openai.com/v1/moderations"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
