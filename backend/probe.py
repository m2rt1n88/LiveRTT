"""OpenOCD process ownership, Tcl reads and RTT reception."""
import codecs
from collections import deque
import os
import re
import shutil
import socket
import subprocess
import threading
import time
from pathlib import Path
from .errors import DebugError

class OpenOCD:
    def __init__(self):
        self.sock = None
        self.buffer = b""
        self.target = ""

    def close(self):
        if self.sock:
            self.sock.close()
        self.sock = None
        self.buffer = b""
        self.target = ""

    def command(self, command):
        if self.sock is None:
            raise DebugError("尚未连接 OpenOCD。")
        try:
            self.sock.sendall(command.encode("ascii") + b"\x1a")
            while b"\x1a" not in self.buffer:
                data = self.sock.recv(65536)
                if not data:
                    raise OSError("OpenOCD closed the connection")
                self.buffer += data
                if len(self.buffer) > 1024 * 1024:
                    raise OSError("OpenOCD response too large")
            response, self.buffer = self.buffer.split(b"\x1a", 1)
            return response.decode("utf-8", "replace").strip()
        except OSError as exc:
            self.close()
            raise DebugError("OpenOCD 通信中断：" + str(exc)) from exc

    def connect(self, port=6666):
        self.close()
        try:
            self.sock = socket.create_connection(("127.0.0.1", port), timeout=2)
            self.sock.settimeout(2)
            self.target = self.command("target current")
            if not re.fullmatch(r"[A-Za-z0-9_.:-]+", self.target):
                raise DebugError("OpenOCD 没有可用目标，请检查芯片和 SWD 配置。")
            return {"target": self.target, "state": self.command(self.target + " curstate"), "port": port}
        except (OSError, DebugError) as exc:
            self.close()
            raise DebugError("连接 OpenOCD Tcl 端口失败，请检查 SWD 接线、供电和端口。" + str(exc)) from exc

    def read(self, address, size, flash=False):
        if size < 1 or size > 512:
            raise DebugError("读取长度超出限制。")
        ranges = [(0x20000000, 0x20080000), (0x10000000, 0x10010000)]
        if flash:
            ranges.append((0x08000000, 0x08200000))
        if not any(start <= address and address + size <= end for start, end in ranges):
            raise DebugError("地址不在第一版支持的 STM32F4 SRAM 范围，已跳过读取。")
        response = self.command("read_memory " + hex(address) + " 8 " + str(size))
        try:
            values = [int(item, 0) for item in response.split()]
            if len(values) != size or any(not 0 <= item <= 255 for item in values):
                raise ValueError("bad count")
            return bytes(values)
        except ValueError as exc:
            raise DebugError("OpenOCD 读取失败（未暂停目标）：" + response[:250]) from exc

    def write_bool(self, address, value):
        """Write only the bool byte; adjacent live state must remain untouched."""
        if type(value) is not bool or not any(start <= address < end for start, end in
                ((0x20000000, 0x20080000), (0x10000000, 0x10010000))):
            raise DebugError("仅允许写入受支持 RAM 内的单字节 bool。")
        command = "write_memory " + hex(address) + " 8 {" + str(int(value)) + "}"
        response = self.command('if {[catch {' + command + '} livertt_error]} {return "LIVERTT_ERROR:$livertt_error"}; return LIVERTT_OK')
        if response != "LIVERTT_OK":
            raise DebugError("OpenOCD 使能写入失败：" + response[:250])

    def write_byte(self, address, value):
        """A native byte operation for the motor writer's restricted PID bitmask."""
        if type(value) is not int or not 0 <= value <= 255 or not any(start <= address < end for start, end in
                ((0x20000000, 0x20080000), (0x10000000, 0x10010000))):
            raise DebugError("仅允许写入受支持 RAM 内的 uint8 参数。")
        command = "write_memory " + hex(address) + " 8 {" + str(value) + "}"
        response = self.command('if {[catch {' + command + '} livertt_error]} {return "LIVERTT_ERROR:$livertt_error"}; return LIVERTT_OK')
        if response != "LIVERTT_OK":
            raise DebugError("OpenOCD PID 特性写入失败：" + response[:250])

    def write_word(self, address, data, byteorder="little"):
        """Write one aligned RAM word, never byte-split a live float."""
        if len(data) != 4 or address % 4 or not any(
                start <= address and address + 4 <= end
                for start, end in ((0x20000000, 0x20080000), (0x10000000, 0x10010000))):
            raise DebugError("仅允许写入受支持 RAM 内对齐的 32 位参数。")
        command = "write_memory " + hex(address) + " 32 {" + str(int.from_bytes(data, byteorder)) + "}"
        response = self.command('if {[catch {' + command + '} livertt_error]} {return "LIVERTT_ERROR:$livertt_error"}; return LIVERTT_OK')
        if response != "LIVERTT_OK":
            raise DebugError("OpenOCD 写入失败：" + response[:250])


