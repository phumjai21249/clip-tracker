# Caption-based guesses shared by build_hook_album.py (the one-off historical
# build) and push_hooks.py (the weekly push): format, funnel stage and customer
# group. A clip someone has watched overrides these by hand.
import re

def text_of(c):
    # Caption without hashtags (they repeat on every clip); a hashtag-only
    # caption falls back to its hashtags, which then carry the topic.
    d = c.get('desc') or ''
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
    mapped = CAT0_MAP.get(c.get('cat0'))
    hashtag_only = not re.sub(r'#\S+', ' ', c.get('desc') or '').strip()
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

def caption_of(desc):
    return re.sub(r'\s+', ' ', re.sub(r'#\S+', '', desc or '')).strip() or '(แฮชแท็กล้วน)'

def summary_curve(c1, c2, c3, c4, dur, r1=None, r3=None):
    # The points Studio reports: 1 s, 2 s, 3 s, 6 s, 25 % and 50 % of the clip.
    # Points are [second, % of viewers still watching].
    pts = {0: 100, 2: c1 * 100}
    if r1 is not None:
        pts[1] = r1 * 100
    if r3 is not None:
        pts[3] = r3 * 100
    if dur > 6:
        pts[6] = c1 * c3 * 100
    pts[round(dur * 0.25, 1)] = c1 * c2 * 100
    pts[round(dur * 0.5, 1)] = c1 * c4 * 100
    return [[t, round(v)] for t, v in sorted(pts.items())]
