"""Return positional PDF lines on selected pages for section verification."""

import json
import re
import sys

try:
    import pymupdf
except ImportError:
    import fitz as pymupdf


def main() -> int:
    document = pymupdf.open(stream=sys.stdin.buffer.read(), filetype="pdf")
    try:
        request = json.loads(sys.argv[1])
        numbers = request["pages"]
        headings = request["headings"]
        pages = []
        occurrences = []
        intervening = []
        pattern = re.compile(r"^(?:[A-Z]\.\d+[.)]?|[A-Z]\.|[IVXLC]+\.)(?:\s+\S|$)")
        for number, page in enumerate(document, start=1):
            lines = []
            for block in page.get_text("dict")["blocks"]:
                for line in block.get("lines", []):
                    text = "".join(span["text"] for span in line["spans"]).strip()
                    if text:
                        lines.append({"text": text, "y": line["bbox"][1]})
            for line in lines:
                normalized = " ".join(line["text"].split())
                if normalized in headings:
                    occurrences.append({"page": number, **line})
                elif request["startPage"] <= number <= request["endPage"] and pattern.match(normalized):
                    intervening.append({"page": number, **line})
            if number in numbers:
                pages.append({"page": number, "height": page.rect.height, "lines": lines})
        print(json.dumps({"pageCount": len(document), "pages": pages,
                          "occurrences": occurrences, "intervening": intervening[:10]}))
    finally:
        document.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
