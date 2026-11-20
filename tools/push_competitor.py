# Adds other shops' clips to the "คลิปคู่แข่ง" view of the hook album.
# The clips are ADDED to what is already there: a clip whose id is already in
# the album is updated, every other clip in the album is left as it is.
#
# usage: python tools/push_competitor.py <clips.json> [--dry-run]
#            [--url https://clip-tracker.onrender.com]
#            [--token-file "D:\TikTok Claude\.secrets\cliptracker_hooks_token.txt"]
#
# <clips.json> is {"clips": [...]} or a plain list, each clip shaped like the
# ones in public/competitor-hooks.json:
#   {"id": "<video id>", "shop": "<shop name>", "url": "https://www.tiktok.com/@<handle>/video/<id>",
#    "date": "YYYY-MM-DD", "dur": <seconds>, "views": n, "likes": n, "comments": n, "shares": n, "saves": n,
#    "seen": "full" | "frames" | "transcript", "caption": "...", "hook": "...", "format": "...",
#    "pillar": "p1".."p5" (optional), "opening": "...", "said": "...", "trick": "...", "adapt": "...",
#    "ad": true | false, "flow": "...", "speech": "..."}
#
# Every clip here was looked at in a browser that is LOGGED OUT of TikTok. The
# shop's own logged-in accounts are never used to open another shop's page.
import argparse, json, os, sys, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from push_hooks import post

NEED = ['id', 'shop', 'url', 'date', 'dur', 'views', 'likes', 'comments', 'shares', 'saves', 'seen', 'caption', 'hook', 'format', 'trick', 'adapt']
BATCH = 40


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('files', nargs='+')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--url', default='https://clip-tracker.onrender.com')
    ap.add_argument('--token-file', default=r'D:\TikTok Claude\.secrets\cliptracker_hooks_token.txt')
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding='utf-8')

    clips = []
    for p in a.files:
        d = json.load(open(p, encoding='utf-8'))
        clips += d['clips'] if isinstance(d, dict) else d
    seen = set()
    for c in clips:
        missing = [k for k in NEED if c.get(k) in (None, '')]
        if missing:
            raise SystemExit(f"{c.get('id')}: missing {', '.join(missing)}")
        if c['id'] in seen:
            raise SystemExit(f"{c['id']}: listed twice")
        seen.add(c['id'])

    req = urllib.request.Request(a.url.rstrip('/') + '/competitor-hooks.json', headers={'User-Agent': 'clip-tracker-push'})
    live = {c['id'] for c in json.loads(urllib.request.urlopen(req, timeout=90).read())['clips']}
    new = [c for c in clips if c['id'] not in live]
    print(f'{len(clips)} clips: {len(new)} new, {len(clips) - len(new)} already in the album (will be updated) · album has {len(live)} now')
    for c in clips:
        print(f"  {'new ' if c['id'] not in live else 'upd '} {c['date']} {c['views']:>9} {c['shop']} · {c['caption'][:40]}")
    if a.dry_run or not clips:
        return

    token = open(a.token_file, encoding='utf-8').read().strip()
    endpoint = a.url.rstrip('/') + '/api/competitor-hooks'
    added = updated = 0
    for i in range(0, len(clips), BATCH):
        r = post(endpoint, token, {'clips': clips[i:i + BATCH]})
        if not r.get('ok'):
            raise SystemExit(f'push failed: {r}')
        added += r['added']
        updated += r['updated']
    print(f'added {added}, updated {updated} at {a.url}')


if __name__ == '__main__':
    main()
