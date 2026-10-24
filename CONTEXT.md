# MESA Repository App — Context for Claude Code

Owner: Nupur, PG student, Mesa School of Business (PGP Cohort IV, Batch 2027). Nexus LMS: https://students.mesaschool.co.in
**Hard deadline: Nupur loses Nexus access in ~1 year. This app must become the permanent, self-sufficient repository.**

## Goals (in priority order)
1. **Exam prep (v1 focus):** per-course mock exams, flashcards, weak-topic tracking, built from the archived PDFs/decks/notes. Upcoming exams: Mid Term Exam 23 Nov 2026, Business Metrics & Mindset Final 2 Dec, End Term 22–23 Dec 2026. Term 1 end-terms were 16 Oct (no grades published on Nexus yet).
2. **Permanent repository** of everything learned: every file, note, link, recording link, assignment, announcement, term-wise (Pre-Term, Term 1, Term 2).
3. **Lifetime timeline** of what she did/achieved at MESA (calendar events past + upcoming, assignments, MRS, attendance, startup-leader sessions, hackathons, flea market, etc.).
4. **Recommendations** on how to use MESA fully (MRS eligibility, ILS/BSL, office hours, specialisation primer, pending assignments, low attendance in Art of Selling 61.5% and AI 68.2%).
5. Later: brother's UG LMS as a **separate profile, only with his consent**. Schema is already profile-scoped (`profile_id`).

## Decisions already made
- Private web app (single user, auth required). Archive in BOTH Neon cloud and a local computer folder (`C:\Users\NUPUR\Documents\MESA-Archive`).
- YouTube class recordings: **links only** for now (88 recordings). Revisit downloading videos later (they may vanish after she leaves).
- Sync cadence: every few hours, add only new items.
- Backend: **Neon** (not Supabase). Neon project `mesa-archive`, id `cold-grass-13336903`, branch `br-bitter-frog-azrkg0by` (main), region aws-ap-southeast-1, org `org-restless-rice-08854398`. Bucket `mesa-files` (private). DB `neondb`.
- Credentials: NOT in this folder. Get a connection string via Neon MCP `get_connection_string`; create a fresh storage credential via `create_credential` (storage:read/write). The ingest credential `nexus-ingest` (key id nak_live_a6a2077dbb3b…) was created for the browser and **must be revoked** (`revoke_credential`) once ingest finishes.

## Data on hand (see `data/mesa_data.json`, 115 KB, captured 2026-10-20)
Keys: student, program, lms, captured, grades, terms, courses(24), calendar(424), assignments(48), notifications(18), attendance, mrs.
- Course: id, term, title, faculty, mode, outline (Google Sheet URL), folders[{tab,name,date,files[{name,type,size}],links}], recordings[{title,date,youtube_id,url}], announcements, extra.
- 238 listed items: PDF 91, LINK 87, NOTE 37, DOCX 9, PPTX 9, XLSX 4, PNG 1. 88 recordings. 39 assignments submitted / 9 pending. Attendance 94/119 (79%). MRS 1 baseline 62.9/100; Resume Stress Test due 25 Oct 23:59.
- Known data uncertainty: a few recording dates may be swapped (Entrepreneurship 101 S5 part 2, DDDM S8/S9 order, Finance S5 undated). Term split rule: events before 2026-10-19 = Term 1, else Term 2.
- Course IDs (Nexus /student/lms/courses/<id>) are in `scripts/ingest.js` queue below and in mesa_data.json.

