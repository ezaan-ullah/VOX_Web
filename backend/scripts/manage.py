"""Developer command line for the dashboard database (report UC-06, FR-17).
Every command validates all records before writing anything.

  python backend/scripts/manage.py init
      Creates data/vox.db with the models, tasks and sample clips in backend/vox/seed.json.

  python backend/scripts/manage.py register-probe --model original --task genre --evar PATH [--labels FILE]
      Converts a probe saved by EVAR (PATH = the folder holding weight_params.pth, or the file itself)
      into probes/<model>/<task>.pt and records it with its class names. --labels is needed for
      multi-label tagging: a text file with one tag per line, in EVAR's column order.

  python backend/scripts/manage.py import-results results.csv
      Imports evaluation scores. CSV columns: model,task,mean,std,ci_low,ci_high,n_seeds
      (model/task are codes, e.g. original,genre; scores in percent; std/ci/n_seeds may be empty).

  python backend/scripts/manage.py set-checkpoint --model further --path RELATIVE/PATH.pth
      Points a model at a checkpoint inside the models folder (e.g. the further pre-trained M2D).

  python backend/scripts/manage.py add-sample --code ID --file audio/x.mp3 --title T --licence L --attribution A [--source-label S]
      Registers an openly licensed sample clip (the file must be inside frontend/).

  python backend/scripts/manage.py status
      Lists models, probes, results and the size of the inference log.
"""
import argparse
import csv
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sqlalchemy import func, select  # noqa: E402

from vox import config, db  # noqa: E402
from vox.probes import convert_evar  # noqa: E402
from vox.service import safe_join  # noqa: E402


def session():
    return db.init(db.make_engine())()


def get(s, cls, code):
    row = s.scalar(select(cls).where(cls.code == code))
    if row is None:
        valid = ", ".join(s.scalars(select(cls.code)))
        sys.exit(f"Unknown {cls.__tablename__} '{code}'. Valid: {valid}")
    return row


def cmd_init(a):
    session().close()
    print(f"Database ready: {config.DB_PATH}")


def cmd_register_probe(a):
    src = Path(a.evar)
    src = src / "weight_params.pth" if src.is_dir() else src
    if not src.exists():
        sys.exit(f"Not found: {src}")
    labels = None
    if a.labels:
        labels = [l.strip() for l in Path(a.labels).read_text(encoding="utf-8").splitlines() if l.strip()]
    with session() as s:
        m, t = get(s, db.Model, a.model), get(s, db.Task, a.task)
        if m.kind != "m2d":
            sys.exit("Probes can only be registered for models that run in the demo (kind m2d).")
        probe = convert_evar(src, labels=labels, multi_label=t.multi_label)
        rel = f"{m.code}/{t.code}.pt"
        probe.save(config.PROBES_DIR / rel)
        row = s.scalar(select(db.Probe).where(db.Probe.model_id == m.id, db.Probe.task_id == t.id))
        if row is None:
            s.add(db.Probe(model_id=m.id, task_id=t.id, path=rel))
        else:
            row.path = rel
        t.labels = [db.Label(idx=i, name=n) for i, n in enumerate(probe.labels)]
        s.commit()
    print(f"Registered {rel}: {len(probe.labels)} classes ({'multi-label' if probe.multi_label else 'single-label'}). "
          "Restart the server to load it.")


def _num(v, field, line, required=False):
    v = (v or "").strip()
    if not v:
        if required:
            raise ValueError(f"line {line}: '{field}' is required")
        return None
    try:
        return float(v)
    except ValueError:
        raise ValueError(f"line {line}: '{field}' is not a number: {v!r}")


