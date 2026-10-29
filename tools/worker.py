"""Deploys Noteshack's online translator (worker/index.js) to Cloudflare
Workers as `noteshack-api`, answering at api.noteshack.org.

    CLOUDFLARE_API_TOKEN=… python3 tools/worker.py

The token needs Account → Workers Scripts → Edit. The Worker gets Workers AI
(the AI binding) and a rate limit per visitor (LIMIT); its workers.dev
address is turned off, so it answers only at api.noteshack.org, which is
connected to it once, in the dashboard (Settings → Domains & Routes)."""
import json, os, urllib.request, uuid

ACCOUNT = 'c047d9e1fea222a9db788c3e9a79cc37'
NAME = 'noteshack-api'
API = f'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/workers/scripts/{NAME}'
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')

METADATA = {
    'main_module': 'index.js',
    'compatibility_date': '2026-10-01',
    'bindings': [
        {'type': 'ai', 'name': 'AI'},
        # requests per visitor per minute (a paragraph batch is one request)
        {'type': 'ratelimit', 'name': 'LIMIT', 'namespace_id': '1001', 'simple': {'limit': 60, 'period': 60}},
    ],
    # nothing about requests is logged
    'observability': {'enabled': False},
}


def call(url, data=None, method='GET', kind='application/json'):
    req = urllib.request.Request(url, data=data, method=method, headers={'Content-Type': kind})
    if os.environ.get('CLOUDFLARE_API_TOKEN'):
        req.add_header('Authorization', 'Bearer ' + os.environ['CLOUDFLARE_API_TOKEN'])
    try:
        with urllib.request.urlopen(req) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        raise SystemExit(f'{method} {url}: {e.code} {e.read().decode(errors="replace")}')


def main():
    code = open(os.path.join(ROOT, 'worker', 'index.js'), 'rb').read()
    b = uuid.uuid4().hex
    parts = [
        ('metadata', 'blob', 'application/json', json.dumps(METADATA).encode()),
        ('index.js', 'index.js', 'application/javascript+module', code),
    ]
    body = b''
    for name, filename, kind, data in parts:
        body += (f'--{b}\r\nContent-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
                 f'Content-Type: {kind}\r\n\r\n').encode() + data + b'\r\n'
    body += f'--{b}--\r\n'.encode()
    r = call(API, body, 'PUT', 'multipart/form-data; boundary=' + b)
    print('deployed', NAME, r['result'].get('etag', ''))
    call(API + '/subdomain', json.dumps({'enabled': False, 'previews_enabled': False}).encode(), 'POST')
    print('workers.dev address off')


if __name__ == '__main__':
    main()
