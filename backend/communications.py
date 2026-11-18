"""Read-only communication discovery, DWARF payload decoding and bounded frame history."""
import math
import struct
from .elf_index import type_of, text_attr
from .errors import DebugError

POINTERS = {'DW_TAG_pointer_type', 'DW_TAG_reference_type'}
COMPOSITES = {'DW_TAG_structure_type', 'DW_TAG_class_type'}
# Command identities only: field offsets, sizes and bitfields come from this ELF.
REFEREE_COMMANDS = {
    0x0001: ('game_status',), 0x0002: ('game_result',), 0x0003: ('game_robot_HP', 'game_robot_hp'),
    0x0101: ('event_data',), 0x0102: ('supply_projectile_action',),
    0x0104: ('referee_warning',), 0x0105: ('dart_remaining_time', 'dart_info'),
    0x0201: ('game_robot_status', 'robot_status'), 0x0202: ('power_heat_data',),
    0x0203: ('game_robot_pos', 'robot_pos'), 0x0204: ('buff',),
    0x0206: ('robot_hurt', 'hurt_data'), 0x0207: ('shoot_data',),
    0x0208: ('bullet_remaining', 'projectile_allowance'), 0x0209: ('rfid_status',),
    0x020A: ('dart_client_cmd',), 0x020B: ('ground_robot_position',),
    0x020C: ('radar_mark_data',), 0x020D: ('sentry_info',), 0x020E: ('radar_info',),
    0x0301: ('robot_interaction', 'student_interactive_data'),
    0x0302: ('custom_robot_data',), 0x0303: ('map_command',),
    0x0305: ('map_robot_data',), 0x0306: ('custom_client_data',),
    0x0307: ('map_path', 'custom_client_map_command'), 0x0308: ('custom_info',),
    0x0309: ('robot_custom_data',), 0x0310: ('robot_custom_data',), 0x0311: ('custom_control',),
    **{0x0A01+i: ('radar_opponent_'+n,) for i, n in enumerate(('pos', 'hp', 'allowance', 'macro', 'buff', 'key'))},
}


def exact(value):
    return str(value) if isinstance(value, int) and abs(value) > 2**53-1 else value


def decode_can(identifier, data):
    kind = (identifier >> 24) & 31
    formats = {1: 'q', 2: 'Q', 3: 'd', 4: 'i', 5: 'I', 6: '2i', 7: '2I', 8: 'f',
               9: '2f', 10: 'h', 11: 'H', 12: '2h', 13: '2H', 14: '4h', 15: '4H',
               16: '8b', 17: '8B', 25: 'Ii', 26: 'II', 27: 'If', 28: 'I2h', 29: 'I2H', 30: 'Q'}
    result = {'rxId': identifier & 255, 'txId': (identifier >> 8) & 255,
              'register': (identifier >> 16) & 255, 'dataType': kind}
    if kind in formats:
        fmt = '<'+formats[kind]
        if len(data) >= struct.calcsize(fmt):
            values = struct.unpack_from(fmt, data)
            result['values'] = [exact(v) if not isinstance(v, float) or math.isfinite(v) else None for v in values]
    return result


