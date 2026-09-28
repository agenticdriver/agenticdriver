"""Install all language packages and run pure contract checks. No provider substitutes."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from python_package import prepare_python
from rust_package import prepare_rust, TOOLCHAIN

ROOT = Path(__file__).resolve().parent.parent
python_only = '--python-only' in sys.argv
rust_only = '--rust-only' in sys.argv
assert not (python_only and rust_only)
with tempfile.TemporaryDirectory(prefix='agenticdriver-packages-') as directory:
    root = Path(directory)
    if not rust_only:
        python, app = prepare_python(root)
        subprocess.run([python, '-m', 'unittest', 'discover', '-s', str(ROOT / 'clients/python/tests')], cwd=app, check=True)
    if not python_only:
        app, additions = prepare_rust(root)
        subprocess.run(['cargo', '+' + TOOLCHAIN, 'test', '--locked'], cwd=ROOT / 'clients/rust', env={**os.environ, **additions}, check=True)
    if not python_only and not rust_only:
        subprocess.run(['go', 'test', '-race', './...'], cwd=ROOT / 'clients/go', check=True)
print('Installed clients and pure contract checks passed. Real model execution is a separate explicit check.')
