Paste everything below into Claude Code, run from the folder that contains this handoff (CONTEXT.md, data/, scripts/).

---

You are building a private web app for me (Nupur, PG student at Mesa School of Business) that becomes my permanent repository of everything from my Nexus LMS, because I lose Nexus access in about a year.

Read these first, in order: `CONTEXT.md`, `data/mesa_data.json`, `scripts/ingest.js`, `scripts/harvest.js`, `scripts/build.py`. CONTEXT.md has the goals, decisions already made, the Neon project IDs, the current database and bucket state, and the technical constraints. Do not redo decisions listed there.

Priorities, in order: (1) exam prep, (2) permanent repository, (3) lifetime timeline, (4) recommendations for using MESA fully. Brother's LMS comes later as a separate profile with his consent; keep everything profile-scoped.

Do this in order, and stop to show me results after each step:

1. **Reconcile the archive.** Use the Neon MCP (project cold-grass-13336903, branch br-bitter-frog-azrkg0by, bucket mesa-files). List the bucket objects and compare against the 238 items in `data/mesa_data.json`. Report exactly what is missing or failed. Nothing may be silently skipped. The ingest is already complete and the upload credential is already revoked; check the "Known caveats" in CONTEXT.md (duplicate SHA in Crafting decks, >30 MB files, link targets not downloaded) and report anything missing.
2. **Finish the database.** Add tables for attendance, MRS, announcements, document chunks (text extracted from PDFs/DOCX/PPTX/XLSX/notes with Postgres full-text search) and exam progress. Load `courses`, `files` (with `storage_key`), `recordings`, attendance and MRS from the JSON. Existing loaded tables: calendar_events (424), assignments (48), notifications (18).
3. **Local copy.** Download the bucket to `C:\Users\NUPUR\Documents\MESA-Archive` (same key paths) and verify counts and checksums.
4. **Build the app** (Next.js + Neon, single-user auth). Screens: Home (what's due, upcoming exams); Courses by term with every file, note, link and YouTube recording; global search across extracted document text; Exam Prep (per-course mock tests and flashcards generated from the course material, weak-topic tracking, spaced repetition; reuse the structure of the Art of Selling exam skill for that course); Timeline (past and upcoming, filterable by term, kind); Recommendations (pending assignments, MRS eligibility and Resume Stress Test due 25 Oct 23:59, low attendance in Art of Selling and AI, specialisation/ILS/BSL, office hours).
5. **Sync.** Write a sync routine that re-crawls Nexus and adds only new items (use `scripts/harvest.js` and `scripts/ingest.js` as the starting point; dedupe by storage key and checksum; log to `sync_log`). Be explicit with me about its limits: it only works while my computer is on and my Nexus login is valid, and it cannot enter my password.

Rules: no secrets in the repo or in chat (get credentials from the Neon MCP at runtime, keep them in `.env.local`, gitignored). Tell me plainly when something cannot be done or when an assumption is a guess. Challenge any decision that you think is wrong before building it, and tell me the downside. Verify your work (counts, a test exam, a search query) before telling me a step is done.
