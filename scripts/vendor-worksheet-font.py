"""Refresh locally hosted Chinese-only Noto Sans HK variable WOFF2 subsets."""
import concurrent.futures
import pathlib
import re
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1] / 'server/app/fonts'
URL = 'https://fonts.googleapis.com/css2?family=Noto+Sans+HK:wght@400..700&display=swap'
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

def fetch(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA}), timeout=60).read()

def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    css = fetch(URL).decode()
    rules, downloads = [], {}
    # Restrict to Chinese glyphs and CJK punctuation; existing Latin fonts remain in use.
    allowed = [(0x2e80, 0x9fff), (0xf900, 0xfaff), (0xfe10, 0xfe1f),
               (0xfe30, 0xfe4f), (0xff00, 0xffef), (0x20000, 0x323af)]
    for rule in re.findall(r'@font-face\s*\{[^}]+\}', css):
        ranges = []
        for first, last in re.findall(r'U\+([0-9a-fA-F]+)(?:-([0-9a-fA-F]+))?', rule):
            a, b = int(first, 16), int(last or first, 16)
            for low, high in allowed:
                start, end = max(a, low), min(b, high)
                if start <= end:
                    ranges.append(f'U+{start:X}-{end:X}' if start != end else f'U+{start:X}')
        if not ranges:
            continue
        url = re.search(r'url\(([^)]+)\)', rule)[1]
        name = f'noto-sans-hk-{len(downloads)}.woff2'
        downloads[url] = name
        rule = rule.replace(url, './' + name).replace("'Noto Sans HK'", "'Worksheet Chinese'")
        rules.append(re.sub(r'unicode-range:[^;]+;', 'unicode-range: ' + ','.join(ranges) + ';', rule))
    def download(item):
        url, name = item
        (ROOT / name).write_bytes(fetch(url))
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(download, downloads.items()))
    (ROOT / 'worksheet-chinese.css').write_text('\n'.join(rules), encoding='utf-8')
    (ROOT / 'OFL.txt').write_bytes(fetch('https://raw.githubusercontent.com/google/fonts/main/ofl/notosanshk/OFL.txt'))
    print(f'Bundled {len(downloads)} subsets; {sum(p.stat().st_size for p in ROOT.glob("*.woff2")):,} bytes')

if __name__ == '__main__':
    main()
