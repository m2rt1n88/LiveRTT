"""Versioned per-ELF profiles, atomically persisted outside the public web root."""
from copy import deepcopy
import json
import math
import os
import re
from pathlib import Path
import tempfile
import threading
import time
import uuid
from .errors import DebugError
from .mechanisms import resolve_mechanism, vector, identifier, supports_world_gimbal

MODULE_FIELDS = {
    "gimbal": ("yaw", "yawTarget", "pitch", "pitchTarget", "yawSpeed", "pitchSpeed", "enabled", "mode"),
    "chassis": ("vx", "vy", "omega", "heading", "vxTarget", "vyTarget", "omegaTarget", "enabled"),
    "motors": ("angle", "speed", "current", "temperature"),
    "vehicle": ("headingTarget",),
}

def text(value, name, limit=1024):
    if not isinstance(value, str) or len(value) > limit or "\x00" in value:
        raise DebugError(name + " 必须是有效文本。")
    return value.strip()

def numeric(item, key, default, low, high):
    value = item.get(key, default)
    if type(value) not in (int, float) or not math.isfinite(value) or not low <= value <= high:
        raise DebugError(key + " 数值超出允许范围。")
    return value

def motion_settings(name, item):
    unit = item.get("angleUnit", "rad")
    if unit not in ("rad", "deg"):
        raise DebugError("角度单位无效。")
    model = resolve_mechanism(item, name)
    cleaned = {"angleUnit": unit, "mechanism": model}
    group = "axes" if name == "gimbal" else "wheels"
    source = item.get(group, {})
    if not isinstance(source, dict):
        raise DebugError("轴 / 轮组配置无效。")
    slots = [s["id"] for s in model["joints" if name == "gimbal" else "wheels"]]
    # Keep inactive calibrations when switching templates; do not sample them.
    slots += [s for s in source if s not in slots and s not in ("rl", "rr")]
    if len(slots) > 32 or any(not identifier(s) for s in slots):
        raise DebugError("轴 / 轮组名称或数量无效。")
    cleaned[group] = {}
    for slot in slots:
        cfg = source.get(slot, source.get({"bl": "rl", "br": "rr"}.get(slot), {}))
        if not isinstance(cfg, dict) or type(cfg.get("sign", 1)) is not int or cfg.get("sign", 1) not in (-1, 1):
            raise DebugError("轴 / 轮组方向无效。")
        settings = {"motor": text(cfg.get("motor", ""), "电机绑定", 512), "sign": cfg.get("sign", 1),
                    "ratio": numeric(cfg, "ratio", 1, .0001, 100000)}
        if name == "gimbal":
            settings.update(zero=numeric(cfg, "zero", 0, -360000, 360000),
                            min=numeric(cfg, "min", -30 if slot == "pitch" else -180, -360000, 360000),
                            max=numeric(cfg, "max", 30 if slot == "pitch" else 180, -360000, 360000))
            if settings["min"] >= settings["max"]:
                raise DebugError("角度下限必须小于上限。")
        cleaned[group][slot] = settings
    if name == "gimbal":
        cleaned.update(yawWrap=item.get("yawWrap", True) is True, tolerance=numeric(item, "tolerance", 3, .01, 180))
        mount = item.get("mount", {"position": [0, 0, 0], "rotation": [0, 0, 0]})
        if not isinstance(mount, dict) or not vector(mount.get("position")) or not vector(mount.get("rotation")):
            raise DebugError("云台安装位姿无效。")
        cleaned["mount"] = deepcopy(mount)
    else:
        layout = model["id"]
        cleaned.update(layout=layout, radius=numeric(item, "radius", .076, .001, 2),
                       halfLength=numeric(item, "halfLength", .2, .001, 5), halfWidth=numeric(item, "halfWidth", .2, .001, 5),
                       vectorScale=numeric(item, "vectorScale", 2, .01, 100),
                       offset=numeric(item, "offset", 0, -1, 1))
        units = item.get("commandUnits", "si")
        if units not in ("si", "setSpeed"):
            raise DebugError("底盘指令单位无效。")
        if units == "setSpeed" and model["adapter"] != "uicrm-four":
            raise DebugError("SetSpeed 原始量只适用于仓库四轮解算器，请选择物理量。")
        cleaned["commandUnits"] = units
        motors = [cleaned[group][s["id"]]["motor"] for s in model["wheels"] if cleaned[group][s["id"]]["motor"]]
        if len(set(motors)) != len(motors):
            raise DebugError("同一个电机不能重复绑定到多个车轮。")
    return cleaned

