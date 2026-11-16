"""Explicit motor parameter allowlist; live SWD writes do not invoke firmware methods."""
import math
import struct
import time
from .elf_index import type_of, text_attr
from .errors import DebugError

PID_FEATURES = [
    {"bit": 1, "label": "积分限幅 / 抗饱和"},
    {"bit": 2, "label": "微分先行"},
    {"bit": 4, "label": "梯形积分"},
    {"bit": 16, "label": "输出滤波"},
    {"bit": 32, "label": "变速积分"},
    {"bit": 64, "label": "微分滤波"},
]
PID_WRITABLE_BITS = 0x77


def _mutable(index, die):
    seen = set()
    while die is not None and die.offset not in seen:
        seen.add(die.offset)
        if die.tag in ("DW_TAG_const_type", "DW_TAG_atomic_type"):
            raise DebugError("const / atomic 参数不支持直接写入。")
        if die.tag not in ("DW_TAG_typedef", "DW_TAG_volatile_type", "DW_TAG_restrict_type"):
            return index.base(die)
        die = type_of(die)
    raise DebugError("参数类型不完整。")


def field_location(monitor, path, field, reader, *, boolean=False, pid_flags=False):
    index = monitor.index
    address, typ = index.resolve(path, reader)
    base = index.base(typ)
    if base is not None and base.tag == "DW_TAG_pointer_type":
        # A const pointer may point at a mutable object; a pointer to const may not.
        address = int.from_bytes(reader(address, index.size(base)), index.byteorder)
        typ = type_of(base)
    if not address:
        raise DebugError("电机对象为空。")
    origin = address
    for name in field.split("."):
        base = _mutable(index, typ)
        if base.tag not in ("DW_TAG_class_type", "DW_TAG_structure_type"):
            raise DebugError("仅允许普通结构体中的参数字段。")
        member = index.members(base).get(name)
        if member is None:
            raise DebugError("ELF 中没有该参数。")
        offset, typ = member
        address += offset
    base = _mutable(index, typ)
    size, encodings = (1, (2,)) if boolean else (1, (7, 8)) if pid_flags else (4, (4,))
    if pid_flags and field not in ("omega_pid_.mode_", "theta_pid_.mode_"):
        raise DebugError("仅允许已实现的 PID 特性位。")
    if index.size(base) != size or base.tag != "DW_TAG_base_type" or text_attr(base, "DW_AT_encoding", 0) not in encodings:
        raise DebugError("使能字段必须是单字节 bool。" if boolean else "第一版电机写入仅支持 float32 参数。")
    if address % size or not any(start <= origin <= address and address + size <= end
                            for start, end in ((0x20000000, 0x20080000), (0x10000000, 0x10010000))):
        raise DebugError("参数地址不在支持的对齐 RAM 范围内。")
    object_address, object_die = monitor.object(path, reader)
    if origin != object_address or address + size > origin + index.size(object_die):
        raise DebugError("电机地址已变化或参数超出对象范围，请重新采样。")
    return address, typ


