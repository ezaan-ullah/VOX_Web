import numpy as np
import pytest
import torch

from conftest import random_probe, wav_bytes
from vox import config
from vox.audio import AudioError, check_upload, load_window
from vox.probes import Probe, convert_evar


def test_window_is_exactly_6_08_s_mono_16k(tmp_path):
    p = tmp_path / "long.wav"
    p.write_bytes(wav_bytes(seconds=10, rate=44100, channels=2))
    clip = load_window(p)
    assert clip.samples.shape == (97280,) and clip.samples.dtype == np.float32
    assert clip.channels == 2 and clip.sample_rate == 44100
    assert not clip.padded and abs(clip.analyzed_s - 6.08) < 1e-3
    assert abs(clip.duration_s - 10) < 0.01


def test_short_clip_is_zero_padded(tmp_path):
    p = tmp_path / "short.wav"
    p.write_bytes(wav_bytes(seconds=2, rate=16000, channels=1))
    clip = load_window(p)
    assert clip.padded and abs(clip.analyzed_s - 2.0) < 1e-3
    assert np.all(clip.samples[2 * 16000 + 10:] == 0)


def test_unreadable_file_gives_visitor_message(tmp_path):
    p = tmp_path / "broken.mp3"
    p.write_bytes(b"not audio at all" * 100)
    with pytest.raises(AudioError, match="could not be read"):
        load_window(p)


def test_upload_checks():
    assert check_upload("a.MP3", 10) == "mp3"
    with pytest.raises(AudioError, match="Unsupported"):
        check_upload("a.flac", 10)
    with pytest.raises(AudioError, match="too large"):
        check_upload("a.wav", config.MAX_UPLOAD_BYTES + 1)


def test_probe_round_trip_and_probabilities(tmp_path):
    p = random_probe(10)
    p.save(tmp_path / "p.pt")
    q = Probe.load(tmp_path / "p.pt")
    probs = q.probabilities(np.random.default_rng(1).standard_normal(3840).astype(np.float32))
    assert probs.shape == (10,) and abs(probs.sum() - 1) < 1e-6
    tags = random_probe(50, multi_label=True).probabilities(np.ones(3840, np.float32))
    assert tags.shape == (50,) and np.all((tags > 0) & (tags < 1))


def test_convert_evar_linear_probe(tmp_path):
    from sklearn.preprocessing import LabelBinarizer, StandardScaler
    X = np.random.default_rng(0).standard_normal((20, 3840))
    scaler = StandardScaler().fit(X)
    enc = LabelBinarizer().fit(["blues", "jazz", "rock"])
    torch.save({"state_dict": {"mlp.0.weight": torch.randn(3, 3840), "mlp.0.bias": torch.zeros(3)},
                "standard_scaler": scaler, "oh_enc": enc, "config": {}}, tmp_path / "weight_params.pth")
    probe = convert_evar(tmp_path / "weight_params.pth")
    assert probe.labels == ["blues", "jazz", "rock"] and not probe.multi_label
    assert np.allclose(probe.mean, scaler.mean_)


def test_convert_evar_rejects_mlp_and_missing_tag_names(tmp_path):
    torch.save({"state_dict": {"mlp.0.weight": torch.randn(8, 3840), "mlp.0.bias": torch.zeros(8),
                               "mlp.3.weight": torch.randn(3, 8), "mlp.3.bias": torch.zeros(3)},
                "standard_scaler": None, "oh_enc": None, "config": {}}, tmp_path / "mlp.pth")
    with pytest.raises(ValueError, match="linear probe"):
        convert_evar(tmp_path / "mlp.pth")
    torch.save({"state_dict": {"mlp.0.weight": torch.randn(50, 3840), "mlp.0.bias": torch.zeros(50)},
                "standard_scaler": None, "oh_enc": None, "config": {}}, tmp_path / "tags.pth")
    with pytest.raises(ValueError, match="labels"):
        convert_evar(tmp_path / "tags.pth")
    assert convert_evar(tmp_path / "tags.pth", labels=[f"t{i}" for i in range(50)]).multi_label
