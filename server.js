const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const admin = require('firebase-admin');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' },
    maxHttpBufferSize: 1e7 // 10 MB
});

const PORT = process.env.PORT || 3000;

// Load Firebase Service Account
let serviceAccount;
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } else {
        serviceAccount = require('./firebase-admin.json');
    }
} catch (e) {
    console.error("⚠️ ไม่พบ Firebase Service Account! โปรดตรวจสอบไฟล์ firebase-admin.json หรือ ENV");
    process.exit(1);
}

// Initialize Firebase
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}
const db = admin.firestore();
const clipsRef = db.collection('clipTracker').doc('clips'); // legacy whole-array doc — frozen after migration, kept as a rollback snapshot
const clipsItemsRef = clipsRef.collection('items'); // source of truth: one Firestore doc per clip
const teamRef = db.collection('clipTracker').doc('team');

// ============ INITIAL DATA ============
function getDefaultClips() {
    const y = 2026;
    let counter = 0;
    const genId = () => 'clip_' + Date.now().toString(36) + '_' + (counter++) + '_' + Math.random().toString(36).substr(2, 5);
    return [
        { id: genId(), title: 'รีวิว iPhone 17 Pro Max', desc: 'รีวิวฟีเจอร์ใหม่ทั้งหมด', creator: 'c1', status: 'done', uploaded: true, date: `${y}-06-01` },
        { id: genId(), title: 'วิธีทำ Passive Income 2026', desc: '5 วิธีที่ทำได้จริง', creator: 'c2', status: 'editing', uploaded: false, date: `${y}-06-02` },
        { id: genId(), title: 'เที่ยวเชียงใหม่ 3 วัน 2 คืน', desc: 'งบไม่เกิน 5,000 บาท', creator: 'c3', status: 'filming', uploaded: false, date: `${y}-06-04` },
        { id: genId(), title: 'รีวิว MacBook Air M5', desc: 'เทียบกับ M4', creator: 'c1', status: 'idle', uploaded: false, date: `${y}-06-05` },
        { id: genId(), title: 'สอนแต่งรูปด้วย Lightroom', desc: 'Preset โทนซอฟต์', creator: 'c2', status: 'filming', uploaded: false, date: `${y}-06-07` },
        { id: genId(), title: 'แกะกล่อง PS6', desc: 'เครื่องแรกในไทย', creator: 'c3', status: 'done', uploaded: true, date: `${y}-06-08` },
        { id: genId(), title: 'วิธีหาเงินจาก YouTube 2026', desc: 'อัปเดตอัลกอ', creator: 'c1', status: 'editing', uploaded: false, date: `${y}-06-10` },
        { id: genId(), title: 'รีวิว Galaxy Z Fold 7', desc: 'จอพับรุ่นใหม่', creator: 'c2', status: 'idle', uploaded: false, date: `${y}-06-12` },
    ];
}

function getDefaultTeam() {
    return {
        creators: [
            { id: 'c1', name: 'คนที่ 1' },
            { id: 'c2', name: 'คนที่ 2' },
            { id: 'c3', name: 'คนที่ 3' },
        ],
        uploader: { id: 'u1', name: 'คนลงคลิป' }
    };
}

// One doc per clip beats one giant array doc: two people editing at once can
// no longer clobber each other's clips (each write only ever touches its own
// document). This seeds clipsItemsRef from whatever the legacy array holds,
// exactly once, the first time the server sees an empty items collection.
async function migrateClipsToPerDocIfNeeded(legacyClips) {
    const itemsSnap = await clipsItemsRef.limit(1).get();
    if (!itemsSnap.empty) return; // already migrated — never re-run, never re-clobber
    if (!legacyClips || legacyClips.length === 0) return;
    const batch = db.batch();
    legacyClips.forEach((clip, i) => {
        const { coverImage, id, ...rest } = clip;
        if (!id) return;
        // Preserve original list order: the array was newest-first (unshift),
        // so the first item gets the highest _seq.
        batch.set(clipsItemsRef.doc(id), { ...rest, _seq: legacyClips.length - i });
    });
    await batch.commit();
    console.log(`✅ Migrated ${legacyClips.length} clips to per-document storage`);
}

