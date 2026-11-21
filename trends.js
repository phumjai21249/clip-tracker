// Sports trends ("เทรนด์กีฬา") — what is happening in sport right now that the
// team can make clips about. Pushed in once a week by a scheduled task
// (tools/push_trends.py), one Firestore doc per week keyed by the date of that
// week's Friday. A push replaces its week whole, so re-running a week is safe.
//
// Reads: one snapshot of the latest weeks per server boot, then nothing per
// page load (the JSON is cached).

const { tokenOk } = require('./hooks');

const WEEK = /^\d{4}-\d{2}-\d{2}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,59}$/;
const HEAT = new Set(['hot', 'rising', 'upcoming']);
const KEEP_WEEKS = 12;
const MAX_ITEMS = 30;
const MAX_WEEK_BYTES = 200 * 1024;
const DEFAULT_TOKEN_SHA256 = '84b751a230fe4b43f4d68c3d311f2b9bbe4b7ce52cf5d471b10ded06b847a085';

const isStr = (v, max) => typeof v === 'string' && v.length <= max;
const strList = (v, maxN, maxLen) => Array.isArray(v) && v.length <= maxN && v.every(s => isStr(s, maxLen) && s.trim() !== '');

// Returns the cleaned item, or a string saying what is wrong.
function cleanTrend(x) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return 'not an object';
    if (typeof x.id !== 'string' || !SLUG.test(x.id)) return 'bad id';
    const at = x.id + ': ';
    if (!isStr(x.title, 120) || !x.title.trim()) return at + 'bad title';
    if (!isStr(x.cat, 40) || !x.cat.trim()) return at + 'bad cat';
    if (!HEAT.has(x.heat)) return at + 'bad heat';
    if (!isStr(x.why, 600) || !x.why.trim()) return at + 'bad why';
    if (!strList(x.angles, 6, 240) || !x.angles.length) return at + 'bad angles';
    const out = { id: x.id, title: x.title.trim(), cat: x.cat.trim(), heat: x.heat, why: x.why.trim(), angles: x.angles.map(s => s.trim()) };
    if (x.when !== undefined) { if (!isStr(x.when, 60)) return at + 'bad when'; out.when = x.when.trim(); }
    for (const k of ['date', 'postBy']) {
        if (x[k] !== undefined) { if (!WEEK.test(x[k])) return at + 'bad ' + k; out[k] = x[k]; }
    }
    if (x.products !== undefined) { if (!strList(x.products, 6, 80)) return at + 'bad products'; out.products = x.products.map(s => s.trim()); }
    if (x.sources !== undefined) {
        if (!Array.isArray(x.sources) || x.sources.length > 6) return at + 'bad sources';
        out.sources = [];
        for (const s of x.sources) {
            if (!s || !isStr(s.title, 120) || !isStr(s.url, 500) || !/^https:\/\/[^\s"'<>]+$/.test(s.url)) return at + 'bad source';
            out.sources.push({ title: s.title.trim() || s.url, url: s.url });
        }
    }
    return out;
}

// Returns the cleaned week, or a string saying what is wrong.
function cleanWeek(body) {
    if (!body || typeof body !== 'object') return 'no body';
    if (!WEEK.test(body.week || '')) return 'bad week';
    if (body.summary !== undefined && !isStr(body.summary, 600)) return 'bad summary';
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > MAX_ITEMS) return `items must be 1–${MAX_ITEMS}`;
    const items = [], seen = new Set();
    for (const raw of body.items) {
        const c = cleanTrend(raw);
        if (typeof c === 'string') return c;
        if (seen.has(c.id)) return c.id + ': duplicate id';
        seen.add(c.id);
        items.push(c);
    }
    const week = { week: body.week, summary: (body.summary || '').trim(), items };
    if (Buffer.byteLength(JSON.stringify(week), 'utf8') > MAX_WEEK_BYTES) return 'week too big';
    return week;
}

function createTrends({ ref, tokenSha256 = process.env.HOOKS_TOKEN_SHA256 || DEFAULT_TOKEN_SHA256, log = console }) {
    const weeks = new Map();   // week -> doc
    let ready = false;
    let cached = null;

    function json() {
        if (!cached) {
            const list = [...weeks.values()].sort((a, b) => (a.week < b.week ? 1 : -1)).slice(0, KEEP_WEEKS);
            cached = JSON.stringify({ ready, weeks: list });
        }
        return cached;
    }

    function start() {
        ref.orderBy('week', 'desc').limit(KEEP_WEEKS).onSnapshot(snap => {
            weeks.clear();
            snap.forEach(d => weeks.set(d.id, d.data()));
            ready = true;
            cached = null;
        }, err => log.error('trends listener error:', err.message));
    }

    async function ingest(body) {
        const w = cleanWeek(body);
        if (typeof w === 'string') return { ok: false, error: w };
        const doc = { ...w, pushedAt: new Date().toISOString() };
        await ref.doc(w.week).set(doc);
        weeks.set(w.week, doc);
        cached = null;
        return { ok: true, week: w.week, items: w.items.length };
    }

    function routes(app, express) {
        app.get('/trends.json', (req, res) => {
            res.set('Cache-Control', 'no-cache');
            res.type('application/json').send(json());
        });
        app.post('/api/trends', express.json({ limit: '1mb' }), async (req, res) => {
            if (!tokenOk(req.get('authorization'), tokenSha256)) return res.status(401).json({ ok: false, error: 'unauthorized' });
            try {
                const r = await ingest(req.body);
                res.status(r.ok ? 200 : 400).json(r);
            } catch (e) {
                log.error('trends ingest failed:', e.message);
                res.status(500).json({ ok: false, error: 'save failed' });
            }
        });
    }

    return { start, routes, ingest, json, count: () => weeks.size };
}

module.exports = { createTrends, cleanTrend, cleanWeek };
