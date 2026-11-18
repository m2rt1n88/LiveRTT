"""Reproducible browser fixture; synthetic telemetry, never accesses a probe.

Run: python tests/manual_motion_server.py.
Not part of production startup. Uses real ELF only to exercise load/profile UI.
"""
import argparse
import math
from pathlib import Path
import sys
import time
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / ".deps")]
from backend.app import Server
from backend.session import DebugSession
from backend.errors import DebugError
from backend.mechanisms import LIBRARY


class MotionFixture(DebugSession):
    def __init__(self, elf, scenario="tracking", layout="mecanum"):
        super().__init__(elf.parent)
        self.elf = elf
        self.scenario = scenario
        self.started = time.monotonic()
        self.layout = layout
        self.probe = SimpleNamespace(sock=None, close=lambda: setattr(self.probe, "sock", None))
        self.service = SimpleNamespace(defaults=lambda: {}, snapshot=lambda: {}, stop=lambda: None, connect=self.connect_fixture)
        self.rtt = SimpleNamespace(close=lambda: None, snapshot=lambda after: {"cursor": 0, "lines": [], "error": "测试替身：不连接 RTT 或真实硬件"})
        self.catalog = [{"path": "fixture." + key, "type": "MotorFixture", "family": "DJI", "bus": "FIXTURE CAN", "rxId": 0x201 + i}
                        for i, key in enumerate(("yaw", "pitch", "smallYaw", "fold", "fl", "fr", "bl", "br", "left", "right", "front"))]

    def presets(self):
        return [{"name": "图形回归 / 合成数据，非实车", "path": str(self.elf)}]

    def connect_fixture(self, probe, *args):
        probe.sock = True
        return {"service": "合成数据，非实车", "target": "浏览器测试替身", "state": "running"}

    def verify(self, sha):
        self.require_elf(sha)
        self.verified_sha = sha
        return {"note": "未验证真实硬件；测试替身不连接探针"}

    def scan_motors(self, sha):
        self.require_elf(sha)
        return {"items": self.catalog, "live": False, "note": "合成数据，非实车。仅供图形回归。"}

    def sample(self, paths, sha, motor_paths=None, communication=None):
        self.require_elf(sha)
        if paths:
            raise DebugError("此替身仅提供电机测试数据，不读取真实变量。")
        t = time.monotonic() - self.started
        motors = []
        for item in self.catalog:
            if item["path"] not in (motor_paths or []):
                continue
            key = item["path"].split(".")[-1]
            axis = key in ("yaw", "pitch", "smallYaw", "fold")
            theta = .6 * math.sin(t / 4) if key == "yaw" else .18 * math.sin(t / 5)
            omega = .15 * math.cos(t / 4) if key == "yaw" else .036 * math.cos(t / 5)
            speed = {"fl": 6.5, "fr": -12, "bl": 9.5, "br": -9}.get(key, omega)
            target = theta + .06 if axis else speed + .8
            if self.scenario == "compensation":
                # Repository +vt is clockwise. Gimbal CCW yaw compensates it.
                if axis:
                    theta = .2375 * t + .03 * math.sin(t) if key == "yaw" else .15 + .025 * math.sin(t / 5)
                    speed = .2375 + .03 * math.cos(t) if key == "yaw" else .005 * math.cos(t / 5)
                    target = .2375 * t if key == "yaw" else .15
                else:
                    speed = 1.25 * (math.sqrt(.5) if self.layout == "omni" else 1)
                    target = speed
            if self.scenario == "zero":
                theta = speed = target = 0
            if self.scenario == "folded":
                theta = {"pitch": math.pi / 3, "fold": -math.pi / 3}.get(key, 0)
                speed = 0
                target = theta
            fields = {"state_.theta": theta, "state_.output_shaft_theta": theta,
                      "state_.omega": speed, "state_.output_shaft_omega": speed,
                      "state_.mode": 6 if axis else 2, "state_.enable": True,
                      "state_.target": target,
                      "output_": speed * 180, "max_raw_current_": 10000,
                      "state_.raw_temperature": 32, "state_.current": .8}
            motors.append({**item, "status": "online", "online": True, "feedbackAgeMs": 1,
                           "fields": fields, "fieldErrors": {}})
        return {"time": time.time(), "durationMs": .1, "values": [], "motors": motors, "connected": True}


def main():
    parser = argparse.ArgumentParser(description="Synthetic browser fixture; never accesses hardware")
    parser.add_argument("--port", type=int, default=18767)
    parser.add_argument("--scenario", choices=("tracking", "compensation", "zero", "folded"), default="tracking")
    parser.add_argument("--gimbal", choices=tuple(m["id"] for m in LIBRARY["gimbal"]), default="yaw-pitch")
    parser.add_argument("--layout", choices=("mecanum", "omni"), default="mecanum")
    args = parser.parse_args()
    elf = next((ROOT.parent / "UICRM-Embedded/cmake-build-debug/examples/DJI_Board_TypeC_general/motor").glob("*m6020.elf"))
    server = Server(("localhost", args.port), MotionFixture(elf, args.scenario, args.layout), ROOT / "tests/.runtime/motion-fixture")
    server.profiles.save({"version": 2, "elfPath": str(elf), "name": "图形回归 / 合成数据，非实车", "watches": [],
        "modules": {"gimbal": {"enabled": True, "mechanism": next(m for m in LIBRARY["gimbal"] if m["id"] == args.gimbal),
                               "axes": {k: {"motor": "fixture." + k} for k in ("yaw", "pitch", "smallYaw", "fold")}},
                    "chassis": {"enabled": True, "layout": args.layout, "wheels": {k: {"motor": "fixture." + k} for k in ("fl", "fr", "bl", "br", "left", "right", "front")}},
                    "vehicle": {"enabled": True}}})
    print(f"SYNTHETIC FIXTURE ONLY: http://localhost:{args.port}/", flush=True)
    try:
        with patch("backend.app.start_rtt", return_value="测试替身：无真实 RTT"), patch("backend.app.Handler.log_message", lambda *_: None):
            server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
