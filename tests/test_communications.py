"""Communication adapters against real ARM DWARF with bounded, synthetic RAM."""
from pathlib import Path
import struct
import unittest
from backend.communications import CommunicationMonitor, decode_can
from backend.elf_index import ElfIndex, type_of
from backend.errors import DebugError
from backend.session import DebugSession
from backend.profiles import validate_profile

FIRMWARE = Path(__file__).resolve().parents[2] / 'UICRM-Embedded'


class CommunicationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        base = FIRMWARE / 'cmake-build-debug/examples/DJI_Board_TypeC_general'
        can = base / 'can_bridge/example_can_bridge_DJI_Board_TypeC_general_host.elf'
        referee = base / 'referee/example_referee_DJI_Board_TypeC_general.elf'
        if not can.exists() or not referee.exists():
            raise unittest.SkipTest('Build TypeC can_bridge host and referee examples first')
        cls.can_index, cls.ref_index = ElfIndex(can), ElfIndex(referee)
        if not CommunicationMonitor(cls.can_index).scan()['items'][0]['capture']:
            raise unittest.SkipTest('Rebuild examples with communication_trace.h')

    def setup_link(self, index, path):
        self.index, self.path, self.ram = index, path, {}
        self.monitor = CommunicationMonitor(index)
        self.address = 0x20008000
        self.put(index.variables[path]['address'], self.address.to_bytes(4, 'little'))
        self.die = self.monitor.candidates[path]['die']
        self.monitor.scan(self.read)

    def put(self, address, data):
        for n, value in enumerate(data):
            self.ram[address+n] = value

    def read(self, address, size):
        self.assertLessEqual(size, 512)
        self.assertTrue(0x20000000 <= address < 0x20080000)
        return bytes(self.ram.get(address+n, 0) for n in range(size))

    def member(self, address, die, name):
        offset, typ = self.index.members(die)[name]
        return address+offset, typ

    def frame(self, seq, identifier, data, direction=0):
        trace, typ = self.member(self.address, self.die, 'trace_')
        records, arr = self.member(trace, typ, 'records')
        capacity = self.index.array_count(self.index.base(arr))
        entry = type_of(self.index.base(arr))
        slot = records+((seq-1) % capacity)*self.index.size(entry)
        for name, value in dict(sequence=seq, timestamp_ms=seq*2, identifier=identifier, length=len(data), direction=direction).items():
            addr, t = self.member(slot, entry, name)
            self.put(addr, value.to_bytes(self.index.size(t), 'little'))
        addr, _ = self.member(slot, entry, 'data')
        self.put(addr, data)
        addr, _ = self.member(trace, typ, 'total')
        self.put(addr, seq.to_bytes(4, 'little'))

    def sample(self, after=0):
        return self.monitor.sample({'path': self.path, 'after': after}, self.read)

    def test_can_typed_packets_identical_payloads_and_cursors(self):
        self.setup_link(self.can_index, 'can_bridge')
        identifier = (9 << 24) | (0x70 << 16) | (0x51 << 8) | 0x52
        for seq in (1, 2):
            self.frame(seq, identifier, struct.pack('<2f', 1.25, -2.5), direction=seq % 2)
        data = self.sample()
        self.assertEqual(len(data['frames']), 2)
        self.assertEqual(data['frames'][0]['direction'], 'TX')
        self.assertEqual(data['frames'][1]['decoded']['values'], [1.25, -2.5])
        self.assertEqual(data['frames'][0]['decoded']['register'], 0x70)
        self.assertEqual(data['cursor'], 2)
        self.assertEqual(self.sample(2)['frames'], [])

    def test_ring_overwrite_and_restart_report_loss(self):
        self.setup_link(self.can_index, 'can_bridge')
        for seq in range(1, 41):
            self.frame(seq, 0, bytes(8))
        data = self.sample(2)
        self.assertEqual([f['sequence'] for f in data['frames']], list(range(9, 41)))
        self.assertEqual(data['dropped'], 6)
        trace, typ = self.member(self.address, self.die, 'trace_')
        total, _ = self.member(trace, typ, 'total')
        self.put(total, (1).to_bytes(4, 'little'))
        self.frame(1, 0, bytes(8))
        self.assertTrue(self.sample(40)['reset'])

    def test_concurrent_overwrite_drops_torn_frame_and_recovers(self):
        self.setup_link(self.can_index, 'can_bridge')
        self.frame(1, 0, bytes(8))
        trace, typ = self.member(self.address, self.die, 'trace_')
        records, arr = self.member(trace, typ, 'records')
        entry = type_of(self.index.base(arr))
        sequence, _ = self.member(records, entry, 'sequence')
        original = self.read
        def racing(address, size):
            if address == sequence and size == 4:
                return bytes(4)
            return original(address, size)
        data = self.monitor.sample({'path': self.path}, racing)
        self.assertEqual(data['frames'], [])
        self.assertEqual(data['dropped'], 1)
        self.assertEqual(len(self.sample()['frames']), 1)

    def test_referee_decodes_packed_bitfields_and_preserves_64bit(self):
        self.setup_link(self.ref_index, 'referee')
        payload = bytes([0x41])+struct.pack('<HQ', 321, 2**63+7)
        wire = bytes([0xa5, len(payload), 0, 17, 0, 1, 0])+payload+bytes(2)
        self.frame(1, 1, wire)
        frame = self.sample()['frames'][0]
        self.assertEqual(frame['wireSequence'], 17)
        self.assertEqual(frame['command'], 'game_status')
        self.assertEqual(frame['decoded']['game_type'], 1)
        self.assertEqual(frame['decoded']['game_progress'], 4)
        self.assertEqual(frame['decoded']['stage_remain_time'], 321)
        self.assertEqual(frame['decoded']['SyncTimeStamp'], str(2**63+7))

    def test_null_pointer_and_invalid_request_do_not_return_old_data(self):
        self.setup_link(self.can_index, 'can_bridge')
        self.put(self.index.variables[self.path]['address'], bytes(4))
        data = self.sample()
        self.assertIn('空指针', data['error'])
        self.assertEqual(data['fields'], {})
        for request in ({'path': 'arbitrary'}, {'path': self.path, 'after': -1}, {'path': self.path, 'after': True}):
            with self.assertRaises(DebugError):
                self.monitor.sample(request, self.read)

    def test_uninstrumented_firmware_keeps_snapshot_without_fabricated_packets(self):
        self.setup_link(self.can_index, 'can_bridge')
        original = self.index.members
        def old_members(die, *args):
            return {k: v for k, v in original(die, *args).items() if k != 'trace_'}
        self.index.members = old_members
        try:
            data = self.sample()
            self.assertFalse(data['capture'])
            self.assertEqual(data['frames'], [])
            self.assertIn('id_', data['fields'])
        finally:
            self.index.members = original

    def test_communication_only_sampling_requires_verified_elf(self):
        self.setup_link(self.can_index, 'can_bridge')
        session = DebugSession(FIRMWARE)
        session.index, session.communications = self.index, self.monitor
        session.probe = type('Probe', (), {'sock': True, 'read': staticmethod(self.read)})()
        with self.assertRaises(DebugError):
            session.sample([], self.index.sha, communication={'path': self.path})
        session.verified_sha = self.index.sha
        result = session.sample([], self.index.sha, communication={'path': self.path})
        self.assertEqual(result['communication']['path'], self.path)
        self.assertEqual(result['values'], [])


