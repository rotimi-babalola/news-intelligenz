import { NextResponse } from "next/server";

export function middleware() {
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