## Neon state right now
Tables created (profile-ready): `profiles, courses, files, recordings, calendar_events, assignments, notifications, sync_log`. Row `profiles('nupur')` exists.
Loaded: calendar_events (424), assignments (48), notifications (18).
**NOT yet loaded:** `courses`, `files`, `recordings` (load from mesa_data.json; `files.storage_key` should map to bucket keys), attendance/MRS (no tables yet — add).
Bucket key convention: `<Term>/<Course short name>/<Tab>/<Folder>/<filename>` e.g. `Term 1/Business Reader/Resources/Session 1/Business Reader Session 1 PPT.pdf`. Link/notes items are stored as `*.note.json` ({label,text,links,url}). `_meta/` holds test objects (safe to delete).
Ingest status: **COMPLETE (2026-10-20).** Bucket `mesa-files` holds 262 course objects (+2 `_meta/test*` objects to delete). Per course: Start Strong 31, AI Workshops 6, AI&App 32, BYOB 5, Business Frameworks 11, Business Reader 11, Crafting 23, DDDM 34, Ent101 14, Finance 27, Orientation 2, Personal Branding 6, PoC 16, Art of Selling 37, BMM 4, Data 102 2, Ops&SC 1. Counts exceed the dataset's listed-item counts because link/note items are saved as `.note.json` and some folders had extra items. Courses with 0 items on Nexus: Career Readiness, AI with Mihirr, B2B Sales, Economics, First Principles Lab, Growth, SQL (Term 2 content not yet uploaded by faculty; the sync must pick it up).
Credential `nexus-ingest` has been REVOKED and removed from the browser.
Known caveats to verify in step 1:
- Crafting Marketing "Decks with Comments (Reshared)": Session 3 and the earlier "S4 Mkt 101" upload have identical SHA-256 (e5a0829a...) and size (20,971,486 B). One is probably a wrong/duplicate file served by Nexus. Compare against Nexus, don't assume.
- Files retried via "Open in new tab" are named after the viewer title (e.g. `Session 1.pptx`), not the original filename.
- Files over 30 MB (device_commit_files limit) cannot be written to the computer folder by the Claude desktop bridge, e.g. Finance Pre-Read FOF1 (49.9 MB), Crafting Session 6 deck (35 MB), Personal Branding Session 4 (31 MB). A Claude Code session on her computer can download these directly from Neon.
- LINK items are stored as `.note.json` containing the target URLs (YouTube, Google Drive). The Google Docs/Drive targets themselves were not downloaded.
- First-pass walker missed The Art of Selling "Resources" session folders and failed on slow-loading PPT/large PDFs ("no dl url"); both fixed by (a) polling up to 15 s for the Download button, (b) using the viewer's "Open in new tab" signed URL via a window.open hook. Fold both fixes into any new sync.

## Update 2026-10-20 (step 1 reconciliation): supersedes "Ingest status" above
- The first ingest was NOT complete: 14 files were missing and ~95 notes/links were wrong. All are now fixed and verified against a fresh crawl (262 Nexus items = 120 files + 142 notes/links, all matched). Details: `reports/step1-reconciliation.md`.
- `scripts/ingest.js` is deprecated (its Download-button approach saved the previous file). Use `scripts/nexus-capture.js` (manifest + optional download, no credentials in the page) and `scripts/apply-capture.js` (reconcile manifest against bucket). File identity on Nexus = material id `<course uuid>/<material uuid>.<ext>`.
- Local scripts use `scripts/lib/s3.js` with credential `local-archive` from `.env.local` (gitignored).
- The built-in browser cannot reach 127.0.0.1. Move data out of the Nexus tab via presigned PUT into `_meta/`.

## Update 2026-10-20 (step 2 database), see `reports/step2-database.md`
- Schema lives in `db/migrations/` (`npm run migrate`). Loader: `npm run load` (idempotent). `DATABASE_URL` is in `.env.local`.
- All tables are loaded (courses 24, files 262, recordings 88, attendance 13, mrs 3, exams 11, announcements 34 titles). Exam-prep tables exist but are empty.
- External link content is exported to `_links/` (`scripts/export-links.js`; Gamma via browser text). 3 Google files need her login.
- Text search: `scripts/extract-text.js` → `doc_chunks` (5,629 chunks). 4 image-only PDFs need OCR.

## Update 2026-10-20 (step 3 local copy + OCR), see `reports/step3-local-copy.md`
- `C:\Users\NUPUR\Documents\MESA-Archive` = verified mirror of the bucket (479 files, 953 MB, `sha256sum -c SHA256SUMS.txt` all OK). Refresh with `node scripts/mirror-local.js` (incremental).
- 6 scanned docs OCR'd (`scripts/ocr-docs.js`, auto-rotation, per-page cache, retries). Text is in `doc_chunks` (is_ocr) and `_ocr/`.
- Her network drops intermittently: every long-running script must retry (`scripts/lib/retry.js`) and be resumable.

