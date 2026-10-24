// Runs INSIDE a logged-in Nexus tab (students.mesaschool.co.in), injected via the browser's javascript tool.
// Replaces the item-capture part of ingest.js. Builds a MANIFEST of every course item without any
// storage credentials in the page:
//   file  -> {kind:'file', material:'<course uuid>/<material uuid>.<ext>'}   (bytes are fetched separately)
//   note  -> {kind:'note', text, links}   (dialog without a file: rich text + links inside the dialog)
//   link  -> {kind:'link', links:[url]}   (item opens an external URL directly via window.open)
//
// Fixes over ingest.js (each one caused real data loss in the 2026-10-20 run):
//  1. Never use the dialog's "Download" button: it builds a blob from whatever the viewer has loaded,
//     which is often the PREVIOUS item (same bytes saved under several names).
//     Use "Open in new tab", whose signed URL names the exact material id.
//  2. Wait until a dialog whose title equals the item label is open (up to 15 s) before reading it.
//  3. LINK items have no dialog; they call window.open(url). Capture that URL instead of page text.
//  4. Items with duplicate labels in one folder are addressed by position, not by label.
//  5. Folders ("Session N", "Other files", nested) are expanded recursively.
//
// Usage (fire-and-forget; poll localStorage because the tool has a 45 s limit):
//   window.mesaCapture([{id:'<course uuid>', prefix:'Term 1/The Art of Selling'}, ...])
//   JSON.parse(localStorage.mesa_cap_status)          // progress
//   JSON.parse(localStorage['mesa_cap_' + courseId])  // items for one course
// Download mode (sync): window.mesaCapture(courses, {download:true, knownMaterials:[...material ids already archived]})
//   -> new files' bytes land in window.__mesaBlobs[material]; upload them with presigned PUT URLs
//      from the Neon MCP (presign_storage_object). No storage credential is ever placed in the page.
(function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const slug = (s) => String(s).replace(/[\\/:*?"<>|#%]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120);
  const CAP = { opts: {} };
  const SKIP_TABS =/^(Overview|Class Recordings|Recordings|Announcements|Assignments|Assignment Feedback|Discussions)$/;
  const main = () => document.querySelector('main');
  const itemButtons = () => [...main().querySelectorAll('button[aria-label^="Open "]')];
  const folders = () => [...main().querySelectorAll('[class*="group/folder"]')];
  const closeDialogs = async () => {
    for (const d of document.querySelectorAll('[role=dialog]')) {
      const c = [...d.querySelectorAll('button')].find((x) => x.innerText.trim() === 'Close' || x.getAttribute('aria-label') === 'Close');
      if (c) c.click();
    }
    for (let i = 0; i < 10 && document.querySelector('[role=dialog]'); i++) await sleep(200);
  };
  const back = async () => {
    const b = [...main().querySelectorAll('button')].find((x) => /^Back$/.test(x.innerText.trim()));
    if (b) { b.click(); await sleep(1000); }
  };

  async function captureItem(btn, label) {
    await closeDialogs();
    let opened = null;
    const ow = window.open;
    window.open = function (u) { opened = String(u); return null; };
    try {
      btn.click();
      let dlg = null;
      for (let i = 0; i < 60 && !opened && !dlg; i++) {
        await sleep(250);
        dlg = [...document.querySelectorAll('[role=dialog]')].find((d) => norm(d.querySelector('h2,h3')?.innerText) === norm(label));
      }
      if (opened && !dlg) return { kind: 'link', links: [opened] };
      if (!dlg) return { kind: 'error', err: 'no dialog titled "' + label + '" and no window.open within 15s' };
      // Give the viewer time to render its toolbar
      let ont = null;
      for (let i = 0; i < 20 && !ont; i++) {
        ont = [...dlg.querySelectorAll('button')].find((x) => /^Open in new tab/.test(x.innerText.trim()));
        if (!ont) {
          if (i >= 6 && ![...dlg.querySelectorAll('button')].some((x) => /^Download/.test(x.innerText.trim()))) break; // a text note
          await sleep(500);
        }
      }
      if (!ont) {
        const text = dlg.innerText.replace(/\n?Close\s*$/, '').trim();
        const links = [...new Set([...dlg.querySelectorAll('a[href]')].map((a) => a.href).concat(text.match(/https?:\/\/[^\s)]+/g) || []))];
        return { kind: 'note', text, links };
      }
      opened = null;
      ont.click();
      for (let i = 0; i < 40 && !opened; i++) await sleep(250);
      if (!opened) return { kind: 'error', err: 'Open in new tab gave no URL' };
      const p = new URL(opened).pathname;
      const res = { kind: 'file', material: p.split('/').slice(-2).join('/'), ext: (p.match(/\.([a-z0-9]+)$/i) || [])[1] || '' };
      // Download mode (used by sync): fetch bytes only for materials not already archived.
      // The signed URL expires in minutes, so fetch immediately. Bytes stay in page memory
      // (window.__mesaBlobs) until the caller uploads them through presigned URLs.
      if (CAP.opts.download && !(CAP.opts.knownMaterials || []).includes(res.material)) {
        const r = await fetch(opened);
        if (!r.ok) return { ...res, kind: 'error', err: 'fetch ' + r.status };
        const blob = await r.blob();
        const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map((x) => x.toString(16).padStart(2, '0')).join('');
        window.__mesaBlobs = window.__mesaBlobs || {};
        window.__mesaBlobs[res.material] = blob;
        Object.assign(res, { downloaded: true, size: blob.size, type: blob.type, sha256: sha });
      }
      return res;
    } finally {
      window.open = ow;
      await closeDialogs();
    }
  }

  async function walk(course, path, depth, out, st) {
    const n = itemButtons().length;
    for (let i = 0; i < n; i++) {
      const btn = itemButtons()[i];
      if (!btn) break;
      const label = btn.getAttribute('aria-label').replace(/^Open /, '');
      const same = itemButtons().slice(0, i).filter((b) => b.getAttribute('aria-label') === btn.getAttribute('aria-label')).length;
      let card = btn; for (let k = 0; k < 4 && card.parentElement && card.parentElement.innerText.length < 200; k++) card = card.parentElement;
      const r = await captureItem(btn, label);
      out.push({ path, label, dup_index: same, card: norm(card.innerText).slice(0, 160), ...r });
      st.items++; if (r.kind === 'error') st.errors++;
      localStorage.setItem('mesa_cap_status', JSON.stringify(st));
      await sleep(250);
    }
    if (depth > 2) return;
    const nf = folders().length;
    for (let i = 0; i < nf; i++) {
      const f = folders()[i];
      if (!f) break;
      const lines = f.innerText.split('\n').map((s) => s.trim()).filter(Boolean);
      const fname = slug(lines[0] || 'folder' + i);
      const leaf = [...f.querySelectorAll('*')].find((e) => e.children.length === 0 && (e.textContent || '').trim());
      (leaf || f).click();
      await sleep(1300);
      out.push({ path: path + '/' + fname, kind: 'folder', label: lines[0], date: lines[1] || null });
      await walk(course, path + '/' + fname, depth + 1, out, st);
      await back();
    }
  }

  window.mesaCapture = async function (courses, opts = {}) {
    CAP.opts = opts;
    const st ={ running: true, started: new Date().toISOString(), course: null, done: [], items: 0, errors: 0 };
    localStorage.setItem('mesa_cap_status', JSON.stringify(st));
    for (const c of courses) {
      st.course = c.prefix; localStorage.setItem('mesa_cap_status', JSON.stringify(st));
      const out = [];
      try {
        await window.next.router.push('/student/lms/courses/' + c.id);
        let anchor = null;
        for (let i = 0; i < 40 && !anchor; i++) {
          await sleep(250);
          anchor = [...document.querySelectorAll('button')].find((x) => /^(Overview|Resources|Outlines|Class Recordings)$/.test(x.innerText.trim()));
        }
        if (!anchor) throw new Error('course tabs not found');
        const strip = anchor.parentElement;
        const tabs = [...strip.children].filter((e) => e.tagName === 'BUTTON').map((e) => e.innerText.trim()).filter(Boolean);
        for (const t of tabs) {
          if (SKIP_TABS.test(t) || (opts.onlyTab && t !== opts.onlyTab)) continue;
          const b = [...strip.children].find((e) => e.tagName === 'BUTTON' && e.innerText.trim() === t);
          if (!b) continue;
          b.click(); await sleep(1300);
          out.push({ path: c.prefix + '/' + slug(t), kind: 'tab', label: t });
          await walk(c, c.prefix + '/' + slug(t), 0, out, st);
        }
      } catch (e) { out.push({ kind: 'error', path: c.prefix, err: String(e.message || e) }); st.errors++; }
      localStorage.setItem('mesa_cap_' + c.id, JSON.stringify({ id: c.id, prefix: c.prefix, captured: new Date().toISOString(), items: out }));
      st.done.push(c.prefix);
    }
    st.running = false; st.finished = new Date().toISOString();
    localStorage.setItem('mesa_cap_status', JSON.stringify(st));
  };
})();