// Initialize data in Firestore if empty and handle migration
async function initDB() {
    try {
        const clipsDoc = await clipsRef.get();
        let clipsData;
        if (!clipsDoc.exists) {
            clipsData = getDefaultClips();
            await clipsRef.set({ data: clipsData });
        } else {
            // Check if there are coverImages inside the clipsDoc data, and migrate them to clipCovers if needed
            clipsData = clipsDoc.data().data || [];
            const hasLegacyCovers = clipsData.some(c => c.coverImage);
            if (hasLegacyCovers) {
                console.log("Migrating legacy cover images to clipCovers collection...");
                const batch = db.batch();
                clipsData.forEach(clip => {
                    if (clip.coverImage) {
                        const ref = db.collection('clipCovers').doc(clip.id);
                        batch.set(ref, { coverImage: clip.coverImage });
                    }
                });
                await batch.commit();

                // Strip coverImages from the main document to free up space
                clipsData = clipsData.map(clip => {
                    const { coverImage, ...rest } = clip;
                    return rest;
                });
                await clipsRef.set({ data: clipsData });
                console.log("✅ Migration completed successfully!");
            }
        }
        await migrateClipsToPerDocIfNeeded(clipsData);

        const teamDoc = await teamRef.get();
        if (!teamDoc.exists) {
            await teamRef.set({ data: getDefaultTeam() });
        }
        console.log("✅ Firestore initialized successfully");
    } catch (e) {
        console.error("Error initializing Firestore:", e);
    }
    // Listeners first so the board can serve as soon as possible; the backfill
    // is a one-off tidy-up and must never delay or block them.
    startClipsListener();
    startTeamListener();
    backfillHasCoverOnce();
}
// Started at the bottom of this file, once the cache bindings below exist.

// ---- per-clip storage helpers (source of truth) ----

// Monotonic so two clips created in the same millisecond still get a stable,
// distinct order instead of tying on Date.now().
let lastSeq = 0;
function nextSeq() { lastSeq = Math.max(Date.now(), lastSeq + 1); return lastSeq; }

// ---- live in-memory clip cache ----
// Serving connections straight from Firestore cost one document read per clip
// per connection (~419), which exhausted the daily free-tier read quota and
// took the whole board down. A single snapshot listener pays that cost once at
// boot and then only for documents that actually change, so a client
// connecting costs zero reads.
let clipsCache = [];
let clipsCacheReady = false;
let clipsCacheError = null;
const cacheWaiters = [];

function snapshotToClips(snap) {
    return snap.docs.map(doc => {
        const { _seq, hasCover, ...clip } = doc.data();
        return { ...clip, id: doc.id, hasCover: !!hasCover };
    });
}

// The team document is one small, rarely-changing record, but reading it per
// connection is still a per-connection Firestore read — the last one on the
// connect path, and enough on its own to fail every connection once the daily
// quota is gone. Same treatment as the clips.
let teamCache = null;

function startTeamListener() {
    teamRef.onSnapshot(
        doc => { teamCache = doc.exists ? doc.data().data : getDefaultTeam(); },
        err => {
            console.error('team listener error:', err.message);
            setTimeout(startTeamListener, 60000);
        }
    );
}

function startClipsListener() {
    clipsItemsRef.orderBy('_seq', 'desc').onSnapshot(
        snap => {
            clipsCache = snapshotToClips(snap);
            clipsCacheReady = true;
            clipsCacheError = null;
            while (cacheWaiters.length) cacheWaiters.shift()();
            console.log(`📥 clip cache updated: ${clipsCache.length} clips`);
        },
        err => {
            clipsCacheError = err;
            console.error('clips listener error:', err.message);
            // Quota exhaustion and transient gRPC drops both land here; retry
            // rather than leaving the process permanently blind.
            setTimeout(startClipsListener, 60000);
        }
    );
}

// Cover images are deliberately NOT part of this payload. Shipping them was
// ~6.7MB per connection; clients fetch each one from GET /cover/:id instead,
// where the browser caches it.
async function getAllClips() {
    if (clipsCacheReady) return clipsCache;
    if (clipsCacheError) throw clipsCacheError;
    // First connection(s) after boot wait for the listener's initial snapshot.
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('clip cache not ready')), 20000);
        cacheWaiters.push(() => { clearTimeout(timer); resolve(); });
    });
    return clipsCache;
}

