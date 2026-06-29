"""Tests for the Note Trainer backend: config persistence, static-file serving
(path-traversal guarded), tunings and the level curriculum."""

import json


# ── Config defaults & persistence ─────────────────────────────────────────────

class TestConfigDefaults:
    def test_get_returns_default_keys(self, client):
        body = client.get("/api/plugins/note-trainer/config").json()
        assert body["lastInstrument"] == "guitar-6"
        assert body["lastMode"] == "relax"
        assert body["unlockedLevel"] == 1
        assert body["bestScores"] == {}
        assert body["stats"] == {}

    def test_new_feature_keys_default(self, client):
        body = client.get("/api/plugins/note-trainer/config").json()
        assert body["earMode"] == "note"
        assert body["achievements"] == []
        assert body["lifetime"] == {"correct": 0, "wrong": 0, "sessions": 0}

    def test_earmode_and_achievements_round_trip(self, client):
        client.post("/api/plugins/note-trainer/config", json={
            "earMode": "interval",
            "achievements": ["first_step", "combo_5"],
            "lifetime": {"correct": 42, "wrong": 7, "sessions": 3},
        })
        body = client.get("/api/plugins/note-trainer/config").json()
        assert body["earMode"] == "interval"
        assert body["achievements"] == ["first_step", "combo_5"]
        assert body["lifetime"]["correct"] == 42


class TestConfigPersistence:
    def test_partial_update_persisted(self, client):
        client.post("/api/plugins/note-trainer/config", json={"lastMode": "arcade"})
        assert client.get("/api/plugins/note-trainer/config").json()["lastMode"] == "arcade"

    def test_unmodified_fields_survive(self, client):
        client.post("/api/plugins/note-trainer/config", json={"lastMode": "arcade"})
        client.post("/api/plugins/note-trainer/config", json={"unlockedLevel": 3})
        body = client.get("/api/plugins/note-trainer/config").json()
        assert body["lastMode"] == "arcade"
        assert body["unlockedLevel"] == 3

    def test_unknown_keys_ignored(self, client, config_dir):
        client.post("/api/plugins/note-trainer/config", json={"evil": "x", "unlockedLevel": 2})
        saved = json.loads((config_dir / "note-trainer.json").read_text())
        assert "evil" not in saved
        assert saved["unlockedLevel"] == 2

    def test_malformed_file_returns_defaults(self, client, config_dir):
        (config_dir / "note-trainer.json").write_text("not json {{")
        body = client.get("/api/plugins/note-trainer/config").json()
        assert body["unlockedLevel"] == 1

    def test_progress_payload_round_trips(self, client):
        client.post("/api/plugins/note-trainer/config", json={
            "bestScores": {"1": 1200, "free": 800},
            "stats": {"0:0": {"correct": 5, "wrong": 1}},
        })
        body = client.get("/api/plugins/note-trainer/config").json()
        assert body["bestScores"]["1"] == 1200
        assert body["stats"]["0:0"]["correct"] == 5

    def test_ear_stats_and_use_home_round_trip(self, client):
        client.post("/api/plugins/note-trainer/config", json={
            "earStats": {"4": {"correct": 3, "wrong": 2}},
            "earUseHome": False,
        })
        body = client.get("/api/plugins/note-trainer/config").json()
        assert body["earStats"]["4"] == {"correct": 3, "wrong": 2}
        assert body["earUseHome"] is False

    def test_malformed_json_body_returns_400_not_500(self, client):
        # A non-JSON body must be a clean 400, not an unhandled 500 from req.json().
        r = client.post(
            "/api/plugins/note-trainer/config",
            data="not json {{",
            headers={"Content-Type": "application/json"},
        )
        assert r.status_code == 400

    def test_write_is_atomic_and_leaves_no_temp_file(self, client, config_dir):
        # Atomic write (tmp + os.replace): the on-disk file is always valid JSON
        # and no .tmp artifact is left behind.
        client.post("/api/plugins/note-trainer/config", json={"unlockedLevel": 7})
        assert json.loads((config_dir / "note-trainer.json").read_text())["unlockedLevel"] == 7
        assert not list(config_dir.glob("*.tmp"))


# ── Tunings & levels ──────────────────────────────────────────────────────────

class TestTunings:
    def test_lists_guitar_and_bass(self, client):
        tunings = client.get("/api/plugins/note-trainer/tunings").json()["tunings"]
        assert "guitar-6" in tunings and "bass-4" in tunings
        assert "Standard" in tunings["guitar-6"]
        # Standard guitar low E ~ 82.41 Hz.
        assert abs(tunings["guitar-6"]["Standard"][0] - 82.41) < 0.01


class TestLevels:
    def test_curriculum_present_and_ordered(self, client):
        levels = client.get("/api/plugins/note-trainer/levels").json()["levels"]
        assert len(levels) >= 1
        ids = [lv["id"] for lv in levels]
        assert ids == sorted(ids)
        first = levels[0]
        # Strings are now chosen per level in the UI, so the curriculum entry only
        # carries the note-set + scoring metadata.
        assert {"id", "label", "noteSet", "count", "promote"} <= set(first)


# ── Static-file serving (security) ────────────────────────────────────────────

class TestStaticServing:
    def test_serves_existing_util(self, client):
        r = client.get("/api/plugins/note-trainer/utils/note-math.js")
        assert r.status_code == 200
        assert "application/javascript" in r.headers["content-type"]
        assert "freqToNoteOctave" in r.text

    def test_serves_worker(self, client):
        r = client.get("/api/plugins/note-trainer/workers/yin.js")
        assert r.status_code == 200
        assert "_yinDetect" in r.text

    def test_rejects_path_traversal(self, client):
        r = client.get("/api/plugins/note-trainer/utils/..%2f..%2froutes.py")
        assert r.status_code == 404

    def test_rejects_non_js(self, client):
        r = client.get("/api/plugins/note-trainer/utils/levels.json")
        assert r.status_code == 404
