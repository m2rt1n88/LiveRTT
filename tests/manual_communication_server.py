"""Synthetic communication UI fixture. Never opens a probe or sends a hardware command."""
from pathlib import Path
import sys
import time
from unittest.mock import patch
ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / '.deps'), str(ROOT / 'tests')]
from backend.app import Server
from manual_motion_server import MotionFixture


class CommunicationFixture(MotionFixture):
    def __init__(self, elf):
        super().__init__(elf)
        self.sequences = {}

    def scan_communications(self, sha):
        self.require_elf(sha)
        return {'items': [{'path': 'fixture.bridge', 'type': 'communication::CanBridge', 'family': 'can_bridge', 'capture': True},
                          {'path': 'fixture.referee', 'type': 'referee_comm::Referee', 'family': 'referee_new', 'capture': True}],
                'note': '合成数据 · 仅用于界面验证，不连接真实硬件。'}

    def sample(self, paths, sha, motor_paths=None, communication=None):
        self.require_elf(sha)
        link = None
        if communication:
            path = communication['path']
            seq = self.sequences.get(path, 0)+1
            self.sequences[path] = seq
            referee = path.endswith('referee')
            frame = {'sequence': seq, 'timeMs': seq*100, 'direction': 'RX' if seq % 3 else 'TX',
                     'id': 0x201 if referee else 0x09705152, 'length': 8, 'hex': '00 00 A0 3F 00 00 20 C0',
                     'decoded': {'robot_id': 3, 'current_HP': 400} if referee else {'rxId': 82, 'txId': 81, 'register': 112, 'values': [1.25, -2.5]}}
            link = {'path': path, 'cursor': seq, 'capture': True, 'dropped': 0, 'frames': [frame],
                    'fields': {'protocol.robot_status.current_HP': 400, 'protocol.robot_status.robot_id': 3} if referee else {'id_': 81, 'reg_callback_count_': 4}}
        return {'time': time.time(), 'durationMs': .4, 'values': [], 'motors': [], 'communication': link, 'connected': True}


if __name__ == '__main__':
    elf = ROOT.parent / 'UICRM-Embedded/cmake-build-debug/examples/DJI_Board_TypeC_general/can_bridge/example_can_bridge_DJI_Board_TypeC_general_host.elf'
    server = Server(('localhost', 18770), CommunicationFixture(elf), ROOT/'tests/.runtime/communication-ui')
    server.profiles.save({'version': 2, 'elfPath': str(elf), 'name': '通信界面测试 · 合成数据，非实车', 'watches': [],
                         'modules': {'communications': {'enabled': True, 'selected': 'fixture.bridge'}}})
    print('SYNTHETIC COMMUNICATION FIXTURE: http://localhost:18770/', flush=True)
    try:
        with patch('backend.app.start_rtt', return_value='合成数据，无真实 RTT'), patch('backend.app.Handler.log_message', lambda *_: None):
            server.serve_forever()
    finally:
        server.server_close()
