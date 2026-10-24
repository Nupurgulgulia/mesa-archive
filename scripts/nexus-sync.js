// Runs INSIDE a logged-in Nexus tab (students.mesaschool.co.in), injected by the scheduled sync session
// through the browser's javascript tool. Two phases, both fire-and-forget with progress in localStorage
// (the javascript tool has a 45 s limit):
//
//   window.mesaSync.snapshot({ putUrl })      -> drives Nexus's own pages and keeps a copy of the JSON data
//                                                 those pages receive; uploads one sanitised snapshot
//   window.mesaSync.fetchFiles({ items, resultsPutUrl })
//                                              -> for each NEW file material: opens it through the normal UI,
//                                                 takes the signed URL Nexus issues for exactly that material id,
//                                                 downloads it and PUTs it to its presigned bucket URL
//   JSON.parse(localStorage.mesa_sync_status)  -> progress
//
// Safety: never reads, stores or reuses login tokens or cookies. It only copies response BODIES of
// api-students.mesaschool.co.in/api/v1 calls that Nexus's own pages make. Removed before upload:
// the student's own profile record, other people's details (calendar attendee lists, announcement
// replies and likers, avatars), and the short-lived signed URLs.
// Upload targets are presigned PUT URLs created on this computer by `npm run sync -- prepare/plan`.
(function () {
  if (window.mesaSync) return;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const API = /^https:\/\/api-students\.mesaschool\.co\.in\/api\/v1\//;
  const data = (window.__mesaData = window.__mesaData || {});
  const signed = (window.__mesaSigned = window.__mesaSigned || {});

  // ---- keep copies of response bodies (no request headers are ever touched) ----
  if (!window.__mesaSyncHooked) {
    const orig = window.fetch.bind(window);
    window.fetch = async function (input, init) {
      const res = await orig(input, init);
      try {
        const url = typeof input === 'string' ? input : input.url;
        if (API.test(url) && res.ok) {
          const u = new URL(url);
          const m = u.pathname.match(/\/content\/materials\/([^/]+)\/signed-url$/);
          res.clone().json().then((j) => {
            if (m) signed[m[1]] = j?.data?.url || null; // used once for the download, never uploaded
            else data[u.pathname + u.search] = j;
          }).catch(() => {});
        }
      } catch {}
      return res;
    };
    window.__mesaSyncHooked = true;
  }

  const status = (s) => localStorage.setItem('mesa_sync_status', JSON.stringify({ ...s, at: new Date().toISOString() }));
  // Navigate, then wait until the page's own data request has arrived (or time out and say so).
  const has = (prefix) => Object.keys(data).some((k) => k.startsWith(prefix));
  const go = async (path, wait = 2500, expect = null) => {
    await window.next.router.push(path);
    await sleep(wait);
    for (let i = 0; expect && !has(expect) && i < 30; i++) await sleep(500);
    return !expect || has(expect);
  };
  const mainButtons = () => [...document.querySelectorAll('main button')];
  const tabStrip = () => {
    const a = [...document.querySelectorAll('button')].find((x) => /^(Overview|Resources|Outlines|Class Recordings|Pre-Reads)$/.test(x.innerText.trim()));
    return a ? a.parentElement : null;
  };
  const closeDialogs = async () => {
    for (const d of document.querySelectorAll('[role=dialog]')) {
      const c = [...d.querySelectorAll('button')].find((x) => x.innerText.trim() === 'Close' || x.getAttribute('aria-label') === 'Close');
      if (c) c.click();
    }
    for (let i = 0; i < 10 && document.querySelector('[role=dialog]'); i++) await sleep(200);
  };
  const latest = (prefix) => {
    const k = Object.keys(data).filter((x) => x.startsWith(prefix));
    return k.length ? data[k[k.length - 1]] : null;
  };

  function sanitise(responses) {
    const out = {};
    for (const [path, body] of Object.entries(responses)) {
      if (/\/student\/me|\/mcp-access\/|\/forms\/mine|signed-url/.test(path)) continue;
      const b = JSON.parse(JSON.stringify(body));
      const d = b?.data;
      for (const e of d?.events || []) { delete e.gcalAttendees; delete e.courseCoverUrl; }
      for (const a of d?.announcements || []) {
        a.repliesCount = (a.replies || []).length;
        delete a.replies; delete a.topLikers; delete a.authorAvatarUrl; delete a.isLikedByMe;
      }
      out[path] = b;
    }
    return out;
  }

  async function snapshot({ putUrl, calendarFrom = '2026-08', calendarMonthsAhead = 3, courseIds = null }) {
    const st = { phase: 'snapshot', running: true, step: 'start', courses: 0, coursesDone: 0, errors: [], missing: [] };
    status(st);
    // A hidden tab doesn't render Nexus pages, so their data never loads: refuse rather than produce a partial snapshot.
    if (document.visibilityState !== 'visible') {
      st.errors.push('The Nexus tab is not visible. Bring it to the front (tabs_select) and start again.');
      st.step = 'failed'; st.running = false; status(st); return;
    }
    try {
      st.step = 'home'; status(st); await go('/student/lms', 3000);
      st.step = 'notifications'; status(st); await go('/student/lms/notifications', 3000, '/api/v1/notifications');
      // notifications load as you scroll; scroll until no new pages arrive
      for (let i = 0, last = -1; i < 40; i++) {
        const n = Object.keys(data).filter((k) => k.includes('/notifications')).length;
        if (n === last && i > 2) break;
        last = n;
        const sc = [...document.querySelectorAll('main, main *')].filter((e) => e.scrollHeight > e.clientHeight + 40).sort((a, b) => b.scrollHeight - a.scrollHeight)[0] || document.scrollingElement;
        sc.scrollTop = sc.scrollHeight; window.scrollTo(0, document.body.scrollHeight);
        await sleep(1500);
      }
      st.step = 'assignments'; status(st); await go('/student/lms/assignments', 2000, '/api/v1/assignments/my');
      st.step = 'attendance'; status(st); await go('/student/lms/attendance', 2000, '/api/v1/attendance/student/sessions');
      st.step = 'mrs'; status(st); await go('/student/lms/mesa-readiness-score', 2000, '/api/v1/mrs/assessments');

      st.step = 'calendar'; status(st); await go('/student/lms/calendar', 2000, '/api/v1/events/my');
      const btn = (t) => mainButtons().find((b) => b.getAttribute('title') === t);
      const month = () => (([...document.querySelectorAll('main h1, main h2, main h3')].map((h) => h.innerText.trim()).find((t) => /^[A-Z][a-z]+ \d{4}$/.test(t))) || '');
      const ym = (s) => { const d = new Date('1 ' + s); return isNaN(d) ? null : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
      for (let i = 0; i < 18 && btn('Previous') && (ym(month()) || '9999') > calendarFrom; i++) { btn('Previous').click(); await sleep(1800); }
      for (let i = 0; i < 18 && btn('Next'); i++) {
        const cur = ym(month()); const now = new Date(); const limit = new Date(now.getFullYear(), now.getMonth() + calendarMonthsAhead, 1);
        if (cur && cur >= `${limit.getFullYear()}-${String(limit.getMonth() + 1).padStart(2, '0')}`) break;
        btn('Next').click(); await sleep(1800);
      }

      st.step = 'courses'; status(st);
      await go('/student/lms/courses', 2000, '/api/v1/curriculum/terms');
      const terms = latest('/api/v1/curriculum/terms')?.data?.terms || latest('/api/v1/curriculum/terms')?.data || [];
      for (const t of Array.isArray(terms) ? terms : []) { if (t?.id) await go(`/student/lms/courses?term=${t.id}`, 2500); }
      let courses = [];
      for (const [k, v] of Object.entries(data)) if (k.startsWith('/api/v1/curriculum/courses?')) courses.push(...(v?.data?.courses || []));
      courses = [...new Map(courses.map((c) => [c.id, c])).values()].filter((c) => !courseIds || courseIds.includes(c.id));
      st.courses = courses.length; status(st);

      for (const c of courses) {
        st.step = `course ${c.title}`; status(st);
        try {
          await go(`/student/lms/courses/${c.id}`, 2000, `/api/v1/curriculum/topics?courseId=${c.id}`);
          const strip = tabStrip();
          const tabs = strip ? [...strip.children].filter((e) => e.tagName === 'BUTTON').map((e) => e.innerText.trim()).filter(Boolean) : [];
          for (const t of tabs) {
            const b = [...(tabStrip()?.children || [])].find((e) => e.tagName === 'BUTTON' && e.innerText.trim() === t);
            if (b) { b.click(); await sleep(2200); }
          }
          // any topic whose materials did not load: click its tab once more
          const topics = data[`/api/v1/curriculum/topics?courseId=${c.id}`]?.data?.topics || [];
          for (const tp of topics) {
            const have = Object.keys(data).some((k) => k.startsWith(`/api/v1/content/topics/${tp.id}/`));
            if (!have) {
              const b = [...(tabStrip()?.children || [])].find((e) => e.tagName === 'BUTTON' && e.innerText.trim() === tp.title);
              if (b) { b.click(); await sleep(2500); }
            }
          }
        } catch (e) { st.errors.push(`${c.title}: ${e.message}`); }
        st.coursesDone++; status(st);
      }

      // Completeness check: every section the local apply step imports must be present.
      const required = ['/api/v1/assignments/my', '/api/v1/attendance/student/summary', '/api/v1/attendance/student/sessions',
        '/api/v1/mrs/assessments', '/api/v1/curriculum/terms', '/api/v1/notifications', '/api/v1/events/my'];
      st.missing = required.filter((p) => !has(p));
      for (const c of courses) if (!has(`/api/v1/curriculum/topics?courseId=${c.id}`)) st.missing.push(`course ${c.title}`);
      st.calendarWindows = Object.keys(data).filter((k) => k.startsWith('/api/v1/events/my')).length;

      st.step = 'upload'; status(st);
      const snap = { version: 1, capturedAt: new Date().toISOString(), origin: location.origin, missing: st.missing, responses: sanitise(data) };
      const body = JSON.stringify(snap);
      const r = await fetch(putUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
      if (!r.ok) throw new Error(`snapshot upload HTTP ${r.status}`);
      st.bytes = body.length; st.responses = Object.keys(snap.responses).length;
      st.step = 'done';
    } catch (e) { st.errors.push(String(e.message || e)); st.step = 'failed'; }
    st.running = false; status(st);
  }

  // items: [{ materialId, courseId, topicTitle, sessionName, title, putUrl, contentType }]
  async function fetchFiles({ items, resultsPutUrl }) {
    const st = { phase: 'fetch', running: true, total: items.length, done: 0, ok: 0, failed: 0, errors: [] };
    status(st);
    if (document.visibilityState !== 'visible') {
      st.errors.push('The Nexus tab is not visible. Bring it to the front (tabs_select) and start again.');
      st.running = false; status(st); return;
    }
    const results = [];
    const ow = window.open;
    for (const it of items) {
      const res = { materialId: it.materialId };
      try {
        // Wait for things to appear instead of sleeping fixed times: re-navigating to the page you're on
        // re-renders it, which can undo a click made too early.
        const waitFor = async (fn, ms = 10000) => { for (let t = 0; t < ms; t += 250) { const v = fn(); if (v) return v; await sleep(250); } return null; };
        const itemButtons = () => mainButtons().filter((b) => b.getAttribute('aria-label') === `Open ${it.title}`);
        const folderName = it.sessionName || 'Other files';
        const findFolder = () => [...document.querySelectorAll('main [class*="group/folder"]')].find((f) => f.innerText.split('\n')[0].trim() === folderName);
        await window.next.router.push(`/student/lms/courses/${it.courseId}`);
        await sleep(1500);
        let candidates = [];
        for (let attempt = 0; attempt < 2 && !candidates.length; attempt++) {
          const tab = await waitFor(() => [...(tabStrip()?.children || [])].find((e) => e.tagName === 'BUTTON' && e.innerText.trim() === it.topicTitle));
          if (!tab) throw new Error(`tab "${it.topicTitle}" not found`);
          tab.click();
          // the item is either inside a folder, or directly in the tab
          const ready = await waitFor(() => findFolder() || (itemButtons().length ? 'items' : null));
          const folder = ready && ready !== 'items' ? ready : null;
          if (folder) {
            const leaf = [...folder.querySelectorAll('*')].find((e) => e.children.length === 0 && (e.textContent || '').trim());
            (leaf || folder).click();
          }
          candidates = (await waitFor(() => (itemButtons().length ? itemButtons() : null))) || [];
        }
        // Try every item with this title until Nexus issues a signed URL for THIS material id.
        if (!candidates.length) throw new Error(`no item titled "${it.title}" in ${folderName}`);
        let url = null;
        for (const b of candidates) {
          delete signed[it.materialId];
          window.open = () => null; // "Open in new tab" must not open anything
          b.click();
          for (let i = 0; i < 40 && signed[it.materialId] === undefined; i++) await sleep(250);
          if (signed[it.materialId] === undefined) {
            // some viewers only ask for the URL when "Open in new tab" is pressed
            const dlg = document.querySelector('[role=dialog]');
            const ont = dlg && [...dlg.querySelectorAll('button')].find((x) => /^Open in new tab/.test(x.innerText.trim()));
            if (ont) { ont.click(); for (let i = 0; i < 20 && signed[it.materialId] === undefined; i++) await sleep(250); }
          }
          window.open = ow;
          await closeDialogs();
          if (signed[it.materialId]) { url = signed[it.materialId]; break; }
        }
        if (!url) throw new Error('Nexus did not issue a download link for this material id');
        const r = await fetch(url);
        if (!r.ok) throw new Error(`download HTTP ${r.status}`);
        const blob = await r.blob();
        const buf = await blob.arrayBuffer();
        const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((x) => x.toString(16).padStart(2, '0')).join('');
        const p = await fetch(it.putUrl, { method: 'PUT', headers: { 'Content-Type': it.contentType || 'application/octet-stream' }, body: blob });
        if (!p.ok) throw new Error(`upload HTTP ${p.status}`);
        Object.assign(res, { ok: true, size: blob.size, sha256: sha });
        st.ok++;
      } catch (e) {
        window.open = ow;
        Object.assign(res, { ok: false, error: String(e.message || e) });
        st.failed++; st.errors.push(`${it.title}: ${res.error}`);
        await closeDialogs().catch(() => {});
      }
      delete signed[it.materialId];
      results.push(res); st.done++; status(st);
    }
    try {
      const r = await fetch(resultsPutUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ finishedAt: new Date().toISOString(), results }) });
      if (!r.ok) st.errors.push(`results upload HTTP ${r.status}`);
    } catch (e) { st.errors.push('results upload: ' + e.message); }
    st.running = false; status(st);
  }

  window.mesaSync = { snapshot, fetchFiles };
})();
'mesaSync ready';
