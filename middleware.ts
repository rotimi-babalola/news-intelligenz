import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const LOCAL_HOST = /^localhost(?::\d+)?$|^127\.0\.0\.1(?::\d+)?$/;

export function middleware(request: NextRequest) {
  const host = request.headers.get("host") ?? "";
  if (host && !LOCAL_HOST.test(host)) {
    return new NextResponse("Local access only", { status: 403 });
  }
  const response = NextResponse.next();
  response.headers.set(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
