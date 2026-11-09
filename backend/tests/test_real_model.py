"""Runs the real M2D/0.7 encoder; skipped if download_models.py has not been run."""
from pathlib import Path

import numpy as np
import pytest

from vox import config

CKPT = config.MODELS_DIR / "m2d_vit_base-80x608p16x16-221006-mr7_enconly" / "checkpoint-300.pth"
pytestmark = pytest.mark.skipif(not (CKPT.exists() and (config.MODELS_DIR / "portable_m2d.py").exists()),
                                reason="M2D weights not downloaded")


def test_real_encoder_gives_one_3840_embedding():
    from vox.encoder import Encoder
    enc = Encoder(CKPT)
    assert enc.frames == 608
    t = np.arange(97280) / 16000
    out = enc.embed((0.3 * np.sin(2 * np.pi * 440 * t)).astype(np.float32))
    assert out.embedding.shape == (3840,) and np.isfinite(out.embedding).all()
    silence = enc.embed(np.zeros(97280, np.float32)).embedding
    assert not np.allclose(out.embedding, silence)        # different audio, different embedding
