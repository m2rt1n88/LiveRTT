"""Browser fixture for motor writes and dragging. Synthetic values only; never opens a probe."""
import json
import math
from pathlib import Path
import sys
import time
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / '.deps'), str(ROOT / 'tests')]
from manual_motion_server import MotionFixture
from backend.app import Server
from backend.errors import DebugError
from backend.motor_control import PID_FEATURES


class MotorFixture(MotionFixture):
    def __init__(self, elf):
        super().__init__(elf)
        self.values = {}
        self.writes = []

    def sample(self, paths, sha, motor_paths=None, communication=None):
        sample = super().sample(paths, sha, motor_paths, communication)
        for i, motor in enumerate(sample['motors']):
            fields = motor['fields']
            for ring in ('omega_pid_', 'theta_pid_'):
                for key, value in (('kp_', 12), ('ki_', .2), ('kd_', 0), ('max_out_', 10000), ('max_iout_', 100), ('dead_band_', 0), ('ScalarA', .5), ('ScalarB', .1), ('mode_', 1), ('Output_Filtering_Coefficient', .8), ('Derivative_Filtering_Coefficient', .6)):
                    fields[ring + '.' + key] = value
                fields.update({ring+'.pout_':fields['output_']*.8, ring+'.iout_':fields['output_']*.15,
                               ring+'.dout_':fields['output_']*.05, ring+'.target_':fields['state_.target']})
            fields['state_.current'] = .8 + .07 * math.sin(time.monotonic()*2)
            fields.update({'state_.speed_feedforward':0, 'state_.torque_feedforward':0})
            fields.update(self.values.get(motor['path'], {}))
            # Let feedback approach the requested target; a test visualization, not a motor model.
            fields['state_.output_shaft_theta'] = fields['state_.theta'] = fields['state_.target'] - .02
            descriptors = []
            for ring, group, unit in (('omega_pid_', '速度环 PID', 'raw'), ('theta_pid_', '角度环 PID', 'rad/s')):
                for key, label in (('kp_', 'Kp'), ('ki_', 'Ki'), ('kd_', 'Kd'), ('max_out_', '输出限幅'), ('max_iout_', '积分限幅'), ('dead_band_', '死区'), ('ScalarA','变速积分 A（过渡宽度）'), ('ScalarB','变速积分 B（完整积分区）'), ('Output_Filtering_Coefficient','输出滤波系数'), ('Derivative_Filtering_Coefficient','微分滤波系数')):
                    descriptors.append({'field':ring+'.'+key, 'label':label, 'group':group,
                                        'unit':unit if key.startswith('max_') else ('rad/s' if ring == 'omega_pid_' else 'rad') if key in ('ScalarA','ScalarB','dead_band_') else '', 'min':None if key in ('kp_', 'ki_', 'kd_') else 0, 'max':1 if 'Coefficient' in key else None, 'requiresDisabled':key in ('ScalarA','ScalarB')})
                descriptors.append({'field':ring+'.mode_', 'label':'算法开关', 'group':group, 'unit':'bitmask', 'min':0, 'max':255, 'kind':'pidFlags', 'options':PID_FEATURES, 'requiresDisabled':True})
            descriptors.append({'field':'state_.target', 'label':'角度目标' if fields['state_.mode'] & 4 else '速度目标', 'group':'控制目标', 'unit':'rad' if fields['state_.mode'] & 4 else 'rad/s', 'min':None, 'max':None})
            for field, label, unit in [('state_.speed_feedforward','速度前馈','rad/s'), ('state_.torque_feedforward','电流前馈','raw')]:
                descriptors.append({'field':field, 'label':label, 'group':'运行前馈', 'unit':unit, 'min':None, 'max':None})
            motor.update({'address':hex(0x20010000+i*0x1000), 'control':{'fields':descriptors, 'mode':fields['state_.mode'],
                'enable':{'supported':True, 'reason':'合成电机软件使能，仅测试界面'},
                'angle':{'field':'state_.target','feedback':'state_.output_shaft_theta','absolute':False} if fields['state_.mode'] & 4 else None}})
        return sample

    def write_motor(self, body):
        self.require_elf(body.get('sha'))
        if not self.probe.sock or body.get('path') not in {m['path'] for m in self.catalog}:
            raise DebugError('测试电机未连接。')
        values = self.values.setdefault(body['path'], {})
        results = []
        for item in body['updates']:
            before = values.get(item['field'], 0)
            values[item['field']] = item['value']
            results.append({'field':item['field'], 'before':before, 'requested':item['value'], 'readback':item['value'], 'written':True, 'matched':True})
        self.writes.append(body)
        (ROOT / 'tests/.runtime/motor-write-fixture/writes.json').write_text(json.dumps(self.writes, ensure_ascii=False, indent=2), encoding='utf-8')
        return {'path':body['path'], 'time':time.time(), 'results':results, 'complete':True, 'sequential':True}

    def set_motor_enabled(self, body):
        self.require_elf(body.get('sha'))
        if not self.probe.sock or body.get('path') not in {m['path'] for m in self.catalog}:
            raise DebugError('测试电机未连接。')
        if type(body.get('enabled')) is not bool:
            raise DebugError('使能必须为 bool。')
        self.values.setdefault(body['path'], {})['state_.enable'] = body['enabled']
        motor = self.sample([], body['sha'], [body['path']])['motors'][0]
        return {'path':body['path'], 'requested':body['enabled'], 'complete':True, 'written':True,
                'matched':True, 'readback':body['enabled'], 'motor':motor, 'time':time.time()}


if __name__ == '__main__':
    elf = next((ROOT.parent / 'UICRM-Embedded/cmake-build-debug/examples/DJI_Board_TypeC_general/motor').glob('*m6020.elf'))
    server = Server(('localhost', 18769), MotorFixture(elf), ROOT / 'tests/.runtime/motor-write-fixture')
    server.profiles.save({'version':2,'elfPath':str(elf),'name':'电机写入回归 / 合成数据，非实车','watches':[],
        'modules':{'motors':{'enabled':True,'selected':['fixture.yaw'],'focus':'fixture.yaw'}}})
    print('SYNTHETIC MOTOR WRITE FIXTURE ONLY: http://localhost:18769/#workspace', flush=True)
    try:
        with patch('backend.app.start_rtt', return_value='合成数据，无真实 RTT'), patch('backend.app.Handler.log_message',lambda *_:None):
            server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
