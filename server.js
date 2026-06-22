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
const clipsRef = db.collection('clipTracker').doc('clips');
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

// Initialize data in Firestore if empty and handle migration
async function initDB() {
    try {
        const clipsDoc = await clipsRef.get();
        if (!clipsDoc.exists) {
            await clipsRef.set({ data: getDefaultClips() });
        } else {
            // Check if there are coverImages inside the clipsDoc data, and migrate them to clipCovers if needed
            const clipsData = clipsDoc.data().data || [];
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
                const cleanClips = clipsData.map(clip => {
                    const { coverImage, ...rest } = clip;
                    return rest;
                });
                await clipsRef.set({ data: cleanClips });
                console.log("✅ Migration completed successfully!");
            }
        }
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

// ============ SERVE STATIC ============
app.use(express.static(path.join(__dirname, 'public')));

// ============ SOCKET.IO ============
let onlineCount = 0;

io.on('connection', (socket) => {
    onlineCount++;
    io.emit('online:count', onlineCount);
    console.log(`✅ User connected (${onlineCount} online)`);

    // Send current data to new connection (merged with separate cover images)
    Promise.all([
        clipsRef.get(),
        db.collection('clipCovers').get(),
        teamRef.get()
    ]).then(([clipsDoc, coversSnapshot, teamDoc]) => {
        const covers = {};
        coversSnapshot.forEach(doc => {
            covers[doc.id] = doc.data().coverImage;
        });
        
        const clips = clipsDoc.exists ? clipsDoc.data().data : [];
        const mergedClips = clips.map(clip => ({
            ...clip,
            coverImage: covers[clip.id] || ""
        }));

        socket.emit('init:data', {
            clips: mergedClips,
            team: teamDoc.exists ? teamDoc.data().data : getDefaultTeam()
        });
    }).catch(e => console.error("Error loading init data:", e));

    // ---- CLIPS ----
    socket.on('clips:update', async (updatedClips) => {
        try {
            // 1. Extract coverImages and strip them from clips array
            const clipsToSave = [];
            const coversToUpdate = [];
            const idsInUpdated = new Set();

            updatedClips.forEach(clip => {
                idsInUpdated.add(clip.id);
                const { coverImage, ...rest } = clip;
                clipsToSave.push(rest);
                
                if (coverImage) {
                    coversToUpdate.push({ id: clip.id, coverImage });
                }
            });

            // 2. Save main clips document
            await clipsRef.set({ data: clipsToSave });

            // 3. Write covers to separate documents
            if (coversToUpdate.length > 0) {
                const batch = db.batch();
                coversToUpdate.forEach(item => {
                    const ref = db.collection('clipCovers').doc(item.id);
                    batch.set(ref, { coverImage: item.coverImage });
                });
                await batch.commit();
            }

            // 4. Cleanup deleted clips or removed cover images
            const coversSnapshot = await db.collection('clipCovers').get();
            const deleteBatch = db.batch();
            let hasDeletes = false;
            coversSnapshot.forEach(doc => {
                const clip = updatedClips.find(c => c.id === doc.id);
                if (!clip || !clip.coverImage) {
                    deleteBatch.delete(doc.ref);
                    hasDeletes = true;
                }
            });
            if (hasDeletes) {
                await deleteBatch.commit();
            }

            // 5. Broadcast the original updatedClips (with coverImage inside) to other clients
            socket.broadcast.emit('clips:updated', updatedClips);
        } catch (e) { console.error("Firebase save error (clips):", e); }
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