def control_schema(monitor, path, fields, reader):
    source, cache = reader, {}
    def reader(address, size):
        key = (address, size)
        if key not in cache:
            cache[key] = source(address, size)
        return cache[key]
    family = monitor.candidates[path]["family"]
    mode = fields.get("state_.mode")
    descriptors, angle = [], None

    def add(field, label, group, unit="", minimum=None, maximum=None):
        if field not in fields:
            return
        try:
            field_location(monitor, path, field, reader)
        except DebugError:
            return
        descriptors.append({"field": field, "label": label, "group": group, "unit": unit,
                            "min": minimum, "max": maximum})

    if family == "DJI":
        for ring, group, unit in (("omega_pid_", "速度环 PID", "raw"), ("theta_pid_", "角度环 PID", "rad/s")):
            for key, label in (("kp_", "Kp"), ("ki_", "Ki"), ("kd_", "Kd")):
                add(ring + "." + key, label, group)
            for key, label, value_unit in (("max_out_", "输出限幅", unit), ("max_iout_", "积分限幅", unit),
                                           ("dead_band_", "死区", "rad/s" if ring == "omega_pid_" else "rad")):
                add(ring + "." + key, label, group, value_unit, 0)
            for key, label in (("Output_Filtering_Coefficient", "输出滤波系数"), ("Derivative_Filtering_Coefficient", "微分滤波系数")):
                add(ring + "." + key, label, group, "", 0, 1)
            input_unit = "rad/s" if ring == "omega_pid_" else "rad"
            add(ring + ".ScalarA", "变速积分 A（过渡宽度）", group, input_unit, 0)
            add(ring + ".ScalarB", "变速积分 B（完整积分区）", group, input_unit, 0)
            for descriptor in descriptors:
                if descriptor["field"] in (ring + ".ScalarA", ring + ".ScalarB"):
                    descriptor["requiresDisabled"] = True
            flag_field = ring + ".mode_"
            if type(fields.get(flag_field)) is int:
                try:
                    field_location(monitor, path, flag_field, reader, pid_flags=True)
                    descriptors.append({"field": flag_field, "label": "算法开关", "group": group,
                                        "unit": "bitmask", "min": 0, "max": 255, "kind": "pidFlags",
                                        "options": PID_FEATURES, "requiresDisabled": True})
                except DebugError:
                    pass
        # A CURRENT bit bypasses both closed loops, even if THETA is also set.
        if isinstance(mode, int) and not mode & 1:
            if mode & 4:
                absolute = bool(mode & 128)
                add("state_.target", "角度目标", "控制目标", "rad", 0 if absolute else None,
                    2 * math.pi if absolute else None)
                angle = {"field": "state_.target", "feedback": "state_.output_shaft_theta", "absolute": absolute}
            elif mode & 2:
                add("state_.target", "速度目标", "控制目标", "rad/s")
        # These are current raw runtime values, not a promise of persistent calibration.
        add("state_.speed_feedforward", "速度前馈", "运行前馈", "rad/s")
        add("state_.torque_feedforward", "电流前馈", "运行前馈", "raw")
    elif family == "DM":
        def limit(key):
            value = fields.get("config_." + key)
            return value if isinstance(value, (int, float)) and math.isfinite(value) and value > 0 else None
        if mode in (0, 256) and limit("angle_max"):
            maximum = limit("angle_max")
            add("state_.tx.p_des", "角度目标", "控制目标", "rad", -maximum, maximum)
            angle = {"field": "state_.tx.p_des", "feedback": "state_.theta", "absolute": False}
        if mode in (0, 256, 512) and limit("omega_max"):
            maximum = limit("omega_max")
            add("state_.tx.v_des", "速度设定 / 上限", "控制目标", "rad/s", 0 if mode == 256 else -maximum, maximum)
        if mode == 0:
            for key, label, unit, range_key, positive in (("kp", "Kp", "", "kp_max", True),
                    ("kd", "Kd", "", "kd_max", True), ("t_ff", "力矩前馈", "N·m", "torque_max", False)):
                maximum = limit(range_key)
                if maximum:
                    add("state_.tx." + key, label, "MIT 参数", unit, 0 if positive else -maximum, maximum)
    if angle and not any(d["field"] == angle["field"] for d in descriptors):
        angle = None
    enable = {"supported": False, "reason": "ELF 中缺少可写的使能字段。" if family == "DJI"
              else "此驱动需要固件发送设备使能命令，暂不支持 SWD 使能开关。"}
    if family == "DJI" and type(fields.get("state_.enable")) is bool:
        try:
            field_location(monitor, path, "state_.enable", reader, boolean=True)
            enable = {"supported": True, "reason": "软件使能；关闭后由固件控制循环归零输出。重新开启会执行板端现有目标。"}
        except DebugError as exc:
            enable["reason"] = str(exc)
    return {"fields": descriptors, "angle": angle, "mode": mode, "enable": enable,
            "reason": "此驱动没有可定位的控制目标，暂不支持 SWD 写入。" if family == "CyberGear" else ""}


