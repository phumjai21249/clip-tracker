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

function tokenOk(header, expectedHash) {
    const m = /^Bearer (\S{16,200})$/.exec(header || '');
    if (!m) return false;
    const got = crypto.createHash('sha256').update(m[1]).digest();
    const want = Buffer.from(expectedHash, 'hex');
    return want.length === got.length && crypto.timingSafeEqual(got, want);
}

function createHooks({ itemsRef, coversRef, staticFile, tokenSha256 = process.env.HOOKS_TOKEN_SHA256 || DEFAULT_TOKEN_SHA256, log = console }) {
    const items = new Map();
    const coverCache = new Map();
    let base = { meta: {}, clips: [] };
    let cached = null;
    let ready = false;

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

    return { start, routes, coverRoute, ingest, album, count: () => items.size };
}

module.exports = { createHooks, cleanEntry, mergeAlbum, tokenOk, toDoc, fromDoc };
