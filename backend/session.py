"""A target session; profile metadata never stores memory addresses."""
import threading
import time
from pathlib import Path
from .elf_index import ElfIndex
from .errors import DebugError
from .motors import MotorMonitor
from .motor_control import write_motor, set_motor_enabled
from .probe import OpenOCD, OpenOCDService, RttReader

class DebugSession:
    def __init__(self, firmware_root):
        self.lock = threading.RLock()
        self.index = None
        self.probe = OpenOCD()
        self.rtt = RttReader()
        self.firmware_root = Path(firmware_root).resolve()
        self.service = OpenOCDService(self.firmware_root)
        self.verified_sha = None
        self.motors = None

    def disconnect(self):
        self.rtt.close()
        self.probe.close()
        self.service.stop()
        self.verified_sha = None

    def presets(self):
        """Discover recent build outputs from any example/program, with bounded scanning."""
        result = []
        for name in ("cmake-build-debug", "cmake-build-release", "build"):
            base = self.firmware_root / name
            if not base.is_dir():
                continue
            for path in base.rglob("*.elf"):
                if path.is_file():
                    result.append({"name": path.name, "path": str(path), "modified": path.stat().st_mtime})
                if len(result) >= 500:
                    break
        return sorted(result, key=lambda item: item["modified"], reverse=True)[:100]

    def load(self, path):
        candidate = ElfIndex(path)
        self.disconnect()
        self.index = candidate
        self.motors = MotorMonitor(candidate)
        self.verified_sha = None
        return {"path": str(candidate.path), "sha": candidate.sha, "variables": len(candidate.variables), "presets": self.presets()}

    def require_elf(self, sha=None):
        if self.index is None:
            raise DebugError("请先加载 ELF。")
        if sha is not None and sha != self.index.sha:
            raise DebugError("ELF 已被其他页面切换，请重新加载变量列表。")
        return self.index

    def verify(self, sha):
        index = self.require_elf(sha)
        self.verified_sha = None
        if not index.signatures:
            raise DebugError("ELF 中没有可用于比对的 Flash 代码段。")
        for address, expected in index.signatures:
            if self.probe.read(address, len(expected), flash=True) != expected:
                raise DebugError("板上代码与所选 ELF 抽查不一致。请选择烧录时生成的 ELF，再重新连接。")
        self.verified_sha = index.sha
        return {"matched": True, "blocks": len(index.signatures), "note": "代码抽查一致；仍需确认 ELF 与烧录文件属于同一次构建。"}

    def scan_motors(self, sha):
        index = self.require_elf(sha)
        if self.motors is None:
            self.motors = MotorMonitor(index)
        live = self.probe.sock is not None and self.verified_sha == index.sha
        return self.motors.scan(self.probe.read if live else None)

    def sample(self, paths, sha, motor_paths=None):
        index = self.require_elf(sha)
        if self.probe.sock is None:
            raise DebugError("尚未连接 OpenOCD。")
        if self.verified_sha != index.sha:
            raise DebugError("请先连接 OpenOCD 并通过代码抽查。")
        motor_paths = [] if motor_paths is None else motor_paths
        if not isinstance(paths, list) or len(paths) > 16 or any(not isinstance(p, str) for p in paths) or (not paths and not motor_paths):
            raise DebugError("每次请选择 1～16 个数值字段。")
        start = time.perf_counter()
        cache = {}

        def reader(address, size):
            key = (address, size)
            if key not in cache:
                cache[key] = self.probe.read(address, size)
            return cache[key]

        values = []
        for path in paths:
            try:
                address, die = index.resolve(path, reader)
                if not index.scalar(die):
                    raise DebugError("不是可绘制的数值字段。")
                value = index.decode(die, reader(address, index.size(die)))
                # Preserve exact 64-bit integers in JSON; the chart receives an approximation.
                exact = str(value) if isinstance(value, int) and abs(value) > 2 ** 53 - 1 else None
                values.append({"path": path, "value": value if exact is None else float(value), "exact": exact, "address": hex(address)})
            except DebugError as exc:
                values.append({"path": path, "value": None, "error": str(exc)})
        if motor_paths and self.motors is None:
            raise DebugError("请先扫描电机。")
        motors = self.motors.sample(motor_paths, self.probe.read) if self.motors else []
        return {"time": time.time(), "durationMs": round((time.perf_counter() - start) * 1000, 2),
                "values": values, "motors": motors, "connected": self.probe.sock is not None}

    def write_motor(self, body):
        index = self.require_elf(body.get("sha", ""))
        if self.probe.sock is None or self.verified_sha != index.sha:
            raise DebugError("请先连接 OpenOCD 并通过代码抽查。")
        if self.motors is None:
            raise DebugError("请先扫描电机。")
        return write_motor(self.motors, self.probe, body.get("path"), body.get("address"),
                           body.get("mode"), body.get("updates"))

    def set_motor_enabled(self, body):
        index = self.require_elf(body.get("sha", ""))
        if self.probe.sock is None or self.verified_sha != index.sha:
            raise DebugError("请先连接 OpenOCD 并通过代码抽查。")
        if self.motors is None:
            raise DebugError("请先扫描电机。")
        return set_motor_enabled(self.motors, self.probe, body.get("path"), body.get("address"),
                                 body.get("mode"), body.get("enabled"))


