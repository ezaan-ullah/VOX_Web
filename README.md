# M2D Music Dashboard (Vox)

The demonstration dashboard of the Vox FYP (report Chapter 4). It has three tabs:

- **Results:** evaluation scores from the database.
- **Demo:** upload a clip, or pick a sample, and run a music task with the **real** M2D model.
- **About:** the project, models, datasets and licences.

Nothing on screen is hardcoded. The browser sends the clip to a Python backend (FastAPI), which:
1. converts it to 16 kHz mono and keeps the first 6.08 s,
2. runs the frozen **M2D/0.7** encoder using M2D's own front-end,
3. applies a trained linear probe, and
4. returns the scores with the measured timings.

## Layout

| Path | What it is |
|---|---|
| `frontend/` | The page (HTML, CSS, JS), the Lato fonts and the bundled CC-BY sample clip |
| `backend/app.py` | FastAPI app: API routes, single-worker queue, upload deletion, static files |
| `backend/vox/` | Reusable package: `audio.py` (decoding, 6.08-s window), `encoder.py` (M2D), `probes.py` (linear probes), `db.py` (SQLite), `service.py` |
| `backend/scripts/download_models.py` | Downloads the M2D/0.7 weights and M2D's loader (pinned commit) into `~/.cache/vox/models` |
| `backend/scripts/manage.py` | Developer CLI: register probes, import results, set checkpoints, add samples, status |
| `backend/tests/` | `pytest` tests: audio window, probes, API, upload deletion, the real encoder |
| `docs/` | The earlier recorded demo video |

## Setup (once)

```sh
python -m venv .venv
.venv\Scripts\pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu   # or the CUDA build on the GPU machine
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python backend\scripts\download_models.py
```

On Linux, use `.venv/bin/...` instead of `.venv\Scripts\...`.

## Run

```sh
start.bat        # Windows: starts http://127.0.0.1:8000 and opens the browser
./start.sh       # Linux
```

The server uses the GPU when there is one, otherwise the CPU. For a video take, open `http://127.0.0.1:8000/?record&speed=0.8#demo`: **R** resets, and `speed` slows the step animation.

## Making the predictions real: register the probes

The encoder works out of the box. Each task also needs a **linear probe** trained on that task's dataset, the same probes as the study's evaluation. Until a probe is registered, the page says "No classifier yet" and never shows invented scores.

1. In EVAR (`nttcslab/eval-audio-repr`), run the linear evaluation **with saving switched on**. This writes `weight_params.pth` to the log folder:
   ```sh
   python lineareval.py config/m2d.yaml gtzan weight_file=/path/to/checkpoint-300.pth --save=True
   ```
   Do this for `gtzan`, `nsynth` (instrument), `nspitch` (pitch) and MagnaTagATune. Use linear probes, the default `hidden=()`.
2. Register each one:
   ```sh
   python backend\scripts\manage.py register-probe --model original --task genre      --evar path\to\log_folder
   python backend\scripts\manage.py register-probe --model original --task instrument --evar ...
   python backend\scripts\manage.py register-probe --model original --task pitch      --evar ...
   python backend\scripts\manage.py register-probe --model original --task tagging    --evar ... --labels mtt_tags.txt
   ```
   For tagging, `--labels` is a text file with the 50 tags, one per line, in EVAR's column order. EVAR doesn't save tag names.
3. Restart the server. `manage.py status` lists what's registered.

The conversion reads EVAR's file once, on your machine, and stores a plain tensor file. The server never unpickles anything.

## The further pre-trained model

When training finishes, put the checkpoint under the models folder and point the `further` model at it:

```sh
python backend\scripts\manage.py set-checkpoint --model further --path m2d_x_music\checkpoint-600.pth
```

Then register its four probes with `--model further`. The **Compare** option shows both models side by side.

## Results tab

```sh
python backend\scripts\manage.py import-results results.csv
```

CSV columns: `model,task,mean,std,ci_low,ci_high,n_seeds`.
- **Codes:** models `original`, `further`, `mert_v1_95m`, `mert_v0_public`, `musicfm_fma`, `matpac_general`, `matpac_music`; tasks `genre`, `tagging`, `instrument`, `pitch`, `fma_small`.
- **Scores:** in percent.
- **Validation:** every row is checked first; nothing is imported if any row is wrong.

## API

| Method | Path | Returns |
|---|---|---|
| GET | `/api/health` | device, loaded models and probes |
| GET | `/api/models`, `/api/tasks`, `/api/samples` | what the Demo tab can offer |
| GET | `/api/samples/{code}/audio` | a bundled sample clip |
| POST | `/api/predict` | form fields `task`, `model`, `compare`, and `file` or `sample`; returns top labels, all scores, the embedding, measured timings, device and queue position |
| GET | `/api/results?group=` | scores and the music score per model |

## Privacy

- **Uploads:** stored under random names and deleted right after the prediction, with a sweeper for anything older than ten minutes.
- **Log:** the inference log keeps task, model, source, duration, device, latency and status. It stores no audio, file names or IP addresses.
- **Accounts:** none.

## Tests

```sh
.venv\Scripts\python -m pytest backend\tests
```

The real-encoder test is skipped if the weights haven't been downloaded.

## Credits and licences

- M2D weights and `portable_m2d.py`: NTT Communication Science Laboratories, [nttcslab/m2d](https://github.com/nttcslab/m2d). Downloaded, not redistributed, under their licence (LICENSE.pdf).
- Music: "Volatile Reaction", Kevin MacLeod (incompetech.com), CC BY 4.0.
- Font: Lato, SIL Open Font License 1.1.
