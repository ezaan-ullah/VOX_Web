import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from conftest import FakeEncoder, random_probe, wav_bytes
from vox import config, db
from vox.service import Dashboard


def make_client(Session, with_probe=True):
    if with_probe:
        random_probe(10).save(config.PROBES_DIR / "original" / "genre.pt")
        with Session() as s:
            m = s.scalar(select(db.Model).where(db.Model.code == "original"))
            t = s.scalar(select(db.Task).where(db.Task.code == "genre"))
            s.add(db.Probe(model_id=m.id, task_id=t.id, path="original/genre.pt"))
            s.commit()
    import app as app_module
    dash = Dashboard(Session, encoder_factory=FakeEncoder).load()
    return TestClient(app_module.create_app(Session=Session, dashboard=dash, serve_frontend=False))


def test_catalogue_endpoints(env):
    Session, _ = env
    with make_client(Session) as c:
        assert c.get("/api/health").json()["models_loaded"] == ["original"]
        models = {m["code"]: m for m in c.get("/api/models").json()}
        assert models["original"]["loaded"] and not models["further"]["loaded"]
        tasks = {t["code"]: t for t in c.get("/api/tasks").json()}
        assert set(tasks) == {"genre", "tagging", "instrument", "pitch"}       # FMA-small is not in the demo
        assert tasks["genre"]["ready"]["original"]["ready"]
        assert not tasks["tagging"]["ready"]["original"]["ready"]
        assert c.get("/api/samples").json()[0]["code"] == "volatile_reaction"


def test_predict_upload_returns_real_shape_and_deletes_file(env):
    Session, tmp = env
    with make_client(Session) as c:
        r = c.post("/api/predict", data={"task": "genre", "model": "original"},
                   files={"file": ("song.wav", wav_bytes(seconds=8), "audio/wav")})
        assert r.status_code == 200, r.text
        body = r.json()
        res = body["results"][0]
        assert res["status"] == "ok" and len(res["top"]) == 5 and len(res["scores"]) == 10
        assert abs(sum(res["scores"]) - 1) < 1e-3
        assert body["input"]["analyzed_s"] == 6.08 and body["input"]["channels"] == 2
        assert list((tmp / "uploads").glob("*")) == []                       # upload deleted (FR-15)
    with Session() as s:
        logs = s.scalars(select(db.InferenceLog)).all()
        assert len(logs) == 1 and logs[0].status == "ok" and logs[0].source == "upload"


def test_predict_without_probe_is_honest(env):
    Session, _ = env
    with make_client(Session) as c:
        res = c.post("/api/predict", data={"task": "tagging", "model": "original"},
                     files={"file": ("a.wav", wav_bytes(), "audio/wav")}).json()["results"][0]
        assert res["status"] == "no_probe" and "top" not in res and res["embedding"]


def test_compare_includes_untrained_model_as_unavailable(env):
    Session, _ = env
    with make_client(Session) as c:
        body = c.post("/api/predict", data={"task": "genre", "model": "original", "compare": "true"},
                      files={"file": ("a.wav", wav_bytes(), "audio/wav")}).json()
        statuses = {r["model"]: r["status"] for r in body["results"]}
        assert statuses == {"original": "ok", "further": "model_unavailable"}


@pytest.mark.parametrize("name,payload,msg", [
    ("a.flac", b"xxxx", "Unsupported file format"),
    ("a.mp3", b"garbage" * 50, "could not be read"),
])
def test_predict_rejects_bad_files(env, name, payload, msg):
    Session, tmp = env
    with make_client(Session) as c:
        r = c.post("/api/predict", data={"task": "genre", "model": "original"},
                   files={"file": (name, payload, "application/octet-stream")})
        assert r.status_code == 422 and msg in r.json()["detail"]
        assert list((tmp / "uploads").glob("*")) == []


def test_predict_rejects_oversized_upload(env, monkeypatch):
    Session, _ = env
    monkeypatch.setattr(config, "MAX_UPLOAD_BYTES", 1000)
    with make_client(Session) as c:
        r = c.post("/api/predict", data={"task": "genre", "model": "original"},
                   files={"file": ("a.wav", wav_bytes(), "audio/wav")})
        assert r.status_code == 422 and "too large" in r.json()["detail"]


def test_results_music_score(env):
    Session, _ = env
    with Session() as s:
        ids = {m.code: m.id for m in s.scalars(select(db.Model))}
        tids = {t.code: t.id for t in s.scalars(select(db.Task))}
        for task, v in {"genre": 80, "tagging": 40, "instrument": 70, "pitch": 90}.items():
            s.add(db.EvaluationResult(model_id=ids["original"], task_id=tids[task], mean=v))
        s.add(db.EvaluationResult(model_id=ids["mert_v1_95m"], task_id=tids["genre"], mean=75))
        s.commit()
    with make_client(Session) as c:
        body = c.get("/api/results").json()
        by = {m["code"]: m for m in body["models"]}
        assert by["original"]["music_score"] == 70.0
        assert by["mert_v1_95m"]["music_score"] is None                        # incomplete -> no score
        assert [m["code"] for m in c.get("/api/results?group=reference").json()["models"]] == ["mert_v1_95m"]
