"""Motor adapter regression tests against real C-board DWARF, using fake RAM only."""
from pathlib import Path
import struct
import unittest
from backend.elf_index import ElfIndex, type_of
from backend.motors import MotorMonitor, online_state
from backend.errors import DebugError
from backend.session import DebugSession
from backend.profiles import validate_profile
from backend.motor_control import write_motor, set_motor_enabled, field_location, _mutable
from backend.probe import OpenOCD
from unittest.mock import Mock
from types import SimpleNamespace

FIRMWARE = Path(__file__).resolve().parents[2] / 'UICRM-Embedded'

class MotorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        paths = list(FIRMWARE.glob('cmake-build-debug/examples/DJI_Board_TypeC_general/motor/*m6020.elf'))
        if not paths:
            raise unittest.SkipTest('Build TypeC m6020 ELF for motor adapter tests')
        cls.index = ElfIndex(paths[0])

    def setUp(self):
        self.monitor = MotorMonitor(self.index)
        self.ram = {}
        self.address = 0x20010000
        self.can = 0x20016000
        self.put(self.index.variables['motor1']['address'], self.address.to_bytes(4, 'little'))
        self.die = self.monitor.candidates['motor1']['die']
        self.write('can_', self.can, pointer=True)
        self.write('last_uptime_', 990)
        self.write('online_threshold_', 30)
        self.write('rx_id_', 0x209)
        self.write('tx_id_', 0x2fe)
        self.write('state_.theta', 1.2)
        self.write('state_.omega', -4.5)
        self.write('state_.target', 9.0)
        self.write('state_.mode', 0x82)
        self.write('state_.enable', True)
        self.write('output_', -1100)
        can_die = self.index.base(type_of(self.index.base(self.index.members(self.die)['can_'][1])))
        offset, _ = self.index.members(can_die)['hcan_']
        self.put(self.can + offset, self.index.variables['hcan1']['address'].to_bytes(4, 'little'))
        self.put(self.index.variables['uwTick']['address'], (1000).to_bytes(4, 'little'))

    def put(self, address, data):
        for n, byte in enumerate(data):
            self.ram[address + n] = byte

    def read(self, address, size):
        self.assertLessEqual(size, 512)
        if not (0x20000000 <= address < 0x20080000 or 0x10000000 <= address < 0x10010000):
            raise DebugError('unsafe RAM address')
        return bytes(self.ram.get(address + n, 0) for n in range(size))

    def write(self, field, value, pointer=False):
        address, die = self.address, self.die
        for part in field.split('.'):
            offset, die = self.index.members(die)[part]
            address += offset
        size = self.index.size(die)
        if isinstance(value, float):
            data = struct.pack('<f', value)
        else:
            data = int(value).to_bytes(size, 'little', signed=value < 0)
        self.put(address, data)

    def test_named_and_registered_alias_dedup_and_can_identity(self):
        address, _ = self.index.resolve('groups_[0].motors[0]')
        self.put(address, self.address.to_bytes(4, 'little'))
        catalog = self.monitor.scan(self.read)
        self.assertEqual([m['path'] for m in catalog['items']], ['motor1'])
        self.assertEqual(catalog['items'][0]['bus'], 'CAN1')
        motor = self.monitor.sample(['motor1'], self.read)[0]
        self.assertTrue(motor['online'])
        self.assertEqual(motor['feedbackAgeMs'], 10)
        self.assertAlmostEqual(motor['fields']['state_.theta'], 1.2, places=5)
        self.assertEqual(motor['fields']['output_'], -1100)
        self.assertEqual(motor['rxId'], 0x209)
        self.assertIn('omega_pid_.pout_', motor['fields'])

    def test_registry_finds_heap_motor_without_named_global(self):
        self.put(self.index.variables['motor1']['address'], bytes(4))
        address, _ = self.index.resolve('groups_[1].motors[2]')
        self.put(address, self.address.to_bytes(4, 'little'))
        catalog = self.monitor.scan(self.read)
        self.assertEqual([m['path'] for m in catalog['items']], ['groups_[1].motors[2]'])
        self.assertEqual(self.monitor.sample(['groups_[1].motors[2]'], self.read)[0]['fields']['output_'], -1100)

    def test_uninitialized_pointer_and_per_motor_error_do_not_reuse_values(self):
        self.monitor.scan()  # Offline candidates, no RAM access.
        self.put(self.index.variables['motor1']['address'], bytes(4))
        sample = self.monitor.sample(['motor1'], self.read)[0]
        self.assertEqual(sample['status'], 'error')
        self.assertEqual(sample['fields'], {})
        self.assertNotIn('online', sample)
        self.assertIn('空指针', sample['error'])

    def test_one_failed_motor_does_not_hide_another_motor(self):
        second = 0x20018000
        self.put(second, bytes(self.ram.get(self.address + n, 0) for n in range(self.index.size(self.die))))
        slot, _ = self.index.resolve('groups_[0].motors[0]')
        self.put(slot, second.to_bytes(4, 'little'))
        self.monitor.scan(self.read)
        self.put(self.index.variables['motor1']['address'], bytes(4))
        first, other = self.monitor.sample(['motor1', 'groups_[0].motors[0]'], self.read)
        self.assertEqual(first['status'], 'error')
        self.assertTrue(other['online'])
        self.assertEqual(other['fields']['output_'], -1100)

    def test_nonfinite_field_is_missing_not_zero(self):
        self.write('state_.theta', float('nan'))
        motor = self.monitor.read('motor1', self.read)
        self.assertNotIn('state_.theta', motor['fields'])
        self.assertIn('state_.theta', motor['fieldErrors'])
        self.assertEqual(motor['fields']['state_.omega'], -4.5)

    def test_heartbeat_is_refreshed_after_slow_object_read(self):
        clock = self.index.variables['uwTick']['address']
        def progressing(address, size):
            if address == clock:
                self.write('last_uptime_', 1201)
                return (1200).to_bytes(size, 'little')
            return self.read(address, size)
        motor = self.monitor.read('motor1', progressing)
        self.assertTrue(motor['online'])
        self.assertEqual(motor['feedbackAgeMs'], 0)
        self.assertEqual(motor['fields']['last_uptime_'], 1201)
        self.assertTrue(motor['feedbackTimeNote'])

    def test_motor_only_session_requires_verified_elf_and_catalog_paths(self):
        session = DebugSession(FIRMWARE)
        session.index = self.index
        session.motors = self.monitor
        class Probe:
            sock = object()
            read = staticmethod(self.read)
        session.probe = Probe()
        with self.assertRaises(DebugError):
            session.sample([], self.index.sha, ['motor1'])
        session.verified_sha = self.index.sha
        session.scan_motors(self.index.sha)
        self.assertEqual(session.sample([], self.index.sha, ['motor1'])['motors'][0]['status'], 'online')
        with self.assertRaises(DebugError):
            session.sample([], 'wrong-sha', ['motor1'])
        with self.assertRaises(DebugError):
            session.sample([], self.index.sha, ['motor1->output_'])
        with self.assertRaises(DebugError):
            session.sample([], self.index.sha, ['motor1'] * 65)

    def control_probe(self):
        self.writes = []
        def write_word(address, data, byteorder):
            self.writes.append((address, data))
            self.put(address, data)
        def write_bool(address, value):
            data = bytes([int(value)])
            self.writes.append((address, data))
            self.put(address, data)
        self.monitor.scan(self.read)
        return SimpleNamespace(sock=True, read=self.read, write_word=write_word, write_bool=write_bool,
                               write_byte=lambda address, value: write_bool(address, value))

    def control_write(self, updates, mode=0x82, address='0x20010000', probe=None):
        return write_motor(self.monitor, probe or self.control_probe(), 'motor1', address, mode, updates)

    def test_runtime_pid_write_uses_real_dwarf_and_readback(self):
        self.write('omega_pid_.kp_', 12.0)
        result = self.control_write([{'field':'omega_pid_.kp_', 'value':15.5}])
        self.assertTrue(result['complete'])
        self.assertEqual(result['results'][0]['before'], 12)
        self.assertEqual(result['results'][0]['readback'], 15.5)
        self.assertEqual(len(self.writes), 1)
        self.assertEqual(len(self.writes[0][1]), 4)

    def test_pid_features_validate_encoded_dependencies_and_preserve_neighbor_bytes(self):
        self.write('state_.enable', False)
        self.write('omega_pid_.mode_', 0x88)
        probe = self.control_probe()
        address, _ = field_location(self.monitor, 'motor1', 'omega_pid_.mode_', self.read, pid_flags=True)
        neighbors = self.read(address-1, 3)
        result = self.control_write([{'field':'omega_pid_.mode_', 'value':0xbb, 'expected':0x88},
                                     {'field':'omega_pid_.ScalarA', 'value':.5},
                                     {'field':'omega_pid_.ScalarB', 'value':.1}], probe=probe)
        self.assertTrue(result['complete'])
        self.assertEqual(result['results'][-1]['field'], 'omega_pid_.mode_')
        self.assertEqual(result['results'][-1]['before'], 0x88)
        self.assertEqual(self.writes[-1], (address, b'\xbb'))
        self.assertEqual(self.read(address-1, 3), neighbors[:1] + b'\xbb' + neighbors[2:])

    def test_pid_features_reject_unsafe_masks_stale_drafts_and_enabled_motor(self):
        for enabled, value, expected, a, b in [(True,32,0,1.,0.), (False,32,1,1.,0.),
                (False,8,0,1.,0.), (False,128,0,1.,0.), (False,32,0,0.,0.),
                (False,32,0,1e-50,0.), (False,32,0,1.,-.1), (False,32,0,3e38,3e38)]:
            self.write('state_.enable', enabled)
            probe = self.control_probe()
            with self.subTest(enabled=enabled,value=value,expected=expected,a=a,b=b), self.assertRaises(DebugError):
                self.control_write([{'field':'omega_pid_.mode_', 'value':value,'expected':expected},
                                    {'field':'omega_pid_.ScalarA','value':a},
                                    {'field':'omega_pid_.ScalarB','value':b}], probe=probe)
            self.assertEqual(self.writes, [])

    def test_pid_feature_batch_stops_if_firmware_reenables_or_changes_mask(self):
        self.write('state_.enable', False)
        for changed_field, changed_value in [('state_.enable', True), ('omega_pid_.mode_', 16)]:
            self.write('state_.enable', False)
            self.write('omega_pid_.mode_', 0)
            probe = self.control_probe()
            original = probe.write_word
            def change_after_first(address, data, byteorder):
                original(address, data, byteorder)
                self.write(changed_field, changed_value)
            probe.write_word = change_after_first
            result = self.control_write([{'field':'omega_pid_.ScalarA','value':1.},
                                        {'field':'omega_pid_.ScalarB','value':.1},
                                        {'field':'omega_pid_.mode_','value':32,'expected':0}], probe=probe)
            self.assertFalse(result['complete'])
            self.assertEqual(len(self.writes), 1)
            self.assertIn('error', result['results'][-1])

    def test_readback_mismatch_stops_remaining_writes(self):
        probe = self.control_probe()
        probe.write_word = lambda address, data, byteorder: self.writes.append((address,data))
        result = self.control_write([{'field':'omega_pid_.kp_','value':1.},
                                    {'field':'omega_pid_.ki_','value':2.}], probe=probe)
        self.assertFalse(result['complete'])
        self.assertEqual(len(self.writes), 1)

    def test_changed_ab_readback_is_rechecked_before_activating_feature(self):
        self.write('state_.enable', False)
        probe = self.control_probe()
        original = probe.write_word
        def overwrite_earlier_dependency(address, data, byteorder):
            original(address, data, byteorder)
            if len(self.writes) == 2:
                self.write('omega_pid_.ScalarA', 0.)
        probe.write_word = overwrite_earlier_dependency
        result = self.control_write([{'field':'omega_pid_.ScalarA','value':1.},
                                    {'field':'omega_pid_.ScalarB','value':.1},
                                    {'field':'omega_pid_.mode_','value':32,'expected':0}], probe=probe)
        self.assertFalse(result['complete'])
        self.assertEqual(len(self.writes), 2)
        self.assertIn('A/B', result['results'][-1]['error'])

    def test_scalar_ab_cannot_invalidate_an_active_changing_integral(self):
        self.write('state_.enable', False)
        self.write('omega_pid_.mode_', 32)
        self.write('omega_pid_.ScalarA', 1.)
        self.write('omega_pid_.ScalarB', .1)
        probe = self.control_probe()
        with self.assertRaises(DebugError):
            self.control_write([{'field':'omega_pid_.ScalarA','value':0.}], probe=probe)
        self.assertEqual(self.writes, [])
        result = self.control_write([{'field':'omega_pid_.mode_','value':0,'expected':32},
                                    {'field':'omega_pid_.ScalarA','value':0.}], probe=probe)
        self.assertTrue(result['complete'])

    def test_all_fields_prevalidated_before_first_write(self):
        for field, value in [('output_', 1), ('state_.enable', True), ('state_.theta', 2),
                             ('omega_pid_.max_out_', -1), ('omega_pid_.kp_', float('nan')),
                             ('omega_pid_.kp_', float('inf')), ('omega_pid_.kp_', True),
                             ('omega_pid_.kp_', 1e100), ('omega_pid_.kp_', 10**1000)]:
            with self.subTest(field=field, value=str(value)[:20]):
                probe = self.control_probe()
                with self.assertRaises(DebugError):
                    self.control_write([{'field':'omega_pid_.ki_', 'value':.2}, {'field':field, 'value':value}], probe=probe)
                self.assertEqual(self.writes, [])

    def test_target_mode_enable_online_and_identity_guards(self):
        for mode, expected, enable, heartbeat, address in [(0x86, 0x82, True, 990, '0x20010000'),
                (0x82, 0x82, False, 990, '0x20010000'), (0x82, 0x82, True, 900, '0x20010000'),
                (0x82, 0x82, True, 990, '0x20018000'), (7, 7, True, 990, '0x20010000')]:
            self.write('state_.mode', mode)
            self.write('state_.enable', enable)
            self.write('last_uptime_', heartbeat)
            probe = self.control_probe()
            with self.assertRaises(DebugError):
                self.control_write([{'field':'state_.target', 'value':1.0}], expected, address, probe)
            self.assertEqual(self.writes, [])

    def test_angle_mode_schema_and_target_coordinate(self):
        self.write('state_.mode', 0x86)
        probe = self.control_probe()
        schema = self.monitor.read('motor1', self.read)['control']
        self.assertEqual(schema['angle']['feedback'], 'state_.output_shaft_theta')
        self.assertTrue(schema['angle']['absolute'])
        for value in (-.1, 7):
            with self.assertRaises(DebugError):
                self.control_write([{'field':'state_.target', 'value':value}], mode=0x86, probe=probe)
        result = self.control_write([{'field':'state_.target', 'value':1.25}], mode=0x86, probe=probe)
        self.assertEqual(result['results'][0]['readback'], 1.25)

    def test_partial_write_failure_is_explicit_and_stops(self):
        probe = self.control_probe()
        original = probe.write_word
        def fail_second(address, data, byteorder):
            if self.writes:
                raise DebugError('probe disconnected')
            original(address, data, byteorder)
        probe.write_word = fail_second
        result = self.control_write([{'field':'omega_pid_.kp_', 'value':10},
                                    {'field':'omega_pid_.ki_', 'value':1},
                                    {'field':'omega_pid_.kd_', 'value':2}], probe=probe)
        self.assertFalse(result['complete'])
        self.assertTrue(result['results'][0]['matched'])
        self.assertIn('error', result['results'][1])
        self.assertEqual(len(result['results']), 2)
        self.assertEqual(len(self.writes), 1)

    def test_firmware_overwrite_is_not_reported_as_confirmed(self):
        probe = self.control_probe()
        def overwrite(address, data, byteorder):
            self.put(address, struct.pack('<f', 99))
        probe.write_word = overwrite
        result = self.control_write([{'field':'omega_pid_.kp_', 'value':10}], probe=probe)
        self.assertFalse(result['complete'])
        self.assertFalse(result['results'][0]['matched'])
        self.assertEqual(result['results'][0]['readback'], 99)

    def test_session_write_rejects_unverified_or_old_elf(self):
        session = DebugSession(FIRMWARE)
        session.index, session.motors, session.probe = self.index, self.monitor, self.control_probe()
        body = {'sha':self.index.sha, 'path':'motor1', 'address':'0x20010000', 'mode':0x82,
                'updates':[{'field':'omega_pid_.kp_', 'value':10}]}
        with self.assertRaises(DebugError):
            session.write_motor(body)
        session.verified_sha = self.index.sha
        with self.assertRaises(DebugError):
            session.write_motor({**body, 'sha':'outdated'})
        self.assertTrue(session.write_motor(body)['complete'])

    def enable_write(self, enabled, probe=None, address='0x20010000', mode=0x82):
        return set_motor_enabled(self.monitor, probe or self.control_probe(), 'motor1', address, mode, enabled)

    def test_enable_uses_only_bool_byte_and_preserves_neighbours_and_target(self):
        probe = self.control_probe()
        address, _ = field_location(self.monitor, 'motor1', 'state_.enable', self.read, boolean=True)
        before = self.read(address - 4, 9)
        result = self.enable_write(False, probe)
        self.assertTrue(result['complete'])
        self.assertIs(result['readback'], False)
        self.assertIs(result['motor']['fields']['state_.enable'], False)
        after = self.read(address - 4, 9)
        self.assertEqual(before[:4], after[:4])
        self.assertEqual(before[5:], after[5:])
        self.assertEqual(result['motor']['fields']['state_.target'], 9)
        self.assertEqual(self.writes, [(address, b'\x00')])
        self.assertTrue(self.enable_write(True, probe)['complete'])
        self.assertEqual(self.writes[-1], (address, b'\x01'))

    def test_disable_available_offline_and_after_mode_change_but_enable_requires_live_mode(self):
        probe = self.control_probe()
        self.write('last_uptime_', 900)
        self.write('state_.mode', 0x86)
        self.assertTrue(self.enable_write(False, probe)['complete'])
        with self.assertRaises(DebugError):
            self.enable_write(True, probe, mode=0x86)
        self.write('last_uptime_', 990)
        with self.assertRaises(DebugError):
            self.enable_write(True, probe)
        self.assertTrue(self.enable_write(True, probe, mode=0x86)['complete'])

    def test_enable_rejects_nonbool_identity_and_unsupported_driver(self):
        for value in (0, 1, 'false', None):
            probe = self.control_probe()
            with self.assertRaises(DebugError):
                self.enable_write(value, probe)
            self.assertEqual(self.writes, [])
        probe = self.control_probe()
        with self.assertRaises(DebugError):
            self.enable_write(False, probe, address='0x20018000')
        self.assertEqual(self.writes, [])
        for family in ('DM', 'CyberGear'):
            self.monitor.candidates['motor1']['family'] = family
            self.assertFalse(self.monitor.read('motor1', self.read)['control']['enable']['supported'])
            with self.assertRaises(DebugError):
                self.enable_write(False, probe)
        self.assertEqual(self.writes, [])

    def test_enable_reports_firmware_override_and_readback_failure(self):
        probe = self.control_probe()
        probe.write_bool = lambda address, value: None
        result = self.enable_write(False, probe)
        self.assertFalse(result['complete'])
        self.assertIs(result['motor']['fields']['state_.enable'], True)
        def lose_readback(address, value):
            probe.read = Mock(side_effect=DebugError('connection lost'))
        probe.write_bool = lose_readback
        result = self.enable_write(False, probe)
        self.assertTrue(result['written'])
        self.assertFalse(result['complete'])
        self.assertIn('connection lost', result['error'])

    def test_enable_session_requires_verified_connection_and_current_elf(self):
        session = DebugSession(FIRMWARE)
        session.index, session.motors, session.probe = self.index, self.monitor, self.control_probe()
        body = {'sha':self.index.sha, 'path':'motor1', 'address':'0x20010000', 'mode':0x82, 'enabled':False}
        with self.assertRaises(DebugError):
            session.set_motor_enabled(body)
        session.verified_sha = self.index.sha
        with self.assertRaises(DebugError):
            session.set_motor_enabled({**body, 'sha':'outdated'})
        self.assertTrue(session.set_motor_enabled(body)['complete'])
        session.probe.sock = None
        with self.assertRaises(DebugError):
            session.set_motor_enabled(body)

