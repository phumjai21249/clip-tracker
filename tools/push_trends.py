# Push one week of sports trends to the Clip Tracker tab "เทรนด์กีฬา".
#
#   python tools/push_trends.py <week.json> [--dry-run]
#            [--url https://clip-tracker.onrender.com]
#            [--token-file "D:\TikTok Claude\.secrets\cliptracker_hooks_token.txt"]
#
# <week.json> is {"week": "YYYY-MM-DD" (that week's Friday), "summary": "...",
#                 "items": [ {id, title, cat, heat, why, angles[], when?, date?,
#                             postBy?, products[]?, sources[{title,url}]?}, ... ]}
# heat is hot | rising | upcoming. ids are lowercase-with-dashes, unique per week.
#
# The file is checked by the same cleanWeek() the server runs (trends.js, via
# node), so a dry run that passes will not be refused for its shape. A push
# replaces that week whole, so running it twice is safe.
import argparse, json, os, subprocess, sys, time, urllib.error, urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHECK = """
const fs = require('fs');
const { cleanWeek } = require(process.argv[1]);
const r = cleanWeek(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')));
process.stdout.write(JSON.stringify(typeof r === 'string' ? { error: r } : { week: r }));
"""


def check(path):
    out = subprocess.run(['node', '-e', CHECK, os.path.join(REPO, 'trends.js'), path],
                         capture_output=True, text=True, encoding='utf-8')
    if out.returncode != 0:
        raise SystemExit('check failed: ' + out.stderr[-400:])
    r = json.loads(out.stdout)
    if 'error' in r:
        raise SystemExit('file refused: ' + r['error'])
    return r['week']


def post(url, token, body):
    data = json.dumps(body, ensure_ascii=False).encode('utf-8')
    # Render's free instance sleeps; the first request can 503 for about a minute.
    for _ in range(8):
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
    ap.add_argument('file')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--url', default='https://clip-tracker.onrender.com')
    ap.add_argument('--token-file', default=r'D:\TikTok Claude\.secrets\cliptracker_hooks_token.txt')
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding='utf-8')

    w = check(a.file)
    print(f"week {w['week']} · {len(w['items'])} trends")
    for it in w['items']:
        print(f"  [{it['heat']:<8}] {it.get('date', '----------')} {it['cat']} · {it['title'][:60]} · {len(it['angles'])} ideas")
    if a.dry_run:
        return
    token = open(a.token_file, encoding='utf-8').read().strip()
    r = post(a.url.rstrip('/') + '/api/trends', token, json.load(open(a.file, encoding='utf-8')))
    if not r.get('ok'):
        raise SystemExit(f'push failed: {r}')
    print(f"pushed week {r['week']} ({r['items']} trends) to {a.url}")


if __name__ == '__main__':
    main()
