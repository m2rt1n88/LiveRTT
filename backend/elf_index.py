"""ELF/DWARF browsing and bounded STM32F4 memory decoding."""
import hashlib
import io
import math
import re
import struct
from pathlib import Path
from .errors import DebugError
try:
    from elftools.elf.elffile import ELFFile
    from elftools.dwarf.dwarf_expr import DWARFExprParser
except ImportError:
    raise SystemExit("Missing pyelftools. Run start_debugger.cmd")

def text_attr(die, name, default=""):
    value = die.attributes.get(name)
    if value is None:
        return default
    return value.value.decode("utf-8", "replace") if isinstance(value.value, bytes) else value.value


def inherited_attr(die, name, seen=None):
    if die is None:
        return None, None
    seen = set() if seen is None else seen
    if die.offset in seen:
        return None, None
    seen.add(die.offset)
    if name in die.attributes:
        return die, die.attributes[name]
    for ref in ("DW_AT_specification", "DW_AT_abstract_origin"):
        if ref in die.attributes:
            owner, attr = inherited_attr(die.get_DIE_from_attribute(ref), name, seen)
            if attr is not None:
                return owner, attr
    return None, None


def type_of(die):
    owner, attr = inherited_attr(die, "DW_AT_type")
    return owner.get_DIE_from_attribute("DW_AT_type") if attr is not None else None


def bare_type(die):
    seen = set()
    while die is not None and die.tag in {
        "DW_TAG_typedef", "DW_TAG_const_type", "DW_TAG_volatile_type",
        "DW_TAG_restrict_type", "DW_TAG_atomic_type",
    }:
        if die.offset in seen:
            return None
        seen.add(die.offset)
        die = type_of(die)
    return die


