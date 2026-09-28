import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import type { ServerConfig } from "./config";

export class PayloadTooLargeError extends Error {}

export function edgeAllowed(request: NextRequest, config: ServerConfig): boolean {
  const supplied = request.headers.get("x-kanabco-edge-secret");
  if (!supplied) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(config.edgeSharedSecret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function requestOriginAllowed(request: NextRequest, config: ServerConfig): boolean {
  const origin = request.headers.get("origin");
  if (origin !== config.allowedOrigin) return false;
  const referer = request.headers.get("referer");
  if (referer) {
    try {
      if (new URL(referer).origin !== config.allowedOrigin) return false;
    } catch {
      return false;
    }
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "same-site") return false;
  return request.headers.get("x-requested-with") === "website";
}

export function apiResponse(body: unknown, status: number, config?: ServerConfig, retryAfterSeconds?: number) {
  const headers: Record<string, string> = {
    "Cache-Control": "no-store",
    "Vary": "Origin",
    "X-Content-Type-Options": "nosniff",
  };
  if (config) {
    headers["Access-Control-Allow-Origin"] = config.allowedOrigin;
    headers["Access-Control-Allow-Credentials"] = "true";
  }
  if (retryAfterSeconds && retryAfterSeconds > 0) headers["Retry-After"] = String(Math.ceil(retryAfterSeconds));
  return NextResponse.json(body, { status, headers });
}

export function apiError(status: number, config?: ServerConfig, retryAfterSeconds?: number) {
  const messages: Record<number, string> = {
    400: "Invalid request",
    401: "Session required",
    403: "Request could not be verified",
    405: "Method not allowed",
    413: "Image too large",
    415: "Unsupported content type",
    429: "Request limit reached",
    503: "Feature temporarily unavailable",
  };
  return apiResponse({ error: messages[status] ?? "Request failed" }, status, config, retryAfterSeconds);
}

export async function readBoundedBody(request: NextRequest, maxBytes: number): Promise<Uint8Array> {
  const claimed = request.headers.get("content-length");
  if (claimed && (!/^\d+$/.test(claimed) || Number(claimed) > maxBytes)) throw new PayloadTooLargeError();
  if (!request.body) throw new Error("No body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new PayloadTooLargeError();
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function parseMultipart(body: Uint8Array, contentType: string): Promise<FormData> {
  const parsed = new Request("http://localhost/internal-parse", {
    method: "POST",
    headers: { "content-type": contentType },
    body: Buffer.from(body),
  });
  return parsed.formData();
}
