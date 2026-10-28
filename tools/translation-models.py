"""Puts Mozilla's translation models on files.noteshack.org (Cloudflare R2),
and prints the MODELS table for js/translate.js.

For each language paired with English, both directions: the first model
Mozilla lists as released, from its registry. Each file is uploaded as
Mozilla publishes it (gzip) under translate/v1/<from>-<to>/, and its size and
SHA-256 go in the table, so the app checks every download.

    CLOUDFLARE_API_TOKEN=… python3 tools/translation-models.py es fr de pt it

The token needs R2 write access to the noteshack-files bucket. A new set of
models goes under a new folder (translate/v2/…), with HOST and the cache
name in js/translate.js changed to match, so a browser never mixes them.
Mozilla's models are under the MPL 2.0; its text goes up beside them."""
import hashlib, json, os, sys, urllib.request

ACCOUNT = 'c047d9e1fea222a9db788c3e9a79cc37'
BUCKET = 'noteshack-files'
FOLDER = 'translate/v1'
REGISTRY = 'https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/db/models.json'
PARTS = {'model': 'model', 'lexicalShortlist': 'lex', 'vocab': 'vocab'}


def get(url):
    with urllib.request.urlopen(url) as r:
        return r.read()


def put(key, data, kind):
    url = f'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/r2/buckets/{BUCKET}/objects/{key}'
    req = urllib.request.Request(url, data=data, method='PUT', headers={'Content-Type': kind})
    if os.environ.get('CLOUDFLARE_API_TOKEN'):
        req.add_header('Authorization', 'Bearer ' + os.environ['CLOUDFLARE_API_TOKEN'])
    with urllib.request.urlopen(req) as r:
        if not json.load(r).get('success'):
            raise SystemExit('upload failed: ' + key)


def main(langs):
    reg = json.loads(get(REGISTRY))
    table = []
    for lang in langs:
        for pair in (f'en-{lang}', f'{lang}-en'):
            model = next(m for m in reg['models'][pair] if (m.get('releaseStatus') or '').startswith('Release'))
            files = []
            for part, short in PARTS.items():
                path = model['files'][part]['path']
                data = get(reg['baseUrl'] + '/' + path)
                name = path.split('/')[-1]
                put(f'{FOLDER}/{pair}/{name}', data, 'application/gzip')
                files.append(f"{short}: ['{name}', {len(data)}, '{hashlib.sha256(data).hexdigest()}']")
                print('uploaded', pair, name, len(data) // 1024, 'KB', file=sys.stderr)
            table.append('    ' + pair.replace('-', '') + ': { ' + ', '.join(files) + ' },')
    put(f'{FOLDER}/LICENSE', open(os.path.join(os.path.dirname(__file__), '..', 'vendor', 'bergamot', 'LICENSE'), 'rb').read(), 'text/plain; charset=utf-8')
    print('\n'.join(table))


if __name__ == '__main__':
    main(sys.argv[1:] or ['es', 'fr', 'de', 'pt', 'it'])