def set_motor_enabled(monitor, probe, path, expected_address, expected_mode, enabled):
    """A dedicated DJI bool write, never a float write or a device CAN command."""
    if not isinstance(path, str) or path not in monitor.catalog:
        raise DebugError("请先扫描并选择当前 ELF 中的电机。")
    if type(enabled) is not bool:
        raise DebugError("电机使能必须是 true 或 false。")
    snapshot = monitor.read(path, probe.read)
    if snapshot["address"] != expected_address:
        raise DebugError("电机对象地址已变化，请重新采样。")
    if not snapshot["control"]["enable"]["supported"]:
        raise DebugError(snapshot["control"]["enable"]["reason"])
    # Disabling remains available while offline or after a control-mode change.
    if enabled and (type(expected_mode) is not int or expected_mode != snapshot["control"]["mode"]):
        raise DebugError("电机模式已变化，请重新采样后使能。")
    if enabled and snapshot.get("online") is not True:
        raise DebugError("电机反馈在线后才能开启使能。")
    address, _ = field_location(monitor, path, "state_.enable", probe.read, boolean=True)
    # Resolve the object again immediately before touching RAM.
    current, object_die = monitor.object(path, probe.read)
    if hex(current) != expected_address:
        raise DebugError("电机对象地址已变化，已取消使能写入。")
    if enabled:
        offset, state_die = monitor.index.members(object_die)["state_"]
        delta, mode_type = monitor.index.members(state_die)["mode"]
        live_mode = monitor.index.decode(mode_type, probe.read(current + offset + delta, monitor.index.size(mode_type)))
        if live_mode != expected_mode:
            raise DebugError("控制模式已变化，已取消开启使能。")
    before = snapshot["fields"]["state_.enable"]
    probe.write_bool(address, enabled)
    result = {"path": path, "requested": enabled, "before": before, "written": True, "complete": False}
    try:
        actual = probe.read(address, 1)
        result.update({"readback": bool(actual[0]), "matched": actual == bytes([int(enabled)])})
        motor = monitor.read(path, probe.read)
        result["motor"] = motor
        result["complete"] = (result["matched"] and motor["address"] == expected_address
                              and motor["fields"].get("state_.enable") is enabled)
    except (DebugError, OSError) as exc:
        result["error"] = "使能已写入，但状态未能确认：" + str(exc)
    result["time"] = time.time()
    return result


