// Hook album ("คลังฮุกร้านเรา") entries pushed in once a week by the KPI check
// (tools/push_hooks.py). The shipped public/hook-album.json is the historical
// base; pushed entries live one Firestore doc per clip and are merged over it,
// so a page reload shows new clips without a deploy. Pushed covers live in a
// second collection and are served at the same /hook-covers/<id>.jpg path the
// static covers use.
//
// Reads: one snapshot of the entries per server boot, then nothing per page
// load (the merged album is cached). A pushed cover costs one read the first
// time it is requested after a boot.

const fs = require('fs');
const crypto = require('crypto');

const ID = /^\d{15,25}$/;
const CHANNELS = new Set(['JS', 'ME']);
const FUNNELS = new Set(['TOFU', 'MOFU', 'BOFU']);
const SEGMENTS = new Set(['A', 'B', 'C', 'D']);
const PILLARS = new Set(['p1', 'p2', 'p3', 'p4', 'p5']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ENTRY_BYTES = 8 * 1024;
const MAX_COVER_B64 = 80 * 1024;
const MAX_BATCH = 200;
// Fields a watched clip got by hand in the shipped album; a push never overwrites them.
const REVIEW_FIELDS = ['format', 'funnel', 'segment', 'caption', 'note', 'hook', 'trick', 'reviewed'];
// SHA-256 of the push token. The token itself stays on the machine that runs
// the KPI check; HOOKS_TOKEN_SHA256 on the server overrides this.
const DEFAULT_TOKEN_SHA256 = '84b751a230fe4b43f4d68c3d311f2b9bbe4b7ce52cf5d471b10ded06b847a085';

const isNum = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const isStr = (v, max) => typeof v === 'string' && v.length <= max;

// Returns the cleaned entry, or a string saying what is wrong.
function cleanEntry(x) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return 'not an object';
    if (typeof x.id !== 'string' || !ID.test(x.id)) return 'bad id';
    if (!CHANNELS.has(x.ch)) return `${x.id}: bad ch`;
    if (!DATE.test(x.date || '')) return `${x.id}: bad date`;
    if (!isNum(x.views, 0, 1e10) || !isNum(x.dur, 0, 3600)) return `${x.id}: bad views/dur`;
    for (const k of ['c1', 'c2', 'c3', 'c4']) if (!isNum(x[k], 0, 5)) return `${x.id}: bad ${k}`;
    if (!isStr(x.caption, 300) || !isStr(x.format, 60)) return `${x.id}: bad caption/format`;
    if (!FUNNELS.has(x.funnel) || !SEGMENTS.has(x.segment)) return `${x.id}: bad funnel/segment`;
    const out = {
        id: x.id, ch: x.ch, url: `https://www.tiktok.com/@${x.ch === 'JS' ? 'j.s.sport_shop' : 'mesport80'}/video/${x.id}`,
        date: x.date, views: Math.round(x.views), dur: x.dur,
        c1: x.c1, c2: x.c2, c3: x.c3, c4: x.c4,
        caption: x.caption, format: x.format, funnel: x.funnel, segment: x.segment,
    };
    if (x.pillar !== undefined) {
        if (!PILLARS.has(x.pillar)) return `${x.id}: bad pillar`;
        out.pillar = x.pillar;
    }
    if (x.ret !== undefined) {
        if (!Array.isArray(x.ret) || x.ret.length > 80 || !x.ret.every(p => Array.isArray(p) && p.length === 2 && isNum(p[0], 0, 3600) && isNum(p[1], 0, 100))) return `${x.id}: bad ret`;
        out.ret = x.ret.map(p => [p[0], p[1]]);
    }
    if (x.retFull !== undefined) out.retFull = !!x.retFull;
    if (x.eng !== undefined) {
        if (!Array.isArray(x.eng) || x.eng.length !== 3 || !x.eng.every(n => isNum(n, 0, 1e10))) return `${x.id}: bad eng`;
        out.eng = x.eng.map(Math.round);
    }
    if (Buffer.byteLength(JSON.stringify(out), 'utf8') > MAX_ENTRY_BYTES) return `${x.id}: too big`;
    return out;
}

// Firestore cannot hold nested arrays, so ret is stored as ["t:v", …].
const toDoc = e => (e.ret ? { ...e, ret: e.ret.map(p => `${p[0]}:${p[1]}`) } : { ...e });
const fromDoc = d => (Array.isArray(d.ret) ? { ...d, ret: d.ret.map(s => String(s).split(':').map(Number)) } : d);

