# Weekly push of the shop's own clips into the Clip Tracker hook album
# ("คลังฮุกร้านเรา"), run as the last step of the weekly KPI check.
#
# usage: python tools/push_hooks.py <hookpush.json> [--dry-run]
#            [--url https://clip-tracker.onrender.com]
#            [--token-file "D:\TikTok Claude\.secrets\cliptracker_hooks_token.txt"]
#
# <hookpush.json> is written by the KPI check from TikTok Studio (logged in to
# the shop's own accounts — competitor clips never go through this):
#   {"captured": "<ISO time>", "clips": [{
#       "id": "<19-digit video id>", "ch": "JS" | "ME", "post_time": <unix s>,
#       "views": n, "likes": n, "comments": n, "shares": n, "dur": <seconds>,
#       "desc": "<caption>", "cover_url": "<Studio cover url, optional>",
#       "r1": f, "r2": f, "r3": f, "r6": f, "p25": f, "p50": f,   # 0–1, still watching
#       "exclude": "" | "ตัดไลฟ์" | "ยิง Promote" | "แอด" | "ภาพนิ่ง" | ...}]}
# Clips with an exclude reason, under 24 h old or under MIN_VIEWS views are skipped,
# the same rules as the KPI's C1–C4.
#
# The same data can also come as the compact text the browser tool can carry out
# of Studio in ~1,000-character pieces (one file per channel, several files allowed):
#   # ch: JS
#   # captured: 2026-11-15T18:40:00+07:00
#   id,post_time,views,likes,comments,shares,dur,r1,r2,r3,r6,p25,p50   (r… ×1000)
#   ## desc            then lines  <last 6 digits of id>|<caption without hashtags>
#   ## exclude         then lines  <last 6 digits>|<reason>
#   ## covers          then lines  <full id>|<cover url read from the public clip page>
import argparse, base64, datetime, json, os, subprocess, sys, tempfile, time, urllib.error, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hooklib import fmt_of, funnel_of, segment_of, caption_of, summary_curve

MIN_VIEWS = 500
BATCH = 40
TH = datetime.timezone(datetime.timedelta(hours=7))
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
FFMPEG = r'C:\Users\MSI\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0-full_build\bin\ffmpeg.exe'


def read_raw(path):
    """Compact text form (see the header) -> the JSON form."""
    ch, captured, section = None, None, 'rows'
    rows, desc, excl, covers = [], {}, {}, {}
    for line in open(path, encoding='utf-8'):
        line = line.strip()
        if not line:
            continue
        if line.startswith('##'):
            section = line[2:].split()[0].lower()
            continue
        if line.startswith('#'):
            k, _, v = line[1:].partition(':')
            if k.strip() == 'ch':
                ch = v.strip()
            elif k.strip() == 'captured':
                captured = v.strip()
            continue
        if section == 'rows':
            f = line.split(',')
            if len(f) != 13:
                raise SystemExit(f'{path}: bad row: {line[:60]}')
            r = [x / 1000 for x in map(int, f[7:])]
            rows.append({'id': f[0], 'post_time': int(f[1]), 'views': int(f[2]), 'likes': int(f[3]),
                         'comments': int(f[4]), 'shares': int(f[5]), 'dur': float(f[6]),
                         'r1': r[0], 'r2': r[1], 'r3': r[2], 'r6': r[3], 'p25': r[4], 'p50': r[5]})
        else:
            k, _, v = line.partition('|')
            {'desc': desc, 'exclude': excl, 'covers': covers}.get(section, {})[k.strip()] = v.strip()
    if ch not in ('JS', 'ME') or not captured:
        raise SystemExit(f'{path}: needs "# ch: JS|ME" and "# captured: <ISO time>" lines')
    # desc / exclude lines are keyed by the end of the id (6 digits is usual;
    # write more digits or the full id when two clips share the same ending).
    def lookup(table, cid, what):
        hits = [k for k in table if cid.endswith(k)]
        if not hits:
            return ''
        best = max(hits, key=len)
        if sum(1 for r in rows if r['id'].endswith(best)) > 1:
            raise SystemExit(f'{path}: {what} key {best} matches more than one clip; use more digits')
        return table[best]
    for x in rows:
        x['ch'] = ch
        x['desc'] = lookup(desc, x['id'], 'desc')
        x['exclude'] = lookup(excl, x['id'], 'exclude')
        if x['id'] in covers:
            x['cover_url'] = covers[x['id']]
    return {'captured': captured, 'clips': rows}


def load(paths):
    data = {'captured': None, 'clips': []}
    for p in paths:
        d = json.load(open(p, encoding='utf-8')) if p.lower().endswith('.json') else read_raw(p)
        for x in d['clips']:
            x.setdefault('captured', d['captured'])
        data['clips'] += d['clips']
    return data


