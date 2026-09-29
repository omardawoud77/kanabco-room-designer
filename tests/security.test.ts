import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { NextRequest } from "next/server";
import { POST } from "../src/app/api/room-design/route";
import { GET as getPublicConfig } from "../src/app/api/config/route";
import { normalizeUploadedImage, InvalidImageError } from "../src/lib/images";
import { ConfigurationError, publicConfig, serverConfig } from "../src/lib/config";
import { billableUsageKnown, estimatedCostCents } from "../src/lib/openai-image";
import { buildRoomPrompt } from "../src/lib/prompt";
import { findProduct } from "../src/lib/catalog";
import { mintLocalTurnstileToken, verifyTurnstile } from "../src/lib/turnstile";

const URL = "https://kanabco.net/api/room-design";
const BASE_HEADERS = {
  origin: "https://kanabco.net",
  "x-requested-with": "website",
  "cf-connecting-ip": "203.0.113.4",
  "x-kanabco-edge-secret": "test-only-edge-secret-with-more-than-32-characters",
};

function configure() {
  process.env.AI_FEATURE_ENABLED = "true";
  process.env.ALLOWED_ORIGIN = "https://kanabco.net";
  process.env.AI_TRUSTED_CLIENT_IP_HEADER = "cf-connecting-ip";
  process.env.SESSION_SIGNING_KEY = "test-only-session-signing-key-with-more-than-32-characters";
  process.env.AI_EDGE_SHARED_SECRET = "test-only-edge-secret-with-more-than-32-characters";
  process.env.TURNSTILE_SITE_KEY = "test-site-key";
  process.env.TURNSTILE_SECRET_KEY = "test-secret-key";
  process.env.TURNSTILE_EXPECTED_HOSTNAME = "kanabco.net";
  process.env.OPENAI_API_KEY = "test-key-not-real";
}

test("kill switch rejects before reading the body or contacting providers", async () => {
  configure();
  process.env.AI_FEATURE_ENABLED = "false";
  const response = await POST(new NextRequest(URL, { method: "POST", headers: BASE_HEADERS }));
  assert.equal(response.status, 503);
});

test("disabled feature does not publish an active widget config", async () => {
  configure();
  process.env.AI_FEATURE_ENABLED = "false";
  const response = await getPublicConfig(new NextRequest("https://kanabco.net/api/config"));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Feature unavailable" });
});

test("missing Origin is rejected before provider contact", async () => {
  configure();
  const response = await POST(new NextRequest(URL, { method: "POST", headers: {
    "x-requested-with": "website", "content-type": "multipart/form-data; boundary=test",
  } }));
  assert.equal(response.status, 403);
});

test("missing trusted edge header is rejected before provider contact", async () => {
  configure();
  const headers = { ...BASE_HEADERS };
  delete (headers as Partial<typeof BASE_HEADERS>)["x-kanabco-edge-secret"];
  const response = await POST(new NextRequest(URL, { method: "POST", headers }));
  assert.equal(response.status, 403);
});

test("early rejects log the IP only after origin and edge authentication", async () => {
  configure();
  const originalInfo = console.info;
  const attempts: Array<{ ipMasked?: string; reason?: string }> = [];
  console.info = (message: unknown) => {
    if (typeof message === "string") attempts.push(JSON.parse(message));
  };
  try {
    const trusted = await POST(new NextRequest(URL, { method: "POST", headers: {
      ...BASE_HEADERS, "content-type": "application/json",
    }, body: "{}" }));
    assert.equal(trusted.status, 415);
    assert.equal(attempts.at(-1)?.ipMasked, "203.0.113.0");
    assert.equal(attempts.at(-1)?.reason, "content_type");

    const untrusted = await POST(new NextRequest(URL, { method: "POST", headers: {
      ...BASE_HEADERS, "x-kanabco-edge-secret": "wrong-secret", "cf-connecting-ip": "198.51.100.77",
    } }));
    assert.equal(untrusted.status, 403);
    assert.equal(attempts.at(-1)?.ipMasked, "unknown");
    assert.equal(attempts.at(-1)?.reason, "origin_or_edge");
  } finally {
    console.info = originalInfo;
  }
});

test("public image model and minimum cost reservation are fixed server-side", () => {
  configure();
  process.env.OPENAI_IMAGE_MODEL = "gpt-image-2.5-sunburst";
  assert.throws(() => serverConfig(), ConfigurationError);
  delete process.env.OPENAI_IMAGE_MODEL;
  process.env.AI_IMAGE_RESERVED_USD = "0.01";
  assert.throws(() => serverConfig(), ConfigurationError);
  delete process.env.AI_IMAGE_RESERVED_USD;
});

