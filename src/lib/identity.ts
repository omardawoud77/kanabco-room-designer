import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { NextRequest } from "next/server";
import type { ServerConfig } from "./config";

const COOKIE_NAME = "kanabco_room_session";
const SESSION_AGE_SECONDS = 60 * 60 * 24 * 30;

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function signature(id: string, secret: string): string {
  return createHmac("sha256", secret).update(id).digest("base64url");
}

export function newSessionCookie(config: ServerConfig): { name: string; value: string; options: {
  httpOnly: true; secure: boolean; sameSite: "lax"; path: string; maxAge: number;
} } {
  const id = randomBytes(32).toString("base64url");
  return {
    name: COOKIE_NAME,
    value: `${id}.${signature(id, config.sessionSigningKey)}`,
    options: { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: SESSION_AGE_SECONDS },
  };
}

export function readSession(request: NextRequest, config: ServerConfig): string | null {
  const value = request.cookies.get(COOKIE_NAME)?.value;
  if (!value) return null;
  const [id, sentSignature, extra] = value.split(".");
  if (extra || !id || !sentSignature || id.length < 40 || id.length > 64) return null;
  const expected = signature(id, config.sessionSigningKey);
  const a = Buffer.from(sentSignature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return id;
}

export function clientIp(request: NextRequest, config: ServerConfig): string | null {
  const raw = request.headers.get(config.clientIpHeader);
  if (!raw || raw.includes(",") || raw.length > 64 || isIP(raw) === 0) return null;
  return raw;
}

export function privateIpHash(ip: string, config: ServerConfig): string {
  return createHmac("sha256", config.sessionSigningKey).update(ip).digest("hex");
}

export function maskedIp(ip: string): string {
  if (ip.includes(".")) {
    const parts = ip.split(".");
    return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.0` : "invalid";
  }
  return `${ip.split(":").slice(0, 3).join(":")}::`;
}
