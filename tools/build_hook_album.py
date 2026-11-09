# Builds hook-album.json for the clip-tracker "คลังฮุกร้านเรา" tab from the
# shop's own TikTok Studio retention data (Aug–Nov 2026).
# usage: python tools/build_hook_album.py public/hook-album.json <idmap.json>
import json, re, sys, os, collections, datetime

ROOT = r'D:\TikTok Claude\tiktok_master_export'
IDMAP = sys.argv[2] if len(sys.argv) > 2 else 'idmap.json'   # 7-digit suffix -> full video ID + captions
HANDLE = {'JS': 'j.s.sport_shop', 'ME': 'mesport80'}
MIN_VIEWS = 500

idmap = json.load(open(IDMAP, encoding='utf-8'))
full, desc = idmap['full'], idmap['desc']
cause = {r['id']: r for r in json.load(open(ROOT + r'\_hookcause_rows.json', encoding='utf-8'))}

clips = []
rows = json.load(open(ROOT + r'\_hookC_3m_rows.json', encoding='utf-8'))
for r in rows['JS'] + rows['ME']:
    ids = full.get(r['id'], [])
    if len(ids) != 1:
        continue
    fid = ids[0]
    clips.append({
        'id': fid, 'ch': r['ch'], 'date': r['d'][:10], 'views': r['v'], 'dur': r['dur'],
        'c1': r['C1'], 'c2': r['C2'], 'c3': r['C3'], 'c4': r['C4'], 'tag': r['tag'],
        'desc': desc.get(fid) or (cause.get(r['id']) or {}).get('desc', ''),
        'cat0': (cause.get(r['id']) or {}).get('cat'),
        'r1': r.get('r1'), 'vis': cause.get(r['id']),
    })

seen = {c['id'] for c in clips}
for ch, f in (('JS', '_wk1107_js_studio.json'), ('ME', '_wk1107_me_studio.json')):
    for x in json.load(open(ROOT + '\\' + f, encoding='utf-8')):
        if x['id'] in seen or not x.get('r2'):
            continue
        r2 = x['r2']
        posted = datetime.datetime.fromtimestamp(x['t'])
        clips.append({
            'id': x['id'], 'ch': ch, 'date': posted.strftime('%Y-%m-%d'), 'views': x['v'],
            'dur': round(x['dur'] / 1000), 'c1': r2, 'c2': x['p25'] / r2, 'c3': x['r6'] / r2,
            'c4': x['p50'] / r2, 'tag': '<24ชม.' if (datetime.datetime(2026, 11, 7) - posted).total_seconds() < 86400 else '',
            'desc': x.get('desc', ''), 'cat0': None,
            'r1': x.get('r1'), 'r3': x.get('r3'), 'eng': (x.get('l'), x.get('c'), x.get('s')),
        })

def text_of(c):
    # Caption without hashtags (they repeat on every clip); a hashtag-only
    # caption falls back to its hashtags, which then carry the topic.
    d = c['desc'] or ''
    t = re.sub(r'#\S+', ' ', d).strip()
    return (t or d.replace('#', ' ')).lower()

# Format, from the caption with hashtags stripped (they repeat on every clip).
FORMATS = [
    ('ทีเซอร์ / Coming soon', r'coming ?soon|เร็ว ?ๆ ?นี้|เตรียมพบ|อีกไม่นาน|รอเลย'),
    ('โปร / ลดราคา / ไลฟ์', r'ลด\s*\d|ลดแรง|ลดราคา|โปร|%|ไลฟ์|live|payday|เพย์เดย์|แจก|คูปอง|flash|ราคาพิเศษ|ถูกสุด|คุ้มมาก'),
    ('เสื้อทีม / สั่งทำ', r'เสื้อ.{0,12}(ทีม|สั่งทำ|พิมพ์|ออกแบบ|oem)|สั่งทำเสื้อ|ออกแบบเสื้อ'),
    ('เปรียบเทียบ / ถามเลือก', r'\bvs\b|เทียบ|เลือก|งบ\s*\d|อันไหน|แบบไหนดี|คู่ไหน|ต่างกัน|หรือ\s*\?'),
    ('ความรู้ / ฮาวทู', r'วิธี|ทำยังไง|เคล็ด|รู้ไหม|ต้องรู้|ดูแล|ทำความสะอาด|ล้าง|ใส่ยังไง|ไซซ์|size'),
    ('สโมสร / ทีมบอล', r'สโมสร|เอฟซี|\bfc\b|นักเตะ|อะคาเดมี|คัดตัว|แข่ง|ฟุตบอลโลก|บอลโลก'),
    ('ตลก / เทรนด์', r'ตลก|555|เทรนด์|เต้น|pov|เมื่อ|แม่ อสม'),
    ('กิจกรรม / ชุมชน', r'เชิญ|บุญ|ประเพณี|กิจกรรม|งานเปิดตัว|สหกรุ๊ป'),
    ('รีวิว / ลูกค้าจริง', r'รีวิว|ขอบคุณ|ลูกค้า|ใช้งานจริง'),
]
CAT0_MAP = {
    'โชว์สินค้า/รุ่นใหม่/เติมสต๊อก': None, 'สโมสร/ทีมบอล': 'สโมสร / ทีมบอล', 'ตลก/เทรนด์/เต้น': 'ตลก / เทรนด์',
    'เปรียบเทียบ/ถามเลือก': 'เปรียบเทียบ / ถามเลือก', 'โปร/ลดราคา/กิจกรรม': 'โปร / ลดราคา / ไลฟ์',
    'ความรู้/ฮาวทู': 'ความรู้ / ฮาวทู', 'เสื้อ OEM/เสื้อทีม': 'เสื้อทีม / สั่งทำ', 'โฟม/อุปกรณ์อื่น': None,
}
ARRIVAL = r'มาแล้ว|เข้าแล้ว|เข้ามา|รีบกด|ก่อนหมด|พร้อมส่ง|เติมสต|สต๊อก|สต็อก|ในตะกร้า|กดตะกร้า|สั่งได้|สั่งซื้อ|ทักแชท|inbox|มีของ'