test("request and image limits cannot exceed the hosted payload ceiling", () => {
  configure();
  const priorBody = process.env.AI_MAX_BODY_BYTES;
  const priorImage = process.env.AI_MAX_IMAGE_BYTES;
  try {
    process.env.AI_MAX_BODY_BYTES = "4000001";
    assert.throws(() => serverConfig(), ConfigurationError);
    process.env.AI_MAX_BODY_BYTES = "4000000";
    process.env.AI_MAX_IMAGE_BYTES = "3500001";
    assert.throws(() => serverConfig(), ConfigurationError);
    process.env.AI_MAX_IMAGE_BYTES = "3500000";
    process.env.AI_MAX_BODY_BYTES = "3501000";
    assert.throws(() => serverConfig(), ConfigurationError);
  } finally {
    if (priorBody === undefined) delete process.env.AI_MAX_BODY_BYTES; else process.env.AI_MAX_BODY_BYTES = priorBody;
    if (priorImage === undefined) delete process.env.AI_MAX_IMAGE_BYTES; else process.env.AI_MAX_IMAGE_BYTES = priorImage;
  }
});

test("enabled production service requires an HTTPS photo-processing notice", () => {
  configure();
  const priorNodeEnv = process.env.NODE_ENV;
  const priorUrl = process.env.AI_PHOTO_PRIVACY_URL;
  Reflect.set(process.env, "NODE_ENV", "production");
  delete process.env.AI_PHOTO_PRIVACY_URL;
  try {
    assert.throws(() => serverConfig(), ConfigurationError);
    process.env.AI_PHOTO_PRIVACY_URL = "http://kanabco.net/photo-privacy";
    assert.throws(() => serverConfig(), ConfigurationError);
    process.env.AI_PHOTO_PRIVACY_URL = "https://kanabco.net/photo-privacy";
    assert.equal(publicConfig(serverConfig()).photoPrivacyUrl, "https://kanabco.net/photo-privacy");
  } finally {
    if (priorNodeEnv === undefined) Reflect.deleteProperty(process.env, "NODE_ENV"); else Reflect.set(process.env, "NODE_ENV", priorNodeEnv);
    if (priorUrl === undefined) delete process.env.AI_PHOTO_PRIVACY_URL; else process.env.AI_PHOTO_PRIVACY_URL = priorUrl;
  }
});

test("unknown image usage keeps the full reservation and is detectable", () => {
  assert.equal(billableUsageKnown(null), false);
  assert.equal(estimatedCostCents(null, 100), 100);
  const known = { input_tokens: 110, input_tokens_details: { image_tokens: 100, text_tokens: 10 }, output_tokens: 200, total_tokens: 310 };
  assert.equal(billableUsageKnown(known), true);
  assert.equal(estimatedCostCents(known, 100), 1);
  assert.equal(billableUsageKnown({ ...known, input_tokens: 109 }), false);
  assert.equal(billableUsageKnown({ ...known, total_tokens: 311 }), false);
  assert.equal(billableUsageKnown({ ...known, output_tokens: -1 }), false);
  assert.equal(billableUsageKnown({ ...known, input_tokens_details: { image_tokens: 1_000_001, text_tokens: 10 } }), false);
  assert.equal(billableUsageKnown({ ...known, total_tokens: undefined }), false);
  assert.equal(estimatedCostCents({ ...known, total_tokens: 311 }, 100), 100);
});

test("new custom categories are concepts while approved sofa references stay distinct", () => {
  const kitchen = buildRoomPrompt({ projectType: "kitchen", product: null, style: "modern", color: "warm-ivory", material: "wood" });
  assert.match(kitchen, /not an existing Kanabco catalog product/);
  assert.match(kitchen, /utilities, structure, ventilation/);
  const sofa = buildRoomPrompt({ projectType: "sofa", product: findProduct("160"), style: "earthy", color: "sand", material: "upholstery" });
  assert.match(sofa, /approved Kanabco Arcus sofa reference/);
});

test("wrong content type and oversized body fail before provider contact", async () => {
  configure();
  const wrongType = await POST(new NextRequest(URL, { method: "POST", headers: {
    ...BASE_HEADERS, "content-type": "application/json",
  }, body: "{}" }));
  assert.equal(wrongType.status, 415);
  const tooLarge = await POST(new NextRequest(URL, { method: "POST", headers: {
    ...BASE_HEADERS, "content-type": "multipart/form-data; boundary=test", "content-length": "9000000",
  }, body: "a" }));
  assert.equal(tooLarge.status, 413);
});