class DecoderTests(unittest.TestCase):
    def test_all_can_types_and_nonfinite_values(self):
        self.assertEqual(decode_can(2 << 24, struct.pack('<Q', 2**64-1))['values'], [str(2**64-1)])
        self.assertEqual(decode_can(28 << 24, struct.pack('<I2h', 1234, -3, 5))['values'], [1234, -3, 5])
        self.assertEqual(decode_can(8 << 24, struct.pack('<f', float('nan')))['values'], [None])
        self.assertNotIn('values', decode_can(9 << 24, bytes(4)))

    def test_profile_retains_link_selection_without_watch_binding(self):
        body = {'version': 2, 'elfPath': str(FIRMWARE / 'a.elf'), 'watches': [],
                'modules': {'communications': {'enabled': True, 'selected': 'referee', 'direction': 'RX', 'filter': '0201'}}}
        settings = validate_profile(body)['modules']['communications']
        self.assertTrue(settings['enabled'])
        self.assertEqual(settings['selected'], 'referee')
        body['modules']['communications']['direction'] = 'invalid'
        with self.assertRaises(DebugError):
            validate_profile(body)


class SeasonTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path = Path(__file__).parent / '.runtime/communication-season/seasons.elf'
        if not path.exists():
            raise unittest.SkipTest('Run python tests/build_communication_fixtures.py first')
        cls.index = ElfIndex(path)

    def season_link(self, year):
        fixture = CommunicationTests()
        fixture.setup_link(self.index, 'link'+str(year))
        proto = self.index.variables['season'+str(year)]
        member, _ = fixture.member(fixture.address, fixture.die, 'protocol_')
        fixture.put(member, proto['address'].to_bytes(4, 'little'))
        return fixture, proto

    def test_distinct_season_layouts_decode_different_robot_status_lengths(self):
        for year, size in ((2026, 13), (2027, 17)):
            with self.subTest(year=year):
                f, proto = self.season_link(year)
                payload = bytes([3, 2])+struct.pack('<5H', 123, 456, 7, 8, 90)+bytes([7])
                if year == 2027:
                    payload = payload[:-1]+struct.pack('<f', 15.5)+payload[-1:]
                self.assertEqual(len(payload), size)
                wire = bytes([0xa5, size, 0, 25, 0, 1, 2])+payload+bytes(2)
                f.frame(1, 0x0201, wire)
                snapshot = f.sample()
                self.assertNotIn('error', snapshot)
                self.assertEqual(snapshot['family'], 'referee_new')
                frame = snapshot['frames'][0]
                self.assertEqual(frame['command'], 'robot_status')
                self.assertEqual(frame['decoded']['robot_id'], 3)
                self.assertEqual(frame['decoded']['current_HP'], 123)
                self.assertEqual(frame['decoded']['power_management_chassis_output'], 1)
                if year == 2027:
                    self.assertEqual(frame['decoded']['bullet_speed_limit'], 15.5)

    def test_heap_season_protocol_resolves_dynamic_vtable_without_named_global(self):
        f, proto = self.season_link(2027)
        name = '_ZTVN12referee_comm5v20278ProtocolE'
        symbol = self.index.elf.get_section_by_name('.symtab').get_symbol_by_name(name)[0]
        f.put(proto['address'], (symbol['st_value']+8).to_bytes(4, 'little'))
        f.monitor.protocols.clear()
        address, typ = f.monitor.protocol(f.address, f.die, f.read)
        self.assertEqual(address, proto['address'])
        self.assertEqual(self.index.qualified_type_name(typ), 'referee_comm::v2027::Protocol')

    def test_new_referee_preserves_full_309_byte_custom_frame_and_unknown_commands(self):
        f, _ = self.season_link(2027)
        payload = bytes(range(256))+bytes(range(44))
        wire = bytes([0xa5, 44, 1, 4, 0, 0x10, 3])+payload+bytes(2)
        f.frame(1, 0x0310, wire, 1)
        frame = f.sample()['frames'][0]
        self.assertEqual(frame['length'], 309)
        self.assertEqual(bytes.fromhex(frame['hex']), wire)
        self.assertEqual(frame['command'], 'robot_custom_data')
        f.frame(2, 0xbeef, bytes([0xa5, 1, 0, 5, 0, 0xef, 0xbe, 7, 0, 0]))
        unknown = f.sample(1)['frames'][0]
        self.assertEqual(unknown['id'], 0xbeef)
        self.assertNotIn('decoded', unknown)


    def test_wrong_known_payload_length_is_not_decoded_as_this_season(self):
        f, _ = self.season_link(2027)
        wire = bytes([0xa5, 13, 0, 1, 0, 1, 2])+bytes(13)+bytes(2)
        f.frame(1, 0x0201, wire)
        frame = f.sample()['frames'][0]
        self.assertIn('decodeError', frame)
        self.assertNotIn('decoded', frame)


if __name__ == '__main__':
    unittest.main()
