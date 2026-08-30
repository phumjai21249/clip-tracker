# Clip Tracker Backlog: Attribution, Month Scoping, Notifications — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make it visible who last touched each clip, stop the 306-row table from dumping every clip at once, and push a Discord message when a clip's status changes or a clip is due today and unfinished.

**Architecture:** Three independent slices on the existing single-file client (`public/index.html`) plus `server.js`. Attribution adds two fields to the clip document and a one-time "who are you" prompt stored per browser. Month scoping is a pure client-side view filter over the already-cached clip list — no new server work. Notifications are server-side only: the existing `clip:save` handler and a once-a-day due-check fire an outbound Discord webhook, with the URL supplied as an environment variable exactly like `FIREBASE_SERVICE_ACCOUNT` is today.

**Tech Stack:** Node 24 + Express 4 + Socket.IO 4 + firebase-admin 13 (server), vanilla ES2020 in one HTML file (client), Firestore for persistence, Discord incoming webhooks for notifications. No build step, no framework, no bundler.

## Global Constraints

- **No new npm dependencies.** Use Node's global `fetch` (available on Node 24) for the Discord call. `package.json` dependencies stay exactly: `dotenv`, `express`, `firebase-admin`, `isomorphic-git`, `socket.io`.
- **A connection must cost zero Firestore reads.** All init data is served from the in-memory caches (`clipsCache`, `teamCache`, `coverCache`, `kpiCache`) maintained by `onSnapshot` listeners. Never add a Firestore read to the `io.on('connection')` path or to `GET /cover/:id`. This is the defect that took the board down on 2026-08-26.
- **Never write a whole collection in one payload.** Clip writes go one clip at a time (`clip:save`), KPI writes one field at a time (`kpi:set`). Any new write follows the same rule.
- **Cover semantics are load-bearing.** On `clip:save`, `coverImage` absent = leave the stored cover alone, `''` = delete it, a string = replace it. A task that reshapes the clip payload must preserve this.
- **UI text is Thai.** New user-facing strings are Thai; code, comments, and commit messages are English.
- **Design tokens only.** Colors, radii, and shadows come from the CSS custom properties in `:root` / `[data-theme="dark"]`. Every new color ships a light and a dark value. See `DESIGN.md`.
- **The repo has no test runner.** Server-side logic is tested with standalone Node scripts under `test/` run as `node test/<name>.js`, following the existing pattern of an in-memory Firestore mock (no credentials, no network, no production data). Client behavior is verified in a browser against a locally served `public/`.
- **Deploy is via git push to `main`.** Render auto-deploys. The local folder holds only `public/`; the full repo (with `server.js`) is `github.com/phumjai21249/clip-tracker`.

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `test/helpers/mock-firestore.js` | Reusable in-memory Firestore double (collections, docs, queries, batches, `onSnapshot`). Extracted from the existing throwaway scripts so all three slices share one. | 1 |
| `test/attribution.test.js` | Asserts `updatedBy` / `updatedAt` are stamped on write and survive edits. | 2 |
| `test/notify.test.js` | Asserts the Discord message builder and the send/skip decision, with `fetch` stubbed. | 6, 7 |
| `server.js` | Stamps attribution, owns `notifyDiscord()` and the daily due-check. | 2, 6, 7 |
| `public/index.html` | Identity prompt, attribution column, month scoping. | 3, 4, 5 |
| `README.md` | Documents the `DISCORD_WEBHOOK_URL` environment variable. | 6 |

Tasks 1–2 are server + test scaffolding. Tasks 3–4 are attribution's client half. Task 5 is month scoping and is fully independent — it can be built and shipped alone. Tasks 6–7 are notifications and depend only on Task 1.

---

### Task 1: Shared Firestore test double

**Files:**
- Create: `test/helpers/mock-firestore.js`
- Create: `test/README.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `makeMockDb()` returning an object with `collection(path)`, `batch()`, and `FieldValue`-free semantics. Collections support `.doc(id)`, `.get()`, `.select()`, `.orderBy(field, dir)`, `.limit(n)`, `.onSnapshot(onNext, onError)`. Doc refs support `.get()`, `.set(data, opts)` (honouring `{merge:true}`), `.delete()`, `.collection(sub)`. Snapshots expose `.docs` (array of `{id, data()}`), `.size`, `.empty`, `.forEach(fn)`.

- [ ] **Step 1: Write the failing test**

Create `test/helpers/mock-firestore.test.js`:

```js
const { makeMockDb } = require('./mock-firestore');

let pass = 0, fail = 0;
const ok = (c, m) => c ? pass++ : (fail++, console.error('FAIL:', m));

