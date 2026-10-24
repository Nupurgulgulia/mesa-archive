# Nexus sync runbook

The sync copies whatever is new on Nexus into the archive: new course files, notes and links, announcement
text, assignments (with your submission status), notifications, calendar changes, attendance (per session and
per course, with class-participation points), MRS scores and class recordings. Only new or changed items are
added. Nothing in the archive is ever overwritten or deleted.

## Limits (read these)
- **It only runs while this computer is on, the Claude desktop app is open, and you are logged in to Nexus
  in the app's built-in browser.** If Nexus has logged you out, the run stops and records `login_required`;
  it cannot type your password. Log in again in the built-in browser and the next run picks up everything missed.
- **The Nexus tab must be in the front while it runs** (Chrome doesn't render hidden tabs, so their data never
  loads). A scheduled run brings it to the front itself. Don't close or navigate that tab during a run (~10 to 15 min).
- **Each scheduled run uses your Claude usage**, because a Claude session drives the browser.
- **It stops working when your Nexus access ends.** After that the app is a frozen archive. Do a final manual
  run in your last week.
- New files are fetched one at a time through Nexus's normal viewer. A file Nexus won't open (removed,
  restricted, too large to download in the browser) is reported in `sync_log`, not silently skipped.
- Practice questions for new material are not generated automatically (that costs Gemini usage): press
  Generate in Exam prep, or run `npm run generate -- <course> --missing-only`.

## What a run does
All commands run in `C:\Users\NUPUR\Projects\mesa-archive`.

1. `npm run -s sync -- prepare`. Prints `{"runId": …, "snapshotPutUrl": …}`. It opens a `sync_log` row and
   creates a one-time upload link for the snapshot. (The link is a short-lived write permission for that one
   file only.)
2. In the built-in browser:
   - **Bring the Nexus tab to the front** (`tabs_select`). If no tab is on `students.mesaschool.co.in`,
     open one at `https://students.mesaschool.co.in/student/lms`.
   - Check you're logged in: the page title is not a login page and `window.next` exists. If logged out,
     **stop**: run `npm run -s sync -- status` and record the problem with
     `npx tsx scripts/sync.ts fail <runId> login_required`, then tell Nupur to log in. Never type a password.
   - Reload the page (navigate to `/student/lms`), then inject the full contents of `scripts/nexus-sync.js`
     with the javascript tool, followed by `window.mesaSync.snapshot({ putUrl: '<snapshotPutUrl>' })`.
   - Poll `localStorage.mesa_sync_status` every ~40 s until `running` is false. Expect `step: "done"` and
     `missing: []`. If anything is listed in `missing` or `errors`, continue but report it.
3. `npm run -s sync -- plan <runId>`. Writes new/changed notes and links directly, matches files already in
   the archive, and lists files to download in `.cache/sync/<runId>/plan.json` (`downloads`, `resultsPutUrl`).
4. If `filesToFetch > 0`: in the Nexus tab (still in front, script still loaded; re-inject if the page was
   reloaded) run `window.mesaSync.fetchFiles({ items: <downloads array from plan.json>, resultsPutUrl: '<resultsPutUrl>' })`
   and poll `localStorage.mesa_sync_status` until `running` is false.
5. `npm run -s sync -- apply <runId>`. Verifies every download (size against Nexus, checksum dedupe), imports
   everything else, saves link content, extracts text, OCRs scans, refreshes the local copy in
   `Documents\MESA-Archive`, and completes the `sync_log` row (`ok` / `partial` with reasons).
6. Report: `npm run -s sync -- status`, plus anything new worth knowing (new assignments and due dates, new
   announcements, attendance changes, MRS changes).

## Where things go
- Run records: bucket `_meta/sync/<runId>/` (snapshot.json = what Nexus showed, plan.json, fetch-results.json,
  apply.json) and the `sync_log` table (the app shows the last sync on Home and in Recommendations).
- New files: same layout as before, `<Term>/<Course>/<Tab>/<Folder>/<file>`. A file changed on Nexus is saved
  as `<name> (updated YYYY-MM-DD).<ext>` next to the old one.

## Privacy
The browser script never reads or reuses login tokens or cookies. It keeps copies of the data Nexus's own pages
receive, and removes your profile record, other people's details (calendar attendee lists, names in
announcement replies, likers, avatars) and the short-lived download links before anything leaves the browser.
