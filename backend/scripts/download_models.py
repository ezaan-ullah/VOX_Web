"""Downloads what the backend needs from the official M2D repository (nttcslab/m2d) into the
models folder (default ~/.cache/vox/models, override with VOX_MODELS_DIR):

  * the M2D/0.7 encoder weights (m2d_vit_base-80x608p16x16-221006-mr7_enconly, about 300 MB)
  * M2D's portable loader, examples/portable_m2d.py, at a pinned commit

Nothing is copied into this repository: the weights and the loader are NTT's, under their licence
(LICENSE.pdf in the M2D repository).

Usage:  python backend/scripts/download_models.py
"""
import sys
import urllib.request
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from vox import config  # noqa: E402

M2D_COMMIT = "3d0c4de9447c404a8d3f9f37e04f53bc902e09b3"
LOADER_URL = f"https://raw.githubusercontent.com/nttcslab/m2d/{M2D_COMMIT}/examples/portable_m2d.py"
WEIGHTS = {
    "m2d_vit_base-80x608p16x16-221006-mr7_enconly":
        "https://github.com/nttcslab/m2d/releases/download/v0.1.0/m2d_vit_base-80x608p16x16-221006-mr7_enconly.zip",
}


def fetch(url: str, dest: Path) -> None:
    print(f"Downloading {url}")
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(url) as r, open(tmp, "wb") as f:
        total = int(r.headers.get("Content-Length") or 0)
        done = 0
        while chunk := r.read(1 << 20):
            f.write(chunk)
            done += len(chunk)
            if total:
                print(f"\r  {done / total:6.1%} of {total / 1e6:.0f} MB", end="", flush=True)
    print()
    tmp.replace(dest)


def main() -> None:
    config.MODELS_DIR.mkdir(parents=True, exist_ok=True)
    loader = config.MODELS_DIR / "portable_m2d.py"
    if not loader.exists():
        fetch(LOADER_URL, loader)
    for name, url in WEIGHTS.items():
        if (config.MODELS_DIR / name).is_dir():
            print(f"Already present: {name}")
            continue
        archive = config.MODELS_DIR / f"{name}.zip"
        fetch(url, archive)
        with zipfile.ZipFile(archive) as z:
            z.extractall(config.MODELS_DIR)
        archive.unlink()
    print(f"Models are in {config.MODELS_DIR}")


if __name__ == "__main__":
    main()
