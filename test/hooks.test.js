// node test/hooks.test.js — no test runner in this repo; exits non-zero on failure.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createHooks, cleanEntry, mergeAlbum, cleanCompetitor, mergeCompetitor, tokenOk, toDoc, fromDoc } = require('../hooks');

function mockCollection() {
    const docs = {};
    let listener = null;
    const notify = () => listener && listener({ forEach: fn => Object.entries(docs).forEach(([id, d]) => fn({ id, data: () => JSON.parse(JSON.stringify(d)) })) });
    return {
        docs,
        onSnapshot(fn) { listener = fn; notify(); },
        doc(id) {
            return {
                async set(d) {
                    // Firestore rejects nested arrays; so does this mock.
                    Object.values(d).forEach(v => { if (Array.isArray(v) && v.some(Array.isArray)) throw new Error('nested arrays not allowed'); });
                    docs[id] = JSON.parse(JSON.stringify(d)); notify();
                },
                async get() { return { exists: id in docs, data: () => docs[id] }; },
            };
        },
    };
}

const good = (over = {}) => ({
    id: '7703146302502112519', ch: 'JS', date: '2026-11-10', views: 12345, dur: 18,
    c1: 0.31, c2: 0.5, c3: 0.42, c4: 0.28, caption: 'Wingz Blaze', format: 'โชว์สินค้า / รุ่นใหม่',
    funnel: 'MOFU', segment: 'A', ret: [[0, 100], [2, 31], [9, 15]], eng: [10, 2, 3], ...over,
});

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok', name); };

