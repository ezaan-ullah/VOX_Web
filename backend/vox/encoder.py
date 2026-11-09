"""The frozen M2D encoder, loaded with M2D's own portable loader (examples/portable_m2d.py).

The loader is not copied into this repository: scripts/download_models.py fetches it, at a pinned
commit, into the models folder, next to the checkpoints. It contains M2D's exact front-end
(16 kHz, 400-sample window, hop 160, 80 mels from 50 Hz to 8 kHz, AudioSet normalisation).
"""
import importlib.util
import sys
import time
from dataclasses import dataclass
from functools import lru_cache

import numpy as np
import torch

from . import config


def pick_device() -> torch.device:
    if config.DEVICE != "auto":
        return torch.device(config.DEVICE)
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def device_label(device: torch.device) -> str:
    if device.type == "cuda":
        return f"GPU ({torch.cuda.get_device_name(device)})"
    return "CPU"


@lru_cache(maxsize=1)
def _portable_module():
    path = config.MODELS_DIR / "portable_m2d.py"
    if not path.exists():
        raise FileNotFoundError(f"{path} is missing; run backend/scripts/download_models.py first.")
    spec = importlib.util.spec_from_file_location("portable_m2d", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["portable_m2d"] = module
    spec.loader.exec_module(module)
    return module


@dataclass
class Embedding:
    embedding: np.ndarray     # (3840,) clip embedding: mean of the frame features
    logmel_ms: float
    encoder_ms: float


class Encoder:
    """Wraps PortableM2D for one checkpoint. Loaded once at start-up, then reused."""

    def __init__(self, weight_file, device: torch.device | None = None):
        self.device = device or pick_device()
        portable = _portable_module()
        self.model = portable.PortableM2D(str(weight_file)).to(self.device).eval()
        self.frames = self.model.cfg.input_size[1]  # 608 for M2D/0.7

    @torch.no_grad()
    def embed(self, samples: np.ndarray) -> Embedding:
        """samples: float32 mono 16 kHz, one window long. Returns the 3,840-value clip embedding."""
        sync = torch.cuda.synchronize if self.device.type == "cuda" else (lambda: None)
        t0 = time.perf_counter()
        wave = torch.from_numpy(np.ascontiguousarray(samples)).float().unsqueeze(0).to(self.device)
        lms = self.model.to_normalized_feature(wave)          # (1, 1, 80, T); T = 609 for 6.08 s
        lms = lms[..., : self.frames]                         # exactly one 80 x 608 window
        if lms.shape[-1] < self.frames:
            lms = torch.nn.functional.pad(lms, (0, self.frames - lms.shape[-1]))
        sync()
        t1 = time.perf_counter()
        frames = self.model.encode_lms(lms)                   # (1, 38, 3840)
        emb = frames.mean(dim=1).squeeze(0).float().cpu().numpy()
        sync()
        t2 = time.perf_counter()
        return Embedding(emb, (t1 - t0) * 1000, (t2 - t1) * 1000)