// Pushed entries over the shipped album. Hand-watched fields of the shipped
// entry win; numbers from the push win (they are newer).
function mergeAlbum(base, pushed) {
    const byId = new Map();
    (base.clips || []).forEach(c => byId.set(c.id, c));
    let latest = '';
    for (const p of pushed) {
        const old = byId.get(p.id);
        const { pushedAt, hasCover, ...fields } = p;
        const merged = { ...(old || {}), ...fields, cover: !!((old && old.cover) || hasCover) };
        if (old && old.reviewed) REVIEW_FIELDS.forEach(k => { if (old[k] !== undefined) merged[k] = old[k]; });
        byId.set(p.id, merged);
        if (pushedAt && pushedAt > latest) latest = pushedAt;
    }
    const clips = [...byId.values()].sort((a, b) => b.c1 - a.c1);
    const meta = { ...(base.meta || {}), count: clips.length, reviewed: clips.filter(c => c.reviewed).length };
    if (latest) {
        // shown to the team as a Thai calendar date (UTC+7), not the UTC one
        meta.pushed = new Date(Date.parse(latest) + 7 * 3600e3).toISOString().slice(0, 10);
        meta.source = 'TikTok Studio (กราฟคนดูต่อรายคลิป) · อัปเดตอัตโนมัติทุกรอบเช็ค KPI รายสัปดาห์';
    }
    return { meta, clips };
}

// ---- Competitor clips ("คลิปคู่แข่ง") ----
// Other shops' public clips, watched logged out and broken down by hand. The
// shipped public/competitor-hooks.json is the base; clips pushed later live one
// Firestore doc each and are added to it. A push only ever adds a clip or
// updates the one with the same id: nothing already in the album is removed.
const SEEN = new Set(['full', 'frames', 'transcript']);
const COMP_TEXT = ['opening', 'said', 'trick', 'adapt', 'flow', 'speech'];
const COMP_COUNTS = ['views', 'likes', 'comments', 'shares', 'saves'];
const OWN_HANDLES = new Set(['j.s.sport_shop', 'mesport80']);
const MAX_COMP_BYTES = 16 * 1024;

// Returns the cleaned competitor entry, or a string saying what is wrong.
function cleanCompetitor(x) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return 'not an object';
    if (typeof x.id !== 'string' || !ID.test(x.id)) return 'bad id';
    if (!isStr(x.shop, 80) || !x.shop.trim()) return `${x.id}: bad shop`;
    const m = /^https:\/\/www\.tiktok\.com\/@([\w.]{1,40})\/video\/(\d{15,25})$/.exec(x.url || '');
    if (!m || m[2] !== x.id) return `${x.id}: bad url`;
    if (OWN_HANDLES.has(m[1].toLowerCase())) return `${x.id}: own clip, push it to /api/hooks`;
    if (!DATE.test(x.date || '')) return `${x.id}: bad date`;
    if (!isNum(x.dur, 0, 3600)) return `${x.id}: bad dur`;
    for (const k of COMP_COUNTS) if (!isNum(x[k], 0, 1e10)) return `${x.id}: bad ${k}`;
    if (!SEEN.has(x.seen)) return `${x.id}: bad seen`;
    if (!isStr(x.caption, 300) || !x.caption.trim()) return `${x.id}: bad caption`;
    for (const k of ['hook', 'format']) if (!isStr(x[k], 60) || !x[k].trim()) return `${x.id}: bad ${k}`;
    const out = { id: x.id, shop: x.shop.trim(), url: x.url, date: x.date, dur: x.dur };
    COMP_COUNTS.forEach(k => { out[k] = Math.round(x[k]); });
    Object.assign(out, { seen: x.seen, caption: x.caption, hook: x.hook, format: x.format });
    if (x.pillar !== undefined) {
        if (!PILLARS.has(x.pillar)) return `${x.id}: bad pillar`;
        out.pillar = x.pillar;
    }
    // A field left out stays out, so pushing a clip again without it keeps what the album already has.
    for (const k of COMP_TEXT) {
        if (x[k] === undefined) continue;
        if (!isStr(x[k], 1500)) return `${x.id}: bad ${k}`;
        out[k] = x[k];
    }
    if (!(out.trick || '').trim() || !(out.adapt || '').trim()) return `${x.id}: trick and adapt are required`;
    if (x.ad !== undefined) out.ad = !!x.ad;
    if (Buffer.byteLength(JSON.stringify(out), 'utf8') > MAX_COMP_BYTES) return `${x.id}: too big`;
    return out;
}