def fmt_of(c):
    # A hashtag-only clip trusts the earlier hand-checked category first:
    # shop hashtags (#เจเอสสปอร์ตหนองบัวลําภู…) say nothing about the clip.
    mapped = CAT0_MAP.get(c['cat0'])
    hashtag_only = not re.sub(r'#\S+', ' ', c['desc'] or '').strip()
    if hashtag_only and mapped:
        return mapped
    t = text_of(c)
    for name, rx in FORMATS:
        if re.search(rx, t):
            return name
    return mapped or 'โชว์สินค้า / รุ่นใหม่'

# Funnel: what the viewer is ready for when the clip reaches them.
def funnel_of(c, fmt):
    t = text_of(c)
    if fmt in ('โปร / ลดราคา / ไลฟ์', 'เสื้อทีม / สั่งทำ'):
        return 'BOFU'
    if fmt == 'โชว์สินค้า / รุ่นใหม่' and re.search(ARRIVAL, t):
        return 'BOFU'
    if fmt in ('ทีเซอร์ / Coming soon', 'สโมสร / ทีมบอล', 'ตลก / เทรนด์', 'กิจกรรม / ชุมชน'):
        return 'TOFU'
    return 'MOFU'

# Which of the four customer groups (audience report 30 Oct 2026) the clip speaks to.
def segment_of(c, fmt):
    t = text_of(c)
    if fmt == 'เสื้อทีม / สั่งทำ':
        return 'C'
    if re.search(r'เด็ก|ลูก|ของขวัญ|แฟน(?!บอล)|ผู้หญิง|สาว|ชุดวอร์ม|คุณแม่', t):
        return 'B'
    if fmt in ('ทีเซอร์ / Coming soon', 'โปร / ลดราคา / ไลฟ์') or re.search(r'ไลฟ์|รุ่นใหม่|สีใหม่', t):
        return 'D'
    return 'A'

# ---- Per-clip analysis inputs (shown when a clip is opened) ----
# Full second-by-second retention exists for the October JS export; every other
# clip gets the points Studio reports (1 s, 2 s, 3 s, 6 s, 25 % and 50 % of the
# clip). Points are [second, % of viewers still watching].
def load_curves():
    try:
        d = json.load(open(ROOT + r'\_wk1031_js_retfull.json', encoding='utf-8'))
        return {k: v for k, v in d['ret'].items() if isinstance(v, list) and len(v) > 4}
    except FileNotFoundError:
        return {}
CURVES = load_curves()

# Likes / comments / shares from the Studio item lists (latest capture wins).
def load_engagement():
    eng = {}
    for f in sorted(os.listdir(ROOT)):
        if not (f.startswith('_wk') and f.endswith('.json')):
            continue
        try:
            d = json.load(open(os.path.join(ROOT, f), encoding='utf-8'))
        except ValueError:
            continue
        items = d.get('items') if isinstance(d, dict) else d
        for x in items if isinstance(items, list) else []:
            if isinstance(x, dict) and x.get('id') and x.get('l') is not None:
                eng[str(x['id'])] = (int(x['l']), int(x.get('c') or 0), int(x.get('s') or 0))
    return eng
ENGAGEMENT = load_engagement()

