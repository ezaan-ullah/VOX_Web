"""Loads the encoders and probes once and turns a clip into task outputs. Used by the web app."""
import base64
import logging
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from sqlalchemy import select

from . import config, db
from .audio import ClipWindow
from .encoder import Encoder, device_label, pick_device
from .probes import Probe

log = logging.getLogger("vox")


@dataclass
class Dashboard:
    Session: object
    encoder_factory: object = Encoder
    encoders: dict = field(default_factory=dict)       # model code -> Encoder
    probes: dict = field(default_factory=dict)         # (model code, task code) -> Probe
    load_errors: dict = field(default_factory=dict)    # model code -> reason it could not load
    device: str = ""

    def load(self) -> "Dashboard":
        """Loads every runnable model (kind "m2d" with a checkpoint on disk) and every registered probe."""
        device = pick_device()
        self.device = device_label(device)
        with self.Session() as s:
            for m in s.scalars(select(db.Model).where(db.Model.kind == "m2d")):
                if not m.checkpoint_path:
                    self.load_errors[m.code] = "This model has not been trained yet."
                    continue
                path = config.MODELS_DIR / m.checkpoint_path
                if not path.exists():
                    self.load_errors[m.code] = "Checkpoint not found on this server."
                    continue
                try:
                    self.encoders[m.code] = self.encoder_factory(path, device)
                    log.info("Loaded %s from %s", m.code, path)
                except Exception as exc:  # keep the server up; the Results tab still works
                    log.exception("Could not load %s", m.code)
                    self.load_errors[m.code] = f"The model could not be loaded ({exc.__class__.__name__})."
            self.reload_probes(s)
        return self

    def reload_probes(self, s) -> None:
        self.probes = {}
        rows = s.execute(select(db.Model.code, db.Task.code, db.Probe.path)
                         .join(db.Model, db.Probe.model_id == db.Model.id)
                         .join(db.Task, db.Probe.task_id == db.Task.id))
        for model_code, task_code, rel in rows:
            path = config.PROBES_DIR / rel
            try:
                self.probes[(model_code, task_code)] = Probe.load(path)
            except Exception:
                log.exception("Could not load probe %s", path)

    def available(self, model_code: str, task_code: str) -> dict:
        if model_code not in self.encoders:
            return {"ready": False, "reason": self.load_errors.get(model_code, "Model not available.")}
        if (model_code, task_code) not in self.probes:
            return {"ready": False, "reason": "No trained classifier for this task yet."}
        return {"ready": True, "reason": ""}

    def run(self, model: db.Model, task: db.Task, clip: ClipWindow) -> dict:
        """Encodes one clip with one model and applies that model's probe for the task."""
        out = {"model": model.code, "display_name": model.display_name, "device": self.device}
        encoder = self.encoders.get(model.code)
        if encoder is None:
            return {**out, "status": "model_unavailable",
                    "message": self.load_errors.get(model.code, "Model not available.")}

        emb = encoder.embed(clip.samples)
        out["embedding"] = encode_embedding(emb.embedding)
        timings = {"logmel_ms": round(emb.logmel_ms, 1), "encoder_ms": round(emb.encoder_ms, 1)}

        probe = self.probes.get((model.code, task.code))
        if probe is None:
            out.update(status="no_probe", timings=timings,
                       inference_ms=round(sum(timings.values()), 1),
                       message="The encoder ran, but there is no trained classifier for this task yet, "
                               "so its embedding cannot be turned into labels.")
            return out

        probs, probe_ms = probe.predict(emb.embedding)
        timings["probe_ms"] = round(probe_ms, 2)
        order = np.argsort(-probs)
        top = [{"label": probe.labels[i], "probability": round(float(probs[i]), 4)} for i in order[: task.top_k]]
        out.update(status="ok", timings=timings, inference_ms=round(sum(timings.values()), 1), top=top,
                   scores=[round(float(p), 4) for p in probs], labels=probe.labels)
        if task.multi_label:
            thr = task.threshold if task.threshold is not None else 0.5
            out["threshold"] = thr
            out["above_threshold"] = [probe.labels[i] for i in order if probs[i] >= thr]
        return out


def encode_embedding(v: np.ndarray) -> str:
    """The 3,840 values scaled to 0–255 and base64-encoded, for drawing the embedding strip."""
    lo, hi = float(v.min()), float(v.max())
    q = np.zeros_like(v, dtype=np.uint8) if hi <= lo else np.round((v - lo) / (hi - lo) * 255).astype(np.uint8)
    return base64.b64encode(q.tobytes()).decode("ascii")


def safe_join(base: Path, rel: str) -> Path:
    """Resolves rel under base and refuses paths that escape it."""
    p = (base / rel).resolve()
    if base.resolve() not in p.parents and p != base.resolve():
        raise ValueError("Path outside the allowed folder.")
    return p
