import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { findProduct, productReference } from "@/lib/catalog";
import { ConfigurationError, featureEnabled, serverConfig, type ServerConfig } from "@/lib/config";
import { ALLOWED_MATERIALS, PROJECT_TYPES } from "@/lib/custom-projects";
import { apiError, apiResponse, edgeAllowed, parseMultipart, PayloadTooLargeError, readBoundedBody, requestOriginAllowed } from "@/lib/http";
import { clientIp, maskedIp, privateIpHash, readSession, sha256 } from "@/lib/identity";
import { InvalidImageError, normalizeGeneratedImage, normalizeUploadedImage } from "@/lib/images";
import { billableUsageKnown, editRoomImage, estimatedCostCents, moderateRoomImage, OpenAiUnavailableError, type ImageUsage } from "@/lib/openai-image";
import { buildRoomPrompt } from "@/lib/prompt";
import { MAX_RESULT_JSON_BYTES } from "@/lib/payload-limits";
import { acquireRepeatLock, acquireSlots, cancelReservation, consumeTurnstileToken, GuardUnavailableError, releaseRepeatLock, releaseSlots, reserveRequest, settleRequest } from "@/lib/redis-guards";
import { verifyTurnstile } from "@/lib/turnstile";

export const runtime = "nodejs";
export const maxDuration = 240;

const fieldsSchema = z.strictObject({
  projectType: z.enum(["sofa", "bed", "wardrobe", "dresser", "dressing-room", "kitchen"]),
  productId: z.string().regex(/^\d{1,8}$/).optional(),
  style: z.enum(["warm-minimal", "modern", "earthy"]),
  color: z.enum(["warm-ivory", "sand", "taupe", "sage", "walnut", "charcoal"]),
  material: z.enum(["upholstery", "wood", "laminate", "stone", "mixed"]),
  roomWidthCm: z.string().regex(/^\d{3,4}$/).optional(),
  turnstileToken: z.string().min(1).max(2048),
});

function textFields(form: FormData): unknown {
  const allowed = new Set(["image", "projectType", "productId", "style", "color", "material", "roomWidthCm", "turnstileToken"]);
  for (const key of form.keys()) {
    if (!allowed.has(key) || form.getAll(key).length !== 1) return null;
  }
  if (form.getAll("image").length !== 1) return null;
  const entries: Record<string, string> = {};
  for (const key of ["projectType", "productId", "style", "color", "material", "roomWidthCm", "turnstileToken"]) {
    const value = form.get(key);
    if (value !== null) {
      if (typeof value !== "string") return null;
      entries[key] = value;
    }
  }
  return entries;
}

function logSpike(costCents: number, thresholdCents: number) {
  if (costCents >= thresholdCents) console.error(JSON.stringify({ event: "SPEND_SPIKE", tenMinuteEstimatedUsdCents: costCents }));
}

