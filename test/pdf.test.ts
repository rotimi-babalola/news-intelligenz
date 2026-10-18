import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  MAX_PDF_BYTES,
  fetchDocumentPdf,
  pymupdfExtractor,
} from "../src/dip/pdf.js";

function response(
  status: number,
  options: {
    headers?: Record<string, string>;
    body?: Uint8Array;
  } = {},
) {
  const headers = new Map(
    Object.entries(options.headers ?? {}).map(([key, value]) => [
      key.toLowerCase(),
      value,
    ]),
  );
  return {
    status,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    arrayBuffer: async () =>
      (options.body ?? new Uint8Array()).buffer as ArrayBuffer,
  };
}

test("document fetch refuses a private destination before any request", async () => {
  let called = 0;
  const result = await fetchDocumentPdf(
    "http://127.0.0.1/secret.pdf",
    async () => {
      called += 1;
      return response(200);
    },
  );
  assert.deepEqual(result, {
    ok: false,
    reason: "Blocked private/local destination",
  });
  assert.equal(called, 0);
});

test("document fetch follows one redirect and returns the bytes", async () => {
  const urls: string[] = [];
  const result = await fetchDocumentPdf(
    "https://dserver.bundestag.de/old.pdf",
    async (url) => {
      urls.push(url);
      return urls.length === 1
        ? response(302, { headers: { location: "/new.pdf" } })
        : response(200, {
            headers: { "content-type": "application/pdf" },
            body: new Uint8Array([1, 2, 3]),
          });
    },
  );
  assert.deepEqual(result, {
    ok: true,
    bytes: Buffer.from([1, 2, 3]),
    finalUrl: "https://dserver.bundestag.de/new.pdf",
  });
  assert.deepEqual(urls, [
    "https://dserver.bundestag.de/old.pdf",
    "https://dserver.bundestag.de/new.pdf",
  ]);
});

test("document fetch rejects non-PDF formats and oversized bodies", async () => {
  assert.deepEqual(
    await fetchDocumentPdf("https://dserver.bundestag.de/x", async () =>
      response(200, { headers: { "content-type": "text/html" } }),
    ),
    { ok: false, reason: "Unsupported format: text/html" },
  );
  assert.deepEqual(
    await fetchDocumentPdf("https://dserver.bundestag.de/x", async () =>
      response(200, {
        headers: { "content-type": "application/pdf" },
        body: new Uint8Array(MAX_PDF_BYTES + 1),
      }),
    ),
    { ok: false, reason: "Document exceeds size bound" },
  );
  assert.deepEqual(
    await fetchDocumentPdf("https://dserver.bundestag.de/x", async () =>
      response(404),
    ),
    { ok: false, reason: "HTTP 404" },
  );
});

test("extraction adapter parses page text and fails loudly otherwise", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dip-pdf-"));
  const ok = join(dir, "ok.sh");
  writeFileSync(
    ok,
    '#!/bin/sh\ncat >/dev/null\nprintf \'{"pageCount":2,"pages":[{"page":1,"text":"Haushalt"},{"page":2,"text":"Anlage"}]}\'\n',
  );
  assert.deepEqual(
    await pymupdfExtractor(Buffer.from("%PDF"), {
      command: "sh",
      scriptPath: ok,
    }),
    [
      { page: 1, text: "Haushalt" },
      { page: 2, text: "Anlage" },
    ],
  );

  const broken = join(dir, "broken.sh");
  writeFileSync(
    broken,
    '#!/bin/sh\ncat >/dev/null\necho "cannot read PDF: boom" >&2\nexit 4\n',
  );
  await assert.rejects(
    pymupdfExtractor(Buffer.from("%PDF"), {
      command: "sh",
      scriptPath: broken,
    }),
    /PDF extraction failed: cannot read PDF: boom/,
  );

  const garbage = join(dir, "garbage.sh");
  writeFileSync(garbage, '#!/bin/sh\ncat >/dev/null\necho "not json"\n');
  await assert.rejects(
    pymupdfExtractor(Buffer.from("%PDF"), {
      command: "sh",
      scriptPath: garbage,
    }),
    /invalid JSON/,
  );
});
