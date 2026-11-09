"""FastAPI backend of the M2D Music Dashboard (report Chapter 4 and Section 6.1.4).

Run from the repository root:
    python -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
"""
import asyncio
import logging
import sys
import time
import uuid
from contextlib import asynccontextmanager, suppress
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select

sys.path.insert(0, str(Path(__file__).resolve().parent))
from vox import config, db  # noqa: E402
from vox.audio import AudioError, check_upload, load_window  # noqa: E402
from vox.service import Dashboard, safe_join  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("vox")


class Worker:
    """One inference at a time, so a burst of requests cannot exhaust GPU memory (Section 4.4.2).
    Requests wait in line; each response reports how many were ahead of it."""

    def __init__(self):
        self.lock = asyncio.Lock()
        self.waiting = 0

    async def submit(self, fn, *args):
        ahead = self.waiting + (1 if self.lock.locked() else 0)
        self.waiting += 1
        try:
            await self.lock.acquire()
        finally:
            self.waiting -= 1
        try:
            return await run_in_threadpool(fn, *args), ahead
        finally:
            self.lock.release()


async def sweep_uploads(stop: asyncio.Event):
    """Deletes any upload older than ten minutes, in case a request died midway (Section 4.4.4)."""
    while not stop.is_set():
        cutoff = time.time() - config.UPLOAD_MAX_AGE_SECONDS
        for f in config.UPLOAD_DIR.glob("*"):
            with suppress(OSError):
                if f.stat().st_mtime < cutoff:
                    f.unlink()
        with suppress(asyncio.TimeoutError):
            await asyncio.wait_for(stop.wait(), timeout=60)


