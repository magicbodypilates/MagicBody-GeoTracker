import { NextRequest, NextResponse } from "next/server";
import { exchangeCodeForTokens } from "@/lib/server/gsc-client";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const error = req.nextUrl.searchParams.get("error");
  const bp = process.env.NEXT_PUBLIC_BASE_PATH ?? "/geo-tracker";

  const successRedirect = `${bp}/?gsc=connected`;
  const failureRedirect = (msg: string) => `${bp}/?gsc=error&msg=${encodeURIComponent(msg)}`;

  if (error) {
    return NextResponse.redirect(new URL(failureRedirect(error), req.url));
  }
  if (!code) {
    return NextResponse.redirect(new URL(failureRedirect("missing_code"), req.url));
  }

  const origin = process.env.GSC_PUBLIC_ORIGIN ?? `http://localhost:${process.env.PORT ?? 3000}`;
  try {
    await exchangeCodeForTokens(code);
    return NextResponse.redirect(new URL(successRedirect, origin));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    return NextResponse.redirect(new URL(failureRedirect(msg), origin));
  }
}
