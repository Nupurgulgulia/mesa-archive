// DEPRECATED 2026-10-20. Do not run. Use scripts/nexus-capture.js instead.
//
// This was the first-pass ingest that ran inside the Nexus tab. A reconciliation on 2026-10-20
// (reports/step1-reconciliation.md) found it lost data in three ways:
//  1. It clicked the dialog's "Download" button. Nexus builds that download from whatever document the
//     viewer has loaded, which is often the PREVIOUS item, so the same file was saved under several
//     names (1_, 2_, ... prefixes) and 14 real files were never captured.
//  2. It never checked that the open dialog belonged to the clicked item, so NOTE items saved the
//     previous note's text.
//  3. LINK items open an external URL via window.open (no dialog). It saved the Nexus page text
//     instead, so ~85 link targets (Google Docs/Sheets/Slides, Gamma, Drive) were not recorded.
// It also required a storage credential stored in the page's localStorage.
//
// scripts/nexus-capture.js fixes all of these: it uses "Open in new tab" (signed URL names the exact
// material id), waits for the dialog whose title matches the item, captures window.open targets,
// addresses duplicate labels by position, and never needs a credential in the page (bytes are
// uploaded with one-time presigned URLs).