class OpenOCDService:
    """Reuse external servers; manage only the executable launched by this session."""
    def __init__(self, firmware_root):
        self.firmware_root = Path(firmware_root)
        self.process = None
        self.reader = None
        self.logs = deque(maxlen=80)
        self.log_lock = threading.Lock()

    def defaults(self):
        # Prefer the real Scoop executable, so terminating it cannot orphan a shim child.
        scoop = Path.home() / "scoop/apps/openocd/current/bin/openocd.exe"
        executable = str(scoop) if scoop.is_file() else (shutil.which("openocd") or "")
        return {"executable": executable,
                "config": str(self.firmware_root / "openocd/stm32f4/daplink.cfg")}

    def snapshot(self):
        with self.log_lock:
            return {"owned": self.process is not None and self.process.poll() is None,
                    "logs": list(self.logs)}

    def _drain(self, process):
        try:
            for line in process.stdout:
                with self.log_lock:
                    self.logs.append(line.rstrip()[:2000])
        finally:
            process.stdout.close()

    def stop(self):
        process, self.process = self.process, None
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)
        if self.reader:
            self.reader.join(timeout=1)
            self.reader = None

    @staticmethod
    def listening(port):
        try:
            with socket.create_connection(("localhost", port), timeout=.25):
                return True
        except OSError:
            return False

    def connect(self, probe, port, executable="", config="", auto_start=True, timeout=12):
        # A listener that fails the handshake must never trigger a competing OpenOCD.
        if self.listening(port):
            result = probe.connect(port)
            result["service"] = "调试器后台 OpenOCD" if self.snapshot()["owned"] else "复用已有 OpenOCD"
            return result
        if not auto_start:
            raise DebugError("OpenOCD 未运行。请启用自动启动或连接已有服务。")
        self.stop()
        defaults = self.defaults()
        executable = executable.strip() or defaults["executable"]
        config = Path(config.strip() or defaults["config"]).expanduser()
        if not config.is_absolute():
            config = self.firmware_root / config
        if not config.is_file() or config.suffix.lower() != ".cfg":
            raise DebugError("找不到 OpenOCD .cfg 配置文件：" + str(config))
        resolved = shutil.which(executable) if executable else None
        if not resolved:
            raise DebugError("找不到 OpenOCD，请在连接设置中填写 openocd.exe 的完整路径。")
        command = [resolved, "-c", "bindto " + ".".join(map(str, (127, 0, 0, 1))), "-c", "gdb_port disabled",
                   "-c", "telnet_port disabled", "-c", "tcl_port " + str(port),
                   "-f", str(config.resolve()), "-c", "init"]
        with self.log_lock:
            self.logs.clear()
        try:
            self.process = subprocess.Popen(command, cwd=str(self.firmware_root), stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            self.reader = threading.Thread(target=self._drain, args=(self.process,), daemon=True)
            self.reader.start()
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                if self.process.poll() is not None:
                    break
                try:
                    result = probe.connect(port)
                    if self.process.poll() is None:
                        result["service"] = "已由调试器后台启动 OpenOCD"
                        return result
                except DebugError:
                    pass
                time.sleep(.15)
            raise DebugError("OpenOCD 启动失败或超时，请检查探针是否被其他程序占用。")
        except (OSError, DebugError) as exc:
            probe.close()
            self.stop()
            details = "\n".join(self.snapshot()["logs"][-12:])
            raise DebugError(str(exc) + ("\n" + details if details else "")) from exc


def start_rtt(probe, reader, port):
    # An existing RTT server can be shared without reconfiguring its event hooks.
    if reader.start(port) is None:
        return None
    try:
        for command in ('rtt setup 0x20000000 0x30000 "SEGGER RTT"',
                        "rtt start", "rtt polling_interval 10", "rtt server start " + str(port) + " 0"):
            response = probe.command('if {[catch {' + command + '} livertt_error]} {return "LIVERTT_ERROR:$livertt_error"} else {return "LIVERTT_OK"}')
            if response != "LIVERTT_OK":
                # Another client may have started the server during setup.
                if reader.start(port) is None:
                    return None
                raise DebugError(response[:500])
        error = reader.start(port)
        if error:
            raise DebugError(error)
        return None
    except DebugError as exc:
        reader.error = "RTT 自动启动失败；RAM 采样仍可使用。" + str(exc)
        return reader.error


class RttReader:
    def __init__(self):
        self.sock = None
        self.thread = None
        self.stop_event = threading.Event()
        self.lock = threading.Lock()
        self.lines = deque(maxlen=1500)
        self.sequence = 0
        self.error = "RTT 未连接。"

    def close(self):
        self.stop_event.set()
        if self.sock:
            try:
                self.sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            self.sock.close()
        self.sock = None
        if self.thread:
            self.thread.join(timeout=1)
        self.thread = None

    def start(self, port):
        self.close()
        self.lines.clear()
        self.sequence = 0
        self.error = ""
        try:
            sock = socket.create_connection(("127.0.0.1", port), timeout=1)
            sock.settimeout(.4)
        except OSError as exc:
            self.error = "RTT 通道不可用；RAM 采样仍可使用。" + str(exc)
            return self.error
        self.sock = sock
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self._read, args=(sock, self.stop_event), daemon=True)
        self.thread.start()
        return None

    def _append(self, text):
        # Strip terminal cursor/color escapes and bound individual log records.
        text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text).replace("\r", "")
        if text:
            with self.lock:
                self.sequence += 1
                self.lines.append({"id": self.sequence, "text": text[:8192]})

    def _read(self, sock, stop):
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        pending = ""
        last = time.monotonic()
        try:
            while not stop.is_set():
                try:
                    data = sock.recv(8192)
                except socket.timeout:
                    data = None
                if data == b"":
                    self.error = "RTT 连接已关闭。"
                    break
                if data:
                    pending += decoder.decode(data)
                while "\n" in pending:
                    line, pending = pending.split("\n", 1)
                    self._append(line)
                if pending and (len(pending) >= 8192 or time.monotonic() - last > .5):
                    self._append(pending)
                    pending = ""
                    last = time.monotonic()
        except OSError:
            if not stop.is_set():
                self.error = "RTT 通信已断开。"
        finally:
            pending += decoder.decode(b"", final=True)
            if pending:
                self._append(pending)
            sock.close()

    def snapshot(self, after):
        with self.lock:
            return {"cursor": self.sequence, "lines": [line for line in self.lines if line["id"] > after], "error": self.error}