// Pushed competitor clips added to the shipped ones. Shipped clips keep their
// order, new ones follow in the order they were pushed; a clip pushed again
// replaces only itself.
function mergeCompetitor(base, pushed) {
    const byId = new Map();
    (base.clips || []).forEach(c => byId.set(c.id, c));
    let latest = '';
    for (const p of pushed.slice().sort((a, b) => String(a.pushedAt || '').localeCompare(String(b.pushedAt || '')) || String(a.id).localeCompare(String(b.id)))) {
        const { pushedAt, ...fields } = p;
        byId.set(p.id, { ...(byId.get(p.id) || {}), ...fields });
        if (pushedAt && pushedAt > latest) latest = pushedAt;
    }
    const clips = [...byId.values()];
    const meta = { ...(base.meta || {}), count: clips.length, ads: clips.filter(c => c.ad).length };
    if (latest) meta.added = new Date(Date.parse(latest) + 7 * 3600e3).toISOString().slice(0, 10);
    return { meta, clips };
}

function tokenOk(header, expectedHash) {
    const m = /^Bearer (\S{16,200})$/.exec(header || '');
    if (!m) return false;
    const got = crypto.createHash('sha256').update(m[1]).digest();
    const want = Buffer.from(expectedHash, 'hex');
    return want.length === got.length && crypto.timingSafeEqual(got, want);
}

