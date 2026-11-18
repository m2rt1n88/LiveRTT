"""Install frame recording into the season referee implementation without switching branches.

Default is preview. Use --apply to update a checkout; exact anchors prevent silent bad patches.
"""
import argparse
from pathlib import Path


def plan(root):
    root = Path(root).resolve()
    header = root / 'boards/communication/referee/include/referee.h'
    source = root / 'boards/communication/referee/src/referee.cpp'
    if not header.is_file() or not source.is_file():
        raise ValueError('此目录没有赛季版 referee；请指定 Martin/referee 或合入该实现的工作目录。')
    template = Path(__file__).resolve().parents[1] / 'firmware/communication_trace.h'
    updates = {root / 'boards/drivers/include/communication_trace.h': template.read_text(encoding='utf-8')}

    def edit(path, changes):
        text = path.read_text(encoding='utf-8')
        for old, new, marker in changes:
            if marker in text:
                continue
            if text.count(old) != 1:
                raise ValueError(f'布局不匹配，未修改任何文件：{path}，锚点 {old!r}')
            text = text.replace(old, new, 1)
        updates[path] = text
    edit(header, [
        ('#include "bsp_uart.h"', '#include "bsp_uart.h"\n#include "../../../drivers/include/communication_trace.h"', '#include "../../../drivers/include/communication_trace.h"'),
        ('    class Referee {\n      public:', '    class Referee {\n      public:\n        communication::CommunicationTrace<8, 320> trace_;', 'CommunicationTrace<8, 320> trace_'),
    ])
    edit(source, [
        ('                protocol_.OnCommand(frame);', '                trace_.Push(0, frame.cmd_id, buffer_, total);\n                protocol_.OnCommand(frame);', 'trace_.Push(0, frame.cmd_id'),
        ('        return Write(tx_, total);', '        const size_t written = Write(tx_, total);\n        if (written == total)\n            trace_.Push(1, cmd_id, tx_, total);\n        return written;', 'trace_.Push(1, cmd_id'),
    ])
    return {p: text for p, text in updates.items() if not p.exists() or p.read_text(encoding='utf-8') != text}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('firmware_root')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    updates = plan(args.firmware_root)
    for path, text in updates.items():
        print(('更新：' if args.apply else '预览：') + str(path))
        if args.apply:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding='utf-8')
    print('已接入／已是最新。' if args.apply else '预览完成；加 --apply 写入，随后重新构建并烧录。')


if __name__ == '__main__':
    main()
