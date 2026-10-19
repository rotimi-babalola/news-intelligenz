import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { MAX_REDIRECTS, isBlockedDestination } from "../extract";

// Fetched PDF bytes and their extracted page text. Fetching and extraction are
// independent of DIP collection: this module never touches a checkpoint and
// treats every failure as a retryable document-job failure rather than a
// collection failure.

export const MAX_PDF_BYTES = 25_000_000;

export type FetchedPdf =
  { ok: true; bytes: Buffer; finalUrl: string } | { ok: false; reason: string };

type PdfFetchFn = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

function defaultFetch(
  url: string,
  init?: { signal: AbortSignal; headers: Record<string, string> },
) {
  return fetch(url, {
    signal: init?.signal,
    headers: init?.headers ?? {},
    redirect: "manual",
  });
}

export type ResolveHost = (hostname: string) => Promise<string[]>;

async function defaultResolveHost(hostname: string): Promise<string[]> {
  const addresses = await lookup(hostname, { all: true });
  return addresses.map(({ address }) => address);
}

// A hostname can pass the literal URL check and still resolve to a private
// address, so every hop is resolved before the request is made.
async function isBlockedResolved(rawUrl: string, resolveHost: ResolveHost) {
  const url = new URL(rawUrl);
  if (isIP(url.hostname)) return false;
  let addresses: string[];
  try {
    addresses = await resolveHost(url.hostname);
  } catch {
    return true;
  }
  if (addresses.length === 0) return true;
  return addresses.some((address) =>
    isBlockedDestination(
      `http://${address.includes(":") ? `[${address}]` : address}`,
    ),
  );
}

// Metadata and the original link are retained before this runs, so a failed
// fetch only fails the document job: the source reference stays intact.
export async function fetchDocumentPdf(
  rawUrl: string,
  fetchFn: PdfFetchFn = defaultFetch,
  resolveHost: ResolveHost = defaultResolveHost,
): Promise<FetchedPdf> {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (
      isBlockedDestination(current) ||
      (await isBlockedResolved(current, resolveHost))
    )
      return { ok: false, reason: "Blocked private/local destination" };
    let response: Awaited<ReturnType<PdfFetchFn>>;
    try {
      response = await fetchFn(current, {
        signal: AbortSignal.timeout(30_000),
        headers: {
          "user-agent": "NewsIntelligenz/0.1 (local operator verification)",
          accept: "application/pdf",
        },
      });
    } catch {
      return { ok: false, reason: "Fetch failed" };
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) return { ok: false, reason: "Redirect without location" };
      try {
        current = new URL(location, current).toString();
      } catch {
        return { ok: false, reason: "Invalid redirect location" };
      }
      continue;
    }
    if (response.status < 200 || response.status >= 300)
      return { ok: false, reason: `HTTP ${response.status}` };
    const contentType = response.headers.get("content-type") ?? "";
    if (
      contentType &&
      !/application\/pdf|application\/octet-stream/i.test(contentType)
    )
      return { ok: false, reason: `Unsupported format: ${contentType}` };
    const declaredSize = response.headers.get("content-length");
    if (declaredSize !== null && Number(declaredSize) > MAX_PDF_BYTES)
      return { ok: false, reason: "Document exceeds size bound" };
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength === 0) return { ok: false, reason: "Empty document" };
    if (bytes.byteLength > MAX_PDF_BYTES)
      return { ok: false, reason: "Document exceeds size bound" };
    return { ok: true, bytes, finalUrl: current };
  }
  return { ok: false, reason: "Too many redirects" };
}

export type ExtractedPage = { page: number; text: string };
export type PageExtractor = (bytes: Buffer) => Promise<ExtractedPage[]>;

export type PdfExtractorOptions = {
  /** Interpreter and script are injectable so tests need no Python. */
  command?: string;
  scriptPath?: string;
  maxBufferBytes?: number;
};

// PyMuPDF runs in a child process: Node has no native PDF text extraction, and
// the script keeps the model-free extraction step small and inspectable.
export function pymupdfExtractor(
  bytes: Buffer,
  options: PdfExtractorOptions = {},
): Promise<ExtractedPage[]> {
  const command = options.command ?? "python3";
  const scriptPath =
    options.scriptPath ?? join(process.cwd(), "scripts", "extract_pdf.py");
  return new Promise((resolve, reject) => {
    const child = execFile(
      /* turbopackIgnore: true */
      command,
      [scriptPath],
      { maxBuffer: options.maxBufferBytes ?? 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error)
          return reject(
            new Error(
              `PDF extraction failed: ${(stderr || error.message).trim().slice(0, 2000)}`,
            ),
          );
        let body: unknown;
        try {
          body = JSON.parse(stdout);
        } catch {
          return reject(new Error("PDF extraction returned invalid JSON"));
        }
        const parsed = body as { pages?: unknown };
        if (!Array.isArray(parsed?.pages))
          return reject(new Error("PDF extraction returned no pages"));
        const pages: ExtractedPage[] = [];
        for (const [index, value] of parsed.pages.entries()) {
          const page = value as { page?: unknown; text?: unknown };
          const pageNo =
            typeof page?.page === "number" && Number.isInteger(page.page)
              ? page.page
              : index + 1;
          if (typeof page?.text !== "string")
            return reject(new Error("PDF extraction returned an invalid page"));
          pages.push({ page: pageNo, text: page.text });
        }
        resolve(pages);
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(bytes);
  });
}
