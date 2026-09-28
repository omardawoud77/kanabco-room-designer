import { NextResponse } from "next/server";
import { listProducts } from "@/lib/catalog";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ products: listProducts() }, { headers: { "Cache-Control": "public, max-age=300" } });
}
