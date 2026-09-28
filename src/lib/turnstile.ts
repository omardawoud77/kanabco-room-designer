import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isLocalTurnstileTestConfig, type ServerConfig } from "./config";

export class TurnstileUnavailableError extends Error {}

const LOCAL_DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
const LOCAL_TOKEN_LIFETIME_SECONDS = 300;
const LOCAL_TOKEN_PATTERN = /^localtest\.v1\.([A-Za-z0-9_-]{32})\.(\d{10})\.([A-Za-z0-9_-]{43})$/;

function localTestKeys(config: ServerConfig, ip: string): boolean {
  return isLocalTurnstileTestConfig(config) && ip === "127.0.0.1";
}

function localSignature(nonce: string, expiresAt: number, sessionId: string, config: ServerConfig): string {
  return createHmac("sha256", config.sessionSigningKey)
    .update(`kanabco-local-turnstile\0${sessionId}\0${nonce}\0${expiresAt}`)
    .digest("base64url");
}

export function mintLocalTurnstileToken(sessionId: string, config: ServerConfig): string {
  if (!isLocalTurnstileTestConfig(config) || !sessionId) throw new Error("Local verification unavailable");
  const nonce = randomBytes(24).toString("base64url");
  const expiresAt = Math.floor(Date.now() / 1000) + LOCAL_TOKEN_LIFETIME_SECONDS;
  return `localtest.v1.${nonce}.${expiresAt}.${localSignature(nonce, expiresAt, sessionId, config)}`;
}

function validLocalToken(token: string, sessionId: string | null, config: ServerConfig): boolean {
  if (!sessionId) return false;
  const match = LOCAL_TOKEN_PATTERN.exec(token);
  if (!match) return false;
  const [, nonce, expiry, suppliedSignature] = match;
  const expiresAt = Number(expiry);
  const now = Math.floor(Date.now() / 1000);
  if (expiresAt <= now || expiresAt > now + LOCAL_TOKEN_LIFETIME_SECONDS) return false;
  const expected = Buffer.from(localSignature(nonce, expiresAt, sessionId, config));
  const supplied = Buffer.from(suppliedSignature);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export async function verifyTurnstile(token: string, ip: string, config: ServerConfig, sessionId: string | null = null): Promise<boolean> {
  try {
    const local = localTestKeys(config, ip);
    if (local && !validLocalToken(token, sessionId, config)) return false;
    if (!local && token.startsWith("localtest.v1.")) return false;
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: config.turnstileSecretKey, response: local ? LOCAL_DUMMY_TOKEN : token, remoteip: ip }),
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    if (!response.ok) throw new TurnstileUnavailableError();
    const data = await response.json() as { success?: boolean; hostname?: string; action?: string; metadata?: { result_with_testing_key?: boolean } };
    // Cloudflare's public test keys return example.com and omit the widget action.
    // Accept that response only for a development server on loopback with exact test keys.
    if (local) {
      return data.success === true && data.hostname === "example.com" && data.metadata?.result_with_testing_key === true;
    }
    return data.success === true && data.hostname === config.turnstileHostname && data.action === "room_design";
  } catch {
    throw new TurnstileUnavailableError();
  }
}
