import base64, gzip, hashlib, pathlib, subprocess
root = pathlib.Path(__file__).parent
encoded = ''.join((root / f'patch-{i}.txt').read_text().strip() for i in range(1, 6))
patch = gzip.decompress(base64.b64decode(encoded, validate=True))
assert hashlib.sha256(patch).hexdigest() == '0f583d8cc92271aee514e23cb23f9d34fb9793f22bbb11a127947308a46fef93'
path = pathlib.Path('evidence/source.patch')
path.parent.mkdir(exist_ok=True)
path.write_bytes(patch)
subprocess.run(['git', 'apply', '--check', str(path)], check=True)
subprocess.run(['git', 'apply', '--index', str(path)], check=True)
subprocess.run(['cargo', 'fmt', '--all', '--', '--config', 'newline_style=Unix'], check=True)
subprocess.run(['git', 'add', 'crates/loomtv-playback/src/mpv', 'apps/desktop-tauri/src-tauri/src/window_host/macos.rs'], check=True)
fix = pathlib.Path('evidence/fix.patch')
fix.write_bytes((root / 'fix.patch').read_text().encode('utf-8'))
subprocess.run(['git', '-c', 'core.autocrlf=false', 'apply', '--check', str(fix)], check=True)
subprocess.run(['git', '-c', 'core.autocrlf=false', 'apply', '--index', str(fix)], check=True)
