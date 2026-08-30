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
}
initDB();

// ---- per-clip storage helpers (source of truth) ----
async function getAllClips() {
    const [itemsSnap, coversSnap] = await Promise.all([
        clipsItemsRef.orderBy('_seq', 'desc').get(),
        db.collection('clipCovers').get()
    ]);
    const covers = {};
    coversSnap.forEach(doc => { covers[doc.id] = doc.data().coverImage; });
    return itemsSnap.docs.map(doc => {
        const { _seq, ...clip } = doc.data();
        return { ...clip, id: doc.id, coverImage: covers[doc.id] || "" };
    });
}

async function upsertClip(clip) {
    const { coverImage, id, ...rest } = clip;
    if (!id) return;
    const ref = clipsItemsRef.doc(id);
    const existing = await ref.get();
    // Keep the clip's original position stable across edits; only brand-new
    // clips get a fresh (always-highest) _seq so they sort to the front.
    const seq = existing.exists && typeof existing.data()._seq === 'number' ? existing.data()._seq : Date.now();
    await ref.set({ ...rest, _seq: seq });
    if (coverImage) {
        await db.collection('clipCovers').doc(id).set({ coverImage });
    } else if (existing.exists) {
        await db.collection('clipCovers').doc(id).delete().catch(() => {});
    }
}

async function deleteClip(id) {
    if (!id) return;
    await clipsItemsRef.doc(id).delete();
    await db.collection('clipCovers').doc(id).delete().catch(() => {});
}

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

    await step('legacyArrayDoc', async () => {
        const d = await clipsRef.get();
        return { exists: d.exists, arrayLen: d.exists ? (d.data().data || []).length : 0 };
    });
    await step('itemsUnordered', async () => {
        const s = await clipsItemsRef.get();
        return { count: s.size };
    });
    await step('itemsOrderedBySeq', async () => {
        const s = await clipsItemsRef.orderBy('_seq', 'desc').get();
        let missingSeq = 0;
        s.forEach(d => { if (typeof d.data()._seq !== 'number') missingSeq++; });
        return { count: s.size, missingSeq };
    });
    await step('covers', async () => {
        const s = await db.collection('clipCovers').get();
        let bytes = 0, biggest = 0;
        s.forEach(d => {
            const c = d.data().coverImage;
            if (typeof c === 'string') { bytes += c.length; if (c.length > biggest) biggest = c.length; }
        });
        return { count: s.size, totalKB: Math.round(bytes / 1024), biggestKB: Math.round(biggest / 1024) };
    });
    await step('team', async () => {
        const d = await teamRef.get();
        return { exists: d.exists };
    });
    await step('getAllClipsEndToEnd', async () => {
        const all = await getAllClips();
        return { count: all.length, payloadKB: Math.round(JSON.stringify(all).length / 1024) };
    });

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

    // Send current data to new connection
    Promise.all([
        getAllClips(),
        teamRef.get()
    ]).then(([clips, teamDoc]) => {
        socket.emit('init:data', {
            clips,
            team: teamDoc.exists ? teamDoc.data().data : getDefaultTeam()
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
            await upsertClip(clip);
            socket.broadcast.emit('clip:saved', clip);
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
server.listen(PORT, () => {
    console.log('');
    console.log('🎬 ═══════════════════════════════════════');
    console.log('   Clip Tracker — Real-Time Collaboration');
    console.log('═══════════════════════════════════════════');
    console.log(`   🌐 http://localhost:${PORT}`);
    console.log('═══════════════════════════════════════════');
    console.log('');
});
