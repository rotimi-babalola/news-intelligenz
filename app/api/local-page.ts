// The local page is the only caller allowed to spend model calls. A foreign
// origin or a simple form post is rejected before any work starts.
export function isLocalPageRequest(request: Request) {
  const host = request.headers.get("host");
  const origin = request.headers.get("origin");
  return Boolean(
    host &&
    (origin === `http://${host}` || origin === `https://${host}`) &&
    request.headers.get("content-type")?.startsWith("application/json"),
  );
}
