"""Linear probes: the one-layer classifiers trained on frozen embeddings.

EVAR's lineareval.py (with saving switched on) writes `weight_params.pth`, which holds the linear
layer plus a pickled scikit-learn StandardScaler and LabelBinarizer. Loading pickles can run code,
so `convert_evar` reads that file once, on the developer's machine, and writes a plain tensor file
that the server loads with torch.load(weights_only=True).
"""
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch


@dataclass
class Probe:
    weight: np.ndarray        # (classes, 3840)
    bias: np.ndarray          # (classes,)
    mean: np.ndarray          # (3840,) standardisation fitted on the probe's training embeddings
    scale: np.ndarray         # (3840,)
    labels: list[str]
    multi_label: bool         # tagging: sigmoid per tag; otherwise softmax over classes

    @classmethod
    def load(cls, path) -> "Probe":
        d = torch.load(str(path), map_location="cpu", weights_only=True)
        return cls(d["weight"].numpy(), d["bias"].numpy(), d["mean"].numpy(), d["scale"].numpy(),
                   list(d["labels"]), bool(d["multi_label"]))

    def save(self, path) -> None:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        torch.save({"weight": torch.from_numpy(self.weight), "bias": torch.from_numpy(self.bias),
                    "mean": torch.from_numpy(self.mean), "scale": torch.from_numpy(self.scale),
                    "labels": list(self.labels), "multi_label": self.multi_label}, str(path))

    def probabilities(self, embedding: np.ndarray) -> np.ndarray:
        x = (embedding.astype(np.float64) - self.mean) / self.scale
        logits = self.weight.astype(np.float64) @ x + self.bias
        if self.multi_label:
            return 1.0 / (1.0 + np.exp(-logits))
        e = np.exp(logits - logits.max())
        return e / e.sum()

    def predict(self, embedding: np.ndarray):
        """Returns (probabilities in label order, milliseconds)."""
        t0 = time.perf_counter()
        p = self.probabilities(embedding)
        return p, (time.perf_counter() - t0) * 1000


def convert_evar(weight_params_path, labels: list[str] | None = None, multi_label: bool | None = None) -> Probe:
    """Converts an EVAR `weight_params.pth` (linear probe, standard scaler on) into a Probe.

    For single-label tasks the class names come from the saved LabelBinarizer. For multi-label
    tagging EVAR saves no names, so pass `labels` in the column order of EVAR's metadata.
    """
    ckpt = torch.load(str(weight_params_path), map_location="cpu", weights_only=False)  # trusted local file
    state = ckpt["state_dict"]
    keys = sorted(k for k in state if k.endswith(".weight"))
    if keys != ["mlp.0.weight"]:
        raise ValueError(f"Expected a linear probe (one layer), found layers {keys}; train with hidden=().")
    weight = state["mlp.0.weight"].float().numpy()
    bias = state["mlp.0.bias"].float().numpy()

    scaler = ckpt.get("standard_scaler")
    if scaler is not None:
        mean, scale = scaler.mean_.astype(np.float32), scaler.scale_.astype(np.float32)
    else:
        mean, scale = np.zeros(weight.shape[1], np.float32), np.ones(weight.shape[1], np.float32)

    enc = ckpt.get("oh_enc")
    if enc is not None and labels is None:
        labels = [str(c) for c in enc.classes_]
    if labels is None:
        raise ValueError("This probe has no saved class names (multi-label); pass labels in EVAR's column order.")
    if len(labels) != weight.shape[0]:
        raise ValueError(f"{len(labels)} labels given, but the probe has {weight.shape[0]} outputs.")
    if multi_label is None:
        multi_label = enc is None
    return Probe(weight, bias, mean, scale, labels, multi_label)