def write_motor(monitor, probe, path, expected_address, expected_mode, updates):
    if not isinstance(path, str) or path not in monitor.catalog:
        raise DebugError("请先扫描并选择当前 ELF 中的电机。")
    if not isinstance(updates, list) or not 1 <= len(updates) <= 16:
        raise DebugError("每次写入 1～16 个电机参数。")
    snapshot = monitor.read(path, probe.read)
    schema = snapshot["control"]
    if expected_address != snapshot["address"] or type(expected_mode) is not int or expected_mode != schema["mode"]:
        raise DebugError("电机对象或模式已变化，请重新采样后写入。")
    allowed = {item["field"]: item for item in schema["fields"]}
    prepared, seen = [], set()
    final_fields = dict(snapshot["fields"])
    guarded_rings = set()
    for update in updates:
        if not isinstance(update, dict) or not isinstance(update.get("field"), str):
            raise DebugError("参数写入格式无效。")
        field, value = update["field"], update.get("value")
        if field not in allowed or field in seen:
            raise DebugError("该字段不允许写入或出现重复：" + field)
        seen.add(field)
        try:
            finite = type(value) in (int, float) and math.isfinite(value)
        except OverflowError:
            finite = False
        if not finite:
            raise DebugError("参数必须是有限数值。")
        item = allowed[field]
        is_flags = item.get("kind") == "pidFlags"
        if item.get("requiresDisabled") and snapshot["fields"].get("state_.enable") is not False:
            raise DebugError("切换 PID 算法或修改 A/B 前，请先关闭电机软件使能。")
        if is_flags:
            before = snapshot["fields"][field]
            if type(value) is not int or not 0 <= value <= 255 or (before ^ value) & ~PID_WRITABLE_BITS:
                raise DebugError("仅允许修改界面列出的六个 PID 特性；保留位与故障回调开关保持原值。")
            if type(update.get("expected")) is not int or update["expected"] != before:
                raise DebugError("PID 特性已变化，请重新采样后修改。")
        if (item["min"] is not None and value < item["min"]) or (item["max"] is not None and value > item["max"]):
            raise DebugError(item["label"] + " 超出允许范围。")
        if item["group"] == "控制目标":
            fields = snapshot["fields"]
            if snapshot.get("online") is not True or fields.get("state_.enable") is not True:
                raise DebugError("目标控制需要电机在线且已由固件使能。")
            if snapshot["family"] == "DM" and fields.get("state_.rx.status") != 1:
                raise DebugError("DM 反馈尚未处于使能状态。")
            if schema["angle"] and field == schema["angle"]["field"] and schema["angle"]["feedback"] not in fields:
                raise DebugError("角度反馈无效，暂不能写入角度目标。")
        try:
            data = bytes([value]) if is_flags else struct.pack("<f" if monitor.index.byteorder == "little" else ">f", value)
        except (OverflowError, struct.error) as exc:
            raise DebugError("参数超出 float32 范围。") from exc
        address, typ = field_location(monitor, path, field, probe.read, pid_flags=is_flags)
        prepared.append((field, address, typ, value, data))
        final_fields[field] = value if is_flags else struct.unpack("<f" if monitor.index.byteorder == "little" else ">f", data)[0]
        if item.get("requiresDisabled"):
            guarded_rings.add(field.split(".")[0])
    for ring in guarded_rings:
        if final_fields.get(ring + ".mode_", 0) & 32:
            a, b = final_fields.get(ring + ".ScalarA"), final_fields.get(ring + ".ScalarB")
            if not (type(a) in (int, float) and type(b) in (int, float) and
                    math.isfinite(a) and math.isfinite(b) and a > 0 and b >= 0 and a + b <= 3.4028234663852886e38):
                raise DebugError("变速积分需要 float32 编码后 A > 0、B ≥ 0，且 A+B 不溢出。")
    # Configure floats first, then activate flags, with the motor disabled throughout.
    prepared.sort(key=lambda item: allowed[item[0]].get("kind") == "pidFlags")
    results = []
    expected_live = dict(snapshot["fields"])
    # All fields are validated first. This is deliberately sequential, not a transaction.
    for field, address, typ, value, data in prepared:
        result = {"field": field, "requested": value, "before": snapshot["fields"][field]}
        try:
            current, object_die = monitor.object(path, probe.read)
            if hex(current) != expected_address:
                raise DebugError("电机对象地址已变化，已停止后续写入。")
            # Re-read mode immediately before each word, in addition to the full preflight.
            offset, state_die = monitor.index.members(object_die)["state_"]
            delta, mode_type = monitor.index.members(state_die)["mode"]
            live_mode = monitor.index.decode(mode_type, probe.read(current + offset + delta, monitor.index.size(mode_type)))
            if live_mode != expected_mode:
                raise DebugError("控制模式已变化，已停止后续写入。")
            if guarded_rings:
                enable_address, _ = field_location(monitor, path, "state_.enable", probe.read, boolean=True)
                if probe.read(enable_address, 1) != b"\x00":
                    raise DebugError("电机已被重新使能，已停止高级参数写入。")
                for ring in guarded_rings:
                    flag_address, _ = field_location(monitor, path, ring + ".mode_", probe.read, pid_flags=True)
                    if probe.read(flag_address, 1) != bytes([expected_live[ring + ".mode_"]]):
                        raise DebugError("PID 特性在写入期间变化，已停止后续写入。")
                    for key in ("ScalarA", "ScalarB"):
                        dependency = ring + "." + key
                        dependency_address, dependency_type = field_location(monitor, path, dependency, probe.read)
                        if monitor.index.decode(dependency_type, probe.read(dependency_address, 4)) != expected_live.get(dependency):
                            raise DebugError("A/B 在写入期间变化，已停止后续写入。")
            if allowed[field].get("kind") == "pidFlags":
                probe.write_byte(address, value)
            else:
                probe.write_word(address, data, monitor.index.byteorder)
            result["written"] = True
            actual = probe.read(address, len(data))
            result.update({"readback": monitor.index.decode(typ, actual), "matched": actual == data})
            if result["matched"]:
                expected_live[field] = result["readback"]
        except (DebugError, OSError) as exc:
            result["error"] = str(exc)
            results.append(result)
            break
        results.append(result)
        if not result.get("matched"):
            break
    return {"path": path, "time": time.time(), "results": results, "sequential": True,
            "complete": len(results) == len(prepared) and all(r.get("matched") for r in results)}