test("missing Turnstile token fails strict schema", async () => {
  configure();
  const image = await sharp({ create: { width: 400, height: 400, channels: 3, background: "#d9d0c6" } }).jpeg().toBuffer();
  const form = new FormData();
  form.set("image", new Blob([new Uint8Array(image)], { type: "image/jpeg" }), "room.jpg");
  form.set("projectType", "kitchen");
  form.set("style", "warm-minimal");
  form.set("color", "warm-ivory");
  form.set("material", "wood");
  const response = await POST(new NextRequest(URL, { method: "POST", headers: BASE_HEADERS, body: form }));
  assert.equal(response.status, 400);
});

test("failed Turnstile verification never reaches image generation", async () => {
  configure();
  const image = await sharp({ create: { width: 400, height: 400, channels: 3, background: "#d9d0c6" } }).jpeg().toBuffer();
  const form = new FormData();
  form.set("image", new Blob([new Uint8Array(image)], { type: "image/jpeg" }), "room.jpg");
  form.set("projectType", "kitchen");
  form.set("style", "warm-minimal");
  form.set("color", "sand");
  form.set("material", "wood");
  form.set("turnstileToken", "invalid-test-token");
  const originalFetch = globalThis.fetch;
  const destinations: string[] = [];
  globalThis.fetch = async (input) => {
    destinations.push(String(input));
    return new Response(JSON.stringify({ success: false }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const response = await POST(new NextRequest(URL, { method: "POST", headers: BASE_HEADERS, body: form }));
    assert.equal(response.status, 403);
    assert.deepEqual(destinations, ["https://challenges.cloudflare.com/turnstile/v0/siteverify"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Cloudflare dummy response works only in explicit loopback development mode", async () => {
  configure();
  const priorNodeEnv = process.env.NODE_ENV;
  const priorLocalFlag = process.env.KANABCO_LOCAL_TURNSTILE_TEST;
  const originalFetch = globalThis.fetch;
  Reflect.set(process.env, "NODE_ENV", "development");
  process.env.KANABCO_LOCAL_TURNSTILE_TEST = "true";
  process.env.ALLOWED_ORIGIN = "http://127.0.0.1:3461";
  process.env.TURNSTILE_SITE_KEY = "1x00000000000000000000AA";
  process.env.TURNSTILE_SECRET_KEY = "1x0000000000000000000000000000000AA";
  process.env.TURNSTILE_EXPECTED_HOSTNAME = "127.0.0.1";
  const config = serverConfig();
  assert.equal(publicConfig(config).localTestMode, true);
  const destinations: string[] = [];
  globalThis.fetch = async (input, init) => {
    destinations.push(String(input));
    assert.equal((JSON.parse(String(init?.body)) as { response: string }).response, "XXXX.DUMMY.TOKEN.XXXX");
    return new Response(JSON.stringify({ success: true, hostname: "example.com", metadata: { result_with_testing_key: true } }), { status: 200 });
  };
  try {
    const sessionId = "local-test-session-identity";
    const token = mintLocalTurnstileToken(sessionId, config);
    assert.equal(await verifyTurnstile(token, "127.0.0.1", config, sessionId), true);
    assert.deepEqual(destinations, ["https://challenges.cloudflare.com/turnstile/v0/siteverify"]);
    assert.equal(await verifyTurnstile("XXXX.DUMMY.TOKEN.XXXX", "127.0.0.1", config, sessionId), false);
    assert.equal(await verifyTurnstile(token, "127.0.0.1", config, "other-session"), false);
    assert.equal(await verifyTurnstile(token, "203.0.113.1", config, sessionId), false);
    Reflect.set(process.env, "NODE_ENV", "production");
    assert.equal(publicConfig(config).localTestMode, false);
    assert.equal(await verifyTurnstile(token, "127.0.0.1", config, sessionId), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (priorNodeEnv === undefined) Reflect.deleteProperty(process.env, "NODE_ENV"); else Reflect.set(process.env, "NODE_ENV", priorNodeEnv);
    if (priorLocalFlag === undefined) delete process.env.KANABCO_LOCAL_TURNSTILE_TEST; else process.env.KANABCO_LOCAL_TURNSTILE_TEST = priorLocalFlag;
  }
});

test("upload decoder rejects spoofed MIME and strips metadata", async () => {
  const image = await sharp({ create: { width: 400, height: 400, channels: 3, background: "#d9d0c6" } }).jpeg().toBuffer();
  const fakePng = new File([new Uint8Array(image)], "room.png", { type: "image/png" });
  await assert.rejects(() => normalizeUploadedImage(fakePng, 8 * 1024 * 1024, 12_000_000), InvalidImageError);
  const validJpeg = new File([new Uint8Array(image)], "room.jpg", { type: "image/jpeg" });
  const normalized = await normalizeUploadedImage(validJpeg, 8 * 1024 * 1024, 12_000_000);
  const metadata = await sharp(normalized).metadata();
  assert.equal(metadata.format, "jpeg");
  assert.equal(metadata.exif, undefined);
});