// compRef / compStaticFile are optional: without them the competitor routes are not mounted.
function createHooks({ itemsRef, coversRef, staticFile, compRef, compStaticFile, tokenSha256 = process.env.HOOKS_TOKEN_SHA256 || DEFAULT_TOKEN_SHA256, log = console }) {
    const items = new Map();
    const coverCache = new Map();
    let base = { meta: {}, clips: [] };
    let cached = null;
    let ready = false;
    const compItems = new Map();
    let compBase = { meta: {}, clips: [] };
    let compCached = null;
    let compReady = false;

    function loadBase() {
        try { base = JSON.parse(fs.readFileSync(staticFile, 'utf8')); } catch (e) { log.error('hook album base unreadable:', e.message); }
        cached = null;
    }

    function start() {
        loadBase();
        itemsRef.onSnapshot(snap => {
            items.clear();
            snap.forEach(d => items.set(d.id, fromDoc(d.data())));
            cached = null;
            ready = true;
        }, err => log.error('hooks snapshot error:', err && err.message));
        if (!compRef) return;
        try { compBase = JSON.parse(fs.readFileSync(compStaticFile, 'utf8')); } catch (e) { log.error('competitor clips base unreadable:', e.message); }
        compRef.onSnapshot(snap => {
            compItems.clear();
            snap.forEach(d => compItems.set(d.id, d.data()));
            compCached = null;
            compReady = true;
        }, err => log.error('competitor clips snapshot error:', err && err.message));
    }

    function competitorAlbum() {
        if (!compCached) compCached = JSON.stringify(mergeCompetitor(compBase, [...compItems.values()]));
        return compCached;
    }

    // Adds the clips (or updates the ones with the same id). Never deletes.
    async function ingestCompetitor(body) {
        const list = body && body.clips;
        if (!Array.isArray(list) || !list.length) return { ok: false, error: 'no clips' };
        if (list.length > MAX_BATCH) return { ok: false, error: `max ${MAX_BATCH} clips per push` };
        const clean = [];
        for (const x of list) {
            const c = cleanCompetitor(x);
            if (typeof c === 'string') return { ok: false, error: c };
            clean.push(c);
        }
        const known = new Set((compBase.clips || []).map(c => c.id));
        const added = clean.filter(c => !known.has(c.id) && !compItems.has(c.id)).length;
        const now = new Date().toISOString();
        for (const c of clean) {
            const prev = compItems.get(c.id);
            await compRef.doc(c.id).set({ ...(prev || {}), ...c, pushedAt: (prev && prev.pushedAt) || now });
        }
        return { ok: true, clips: clean.length, added, updated: clean.length - added };
    }

    function album() {
        if (!cached) cached = JSON.stringify(mergeAlbum(base, [...items.values()]));
        return cached;
    }

    async function ingest(body) {
        const list = body && body.clips;
        const covers = (body && body.covers) || {};
        if (!Array.isArray(list) || !list.length) return { ok: false, error: 'no clips' };
        if (list.length > MAX_BATCH) return { ok: false, error: `max ${MAX_BATCH} clips per push` };
        const clean = [];
        for (const x of list) {
            const c = cleanEntry(x);
            if (typeof c === 'string') return { ok: false, error: c };
            clean.push(c);
        }
        for (const [id, b64] of Object.entries(covers)) {
            if (!ID.test(id) || typeof b64 !== 'string' || b64.length > MAX_COVER_B64 || !/^[A-Za-z0-9+/=]+$/.test(b64)) return { ok: false, error: `bad cover ${id}` };
        }
        const now = new Date().toISOString();
        let coversWritten = 0;
        for (const [id, b64] of Object.entries(covers)) {
            await coversRef.doc(id).set({ jpg: b64, at: now });
            coverCache.set(id, Buffer.from(b64, 'base64'));
            coversWritten++;
        }
        for (const c of clean) {
            const prev = items.get(c.id);
            const hasCover = !!(covers[c.id] || (prev && prev.hasCover));
            await itemsRef.doc(c.id).set(toDoc({ ...c, hasCover, pushedAt: now }));
        }
        return { ok: true, clips: clean.length, covers: coversWritten };
    }

    function routes(app, express) {
        // Must be mounted before express.static so the merged album wins over the shipped file.
        app.get('/hook-album.json', (req, res) => {
            res.set('Cache-Control', 'no-cache');
            res.type('application/json').send(album());
        });
        app.post('/api/hooks', express.json({ limit: '12mb' }), async (req, res) => {
            if (!tokenOk(req.get('authorization'), tokenSha256)) return res.status(401).json({ ok: false, error: 'unauthorized' });
            if (!ready) return res.status(503).json({ ok: false, error: 'not ready, retry shortly' });
            try {
                const r = await ingest(req.body);
                res.status(r.ok ? 200 : 400).json(r);
            } catch (e) {
                log.error('hooks ingest failed:', e);
                res.status(500).json({ ok: false, error: String(e && e.message || e), code: (e && e.code) || null });
            }
        });
        if (!compRef) return;
        // Also before express.static, for the same reason.
        app.get('/competitor-hooks.json', (req, res) => {
            res.set('Cache-Control', 'no-cache');
            res.type('application/json').send(competitorAlbum());
        });
        app.post('/api/competitor-hooks', express.json({ limit: '2mb' }), async (req, res) => {
            if (!tokenOk(req.get('authorization'), tokenSha256)) return res.status(401).json({ ok: false, error: 'unauthorized' });
            if (!compReady) return res.status(503).json({ ok: false, error: 'not ready, retry shortly' });
            try {
                const r = await ingestCompetitor(req.body);
                res.status(r.ok ? 200 : 400).json(r);
            } catch (e) {
                log.error('competitor clips ingest failed:', e);
                res.status(500).json({ ok: false, error: String(e && e.message || e), code: (e && e.code) || null });
            }
        });
    }

    // Mount after express.static: a cover shipped in public/hook-covers is served
    // by static first; only pushed covers reach this.
    function coverRoute(app) {
        app.get('/hook-covers/:file', async (req, res, next) => {
            const m = /^(\d{15,25})\.jpg$/.exec(req.params.file);
            if (!m) return next();
            const id = m[1];
            try {
                let buf = coverCache.get(id);
                if (!buf) {
                    const d = await coversRef.doc(id).get();
                    if (!d.exists) return next();
                    buf = Buffer.from(d.data().jpg, 'base64');
                    coverCache.set(id, buf);
                }
                res.set('Cache-Control', 'public, max-age=604800');
                res.type('image/jpeg').send(buf);
            } catch (e) { next(); }
        });
    }

    return { start, routes, coverRoute, ingest, album, count: () => items.size, ingestCompetitor, competitorAlbum, competitorCount: () => compItems.size };
}

module.exports = { createHooks, cleanEntry, mergeAlbum, cleanCompetitor, mergeCompetitor, tokenOk, toDoc, fromDoc };
