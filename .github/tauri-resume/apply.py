import base64, gzip, hashlib, pathlib, subprocess
root = pathlib.Path(__file__).parent
encoded = ''.join((root / f'patch-{i}.txt').read_text().strip() for i in range(1, 5))
patch = gzip.decompress(base64.b64decode(encoded, validate=True))
assert hashlib.sha256(patch).hexdigest() == '2bbbd9ff5903007ce0e521bfa0dbc2fddbc6b5cc83eae85bcf3faab173d83747'
path = pathlib.Path('/tmp/loomtv-storage-reviewed.patch')
path.write_bytes(patch)
subprocess.run(['git', 'apply', '--check', str(path)], check=True)
subprocess.run(['git', 'apply', '--index', str(path)], check=True)
