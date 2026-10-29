"""Puts the Noto fonts on files.noteshack.org (Cloudflare R2), and prints the
FONTS table for js/shaping.js.

Saved PDFs write any script the matched fonts lack (Arabic, Hebrew, Indic
scripts, Thai, Chinese, Japanese, Korean, and Cyrillic, Greek or Vietnamese
where the matched font has no such letters) in Noto, embedding only the
letters used. The fonts are Google Fonts' static instances, as packaged on npm
by @expo-google-fonts; each is uploaded gzipped, with its OFL license beside it.

    CLOUDFLARE_API_TOKEN=… python3 tools/noto-fonts.py

New versions go under a new folder (fonts/v2/…), with HOST and the cache name
in js/shaping.js changed to match."""
import gzip, hashlib, io, json, os, subprocess, sys, tarfile, tempfile, urllib.request

ACCOUNT = 'c047d9e1fea222a9db788c3e9a79cc37'
BUCKET = 'noteshack-files'
FOLDER = 'fonts/v1'
# family (as in the file names) → npm package, styles
FAMILIES = {
    'NotoSans': ('noto-sans', ['Regular', 'Bold', 'Italic', 'BoldItalic']),
    'NotoSerif': ('noto-serif', ['Regular', 'Bold', 'Italic', 'BoldItalic']),
    'NotoSansMono': ('noto-sans-mono', ['Regular', 'Bold']),
    'NotoSansArabic': ('noto-sans-arabic', ['Regular', 'Bold']),
    'NotoSansHebrew': ('noto-sans-hebrew', ['Regular', 'Bold']),
    'NotoSansDevanagari': ('noto-sans-devanagari', ['Regular', 'Bold']),
    'NotoSansBengali': ('noto-sans-bengali', ['Regular', 'Bold']),
    'NotoSansTamil': ('noto-sans-tamil', ['Regular', 'Bold']),
    'NotoSansTelugu': ('noto-sans-telugu', ['Regular', 'Bold']),
    'NotoSansGujarati': ('noto-sans-gujarati', ['Regular', 'Bold']),
    'NotoSansGurmukhi': ('noto-sans-gurmukhi', ['Regular', 'Bold']),
    'NotoSansThai': ('noto-sans-thai', ['Regular', 'Bold']),
    'NotoSansSC': ('noto-sans-sc', ['Regular', 'Bold']),
    'NotoSansTC': ('noto-sans-tc', ['Regular', 'Bold']),
    'NotoSansJP': ('noto-sans-jp', ['Regular', 'Bold']),
    'NotoSansKR': ('noto-sans-kr', ['Regular', 'Bold']),
}
EXPO = {'Regular': '400Regular', 'Bold': '700Bold', 'Italic': '400Regular_Italic', 'BoldItalic': '700Bold_Italic'}


def put(key, data, kind):
    url = f'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/r2/buckets/{BUCKET}/objects/{key}'
    req = urllib.request.Request(url, data=data, method='PUT', headers={'Content-Type': kind})
    if os.environ.get('CLOUDFLARE_API_TOKEN'):
        req.add_header('Authorization', 'Bearer ' + os.environ['CLOUDFLARE_API_TOKEN'])
    with urllib.request.urlopen(req) as r:
        if not json.load(r).get('success'):
            raise SystemExit('upload failed: ' + key)


def main():
    lines = []
    with tempfile.TemporaryDirectory() as tmp:
        for family, (pkg, styles) in FAMILIES.items():
            out = subprocess.run(['npm', 'pack', '--silent', '@expo-google-fonts/' + pkg], cwd=tmp, capture_output=True, text=True, check=True).stdout.split()[-1]
            tar = tarfile.open(os.path.join(tmp, out))
            files = []
            for style in styles:
                ttf = tar.extractfile(f'package/{EXPO[style]}/{family}_{EXPO[style]}.ttf').read()
                gz = gzip.compress(ttf, 9, mtime=0)
                name = f'{family}-{style}.ttf.gz'
                put(f'{FOLDER}/{family}/{name}', gz, 'application/gzip')
                files.append(f"{style}: ['{name}', {len(gz)}, '{hashlib.sha256(gz).hexdigest()}']")
                print('uploaded', name, len(gz) // 1024, 'KB', file=sys.stderr)
            put(f'{FOLDER}/{family}/OFL.txt', tar.extractfile('package/LICENSE_FONT').read(), 'text/plain; charset=utf-8')
            lines.append(f'    {family}: {{ ' + ', '.join(files) + ' },')
    print('\n'.join(lines))


if __name__ == '__main__':
    main()
