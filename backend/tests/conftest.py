import io
import sys
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from vox import config, db  # noqa: E402
from vox.encoder import Embedding  # noqa: E402
from vox.probes import Probe  # noqa: E402


class FakeEncoder:
    """Stands in for M2D in tests: a deterministic 3,840-value embedding from the audio."""

    def __init__(self, path, device=None):
        self.path = path

    def embed(self, samples):
        rng = np.random.default_rng(int(abs(samples).sum() * 1000) % 2**32)
        return Embedding(rng.standard_normal(3840).astype(np.float32), 1.0, 2.0)


def wav_bytes(seconds=2.0, rate=44100, channels=2, freq=440.0):
    t = np.arange(int(seconds * rate)) / rate
    x = 0.3 * np.sin(2 * np.pi * freq * t)
    data = np.stack([x] * channels, axis=1) if channels > 1 else x
    buf = io.BytesIO()
    sf.write(buf, data, rate, format="WAV")
    return buf.getvalue()


def random_probe(n_classes, multi_label=False, seed=0):
    rng = np.random.default_rng(seed)
    return Probe(rng.standard_normal((n_classes, 3840)).astype(np.float32) * 0.01,
                 np.zeros(n_classes, np.float32), np.zeros(3840, np.float32), np.ones(3840, np.float32),
                 [f"label{i}" for i in range(n_classes)], multi_label)


@pytest.fixture
def env(tmp_path, monkeypatch):
    """A temporary database, probe folder and upload folder."""
    monkeypatch.setattr(config, "PROBES_DIR", tmp_path / "probes")
    monkeypatch.setattr(config, "UPLOAD_DIR", tmp_path / "uploads")
    monkeypatch.setattr(config, "MODELS_DIR", tmp_path / "models")
    (tmp_path / "models").mkdir()
    (tmp_path / "models" / "fake.pth").write_bytes(b"x")
    Session = db.init(db.make_engine(tmp_path / "vox.db"))
    with Session() as s:
        from sqlalchemy import select
        s.scalar(select(db.Model).where(db.Model.code == "original")).checkpoint_path = "fake.pth"
        s.commit()
    return Session, tmp_path
