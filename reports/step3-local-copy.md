# Step 3: Local copy + OCR (2026-10-20)

## Local copy: `C:\Users\NUPUR\Documents\MESA-Archive`
- **479 / 479** bucket objects on disk with identical key paths (953 MB). 0 missing, 0 extra.
  - Course material: 262 Nexus items, plus the crawl manifest.
  - `_links/`: 210 exported link targets.
  - `_ocr/`: 6 OCR text sidecars.
- Every file was verified twice:
  1. MD5 of the downloaded bytes = bucket ETag (all objects are single-part, so all 479 were MD5-checked), and SHA-256 of the file read back from disk = SHA-256 of the download.
  2. An independent `sha256sum -c SHA256SUMS.txt` over the whole folder: all 479 OK.
- `files.sha256` is filled for all 262 course items in the database.
- The folder is self-describing: `README.txt` (what is where, how to verify), `SHA256SUMS.txt`, and `_archive_index.json` (key → path, size, MD5, SHA-256).
- Windows path problems: none (0 names needed changing). The Documents folder is local, not inside OneDrive.
- The network dropped twice during the run (DNS). The 42 failed downloads were fetched on an incremental re-run. `scripts/mirror-local.js` is safe to re-run at any time and only fetches new or changed objects.

## OCR (`scripts/ocr-docs.js`, Tesseract)
| Document | Pages | Mean confidence |
|---|---|---|
| Finance: Pre-Read FOF1 (scanned textbook, *Corporate Financial Statements, Ind AS*) | 104 | 83.7 |
| Crafting Marketing: Answer Key Set A | 5 | 91.4 |
| BYOB: Product Selection workshop | 40 | 85.9 |
| BYOB: Supply chain workshop 2 | 20 | 89.2 |
| E101 Drive folder: Moh Cream Perfumes deck | 5 | 90.4 |
| E101 Drive folder: SoleMate Quirky Socks deck | 5 | 68.2 |

- Pages scanned sideways are detected and rotated automatically. The answer key went from 42 to 91 confidence after this fix.
- Each finished page is cached on disk (`.cache/ocr/`, gitignored) and network calls retry, so a dropout costs at most one page. One upload timeout during this run was recovered automatically.
- OCR text is stored in search (`doc_chunks.is_ocr = true`, 420 chunks) and as a readable sidecar `_ocr/<original path>.txt`.
- **Caveat:** OCR loses formatting. The Crafting answer key marks correct options in **bold**, so the text contains the questions and options but not which option is correct. Use the PDF for answers.
- Search verified: "deferred tax liability" → FOF1 pages 42 and 59 (OCR text).

## Search index now
357 documents with text (351 native + 6 OCR) → 6,049 chunks.
Not searchable: 5 videos, 1 PNG, 1 Keynote file, and the Orientation "Hand Book" (its Google Doc needs your login).
