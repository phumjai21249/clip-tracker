// Browser snippets for the weekly hook-album push (see tools/push_hooks.py).
// Run them one at a time with the browser tool's JavaScript runner. The tool
// returns at most ~1,000 characters per call, and TikTok's page security stops
// a page from sending data anywhere else, so data leaves in small text pieces.
//
// Studio (steps 1–4): the shop's own account, logged in. JS = Chrome.
// ME = whichever browser is logged in to @mesport80.
// Covers (step 5): the built-in browser, which is logged OUT of TikTok.
// Competitor clips never go through this flow; they are looked at logged out only.

// ---- 1. on https://www.tiktok.com/tiktokstudio/analytics : catch the post list, open Posts
window.__il = [];
if (!window.__hooked) {
    const of = window.fetch;
    window.fetch = async function (...a) {
        const r = await of.apply(this, a);
        try { if (/item_list/.test(String(a[0] && a[0].url || a[0]))) r.clone().json().then(j => window.__il.push(j)).catch(() => {}); } catch (e) {}
        return r;
    };
    window.__hooked = true;
}
history.pushState({}, '', '/tiktokstudio/content'); dispatchEvent(new PopStateEvent('popstate'));

// ---- 2. scroll until the list reaches 15 days back
await (async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const since = Date.now() / 1000 - 15 * 86400;
    const uniq = () => { const m = new Map(); window.__il.flatMap(x => x.item_list || []).forEach(x => m.set(x.item_id, x)); return [...m.values()]; };
    const scroller = () => [...document.querySelectorAll('*')].filter(e => e.scrollHeight > e.clientHeight + 200 && /auto|scroll/.test(getComputedStyle(e).overflowY)).sort((a, b) => b.scrollHeight - a.scrollHeight)[0] || document.scrollingElement;
    await sleep(6000);
    for (let i = 0; i < 10; i++) {
        const it = uniq().filter(x => !x.is_pinned);
        if (Math.min(...it.map(x => Number(x.post_time))) < since) break;
        const s = scroller(); s.scrollTop = s.scrollHeight;
        await sleep(2500);
    }
    window.__items = uniq();
    return window.__items.filter(x => Number(x.post_time) >= since).length;
})();

// ---- 3. viewer curve per clip (videos older than 24 h, last 15 days). Re-run until "left" is 0.
await (async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const now = Date.now() / 1000, t0 = Date.now();
    window.__curves = window.__curves || {};
    const todo = window.__items.filter(x => now - Number(x.post_time) > 86400 && Number(x.post_time) > now - 15 * 86400 && x.item_type === 1 && !window.__curves[x.item_id]);
    for (const x of todo) {
        if (Date.now() - t0 > 35000) break;
        const tr = JSON.stringify([{ insigh_type: 'video_retention_rate_realtime', aweme_id: x.item_id }]);
        const j = await (await fetch('/aweme/v2/data/insight/?locale=th-TH&aid=1988&type_requests=' + encodeURIComponent(tr), { credentials: 'include' })).json();
        const l = j.video_retention_rate_realtime && j.video_retention_rate_realtime.value && j.video_retention_rate_realtime.value.list;
        if (l && l.length) window.__curves[x.item_id] = l.map(p => [Number(p.timestamp), p.value]);
        await sleep(300);
    }
    return { left: window.__items.filter(x => now - Number(x.post_time) > 86400 && Number(x.post_time) > now - 15 * 86400 && x.item_type === 1 && !window.__curves[x.item_id]).length };
})();

// ---- 4. build the text rows, then read them out ~13 rows / 22 captions at a time
(() => {
    const at = (c, s) => { let b = c[0]; for (const p of c) if (Math.abs(p[0] / 1000 - s) < Math.abs(b[0] / 1000 - s)) b = p; return Math.round(b[1] * 1000); };
    const rows = window.__items.filter(x => window.__curves[x.item_id]);
    window.__csv = rows.map(x => { const c = window.__curves[x.item_id], d = Math.round(x.duration / 100) / 10;
        return [x.item_id, x.post_time, x.play_count, x.like_count, x.comment_count, x.share_count, d, at(c, 1), at(c, 2), at(c, 3), at(c, 6), at(c, d * 0.25), at(c, d * 0.5)].join(','); });
    window.__desc = rows.map(x => x.item_id.slice(-8) + '|' + (x.desc || '').replace(/#\S+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90));
    return { rows: rows.length };
})();
// window.__csv.slice(0, 13).join('\n')   … then 13–26, 26–39, …
// window.__desc.slice(0, 15).join('\n')  … then 15–30, …  (keys = last 8 digits of the id)

// ---- 5. built-in browser (logged out), once per clip that has no cover yet:
//      navigate to https://www.tiktok.com/@<handle>/video/<id>, then run
let it = null;
for (let i = 0; i < 16 && !it; i++) {
    try { it = JSON.parse(document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__').textContent).__DEFAULT_SCOPE__['webapp.video-detail'].itemInfo.itemStruct; }
    catch (e) { await new Promise(r => setTimeout(r, 500)); }
}
it ? it.id + '|' + it.video.cover : 'none';