class MotorContractTests(unittest.TestCase):
    def test_pid_byte_writer_rejects_non_uint8_and_unsafe_addresses(self):
        probe = OpenOCD()
        probe.command = Mock(return_value='LIVERTT_OK')
        probe.write_byte(0x20000103, 119)
        self.assertIn('write_memory 0x20000103 8 {119}', probe.command.call_args.args[0])
        for address, value in [(0x08000000,1), (0x20080000,1), (0x20000001,True),
                               (0x20000001,-1), (0x20000001,256), (0x20000001,1.5)]:
            with self.assertRaises(DebugError):
                probe.write_byte(address, value)
        self.assertEqual(probe.command.call_count, 1)
    def test_bool_write_uses_single_byte_and_rejects_flash_and_numeric_values(self):
        probe = OpenOCD()
        probe.command = Mock(return_value='LIVERTT_OK')
        probe.write_bool(0x20000103, False)
        self.assertIn('write_memory 0x20000103 8 {0}', probe.command.call_args.args[0])
        for address, value in [(0x08000000, False), (0x40000000, False), (0x20080000, False), (0x20000000, 1)]:
            with self.assertRaises(DebugError):
                probe.write_bool(address, value)
        self.assertEqual(probe.command.call_count, 1)
        probe.command.return_value = 'LIVERTT_ERROR:failed'
        with self.assertRaises(DebugError):
            probe.write_bool(0x20000103, True)

    def test_write_word_uses_one_aligned_native_width_command(self):
        probe = OpenOCD()
        probe.command = Mock(return_value='LIVERTT_OK')
        probe.write_word(0x20000100, struct.pack('<f', 1.0))
        self.assertIn('write_memory 0x20000100 32 {1065353216}', probe.command.call_args.args[0])
        for address, data in [(0x08000100, bytes(4)), (0x40000000, bytes(4)), (0x20000001, bytes(4)), (0x20000000, bytes(8))]:
            with self.assertRaises(DebugError):
                probe.write_word(address, data)
        self.assertEqual(probe.command.call_count, 1)
        probe.command.return_value = 'LIVERTT_ERROR:failed'
        with self.assertRaises(DebugError):
            probe.write_word(0x20000100, bytes(4))

    def test_const_and_atomic_qualifiers_are_not_stripped_for_writes(self):
        for tag in ('DW_TAG_const_type', 'DW_TAG_atomic_type'):
            with self.assertRaises(DebugError):
                _mutable(Mock(), SimpleNamespace(offset=1, tag=tag))

    def test_heartbeat_rules_wrap_and_unknown(self):
        self.assertEqual(online_state(0, 1000, 30)['status'], 'waiting')
        self.assertTrue(online_state(0xfffffff0, 5, 30)['online'])
        self.assertFalse(online_state(970, 1000, 30)['online'])
        self.assertEqual(online_state(123, None, 30)['status'], 'unknown')

    def test_profile_restores_selection_separately_from_scalar_watches(self):
        profile = validate_profile({'elfPath':'test.elf','modules':{'motors':{'enabled':True,'selected':['motor1','groups_[0].motors[1]'],'focus':'motor1','bus':'CAN1'}}})
        self.assertEqual(profile['watches'], [])
        self.assertEqual(profile['modules']['motors']['selected'], ['motor1','groups_[0].motors[1]'])
        self.assertEqual(profile['modules']['motors']['bus'], 'CAN1')
        with self.assertRaises(DebugError):
            validate_profile({'elfPath':'test.elf','modules':{'motors':{'selected':['motor1','motor1']}}})

if __name__ == '__main__':
    unittest.main()

