"""CAN motor adapters, with all offsets obtained from this ELF's DWARF."""
from .elf_index import type_of
from .errors import DebugError
from .motor_control import control_schema


def online_state(last, now, threshold):
    if last is None or now is None or threshold is None:
        return {"online": None, "feedbackAgeMs": None, "status": "unknown"}
    age = (int(now) - int(last)) & 0xffffffff
    return {"online": bool(last and age < threshold), "feedbackAgeMs": age if last else None,
            "status": "waiting" if not last else "online" if age < threshold else "offline"}


class MotorMonitor:
    def __init__(self, index):
        self.index = index
        self.candidates = {}
        self.catalog = {}
        budget = [20000]
        def walk(path, die, depth, registry=False):
            budget[0] -= 1
            if budget[0] < 0 or depth > 5 or len(self.candidates) >= 256:
                return
            base = index.base(die)
            if base is None:
                return
            pointer = base.tag == "DW_TAG_pointer_type"
            obj = index.base(type_of(base)) if pointer else base
            if obj is None:
                return
            members = index.members(obj) if obj.tag in ("DW_TAG_class_type", "DW_TAG_structure_type") else {}
            if {"can_", "rx_id_", "last_uptime_"} <= members.keys():
                state = index.members(members["state_"][1]) if "state_" in members else {}
                family = ("DJI" if "target" in state and "output_" in members else "DM" if {"tx", "rx"} <= state.keys()
                          else "CyberGear" if {"theta_", "omega_", "torque_", "mode_", "error_code_"} <= members.keys() else None)
                if family:
                    self.candidates[path] = {"path": path, "family": family, "type": index.type_name(obj), "die": obj, "registry": registry}
                return
            if pointer:  # Never traverse arbitrary object graphs or void pointers.
                return
            if obj.tag == "DW_TAG_array_type":
                for n in range(min(index.array_count(obj), 64)):
                    walk(f"{path}[{n}]", type_of(obj), depth + 1, registry)
            else:
                for name, (_, typ) in members.items():
                    walk(path + "." + name, typ, depth + 1, registry)
        # Named objects are preferred over registry aliases when deduplicating live addresses.
        for path, item in sorted(index.variables.items(), key=lambda p: ("groups_" in p[0] or "instances_" in p[0], p[0])):
            walk(path, item["die"], 0, item["name"] in ("groups_", "instances_"))

    def object(self, path, reader):
        address, die = self.index.resolve(path, reader)
        die = self.index.base(die)
        if die.tag == "DW_TAG_pointer_type":
            address = int.from_bytes(reader(address, self.index.size(die)), self.index.byteorder)
            die = self.index.base(type_of(die))
        if not address:
            raise DebugError("电机尚未构造（空指针），运行初始化后重新扫描。")
        return address, die

    def scan(self, reader=None):
        items, addresses = [], set()
        for path, item in self.candidates.items():
            if reader is None and item["registry"]:
                continue  # Runtime slots have no identity until their pointer is read.
            public = {k: item[k] for k in ("path", "family", "type")}
            if reader:
                try:
                    address, _ = self.object(path, reader)
                    if address in addresses:
                        continue
                    snapshot = self.read(path, reader)
                    addresses.add(address)
                    public.update({k: snapshot.get(k) for k in ("bus", "rxId", "txId")})
                except DebugError:
                    continue  # Unoccupied registry slots and unconstructed globals.
            items.append(public)
        self.catalog = {item["path"]: item for item in items}
        return {"items": items, "live": reader is not None,
                "note": "扫描 DJI 分组表、DM 实例表及静态电机对象（含 CyberGear）；只能发现固件中的电机，无法探测未注册的物理设备。"}

    def read(self, path, reader):
        index = self.index
        address, die = self.object(path, reader)
        size = index.size(die)
        if not 0 < size <= 8192:
            raise DebugError("电机对象布局大小无效。")
        # A few bounded contiguous reads instead of one Tcl request per field.
        data = b"".join(reader(address + offset, min(512, size - offset)) for offset in range(0, size, 512))
        fields, errors = {}, {}
        def flatten(typ, offset=0, prefix="", depth=0):
            if depth > 4:
                return
            for name, (delta, field_type) in index.members(typ).items():
                key = prefix + name
                pos = offset + delta
                if index.scalar(field_type):
                    try:
                        fields[key] = index.decode(field_type, data[pos:pos + index.size(field_type)])
                    except DebugError as exc:
                        errors[key] = str(exc)
                else:
                    base = index.base(field_type)
                    if base is not None and base.tag in ("DW_TAG_class_type", "DW_TAG_structure_type"):
                        flatten(base, pos, key + ".", depth + 1)
        flatten(die)
        def ptr_member(obj_addr, obj_die, name):
            member = index.members(obj_die).get(name)
            if not member:
                return None, None
            offset, typ = member
            return int.from_bytes(reader(obj_addr + offset, index.size(typ)), index.byteorder), index.base(type_of(index.base(typ)))
        bus = "未知 CAN"
        try:
            can, can_die = ptr_member(address, die, "can_")
            if can:
                hcan, _ = ptr_member(can, can_die, "hcan_")
                match = next((v["name"] for v in index.variables.values() if v["address"] == hcan and v["name"].startswith("hcan")), None)
                bus = match.upper().replace("HCAN", "CAN") if match else f"CAN@{can:#x}"
        except DebugError:
            pass
        tick = None
        clock = next((v for v in index.variables.values() if v["name"] == "uwTick"), None)
        if clock:
            tick = index.decode(clock["die"], reader(clock["address"], index.size(clock["die"])))
        # Read the heartbeat again next to HAL time, rather than using the old object
        # block from before the CAN metadata reads (the firmware threshold is only 30 ms).
        heartbeat = index.members(die).get("last_uptime_")
        last = fields.get("last_uptime_")
        if heartbeat:
            offset, typ = heartbeat
            last = index.decode(typ, reader(address + offset, index.size(typ)))
            fields["last_uptime_"] = last
        during_read = bool(last and tick is not None and ((int(tick) - int(last)) & 0xffffffff) > 0x7fffffff)
        status = online_state(last, last if during_read else tick, fields.get("online_threshold_"))
        return {"path": path, "family": self.candidates[path]["family"], "type": index.type_name(die),
                "address": hex(address), "control": control_schema(self, path, fields, reader),
                "bus": bus, "rxId": fields.get("rx_id_"), "txId": fields.get("tx_id_"),
                **status, "feedbackTimeNote": "读取时收到新反馈" if during_read else "",
                "fields": fields, "fieldErrors": errors}

    def sample(self, paths, reader):
        if not isinstance(paths, list) or len(paths) > 64 or any(not isinstance(p, str) or p not in self.catalog for p in paths):
            raise DebugError("请选择扫描列表中的电机（最多 64 个）。")
        result = []
        for path in paths:
            try:
                result.append(self.read(path, reader))
            except DebugError as exc:
                result.append({"path": path, "error": str(exc), "status": "error", "fields": {}})
        return result
