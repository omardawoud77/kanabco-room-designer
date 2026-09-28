import type { NextRequest } from "next/server";
import { featureEnabled, isLocalTurnstileTestConfig, serverConfig } from "@/lib/config";
import { apiError, apiResponse, PayloadTooLargeError, readBoundedBody, requestOriginAllowed } from "@/lib/http";
import { readSession } from "@/lib/identity";
import { mintLocalTurnstileToken } from "@/lib/turnstile";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!featureEnabled()) return apiError(503);
  try {
    const config = serverConfig();
    const url = new URL(request.url);
    const host = request.headers.get("host");
    if (!isLocalTurnstileTestConfig(config) || url.protocol !== "http:" ||
      (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") ||
      !host || !/^127\.0\.0\.1:\d{2,5}$/.test(host)) {
      return apiResponse({ error: "Not found" }, 404);
    }
    if (!requestOriginAllowed(request, config)) return apiError(403, config);
    try {
      if (request.body && (await readBoundedBody(request, 8)).byteLength !== 0) return apiError(400, config);
    } catch (error) {
      return apiError(error instanceof PayloadTooLargeError ? 413 : 400, config);
    }
    const sessionId = readSession(request, config);
    if (!sessionId) return apiError(401, config);
    return apiResponse({ token: mintLocalTurnstileToken(sessionId, config) }, 200, config);
  } catch {
    return apiError(503);
  }
}
