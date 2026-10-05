import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultPermittedHosts,
  extractArticleText,
  fetchArticleHtml,
  isBlockedDestination,
  isChangedText,
  isExtractionPermitted,
  textHash,
} from "../src/extract.js";

function stubFetch(
  handler: (url: string) => {
    status: number;
    headers?: Record<string, string | undefined>;
    body?: string;
  },
) {
  return async (url: string) => ({
    status: handler(url).status,
    headers: {
      get: (name: string) => handler(url).headers?.[name.toLowerCase()] ?? null,
    },
    text: async () => handler(url).body ?? "",
  });
}

test("permission gate allows configured feed hosts, blocks others", () => {
  const allowed = defaultPermittedHosts();
  assert.ok(allowed.has("www.tagesschau.de"));
  assert.ok(allowed.has("www.deutschlandfunk.de"));
  assert.ok(isExtractionPermitted("https://www.tagesschau.de/a.html", allowed));
  assert.equal(
    isExtractionPermitted("https://example.org/a.html", allowed),
    false,
  );
  assert.equal(isExtractionPermitted("nota-url", allowed), false);
});

test("SSRF guard blocks private/local/non-http destinations", () => {
  for (const url of [
    "http://127.0.0.1/a",
    "http://10.0.0.5/a",
    "http://192.168.1.1/a",
    "http://172.16.4.2/a",
    "http://169.254.169.254/",
    "http://localhost/a",
    "http://[::1]/a",
    "ftp://www.tagesschau.de/a",
    "https://user:pass@www.tagesschau.de/a",
  ])
    assert.equal(isBlockedDestination(url), true, url);
  assert.equal(isBlockedDestination("https://www.tagesschau.de/a.html"), false);
});

test("fetch follows bounded redirects and rechecks permission per hop", async () => {
  const allowed = new Set(["a.example", "b.example"]);
  const fetchFn = stubFetch((url) =>
    url === "https://a.example/start"
      ? { status: 302, headers: { location: "https://b.example/final" } }
      : {
          status: 200,
          headers: { "content-type": "text/html" },
          body: "<body>x</body>",
        },
  );
  const result = await fetchArticleHtml(
    "https://a.example/start",
    fetchFn,
    allowed,
  );
  assert.equal(result.ok, true);
  assert.equal(
    (result as { finalUrl: string }).finalUrl,
    "https://b.example/final",
  );

  const offsite = await fetchArticleHtml(
    "https://a.example/start",
    stubFetch(() => ({
      status: 302,
      headers: { location: "https://evil.example/x" },
    })),
    allowed,
  );
  assert.equal(offsite.ok, false);

  const loop = await fetchArticleHtml(
    "https://a.example/start",
    stubFetch(() => ({
      status: 302,
      headers: { location: "https://a.example/start" },
    })),
    allowed,
  );
  assert.equal(loop.ok, false);
});

test("default fetch leaves redirects for the permission guard", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    return init?.redirect === "manual"
      ? new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/private" },
        })
      : new Response("secret", {
          headers: { "content-type": "text/html" },
        });
  };
  try {
    const result = await fetchArticleHtml(
      "https://a.example/start",
      undefined,
      new Set(["a.example"]),
    );
    assert.equal(result.ok, false);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetch preserves link on failure or unsupported formats", async () => {
  const allowed = new Set(["a.example"]);
  for (const [name, handler] of [
    ["http-error", () => ({ status: 404 })],
    [
      "pdf",
      () => ({
        status: 200,
        headers: { "content-type": "application/pdf" },
        body: "%PDF",
      }),
    ],
    ["private", () => ({ status: 200, body: "x" })],
  ] as const) {
    const url =
      name === "private" ? "https://a.example/x" : "https://a.example/x";
    const result =
      name === "private"
        ? await fetchArticleHtml(
            "http://127.0.0.1/x",
            stubFetch(handler),
            allowed,
          )
        : await fetchArticleHtml(url, stubFetch(handler), allowed);
    assert.equal(result.ok, false, name);
    assert.ok((result as { reason: string }).reason.length > 0);
  }
  const unpermitted = await fetchArticleHtml(
    "https://other.example/x",
    stubFetch(() => ({ status: 200, body: "x" })),
    allowed,
  );
  assert.equal(unpermitted.ok, false);
});

test("generic extraction prefers article/main and rejects thin pages", () => {
  const html = `<html><body><nav>Menu links here</nav>
    <article><h1>Title</h1><p>${"Body sentence one. ".repeat(10)}</p></article>
    <footer>Footer stuff</footer></body></html>`;
  const text = extractArticleText(html);
  assert.ok(text?.includes("Body sentence one."));
  assert.ok(!text?.includes("Menu links"));
  assert.equal(extractArticleText("<html><body><p>Hi</p></body></html>"), null);
  assert.equal(extractArticleText("<html><body><p>Hi</p></body></html>"), null);
});

test("identical text needs no new version; changed text does", () => {
  const text = "a".repeat(60);
  const hash = textHash(text);
  assert.equal(isChangedText(hash, text), false);
  assert.equal(isChangedText(hash, `${text} updated`), true);
  assert.equal(isChangedText(null, text), true);
});