class ElfIndex:
    def __init__(self, path):
        self.path = Path(path).expanduser().resolve()
        if self.path.suffix.lower() != ".elf" or not self.path.is_file():
            raise DebugError("请选择存在的 .elf 文件（填写本机完整路径）。")
        if self.path.stat().st_size > 128 * 1024 * 1024:
            raise DebugError("ELF 超过 128 MB，第一版暂不支持。")
        content = self.path.read_bytes()
        self.sha = hashlib.sha256(content).hexdigest()
        self.stream = io.BytesIO(content)
        self.elf = ELFFile(self.stream)
        if self.elf["e_machine"] != "EM_ARM" or self.elf.elfclass != 32:
            raise DebugError("第一版支持 32 位 ARM ELF，适用于 C 板 STM32。")
        if not self.elf.has_dwarf_info():
            raise DebugError("ELF 缺少 DWARF 调试信息，请使用带 -g 的构建。")
        self.dwarf = self.elf.get_dwarf_info()
        self.expr = DWARFExprParser(self.dwarf.structs)
        self.byteorder = "little" if self.elf.little_endian else "big"
        self.variables = {}
        self._members_cache = {}
        self._definitions = {}
        for cu in self.dwarf.iter_CUs():
            for die in cu.iter_DIEs():
                if die.tag in ("DW_TAG_structure_type", "DW_TAG_class_type", "DW_TAG_union_type", "DW_TAG_enumeration_type") and "DW_AT_byte_size" in die.attributes and not text_attr(die, "DW_AT_declaration", False):
                    self._definitions.setdefault((die.tag, self.qualified_type_name(die)), die)
        self._index()
        self.signatures = []
        # Flash spot checks detect common wrong-ELF cases, not an exact image identity proof.
        for name in (".isr_vector", ".text"):
            section = self.elf.get_section_by_name(name)
            if section is not None and section["sh_size"] >= 32:
                data = section.data()
                for offset in sorted({0, max(0, len(data) // 2 - 16), len(data) - 32}):
                    address = section["sh_addr"] + offset
                    if 0x08000000 <= address < 0x08200000 - 32:
                        self.signatures.append((address, data[offset:offset + 32]))
        if not self.variables:
            raise DebugError("没有找到带固定内存地址和类型信息的变量。")

    def qualified_type_name(self, die):
        parts = [text_attr(die, "DW_AT_name")]
        parent = die.get_parent()
        while parent is not None:
            if parent.tag in ("DW_TAG_namespace", "DW_TAG_structure_type", "DW_TAG_class_type"):
                name = text_attr(parent, "DW_AT_name")
                if name:
                    parts.append(name)
            parent = parent.get_parent()
        return "::".join(reversed(parts))

    def base(self, die):
        die = bare_type(die)
        if die is not None and text_attr(die, "DW_AT_declaration", False):
            return self._definitions.get((die.tag, self.qualified_type_name(die)), die)
        return die

    def _index(self):
        def walk(parent, scope=""):
            for die in parent.iter_children():
                if die.tag == "DW_TAG_namespace":
                    name = text_attr(die, "DW_AT_name")
                    walk(die, scope + name + "::" if name else scope)
                elif die.tag == "DW_TAG_variable":
                    owner, name_attr = inherited_attr(die, "DW_AT_name")
                    _, loc = inherited_attr(die, "DW_AT_location")
                    typ = type_of(die)
                    if name_attr is None or loc is None or typ is None:
                        continue
                    if loc.form not in ("DW_FORM_exprloc", "DW_FORM_block", "DW_FORM_block1", "DW_FORM_block2", "DW_FORM_block4"):
                        continue
                    try:
                        ops = self.expr.parse_expr(loc.value)
                    except Exception:
                        continue
                    if len(ops) != 1 or ops[0].op_name != "DW_OP_addr":
                        continue
                    name = name_attr.value.decode("utf-8", "replace")
                    if not re.fullmatch(r"[A-Za-z_$][\w$]*", name, re.ASCII):
                        continue
                    qualified = scope + name
                    address = ops[0].args[0]
                    if not (0x20000000 <= address < 0x20080000 or 0x10000000 <= address < 0x10010000):
                        continue  # Exclude garbage-collected symbols, flash constants and peripheral objects.
                    key = qualified
                    if key in self.variables:
                        if self.variables[key]["address"] == address:
                            continue
                        key += "@" + format(die.offset, "x")
                    self.variables[key] = {"name": name, "path": key, "address": address, "die": typ}
                elif die.tag in ("DW_TAG_subprogram", "DW_TAG_lexical_block"):
                    # Also discover static locals with a permanent address. Stack locals are excluded.
                    walk(die, scope)
        for cu in self.dwarf.iter_CUs():
            walk(cu.get_top_DIE())

    def size(self, die):
        die = self.base(die)
        if die is None:
            return 0
        if "DW_AT_byte_size" in die.attributes:
            return die.attributes["DW_AT_byte_size"].value
        if die.tag == "DW_TAG_pointer_type":
            return die.cu["address_size"]
        if die.tag == "DW_TAG_array_type":
            return self.size(type_of(die)) * self.array_count(die)
        if die.tag == "DW_TAG_enumeration_type":
            return self.size(type_of(die))
        return 0

    def type_name(self, die, depth=0):
        if die is None or depth > 12:
            return "unknown"
        name = text_attr(die, "DW_AT_name")
        if name:
            return name
        if die.tag in ("DW_TAG_pointer_type", "DW_TAG_reference_type", "DW_TAG_rvalue_reference_type"):
            return self.type_name(type_of(die), depth + 1) + "*"
        if die.tag == "DW_TAG_array_type":
            return self.type_name(type_of(die), depth + 1) + "[" + str(self.array_count(die)) + "]"
        base = self.base(die)
        return self.type_name(base, depth + 1) if base is not die else die.tag.removeprefix("DW_TAG_")

    def array_count(self, die):
        dims = [child for child in die.iter_children() if child.tag == "DW_TAG_subrange_type"]
        if len(dims) != 1:
            return 0  # Explicitly exclude multidimensional/dynamic bounds in v1.
        attrs = dims[0].attributes
        lower = attrs.get("DW_AT_lower_bound")
        if lower and lower.value != 0:
            return 0
        if "DW_AT_count" in attrs:
            return attrs["DW_AT_count"].value
        upper = attrs.get("DW_AT_upper_bound")
        return upper.value + 1 if upper and isinstance(upper.value, int) else 0

    def members(self, die, seen=None):
        die = self.base(die)
        if die is None:
            return {}
        if die.offset in self._members_cache:
            return self._members_cache[die.offset]
        seen = set() if seen is None else seen
        if die.offset in seen:
            return {}
        seen = seen | {die.offset}
        result = {}
        for child in die.iter_children():
            if child.tag not in ("DW_TAG_member", "DW_TAG_inheritance"):
                continue
            if any(key in child.attributes for key in ("DW_AT_bit_size", "DW_AT_data_bit_offset")):
                continue
            attr = child.attributes.get("DW_AT_data_member_location")
            if attr is None:
                # A union's non-static members start at zero. No location on a class member usually means static.
                if die.tag != "DW_TAG_union_type" or child.tag != "DW_TAG_member":
                    continue
                offset = 0
            elif isinstance(attr.value, int):
                offset = attr.value
            else:
                try:
                    ops = self.expr.parse_expr(attr.value)
                except Exception:
                    continue
                if len(ops) != 1 or ops[0].op_name != "DW_OP_plus_uconst":
                    continue
                offset = ops[0].args[0]
            typ = type_of(child)
            if typ is None:
                continue
            if child.tag == "DW_TAG_inheritance":
                for name, (base_offset, base_type) in self.members(typ, seen).items():
                    result.setdefault(name, (offset + base_offset, base_type))
            else:
                name = text_attr(child, "DW_AT_name")
                if name and re.fullmatch(r"[A-Za-z_$][\w$]*", name, re.ASCII):
                    result[name] = (offset, typ)
        self._members_cache[die.offset] = result
        return result

    def scalar(self, die):
        die = self.base(die)
        return bool(die and die.tag in ("DW_TAG_base_type", "DW_TAG_enumeration_type") and 0 < self.size(die) <= 8)

    def describe(self, path, name, die, **extra):
        base = self.base(die)
        target = self.base(type_of(base)) if base is not None and base.tag == "DW_TAG_pointer_type" else base
        expandable = bool(target and (target.tag in ("DW_TAG_structure_type", "DW_TAG_class_type", "DW_TAG_union_type") or (target.tag == "DW_TAG_array_type" and self.array_count(target) > 0)))
        return {"path": path, "name": name, "type": self.type_name(die), "size": self.size(die),
                "scalar": self.scalar(die), "expandable": expandable, **extra}

    def tokens(self, path):
        if not isinstance(path, str) or len(path) > 600:
            raise DebugError("变量路径无效。")
        match = re.match(r"[A-Za-z_$][\w$:]*(?:@[0-9a-f]+)?", path, re.ASCII)
        if not match or match.group() not in self.variables:
            raise DebugError("ELF 中找不到该根变量，请先搜索变量或检查拼写。")
        root = match.group()
        rest = path[match.end():]
        tokens = []
        while rest:
            member = re.match(r"(->|\.)([A-Za-z_$][\w$]*)", rest, re.ASCII)
            index = re.match(r"\[(\d+)\]", rest, re.ASCII)
            if member:
                tokens.append((member[1], member[2]))
                rest = rest[member.end():]
            elif index:
                tokens.append(("[]", int(index[1])))
                rest = rest[index.end():]
            else:
                raise DebugError("仅支持变量、.成员、->成员和[数组下标]，不支持函数或任意表达式。")
            if len(tokens) > 24:
                raise DebugError("变量路径过深。")
        return root, tokens

    def resolve(self, path, reader=None):
        root, tokens = self.tokens(path)
        var = self.variables[root]
        address, die = var["address"], var["die"]
        for op, name in tokens:
            base = self.base(die)
            if base is None:
                raise DebugError("变量类型信息不完整。")
            if op == "->":
                if base.tag != "DW_TAG_pointer_type":
                    raise DebugError("-> 前必须是指针。")
                if reader:
                    pointer = int.from_bytes(reader(address, self.size(base)), self.byteorder)
                    if not pointer:
                        raise DebugError("对象指针为空，可能尚未初始化。")
                    address = pointer
                base = self.base(type_of(base))
                if base is None:
                    raise DebugError("无法解析指针指向的类型。")
            if op == "[]":
                if base.tag != "DW_TAG_array_type" or not 0 <= name < self.array_count(base):
                    raise DebugError("数组下标越界，或数组形状暂不支持。")
                die = type_of(base)
                address += name * self.size(die)
            else:
                if base.tag not in ("DW_TAG_structure_type", "DW_TAG_class_type", "DW_TAG_union_type"):
                    raise DebugError("成员访问需要结构体或对象。")
                fields = self.members(base)
                if name not in fields:
                    raise DebugError("找不到成员 " + str(name) + "（位域和虚继承暂不支持）。")
                offset, die = fields[name]
                address += offset
        return address, die

    def children(self, path):
        _, die = self.resolve(path)
        base = self.base(die)
        sep = "."
        if base is not None and base.tag == "DW_TAG_pointer_type":
            base = self.base(type_of(base))
            sep = "->"
        if base is None:
            return []
        if base.tag == "DW_TAG_array_type":
            return [self.describe(path + "[" + str(i) + "]", "[" + str(i) + "]", type_of(base))
                    for i in range(min(32, self.array_count(base)))]
        return [self.describe(path + sep + name, name, typ) for name, (_, typ) in self.members(base).items()]

    def search(self, query, offset=0):
        query = query.strip().casefold()
        roots = [v for k, v in sorted(self.variables.items()) if query in k.casefold() or query in self.type_name(v["die"]).casefold()]
        return {"total": len(roots), "items": [self.describe(v["path"], v["path"], v["die"], address=hex(v["address"])) for v in roots[offset:offset + 80]]}

    def decode(self, die, data):
        base = self.base(die)
        if not self.scalar(base):
            raise DebugError("请选择具体数值字段，不能直接绘制整个对象或指针。")
        if base.tag == "DW_TAG_enumeration_type":
            under = self.base(type_of(base))
            encoding = text_attr(under, "DW_AT_encoding", 5) if under is not None else 5
        else:
            encoding = text_attr(base, "DW_AT_encoding", 0)
        if encoding == 4:
            if len(data) not in (4, 8):
                raise DebugError("暂不支持该浮点长度。")
            value = struct.unpack(("<" if self.byteorder == "little" else ">") + ("f" if len(data) == 4 else "d"), data)[0]
            if not math.isfinite(value):
                raise DebugError("数据为 NaN/Inf，请检查初始化状态和 ELF 是否匹配。")
            return value
        if encoding not in (2, 5, 6, 7, 8):
            raise DebugError("暂不支持该数值编码。")
        value = int.from_bytes(data, self.byteorder, signed=encoding in (5, 6))
        return bool(value) if encoding == 2 else value


