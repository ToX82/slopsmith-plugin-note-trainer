"""Note Trainer plugin backend.

Serves the plugin's static JS (utils/, workers/) the same way the tuner plugin
does (explicit, path-traversal-guarded routes — a Web Worker needs a same-origin
URL), exposes the standard guitar/bass tunings, the level curriculum, and
persists player progress (best scores, medals, picked strings, per-note/string
mastery stats) under the host-provided config_dir.
"""

import json
import os
import threading
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

# Open-string frequencies (Hz) per instrument/tuning. Mirrors the tuner plugin's
# table so a player sees the same tunings across plugins. The open-string freqs
# fully define a tuning — the frontend derives MIDI/note names from them.
DEFAULT_TUNINGS = {
    "guitar-6": {
        "Standard":  [82.41, 110.00, 146.83, 196.00, 246.94, 329.63],
        "Drop D":    [73.42, 110.00, 146.83, 196.00, 246.94, 329.63],
        "Eb Standard": [77.78, 103.83, 138.59, 185.00, 233.08, 311.13],
        "DADGAD":    [73.42, 110.00, 146.83, 196.00, 220.00, 293.66],
    },
    "guitar-7": {
        "Standard":    [61.74, 82.41, 110.00, 146.83, 196.00, 246.94, 329.63],
        "Drop A":      [55.00, 82.41, 110.00, 146.83, 196.00, 246.94, 329.63],
    },
    "guitar-8": {
        "Standard":    [46.25, 61.74, 82.41, 110.00, 146.83, 196.00, 246.94, 329.63],
        "Drop E":      [41.20, 61.74, 82.41, 110.00, 146.83, 196.00, 246.94, 329.63],
    },
    "bass-4": {
        "Standard":   [41.20, 55.00, 73.42, 98.00],
        "Drop D":     [36.71, 55.00, 73.42, 98.00],
    },
    "bass-5": {
        "Standard":   [30.87, 41.20, 55.00, 73.42, 98.00],
        "Drop D":     [30.87, 36.71, 55.00, 73.42, 98.00],
    },
}

_DEFAULT_CONFIG = {
    "lastInstrument": "guitar-6",
    "lastTuning": "Standard",
    "lastNoteSet": "natural",   # natural | sharps | flats | chromatic
    "lastMode": "relax",        # relax | arcade | challenge | learn | ear
    "lastEarTier": "easy",      # ear-training difficulty: easy | medium | hard
    "earMode": "note",          # ear-training answer style: note | interval
    "earUseHome": True,         # play the home reference note before each target
    "maxFret": 12,
    "unlockedLevel": 1,         # legacy: all levels are now unlocked from the start
    "bestScores": {},           # levelId -> best score
    "medals": {},               # levelId -> "gold" | "silver" | "bronze" (best earned)
    "levelStrings": {},         # levelId -> [stringIndex, …] strings picked to drill
    "stats": {},                # "stringIndex:pitchClass" -> {correct, wrong}
    "earStats": {},             # interval offset (semitones from root) -> {correct, wrong}
    "achievements": [],         # ids of unlocked long-term achievements
    "lifetime": {"correct": 0, "wrong": 0, "sessions": 0},  # totals across every session
    # Mic settings live in localStorage (per-device, like the tuner); only
    # gameplay progress is persisted server-side.
}


def setup(app: FastAPI, context: dict):
    config_dir = Path(context["config_dir"])
    config_file = config_dir / "note-trainer.json"

    _utils_dir = Path(__file__).parent / "utils"
    _workers_dir = Path(__file__).parent / "workers"
    _levels_file = Path(__file__).parent / "data" / "levels.json"

    # Serialize the read-modify-write of the config file. Two near-simultaneous
    # saves (the frontend sends progress in several patches) would otherwise each
    # read the file, merge their own keys, and rewrite the whole thing — the last
    # writer clobbering the other's patch (lost update).
    _cfg_lock = threading.Lock()

    def _read_file() -> dict:
        cfg = dict(_DEFAULT_CONFIG)
        if config_file.exists():
            try:
                data = json.loads(config_file.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    cfg.update({k: data[k] for k in _DEFAULT_CONFIG if k in data})
            except Exception:
                pass
        return cfg

    def _read() -> dict:
        with _cfg_lock:
            return _read_file()

    def _write(patch: dict) -> None:
        with _cfg_lock:
            config_dir.mkdir(parents=True, exist_ok=True)
            current = _read_file()
            # Only persist known keys; ignore anything else the client sends.
            for key in _DEFAULT_CONFIG:
                if key in patch:
                    current[key] = patch[key]
            # Atomic write: a crash mid-write can't leave a truncated/corrupt
            # config (write to a temp file, then replace in one step).
            tmp = config_file.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(current, indent=2), encoding="utf-8")
            os.replace(tmp, config_file)

    def _serve_js_from(base_dir: Path, filename: str) -> Response:
        target = (base_dir / filename).resolve()
        try:
            target.relative_to(base_dir.resolve())
        except ValueError:
            return Response("", status_code=404)
        if target.suffix == ".js" and target.is_file():
            return Response(target.read_text(encoding="utf-8"),
                            media_type="application/javascript")
        return Response("", status_code=404)

    @app.get("/api/plugins/note-trainer/utils/{filename}")
    def get_utils_file(filename: str):
        return _serve_js_from(_utils_dir, filename)

    @app.get("/api/plugins/note-trainer/workers/{filename}")
    def get_worker_file(filename: str):
        return _serve_js_from(_workers_dir, filename)

    @app.get("/api/plugins/note-trainer/tunings")
    def get_tunings():
        return {"tunings": DEFAULT_TUNINGS}

    @app.get("/api/plugins/note-trainer/levels")
    def get_levels():
        try:
            return {"levels": json.loads(_levels_file.read_text(encoding="utf-8"))}
        except Exception:
            return {"levels": []}

    @app.get("/api/plugins/note-trainer/config")
    def get_config():
        return _read()

    @app.post("/api/plugins/note-trainer/config")
    async def set_config(req: Request):
        try:
            body = await req.json()
        except Exception:
            return JSONResponse({"error": "invalid JSON"}, status_code=400)
        if isinstance(body, dict):
            _write(body)
        return {"ok": True}
