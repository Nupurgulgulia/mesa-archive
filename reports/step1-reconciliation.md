# Step 1 — Archive reconciliation (2026-10-20, final)

## Outcome
Every item that Nexus shows across 24 courses (Overview, Recordings, Announcements and Assignments tabs excluded) is now in `mesa-files`, verified against a fresh crawl of Nexus.

| | Count |
|---|---|
| Items on Nexus (fresh crawl, `data/nexus_manifest_2026-10-20.json`) | **262** = 120 files + 142 notes/links |
| Files matched to a bucket object (same folder, size within Nexus's rounding) | **120 / 120** |
| Notes/links whose bucket content matches Nexus | **142 / 142** |
| Crawl errors | 0 |
| Bucket objects matched to nothing on Nexus | 17 (14 bogus duplicates + 3 under `_meta/`), see below |

The original dataset (`mesa_data.json`, 238 items) undercounted. Nexus also has Basic Accounting/Finance cheat sheets, extra Entrepreneurship 101 decks, quiz links, feedback forms and the Art of Selling one-pagers PDF.

## What was wrong, and what was done
The first ingest (`scripts/ingest.js`) had three bugs that lost data silently:

1. **Download button served the previous file.** Nexus builds the download from whatever the viewer has loaded. 14 files were never captured; copies of the folder's first file were saved instead (`1_…`, `2_…`).
   **Fixed:** re-fetched via "Open in new tab" (the signed URL names the exact material id) and uploaded:
   - AI and its Application: Supabase pre-read, Gemini API Keys, Session Deck, Session 1 Deck, Telegram Setup, Seed Data (PDF), Solution Key ×2, Session 3 Deck, Case Study 2 Session Deck, plus the Test Cases and Case Study 3 Seed Data links
   - Personal Branding: Session 2_Storytelling & Writing **PDF**
   - Crafting Marketing: **Session 4.pptx** (22.7 MB). Confirmed on Nexus: the old `S4 Mkt 101` object is Session 3's deck under the wrong name.
2. **Note text came from the previous dialog.** Examples: Start Strong "If You're a Movie Buff" held the "Startup Awareness" text, and Art of Selling Session 3/8 each have two different Gamma decks, which were saved as one.
3. **Link items saved the Nexus page instead of the target.** About 85 links (Google Docs/Sheets/Slides, Gamma, Drive) had no target URL recorded.

**Fixed (2 and 3):** a new crawler (`scripts/nexus-capture.js`) re-captured all 142 notes/links. It waits for the dialog whose title matches the item, or captures the `window.open` target. 138 note objects were rewritten and 4 were already correct. `scripts/verify-notes.js` now passes, except for 6 genuine cases: 4 text-only notes, and 2 places where Nexus points two items at the same document.

## Faculty-side duplicates (on Nexus itself, not capture errors)
- AI Session 1: "Session Deck" and "Session 1 Deck" are byte-identical.
- Start Strong Week 12 re-posts the Week 9 Data Analytics cheat sheet.
- Art of Selling: Session 6 and Session 7 pre-reads point to the same Drive file. Session 3 (2nd deck) and Session 8 (1st deck) share a Gamma deck.

## Proposed deletions (awaiting your OK; deletion is permanent)
Byte-identical extra copies. The un-numbered copy is kept in each case.
- `Term 1/AI and its Application/Mihirr's Resources/Session 1 - Claude 101/{1_,2_,3_,4_}MESA_Lecture 1_Build Prompt.pdf` (4)
- `…/Case Study 1 - Session 3/{1_..5_}MESA_Case 01_Solution Template.docx` (5)
- `…/Case Study 2 - Session 1/{1_,2_}MESA_Case 02_Components Map.png` (2)
- `…/Case Study 3/1_Vaani Platform Invite codes for Mesa.xlsx` (1)
- `Term 1/Personal Branding/…/1_Session 2_Storytelling & Writing.pptx` (1)
- `Term 1/Crafting Marketing Strategies/…/S4 Mkt 101_Mesa PG26 (2).pptx` (1; a mislabelled copy of Session 3)
- `_meta/test.txt`, `_meta/test2.pdf` (2)

(The script's report lists different numbered copies only because its matcher picked arbitrarily among identical files.)

Keep: `_meta/capture/nexus_manifest_2026-10-20.json` (the crawl that proves this reconciliation).

## Credentials
- `nexus-ingest`: already revoked at 06:40 UTC before this session (confirmed).
- `local-archive-read`: created and revoked during this step.
- `local-archive` (storage read+write): active, stored only in `.env.local` (gitignored). Used by the local scripts and step 3.
- Nothing was stored in the Nexus page. Uploads from the page used one-time presigned URLs (10–20 min expiry).

## Still not archived (content gap, not a missing item)
Link targets are recorded but their content is not: Google Docs/Sheets/Slides, Gamma decks, Drive files. That covers most of Art of Selling, Finance, DDDM, Crafting and Entrepreneurship 101 teaching material. Proposed for step 2/3: export each target to PDF/XLSX while your access lasts.

## Database state (unchanged in this step)
profiles 1, calendar_events 424, assignments 48, notifications 18; courses/files/recordings/sync_log 0.
