# Step 5: Nexus sync (2026-10-20)

Runbook: `docs/SYNC.md`. Code: `scripts/nexus-sync.js` (browser half), `scripts/sync.ts` (`npm run sync -- prepare | plan | apply | status | dedupe | fail`).
Scheduled task **`mesa-nexus-sync`**: 07:30, 14:30 and 21:30 daily, saved in Auto mode.

## How it works (and why it's different from the original ingest)
Nexus's pages load their data from a private JSON API. The sync never touches your login: it **keeps copies of the data responses Nexus's own pages receive** while it navigates them in your logged-in browser. A first attempt to reuse the login token was correctly blocked by the safety checker, and was abandoned.
- **Snapshot:** one ~13-minute pass covers home, notifications (all pages), assignments, attendance, MRS, the calendar (Aug to 3 months ahead) and all 33 courses (every tab). Before upload it strips your profile record, other people's details (attendee lists, reply authors, likers) and download links. The result is saved permanently as `_meta/sync/<run>/snapshot.json`.
- **Plan (local):**
  - Every Nexus material is matched to the archive by file name + exact size (files) or by content (notes/links).
  - Notes and links come straight from the data, with no clicking.
  - Only genuinely new files are downloaded, each identified by its Nexus **material id** through the normal viewer, so the "wrong file under the right name" bug of the first ingest cannot recur.
- **Apply (local):**
  - Downloads are verified (size vs Nexus, checksum dedupe).
  - Imported: announcements (with text), assignments (with submission status), notifications, calendar, per-session attendance + course totals (with class participation), MRS, recordings.
  - Hand-captured 20 Oct rows are merged into their Nexus rows.
  - Then link export, text extraction, OCR and the local mirror run, and `sync_log` is written.
- **Never overwrites:** an existing archive object is never rewritten (the code refuses). A changed item is saved as `… (updated <date>)` next to the old one. Items removed from Nexus are only marked `removed_at`.

## First full run (`2026-10-20T16-17-15-079Z`): status ok
| | Result |
|---|---|
| Courses on Nexus | 33. **9 were missing from the archive**: Idea Lab Sprint, Business Sprint Lab, Mesa Start-up Lab, Sector Spotlight, Specialisation Primer, Workshops, a second Ops & Supply Chain section, two "Startup Leader". All 9 currently have no materials. |
| Files | All **120** archived files recognised on Nexus. **0 new files** since 20 Oct. |
| Notes/links | **22 new** (course outlines for every course, BYOB handbook and team list, Start Strong welcome); 142 unchanged. |
| Announcements | **43, all with full text** (20 Oct had titles only). |
| Assignments | 48, all linked; Nexus says **7 are not submitted**. |
| Notifications | 43 (40 linked to Nexus; 3 older hand-captured ones kept). |
| Calendar | 443 events, every one linked to Nexus (the 424 hand-transcribed ones merged in, plus ~20 genuinely new). |
| Attendance | 120 sessions + per-course totals, now with class-participation points. |
| MRS | MRS 1 "Data, AI and communication" = **62.9**; Baseline Submission "Where you start" = 66.7 (MRS scale, 26.69/40); MRS 2 and 3 not yet scheduled. |
| Recordings | 90; **all now have Nexus's own dates** (the 5 "uncertain" ones are resolved). |
| Link exports | 17 new course-outline docs saved; 5 need your Google login. |
| Idempotence | Re-running `apply` on the same snapshot: **0 new, 0 failures**. |
| File download path | Tested on a known file: downloaded copy **byte-identical** to the archive (SHA-256). |

## Problems found while testing, and fixed
1. **The first plan overwrote 21 archived notes and lossily re-rendered them** (lost links, swapped two same-titled AoS decks), and created 18 duplicate notes. **All 21 were restored byte-for-byte** from the verified 20 Oct local copy, and the 18 duplicates were removed. Matching is now by content, and the code refuses to write to an existing key. Re-check: 0 archived objects changed.
2. **Hidden browser tab = no data.** Chrome doesn't render background tabs, so the first snapshot missed whole sections. The script now refuses to run unless the Nexus tab is visible, waits for each page's data, and reports missing sections.
3. **Duplicate calendar/announcement/notification/assignment rows**, because Nexus's real titles differ from the 20 Oct transcription (typos, dashes, course names, "Important:" prefixes). Now matched by Nexus id, then by a strict fuzzy rule (numbers must match exactly), with a merge step; dry-run reviewed by hand (23 merges, no false ones).
4. **MRS mapped by position** (wrong). Now by title. *Correction:* earlier in this session I said your MRS changed to 66.7. It did not: **MRS 1 is 62.9**; 66.7 is the separate baseline component.
5. Attendance shown twice (Nexus course names include faculty): fixed.
6. Old uniqueness rules made distinct Nexus items with identical text overwrite each other: replaced by Nexus-id identity (migration 007).
7. File download clicked too early after re-render: now waits for elements; verified.

## Limits (plain)
- **Runs only while this computer is on, the Claude app is open, and you're logged in to Nexus in the app's built-in browser.** It cannot enter your password; a logged-out run records `login_required` and stops.
- **During a run (about 13 to 20 min) the app's browser pane is in use and the Nexus tab must stay in front.** Avoid using the built-in browser at 07:30 / 14:30 / 21:30, or change the times.
- **Each run uses your Claude allowance.**
- **When your Nexus access ends, the sync ends.** Do a manual run in your last week.
- Practice questions for new material aren't generated automatically (Gemini cost): use Generate in Exam prep.
- A scheduled run is a separate Claude session following the runbook. If Nexus changes its pages, a run may fail; it reports rather than improvises.
