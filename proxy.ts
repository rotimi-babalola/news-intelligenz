import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const LOCAL_HOST = /^localhost(?::\d+)?$|^127\.0\.0\.1(?::\d+)?$/;

export function proxy(request: NextRequest) {
  const host = request.headers.get("host") ?? "";
  if (host && !LOCAL_HOST.test(host)) {
    return new NextResponse("Local access only", { status: 403 });
  }
  const response = NextResponse.next();
  // Local-only admin tool (non-local Host is rejected above). Next.js needs
  // its own inline bootstrap scripts and, in dev, eval + the HMR socket.
  const scriptSrc =
    process.env.NODE_ENV === "production"
      ? "script-src 'self' 'unsafe-inline'"
      : "script-src 'self' 'unsafe-inline' 'unsafe-eval'";
  response.headers.set(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      scriptSrc,
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      "img-src 'self' data:",
      "connect-src 'self' ws: wss:",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
  );
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
