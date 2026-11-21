// node test/trends.test.js — no test runner in this repo; exits non-zero on failure.
const assert = require('assert');
const crypto = require('crypto');
const { createTrends, cleanTrend, cleanWeek } = require('../trends');

const item = (over = {}) => ({
    id: 'red-derby-nov', title: 'แดงเดือด ลิเวอร์พูล–แมนยู', cat: 'พรีเมียร์ลีก', heat: 'upcoming',
    why: 'แมตช์ที่คนไทยดูมากที่สุดของฤดูกาล', angles: ['ทายผลแดงเดือดใต้คลิป'],
    when: 'อา. 30 พ.ย. 23:30', date: '2026-11-30', postBy: '2026-11-29',
    products: ['WINGZ MUGEN REBORN'], sources: [{ title: 'ตารางแข่ง', url: 'https://example.com/fixtures' }],
    ...over,
});

function mockRef() {
    const docs = {};
    let listener = null;
    const snap = () => ({ forEach: fn => Object.entries(docs).sort((a, b) => (a[0] < b[0] ? 1 : -1)).forEach(([id, d]) => fn({ id, data: () => d })) });
    return {
        docs,
        orderBy() { return this; },
        limit() { return this; },
        onSnapshot(fn) { listener = fn; fn(snap()); },
        doc(id) { return { async set(d) { docs[id] = JSON.parse(JSON.stringify(d)); listener && listener(snap()); } }; },
    };
}

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok', name); };

(async () => {
    await t('cleanTrend keeps known fields and drops unknown ones', () => {
        const c = cleanTrend(item({ evil: '<script>' }));
        assert.strictEqual(typeof c, 'object');
        assert.strictEqual(c.evil, undefined);
        assert.deepStrictEqual(c.products, ['WINGZ MUGEN REBORN']);
    });
    await t('cleanTrend rejects bad fields', () => {
        assert.match(cleanTrend(item({ id: 'Bad Id' })), /bad id/);
        assert.match(cleanTrend(item({ heat: 'warm' })), /heat/);
        assert.match(cleanTrend(item({ angles: [] })), /angles/);
        assert.match(cleanTrend(item({ date: '30/11' })), /date/);
        assert.match(cleanTrend(item({ sources: [{ title: 'x', url: 'javascript:alert(1)' }] })), /source/);
        assert.match(cleanTrend(item({ sources: [{ title: 'x', url: 'http://plain.example' }] })), /source/);
    });
    await t('cleanWeek needs a week, 1–30 items and unique ids', () => {
        assert.match(cleanWeek({ week: '2026-11-27', items: [] }), /items/);
        assert.match(cleanWeek({ week: 'now', items: [item()] }), /week/);
        assert.match(cleanWeek({ week: '2026-11-27', items: [item(), item()] }), /duplicate/);
        assert.strictEqual(cleanWeek({ week: '2026-11-27', items: [item()] }).items.length, 1);
    });
    await t('ingest stores a week, a re-push replaces it, json lists newest first', async () => {
        const ref = mockRef();
        const tr = createTrends({ ref, tokenSha256: 'x', log: { error() {} } });
        tr.start();
        assert.deepStrictEqual(await tr.ingest({ week: '2026-11-20', items: [item()] }), { ok: true, week: '2026-11-20', items: 1 });
        await tr.ingest({ week: '2026-11-27', summary: 's', items: [item(), item({ id: 'seven-color' })] });
        await tr.ingest({ week: '2026-11-27', items: [item({ id: 'only-one' })] });
        const j = JSON.parse(tr.json());
        assert.deepStrictEqual(j.weeks.map(w => w.week), ['2026-11-27', '2026-11-20']);
        assert.deepStrictEqual(j.weeks[0].items.map(i => i.id), ['only-one']);
        assert.strictEqual((await tr.ingest({ week: '2026-11-27', items: [item({ heat: 'x' })] })).ok, false);
        assert.deepStrictEqual(JSON.parse(tr.json()).weeks[0].items.map(i => i.id), ['only-one']);
    });
    await t('push route refuses a wrong token', async () => {
        const tok = 'a'.repeat(64), hash = crypto.createHash('sha256').update(tok).digest('hex');
        const routes = {};
        const app = { get(p, h) { routes['GET ' + p] = h; }, post(p, mw, h) { routes['POST ' + p] = h; } };
        createTrends({ ref: mockRef(), tokenSha256: hash, log: { error() {} } }).routes(app, { json: () => null });
        const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
        await routes['POST /api/trends']({ get: () => 'Bearer ' + 'b'.repeat(64), body: {} }, res);
        assert.strictEqual(res.code, 401);
        const ok = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
        await routes['POST /api/trends']({ get: () => 'Bearer ' + tok, body: { week: '2026-11-27', items: [item()] } }, ok);
        assert.strictEqual(ok.code, 200);
    });
    console.log(`\n${n} passed`);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