async function upsertClip(clip) {
    const { coverImage, hasCover, id, ...rest } = clip;
    if (!id) return;
    const ref = clipsItemsRef.doc(id);
    const existing = await ref.get();
    const prev = existing.exists ? existing.data() : null;
    // Keep the clip's original position stable across edits; only brand-new
    // clips get a fresh (always-highest) _seq so they sort to the front.
    const seq = prev && typeof prev._seq === 'number' ? prev._seq : nextSeq();
    const doc = { ...rest, _seq: seq };

    if (coverImage === undefined) {
        // "Leave the cover as it is." The client no longer holds the base64,
        // so an absent field must never be read as "remove the cover".
        if (prev && prev.coverVersion) doc.coverVersion = prev.coverVersion;
        if (prev && prev.hasCover) doc.hasCover = true;
        await ref.set(doc);
        return { coverChanged: false };
    }
    if (coverImage) {
        doc.hasCover = true;
        doc.coverVersion = nextSeq(); // cache-buster for /cover/:id?v=
        await ref.set(doc);
        await db.collection('clipCovers').doc(id).set({ coverImage });
        return { coverChanged: true, hasCover: true, coverVersion: doc.coverVersion };
    }
    doc.hasCover = false;
    await ref.set(doc);
    await db.collection('clipCovers').doc(id).delete().catch(() => {});
    return { coverChanged: true, hasCover: false, coverVersion: null };
}

// The hasCover flag lives on the clip document so the snapshot listener carries
// it for free. Clips that already had covers predate the flag, so stamp them
// once — guarded by a marker so this never runs again.
let lastBackfillResult = null;

async function backfillHasCoverOnce({ force = false } = {}) {
    const metaRef = db.collection('clipTracker').doc('meta');
    try {
        if (!force) {
            const meta = await metaRef.get();
            if (meta.exists && meta.data().hasCoverBackfilled) {
                lastBackfillResult = { skipped: 'already done' };
                return lastBackfillResult;
            }
        }
        const coverIds = await db.collection('clipCovers').select().get();
        for (let i = 0; i < coverIds.docs.length; i += 400) {
            const batch = db.batch();
            coverIds.docs.slice(i, i + 400).forEach(d => {
                batch.set(clipsItemsRef.doc(d.id), { hasCover: true }, { merge: true });
            });
            await batch.commit();
        }
        await metaRef.set({ hasCoverBackfilled: true }, { merge: true });
        lastBackfillResult = { stamped: coverIds.docs.length };
        console.log(`✅ hasCover backfilled for ${coverIds.docs.length} clips`);
    } catch (e) {
        // Most likely the daily read quota; try again on the next boot rather
        // than blocking startup.
        lastBackfillResult = { error: e.message, code: e.code || null };
        console.error('hasCover backfill deferred:', e.message);
    }
    return lastBackfillResult;
}

async function deleteClip(id) {
    if (!id) return;
    await clipsItemsRef.doc(id).delete();
    await db.collection('clipCovers').doc(id).delete().catch(() => {});
}

