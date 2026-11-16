import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { join } from "node:path";
import {
  FETCH_USER_AGENT,
  fetchWithRedirects,
  type ResolveHost,
} from "../../url-safety";
import { MAX_PDF_BYTES, PDF_FETCH_TIMEOUT_MS } from "../constants";

// Fetched PDF bytes and their extracted page text. Fetching and extraction are
// independent of DIP collection: this module never touches a checkpoint and
// treats every failure as a retryable document-job failure rather than a
// collection failure.

export type FetchedPdf =
  { ok: true; bytes: Buffer; finalUrl: string } | { ok: false; reason: string };

// 404/410 means the source never published the file at that link, and a
// declared size over the bound never gets smaller. Retrying cannot change
// either, so the document job is exhausted on the first attempt.
export function isPermanentFetchFailure(reason: string) {
  return (
    reason === "HTTP 404" ||
    reason === "HTTP 410" ||
    reason === "Document exceeds size bound"
  );
}

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

async function defaultResolveHost(hostname: string): Promise<string[]> {
  const addresses = await lookup(hostname, { all: true });
  return addresses.map(({ address }) => address);
}

// Metadata and the original link are retained before this runs, so a failed
// fetch only fails the document job: the source reference stays intact.
export async function fetchDocumentPdf(
  rawUrl: string,
  fetchFn: PdfFetchFn = defaultFetch,
  resolveHost: ResolveHost = defaultResolveHost,
  maxBytes: number = MAX_PDF_BYTES,
): Promise<FetchedPdf> {
  const result = await fetchWithRedirects(rawUrl, {
    fetchFn,
    headers: {
      "user-agent": FETCH_USER_AGENT,
      accept: "application/pdf",
    },
    timeoutMs: PDF_FETCH_TIMEOUT_MS,
    contentType: /application\/pdf|application\/octet-stream/i,
    maxBytes,
    sizeReason: "Document exceeds size bound",
    resolveHost,
    checkContentLength: true,
    emptyReason: "Empty document",
    read: async (response) => {
      const bytes = Buffer.from(await response.arrayBuffer());
      return { bytes: bytes.byteLength, value: bytes };
    },
  });
  if (!result.ok) return result;
  return { ok: true, bytes: result.value, finalUrl: result.finalUrl };
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
