// New-product launch plans. One Firestore document per product, cached in
// memory by a snapshot listener so opening the board costs no reads, and
// written one field path at a time so two people editing different parts of
// the same product never overwrite each other.

// Top-level details are replaced whole; specs, prep ticks and clip links are
// addressed one entry at a time ("specs.3", "prepDone.2", "clipIds.1").
const TOP_LEVEL = new Set([
    'name', 'code', 'intro', 'color', 'price', 'sizes', 'features',
    'compareWith', 'creator', 'channel', 'arrivalDate', 'prep',
]);
const NESTED = /^(specs|prepDone|clipIds)\.[0-9A-Za-z_]{1,20}$/;
const ID = /^[0-9A-Za-z_-]{1,80}$/;
const MAX_BYTES = 200 * 1024;   // per write; a product doc is well under 1 MB

function sizeOf(v) {
    try { return Buffer.byteLength(JSON.stringify(v) || '', 'utf8'); } catch (e) { return Infinity; }
}

function validateUpdate(msg) {
    const { id, fields } = msg || {};
    if (typeof id !== 'string' || !ID.test(id)) return 'bad id';
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return 'bad fields';
    const keys = Object.keys(fields);
    if (!keys.length) return 'no fields';
    for (const k of keys) {
        if (!TOP_LEVEL.has(k) && !NESTED.test(k)) return `field not allowed: ${k}`;
    }
    if (sizeOf(fields) > MAX_BYTES) return 'too large';
    return null;
}

function validateCreate(msg) {
    const p = msg && msg.product;
    if (!p || typeof p !== 'object') return 'bad product';
    if (typeof p.id !== 'string' || !ID.test(p.id)) return 'bad id';
    if (typeof p.name !== 'string' || !p.name.trim()) return 'name required';
    if (sizeOf(p) > MAX_BYTES * 4) return 'too large';
    return null;
}

// `ref` is the products collection; `FieldValue` comes from firebase-admin.
// Returns the cache accessor and the socket wiring.
function createProducts({ ref, FieldValue, log = console }) {
    let cache = {};
    let ready = false;

    function startListener() {
        ref.onSnapshot(
            snap => {
                const next = {};
                snap.forEach(doc => { next[doc.id] = Object.assign({}, doc.data(), { id: doc.id }); });
                cache = next;
                ready = true;
            },
            err => {
                log.error('products listener error:', err.message);
                setTimeout(startListener, 60000);
            }
        );
    }

    function list() {
        return Object.values(cache).sort((a, b) => (b._seq || 0) - (a._seq || 0));
    }

    function attach(socket) {
        const reply = (ack, r) => { if (typeof ack === 'function') ack(r); };

        socket.on('product:create', async (msg, ack) => {
            const bad = validateCreate(msg);
            if (bad) return reply(ack, { ok: false, error: bad });
            try {
                const product = Object.assign({}, msg.product, { _seq: Date.now() });
                await ref.doc(product.id).set(product);
                socket.broadcast.emit('product:created', product);
                reply(ack, { ok: true });
            } catch (e) {
                log.error('product:create failed:', e.message);
                reply(ack, { ok: false, error: e.message, code: e.code || null });
            }
        });

        socket.on('product:update', async (msg, ack) => {
            const bad = validateUpdate(msg);
            if (bad) return reply(ack, { ok: false, error: bad });
            try {
                // null removes the path (e.g. un-ticking a prep item).
                const write = {};
                Object.entries(msg.fields).forEach(([k, v]) => {
                    write[k] = v === null || v === undefined ? FieldValue.delete() : v;
                });
                await ref.doc(msg.id).update(write);
                socket.broadcast.emit('product:updated', { id: msg.id, fields: msg.fields });
                reply(ack, { ok: true });
            } catch (e) {
                log.error('product:update failed:', e.message);
                reply(ack, { ok: false, error: e.message, code: e.code || null });
            }
        });

        // Deletes the plan only. Clips it already put on the board are real
        // work items and stay there.
        socket.on('product:delete', async (id, ack) => {
            if (typeof id !== 'string' || !ID.test(id)) return reply(ack, { ok: false, error: 'bad id' });
            try {
                await ref.doc(id).delete();
                socket.broadcast.emit('product:deleted', id);
                reply(ack, { ok: true });
            } catch (e) {
                log.error('product:delete failed:', e.message);
                reply(ack, { ok: false, error: e.message, code: e.code || null });
            }
        });
    }

    return { startListener, list, attach, isReady: () => ready, count: () => Object.keys(cache).length };
}

module.exports = { createProducts, validateUpdate, validateCreate };
