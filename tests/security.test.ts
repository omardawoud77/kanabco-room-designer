import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { NextRequest } from "next/server";
import { POST } from "../src/app/api/room-design/route";
import { normalizeUploadedImage, InvalidImageError } from "../src/lib/images";
import { ConfigurationError, serverConfig } from "../src/lib/config";
import { billableUsageKnown, estimatedCostCents } from "../src/lib/openai-image";
import { buildRoomPrompt } from "../src/lib/prompt";
import { findProduct } from "../src/lib/catalog";

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

test("public image model and minimum cost reservation are fixed server-side", () => {
  configure();
  process.env.OPENAI_IMAGE_MODEL = "gpt-image-2.5-sunburst";
  assert.throws(() => serverConfig(), ConfigurationError);
  delete process.env.OPENAI_IMAGE_MODEL;
  process.env.AI_IMAGE_RESERVED_USD = "0.01";
  assert.throws(() => serverConfig(), ConfigurationError);
  delete process.env.AI_IMAGE_RESERVED_USD;
});

test("unknown image usage keeps the full reservation and is detectable", () => {
  assert.equal(billableUsageKnown(null), false);
  assert.equal(estimatedCostCents(null, 100), 100);
  assert.equal(billableUsageKnown({ input_tokens_details: { image_tokens: 100, text_tokens: 10 }, output_tokens: 200 }), true);
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
