import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { NextRequest } from "next/server";
import { POST } from "../src/app/api/room-design/route";
import { newSessionCookie } from "../src/lib/identity";
import { serverConfig } from "../src/lib/config";

const URL = "https://kanabco.net/api/room-design";
const EDGE_SECRET = "test-only-edge-secret-with-more-than-32-characters";

type ProviderCall = {
  destination: string;
  body: BodyInit | null | undefined;
};

function configure() {
  process.env.AI_FEATURE_ENABLED = "true";
  process.env.ALLOWED_ORIGIN = "https://kanabco.net";
  process.env.AI_TRUSTED_CLIENT_IP_HEADER = "cf-connecting-ip";
  process.env.SESSION_SIGNING_KEY = "test-only-session-signing-key-with-more-than-32-characters";
  process.env.AI_EDGE_SHARED_SECRET = EDGE_SECRET;
  process.env.TURNSTILE_SITE_KEY = "test-site-key";
  process.env.TURNSTILE_SECRET_KEY = "test-secret-key";
  process.env.TURNSTILE_EXPECTED_HOSTNAME = "kanabco.net";
  process.env.OPENAI_API_KEY = "test-key-not-real";
  process.env.UPSTASH_REDIS_REST_URL = "https://mock.redis.invalid";
  process.env.UPSTASH_REDIS_REST_TOKEN = "test-redis-token-not-real";
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function redisResult(command: unknown): unknown {
  assert.ok(Array.isArray(command));
  if (command[0] === "set") return "OK";
  assert.equal(command[0], "eval");
  const script = String(command[1]);
  if (script.includes("local result = redis.call('SET'")) return 1;
  if (script.includes("local lease_end")) return 0;
  if (script.includes("session_total + reserve")) return [0, 0];
  if (script.includes("local ten_spend")) return [0, 0];
  if (script.includes("for i = 1, 3 do redis.call('ZREM'")) return 1;
  if (script.includes("'cancelled'")) return 1;
  throw new Error("Unexpected Redis script in integration test");
}

async function withProviders<T>(run: (calls: ProviderCall[]) => Promise<T>): Promise<T> {
  configure();
  const generated = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#d9d0c6" } }).jpeg().toBuffer();
  const originalFetch = globalThis.fetch;
  const calls: ProviderCall[] = [];
  globalThis.fetch = async (input, init) => {
    const destination = String(input);
    calls.push({ destination, body: init?.body });
    if (destination === "https://challenges.cloudflare.com/turnstile/v0/siteverify") {
      return json({ success: true, hostname: "kanabco.net", action: "room_design" });
    }
    if (destination === "https://mock.redis.invalid/pipeline") {
      const commands = JSON.parse(String(init?.body)) as unknown[];
      return json(commands.map((command) => ({ result: redisResult(command) })));
    }
    if (destination === "https://api.openai.com/v1/moderations") {
      return json({ results: [{ flagged: false }] });
    }
    if (destination === "https://api.openai.com/v1/images/edits") {
      return json({
        data: [{ b64_json: generated.toString("base64") }],
        usage: { input_tokens: 250, input_tokens_details: { image_tokens: 200, text_tokens: 50 }, output_tokens: 100, total_tokens: 350 },
      });
    }
    throw new Error(`Unexpected provider call: ${destination}`);
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function requestFor(projectType: string, productId?: string): Promise<NextRequest> {
  const image = await sharp({ create: { width: 400, height: 400, channels: 3, background: "#d9d0c6" } }).jpeg().toBuffer();
  const form = new FormData();
  form.set("image", new Blob([new Uint8Array(image)], { type: "image/jpeg" }), "room.jpg");
  form.set("projectType", projectType);
  if (productId) form.set("productId", productId);
  form.set("style", "warm-minimal");
  form.set("color", "warm-ivory");
  form.set("material", projectType === "sofa" ? "upholstery" : "wood");
  form.set("turnstileToken", `test-token-${crypto.randomUUID()}`);
  const session = newSessionCookie(serverConfig());
  return new NextRequest(URL, {
    method: "POST",
    headers: {
      origin: "https://kanabco.net",
      "x-requested-with": "website",
      "cf-connecting-ip": "203.0.113.4",
      "x-kanabco-edge-secret": EDGE_SECRET,
      cookie: `${session.name}=${session.value}`,
    },
    body: form,
  });
}

test("kitchen concept succeeds without any catalog product or price", async () => {
  await withProviders(async (calls) => {
    const response = await POST(await requestFor("kitchen"));
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.project.type, "kitchen");
    assert.equal(payload.project.source, "custom-concept");
    assert.equal(payload.project.productId, null);
    assert.equal(payload.project.priceEgp, null);
    assert.match(payload.project.priceNote, /specialist/);
    assert.match(payload.imageDataUrl, /^data:image\/jpeg;base64,/);
    const edits = calls.filter((call) => call.destination.endsWith("/images/edits"));
    assert.equal(edits.length, 1);
    assert.ok(edits[0].body instanceof FormData);
    assert.equal(edits[0].body.getAll("image[]").length, 1);
    assert.match(String(edits[0].body.get("prompt")), /not an existing Kanabco catalog product/);
  });
});

test("sofa concept includes the approved product reference but no instant quote", async () => {
  await withProviders(async (calls) => {
    const response = await POST(await requestFor("sofa", "160"));
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.project.type, "sofa");
    assert.equal(payload.project.source, "catalog-reference");
    assert.equal(payload.project.productId, "160");
    assert.equal(payload.project.priceEgp, null);
    const edits = calls.filter((call) => call.destination.endsWith("/images/edits"));
    assert.equal(edits.length, 1);
    assert.ok(edits[0].body instanceof FormData);
    assert.equal(edits[0].body.getAll("image[]").length, 2);
    assert.match(String(edits[0].body.get("prompt")), /approved Kanabco Arcus sofa reference/);
  });
});

test("a catalog product cannot be attached to a kitchen; no OpenAI call is made", async () => {
  await withProviders(async (calls) => {
    const response = await POST(await requestFor("kitchen", "160"));
    assert.equal(response.status, 400);
    assert.equal(calls.filter((call) => call.destination.startsWith("https://api.openai.com/")).length, 0);
    assert.ok(calls.some((call) => call.destination === "https://challenges.cloudflare.com/turnstile/v0/siteverify"));
  });
});