class CommunicationMonitor:
    def __init__(self, index):
        self.index, self.candidates, self.catalog, self.protocols = index, {}, {}, {}
        budget = [20000]

        def walk(path, die, depth=0):
            budget[0] -= 1
            if budget[0] < 0 or depth > 5 or len(self.candidates) >= 256:
                return
            base = index.base(die)
            if base is None:
                return
            pointer = base.tag in POINTERS
            obj = index.base(type_of(base)) if pointer else base
            if obj is None:
                return
            name = index.qualified_type_name(obj)
            members = index.members(obj) if obj.tag in COMPOSITES else {}
            family = None
            if name.endswith('::CanBridge'):
                family = 'can_bridge'
            elif name.endswith('::Referee'):
                family = 'referee_new' if 'protocol_' in members else 'referee_legacy'
            elif name.endswith('::ChassisCanBridgeSender') or 'chassis_can_bridge' in name.lower() or 'ChassisCanBridge' in name:
                family = 'chassis_bridge'
            if family:
                self.candidates[path] = {'path': path, 'family': family, 'type': name, 'die': obj}
                return
            if name.startswith('referee_comm::') and name.endswith('::Protocol') and 'game_status' in members:
                self.protocols[path] = obj
                return
            if pointer:
                return
            if obj.tag == 'DW_TAG_array_type':
                for n in range(min(index.array_count(obj), 32)):
                    walk(f'{path}[{n}]', type_of(obj), depth+1)
            else:
                for field, (_, typ) in members.items():
                    walk(path+'.'+field, typ, depth+1)
        for path, var in sorted(index.variables.items()):
            walk(path, var['die'])

    def object(self, path, reader):
        address, die = self.index.resolve(path, reader)
        die = self.index.base(die)
        if die.tag in POINTERS:
            address = int.from_bytes(reader(address, die.cu['address_size']), self.index.byteorder)
            die = self.index.base(type_of(die))
        if not address:
            raise DebugError('通信对象尚未初始化（空指针）。')
        return address, die

    def block(self, address, die, reader):
        size = self.index.size(die)
        if not 0 < size <= 32768:
            raise DebugError('通信对象大小无效。')
        return b''.join(reader(address+offset, min(512, size-offset)) for offset in range(0, size, 512))

    def fields(self, die, data, prefix='', depth=0, limit=768):
        """Decode packed DWARF bitfields and arrays; never follow payload pointers."""
        index, result = self.index, {}
        die = index.base(die)
        if die is None or depth > 7:
            return result
        if index.scalar(die):
            if len(data) >= index.size(die):
                try:
                    result[prefix.rstrip('.')] = exact(index.decode(die, data[:index.size(die)]))
                except DebugError:
                    result[prefix.rstrip('.')] = None
            return result
        if die.tag == 'DW_TAG_array_type':
            typ = type_of(die)
            size = index.size(typ)
            for n in range(min(index.array_count(die), 64)):
                key = prefix.rstrip('.')+'['+str(n)+']'
                result.update(self.fields(typ, data[n*size:(n+1)*size], key+'.', depth+1))
        elif die.tag in COMPOSITES or die.tag == 'DW_TAG_union_type':
            members = index.members(die)
            if die.tag == 'DW_TAG_union_type':
                members = {n: v for n, v in members.items() if n == ('id' if 'id' in members else 'data')}
            for name, (offset, typ) in members.items():
                if name.startswith('_vptr') or name in ('trace_', 'bufferRx', 'bufferTx', 'buffer_', 'tx_'):
                    continue
                result.update(self.fields(typ, data[offset:offset+index.size(typ)], prefix+name+'.', depth+1))
                if len(result) >= limit:
                    break
            for child in die.iter_children():
                bits = text_attr(child, 'DW_AT_bit_size', 0)
                if child.tag != 'DW_TAG_member' or not bits:
                    continue
                pos = text_attr(child, 'DW_AT_data_bit_offset', None)
                if pos is None:
                    offset = text_attr(child, 'DW_AT_data_member_location', 0)
                    if not isinstance(offset, int):
                        continue
                    pos = offset*8+index.size(type_of(child))*8-text_attr(child, 'DW_AT_bit_offset', 0)-bits
                if pos < 0 or pos+bits > len(data)*8:
                    continue
                value = (int.from_bytes(data, index.byteorder) >> pos) & ((1 << bits)-1)
                base = index.base(type_of(child))
                if text_attr(base, 'DW_AT_encoding', 7) in (5, 6) and value & (1 << (bits-1)):
                    value -= 1 << bits
                result[prefix+text_attr(child, 'DW_AT_name', '?')] = exact(value)
        return dict(list(result.items())[:limit])

    def protocol(self, address, die, reader):
        member = self.index.members(die).get('protocol_')
        if not member:
            return address, die
        target = int.from_bytes(reader(address+member[0], 4), self.index.byteorder)
        for path, typ in self.protocols.items():
            try:
                actual, _ = self.object(path, reader)
                if actual == target:
                    return actual, typ
            except DebugError:
                continue
        # A heap-allocated season implementation may only have a base reference.
        # Resolve its dynamic type through the ARM Itanium ABI vtable symbol.
        if target:
            vptr = int.from_bytes(reader(target, 4), self.index.byteorder)
            symbols = self.index.elf.get_section_by_name('.symtab')
            for (_, name), typ in self.index._definitions.items():
                if name.startswith('referee_comm::') and name.endswith('::Protocol') and 'game_status' in self.index.members(typ):
                    mangled = '_ZTVN'+''.join(str(len(p))+p for p in name.split('::'))+'E'
                    matches = symbols.get_symbol_by_name(mangled) if symbols else None
                    if matches and any(s['st_value']+8 == vptr for s in matches):
                        return target, typ
        raise DebugError('无法定位赛季 Protocol 对象；请保留该对象的全局／静态变量和 DWARF。')

    def scan(self, reader=None):
        items, seen = [], set()
        for path, item in self.candidates.items():
            public = {k: item[k] for k in ('path', 'family', 'type')}
            members = self.index.members(item['die'])
            public['capture'] = 'trace_' in members
            if item['family'] == 'chassis_bridge' and 'can_bridge_' in members:
                bridge = self.index.base(type_of(self.index.base(members['can_bridge_'][1])))
                public['capture'] = 'trace_' in self.index.members(bridge)
            if reader:
                try:
                    address, _ = self.object(path, reader)
                    if address in seen:
                        continue
                    seen.add(address)
                    public.update(address=hex(address), initialized=True)
                except DebugError as exc:
                    public.update(initialized=False, error=str(exc))
            items.append(public)
        self.catalog = {item['path']: item for item in items}
        return {'items': items, 'live': reader is not None,
                'note': '扫描当前 ELF 的通信对象；字段视图为内存快照，逐帧记录需固件 trace_ 环形缓冲。'}

    def trace(self, address, die, reader, after):
        index = self.index
        member = index.members(die).get('trace_')
        if not member:
            return {'frames': [], 'cursor': after, 'capture': False, 'dropped': 0}
        offset, typ = member
        members = index.members(typ)
        if not {'revision', 'total', 'records'} <= members.keys():
            raise DebugError('不支持此版本的帧记录布局。')
        base = address+offset
        total = int.from_bytes(reader(base+members['total'][0], 4), index.byteorder)
        arr_offset, arr_type = members['records']
        capacity = index.array_count(index.base(arr_type))
        entry_type = type_of(index.base(arr_type))
        size = index.size(entry_type)
        if not 0 < capacity <= 256 or not 0 < size <= 1024:
            raise DebugError('帧缓冲容量无效。')
        reset = after > total
        pending = total if reset else total-after
        count = min(pending, capacity)
        frames, overwritten = [], 0
        em = index.members(entry_type)
        seq_offset = em['sequence'][0]
        for sequence in range(total-count+1, total+1):
            pos = arr_offset+((sequence-1) % capacity)*size
            entry = self.block(base+pos, entry_type, reader)
            committed = int.from_bytes(reader(base+pos+seq_offset, 4), index.byteorder)
            fields = self.fields(entry_type, entry)
            if fields.get('sequence') != sequence or committed != sequence:
                overwritten += 1
                continue
            payload_offset, payload_type = em['data']
            n = min(int(fields.get('length', 0)), index.size(payload_type))
            payload = entry[payload_offset:payload_offset+n]
            frames.append({'sequence': sequence, 'timeMs': fields.get('timestamp_ms'),
                           'direction': 'TX' if fields.get('direction') else 'RX',
                           'id': fields.get('identifier', 0), 'length': n, 'hex': payload.hex(' ').upper()})
        return {'frames': frames, 'cursor': total, 'capture': True, 'dropped': max(0, pending-capacity)+overwritten, 'reset': reset}

    def sample(self, request, reader):
        if not isinstance(request, dict) or request.get('path') not in self.catalog:
            raise DebugError('请选择扫描列表中的通信链路。')
        path, after = request['path'], request.get('after', 0)
        if type(after) is not int or not 0 <= after <= 0xffffffff:
            raise DebugError('帧游标无效。')
        item = self.catalog[path]
        try:
            address, die = self.object(path, reader)
            fields = self.fields(die, self.block(address, die, reader))
            trace_address, trace_die = address, die
            bridge_member = self.index.members(die).get('can_bridge_') if item['family'] == 'chassis_bridge' else None
            if bridge_member and 'trace_' not in self.index.members(die):
                trace_address = int.from_bytes(reader(address+bridge_member[0], 4), self.index.byteorder)
                trace_die = self.index.base(type_of(self.index.base(bridge_member[1])))
                if not trace_address:
                    raise DebugError('底盘通信绑定的 CAN Bridge 尚未初始化。')
            trace = self.trace(trace_address, trace_die, reader, after)
            payload_die = die
            if item['family'] == 'referee_new':
                try:
                    pa, payload_die = self.protocol(address, die, reader)
                    fields.update({'protocol.'+k: v for k, v in self.fields(payload_die, self.block(pa, payload_die, reader)).items()})
                except DebugError as exc:
                    fields['protocol.error'] = str(exc)
            for frame in trace['frames']:
                raw = bytes.fromhex(frame['hex'])
                if item['family'] in ('can_bridge', 'chassis_bridge'):
                    frame['decoded'] = decode_can(frame['id'], raw)
                    if item['family'] == 'chassis_bridge':
                        reg = frame['decoded']['register']
                        if reg == fields.get('chassis_xy_reg_id_') and len(raw) == 8:
                            frame['decoded'].update(zip(('vx', 'vy'), decode_can(9 << 24, raw)['values']))
                            frame['command'] = '底盘平移'
                        elif reg == fields.get('chassis_turn_on_reg_id_') and len(raw) == 8:
                            frame['decoded'].update(zip(('enabled', 'turn'), decode_can(9 << 24, raw)['values']))
                            frame['command'] = '底盘使能 / 旋转'
                elif item['family'].startswith('referee') and len(raw) >= 9 and raw[0] == 0xA5:
                    cmd = int.from_bytes(raw[5:7], 'little')
                    frame['id'], frame['wireSequence'] = cmd, raw[3]
                    length = int.from_bytes(raw[1:3], 'little')
                    members = self.index.members(payload_die)
                    name = next((n for n in REFEREE_COMMANDS.get(cmd, ()) if n in members), None)
                    frame['command'] = name or '未知命令'
                    if name and length == len(raw)-9:
                        expected = self.index.size(members[name][1])
                        if length == expected or (cmd == 0x0301 and 6 <= length <= expected):
                            frame['decoded'] = self.fields(members[name][1], raw[7:7+length])
                        else:
                            frame['decodeError'] = f'载荷长度 {length} 与此 ELF 的 {expected} 字节布局不符'
            return {'path': path, 'family': item['family'], 'address': hex(address), 'fields': fields, **trace}
        except DebugError as exc:
            return {'path': path, 'error': str(exc), 'fields': {}, 'frames': [], 'cursor': after}
