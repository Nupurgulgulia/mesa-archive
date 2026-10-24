# MESA Archive

Nupur's private repository of everything from the Nexus LMS (Mesa School of Business, PGP Cohort IV), with exam prep, a lifetime timeline and recommendations. Runs on this laptop at http://localhost:3000; data lives in Neon (Postgres + object storage) and in a verified local copy at `C:\Users\NUPUR\Documents\MESA-Archive`.

## Start it
Double-click **`Start MESA Archive.cmd`**: it builds on first run, starts the app, and opens the browser. Close the window to stop it.

First time only, set your password (typed in the terminal, never stored in plain text):
```
npm run set-password
```

## What's where
| Screen | What it does |
|---|---|
| Home | What's due, exam countdowns, this week, review queue, weak topics, attendance, latest notices |
| Courses | Every course by term: files, notes, links (with saved copies), recordings, assignments, announcements |
| Search | Full-text search across every document, OCR'd scan and saved link copy; jumps to the PDF page |
| Exam prep | AI-generated MCQs, flashcards and short answers per course (cited to sources), mock tests, weak-topic drills, spaced repetition; Art of Selling mock paper and role-play buyer drills |
| Timeline | Classes, exams, events, deadlines, notices, MRS and recordings, filterable by term and kind |
| Recommendations | Deadlines, MRS eligibility, attendance, specialisation, ILS/BSL, office hours, events, archive gaps |

## Secrets
All secrets are in `.env.local` (gitignored, never commit it): `DATABASE_URL`, Neon storage keys (`NEON_S3_*` read/write for scripts, `APP_S3_*` read-only for the app), `GEMINI_API_KEY`, `APP_PASSWORD_HASH`, `SESSION_SECRET`. To rotate a Neon key, create a new credential in the Neon console (or ask Claude via the Neon MCP), replace the value, and revoke the old one.

## Scripts
| Command | Purpose |
|---|---|
| `npm run set-password` | Set/change the login password (signs out existing sessions) |
| `npm run generate -- list` / `-- <course>` / `-- all` | Generate practice questions from course material (Gemini) |
| `npm run migrate` | Apply database migrations in `db/migrations/` |
| `npm run load` | (Re)load courses, items, recordings, attendance, MRS from `data/` (idempotent) |
| `npm run export-links` | Save Google Docs/Sheets/Slides/Drive content behind links into the bucket |
| `npm run extract-text` | Extract searchable text from new/changed documents |
| `npm run ocr` | OCR image-only PDFs/decks (resumable) |
| `npm run mirror` | Refresh the verified local copy in Documents\MESA-Archive |
| `npm run verify-notes` | Check every note/link object for stale captures |
| `node scripts/export-json.js` | Export the current database to `data/mesa_data_<date>.json` (same layout as the original `mesa_data.json`) |
| `node scripts/smoke-test.js <url>` | Check a running copy (local or Vercel): pages, login refusal, file download, exam write |
| `npm run sync -- status` | Recent Nexus sync runs (the sync itself runs as the scheduled task `mesa-nexus-sync`; see `docs/SYNC.md`) |

## Reports
`reports/step1-reconciliation.md`, `step2-database.md`, `step3-local-copy.md`, `step4-app.md` record what was done, verified, and what is still missing.

## Online copy (Vercel)
The app is also deployed to Vercel (project `mesa-archive`, linked in `.vercel/`). Redeploy with `npx vercel@65.2.0 deploy --prod`.
- It uses a **restricted database account `mesa_app`** (read everything; insert/update only on the exam-progress tables). Its connection string is in `.env.vercel.local` (gitignored) and in Vercel's `DATABASE_URL`. If a migration adds a table the app writes to, grant it: `grant insert, update on <table> to mesa_app;` (new tables also need `grant select`).
- Files are served from Neon storage with the read-only key (no local copy online). The sync and all scripts run only on this laptop.
- Change the password: `npm.cmd run set-password` (10+ characters), then `npm.cmd run push-password` (uploads it to Vercel and redeploys). `npm.cmd run check-password` tests a password against the saved one.
- After rotating the Gemini key, update `GEMINI_API_KEY` in Vercel (Project → Settings → Environment Variables) and redeploy.
