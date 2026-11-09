"""Decoding and the single 6.08-s input window (report FR-11, Table 5.2)."""
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
import torchaudio.functional as AF

from . import config


class AudioError(ValueError):
    """Raised with a message that can be shown to the visitor as is."""


@dataclass
class ClipWindow:
    samples: np.ndarray       # float32 mono at 16 kHz, exactly one window long
    duration_s: float         # length of the whole file
    sample_rate: int          # sample rate of the file
    channels: int
    analyzed_s: float         # audio actually analysed (≤ 6.08 s)
    padded: bool              # True if the clip was shorter than one window
    decode_ms: float


def check_upload(filename: str, size: int) -> str:
    """Server-side checks of type and size; returns the lower-case extension."""
    ext = Path(filename or "").suffix.lower().lstrip(".")
    if ext not in config.ALLOWED_EXTENSIONS:
        raise AudioError("Unsupported file format. Please use WAV or MP3.")
    if size > config.MAX_UPLOAD_BYTES:
        raise AudioError("File too large (maximum 10 MB).")
    return ext


def load_window(path, seconds: float = config.WINDOW_SECONDS) -> ClipWindow:
    """Reads the first `seconds` of a file as 16 kHz mono, zero-padded to exactly one window."""
    t0 = time.perf_counter()
    try:
        with sf.SoundFile(str(path)) as f:
            rate, channels, total = f.samplerate, f.channels, f.frames
            wanted = int(np.ceil(seconds * rate))
            data = f.read(frames=wanted, dtype="float32", always_2d=True)
    except Exception as exc:  # corrupt, truncated or not really audio
        raise AudioError("The file could not be read.") from exc
    if data.size == 0:
        raise AudioError("The file could not be read.")

    mono = torch.from_numpy(data.mean(axis=1))
    if rate != config.SAMPLE_RATE:
        mono = AF.resample(mono, rate, config.SAMPLE_RATE)
    target = int(round(seconds * config.SAMPLE_RATE))
    analyzed = min(len(mono), target) / config.SAMPLE_RATE
    out = np.zeros(target, dtype=np.float32)
    out[: min(len(mono), target)] = mono[:target].numpy()

    duration = total / rate if total and total > 0 else len(data) / rate
    return ClipWindow(out, float(duration), int(rate), int(channels), float(analyzed),
                      analyzed < seconds - 1e-3, (time.perf_counter() - t0) * 1000)
