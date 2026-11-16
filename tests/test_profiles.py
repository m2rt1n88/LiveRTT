"""Persistence and HTTP profile contracts; all data uses temporary directories."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from backend.app import Server, DebugSession
from backend.errors import DebugError
from backend.profiles import ProfileStore, validate_profile
from backend.mechanisms import LIBRARY


def profile(path, label="speed"):
    return {"version": 2, "elfPath": str(path), "name": "Example " + label,
            "watches": [{"path": label, "label": label, "unit": "rad/s", "scale": 2, "plot": False}],
            "connection": {"port": 6666, "rttPort": 8888},
            "modules": {"gimbal": {"enabled": True, "bindings": {"yaw": label}}}}


class ProfileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.store = ProfileStore(self.root / "data")

    def tearDown(self):
        self.temp.cleanup()

    def test_two_elfs_with_equal_names_keep_independent_settings(self):
        a = self.store.save(profile(self.root / "a/app.elf", "motor.speed"))
        b = self.store.save(profile(self.root / "b/app.elf", "imu.yaw"))
        self.assertNotEqual(a["id"], b["id"])
        self.assertEqual(len(self.store.list()), 2)
        restored = ProfileStore(self.root / "data").get(a["id"])
        self.assertEqual(restored["watches"][0]["path"], "motor.speed")
        self.assertFalse(restored["watches"][0]["plot"])
        self.assertEqual(restored["modules"]["gimbal"]["bindings"]["yaw"], "motor.speed")
        self.assertFalse(restored["modules"]["chassis"]["enabled"])
        restored["watches"][0]["unit"] = "changed locally"
        self.assertEqual(self.store.get(a["id"])["watches"][0]["unit"], "rad/s")

    def test_rebuild_same_path_reuses_id_without_addresses_or_sha(self):
        body = profile(self.root / "app.elf")
        original = self.store.save(body)
        body["watches"][0].update(scale=57.2957795, plot=True, address="old RAM address")
        body["sha"] = "old build"
        again = self.store.save(body)
        self.assertEqual(original["id"], again["id"])
        self.assertEqual(len(self.store.list()), 1)
        self.assertNotIn("sha", again)
        self.assertNotIn("address", again["watches"][0])
        self.assertEqual(again["watches"][0]["scale"], 57.2957795)

    def test_rejected_data_does_not_change_saved_profile(self):
        body = profile(self.root / "app.elf")
        original = self.store.save(body)
        bad_bodies = []
        for update in ({"watches": [{"path": "x", "scale": float("nan")}]},
                       {"watches": [{"path": "x"}, {"path": "x"}]},
                       {"watches": [1]}, {"rate": 10000},
                       {"connection": {"port": 8888, "rttPort": 8888}},
                       {"modules": {"gimbal": {"bindings": {"yaw": "unwatched"}}}},
                       {"id": "../elsewhere"}, {"id": "0" * 32}):
            candidate = deepcopy(body)
            candidate.update(update)
            bad_bodies.append(candidate)
        for candidate in bad_bodies:
            with self.subTest(candidate=candidate):
                with self.assertRaises(DebugError):
                    self.store.save(candidate)
                self.assertEqual(self.store.get(original["id"]), original)

    def test_atomic_replace_failure_keeps_previous_file(self):
        body = profile(self.root / "app.elf")
        original = self.store.save(body)
        body["name"] = "new value"
        with patch("backend.profiles.os.replace", side_effect=OSError("disk failure")):
            with self.assertRaises(OSError):
                self.store.save(body)
        self.assertEqual(self.store.get(original["id"]), original)
        self.assertEqual(list(self.store.root.glob("*.tmp")), [])

    def test_corrupt_store_is_reported_and_never_overwritten(self):
        self.store.root.mkdir()
        self.store.path.write_text("broken original data", encoding="utf-8")
        with self.assertRaisesRegex(DebugError, "原文件已保留"):
            self.store.save(profile(self.root / "app.elf"))
        self.assertEqual(self.store.path.read_text(), "broken original data")

    def test_validate_does_not_create_files_or_require_connected_board(self):
        body = validate_profile(profile(self.root / "missing.elf"))
        self.assertEqual(body["version"], 2)
        self.assertFalse(self.store.path.exists())

    def test_motion_settings_round_trip_and_removed_targets_are_ignored(self):
        body = profile(self.root / "motion.elf")
        body["modules"].update(targets={"enabled": True}, chassis={"enabled": True, "layout": "omni",
            "radius": .1, "halfLength": .3, "halfWidth": .25, "offset": .25, "commandUnits": "setSpeed",
            "wheels": {"fl": {"motor": "motors[0]", "sign": -1, "ratio": 2}}})
        body["modules"]["gimbal"].update(angleUnit="deg", yawWrap=False, tolerance=5,
            axes={"pitch": {"motor": "pitch_motor", "sign": -1, "ratio": 1, "zero": 123, "min": -20, "max": 45}})
        saved = self.store.save(body)
        restored = self.store.get(saved["id"])
        self.assertEqual(saved, restored)
        self.assertNotIn("targets", restored["modules"])
        self.assertEqual(restored["modules"]["chassis"]["layout"], "omni")
        self.assertEqual(restored["modules"]["chassis"]["offset"], .25)
        self.assertEqual(restored["modules"]["chassis"]["commandUnits"], "setSpeed")
        self.assertEqual(restored["modules"]["gimbal"]["axes"]["pitch"]["zero"], 123)
        self.assertEqual(restored["watches"], validate_profile(body)["watches"])

    def test_motion_settings_reject_invalid_geometry_duplicates_and_nonfinite_calibration(self):
        for module, changes in [("gimbal", {"angleUnit": "turns"}),
                ("gimbal", {"axes": {"yaw": {"ratio": 0}}}),
                ("gimbal", {"axes": {"pitch": {"zero": float("nan")}}}),
                ("gimbal", {"axes": {"pitch": {"min": 45, "max": 30}}}),
                ("chassis", {"radius": -1}), ("chassis", {"layout": "unknown"}),
                ("chassis", {"offset": float("nan")}), ("chassis", {"offset": 1.1}),
                ("chassis", {"commandUnits": "rpm"}),
                ("chassis", {"wheels": {"fl": {"motor": "m"}, "fr": {"motor": "m"}}})]:
            with self.subTest(changes=changes):
                body = profile(self.root / "invalid.elf")
                body["modules"][module] = changes
                with self.assertRaises(DebugError):
                    validate_profile(body)

    def test_legacy_rear_wheel_keys_migrate_without_losing_calibration(self):
        body = profile(self.root / "legacy-wheels.elf")
        body["modules"]["chassis"] = {"wheels": {"rl": {"motor": "left_back", "sign": -1, "ratio": 2},
                                                           "rr": {"motor": "right_back"}}}
        cleaned = validate_profile(body)["modules"]["chassis"]
        self.assertEqual(cleaned["wheels"]["bl"], {"motor": "left_back", "sign": -1, "ratio": 2})
        self.assertEqual(cleaned["wheels"]["br"]["motor"], "right_back")
        self.assertNotIn("rl", cleaned["wheels"])
        self.assertEqual(cleaned["commandUnits"], "si")
        self.assertEqual(cleaned["offset"], 0)
        body["modules"]["chassis"]["wheels"]["bl"] = {"motor": "canonical"}
        self.assertEqual(validate_profile(body)["modules"]["chassis"]["wheels"]["bl"]["motor"], "canonical")

    def test_vehicle_settings_round_trip_and_old_profiles_default_to_disabled(self):
        body = profile(self.root / "vehicle.elf")
        self.assertFalse(validate_profile(body)["modules"]["vehicle"]["enabled"])
        body["modules"]["vehicle"] = {"enabled": True, "gimbalFrame": "world",
            "angleUnit": "deg", "bindings": {"headingTarget": "speed"}}
        saved = self.store.save(body)
        self.assertEqual(self.store.get(saved["id"])["modules"]["vehicle"], body["modules"]["vehicle"])
        for changes in ({"gimbalFrame": "unknown"}, {"angleUnit": "turn"},
                        {"bindings": {"headingTarget": "unwatched"}}):
            candidate = deepcopy(body)
            candidate["modules"]["vehicle"].update(changes)
            with self.subTest(changes=changes), self.assertRaises(DebugError):
                validate_profile(candidate)

    def test_profile_endpoints_and_private_data_are_protected(self):
        session = DebugSession(self.root)
        web = Server(("localhost", 0), session, self.root / "data")
        thread = threading.Thread(target=web.serve_forever, daemon=True)
        thread.start()
        base = "http://localhost:" + str(web.server_port)
        try:
            with urlopen(base + "/api/status") as response:
                status = json.load(response)
            headers = {"X-Debug-Token": status["token"], "Content-Type": "application/json"}
            body = profile(self.root / "arbitrary-program.elf")
            with urlopen(Request(base + "/api/profile/validate", json.dumps(body).encode(), headers)) as response:
                self.assertEqual(json.load(response)["elfPath"], body["elfPath"])
            self.assertFalse((self.root / "data/profiles.json").exists())
            with urlopen(Request(base + "/api/profile/save", json.dumps(body).encode(), headers)) as response:
                saved = json.load(response)
            with urlopen(Request(base + "/api/profile?id=" + saved["id"], headers=headers)) as response:
                self.assertEqual(json.load(response)["watches"][0]["scale"], 2)
            for path in ("/api/profiles", "/data/profiles.json", "/backend/app.py", "/assets/js/../../data/profiles.json"):
                with self.subTest(path=path), self.assertRaises(HTTPError) as caught:
                    urlopen(base + path)
                self.assertIn(caught.exception.code, (403, 404))
                caught.exception.close()
            for path in ("/assets/js/app.js", "/assets/css/app.css", "/assets/js/vehicle.js", "/assets/js/mechanisms.js", "/assets/js/mechanism-view.js", "/assets/js/motor-ai.js", "/assets/js/motor-plots.js", "/assets/models/library.json"):
                with urlopen(base + path) as response:
                    self.assertEqual(response.status, 200)
                    if path.endswith(".json"):
                        self.assertEqual(response.headers.get_content_type(), "application/json")
                        self.assertEqual(json.load(response)["version"], 1)
        finally:
            web.shutdown()
            web.server_close()

    def test_custom_mechanisms_round_trip_per_elf_with_dynamic_bindings(self):
        body = profile(self.root / "multi.elf")
        model = deepcopy(next(m for m in LIBRARY["gimbal"] if m["id"] == "folding"))
        model["id"] = "my-folding-head"
        model["joints"][2]["origin"] = [12, 0, 71]
        body["modules"]["gimbal"].update(mechanism=model,
            mount={"position": [4, 0, 12], "rotation": [0, 0, 0]},
            axes={"fold": {"motor": "upper", "sign": -1, "zero": 37}},
            bindings={"pitch": "speed", "foldTarget": "speed"})
        body["modules"]["chassis"] = {"mechanism": LIBRARY["chassis"][2],
            "wheels": {"left": {"motor": "left"}, "right": {"motor": "right"}}}
        saved = self.store.save(body)
        self.assertEqual(saved["modules"]["gimbal"]["mechanism"], model)
        self.assertEqual(saved["modules"]["gimbal"]["bindings"]["foldTarget"], "speed")
        self.assertEqual(saved["modules"]["gimbal"]["axes"]["fold"]["zero"], 37)
        self.assertEqual(set(saved["modules"]["chassis"]["wheels"]), {"left", "right"})
        self.store.save(profile(self.root / "other.elf"))
        self.assertEqual(self.store.get(saved["id"])["modules"], saved["modules"])
        self.assertEqual(validate_profile(saved)["modules"], saved["modules"])

    def test_legacy_templates_upgrade_without_changing_motor_roles_or_custom_geometry(self):
        for migration in LIBRARY["gimbalMigrations"]:
            body = profile(self.root / (migration["from"]["id"] + ".elf"))
            gimbal = body["modules"]["gimbal"]
            gimbal.update(mechanism=deepcopy(migration["from"]),
                          axes={"pitch": {"motor": "lower", "zero": 17},
                                "fold": {"motor": "upper", "zero": -23}},
                          bindings={"foldTarget": "speed"})
            saved = self.store.save(body)
            restored = self.store.get(saved["id"])["modules"]["gimbal"]
            self.assertEqual(restored["axes"]["pitch"]["motor"], "lower")
            self.assertEqual(restored["axes"]["fold"]["motor"], "upper")
            self.assertEqual(restored["axes"]["fold"]["zero"], -23)
            self.assertEqual(restored["bindings"]["foldTarget"], "speed")
            if migration["to"]:
                self.assertEqual(restored["mechanism"], next(m for m in LIBRARY["gimbal"] if m["id"] == migration["to"]))
            else:
                self.assertEqual(restored["mechanism"]["id"], "legacy-four-axis")
                self.assertEqual(restored["mechanism"]["joints"], migration["from"]["joints"])
            self.assertEqual(validate_profile(saved)["modules"]["gimbal"], restored)
            gimbal["mechanism"]["joints"][1]["origin"][0] += 3
            self.assertEqual(validate_profile(body)["modules"]["gimbal"]["mechanism"], gimbal["mechanism"])

    def test_invalid_mechanisms_and_dynamic_bindings_leave_saved_data_unchanged(self):
        original = self.store.save(profile(self.root / "model.elf"))
        for changes in ("cycle", "zero-axis", "duplicate", "bad-tool", "reserved", "unwatched", "adapter"):
            body = deepcopy(original)
            gimbal = body["modules"]["gimbal"]
            model = gimbal["mechanism"]
            if changes == "cycle": model["joints"][0]["parent"] = "pitch"
            if changes == "zero-axis": model["joints"][0]["axis"] = [0, 0, 0]
            if changes == "duplicate": model["joints"][1]["id"] = "yaw"
            if changes == "bad-tool": model["tool"]["parent"] = []
            if changes == "reserved": model["joints"][1]["id"] = "config"
            if changes == "unwatched": gimbal["bindings"]["pitchSpeed"] = "not-a-watch"
            if changes == "adapter": model["adapter"] = "eval"
            with self.subTest(changes=changes), self.assertRaises(DebugError):
                self.store.save(body)
            self.assertEqual(self.store.get(original["id"]), original)

    def test_matrix_model_rejects_setspeed_and_accepts_duplicate_inactive_wheels(self):
        body = profile(self.root / "matrix.elf")
        body["modules"]["chassis"] = {"layout": "differential", "commandUnits": "setSpeed"}
        with self.assertRaises(DebugError): validate_profile(body)
        body["modules"]["chassis"].update(commandUnits="si", wheels={
            "left": {"motor": "m1"}, "right": {"motor": "m2"}, "fl": {"motor": "m1"}})
        validated = validate_profile(body)
        self.assertEqual(validated["modules"]["chassis"]["layout"], "differential")


if __name__ == "__main__":
    unittest.main()