def validate_profile(body):
    if not isinstance(body, dict) or body.get("version", 2) != 2:
        raise DebugError("配置版本无效，需要 version: 2。")
    elf = text(body.get("elfPath", ""), "ELF 路径", 4096)
    if not elf or Path(elf).suffix.lower() != ".elf":
        raise DebugError("请填写 ELF 路径。")
    connection = body.get("connection", {})
    if not isinstance(connection, dict):
        raise DebugError("连接配置无效。")
    ports = [connection.get("port", 6666), connection.get("rttPort", 8888)]
    if any(type(p) is not int or not 1 <= p <= 65535 for p in ports) or ports[0] == ports[1]:
        raise DebugError("Tcl / RTT 端口必须有效且不重复。")
    watches = body.get("watches", [])
    if not isinstance(watches, list) or len(watches) > 16:
        raise DebugError("每份配置最多保存 16 个变量。")
    cleaned, paths = [], set()
    for watch in watches:
        if not isinstance(watch, dict):
            raise DebugError("变量配置无效。")
        path = text(watch.get("path", ""), "变量路径", 512)
        scale = watch.get("scale", 1)
        if not path or path in paths or type(scale) not in (int, float) or not math.isfinite(scale):
            raise DebugError("变量路径重复、为空或倍率无效。")
        paths.add(path)
        cleaned.append({"path": path, "label": text(watch.get("label", path), "变量名称", 100),
                        "unit": text(watch.get("unit", ""), "单位", 100), "scale": scale,
                        "plot": watch.get("plot", True) is True})
    rate, window = body.get("rate", 10), str(body.get("window", "30"))
    if type(rate) is not int or rate not in (5, 10, 20) or window not in ("10", "30", "120", "all"):
        raise DebugError("采样频率或曲线窗口无效。")
    modules = body.get("modules", {})
    if not isinstance(modules, dict):
        raise DebugError("监视模块配置无效。")
    cleaned_modules = {}
    for name, fields in MODULE_FIELDS.items():
        item = modules.get(name, {})
        if not isinstance(item, dict) or not isinstance(item.get("bindings", {}), dict):
            raise DebugError("监视模块绑定无效。")
        settings = motion_settings(name, item) if name in ("gimbal", "chassis") else {}
        if name == "gimbal":
            fields = tuple(dict.fromkeys((*fields, *(s + suffix for s in settings["axes"] for suffix in ("", "Target", "Speed")))))
        bindings = {field: text(item.get("bindings", {}).get(field, ""), "绑定变量", 512) for field in fields}
        if any(value and value not in paths for value in bindings.values()):
            raise DebugError("模块只能绑定当前已选变量。")
        cleaned_modules[name] = {"enabled": item.get("enabled", False) is True, "bindings": bindings}
        if name in ("gimbal", "chassis"):
            cleaned_modules[name].update(settings)
        if name == "vehicle":
            unit, frame = item.get("angleUnit", "rad"), item.get("gimbalFrame", "body")
            if unit not in ("rad", "deg") or frame not in ("body", "world"):
                raise DebugError("整车角度单位或云台参考系无效。")
            cleaned_modules[name].update(angleUnit=unit, gimbalFrame=frame)
        if name == "motors":
            selected = item.get("selected", [])
            if not isinstance(selected, list) or len(selected) > 64:
                raise DebugError("最多选择 64 个电机。")
            selected = [text(p, "电机路径", 512) for p in selected]
            if any(not p for p in selected) or len(set(selected)) != len(selected):
                raise DebugError("电机路径为空或重复。")
            cleaned_modules[name].update(selected=selected, focus=text(item.get("focus", ""), "重点电机", 512), bus=text(item.get("bus", ""), "CAN 筛选", 100))
    if cleaned_modules["vehicle"]["gimbalFrame"] == "world" and not supports_world_gimbal(cleaned_modules["gimbal"]):
        raise DebugError("多关节或偏置安装云台请使用 body 关节参考系；world 仅支持默认安装的常规 Yaw / Pitch。")
    return {"version": 2, "name": text(body.get("name", Path(elf).stem), "配置名称", 100) or Path(elf).stem,
            "elfPath": str(Path(elf).expanduser().resolve()), "connection": {
                "autoStart": connection.get("autoStart", True) is True,
                "executable": text(connection.get("executable", ""), "OpenOCD 程序", 4096),
                "config": text(connection.get("config", ""), "OpenOCD 配置", 4096),
                "port": ports[0], "rttPort": ports[1]},
            "watches": cleaned, "rate": rate, "window": window, "modules": cleaned_modules}


class ProfileStore:
    def __init__(self, data_root):
        self.root = Path(data_root)
        self.path = self.root / "profiles.json"
        self.lock = threading.RLock()

    def _read(self):
        if not self.path.exists():
            return {"version": 1, "profiles": []}
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            if data.get("version") != 1 or not isinstance(data.get("profiles"), list):
                raise ValueError("unsupported store format")
            return data
        except (ValueError, AttributeError, OSError) as exc:
            raise DebugError("配置库读取失败，原文件已保留：" + str(self.path) + " · " + str(exc)) from exc

    def list(self):
        with self.lock:
            return [{key: p[key] for key in ("id", "name", "elfPath", "updatedAt")} for p in
                    sorted(self._read()["profiles"], key=lambda p: p["updatedAt"], reverse=True)]

    def get(self, profile_id):
        with self.lock:
            for profile in self._read()["profiles"]:
                if profile["id"] == profile_id:
                    return deepcopy(profile)
        raise DebugError("找不到这份调试配置。")

    def save(self, body):
        profile = validate_profile(body)
        profile_id = body.get("id", "")
        if profile_id and (not isinstance(profile_id, str) or not re.fullmatch(r"[a-f0-9]{32}", profile_id)):
            raise DebugError("配置 ID 无效。")
        with self.lock:
            data = self._read()
            match = next((p for p in data["profiles"] if p["id"] == profile_id), None)
            if profile_id and match is None:
                raise DebugError("配置已不存在，请重新选择配置。")
            if not profile_id:
                match = next((p for p in data["profiles"] if os.path.normcase(p["elfPath"]) == os.path.normcase(profile["elfPath"])), None)
            profile["id"] = match["id"] if match else uuid.uuid4().hex
            profile["updatedAt"] = time.time()
            if match:
                data["profiles"][data["profiles"].index(match)] = profile
            else:
                if len(data["profiles"]) >= 200:
                    raise DebugError("配置已达 200 份上限。")
                data["profiles"].append(profile)
            self.root.mkdir(parents=True, exist_ok=True)
            temp_path = None
            try:
                with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.root, prefix="profiles-", suffix=".tmp", delete=False) as handle:
                    temp_path = Path(handle.name)
                    json.dump(data, handle, ensure_ascii=False, allow_nan=False, indent=2)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temp_path, self.path)
            finally:
                if temp_path and temp_path.exists():
                    temp_path.unlink()
            return deepcopy(profile)
