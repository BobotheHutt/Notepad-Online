"""Deploys Noteshack's online translator (worker/index.js) to Cloudflare
Workers as `noteshack-api`, answering at api.noteshack.org.

    CLOUDFLARE_API_TOKEN=… python3 tools/worker.py

Run by GitHub Actions (.github/workflows/worker.yml) when worker/ changes,
with the token in the repository's secrets. The token needs Account →
Workers Scripts → Edit, and for noteshack.org Zone → Workers Routes → Edit
and Zone → Zone → Read. The Worker gets Workers AI (the AI binding), rate
limits per visitor (LIMIT for translating, REPORTS for problem reports), the
daily spending cap on translating (BUDGET, the Durable Object Budget) and
the GitHub key reports are filed with (GITHUB_TOKEN, from the repository
secret NOTESHACK_ISSUES_TOKEN: a fine-grained token for this repository
only, Issues read and write). It answers at api.noteshack.org, and its
workers.dev address is turned off."""
import json, os, urllib.parse, urllib.request, uuid

ACCOUNT = 'c047d9e1fea222a9db788c3e9a79cc37'
NAME = 'noteshack-api'
HOST = 'api.noteshack.org'
ZONE = 'noteshack.org'
CF = 'https://api.cloudflare.com/client/v4'
API = f'{CF}/accounts/{ACCOUNT}/workers/scripts/{NAME}'
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')

METADATA = {
    'main_module': 'index.js',
    'compatibility_date': '2026-10-01',
    'bindings': [
        {'type': 'ai', 'name': 'AI'},
        # requests per visitor per minute (a paragraph batch is one request)
        {'type': 'ratelimit', 'name': 'LIMIT', 'namespace_id': '1001', 'simple': {'limit': 60, 'period': 60}},
        # problem reports per visitor per minute
        {'type': 'ratelimit', 'name': 'REPORTS', 'namespace_id': '1002', 'simple': {'limit': 3, 'period': 60}},
        # today's translation spending, for the daily cap
        {'type': 'durable_object_namespace', 'name': 'BUDGET', 'class_name': 'Budget'},
    ],
    # nothing about requests is logged
    'observability': {'enabled': False},
}
# the Durable Object classes, each added once (Cloudflare keeps the tag)
MIGRATION = {'new_tag': 'v1', 'new_sqlite_classes': ['Budget']}


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
    if os.environ.get('NOTESHACK_ISSUES_TOKEN'):
        METADATA['bindings'].append({'type': 'secret_text', 'name': 'GITHUB_TOKEN', 'text': os.environ['NOTESHACK_ISSUES_TOKEN']})
    else:
        METADATA['keep_bindings'] = ['secret_text']
    scripts = call(f'{CF}/accounts/{ACCOUNT}/workers/scripts')['result']
    if next((s.get('migration_tag') for s in scripts if s['id'] == NAME), None) != MIGRATION['new_tag']:
        METADATA['migrations'] = MIGRATION
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
    zone = call(f'{CF}/zones?name=' + urllib.parse.quote(ZONE))['result'][0]['id']
    call(f'{CF}/accounts/{ACCOUNT}/workers/domains', json.dumps({'hostname': HOST, 'service': NAME, 'environment': 'production', 'zone_id': zone}).encode(), 'PUT')
    print('answering at', HOST)


if __name__ == '__main__':
    main()
