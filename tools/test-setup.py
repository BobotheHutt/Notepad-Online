"""Gets what the tests need from outside the repository into tests/.fixtures/
(not committed), for a machine whose network cannot reach the sites the app
uses (as in Claude's cloud sessions):

- tests/.fixtures/fontsource/: the Fontsource fonts the app downloads from
  jsDelivr, taken from npm instead. Point NOTESHACK_FONTS at it.
- tests/.fixtures/files/: the translation models and Noto fonts from
  files.noteshack.org, taken from the R2 bucket through Cloudflare's API
  (the session's Cloudflare secret answers for that path). The tests look
  there by default.

    python3 tools/test-setup.py
    NOTESHACK_FONTS=tests/.fixtures/fontsource npx playwright test …

Files already there are skipped, so it can be run again after a change."""
import io, json, os, re, subprocess, tarfile, tempfile, urllib.request

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
OUT = os.path.join(ROOT, 'tests', '.fixtures')
ACCOUNT = 'c047d9e1fea222a9db788c3e9a79cc37'
R2 = f'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/r2/buckets/noteshack-files/objects/'

# the fonts js/fonts.js can fetch from Fontsource
FONTSOURCE = ['arimo', 'caladea', 'carlito', 'cousine', 'eb-garamond', 'fira-sans', 'gelasio', 'ibm-plex-sans', 'inter', 'lato',
              'libre-baskerville', 'libre-franklin', 'lora', 'merriweather', 'montserrat', 'mulish', 'noto-sans', 'noto-serif', 'nunito',
              'open-sans', 'poppins', 'pt-sans', 'pt-serif', 'raleway', 'roboto', 'roboto-slab', 'source-sans-3', 'source-serif-4',
              'tinos', 'ubuntu', 'work-sans']


def fontsource():
    with tempfile.TemporaryDirectory() as tmp:
        for name in FONTSOURCE:
            dest = os.path.join(OUT, 'fontsource', name)
            if os.path.isdir(dest):
                continue
            tgz = subprocess.run(['npm', 'pack', '--silent', '@fontsource/' + name], cwd=tmp, capture_output=True, text=True, check=True).stdout.split()[-1]
            with tarfile.open(os.path.join(tmp, tgz)) as tar:
                for m in tar.getmembers():
                    rel = m.name.split('/', 1)[1]
                    if m.isfile() and (rel.startswith('files/') or rel == 'metadata.json'):
                        path = os.path.join(dest, rel)
                        os.makedirs(os.path.dirname(path), exist_ok=True)
                        with open(path, 'wb') as f:
                            f.write(tar.extractfile(m).read())
            print('fontsource', name)


def remote():
    keys = []
    translate = open(os.path.join(ROOT, 'js', 'translate.js')).read()
    for pair, files in re.findall(r"^\s+(\w{4}): \{(.*?)\},?$", translate, re.M):
        keys += [f'translate/v1/{pair[:2]}-{pair[2:]}/{f}' for f in re.findall(r"\['([^']+)', \d+", files)]
    shaping = open(os.path.join(ROOT, 'js', 'shaping.js')).read()
    for fam, body in re.findall(r"(Noto\w+): \{([^}]*)\}", shaping):
        keys += [f'fonts/v1/{fam}/{f}' for f in re.findall(r"\['([^']+)', \d+", body)]
    for key in keys:
        path = os.path.join(OUT, 'files', key)
        if os.path.exists(path):
            continue
        req = urllib.request.Request(R2 + key)
        if os.environ.get('CLOUDFLARE_API_TOKEN'):
            req.add_header('Authorization', 'Bearer ' + os.environ['CLOUDFLARE_API_TOKEN'])
        with urllib.request.urlopen(req) as r:
            data = r.read()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'wb') as f:
            f.write(data)
        print('file', key)


if __name__ == '__main__':
    fontsource()
    remote()
