"""SQLite database of the dashboard (report Section 4.9): models, tasks, labels, probes,
evaluation results, sample clips and an anonymous inference log. Accessed through SQLAlchemy,
so a client-server database could replace SQLite without changing the application code."""
import json
from datetime import datetime, timezone

from sqlalchemy import (Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint,
                        create_engine, select)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship, sessionmaker

from . import config


class Base(DeclarativeBase):
    pass


class Model(Base):
    __tablename__ = "model"
    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(64), unique=True)
    display_name: Mapped[str] = mapped_column(String(128))
    kind: Mapped[str] = mapped_column(String(16))            # "m2d" (can run in the demo) or "reference"
    group: Mapped[str] = mapped_column(String(32))           # filter on the Results tab
    description: Mapped[str] = mapped_column(Text, default="")
    checkpoint_path: Mapped[str | None] = mapped_column(String(512), nullable=True)  # relative to MODELS_DIR
    sort_order: Mapped[int] = mapped_column(Integer, default=0)


class Task(Base):
    __tablename__ = "task"
    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(64), unique=True)
    name: Mapped[str] = mapped_column(String(64))
    dataset: Mapped[str] = mapped_column(String(64))
    size_label: Mapped[str] = mapped_column(String(64))       # e.g. "10 genres"
    metric: Mapped[str] = mapped_column(String(16))           # "accuracy" or "mAP"
    multi_label: Mapped[bool] = mapped_column(Boolean, default=False)
    threshold: Mapped[float | None] = mapped_column(Float, nullable=True)
    in_demo: Mapped[bool] = mapped_column(Boolean, default=True)
    in_music_score: Mapped[bool] = mapped_column(Boolean, default=True)
    top_k: Mapped[int] = mapped_column(Integer, default=5)
    note: Mapped[str] = mapped_column(Text, default="")
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    labels: Mapped[list["Label"]] = relationship(order_by="Label.idx", cascade="all, delete-orphan")


class Label(Base):
    __tablename__ = "label"
    __table_args__ = (UniqueConstraint("task_id", "idx"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[int] = mapped_column(ForeignKey("task.id"))
    idx: Mapped[int] = mapped_column(Integer)
    name: Mapped[str] = mapped_column(String(128))


class Probe(Base):
    __tablename__ = "probe"
    __table_args__ = (UniqueConstraint("model_id", "task_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    model_id: Mapped[int] = mapped_column(ForeignKey("model.id"))
    task_id: Mapped[int] = mapped_column(ForeignKey("task.id"))
    path: Mapped[str] = mapped_column(String(512))           # relative to PROBES_DIR
    registered_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc))


class EvaluationResult(Base):
    __tablename__ = "evaluation_result"
    __table_args__ = (UniqueConstraint("model_id", "task_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    model_id: Mapped[int] = mapped_column(ForeignKey("model.id"))
    task_id: Mapped[int] = mapped_column(ForeignKey("task.id"))
    mean: Mapped[float] = mapped_column(Float)               # percent
    std: Mapped[float | None] = mapped_column(Float, nullable=True)
    ci_low: Mapped[float | None] = mapped_column(Float, nullable=True)
    ci_high: Mapped[float | None] = mapped_column(Float, nullable=True)
    n_seeds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    imported_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc))


class SampleClip(Base):
    __tablename__ = "sample_clip"
    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(64), unique=True)
    title: Mapped[str] = mapped_column(String(256))
    file_path: Mapped[str] = mapped_column(String(512))      # relative to the frontend folder
    licence: Mapped[str] = mapped_column(String(128))
    attribution: Mapped[str] = mapped_column(Text)
    source_label: Mapped[str | None] = mapped_column(String(128), nullable=True)


class InferenceLog(Base):
    """Anonymous: no audio, no file names, no network addresses (FR-16)."""
    __tablename__ = "inference_log"
    id: Mapped[int] = mapped_column(primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc))
    task_code: Mapped[str] = mapped_column(String(64))
    model_code: Mapped[str] = mapped_column(String(64))
    source: Mapped[str] = mapped_column(String(16))          # "upload" or "sample"
    duration_s: Mapped[float | None] = mapped_column(Float, nullable=True)
    device: Mapped[str] = mapped_column(String(64), default="")
    latency_ms: Mapped[float | None] = mapped_column(Float, nullable=True)
    status: Mapped[str] = mapped_column(String(32))


def make_engine(path=None):
    path = path or config.DB_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    return create_engine(f"sqlite:///{path}", future=True)


def init(engine) -> sessionmaker:
    """Creates the tables and, on an empty database, adds the models, tasks, labels and samples
    listed in seed.json. Returns a session factory."""
    Base.metadata.create_all(engine)
    Session = sessionmaker(engine, expire_on_commit=False)
    with Session() as s:
        if s.scalar(select(Model.id).limit(1)) is None:
            seed(s, json.loads(config.SEED_FILE.read_text(encoding="utf-8")))
            s.commit()
    return Session


def seed(s, data: dict) -> None:
    for i, m in enumerate(data["models"]):
        s.add(Model(sort_order=i, **m))
    for i, t in enumerate(data["tasks"]):
        labels = t.pop("labels", [])
        task = Task(sort_order=i, **t)
        task.labels = [Label(idx=j, name=n) for j, n in enumerate(labels)]
        s.add(task)
    for c in data.get("samples", []):
        s.add(SampleClip(**c))