export async function OPTIONS(request: NextRequest) {
  if (!featureEnabled()) return apiError(503);
  try {
    const config = serverConfig();
    if (request.headers.get("origin") !== config.allowedOrigin) return apiError(403);
    if (!edgeAllowed(request, config)) return apiError(403);
    return new NextResponse(null, { status: 204, headers: {
      "Access-Control-Allow-Origin": config.allowedOrigin,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "POST",
      "Access-Control-Allow-Headers": "Content-Type, X-Requested-With",
      "Access-Control-Max-Age": "600",
      "Vary": "Origin",
      "Cache-Control": "no-store",
    } });
  } catch {
    return apiError(503);
  }
}

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  const startedAt = Date.now();
  let config: ServerConfig | undefined;
  let ip = "unknown";
  let ipHash: string | null = null;
  let sessionHash: string | null = null;
  let dayUtc: string | null = null;
  let slotsAcquired = false;
  let budgetReserved = false;
  let repeatLocked = false;
  let repeatDigest: string | null = null;
  let imageCallStarted = false;
  let settled = false;
  let turnstileSuccess = false;
  let imageBytes = 0;
  let inputChars = 0;
  let prompt: string | undefined;
  let usage: ImageUsage | null = null;
  let estimatedUsdCents = 0;
  let outcome: "success" | "reject" | "error" = "reject";
  let reason = "unknown";

  try {
    // 1. Kill switch.
    if (!featureEnabled()) { reason = "feature_disabled"; return apiError(503); }
    config = serverConfig();

    // 2. Method, origin, content type and bounded body.
    if (!requestOriginAllowed(request, config) || !edgeAllowed(request, config)) { reason = "origin_or_edge"; return apiError(403, config); }
    ip = clientIp(request, config) ?? "unknown";
    const contentType = request.headers.get("content-type") || "";
    if (!/^multipart\/form-data;\s*boundary=[A-Za-z0-9'()+_,.\/:=?-]{1,200}(?:;.*)?$/i.test(contentType)) {
      reason = "content_type";
      return apiError(415, config);
    }
    let body: Uint8Array;
    try { body = await readBoundedBody(request, config.maxBodyBytes); }
    catch (error) {
      reason = error instanceof PayloadTooLargeError ? "body_too_large" : "body_read";
      return apiError(error instanceof PayloadTooLargeError ? 413 : 400, config);
    }

    // 3. Strict request schema.
    let form: FormData;
    try { form = await parseMultipart(body, contentType); }
    catch { reason = "multipart_parse"; return apiError(400, config); }
    const parsed = fieldsSchema.safeParse(textFields(form));
    const upload = form.get("image");
    if (!parsed.success || !(upload instanceof File)) { reason = "schema"; return apiError(400, config); }
    const fields = parsed.data;
    const width = fields.roomWidthCm ? Number(fields.roomWidthCm) : undefined;
    if (width !== undefined && (width < 180 || width > 1000)) { reason = "room_width"; return apiError(400, config); }
    imageBytes = upload.size;
    inputChars = fields.projectType.length + (fields.productId?.length ?? 0) + fields.style.length + fields.color.length + fields.material.length + (fields.roomWidthCm?.length ?? 0);

    // 4. Server-side Turnstile verification and replay protection.
    if (ip === "unknown") { reason = "client_ip_untrusted"; return apiError(503, config); }
    const sessionId = readSession(request, config);
    turnstileSuccess = await verifyTurnstile(fields.turnstileToken, ip, config, sessionId);
    if (!turnstileSuccess) { reason = "turnstile"; return apiError(403, config); }
    if (!await consumeTurnstileToken(sha256(fields.turnstileToken))) { reason = "turnstile_replay"; return apiError(403, config); }

    // 5-6. IP/session and global concurrency slots, atomically in that order.
    if (!sessionId) { reason = "session_missing"; return apiError(401, config); }
    sessionHash = sha256(sessionId);
    ipHash = privateIpHash(ip, config);
    const slots = await acquireSlots({
      jobId: requestId, ipHash, sessionHash,
      ipMax: config.ipInflight, sessionMax: config.sessionInflight, globalMax: config.globalInflight,
      leaseMs: Math.max(config.openAiTimeoutMs + 90_000, 300_000),
    });
    if (!slots.ok) { reason = `inflight_${slots.scope}`; return apiError(429, config, 30); }
    slotsAcquired = true;

    // 7-8. Rolling request limits and reserved USD budget.
    dayUtc = new Date().toISOString().slice(0, 10);
    const reservation = await reserveRequest({
      jobId: requestId, ipHash, sessionHash, dayUtc, minuteBucket: Math.floor(Date.now() / 60_000),
      ipPerMinute: config.ipPerMinute, ipPerDay: config.ipPerDay,
      sessionPerDay: config.sessionPerDay, globalPerDay: config.globalPerDay,
      sessionUsdCents: config.sessionUsdCents, globalUsdCents: config.globalUsdCents,
      reserveCents: config.imageReserveCents,
    });
    if (!reservation.ok) { reason = `limit_${reservation.scope}`; return apiError(429, config, reservation.retryAfterSeconds ?? 60); }
    budgetReserved = true;

    // 9. Project choice, optional product reference, image integrity, dimensions and duplicate.
    const project = PROJECT_TYPES[fields.projectType];
    const product = fields.productId ? findProduct(fields.productId) : null;
    if (!project || !ALLOWED_MATERIALS[fields.projectType].some((material) => material === fields.material) || (fields.productId && (!product || fields.projectType !== "sofa"))) {
      reason = "project_choice";
      return apiError(400, config);
    }
    if (upload.size > config.maxImageBytes) { reason = "image_too_large"; return apiError(413, config); }
    let room: Buffer;
    try { room = await normalizeUploadedImage(upload, config.maxImageBytes, config.maxImagePixels); }
    catch (error) { reason = error instanceof InvalidImageError ? "image_invalid" : "image_processing"; return apiError(400, config); }
    repeatDigest = sha256(Buffer.concat([room, Buffer.from(`${fields.projectType}|${fields.productId ?? ""}|${fields.style}|${fields.color}|${fields.material}|${width ?? ""}`)]));
    const unique = await acquireRepeatLock({ sessionHash, repeatDigest, jobId: requestId });
    if (!unique) { reason = "repeat"; return apiError(429, config, 600); }
    repeatLocked = true;
    prompt = buildRoomPrompt({ projectType: fields.projectType, product, style: fields.style, color: fields.color, material: fields.material, roomWidthCm: width });
    const reference = product ? await sharp(await productReference(product)).resize(1024, 1024, { fit: "inside" }).png().toBuffer() : undefined;

    // 10. Image and controlled prompt moderation.
    const moderationAllowed = await moderateRoomImage(config, room, prompt);
    if (!moderationAllowed) { reason = "moderation"; return apiError(403, config); }

    // 11. The only paid image edit call. The model, prompt, output and identifier are server-owned.
    imageCallStarted = true;
    const edit = await editRoomImage({ config, room, productReference: reference, prompt, safetyUserHash: sessionHash });
    usage = edit.usage;

    // 12. Settle actual approximate usage and emit a spike signal.
    estimatedUsdCents = estimatedCostCents(usage, config.imageReserveCents);
    // Keep the full reservation charged when actual usage is lower so the daily cap stays conservative.
    const usageKnown = billableUsageKnown(usage);
    const settlement = await settleRequest({
      jobId: requestId, dayUtc, chargedCents: Math.max(estimatedUsdCents, config.imageReserveCents),
      estimatedCents: estimatedUsdCents, minuteBucket: Math.floor(Date.now() / 60_000), usageKnown,
    });
    settled = true;
    if (!usageKnown) console.error(JSON.stringify({ event: "USAGE_UNKNOWN_DAILY_BREAKER", requestId, dayUtc }));
    logSpike(settlement.spend10MinCents, config.alert10MinCents);
    const safeImage = await normalizeGeneratedImage(edit.image);

    // 13. Return pixels and plain strings only; the UI never renders model HTML.
    const responseBody = {
      requestId,
      imageDataUrl: `data:image/jpeg;base64,${safeImage.toString("base64")}`,
      project: {
        type: fields.projectType,
        label: project.label,
        source: product ? "catalog-reference" : "custom-concept",
        productId: product?.id ?? null,
        productName: product?.name ?? null,
        productUrl: product?.productUrl ?? null,
        priceEgp: null,
        priceNote: "A Kanabco specialist must confirm whether this concept can be made and provide a final quote.",
      },
      conceptDisclaimer: "AI design concept only. Beds, kitchens and other custom concepts are not listed Kanabco products or confirmed services. A specialist must verify feasibility, measurements, materials, availability and final price before any order.",
    };
    if (Buffer.byteLength(JSON.stringify(responseBody)) > MAX_RESULT_JSON_BYTES) {
      reason = "result_too_large";
      return apiError(503, config);
    }
    outcome = "success";
    reason = "ok";
    return apiResponse(responseBody, 200, config);
  } catch (error) {
    outcome = "error";
    reason = error instanceof ConfigurationError ? "configuration" :
      error instanceof GuardUnavailableError ? "quota_store" :
      error instanceof OpenAiUnavailableError ? (imageCallStarted ? "image_provider" : "moderation_provider") :
      "internal";
    return apiError(503, config);
  } finally {
    if (repeatLocked && !imageCallStarted && sessionHash && repeatDigest) {
      try { await releaseRepeatLock({ sessionHash, repeatDigest, jobId: requestId }); }
      catch { console.error(JSON.stringify({ event: "REPEAT_LOCK_RELEASE_FAILED", requestId })); }
    }
    if (budgetReserved && !imageCallStarted && dayUtc) {
      try { await cancelReservation({ jobId: requestId, dayUtc }); }
      catch { console.error(JSON.stringify({ event: "RESERVATION_CANCEL_FAILED", requestId })); }
    }
    if (slotsAcquired && ipHash && sessionHash) {
      try { await releaseSlots({ jobId: requestId, ipHash, sessionHash }); }
      catch { console.error(JSON.stringify({ event: "SLOT_RELEASE_FAILED", requestId })); }
    }
    audit({
      requestId, startedAt, ipMasked: ip === "unknown" ? ip : maskedIp(ip), sessionHash, inputChars, imageBytes,
      turnstileSuccess, model: config?.model ?? null,
      inputTokens: usage?.input_tokens ?? 0, outputTokens: usage?.output_tokens ?? 0,
      estimatedUsdCents, outcome, reason,
      ...(config?.logPrompts && prompt ? { prompt } : {}),
    });
    if (imageCallStarted && !settled) console.error(JSON.stringify({ event: "UNSETTLED_IMAGE_ATTEMPT", requestId }));
  }
}
