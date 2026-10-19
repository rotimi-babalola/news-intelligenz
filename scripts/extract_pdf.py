"""Extract per-page text from a PDF on stdin and print it as JSON on stdout.

Used by src/dip/pdf.ts, which passes the fetched bytes on stdin so no temporary
file is needed. Requires PyMuPDF (`python3 -m pip install pymupdf`).

Output: {"pageCount": <n>, "pages": [{"page": 1, "text": "..."}, ...]}
"""

import json
import sys

try:
    import pymupdf
except ImportError:  # PyMuPDF < 1.24 exposes the same API as `fitz`
    try:
        import fitz as pymupdf
    except ImportError:
        sys.stderr.write(
            "pymupdf is not installed; run `python3 -m pip install pymupdf`\n"
        )
        sys.exit(3)


def main() -> int:
    data = sys.stdin.buffer.read()
    if not data:
        sys.stderr.write("no PDF bytes on stdin\n")
        return 4
    try:
        document = pymupdf.open(stream=data, filetype="pdf")
    except Exception as exc:  # malformed or encrypted input
        sys.stderr.write(f"cannot read PDF: {exc}\n")
        return 4
    try:
        pages = [
            {"page": number, "text": page.get_text("text")}
            for number, page in enumerate(document, start=1)
        ]
    finally:
        document.close()
    sys.stdout.write(json.dumps({"pageCount": len(pages), "pages": pages}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