def analysis_of(c):
    a = {}
    full_curve = CURVES.get(c['id'])
    # A curve captured while the clip was still young disagrees with the later
    # C1; trust the curve only when its 2-second point matches C1.
    if full_curve and not any(ms == 2000 and abs(v - c['c1']) <= 0.03 for ms, v in full_curve):
        full_curve = None
    if full_curve:
        pts = [[round(ms / 1000, 1), round(v * 100)] for ms, v in full_curve]
        step = max(1, len(pts) // 40)
        a['ret'] = pts[::step] + ([pts[-1]] if (len(pts) - 1) % step else [])
        a['retFull'] = True
    else:
        c1, dur = c['c1'], c['dur']
        pts = {0: 100, 2: c1 * 100}
        if c.get('r1') is not None:
            pts[1] = c['r1'] * 100
        if c.get('r3') is not None:
            pts[3] = c['r3'] * 100
        if dur > 6:
            pts[6] = c1 * c['c3'] * 100
        pts[round(dur * 0.25, 1)] = c1 * c['c2'] * 100
        pts[round(dur * 0.5, 1)] = c1 * c['c4'] * 100
        a['ret'] = [[t, round(v)] for t, v in sorted(pts.items())]
    eng = ENGAGEMENT.get(c['id']) or (c.get('eng') if c.get('eng') and c['eng'][0] is not None else None)
    if eng:
        a['eng'] = [int(eng[0]), int(eng[1] or 0), int(eng[2] or 0)]
    v = c.get('vis')
    if v and v.get('m0') is not None:
        # first frame brightness / colour / detail and how much the picture
        # changes at 1 s and 2 s; flags: blank first frame, almost no motion
        a['vis'] = {'m': v['m0'], 's': v['s0'], 'e': v['e0'], 'd1': v['d1'], 'd2': v['d2'],
                    'blank': bool(v.get('dark')), 'still': bool(v.get('static'))}
    return a

out = []
for c in clips:
    if c['tag'] or c['views'] < MIN_VIEWS:
        continue
    fmt = fmt_of(c)
    caption = re.sub(r'\s+', ' ', re.sub(r'#\S+', '', c['desc'] or '')).strip() or '(แฮชแท็กล้วน)'
    out.append({
        'id': c['id'], 'ch': c['ch'], 'url': f"https://www.tiktok.com/@{HANDLE[c['ch']]}/video/{c['id']}",
        'date': c['date'], 'views': c['views'], 'dur': c['dur'],
        'c1': round(c['c1'], 3), 'c2': round(c['c2'], 3), 'c3': round(c['c3'], 3), 'c4': round(c['c4'], 3),
        'caption': caption[:140], 'format': fmt, 'funnel': funnel_of(c, fmt), 'segment': segment_of(c, fmt),
        **analysis_of(c),
    })

# Clips someone has watched end to end override the caption guesses: format,
# funnel and customer group from what is actually on screen, plus a note.
REVIEW = sys.argv[3] if len(sys.argv) > 3 else 'tools/hook-review.json'
try:
    review = json.load(open(REVIEW, encoding='utf-8'))
except FileNotFoundError:
    review = {}
for x in out:
    r = review.get(x['id'])
    if not r or r.get('unwatched'):
        continue
    x.update({k: r[k] for k in ('format', 'funnel', 'segment') if k in r})
    if r.get('caption') and x['caption'] == '(แฮชแท็กล้วน)':
        x['caption'] = r['caption'][:140]
    x['note'] = r.get('note', '')
    x['hook'] = r.get('hook', '')
    x['trick'] = r.get('trick', '')
    x['reviewed'] = True

# Covers fetched from each clip's page (tools/fetch_covers.py) live in
# public/hook-covers/<id>.jpg; a clip without one shows a plain tile.
COVERS = sys.argv[4] if len(sys.argv) > 4 else 'public/hook-covers'
for x in out:
    x['cover'] = os.path.exists(os.path.join(COVERS, x['id'] + '.jpg'))

out.sort(key=lambda x: -x['c1'])
meta = {
    'built': '2026-11-09', 'source': 'TikTok Studio (กราฟคนดูต่อรายคลิป) ส.ค.–6 พ.ย. 2026',
    'rules': f'ไม่นับคลิปตัดไลฟ์ ยิง Promote อายุไม่ถึง 24 ชม. และคลิปวิวต่ำกว่า {MIN_VIEWS}',
    'count': len(out),
    'reviewed': sum(1 for x in out if x.get('reviewed')),
}
json.dump({'meta': meta, 'clips': out}, open(sys.argv[1], 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))

print('clips', len(out), 'of', len(clips))
print('by ch', collections.Counter(x['ch'] for x in out))
print('funnel', collections.Counter(x['funnel'] for x in out))
print('format', collections.Counter(x['format'] for x in out).most_common())
print('segment', collections.Counter(x['segment'] for x in out))
for th in (0.33, 0.4, 0.45, 0.5):
    print('c1>=', th, sum(1 for x in out if x['c1'] >= th))
for x in out[:12]:
    print(round(x['c1'] * 100), x['ch'], x['funnel'], x['format'], x['views'], x['caption'][:50])