## Update 2026-10-20 (step 4 app), see `reports/step4-app.md` and `README.md`
- The Next.js 15 app lives in this folder (`app/`, `lib/`). Start with `Start MESA Archive.cmd` → http://127.0.0.1:3000 (bound to localhost only). Single password (`npm run set-password`).
- AI = Gemini (`GEMINI_API_KEY`, model `gemini-3.8-flash`) because Neon's AI gateway needs a paid plan. 2,244 practice questions across 16 courses, all source-cited. Art of Selling mock paper and 4 role-play buyers reuse the artofselling skill (`lib/exam/aos.ts`).
- `.env.local` keys: DATABASE_URL, NEON_S3_* (scripts, read/write `local-archive`), APP_S3_* (app, read-only `mesa-app-read`), GEMINI_*, APP_PASSWORD_HASH (`scrypt:salt:hash`; never use `$`, Next expands it), SESSION_SECRET, ARCHIVE_DIR.
- Open: she must set her own password and delete APP_TEST_PASSWORD; rotate the pasted Gemini key; decide on moving the project out of OneDrive (keys + node_modules currently sync).

## Update 2026-10-20 (step 5 sync), see `reports/step5-sync.md` and `docs/SYNC.md`
- The project moved out of OneDrive to `C:\Users\NUPUR\Projects\mesa-archive` (Desktop shortcut "MESA Archive").
- Nexus pages load from a private API (api-students.mesaschool.co.in/api/v1). The sync copies the RESPONSE BODIES its pages receive while navigating the logged-in, VISIBLE tab. Never read or reuse tokens (that was correctly blocked). Materials: `/content/topics/<id>/materials`; file downloads via the viewer's `/content/materials/<id>/signed-url`.
- Identity: `nexus_materials.material_id` maps every Nexus item to its archive object (file name + exact size; notes by content). Synced rows carry `nexus_id`; legacy uniqueness applies only where nexus_id is null.
- Scheduled task `mesa-nexus-sync` (07:30/14:30/21:30). `npm run sync -- status` shows runs.
- MRS truth: MRS 1 "Data, AI and communication" = 62.9; Baseline Submission = 66.7 (MRS scale).
- 9 courses on Nexus were missing from the original archive (ILS, BSL, Startup Lab, etc.); added (no materials yet).

## Hard technical constraints (learned the hard way)
- Nexus is Next.js; no public API. Data is only reachable by driving the logged-in UI.
- Files open in an in-page PDF viewer; the dialog's **Download** button creates a synthetic `<a download href=signed GCS URL>`. Signed URLs expire in minutes. Page JS can `fetch` them and PUT to Neon with SigV4 (CORS fine from the Nexus origin; Nexus has no CSP).
- The Claude cloud sandbox **cannot reach Neon storage directly** (proxy 403). Uploads must originate from the Nexus tab in her browser, or presigned URLs used from a machine with open egress. A Claude Code session on her own computer likely CAN reach Neon directly.
- javascript_tool has a 45 s timeout: run long jobs fire-and-forget, store progress in localStorage, poll.
- Browser Download clicks do not reliably land in ~/Downloads.
- Auto-sync = a scheduled task running in her desktop app's built-in browser (create_trigger, requires_local_device). Works only when her computer/app is on and Nexus session is valid; cannot enter passwords. After Nexus access ends, no more sync — the app is then a frozen archive.
- Not available from Nexus: transcripts, grades (none published), video files (YouTube only).
- YouTube links could rot; Google Docs/Drive links in notes are not yet captured as content.

## Suggested architecture
Next.js (or Vite+React) + Neon Postgres; files served via presigned download URLs from `mesa-files`; simple auth (one password/Neon Auth); PDF text extraction (pdf-parse/pdfjs) into a `chunks` table with full-text search (tsvector) and optionally embeddings; exam engine generating MCQs/short answers per course from chunks; progress/weak-topic tracking table; timeline view from calendar_events+assignments+notifications; recommendations page driven by deadlines, MRS, attendance.
The MESA "Art of Selling" course has an existing exam-engine skill (anthropic-skills:artofselling: MCQs, discovery questions, voice call, PSBA pitch, objections, negotiation) — reuse its structure for that course.