def cmd_import_results(a):
    with session() as s, open(a.csv, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        missing = {"model", "task", "mean"} - set(reader.fieldnames or [])
        if missing:
            sys.exit(f"Missing columns: {', '.join(sorted(missing))}")
        models = {m.code: m for m in s.scalars(select(db.Model))}
        tasks = {t.code: t for t in s.scalars(select(db.Task))}
        rows, errors = [], []
        for i, r in enumerate(reader, start=2):
            try:
                m, t = models.get((r.get("model") or "").strip()), tasks.get((r.get("task") or "").strip())
                if m is None or t is None:
                    raise ValueError(f"line {i}: unknown model or task ({r.get('model')}, {r.get('task')})")
                mean = _num(r.get("mean"), "mean", i, required=True)
                if not 0 <= mean <= 100:
                    raise ValueError(f"line {i}: mean must be a percentage between 0 and 100")
                n = _num(r.get("n_seeds"), "n_seeds", i)
                rows.append(dict(model_id=m.id, task_id=t.id, mean=mean, std=_num(r.get("std"), "std", i),
                                 ci_low=_num(r.get("ci_low"), "ci_low", i), ci_high=_num(r.get("ci_high"), "ci_high", i),
                                 n_seeds=int(n) if n is not None else None))
            except ValueError as e:
                errors.append(str(e))
        if errors:
            sys.exit("Nothing imported. Fix these rows first:\n  " + "\n  ".join(errors))
        for r in rows:
            old = s.scalar(select(db.EvaluationResult).where(db.EvaluationResult.model_id == r["model_id"],
                                                             db.EvaluationResult.task_id == r["task_id"]))
            if old is not None:
                s.delete(old)
                s.flush()
            s.add(db.EvaluationResult(**r))
        s.commit()
    print(f"Imported {len(rows)} results.")


def cmd_set_checkpoint(a):
    p = config.MODELS_DIR / a.path
    if not p.exists():
        sys.exit(f"Not found: {p}")
    with session() as s:
        m = get(s, db.Model, a.model)
        m.checkpoint_path = a.path
        s.commit()
    print(f"{a.model} now uses {p}. Restart the server to load it.")


def cmd_add_sample(a):
    p = safe_join(config.FRONTEND_DIR, a.file)
    if not p.exists():
        sys.exit(f"Not found inside frontend/: {a.file}")
    if p.suffix.lower() not in (".wav", ".mp3"):
        sys.exit("Sample clips must be WAV or MP3.")
    with session() as s:
        if s.scalar(select(db.SampleClip).where(db.SampleClip.code == a.code)):
            sys.exit(f"Sample '{a.code}' already exists.")
        s.add(db.SampleClip(code=a.code, title=a.title, file_path=a.file, licence=a.licence,
                            attribution=a.attribution, source_label=a.source_label))
        s.commit()
    print(f"Added sample {a.code}.")


def cmd_status(a):
    with session() as s:
        print(f"Database: {config.DB_PATH}\nModels folder: {config.MODELS_DIR}")
        for m in s.scalars(select(db.Model).order_by(db.Model.sort_order)):
            probes = s.scalars(select(db.Task.code).join(db.Probe, db.Probe.task_id == db.Task.id)
                               .where(db.Probe.model_id == m.id)).all()
            ckpt = m.checkpoint_path or "-"
            ok = "" if m.kind != "m2d" or ckpt == "-" else (" (found)" if (config.MODELS_DIR / ckpt).exists() else " (MISSING)")
            print(f"  {m.code:16} {m.kind:9} checkpoint: {ckpt}{ok}  probes: {', '.join(probes) or '-'}")
        print(f"Results: {s.scalar(select(func.count(db.EvaluationResult.id)))} rows")
        print(f"Samples: {s.scalar(select(func.count(db.SampleClip.id)))}")
        print(f"Inference log: {s.scalar(select(func.count(db.InferenceLog.id)))} rows")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init").set_defaults(fn=cmd_init)
    sp = sub.add_parser("register-probe")
    sp.add_argument("--model", required=True); sp.add_argument("--task", required=True)
    sp.add_argument("--evar", required=True); sp.add_argument("--labels")
    sp.set_defaults(fn=cmd_register_probe)
    sp = sub.add_parser("import-results"); sp.add_argument("csv"); sp.set_defaults(fn=cmd_import_results)
    sp = sub.add_parser("set-checkpoint")
    sp.add_argument("--model", required=True); sp.add_argument("--path", required=True)
    sp.set_defaults(fn=cmd_set_checkpoint)
    sp = sub.add_parser("add-sample")
    for k in ("--code", "--file", "--title", "--licence", "--attribution"):
        sp.add_argument(k, required=True)
    sp.add_argument("--source-label")
    sp.set_defaults(fn=cmd_add_sample)
    sub.add_parser("status").set_defaults(fn=cmd_status)
    a = p.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
