// node test/products.test.js — no test runner in this repo; exits non-zero on failure.
const assert = require('assert');
const { createProducts, validateUpdate } = require('../products');

const DELETE = { __delete: true };
function mockFirestore({ failWrites = false } = {}) {
    const docs = {};
    let listener = null;
    const notify = () => listener && listener({
        forEach: fn => Object.entries(docs).forEach(([id, d]) => fn({ id, data: () => JSON.parse(JSON.stringify(d)) })),
    });
    const setPath = (obj, path, v) => {
        const parts = path.split('.');
        let o = obj;
        parts.slice(0, -1).forEach(p => { o[p] = o[p] || {}; o = o[p]; });
        if (v === DELETE) delete o[parts[parts.length - 1]]; else o[parts[parts.length - 1]] = v;
    };
    return {
        docs,
        onSnapshot(fn) { listener = fn; notify(); },
        doc(id) {
            return {
                async set(d) { if (failWrites) throw Object.assign(new Error('quota'), { code: 8 }); docs[id] = JSON.parse(JSON.stringify(d)); notify(); },
                async update(fields) {
                    if (failWrites) throw Object.assign(new Error('quota'), { code: 8 });
                    if (!docs[id]) throw Object.assign(new Error('NOT_FOUND'), { code: 5 });
                    Object.entries(fields).forEach(([k, v]) => setPath(docs[id], k, v)); notify();
                },
                async delete() { delete docs[id]; notify(); },
            };
        },
    };
}
function mockSocket() {
    const handlers = {}, broadcasts = [];
    return {
        handlers, broadcasts,
        on: (ev, fn) => { handlers[ev] = fn; },
        broadcast: { emit: (ev, data) => broadcasts.push([ev, data]) },
        call: (ev, msg) => new Promise(res => handlers[ev](msg, res)),
    };
}
const quiet = { error: () => {} };

(async () => {
    let passed = 0;
    const t = async (name, fn) => { await fn(); passed++; console.log('  ✓', name); };

    // ---- validation ----
    await t('allows top-level and single nested paths', () => {
        assert.strictEqual(validateUpdate({ id: 'p1', fields: { price: '1,790', 'specs.3': {}, 'prepDone.2': true, 'clipIds.1': 'c', 'assign.4': 'c2' } }), null);
    });
    await t('rejects unknown and deep paths', () => {
        assert.match(validateUpdate({ id: 'p1', fields: { _seq: 1 } }), /not allowed/);
        assert.match(validateUpdate({ id: 'p1', fields: { 'specs.3.caption': 'x' } }), /not allowed/);
        assert.match(validateUpdate({ id: 'p1', fields: { 'specs': {} } }), /not allowed/);
    });
    await t('rejects bad ids and empty updates', () => {
        assert.strictEqual(validateUpdate({ id: '../x', fields: { name: 'a' } }), 'bad id');
        assert.strictEqual(validateUpdate({ id: 'p1', fields: {} }), 'no fields');
    });

    // ---- create / update / delete ----
    const ref = mockFirestore();
    const products = createProducts({ ref, FieldValue: { delete: () => DELETE }, log: quiet });
    products.startListener();
    const sock = mockSocket();
    products.attach(sock);

    await t('create stores the product and acks', async () => {
        const r = await sock.call('product:create', { product: { id: 'p1', name: 'PAN ZOOM', specs: { 1: { caption: 'a' }, 2: { caption: 'b' } } } });
        assert.deepStrictEqual(r, { ok: true });
        assert.strictEqual(ref.docs.p1.name, 'PAN ZOOM');
        assert.ok(ref.docs.p1._seq > 0);
        assert.strictEqual(products.list().length, 1);
    });
    await t('create without a name is refused', async () => {
        const r = await sock.call('product:create', { product: { id: 'p2', name: '  ' } });
        assert.deepStrictEqual(r, { ok: false, error: 'name required' });
        assert.ok(!ref.docs.p2);
    });
    await t('updating one spec leaves the others alone', async () => {
        await sock.call('product:update', { id: 'p1', fields: { 'specs.2': { caption: 'B!' } } });
        assert.strictEqual(ref.docs.p1.specs['1'].caption, 'a');
        assert.strictEqual(ref.docs.p1.specs['2'].caption, 'B!');
    });
    await t('two different prep ticks both survive', async () => {
        await sock.call('product:update', { id: 'p1', fields: { 'prepDone.0': true } });
        await sock.call('product:update', { id: 'p1', fields: { 'prepDone.3': true } });
        assert.deepStrictEqual(ref.docs.p1.prepDone, { 0: true, 3: true });
    });
    await t('null removes a path', async () => {
        await sock.call('product:update', { id: 'p1', fields: { 'prepDone.0': null } });
        assert.deepStrictEqual(ref.docs.p1.prepDone, { 3: true });
    });
    await t('updates are broadcast to other clients', () => {
        assert.ok(sock.broadcasts.some(([ev, d]) => ev === 'product:updated' && d.id === 'p1'));
    });
    await t('updating a missing product acks the failure', async () => {
        const r = await sock.call('product:update', { id: 'nope', fields: { name: 'x' } });
        assert.strictEqual(r.ok, false);
    });
    await t('a refused path never reaches Firestore', async () => {
        const r = await sock.call('product:update', { id: 'p1', fields: { createdBy: 'x' } });
        assert.strictEqual(r.ok, false);
        assert.ok(!('createdBy' in ref.docs.p1));
    });
    await t('delete removes the product only', async () => {
        const r = await sock.call('product:delete', 'p1');
        assert.deepStrictEqual(r, { ok: true });
        assert.strictEqual(products.list().length, 0);
    });

    // ---- failures are acknowledged, never silent ----
    const failing = createProducts({ ref: mockFirestore({ failWrites: true }), FieldValue: { delete: () => DELETE }, log: quiet });
    failing.startListener();
    const s2 = mockSocket(); failing.attach(s2);
    await t('a failed write acks ok:false with the error', async () => {
        const r = await s2.call('product:create', { product: { id: 'p9', name: 'X' } });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.error, 'quota');
        assert.ok(!s2.broadcasts.length, 'nothing broadcast for a failed write');
    });

    console.log(`\n${passed} passed`);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