async function main() {
  const db = makeMockDb();
  const col = db.collection('things');

  await col.doc('a').set({ n: 1, keep: 'yes' });
  await col.doc('b').set({ n: 2 });
  ok((await col.doc('a').get()).exists, 'doc written is readable');
  ok((await col.get()).size === 2, 'collection reports its size');

  await col.doc('a').set({ n: 9 }, { merge: true });
  const merged = (await col.doc('a').get()).data();
  ok(merged.n === 9 && merged.keep === 'yes', 'merge:true keeps untouched fields');

  await col.doc('a').set({ n: 9 });
  ok((await col.doc('a').get()).data().keep === undefined, 'set without merge replaces');

  const desc = await col.orderBy('n', 'desc').get();
  ok(desc.docs.map(d => d.id).join(',') === 'a,b', 'orderBy desc sorts');

  const ids = await col.select().get();
  let threw = false;
  try { ids.docs[0].data(); } catch (e) { threw = true; }
  ok(threw, 'select() projection refuses field access');

  let seen = 0;
  col.onSnapshot(s => { seen = s.size; });
  await col.doc('c').set({ n: 3 });
  await new Promise(r => setTimeout(r, 0));
  ok(seen === 3, 'onSnapshot fires on write');

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/helpers/mock-firestore.test.js`
Expected: FAIL — `Cannot find module './mock-firestore'`

- [ ] **Step 3: Write minimal implementation**

Create `test/helpers/mock-firestore.js`:

```js
// In-memory stand-in for the Firestore Node SDK surface this project uses.
// No credentials, no network, no production data.
function clone(x) { return x === undefined ? x : JSON.parse(JSON.stringify(x)); }

function makeMockDb() {
  const store = new Map();          // path -> Map<id, data>
  const watchers = new Map();       // path -> [fn]
  const col = p => { if (!store.has(p)) store.set(p, new Map()); return store.get(p); };

  function notify(path) {
    (watchers.get(path) || []).forEach(fn => fn(snap([...col(path).entries()])));
  }

  function snap(entries, { idOnly = false } = {}) {
    const docs = entries.map(([id, data]) => ({
      id,
      data: () => {
        if (idOnly) throw new Error('select() projection: field data not fetched');
        return clone(data);
      },
    }));
    return { docs, size: docs.length, empty: docs.length === 0, forEach: fn => docs.forEach(fn) };
  }

  function docRef(path, id) {
    return {
      id,
      async get() {
        const c = col(path);
        return { exists: c.has(id), id, data: () => clone(c.get(id)) };
      },
      async set(data, opts) {
        const c = col(path);
        c.set(id, opts && opts.merge
          ? Object.assign({}, c.get(id) || {}, clone(data))
          : clone(data));
        notify(path);
      },
      async delete() { col(path).delete(id); notify(path); },
      collection(sub) { return collectionRef(`${path}/${id}/${sub}`); },
    };
  }

  function collectionRef(path) {
    return {
      doc: id => docRef(path, id),
      async get() { return snap([...col(path).entries()]); },
      select(...fields) {
        if (fields.length) throw new Error('mock models only the id-only projection');
        return { async get() { return snap([...col(path).entries()], { idOnly: true }); } };
      },
      limit(n) { return { async get() { return snap([...col(path).entries()].slice(0, n)); } }; },
      orderBy(field, dir = 'asc') {
        return { async get() {
          const e = [...col(path).entries()].sort((a, b) =>
            dir === 'desc' ? b[1][field] - a[1][field] : a[1][field] - b[1][field]);
          return snap(e);
        } };
      },
      onSnapshot(onNext) {
        if (!watchers.has(path)) watchers.set(path, []);
        watchers.get(path).push(onNext);
        onNext(snap([...col(path).entries()]));
        return () => {};
      },
    };
  }

  return { collection: collectionRef, batch() {
    const ops = [];
    return {
      set(ref, d, o) { ops.push(['set', ref, d, o]); },
      delete(ref) { ops.push(['del', ref]); },
      async commit() { for (const [t, r, d, o] of ops) t === 'set' ? await r.set(d, o) : await r.delete(); },
    };
  } };
}

module.exports = { makeMockDb };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/helpers/mock-firestore.test.js`
Expected: `7 passed, 0 failed`

- [ ] **Step 5: Document how to run the suite**

Create `test/README.md`:

```markdown
# Tests

Standalone Node scripts — no runner, no dependencies, no credentials. Each file
exercises server logic against `helpers/mock-firestore.js`, an in-memory double,
so tests never touch the live Firestore or the production board.

Run one:

    node test/attribution.test.js

Run all:

    for f in test/*.test.js; do node "$f" || exit 1; done

Client behaviour is not covered here — verify it in a browser against a locally
served `public/`.
```

- [ ] **Step 6: Commit**

```bash
git add test/helpers/mock-firestore.js test/helpers/mock-firestore.test.js test/README.md
git commit -m "test: add a shared in-memory Firestore double

The cover-offload and clip-sync checks each carried their own copy of a
Firestore stand-in. One shared double, with its own test, so the slices
landing next can assert against the same semantics."
```

---

### Task 2: Stamp who changed a clip, and when

**Files:**
- Modify: `server.js` — `upsertClip()` and the `clip:save` handler
- Create: `test/attribution.test.js`

**Interfaces:**
- Consumes: `makeMockDb()` from Task 1.
- Produces: every clip document gains `updatedBy` (string, ≤40 chars) and `updatedAt` (number, epoch ms). `upsertClip(clip)` keeps its existing return shape `{coverChanged, hasCover?, coverVersion?}`. The `clip:saved` broadcast carries `updatedBy` and `updatedAt`.

- [ ] **Step 1: Write the failing test**

Create `test/attribution.test.js`:

```js
const { makeMockDb } = require('./helpers/mock-firestore');

const db = makeMockDb();
const clipsItemsRef = db.collection('clipTracker').doc('clips').collection('items');

let lastSeq = 0;
function nextSeq() { lastSeq = Math.max(Date.now(), lastSeq + 1); return lastSeq; }

// Mirror of server.js upsertClip — keep in sync.
async function upsertClip(clip) {
  const { coverImage, hasCover, id, updatedBy, ...rest } = clip;
  if (!id) return { coverChanged: false };
  const ref = clipsItemsRef.doc(id);
  const existing = await ref.get();
  const prev = existing.exists ? existing.data() : null;
  const seq = prev && typeof prev._seq === 'number' ? prev._seq : nextSeq();
  const doc = { ...rest, _seq: seq };
  doc.updatedBy = (typeof updatedBy === 'string' && updatedBy.trim())
    ? updatedBy.trim().slice(0, 40)
    : (prev && prev.updatedBy) || '';
  doc.updatedAt = Date.now();
  if (coverImage === undefined) {
    if (prev && prev.coverVersion) doc.coverVersion = prev.coverVersion;
    if (prev && prev.hasCover) doc.hasCover = true;
    await ref.set(doc);
    return { coverChanged: false, updatedBy: doc.updatedBy, updatedAt: doc.updatedAt };
  }
  if (coverImage) {
    doc.hasCover = true;
    doc.coverVersion = nextSeq();
    await ref.set(doc);
    return { coverChanged: true, hasCover: true, coverVersion: doc.coverVersion, updatedBy: doc.updatedBy, updatedAt: doc.updatedAt };
  }
  doc.hasCover = false;
  await ref.set(doc);
  return { coverChanged: true, hasCover: false, coverVersion: null, updatedBy: doc.updatedBy, updatedAt: doc.updatedAt };
}

let pass = 0, fail = 0;
const ok = (c, m) => c ? pass++ : (fail++, console.error('FAIL:', m));

async function main() {
  await upsertClip({ id: 'c1', title: 'first', updatedBy: 'อาย' });
  let d = (await clipsItemsRef.doc('c1').get()).data();
  ok(d.updatedBy === 'อาย', 'records who made the change');
  ok(typeof d.updatedAt === 'number' && d.updatedAt > 0, 'records when');
  ok(d._seq !== undefined, 'the existing ordering key is untouched');

  const firstStamp = d.updatedAt;
  await new Promise(r => setTimeout(r, 3));
  await upsertClip({ id: 'c1', title: 'second', updatedBy: 'เจม' });
  d = (await clipsItemsRef.doc('c1').get()).data();
  ok(d.updatedBy === 'เจม', 'a later editor replaces the earlier one');
  ok(d.updatedAt > firstStamp, 'the timestamp moves forward');

  // A client that has not identified itself must not erase the last known editor.
  await upsertClip({ id: 'c1', title: 'third' });
  d = (await clipsItemsRef.doc('c1').get()).data();
  ok(d.updatedBy === 'เจม', 'an anonymous save keeps the previous editor');

  await upsertClip({ id: 'c2', title: 'long', updatedBy: 'x'.repeat(200) });
  d = (await clipsItemsRef.doc('c2').get()).data();
  ok(d.updatedBy.length === 40, 'a long name is truncated');

  await upsertClip({ id: 'c3', title: 'blank', updatedBy: '   ' });
  d = (await clipsItemsRef.doc('c3').get()).data();
  ok(d.updatedBy === '', 'a blank name stores empty, not whitespace');

  // The attribution change must not disturb cover semantics.
  await upsertClip({ id: 'c4', title: 'cover', coverImage: 'data:image/jpeg;base64,AAA', updatedBy: 'อาย' });
  await upsertClip({ id: 'c4', title: 'cover renamed', updatedBy: 'เจม' });
  d = (await clipsItemsRef.doc('c4').get()).data();
  ok(d.hasCover === true, 'a plain edit still keeps the cover');

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main();
```

- [ ] **Step 2: Prove the assertions bite, then prove `server.js` lacks the behaviour**

The test carries a mirror of `upsertClip` because requiring `server.js` would
initialise Firebase and open listeners. A mirror can drift, so this step checks
both halves.

First, prove the assertions are real by breaking the mirror on purpose —
temporarily change `doc.updatedBy = ...` in the test to `doc.updatedBy = '';`:

Run: `node test/attribution.test.js`
Expected: FAIL — `records who made the change`

Restore the line, then confirm the real server does **not** yet stamp:

Run: `grep -c "updatedBy" server.js`
Expected: `0`

- [ ] **Step 3: Write minimal implementation**

In `server.js`, replace the opening of `upsertClip` (currently `const { coverImage, hasCover, id, ...rest } = clip;` through `const doc = { ...rest, _seq: seq };`) with:

```js
async function upsertClip(clip) {
    const { coverImage, hasCover, id, updatedBy, ...rest } = clip;
    if (!id) return { coverChanged: false };
    const ref = clipsItemsRef.doc(id);
    const existing = await ref.get();
    const prev = existing.exists ? existing.data() : null;
    // Keep the clip's original position stable across edits; only brand-new
    // clips get a fresh (always-highest) _seq so they sort to the front.
    const seq = prev && typeof prev._seq === 'number' ? prev._seq : nextSeq();
    const doc = { ...rest, _seq: seq };
    // A client that has not said who it is must not erase the last known
    // editor — an unattributed save is missing information, not a correction.
    doc.updatedBy = (typeof updatedBy === 'string' && updatedBy.trim())
        ? updatedBy.trim().slice(0, 40)
        : (prev && prev.updatedBy) || '';
    doc.updatedAt = Date.now();
```

Then add `updatedBy: doc.updatedBy, updatedAt: doc.updatedAt` to each of the three `return` objects in that function.

In the `clip:save` handler, after the existing `if (r && r.coverChanged) { ... }` block, add:

```js
            if (r) { rest.updatedBy = r.updatedBy; rest.updatedAt = r.updatedAt; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/attribution.test.js`
Expected: `9 passed, 0 failed`

Confirm the server compiles and now carries the same logic the mirror asserts:

Run: `node -c server.js && grep -c "doc.updatedBy" server.js`
Expected: no syntax output, then `1`

- [ ] **Step 5: Commit**

```bash
git add server.js test/attribution.test.js
git commit -m "feat: record who last changed each clip and when

Every clip document now carries updatedBy and updatedAt, stamped server
side so a client cannot backdate or spoof the time. A save that arrives
without a name keeps the previous editor rather than blanking it, since
an unattributed save is missing information rather than a correction."
```

---

### Task 3: Ask the browser who is using it

**Files:**
- Modify: `public/index.html` — add the identity modal markup after the team modal (`</div>` closing `#teamModalOverlay`, currently near line 1820), add CSS beside `.team-input-row`, add the state and functions beside `saveTeamNames()` (currently near line 2056)

**Interfaces:**
- Consumes: `CREATORS`, `UPLOADER`, `applyTeamData()`, `showToast()`, `escHtml()` — all already defined in `public/index.html`.
- Produces: global `currentUserName` (string, `''` when unknown), `openWhoAmI()`, `setWhoAmI(name)`. Task 4 reads `currentUserName`; Task 4 also calls `openWhoAmI()` from a header button.

- [ ] **Step 1: Add the identity modal markup**

In `public/index.html`, immediately after the closing `</div>` of `#teamModalOverlay`, insert:

```html
    <!-- WHO AM I -->
    <div class="modal-overlay" id="whoAmIOverlay">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="whoAmITitle">
            <div class="modal-header">
                <h3>
                    <span class="material-icons-round">badge</span>
                    <span id="whoAmITitle">คุณคือใคร?</span>
                </h3>
                <button class="modal-close" onclick="closeWhoAmI()" aria-label="ปิด">
                    <span class="material-icons-round">close</span>
                </button>
            </div>
            <div class="modal-body">
                <p class="whoami-note">เลือกชื่อตัวเอง เพื่อให้ทีมเห็นว่าใครแก้คลิปไหนล่าสุด — จำไว้ในเครื่องนี้ เปลี่ยนได้ทีหลัง</p>
                <div class="whoami-list" id="whoAmIList"></div>
            </div>
        </div>
    </div>
```

- [ ] **Step 2: Add the styles**

In the `<style>` block, immediately after the `.team-input-row .form-input { flex: 1; }` rule, insert:

```css
        .whoami-note { font-size: 0.8rem; line-height: 1.6; color: var(--text-2); margin-bottom: 14px; }
        .whoami-list { display: flex; flex-direction: column; gap: 8px; }
        .whoami-option {
            display: flex; align-items: center; gap: 12px;
            padding: 12px 14px; width: 100%; cursor: pointer; outline: none;
            background: var(--surface); border: 1px solid var(--border);
            border-radius: var(--radius-md); font-family: inherit; text-align: left;
            transition: border-color var(--t-fast), background var(--t-fast);
        }
        .whoami-option:hover { border-color: var(--brand); background: var(--brand-soft); }
        .whoami-option:focus-visible { box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--brand); }
        .whoami-option.current { border-color: var(--brand); box-shadow: 0 0 0 1px var(--brand); }
        .whoami-option-name { font-size: 0.9rem; font-weight: 700; color: var(--text); }
        .whoami-option-role { font-size: 0.72rem; color: var(--text-2); }
```

- [ ] **Step 3: Add the state and functions**

Immediately after the `closeTeamModal()` function definition, insert:

```javascript
        // ============ WHO AM I ============
        // Not authentication — anyone can pick any name. It exists so the board
        // can show who last touched a clip, which is the actual question the
        // team has. Remembered per browser.
        const WHOAMI_STORE = 'clipTracker.whoami';
        let currentUserName = '';
        try { currentUserName = localStorage.getItem(WHOAMI_STORE) || ''; } catch (e) {}

        function renderWhoAmI() {
            const people = [...CREATORS, UPLOADER];
            document.getElementById('whoAmIList').innerHTML = people.map(p => `
                <button type="button" class="whoami-option ${p.name === currentUserName ? 'current' : ''}"
                        onclick="setWhoAmI('${escAttr(p.name)}')">
                    <span class="avatar ${p.avatarClass}">${escHtml(p.initials)}</span>
                    <span>
                        <span class="whoami-option-name">${escHtml(p.name)}</span><br>
                        <span class="whoami-option-role">${escHtml(p.role)}</span>
                    </span>
                </button>`).join('');
        }
        function openWhoAmI() {
            renderWhoAmI();
            document.getElementById('whoAmIOverlay').classList.add('open');
        }
        function closeWhoAmI() { document.getElementById('whoAmIOverlay').classList.remove('open'); }
        function setWhoAmI(name) {
            currentUserName = name;
            try { localStorage.setItem(WHOAMI_STORE, name); } catch (e) {}
            closeWhoAmI();
            renderTeamBar();
            showToast('สวัสดี ' + name, 'success');
        }
```

- [ ] **Step 4: Prompt once on first use, and close on overlay click**

In the `init()` IIFE at the bottom of the main `<script>`, immediately after `render();`, insert:

```javascript
            if (!currentUserName) setTimeout(openWhoAmI, 800);
```

And beside the other overlay click handlers (near `document.getElementById('teamModalOverlay').addEventListener(...)`), insert:

```javascript
        document.getElementById('whoAmIOverlay').addEventListener('click', e => {
            if (e.target === document.getElementById('whoAmIOverlay')) closeWhoAmI();
        });
```

Extend the existing Escape handler so it reads:

```javascript
            if (e.key === 'Escape') { closeModal(); closeTeamModal(); closeDayView(); closeDeleteModal(); closeWhoAmI(); }
```

- [ ] **Step 5: Verify in a browser**

```bash
cd public && python -m http.server 5644
```

Open `http://localhost:5644`, then in the console:

```js
localStorage.removeItem('clipTracker.whoami'); location.reload();
```

Expected: the "คุณคือใคร?" modal appears on its own after ~0.8s, lists four people with their avatars, and clicking one closes it and toasts "สวัสดี …". Reload again: the modal does **not** reappear, and `currentUserName` is the chosen name.

- [ ] **Step 6: Commit**

```bash
git add public/index.html
git commit -m "feat: let a browser say who is using it

A one-time picker, remembered per browser, so the board can attribute
edits. Deliberately not authentication — anyone can pick any name; the
question the team actually has is who last touched a clip, not who is
allowed to."
```

---

### Task 4: Show who last edited each clip

**Files:**
- Modify: `public/index.html` — `syncClipSave()`, `renderTable()` desktop row and mobile card, the table header, styles, and the header actions

**Interfaces:**
- Consumes: `currentUserName` from Task 3; `updatedBy` / `updatedAt` on each clip from Task 2.
- Produces: `relativeTime(ms)` returning a Thai relative string; an "แก้ล่าสุด" column in the desktop table and a line in the mobile card.

- [ ] **Step 1: Send the current user with every clip save**

Replace `syncClipSave` (currently `function syncClipSave(clip) { if (socket) socket.emit('clip:save', clip); }`) with:

```javascript
        function syncClipSave(clip) {
            if (socket) socket.emit('clip:save', Object.assign({}, clip, { updatedBy: currentUserName }));
        }
```

- [ ] **Step 2: Add the relative-time helper**

Immediately after the `formatDate` function, insert:

```javascript
        function relativeTime(ms) {
            if (!ms) return '';
            const diff = Date.now() - ms;
            if (diff < 60000) return 'เมื่อสักครู่';
            const mins = Math.floor(diff / 60000);
            if (mins < 60) return mins + ' นาทีก่อน';
            const hours = Math.floor(mins / 60);
            if (hours < 24) return hours + ' ชม.ก่อน';
            const days = Math.floor(hours / 24);
            if (days < 7) return days + ' วันก่อน';
            return formatDate(new Date(ms).toISOString().slice(0, 10));
        }
        function editedByHtml(clip) {
            if (!clip.updatedBy && !clip.updatedAt) return '<span class="edited-none">—</span>';
            return `<span class="edited-cell">
                        <span class="edited-who">${escHtml(clip.updatedBy || 'ไม่ระบุ')}</span>
                        <span class="edited-when num">${escHtml(relativeTime(clip.updatedAt))}</span>
                    </span>`;
        }
```

- [ ] **Step 3: Add the styles**

After the `.date-cell` rule in the `<style>` block, insert:

```css
        .edited-cell { display: flex; flex-direction: column; gap: 1px; white-space: nowrap; }
        .edited-who { font-size: 0.78rem; font-weight: 700; color: var(--text-2); }
        .edited-when { font-size: 0.7rem; color: var(--text-3); }
        .edited-none { color: var(--text-3); }
```

- [ ] **Step 4: Add the column to the table**

In the `<thead>` of the clip table, insert a new `<th>` immediately after the `วันที่ลง` header:

```html
                            <th>แก้ล่าสุด</th>
```

In `renderTable()`'s desktop row template, insert a new cell immediately after `<td class="date-cell num">${formatDate(clip.date)}</td>`:

```javascript
                    <td>${editedByHtml(clip)}</td>
```

In the mobile card template, inside `.clip-card-footer`, immediately after the `.clip-card-person` div, insert:

```javascript
                        <div class="edited-when">${clip.updatedBy ? escHtml('แก้ล่าสุด: ' + clip.updatedBy + ' · ' + relativeTime(clip.updatedAt)) : ''}</div>
```

- [ ] **Step 5: Let people change their name later**

In the header actions, immediately before the `ตั้งค่าทีม` button, insert:

```html
                <button class="btn" id="btnWhoAmI" onclick="openWhoAmI()">
                    <span class="material-icons-round">badge</span>
                    ฉันคือใคร
                </button>
```

- [ ] **Step 6: Verify in a browser**

```bash
cd public && python -m http.server 5644
```

In the console:

```js
clips = [{ id:'t1', title:'ทดสอบ', desc:'', creator:'c1', status:'idle', channel:'JS SPORT SHOP',
           uploaded:false, date:'2026-08-31', hasCover:false, links:[],
           updatedBy:'อาย', updatedAt: Date.now() - 5*60*1000 }];
render();
document.querySelector('.edited-who').textContent + ' / ' + document.querySelector('.edited-when').textContent;
```

Expected: `อาย / 5 นาทีก่อน`. Then check a clip with no attribution renders `—` rather than `undefined`:

```js
clips[0].updatedBy = ''; clips[0].updatedAt = 0; render();
document.querySelector('#clipTableBody .edited-none') !== null;   // true
```

- [ ] **Step 7: Commit**

```bash
git add public/index.html
git commit -m "feat: show who last edited each clip

Adds an แก้ล่าสุด column to the table and a line to the mobile card,
and sends the current browser's chosen name with every save. Clips
edited before this shipped show — rather than a fabricated name."
```

---

### Task 5: Scope the list to one month

**Files:**
- Modify: `public/index.html` — state near `let currentFilter`, `getFilteredClips()`, `filterCount()`, the table toolbar markup, styles, and `render()`

**Interfaces:**
- Consumes: `clips`, `renderTable()`, `renderStats()`, `renderFilters()` — all existing.
- Produces: `clipMonthScope` (string, `'YYYY-MM'` or `'all'`), `setMonthScope(value)`, `renderMonthScope()`. `getFilteredClips()` and `filterCount()` both narrow by the scope so the counts on the pills and stat cards agree with the rows on screen.

- [ ] **Step 1: Add the state and the scope helpers**

Immediately after `let currentFilter = 'all';`, insert:

```javascript
        // With 300+ clips, rendering every row on load is slow and useless —
        // nobody scrolls to March. Default to the current month; 'all' is the
        // deliberate escape hatch.
        let clipMonthScope = (() => {
            const now = new Date();
            return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
        })();
```

- [ ] **Step 2: Narrow the filter and the counts**

Replace `getFilteredClips()` with:

```javascript
        function inMonthScope(clip) {
            return clipMonthScope === 'all' || (clip.date || '').slice(0, 7) === clipMonthScope;
        }

        function getFilteredClips() {
            let list = clips.filter(inMonthScope);
            if (currentFilter === 'uploaded') list = list.filter(c => c.uploaded);
            else if (currentFilter !== 'all') list = list.filter(c => c.status === currentFilter);
            if (searchQuery) {
                const q = searchQuery.toLowerCase();
                list = list.filter(c => {
                    const creator = CREATORS.find(cr => cr.id === c.creator);
                    return (c.title || '').toLowerCase().includes(q)
                        || (c.desc || '').toLowerCase().includes(q)
                        || (c.channel || '').toLowerCase().includes(q)
                        || (creator ? creator.name.toLowerCase().includes(q) : false);
                });
            }
            return list;
        }
```

Replace `filterCount()` with:

```javascript
        function filterCount(key) {
            const scoped = clips.filter(inMonthScope);
            if (key === 'all') return scoped.length;
            if (key === 'uploaded') return scoped.filter(c => c.uploaded).length;
            return scoped.filter(c => c.status === key).length;
        }
```

- [ ] **Step 3: Add the picker markup**

In the table section's `.table-toolbar`, immediately before the `.search-box` div, insert:

```html
                    <select class="form-select month-scope" id="monthScope" onchange="setMonthScope(this.value)" aria-label="เลือกเดือน"></select>
```

- [ ] **Step 4: Add the styles**

After the `.filter-pill` rules, insert:

```css
        .month-scope {
            width: auto; min-width: 150px; padding: 8px 12px;
            font-size: 0.8rem; font-weight: 700;
        }
```

- [ ] **Step 5: Render and wire the picker**

Immediately after `renderFilters()`, insert:

```javascript
        function renderMonthScope() {
            const months = [...new Set(clips.map(c => (c.date || '').slice(0, 7)).filter(Boolean))].sort().reverse();
            // The current month is always offered, even before anything is
            // planned in it, so a fresh month is never unreachable.
            const now = new Date();
            const nowKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
            if (months.indexOf(nowKey) < 0) months.unshift(nowKey);
            if (clipMonthScope !== 'all' && months.indexOf(clipMonthScope) < 0) months.unshift(clipMonthScope);
            const label = key => {
                const [y, m] = key.split('-').map(Number);
                return THAI_MONTHS[m - 1] + ' ' + (y + 543);
            };
            const opts = months.map(k =>
                `<option value="${k}" ${k === clipMonthScope ? 'selected' : ''}>${label(k)} (${clips.filter(c => (c.date || '').slice(0, 7) === k).length})</option>`);
            opts.push(`<option value="all" ${clipMonthScope === 'all' ? 'selected' : ''}>ทุกเดือน (${clips.length})</option>`);
            document.getElementById('monthScope').innerHTML = opts.join('');
        }

        function setMonthScope(value) {
            clipMonthScope = value;
            renderStats(); renderFilters(); renderTable(); renderMonthScope();
        }
```

Add `renderMonthScope();` to `render()`, immediately after `renderFilters();`.

- [ ] **Step 6: Verify in a browser**

```bash
cd public && python -m http.server 5644
```

In the console:

```js
clips = [
  { id:'a', title:'เดือนนี้', creator:'c1', status:'idle', channel:'JS SPORT SHOP', uploaded:false, date:'2026-08-05', links:[] },
  { id:'b', title:'เดือนนี้ 2', creator:'c1', status:'done', channel:'JS SPORT SHOP', uploaded:true, date:'2026-08-20', links:[] },
  { id:'c', title:'เดือนก่อน', creator:'c1', status:'idle', channel:'Me SPORT', uploaded:false, date:'2026-07-10', links:[] }
];
render();
JSON.stringify({
  rows: document.querySelectorAll('#clipTableBody tr').length,
  options: [...document.getElementById('monthScope').options].map(o => o.value)
});
```

Expected: `rows` is 2 (only August), and `options` contains `2026-08`, `2026-07`, and `all`.

Then:

```js
setMonthScope('all');
document.querySelectorAll('#clipTableBody tr').length;      // 3
setMonthScope('2026-07');
document.querySelectorAll('#clipTableBody tr').length;      // 1
document.querySelector('.filter-pill .pill-count').textContent;  // "1" — counts follow the scope
```

- [ ] **Step 7: Commit**

```bash
git add public/index.html
git commit -m "feat: scope the clip list to one month at a time

The table rendered all 300+ clips on every load, which is slow and shows
nobody what they came for. It now defaults to the current month, with a
picker listing every month that has clips and a ทุกเดือน escape. The
filter pills and stat cards count within the scope so the numbers on
screen match the rows on screen."
```

---

### Task 6: Post a Discord message when a clip's status changes

**Files:**
- Modify: `server.js` — new notification section before `// ============ COVER IMAGES ============`, and the `clip:save` handler
- Modify: `README.md`
- Create: `test/notify.test.js`

**Interfaces:**
- Consumes: `clipsCache` and `teamCache` (already in `server.js`); `makeMockDb()` is not needed here.
- Produces: `buildStatusMessage(prev, next)` returning a string or `null` (both arguments are clip objects; `prev` is `null` for a new clip); `notifyDiscord(content)` returning a promise that resolves to `true` when sent and `false` when skipped or failed; the module-level constants `DISCORD_WEBHOOK_URL` and `STATUS_LABELS`. Task 7 reuses `notifyDiscord` and `STATUS_LABELS`.

- [ ] **Step 1: Write the failing test**

Create `test/notify.test.js`:

```js
// Mirror of server.js buildStatusMessage — keep in sync.
const STATUS_LABELS = {
  idle: 'ยังไม่ทำ', filming: 'กำลังถ่ายทำ', editing: 'กำลังตัด', done: 'อัปลงไดร์ฟแล้ว',
};

function buildStatusMessage(prev, next) {
  if (!prev || !next) return null;
  const bits = [];
  if (prev.status !== next.status) {
    bits.push(`\`${STATUS_LABELS[prev.status] || prev.status}\` → **${STATUS_LABELS[next.status] || next.status}**`);
  }
  if (!prev.uploaded && next.uploaded) bits.push('**อัปลง TikTok แล้ว** ✅');
  if (!bits.length) return null;
  const who = next.updatedBy ? ` · โดย ${next.updatedBy}` : '';
  return `🎬 **${next.title || 'ไม่มีชื่อ'}**\n${bits.join(' · ')}${who}`;
}

let pass = 0, fail = 0;
const ok = (c, m) => c ? pass++ : (fail++, console.error('FAIL:', m));

const base = { title: 'คลิปทดสอบ', status: 'idle', uploaded: false, updatedBy: 'อาย' };

// Only real transitions are worth a message.
ok(buildStatusMessage(base, { ...base, title: 'ชื่อใหม่' }) === null, 'renaming a clip sends nothing');
ok(buildStatusMessage(base, { ...base }) === null, 'an unchanged save sends nothing');
ok(buildStatusMessage(null, base) === null, 'a brand-new clip sends nothing');

const m1 = buildStatusMessage(base, { ...base, status: 'editing' });
ok(m1 && m1.includes('กำลังตัด'), 'a status change names the new status');
ok(m1.includes('ยังไม่ทำ'), 'a status change names the old status');
ok(m1.includes('อาย'), 'a status change names the editor');
ok(m1.includes('คลิปทดสอบ'), 'a status change names the clip');

const m2 = buildStatusMessage(base, { ...base, uploaded: true });
ok(m2 && m2.includes('TikTok'), 'flipping the upload toggle sends a message');
ok(buildStatusMessage({ ...base, uploaded: true }, { ...base, uploaded: false }) === null,
   'un-flipping the upload toggle stays quiet');

const m3 = buildStatusMessage(base, { ...base, status: 'done', uploaded: true });
ok(m3.split('·').length >= 3, 'two changes in one save produce one message');

const m4 = buildStatusMessage(base, { ...base, status: 'editing', updatedBy: '' });
ok(!m4.includes('โดย'), 'an unattributed change omits the editor');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Prove the assertions bite, then prove `server.js` lacks the behaviour**

Same mirror pattern as Task 2. Temporarily change the early return in the test's
`buildStatusMessage` from `if (!bits.length) return null;` to `if (false) return null;`:

Run: `node test/notify.test.js`
Expected: FAIL — `renaming a clip sends nothing`

Restore the line, then confirm the server has no notifier yet:

Run: `grep -c "notifyDiscord" server.js`
Expected: `0`

- [ ] **Step 3: Write the implementation**

In `server.js`, immediately before `// ============ COVER IMAGES ============`, insert:

```js
// ============ NOTIFICATIONS ============
// Outbound only, fire-and-forget: a webhook that is slow, rate-limited, or
// misconfigured must never delay or fail a clip save.
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const STATUS_LABELS = {
    idle: 'ยังไม่ทำ', filming: 'กำลังถ่ายทำ', editing: 'กำลังตัด', done: 'อัปลงไดร์ฟแล้ว',
};

function buildStatusMessage(prev, next) {
    if (!prev || !next) return null; // a brand-new clip is not a transition
    const bits = [];
    if (prev.status !== next.status) {
        bits.push(`\`${STATUS_LABELS[prev.status] || prev.status}\` → **${STATUS_LABELS[next.status] || next.status}**`);
    }
    if (!prev.uploaded && next.uploaded) bits.push('**อัปลง TikTok แล้ว** ✅');
    if (!bits.length) return null;
    const who = next.updatedBy ? ` · โดย ${next.updatedBy}` : '';
    return `🎬 **${next.title || 'ไม่มีชื่อ'}**\n${bits.join(' · ')}${who}`;
}

async function notifyDiscord(content) {
    if (!DISCORD_WEBHOOK_URL || !content) return false;
    try {
        const res = await fetch(DISCORD_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: content.slice(0, 1900) }), // Discord caps at 2000
        });
        if (!res.ok) { console.error('discord webhook rejected:', res.status); return false; }
        return true;
    } catch (e) {
        console.error('discord webhook failed:', e.message);
        return false;
    }
}
```

In the `clip:save` handler, capture the previous state **before** the write and notify after it. The handler becomes:

```js
    socket.on('clip:save', async (clip) => {
        try {
            const before = clipsCache.find(c => c.id === (clip && clip.id)) || null;
            const r = await upsertClip(clip);
            // Broadcast without the base64: other clients fetch the image from
            // /cover/:id like everyone else. hasCover is only included when the
            // cover actually changed, so receivers merge and keep their own
            // value otherwise.
            const { coverImage, ...rest } = clip;
            if (r && r.coverChanged) {
                rest.hasCover = r.hasCover;
                rest.coverVersion = r.coverVersion;
            }
            if (r) { rest.updatedBy = r.updatedBy; rest.updatedAt = r.updatedAt; }
            socket.broadcast.emit('clip:saved', rest);
            // Deliberately not awaited: the save is already durable.
            notifyDiscord(buildStatusMessage(before, rest));
        } catch (e) { console.error("Firebase save error (clip:save):", e); }
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/notify.test.js`
Expected: `10 passed, 0 failed`

Run: `node -c server.js`
Expected: no output

- [ ] **Step 5: Document the environment variable**

Append to `README.md`:

```markdown
## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | yes | Firestore service-account JSON. Falls back to `firebase-admin.json` locally. |
| `PORT` | no | Defaults to 3000; Render sets this. |
| `DISCORD_WEBHOOK_URL` | no | Discord incoming-webhook URL. When unset, notifications are silently skipped and everything else works normally. |

To create the webhook: Discord → Server Settings → Integrations → Webhooks →
New Webhook → pick the channel → Copy Webhook URL. Paste it into Render →
the service → Environment → Add Environment Variable.
```

- [ ] **Step 6: Commit**

```bash
git add server.js test/notify.test.js README.md
git commit -m "feat: post a Discord message when a clip's status changes

Fires on a real transition only — a status change or the TikTok toggle
going on — so renames and no-op saves stay quiet. The call is
fire-and-forget and the webhook URL is optional: with DISCORD_WEBHOOK_URL
unset the board behaves exactly as before."
```

---

### Task 7: Post a daily reminder for clips due today

**Files:**
- Modify: `server.js` — add the scheduler beside the notification section, start it in `initDB()`
- Modify: `test/notify.test.js` — extend with the due-list builder

**Interfaces:**
- Consumes: `notifyDiscord()` from Task 6, `clipsCache`.
- Produces: `buildDueMessage(clips, todayKey)` returning a string or `null`; `startDueCheck()` scheduling the check.

- [ ] **Step 1: Extend the test**

Append to `test/notify.test.js`, before the final `console.log`:

```js
// Mirror of server.js buildDueMessage — keep in sync.
function buildDueMessage(clips, todayKey) {
  const due = clips.filter(c => c.date === todayKey && c.status !== 'done' && !c.uploaded);
  if (!due.length) return null;
  const lines = due.slice(0, 15).map(c => `• ${c.title || 'ไม่มีชื่อ'} — ${STATUS_LABELS[c.status] || c.status}`);
  const more = due.length > 15 ? `\n…และอีก ${due.length - 15} คลิป` : '';
  return `⏰ **วันนี้มี ${due.length} คลิปที่ยังไม่เสร็จ**\n${lines.join('\n')}${more}`;
}

const today = '2026-08-31';
ok(buildDueMessage([], today) === null, 'no clips means no reminder');
ok(buildDueMessage([{ title: 'x', date: today, status: 'done', uploaded: false }], today) === null,
   'a finished clip is not chased');
ok(buildDueMessage([{ title: 'x', date: today, status: 'idle', uploaded: true }], today) === null,
   'an already-uploaded clip is not chased');
ok(buildDueMessage([{ title: 'x', date: '2026-08-30', status: 'idle', uploaded: false }], today) === null,
   'another day is not chased');

const due = buildDueMessage([
  { title: 'ก', date: today, status: 'idle', uploaded: false },
  { title: 'ข', date: today, status: 'editing', uploaded: false },
], today);
ok(due.includes('2 คลิป'), 'the reminder counts what is outstanding');
ok(due.includes('ก') && due.includes('ข'), 'the reminder names each clip');

const many = buildDueMessage(
  Array.from({ length: 20 }, (_, i) => ({ title: 'c' + i, date: today, status: 'idle', uploaded: false })),
  today);
ok(many.includes('และอีก 5 คลิป'), 'a long list is truncated with a count');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/notify.test.js`
Expected: FAIL — `buildDueMessage is not defined` until the block above is in place; once it is, the assertions describe behaviour `server.js` does not yet have.

- [ ] **Step 3: Write the implementation**

In `server.js`, immediately after `notifyDiscord`, insert:

```js
function buildDueMessage(clips, todayKey) {
    const due = clips.filter(c => c.date === todayKey && c.status !== 'done' && !c.uploaded);
    if (!due.length) return null;
    const lines = due.slice(0, 15).map(c => `• ${c.title || 'ไม่มีชื่อ'} — ${STATUS_LABELS[c.status] || c.status}`);
    const more = due.length > 15 ? `\n…และอีก ${due.length - 15} คลิป` : '';
    return `⏰ **วันนี้มี ${due.length} คลิปที่ยังไม่เสร็จ**\n${lines.join('\n')}${more}`;
}

// Render restarts this process freely, so "have we already sent today's
// reminder" is tracked in Firestore rather than in memory — otherwise a
// restart at the wrong moment would send it twice.
const notifyMetaRef = db.collection('clipTracker').doc('notifyMeta');

function bangkokDateKey(now = new Date()) {
    // The team works Thai hours; the server's clock is UTC.
    const t = new Date(now.getTime() + 7 * 3600 * 1000);
    return t.toISOString().slice(0, 10);
}

async function runDueCheck() {
    if (!DISCORD_WEBHOOK_URL) return;
    try {
        const todayKey = bangkokDateKey();
        const bangkokHour = new Date(Date.now() + 7 * 3600 * 1000).getUTCHours();
        if (bangkokHour < 10) return; // send from 10:00 Bangkok onwards
        const meta = await notifyMetaRef.get();
        if (meta.exists && meta.data().lastDueDate === todayKey) return;
        const msg = buildDueMessage(clipsCache, todayKey);
        await notifyMetaRef.set({ lastDueDate: todayKey }, { merge: true });
        if (msg) await notifyDiscord(msg);
    } catch (e) {
        console.error('due check failed:', e.message);
    }
}

function startDueCheck() {
    if (!DISCORD_WEBHOOK_URL) return;
    setTimeout(runDueCheck, 60000).unref?.();          // once the caches are warm
    setInterval(runDueCheck, 30 * 60 * 1000).unref?.(); // and every half hour after
}
```

In `initDB()`, immediately after `startKpiListener();`, insert:

```js
    startDueCheck();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/notify.test.js`
Expected: `17 passed, 0 failed`

Run: `node -c server.js`
Expected: no output

- [ ] **Step 5: Verify the whole suite still passes**

Run: `for f in test/*.test.js; do node "$f" || exit 1; done`
Expected: every file reports `0 failed`

- [ ] **Step 6: Commit**

```bash
git add server.js test/notify.test.js
git commit -m "feat: post a daily reminder for clips due today

Checks from 10:00 Bangkok onwards and names the clips dated today that
are neither done nor uploaded. Whether today's reminder has already gone
out is recorded in Firestore, not in memory, because Render restarts this
process freely and an in-memory flag would let a restart send it twice."
```

---

### Task 8: Ship it

**Files:**
- Modify: none (deploy and verify only)

- [ ] **Step 1: Run the full suite**

Run: `for f in test/*.test.js; do node "$f" || exit 1; done`
Expected: every file reports `0 failed`

- [ ] **Step 2: Check the design detector**

Run `/impeccable audit` from the `clip-tracker` directory (not the parent — from
the parent it picks up Invest Hub's `DESIGN.md` and every finding is spurious).

Expected: only `design-system-font-size` findings, which are known and documented
in `DESIGN.md` as an intentional working range. Any new finding in the `slop` or
`quality` categories must be fixed before shipping.

- [ ] **Step 3: Push**

```bash
git push origin main
```

- [ ] **Step 4: Wait for the deploy and confirm the caches are warm**

Run: `curl -s https://clip-tracker.onrender.com/__diag`
Expected: `cache.ready` true, `clips` at the expected count, `coversReady` true, `teamReady` true, `kpiReady` true.

- [ ] **Step 5: Verify in the live app**

Open `https://clip-tracker.onrender.com` and confirm:
- The "คุณคือใคร?" prompt appears on a browser that has never chosen a name.
- The table opens on the current month; the picker lists earlier months with counts; ทุกเดือน shows everything.
- Changing a clip's status updates the แก้ล่าสุด column with your name and "เมื่อสักครู่".
- If `DISCORD_WEBHOOK_URL` is set on Render, that status change posts to the Discord channel within a few seconds.

- [ ] **Step 6: Set the webhook (owner action)**

`DISCORD_WEBHOOK_URL` cannot be set from this repo. In Discord: Server Settings → Integrations → Webhooks → New Webhook → choose the channel → Copy Webhook URL. In Render: the service → Environment → Add Environment Variable → `DISCORD_WEBHOOK_URL` → paste → Save (the service restarts). Until this is done, Tasks 6 and 7 are inert by design and the rest of the app is unaffected.