(async () => {
    await t('cleanEntry accepts a valid entry and builds the url', () => {
        const c = cleanEntry(good());
        assert.strictEqual(typeof c, 'object');
        assert.strictEqual(c.url, 'https://www.tiktok.com/@j.s.sport_shop/video/7703146302502112519');
        assert.strictEqual(cleanEntry(good({ ch: 'ME' })).url.includes('@mesport80'), true);
    });
    await t('cleanEntry rejects bad fields and drops unknown ones', () => {
        assert.match(cleanEntry(good({ id: 'abc' })), /bad id/);
        assert.match(cleanEntry(good({ funnel: 'X' })), /funnel/);
        assert.match(cleanEntry(good({ c1: 'x' })), /c1/);
        assert.match(cleanEntry(good({ ret: [[1, 2, 3]] })), /ret/);
        assert.match(cleanEntry(good({ caption: 'x'.repeat(400) })), /caption/);
        assert.strictEqual(cleanEntry(good({ evil: '<script>' })).evil, undefined);
    });
    await t('ret round-trips through the Firestore-safe form', () => {
        const e = cleanEntry(good());
        assert.deepStrictEqual(fromDoc(JSON.parse(JSON.stringify(toDoc(e)))).ret, e.ret);
    });
    await t('mergeAlbum: push updates numbers, keeps hand-watched fields, adds new clips', () => {
        const base = { meta: { built: 'x' }, clips: [
            { id: '1', c1: 0.2, views: 10, format: 'ตลก / เทรนด์', hook: 'h', reviewed: true, cover: true },
            { id: '2', c1: 0.5, views: 5, format: 'A', cover: false },
        ] };
        const m = mergeAlbum(base, [
            { id: '1', c1: 0.3, views: 99, format: 'โชว์สินค้า / รุ่นใหม่', hasCover: false, pushedAt: '2026-11-15T01:00:00Z' },
            { id: '3', c1: 0.9, views: 7, format: 'B', hasCover: true, pushedAt: '2026-11-15T18:00:00Z' },
        ]);
        const byId = Object.fromEntries(m.clips.map(c => [c.id, c]));
        assert.strictEqual(byId['1'].views, 99);
        assert.strictEqual(byId['1'].format, 'ตลก / เทรนด์');
        assert.strictEqual(byId['1'].hook, 'h');
        assert.strictEqual(byId['1'].cover, true);
        assert.strictEqual(byId['3'].cover, true);
        assert.strictEqual(byId['3'].pushedAt, undefined);
        assert.deepStrictEqual(m.clips.map(c => c.id), ['3', '2', '1']);
        assert.strictEqual(m.meta.count, 3);
        assert.strictEqual(m.meta.pushed, '2026-11-16');
    });
    await t('tokenOk only accepts the token whose hash matches', () => {
        const tok = 'a'.repeat(64), hash = crypto.createHash('sha256').update(tok).digest('hex');
        assert.strictEqual(tokenOk('Bearer ' + tok, hash), true);
        assert.strictEqual(tokenOk('Bearer ' + 'b'.repeat(64), hash), false);
        assert.strictEqual(tokenOk(undefined, hash), false);
        assert.strictEqual(tokenOk(tok, hash), false);
    });
    await t('ingest writes entries and covers; album and cover route see them', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-'));
        const file = path.join(dir, 'hook-album.json');
        fs.writeFileSync(file, JSON.stringify({ meta: {}, clips: [{ id: '7000000000000000001', c1: 0.1, cover: true }] }));
        const items = mockCollection(), covers = mockCollection();
        const h = createHooks({ itemsRef: items, coversRef: covers, staticFile: file, log: { error() {} } });
        h.start();
        const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
        const r = await h.ingest({ clips: [good()], covers: { '7703146302502112519': jpg } });
        assert.deepStrictEqual(r, { ok: true, clips: 1, covers: 1 });
        const a = JSON.parse(h.album());
        assert.strictEqual(a.clips.length, 2);
        const c = a.clips.find(x => x.id === '7703146302502112519');
        assert.strictEqual(c.cover, true);
        assert.deepStrictEqual(c.ret, [[0, 100], [2, 31], [9, 15]]);
        // a second push without a cover keeps the earlier one
        await h.ingest({ clips: [good({ views: 20000 })] });
        const c2 = JSON.parse(h.album()).clips.find(x => x.id === '7703146302502112519');
        assert.strictEqual(c2.views, 20000);
        assert.strictEqual(c2.cover, true);
        // one bad entry rejects the whole push, nothing written
        const before = Object.keys(items.docs).length;
        const bad = await h.ingest({ clips: [good({ id: '7703146302502112520' }), good({ id: 'x' })] });
        assert.strictEqual(bad.ok, false);
        assert.strictEqual(Object.keys(items.docs).length, before);
        assert.strictEqual((await h.ingest({ clips: [] })).ok, false);
        assert.strictEqual((await h.ingest({ clips: [good()], covers: { '7703146302502112519': 'not base64!' } })).ok, false);
    });
    const comp = (over = {}) => ({
        id: '7600000000000000001', shop: 'ร้านตัวอย่าง', url: 'https://www.tiktok.com/@some.shop/video/7600000000000000001',
        date: '2026-10-01', dur: 30, views: 50000, likes: 900, comments: 12, shares: 40, saves: 55, seen: 'full',
        caption: 'c', hook: 'h', format: 'f', pillar: 'p2', opening: 'o', said: '', trick: 't', adapt: 'a', ad: true, flow: 'fl', speech: '', ...over,
    });
    await t('cleanCompetitor accepts a valid clip, rejects bad ones and own clips', () => {
        const c = cleanCompetitor(comp({ evil: '<script>' }));
        assert.strictEqual(typeof c, 'object');
        assert.strictEqual(c.evil, undefined);
        assert.strictEqual(c.ad, true);
        assert.match(cleanCompetitor(comp({ id: 'x' })), /bad id/);
        assert.match(cleanCompetitor(comp({ url: 'https://evil.example/@a/video/7600000000000000001' })), /bad url/);
        assert.match(cleanCompetitor(comp({ url: 'https://www.tiktok.com/@some.shop/video/7600000000000000002' })), /bad url/);
        assert.match(cleanCompetitor(comp({ url: 'https://www.tiktok.com/@j.s.sport_shop/video/7600000000000000001' })), /own clip/);
        assert.match(cleanCompetitor(comp({ seen: 'no' })), /seen/);
        assert.match(cleanCompetitor(comp({ saves: -1 })), /saves/);
        assert.match(cleanCompetitor(comp({ trick: ' ' })), /required/);
        assert.match(cleanCompetitor(comp({ pillar: 'p9' })), /pillar/);
    });
    await t('mergeCompetitor adds pushed clips after the shipped ones and removes nothing', () => {
        const base = { meta: { source: 's' }, clips: [{ id: '1', views: 10, ad: true, trick: 'old' }, { id: '2', views: 5, ad: false }] };
        const m = mergeCompetitor(base, [
            { id: '4', views: 1, ad: true, pushedAt: '2026-11-20T18:00:00Z' },
            { id: '3', views: 7, ad: false, pushedAt: '2026-11-19T01:00:00Z' },
            { id: '1', views: 99, ad: true, trick: 'new', pushedAt: '2026-11-19T01:00:00Z' },
        ]);
        assert.deepStrictEqual(m.clips.map(c => c.id), ['1', '2', '3', '4']);
        assert.strictEqual(m.clips[0].views, 99);
        assert.strictEqual(m.clips[0].trick, 'new');
        assert.strictEqual(m.clips[0].pushedAt, undefined);
        assert.deepStrictEqual([m.meta.count, m.meta.ads, m.meta.added, m.meta.source], [4, 2, '2026-11-21', 's']);
        assert.strictEqual(mergeCompetitor(base, []).meta.added, undefined);
    });
    await t('ingestCompetitor adds to the album; a second push leaves earlier clips in place', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comp-'));
        const file = path.join(dir, 'hook-album.json'), cfile = path.join(dir, 'competitor-hooks.json');
        fs.writeFileSync(file, JSON.stringify({ meta: {}, clips: [] }));
        fs.writeFileSync(cfile, JSON.stringify({ meta: { source: 's' }, clips: [comp({ id: '7500000000000000001', url: 'https://www.tiktok.com/@some.shop/video/7500000000000000001' })] }));
        const store = mockCollection();
        const h = createHooks({ itemsRef: mockCollection(), coversRef: mockCollection(), staticFile: file, compRef: store, compStaticFile: cfile, log: { error() {} } });
        h.start();
        assert.strictEqual(JSON.parse(h.competitorAlbum()).clips.length, 1);
        assert.deepStrictEqual(await h.ingestCompetitor({ clips: [comp()] }), { ok: true, clips: 1, added: 1, updated: 0 });
        const second = comp({ id: '7600000000000000002', url: 'https://www.tiktok.com/@other/video/7600000000000000002' });
        assert.deepStrictEqual(await h.ingestCompetitor({ clips: [second, comp({ views: 60000 })] }), { ok: true, clips: 2, added: 1, updated: 1 });
        const a = JSON.parse(h.competitorAlbum());
        assert.deepStrictEqual(a.clips.map(c => c.id), ['7500000000000000001', '7600000000000000001', '7600000000000000002']);
        assert.strictEqual(a.clips[1].views, 60000);
        assert.strictEqual(a.meta.count, 3);
        // pushing a clip again without its optional fields keeps the ones it had
        const { flow, opening, ad, ...bare } = comp({ views: 70000 });
        await h.ingestCompetitor({ clips: [bare] });
        const kept = JSON.parse(h.competitorAlbum()).clips[1];
        assert.deepStrictEqual([kept.views, kept.flow, kept.opening, kept.ad], [70000, 'fl', 'o', true]);
        // one bad clip rejects the whole push, nothing written
        const bad = await h.ingestCompetitor({ clips: [comp({ id: '7600000000000000003', url: 'https://www.tiktok.com/@other/video/7600000000000000003' }), comp({ seen: 'x' })] });
        assert.strictEqual(bad.ok, false);
        assert.strictEqual(Object.keys(store.docs).length, 2);
        assert.strictEqual((await h.ingestCompetitor({ clips: [] })).ok, false);
        assert.strictEqual(h.competitorCount(), 2);
    });
    console.log(`\n${n} passed`);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
