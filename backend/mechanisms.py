"""Declarative mechanism templates shared with the frontend; no executable JSON."""
from copy import deepcopy
import json
import math
import re
from . import ROOT
from .errors import DebugError

LIBRARY = json.loads((ROOT / "frontend/assets/models/library.json").read_text(encoding="utf-8"))


def identifier(value):
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,39}", value) and value not in ("constructor", "prototype", "__proto__")


def vector(value):
    return isinstance(value, list) and len(value) == 3 and all(type(x) in (int, float) and math.isfinite(x) and abs(x) <= 100000 for x in value)


def validate_mechanism(model, kind):
    def fail():
        raise DebugError("构型定义无效，请检查关节层级、轴向、轮位与解算器。")
    if not isinstance(model, dict) or not identifier(model.get("id")):
        fail()
    if not isinstance(model.get("name"), str) or not 1 <= len(model["name"]) <= 100:
        fail()
    items = model.get("joints" if kind == "gimbal" else "wheels")
    if not isinstance(items, list) or not 1 <= len(items) <= 16:
        fail()
    seen = set()
    if kind == "chassis" and "outline" in model:
        outline = model["outline"]
        if not isinstance(outline, list) or not 3 <= len(outline) <= 32 or any(not isinstance(p, list) or len(p) != 2 or not vector(p + [0]) for p in outline):
            fail()
    for item in items:
        if not isinstance(item, dict) or not identifier(item.get("id")) or item["id"] in seen:
            fail()
        if not isinstance(item.get("label"), str) or not 1 <= len(item["label"]) <= 100:
            fail()
        if kind == "gimbal":
            if item.get("parent") is not None and (not identifier(item["parent"]) or item["parent"] not in seen):
                fail()
            if not vector(item.get("origin")) or not vector(item.get("axis")) or math.hypot(*item["axis"]) < .000001:
                fail()
            if "rest" in item and not vector(item["rest"]):
                fail()
        else:
            if not vector(item.get("position")) or type(item.get("angle")) not in (int, float) or not math.isfinite(item["angle"]) or abs(item["angle"]) > 360000:
                fail()
            if type(item.get("rollingSign")) is not int or item["rollingSign"] not in (-1, 1) or type(item.get("roller")) is not int or item["roller"] not in (-1, 0, 1):
                fail()
            if model.get("adapter") == "matrix" and not vector(item.get("drive")):
                fail()
        seen.add(item["id"])
    if kind == "gimbal":
        tool = model.get("tool")
        fields = [item["id"] + suffix for item in items for suffix in ("", "Target", "Speed")]
        if any(item["id"] in ("enabled", "mode", "config") for item in items) or len(set(fields)) != len(fields):
            fail()
        if model.get("adapter") != "joint-tree" or not isinstance(tool, dict) or not identifier(tool.get("parent")) or tool["parent"] not in seen or not vector(tool.get("origin")) or math.hypot(*tool["origin"]) < .000001:
            fail()
    elif model.get("adapter") == "uicrm-four":
        factor = model.get("factor")
        if [w["id"] for w in items] != ["fl", "fr", "bl", "br"] or type(factor) not in (int, float) or not math.isfinite(factor) or not 0 < factor <= 2:
            fail()
    elif model.get("adapter") == "matrix":
        components = model.get("components")
        if not isinstance(components, list) or not components or any(k not in ("vx", "vy", "omega") for k in components) or len(set(components)) != len(components):
            fail()
    else:
        fail()
    # Return JSON data only. Unknown metadata is retained for portable templates.
    return deepcopy(model)


def migrate_mechanism(model, kind):
    # Match the entire old shipped snapshot, never merely its ID.
    for migration in LIBRARY.get("gimbalMigrations", []) if kind == "gimbal" else []:
        if model == migration["from"]:
            if migration["to"]:
                return deepcopy(next(m for m in LIBRARY["gimbal"] if m["id"] == migration["to"]))
            return {**deepcopy(model), "id": "legacy-four-axis", "name": "旧四轴自定义（请重新选择构型）"}
    return deepcopy(model)


def resolve_mechanism(item, kind):
    if item.get("mechanism") is not None:
        return migrate_mechanism(validate_mechanism(item["mechanism"], kind), kind)
    model_id = item.get("layout", "mecanum") if kind == "chassis" else "yaw-pitch"
    for model in LIBRARY[kind]:
        if model["id"] == model_id:
            return deepcopy(model)
    raise DebugError("找不到构型模板。")


def supports_world_gimbal(config):
    joints = config["mechanism"]["joints"]
    if len(joints) != 2:
        return False
    a, b = joints
    return (a["id"] == "yaw" and a.get("parent") is None and b["id"] == "pitch" and b.get("parent") == "yaw"
            and a["axis"][:2] == [0, 0] and a["axis"][2] > 0
            and b["axis"][0] == b["axis"][2] == 0 and b["axis"][1] < 0
            and all(v == 0 for j in joints for v in j.get("rest", []))
            and all(v == 0 for v in config["mount"]["position"] + config["mount"]["rotation"]))
