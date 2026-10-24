# Step 2: Database (2026-10-20)

## Cleanup from step 1
Deleted 16 objects with your OK: 14 byte-identical duplicates and 2 `_meta` test files. Before each delete, the script confirmed the copy being kept existed with the same etag. Re-verified afterwards: 262/262 Nexus items still match. The bucket holds 263 course objects (262 items + the crawl manifest) plus 210 link exports under `_links/`.

## Schema (`db/migrations/002_step2.sql`, applied by `npm run migrate`)
All tables are profile-scoped.
- **Tightened:**
  - `files` is now keyed by `(profile_id, storage_key)` and Nexus `material_id`. The old (course, tab, folder, name) key broke on duplicate labels.
  - Real `date` columns were added to recordings, assignments and notifications.
  - `course_id` was added to assignments and calendar.
  - `calendar_events.status` is frozen at 20 Oct and is marked "do not use"; the app computes past/upcoming from the date.
- **New:**
  - Records: `attendance`, `mrs`, `mrs_requirements`, `announcements`.
  - Links: `link_targets` + `file_links` (external links and their exported copies).
  - Search: `doc_extractions` + `doc_chunks` (text plus a generated `tsvector`, GIN index).
  - Exam prep: `exams`, `topics`, `exam_items`, `exam_sessions`, `attempts`, `srs_state` and the `topic_mastery` view. These stay empty until step 4.
  - `sync_log`: richer columns.

## Loaded (`npm run load`, idempotent)
| Table | Rows | Notes |
|---|---|---|
| courses | 24 | with bucket prefix |
| files | 262 | 120 files, 41 notes, 101 links; every row has storage_key + etag |
| recordings | 88 | 2 undated, 5 flagged `date_uncertain` (E101 S5 pt 2, DDDM S8/S9, Finance S5) |
| attendance | 13 | 12 subjects + overall 94/119 (79%), as of 2026-10-20 |
| mrs / mrs_requirements | 3 / 2 | MRS 1 = 62.9; weekly TMAY; Resume Stress Test due 25 Oct 23:59 IST |
| announcements | 34 | **titles only.** Bodies were never captured; the sync should fetch them |
| exams | 11 | incl. Mid Term 23 Nov, BMM Final 2 Dec, End Term 22–23 Dec |
| calendar / assignments / notifications | 424 / 48 / 18 | backfilled with course_id and real dates; 12 assignments have no due date on Nexus |

## Link exports (`scripts/export-links.js` + browser for Gamma)
220 distinct link targets: 54 YouTube (links only, per the earlier decision) and 60 general web articles (HBR, Medium etc.; not MESA content, not exported).
- **Exported (103):**
  - 84 Google Docs/Sheets/Slides (as PDF/XLSX)
  - 13 Drive files
  - 6 Drive folders (all files inside)
  - 8 Gamma decks (text only; Gamma blocks file export without an account)
- **Needs your Google login (3):** Orientation "Hand Book" (Google Doc), Entrepreneurship 101 Session 3 and Session 4 decks. Sign in to Google in the built-in browser and they can be fetched in a minute.
- Size: about 660 MB, mostly 5 videos found in Drive links (MSL session recording 186 MB, "Building an AI-native career" 141 MB, and three others).

## Full-text search
- **Indexed:** 351 documents → 5,629 chunks (≈5.6 M characters) across 17 courses.
- **No text yet (scanned/image-only PDFs, need OCR):** Finance **Pre-Read FOF1 (104 pages)**, Crafting **Answer Key Set A**, BYOB **Product Selection workshop** and **Supply chain workshop 2**, plus 2 image-only E101 student decks.
- **Not text by nature:** 5 videos, 1 PNG (AI Components Map), 1 Keynote file.
- **Verified with real queries:**
  - "mom test discovery questions" → AoS Session 1 pre-read
  - "jobs to be done AMUSED" → AoS JTBD Gamma deck
  - "contribution margin unit economics" → Data 102 / Ops pre-reads

## Known gaps / follow-ups
1. OCR for the 4 image-only course PDFs (needed before using Finance/BYOB material for exam prep).
2. 3 login-only Google files.
3. Announcement bodies (not captured on 20 Oct).
4. Bucket keys have no profile prefix. When your brother's profile is added, his files should go under a separate prefix or bucket. Decide before his first ingest.
5. DDDM dominates the index (59% of text) because its Google Sheets workbooks export row by row. Fine for search; exam generation should weight by course, not by volume.
