import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { ConfigurationError, publicConfig, serverConfig } from "@/lib/config";
import { newSessionCookie, readSession } from "@/lib/identity";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const config = serverConfig();
    const response = NextResponse.json(publicConfig(), { headers: { "Cache-Control": "no-store" } });
    if (!readSession(request, config)) {
      const cookie = newSessionCookie(config);
      response.cookies.set(cookie.name, cookie.value, cookie.options);
    }
    return response;
  } catch (error) {
    if (!(error instanceof ConfigurationError)) console.error("CONFIG_ERROR", error);
    return NextResponse.json({ error: "Feature unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
