"""Settings for the backend. Every path can be overridden with an environment variable."""
import os
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

# Where model checkpoints and M2D's portable loader live (large files, kept out of git).
MODELS_DIR = Path(os.environ.get("VOX_MODELS_DIR", Path.home() / ".cache" / "vox" / "models"))
# Converted linear probes: probes/<model code>/<task code>.pt
PROBES_DIR = Path(os.environ.get("VOX_PROBES_DIR", REPO / "probes"))
# SQLite database with models, tasks, labels, probes, results, sample clips and the inference log.
DB_PATH = Path(os.environ.get("VOX_DB", REPO / "data" / "vox.db"))
# Uploads are stored here under random names and deleted after each prediction.
UPLOAD_DIR = Path(os.environ.get("VOX_UPLOAD_DIR", Path(tempfile.gettempdir()) / "vox_uploads"))
FRONTEND_DIR = REPO / "frontend"
SEED_FILE = Path(__file__).resolve().parent / "seed.json"

# Input rules from the report (FR-06, FR-08, FR-11).
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
ALLOWED_EXTENSIONS = {"wav", "mp3"}
SAMPLE_RATE = 16_000
WINDOW_SECONDS = 6.08          # one M2D input window
WINDOW_FRAMES = 608            # 10 ms frames in that window
UPLOAD_MAX_AGE_SECONDS = 10 * 60

# "cuda" if available, otherwise "cpu"; set VOX_DEVICE=cpu to force the CPU.
DEVICE = os.environ.get("VOX_DEVICE", "auto")