def entry_of(x):
    """Album entry for one Studio clip, or (None, reason) when it is skipped."""
    r2 = x.get('r2')
    if not r2:
        return None, 'ไม่มีค่าค้าง 2 วิ'
    dur = round(float(x['dur']), 1)
    c = {'desc': x.get('desc') or '', 'cat0': None}
    fmt = fmt_of(c)
    c1, c2, c3, c4 = r2, x['p25'] / r2, x['r6'] / r2, x['p50'] / r2
    e = {
        'id': str(x['id']), 'ch': x['ch'],
        'date': datetime.datetime.fromtimestamp(int(x['post_time']), TH).strftime('%Y-%m-%d'),
        'views': int(x['views']), 'dur': dur,
        'c1': round(c1, 3), 'c2': round(c2, 3), 'c3': round(c3, 3), 'c4': round(c4, 3),
        'caption': caption_of(c['desc'])[:140], 'format': fmt,
        'funnel': funnel_of(c, fmt), 'segment': segment_of(c, fmt),
        'ret': summary_curve(c1, c2, c3, c4, dur, x.get('r1'), x.get('r3')),
    }
    if x.get('likes') is not None:
        e['eng'] = [int(x['likes']), int(x.get('comments') or 0), int(x.get('shares') or 0)]
    return e, None


def select(data):
    keep, skipped = [], []
    for x in data['clips']:
        captured = datetime.datetime.fromisoformat(x['captured'].replace('Z', '+00:00')).timestamp()
        why = (x.get('exclude') or '').strip()
        if not why and captured - int(x['post_time']) < 86400:
            why = 'อายุไม่ถึง 24 ชม.'
        if not why and int(x['views']) < MIN_VIEWS:
            why = f'วิวต่ำกว่า {MIN_VIEWS}'
        e = None
        if not why:
            e, why = entry_of(x)
        if e:
            keep.append((e, x))
        else:
            skipped.append((str(x['id']), why))
    return keep, skipped


def cover_b64(url):
    # Studio cover links are signed and expire within days, so fetch them now
    # and send the shrunk image along; the server keeps it.
    raw = tempfile.NamedTemporaryFile(suffix='.img', delete=False).name
    out = raw + '.jpg'
    try:
        req = urllib.request.Request(url, headers={'User-Agent': UA, 'Referer': 'https://www.tiktok.com/'})
        with urllib.request.urlopen(req, timeout=30) as r:
            open(raw, 'wb').write(r.read())
        subprocess.run([FFMPEG, '-y', '-loglevel', 'error', '-i', raw, '-vf', 'scale=270:-2', '-q:v', '5', '-frames:v', '1', out], check=True)
        return base64.b64encode(open(out, 'rb').read()).decode()
    except Exception as ex:
        print('  cover failed:', str(ex)[:120])
        return None
    finally:
        for f in (raw, out):
            try:
                os.remove(f)
            except OSError:
                pass


def post(url, token, body):
    data = json.dumps(body, ensure_ascii=False).encode('utf-8')
    # Render's free instance sleeps; the first request can 503 for about a minute.
    for attempt in range(8):
        req = urllib.request.Request(url, data=data, method='POST', headers={
            'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token})
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as ex:
            msg = ex.read().decode('utf-8', 'ignore')[:300]
            if ex.code in (502, 503, 504):
                print(f'  server {ex.code}, waiting…')
                time.sleep(20)
                continue
            raise SystemExit(f'push refused ({ex.code}): {msg}')
        except (urllib.error.URLError, TimeoutError) as ex:
            print('  no answer yet, waiting…', str(ex)[:80])
            time.sleep(20)
    raise SystemExit('server did not answer after several tries')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('files', nargs='+')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--missing-covers', action='store_true',
                    help='list the clips to push that the live album has no cover for, then stop')
    ap.add_argument('--url', default='https://clip-tracker.onrender.com')
    ap.add_argument('--token-file', default=r'D:\TikTok Claude\.secrets\cliptracker_hooks_token.txt')
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding='utf-8')

    keep, skipped = select(load(a.files))
    if a.missing_covers:
        req = urllib.request.Request(a.url.rstrip('/') + '/hook-album.json', headers={'User-Agent': 'clip-tracker-push'})
        live = json.loads(urllib.request.urlopen(req, timeout=90).read())
        has = {c['id'] for c in live['clips'] if c.get('cover')}
        for e, x in keep:
            if e['id'] not in has and not x.get('cover_url'):
                print(f"https://www.tiktok.com/@{'j.s.sport_shop' if e['ch'] == 'JS' else 'mesport80'}/video/{e['id']}")
        return
    print(f'{len(keep)} clips to push, {len(skipped)} skipped')
    for cid, why in skipped:
        print('  skip', cid, why)
    for e, _ in keep:
        print(f"  {e['ch']} {e['date']} C1 {e['c1']*100:.0f}% {e['views']:>8} {e['format']} · {e['caption'][:40]}")
    if a.dry_run or not keep:
        return

    token = open(a.token_file, encoding='utf-8').read().strip()
    endpoint = a.url.rstrip('/') + '/api/hooks'
    total = {'clips': 0, 'covers': 0}
    for i in range(0, len(keep), BATCH):
        part = keep[i:i + BATCH]
        covers = {}
        for e, x in part:
            if x.get('cover_url'):
                b = cover_b64(x['cover_url'])
                if b:
                    covers[e['id']] = b
        r = post(endpoint, token, {'clips': [e for e, _ in part], 'covers': covers})
        if not r.get('ok'):
            raise SystemExit(f'push failed: {r}')
        total['clips'] += r['clips']
        total['covers'] += r['covers']
    print(f"pushed {total['clips']} clips, {total['covers']} covers to {a.url}")


if __name__ == '__main__':
    main()