def create_app(Session=None, dashboard: Dashboard | None = None, serve_frontend: bool = True) -> FastAPI:
    state = {}

    @asynccontextmanager
    async def lifespan(app):
        config.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        S = Session or db.init(db.make_engine())
        state["Session"] = S
        state["dash"] = dashboard or await run_in_threadpool(lambda: Dashboard(S).load())
        state["worker"] = Worker()
        stop = asyncio.Event()
        sweeper = asyncio.create_task(sweep_uploads(stop))
        yield
        stop.set()
        await sweeper

    app = FastAPI(title="M2D Music Dashboard", lifespan=lifespan)

    def task_dict(t: db.Task, dash: Dashboard, models) -> dict:
        return {"code": t.code, "name": t.name, "dataset": t.dataset, "size": t.size_label, "metric": t.metric,
                "multi_label": t.multi_label, "threshold": t.threshold, "note": t.note,
                "ready": {m.code: dash.available(m.code, t.code) for m in models}}

    @app.get("/api/health")
    def health():
        dash = state["dash"]
        return {"status": "ok", "device": dash.device, "models_loaded": sorted(dash.encoders),
                "probes_loaded": len(dash.probes)}

    @app.get("/api/models")
    def models():
        dash = state["dash"]
        with state["Session"]() as s:
            rows = s.scalars(select(db.Model).where(db.Model.kind == "m2d").order_by(db.Model.sort_order)).all()
            return [{"code": m.code, "name": m.display_name, "detail": m.description,
                     "loaded": m.code in dash.encoders, "reason": dash.load_errors.get(m.code, "")} for m in rows]

    @app.get("/api/tasks")
    def tasks():
        dash = state["dash"]
        with state["Session"]() as s:
            ms = s.scalars(select(db.Model).where(db.Model.kind == "m2d")).all()
            ts = s.scalars(select(db.Task).where(db.Task.in_demo).order_by(db.Task.sort_order)).all()
            return [task_dict(t, dash, ms) for t in ts]

    @app.get("/api/samples")
    def samples():
        with state["Session"]() as s:
            return [{"code": c.code, "title": c.title, "licence": c.licence, "attribution": c.attribution,
                     "source_label": c.source_label, "url": f"/api/samples/{c.code}/audio",
                     "filename": Path(c.file_path).name}
                    for c in s.scalars(select(db.SampleClip).order_by(db.SampleClip.id))]

    def sample_path(code: str) -> tuple[Path, db.SampleClip]:
        with state["Session"]() as s:
            c = s.scalar(select(db.SampleClip).where(db.SampleClip.code == code))
        if c is None:
            raise HTTPException(404, "Unknown sample clip.")
        p = safe_join(config.FRONTEND_DIR, c.file_path)
        if not p.exists():
            raise HTTPException(404, "Sample file missing on the server.")
        return p, c

    @app.get("/api/samples/{code}/audio")
    def sample_audio(code: str):
        p, _ = sample_path(code)
        return FileResponse(p)

    @app.get("/api/results")
    def results(group: str = "all"):
        with state["Session"]() as s:
            q = select(db.Model).order_by(db.Model.sort_order)
            if group != "all":
                q = q.where(db.Model.group == group)
            ms = s.scalars(q).all()
            ts = s.scalars(select(db.Task).order_by(db.Task.sort_order)).all()
            rows = s.scalars(select(db.EvaluationResult)).all()
            by = {(r.model_id, r.task_id): r for r in rows}
            music = [t for t in ts if t.in_music_score]
            out_models = []
            for m in ms:
                cells = {t.code: _result(by.get((m.id, t.id))) for t in ts}
                vals = [by[(m.id, t.id)].mean for t in music if (m.id, t.id) in by]
                score = round(sum(vals) / len(vals), 2) if music and len(vals) == len(music) else None
                if any(cells.values()):
                    out_models.append({"code": m.code, "name": m.display_name, "group": m.group,
                                       "music_score": score, "results": cells})
            return {"tasks": [{"code": t.code, "name": t.name, "dataset": t.dataset, "metric": t.metric,
                               "in_music_score": t.in_music_score, "note": t.note} for t in ts],
                    "models": out_models}

    @app.post("/api/predict")
    async def predict(task: str = Form(...), model: str = Form("further"), compare: bool = Form(False),
                      sample: str | None = Form(None), file: UploadFile | None = File(None)):
        dash, worker = state["dash"], state["worker"]
        with state["Session"]() as s:
            t = s.scalar(select(db.Task).where(db.Task.code == task, db.Task.in_demo))
            m = s.scalar(select(db.Model).where(db.Model.code == model, db.Model.kind == "m2d"))
            others = s.scalars(select(db.Model).where(db.Model.kind == "m2d", db.Model.code != model)).all()
        if t is None or m is None:
            raise HTTPException(400, "Unknown task or model.")
        run_models = [m] + (others[:1] if compare else [])

        upload_path, source, started = None, "sample" if sample else "upload", time.perf_counter()
        status, clip = "error", None
        try:
            if sample:
                path, c = sample_path(sample)
                name = Path(c.file_path).name
            elif file is not None:
                name = file.filename or "upload"
                ext = check_upload(name, 0)
                upload_path = config.UPLOAD_DIR / f"{uuid.uuid4().hex}.{ext}"
                size = 0
                with open(upload_path, "wb") as f:
                    while chunk := await file.read(1 << 20):
                        size += len(chunk)
                        check_upload(name, size)          # stop as soon as it passes 10 MB
                        f.write(chunk)
                path = upload_path
            else:
                raise AudioError("Add a WAV or MP3 clip first.")

            clip = await run_in_threadpool(load_window, path)

            def job():
                return [dash.run(mm, t, clip) for mm in run_models]

            outputs, ahead = await worker.submit(job)
            status = "ok" if all(o["status"] == "ok" for o in outputs) else outputs[0]["status"]
            return {
                "task": {"code": t.code, "name": t.name, "multi_label": t.multi_label, "note": t.note},
                "input": {"name": name, "source": source, "duration_s": round(clip.duration_s, 2),
                          "sample_rate": clip.sample_rate, "channels": clip.channels,
                          "analyzed_s": round(clip.analyzed_s, 2), "padded": clip.padded,
                          "decode_ms": round(clip.decode_ms, 1)},
                "queue_position": ahead,
                "results": outputs,
                "upload": "Deleted after the prediction" if upload_path else "Bundled sample clip",
            }
        except AudioError as exc:
            status = "rejected"
            return JSONResponse(status_code=422, content={"detail": str(exc)})
        finally:
            if upload_path is not None:
                with suppress(OSError):
                    upload_path.unlink()
            try:
                with state["Session"]() as s:
                    s.add(db.InferenceLog(task_code=task, model_code=model + ("+compare" if compare else ""),
                                          source=source, duration_s=clip.duration_s if clip else None,
                                          device=dash.device, latency_ms=(time.perf_counter() - started) * 1000,
                                          status=status))
                    s.commit()
            except Exception:
                log.exception("Could not write the inference log")

    if serve_frontend and config.FRONTEND_DIR.exists():
        app.mount("/", StaticFiles(directory=config.FRONTEND_DIR, html=True), name="frontend")
    return app


def _result(r):
    if r is None:
        return None
    return {"mean": r.mean, "std": r.std, "ci_low": r.ci_low, "ci_high": r.ci_high, "n_seeds": r.n_seeds}


app = create_app()