// ============ COVER IMAGES ============
// Served per image over plain HTTP so the browser caches them and only fetches
// what it actually renders, instead of every client receiving all of them up
// front through the socket.
app.get('/cover/:id', async (req, res) => {
    try {
        const doc = await db.collection('clipCovers').doc(req.params.id).get();
        if (!doc.exists) return res.status(404).end();
        const dataUrl = doc.data().coverImage || '';
        const m = /^data:(image\/[a-z.+-]+);base64,(.+)$/i.exec(dataUrl);
        if (!m) return res.status(404).end();
        const body = Buffer.from(m[2], 'base64');
        // Requests carry ?v=<coverVersion>, so a given URL's bytes never change
        // and can be cached hard; replacing a cover changes the URL.
        res.set('Content-Type', m[1]);
        res.set('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'public, max-age=60');
        res.set('Content-Length', String(body.length));
        res.end(body);
    } catch (e) {
        console.error('cover fetch failed', req.params.id, e.message);
        res.status(500).end();
    }
});

// ============ DIAGNOSTICS ============
// Times each Firestore read the connection path depends on, in isolation, so a
// failure or a slow query can be attributed to one specific call instead of
// disappearing into the connection handler's catch. Reports sizes and counts
// only — never clip content.
app.get('/__diag', async (req, res) => {
    const out = { ok: true, node: process.version, steps: {} };
    const step = async (name, fn) => {
        const t = Date.now();
        try {
            out.steps[name] = Object.assign({ ms: Date.now() - t }, await fn());
            out.steps[name].ms = Date.now() - t;
        } catch (e) {
            out.ok = false;
            out.steps[name] = { ms: Date.now() - t, error: e.message, code: e.code || null };
        }
    };

    // Default view is read-free: it reports the in-memory cache, so checking
    // health never spends the read quota it exists to protect.
    out.cache = {
        ready: clipsCacheReady,
        clips: clipsCache.length,
        withCover: clipsCache.filter(c => c.hasCover).length,
        payloadKB: Math.round(JSON.stringify(clipsCache).length / 1024),
        teamReady: !!teamCache,
        lastError: clipsCacheError ? clipsCacheError.message : null
    };
    out.backfill = lastBackfillResult;

    if (req.query.backfill) {
        out.backfillRun = await backfillHasCoverOnce({ force: req.query.backfill === 'force' });
    }

    // Everything below actually hits Firestore and costs one read per document,
    // so it stays behind ?deep=1.
    if (req.query.deep) {
        await step('itemsOrderedBySeq', async () => {
            const s = await clipsItemsRef.orderBy('_seq', 'desc').get();
            let missingSeq = 0, flagged = 0;
            s.forEach(d => { if (typeof d.data()._seq !== 'number') missingSeq++; if (d.data().hasCover) flagged++; });
            return { count: s.size, missingSeq, hasCoverFlagged: flagged };
        });
        await step('coverIdsOnly', async () => {
            const s = await db.collection('clipCovers').select().get();
            return { count: s.size };
        });
        await step('team', async () => {
            const d = await teamRef.get();
            return { exists: d.exists };
        });
    }

    const m = process.memoryUsage();
    out.memory = { rssMB: Math.round(m.rss / 1048576), heapUsedMB: Math.round(m.heapUsed / 1048576) };
    out.uptimeSec = Math.round(process.uptime());
    res.json(out);
});

// ============ SERVE STATIC ============
app.use(express.static(path.join(__dirname, 'public')));

// ============ SOCKET.IO ============
let onlineCount = 0;

io.on('connection', (socket) => {
    onlineCount++;
    io.emit('online:count', onlineCount);
    console.log(`✅ User connected (${onlineCount} online)`);

    // Send current data to new connection — both sides come from the live
    // caches, so a connection costs zero Firestore reads.
    getAllClips().then(clips => {
        socket.emit('init:data', {
            clips,
            team: teamCache || getDefaultTeam()
        });
    }).catch(e => {
        // Never fail silently here: before this, a rejected read left the client
        // connected but permanently empty with no way to tell why.
        console.error("Error loading init data:", e);
        socket.emit('init:error', { message: String(e && e.message || e), code: (e && e.code) || null });
    });

    // ---- CLIPS (one clip per write — see upsertClip/deleteClip) ----
    socket.on('clip:save', async (clip) => {
        try {
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
            socket.broadcast.emit('clip:saved', rest);
        } catch (e) { console.error("Firebase save error (clip:save):", e); }
    });

    socket.on('clip:delete', async (id) => {
        try {
            await deleteClip(id);
            socket.broadcast.emit('clip:deleted', id);
        } catch (e) { console.error("Firebase save error (clip:delete):", e); }
    });

    // ---- Legacy whole-array event ----
    // Kept only so a browser tab that still has the old page cached (hasn't
    // refreshed since this deploy) doesn't silently stop syncing. It upserts
    // every clip in the payload but never deletes — a stale/incomplete array
    // can no longer wipe out clips the sender's tab simply doesn't know about
    // yet, which was the actual cause of clips disappearing during long
    // sessions. Delete still needs a client on the new clip:delete event.
    socket.on('clips:update', async (updatedClips) => {
        try {
            for (const clip of updatedClips) {
                await upsertClip(clip);
            }
            const fresh = await getAllClips();
            io.emit('clips:updated', fresh);
        } catch (e) { console.error("Firebase save error (clips:update, legacy):", e); }
    });

    // ---- TEAM ----
    socket.on('team:update', async (team) => {
        try {
            await teamRef.set({ data: team });
            socket.broadcast.emit('team:updated', team);
        } catch (e) { console.error("Firebase save error (team):", e); }
    });

    // ---- DISCONNECT ----
    socket.on('disconnect', () => {
        onlineCount--;
        io.emit('online:count', onlineCount);
        console.log(`❌ User disconnected (${onlineCount} online)`);
    });
});

// ============ START ============
// Kicked off here so every binding it touches (notably the clip cache) is
// already initialised.
initDB();

server.listen(PORT, () => {
    console.log('');
    console.log('🎬 ═══════════════════════════════════════');
    console.log('   Clip Tracker — Real-Time Collaboration');
    console.log('═══════════════════════════════════════════');
    console.log(`   🌐 http://localhost:${PORT}`);
    console.log('═══════════════════════════════════════════');
    console.log('');
});
