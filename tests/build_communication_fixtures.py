"""Compile the local Martin/referee sources into an ARM DWARF fixture; no board access."""
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
FIRMWARE = ROOT.parent / 'UICRM-Embedded'
sys.path.insert(0, str(ROOT))
from tools.install_communication_trace import plan


def main():
    root = ROOT / 'tests/.runtime/communication-season'
    files = ['boards/communication/referee/include/referee.h', 'boards/communication/referee/include/crc.h',
             'boards/communication/referee/src/referee.cpp']
    files += [f'boards/communication/referee/{part}/{season}/protocol.{ext}'
              for season in (2026, 2027) for part, ext in [('include/seasons', 'h'), ('src/seasons', 'cpp')]]
    for name in files:
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(subprocess.check_output(['git', '-C', str(FIRMWARE), 'show', 'Martin/referee:'+name]))
    for path, text in plan(root).items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')
    assert not plan(root), 'Installer must be idempotent'
    commands = json.loads((FIRMWARE / 'cmake-build-debug/compile_commands.json').read_text())
    entry = next(e for e in commands if e['file'].endswith('/src/protocol.cpp') and 'TypeC_general_drivers' in e['command'])
    args = shlex.split(entry['command'], posix=False)
    args = args[:args.index('-o')]
    # Put the staged season headers before all existing include directories.
    args.insert(1, '-I'+str(root / 'boards/communication/referee/include'))
    env = {**os.environ, 'PATH': str(Path(args[0]).parent)+os.pathsep+os.environ['PATH']}
    fixture = root / 'fixture.cpp'
    fixture.write_text('#include "seasons/2026/protocol.h"\n#include "seasons/2027/protocol.h"\n'
                       'referee_comm::v2026::Protocol season2026;\nreferee_comm::v2027::Protocol season2027;\n'
                       'referee_comm::Referee* link2026;\nreferee_comm::Referee* link2027;\n', encoding='utf-8')
    sources = [root/name for name in files if name.endswith('.cpp')]+[fixture]
    objects = []
    for i, source in enumerate(sources):
        output = root / f'fixture-{i}.o'
        subprocess.run([*args, '-c', str(source), '-o', str(output)], check=True, env=env)
        objects.append(str(output))
    # This ELF is a layout fixture and is never executed. Give external BSP/libc
    # calls typed Thumb destinations so the ARM linker can resolve relocations.
    nm = str(Path(args[0]).with_name('arm-none-eabi-nm.exe'))
    undefined, defined = set(), set()
    for output in objects:
        undefined.update(line.split()[-1] for line in subprocess.check_output([nm, '-u', output], env=env, text=True).splitlines() if line.split())
        defined.update(line.split()[-1] for line in subprocess.check_output([nm, '-g', '--defined-only', output], env=env, text=True).splitlines() if line.split())
    assembly = ['.syntax unified', '.thumb']
    for symbol in sorted(undefined-defined):
        if symbol == '__dso_handle':
            assembly += ['.data', '.global __dso_handle', '__dso_handle: .word 0']
        else:
            assembly += ['.text', '.global '+symbol, '.type '+symbol+', %function', '.thumb_func', symbol+': bx lr']
    stub = root/'external-layout-only.s'
    stub.write_text('\n'.join(assembly)+'\n', encoding='utf-8')
    stub_obj = root/'external-layout-only.o'
    subprocess.run([args[0], '-mcpu=cortex-m4', '-mthumb', '-c', str(stub), '-o', str(stub_obj)], check=True, env=env)
    objects.append(str(stub_obj))
    subprocess.run([args[0], '-mcpu=cortex-m4', '-mthumb', '-mfpu=fpv4-sp-d16', '-mfloat-abi=hard',
                    '-nostdlib', '-Wl,-Ttext=0x08000000',
                    '-Wl,-Tdata=0x20000000', '-Wl,-e,0', *objects, '-o', str(root/'seasons.elf')], check=True, env=env)
    print('Season 2026 / 2027 sources and recorder compiled: '+str(root/'seasons.elf'))


if __name__ == '__main__':
    main()
