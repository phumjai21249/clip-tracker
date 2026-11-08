# Fetch each hook-album clip's TikTok page: real caption, duration, cover,
# and (for clips still to watch) the video itself. Covers are shrunk with ffmpeg.
import json, re, sys, time, urllib.request, subprocess, os

S = os.path.dirname(os.path.abspath(__file__))
FFMPEG = r'C:\Users\MSI\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0-full_build\bin\ffmpeg.exe'
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
album = json.load(open(sys.argv[1], encoding='utf-8'))['clips']
review = json.load(open(os.path.join(S, 'review.json'), encoding='utf-8'))
todo_video = {k for k, v in review.items() if v.get('unwatched')}
out_path = os.path.join(S, 'pages.json')
pages = json.load(open(out_path, encoding='utf-8')) if os.path.exists(out_path) else {}
os.makedirs(os.path.join(S, 'covers'), exist_ok=True)
os.makedirs(os.path.join(S, 'videos'), exist_ok=True)

def get(url, binary=False, headers=None):
    req = urllib.request.Request(url, headers=dict({'User-Agent': UA, 'Accept-Language': 'th,en', 'Referer': 'https://www.tiktok.com/'}, **(headers or {})))
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read() if binary else r.read().decode('utf-8', 'ignore')

for i, c in enumerate(album):
    cid = c['id']
    cover = os.path.join(S, 'covers', cid + '.jpg')
    if cid in pages and os.path.exists(cover) and (cid not in todo_video or os.path.exists(os.path.join(S, 'videos', cid + '.mp4'))):
        continue
    try:
        h = get(c['url'])
        m = re.search(r'<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>(.*?)</script>', h, re.S)
        it = json.loads(m.group(1))['__DEFAULT_SCOPE__']['webapp.video-detail']['itemInfo']['itemStruct']
        v = it['video']
        pages[cid] = {'desc': it.get('desc', ''), 'dur': v.get('duration'), 'author': (it.get('author') or {}).get('uniqueId')}
        raw = os.path.join(S, 'covers', cid + '_raw.jpg')
        open(raw, 'wb').write(get(v.get('originCover') or v.get('cover'), binary=True))
        subprocess.run([FFMPEG, '-y', '-loglevel', 'error', '-i', raw, '-vf', 'scale=270:-2', '-q:v', '5', cover], check=True)
        os.remove(raw)
        if cid in todo_video:
            play = v.get('playAddr') or v.get('downloadAddr')
            if play:
                try:
                    open(os.path.join(S, 'videos', cid + '.mp4'), 'wb').write(get(play, binary=True))
                except Exception as e:
                    pages[cid]['video_err'] = str(e)[:80]
        print(i, cid, 'ok', pages[cid]['dur'], pages[cid]['author'], flush=True)
    except Exception as e:
        print(i, cid, 'ERR', str(e)[:100], flush=True)
    json.dump(pages, open(out_path, 'w', encoding='utf-8'), ensure_ascii=False)
    time.sleep(3)
print('done', len(pages))
