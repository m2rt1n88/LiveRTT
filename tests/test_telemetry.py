"""Protocol and real-ELF integration tests; no physical target is touched."""
import json
import io
import socket
import socketserver
import struct
import threading
import unittest
from unittest.mock import Mock, patch
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from backend.app import DebugError, DebugSession, ElfIndex, OpenOCD, OpenOCDService, RttReader, Server, start_rtt

FIRMWARE = Path(__file__).resolve().parents[2] / "UICRM-Embedded"
if not FIRMWARE.is_dir():
    FIRMWARE = next((parent for parent in Path(__file__).resolve().parents if parent.name == "UICRM-Embedded"), FIRMWARE)


class FakeTarget(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


class TargetHandler(socketserver.BaseRequestHandler):
    def handle(self):
        pending = b""
        while True:
            data = self.request.recv(8192)
            if not data:
                return
            pending += data
            while b"\x1a" in pending:
                raw, pending = pending.split(b"\x1a", 1)
                command = raw.decode("ascii")
                self.server.commands.append(command)
                if command == "target current":
                    response = "stm32f4x.cpu"
                elif command == "stm32f4x.cpu curstate":
                    response = "running"
                elif command.startswith("read_memory "):
                    _, address, width, size = command.split()
                    if width != "8":
                        response = "unsupported width"
                    else:
                        start = int(address, 0)
                        response = " ".join(str(self.server.memory.get(start + i, 0)) for i in range(int(size)))
                else:
                    response = "ERROR: only read commands are permitted"
                wire = response.encode() + b"\x1a"
                # Deliberately fragment Tcl responses, including the terminator.
                self.request.sendall(wire[:3])
                self.request.sendall(wire[3:])


class IntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        candidates = list(FIRMWARE.glob("build/*/examples/DJI_Board_TypeC_general/motor/*m6020.elf"))
        candidates += list(FIRMWARE.glob("cmake-build-debug/examples/DJI_Board_TypeC_general/motor/*m6020.elf"))
        if not candidates:
            raise unittest.SkipTest("No C-board 6020 ELF available; build the example before running these tests")
        cls.elf_path = candidates[0]
        cls.index = ElfIndex(cls.elf_path)

    def setUp(self):
        self.target = FakeTarget(("localhost", 0), TargetHandler)
        self.target.commands = []
        self.target.memory = {}
        for address, data in self.index.signatures:
            self.put(address, data)
        self.thread = threading.Thread(target=self.target.serve_forever, daemon=True)
        self.thread.start()
        self.probe = OpenOCD()
        self.probe.connect(self.target.server_address[1])

    def tearDown(self):
        self.probe.close()
        self.target.shutdown()
        self.target.server_close()

    def put(self, address, data):
        for i, value in enumerate(data):
            self.target.memory[address + i] = value

    def session(self):
        session = DebugSession(FIRMWARE)
        session.index = self.index
        session.probe = self.probe
        session.verify(self.index.sha)
        return session

    def test_real_elf_class_inheritance_and_offline_browsing(self):
        root = self.index.search("motor1")["items"]
        self.assertEqual(root[0]["type"], "Motor6020*")
        fields = {item["name"]: item for item in self.index.children("motor1")}
        self.assertTrue(fields["state_"]["expandable"])
        self.assertTrue(fields["output_"]["scalar"])
        state = {item["name"] for item in self.index.children("motor1->state_")}
        self.assertTrue({"theta", "omega", "target", "current", "temperature"} <= state)
        # Browsing/inspection must not access a target.
        self.assertEqual(self.target.commands, ["target current", "stm32f4x.cpu curstate"])

    def test_pointer_following_read_decode_and_relocation(self):
        session = self.session()
        root_address = self.index.variables["motor1"]["address"]
        first_object = 0x20008000
        self.put(root_address, first_object.to_bytes(4, "little"))
        state_offset, _ = self.index.members(self.index.base(self.index.variables["motor1"]["die"]).get_DIE_from_attribute("DW_AT_type"))["state_"]
        # DjiMotorState starts with five consecutive float feedback values in the real example.
        self.put(first_object + state_offset, struct.pack("<5f", 1.25, -2.5, 3.75, 42, .5))
        paths = ["motor1->state_.theta", "motor1->state_.omega", "motor1->state_.current", "motor1->state_.temperature"]
        data = session.sample(paths, self.index.sha)
        self.assertEqual([v["value"] for v in data["values"]], [1.25, -2.5, 3.75, 42])
        second_object = 0x20009000
        self.put(root_address, second_object.to_bytes(4, "little"))
        self.put(second_object + state_offset, struct.pack("<f", 9.5))
        self.assertEqual(session.sample(paths[:1], self.index.sha)["values"][0]["value"], 9.5)

    def test_null_and_invalid_pointer_never_read_peripheral(self):
        session = self.session()
        root_address = self.index.variables["motor1"]["address"]
        data = session.sample(["motor1->state_.theta"], self.index.sha)
        self.assertIsNone(data["values"][0]["value"])
        self.assertIn("指针为空", data["values"][0]["error"])
        self.put(root_address, (0x40000000).to_bytes(4, "little"))
        data = session.sample(["motor1->state_.theta"], self.index.sha)
        self.assertIsNone(data["values"][0]["value"])
        self.assertFalse(any(command.startswith("read_memory 0x400") for command in self.target.commands))

    def test_wrong_elf_and_nonfinite_data_rejected(self):
        session = self.session()
        address, _ = self.index.signatures[0]
        self.put(address, b"\xff" * 32)
        with self.assertRaises(DebugError):
            session.verify(self.index.sha)
        self.assertIsNone(session.verified_sha)
        with self.assertRaises(DebugError):
            session.sample(["motor1->state_.omega"], self.index.sha)
        _, die = self.index.resolve("motor1->state_.omega")
        with self.assertRaises(DebugError):
            self.index.decode(die, struct.pack("<f", float("nan")))

    def test_no_evaluation_or_writes(self):
        for expression in ("motor1->CalcOutput()", "motor1->state_.omega;reset", "motor1[999999]", "motor1->state_.target=5"):
            with self.assertRaises(DebugError):
                self.index.resolve(expression)
        with self.assertRaises(DebugError):
            self.probe.read(0x40000000, 4)
        self.assertFalse(any(any(word in command for word in ("halt", "reset", "write", "resume")) for command in self.target.commands))

    def test_http_contract_and_host_protection(self):
        session = self.session()
        import tempfile
        data_dir = tempfile.TemporaryDirectory()
        web = Server(("localhost", 0), session, data_dir.name)
        thread = threading.Thread(target=web.serve_forever, daemon=True)
        thread.start()
        base = "http://localhost:" + str(web.server_port)
        try:
            with urlopen(base + "/api/status") as response:
                status = json.load(response)
            headers = {"X-Debug-Token": status["token"], "Content-Type": "application/json"}
            request = Request(base + "/api/inspect", json.dumps({"sha": self.index.sha, "path": "motor1->state_.omega"}).encode(), headers)
            with urlopen(request) as response:
                self.assertTrue(json.load(response)["scalar"])
            with self.assertRaises(HTTPError) as caught:
                urlopen(Request(base + "/api/disconnect", b"{}", {"Content-Type": "application/json"}))
            self.assertEqual(caught.exception.code, 403)
            caught.exception.close()
            with self.assertRaises(HTTPError) as caught:
                urlopen(Request(base + "/api/status", headers={"Origin": "https://unrelated.invalid"}))
            self.assertEqual(caught.exception.code, 403)
            caught.exception.close()
            with self.assertRaises(HTTPError) as caught:
                urlopen(base + "/telemetry_server.py")
            self.assertEqual(caught.exception.code, 404)
            caught.exception.close()
            with urlopen(base + "/") as response:
                self.assertIn(b'workspace-page', response.read())
        finally:
            web.shutdown()
            web.server_close()
            data_dir.cleanup()

    def test_rtt_fragmented_utf8(self):
        listener = socket.socket()
        listener.bind(("localhost", 0))
        listener.listen(1)
        done = threading.Event()
        def send():
            conn, _ = listener.accept()
            payload = "\x1b[32m电机在线\x1b[0m\n".encode()
            conn.sendall(payload[:8]); conn.sendall(payload[8:])
            done.wait(2)
            conn.close()
        threading.Thread(target=send, daemon=True).start()
        reader = RttReader()
        try:
            self.assertIsNone(reader.start(listener.getsockname()[1]))
            import time
            deadline = time.monotonic() + 2
            while not reader.snapshot(0)["lines"] and time.monotonic() < deadline:
                time.sleep(.02)
            self.assertEqual(reader.snapshot(0)["lines"][0]["text"], "电机在线")
            self.assertEqual(reader.snapshot(1)["lines"], [])
        finally:
            done.set(); reader.close(); listener.close()


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.service = OpenOCDService(FIRMWARE)
        self.probe = Mock()
        self.probe.connect.return_value = {"target": "stm32f4x.cpu", "state": "running"}

    def tearDown(self):
        self.service.stop()

    def test_existing_service_reused_and_never_terminated(self):
        with patch.object(self.service, "listening", return_value=True), patch("backend.probe.subprocess.Popen") as launch:
            result = self.service.connect(self.probe, 6666)
            self.service.stop()
        launch.assert_not_called()
        self.assertIn("复用", result["service"])
        self.probe.connect.assert_called_once_with(6666)

    def test_bad_existing_listener_does_not_launch_competitor(self):
        self.probe.connect.side_effect = DebugError("bad Tcl handshake")
        with patch.object(self.service, "listening", return_value=True), patch("backend.probe.subprocess.Popen") as launch:
            with self.assertRaisesRegex(DebugError, "bad Tcl"):
                self.service.connect(self.probe, 6666)
        launch.assert_not_called()

    def test_launch_arguments_owned_cleanup_and_log_drain(self):
        process = Mock(stdout=io.StringIO("CMSIS-DAP connected\n"))
        process.poll.return_value = None
        with patch.object(self.service, "listening", return_value=False), patch("backend.probe.shutil.which", return_value="openocd.exe"), patch("backend.probe.subprocess.Popen", return_value=process) as launch:
            result = self.service.connect(self.probe, 16666)
            self.assertTrue(self.service.snapshot()["owned"])
            self.assertIn("后台启动", result["service"])
            command = launch.call_args.args[0]
            self.assertIn("tcl_port 16666", command)
            self.assertIn("telnet_port disabled", command)
            self.assertIn("gdb_port disabled", command)
            self.assertEqual(launch.call_args.kwargs["cwd"], str(FIRMWARE))
            self.assertNotIn("shell", launch.call_args.kwargs)
            self.assertFalse(any(word in " ".join(command) for word in ("reset", "halt", "program")))
            self.service.stop()
            self.service.stop()
        process.terminate.assert_called_once()
        self.assertEqual(self.service.snapshot()["logs"], ["CMSIS-DAP connected"])

    def test_exit_and_timeout_include_logs_and_clean_owned_process(self):
        for exited in (True, False):
            with self.subTest(exited=exited):
                process = Mock(stdout=io.StringIO("Error: probe unavailable\n"))
                process.poll.return_value = 1 if exited else None
                self.probe.connect.side_effect = DebugError("not ready")
                with patch.object(self.service, "listening", return_value=False), patch("backend.probe.shutil.which", return_value="openocd.exe"), patch("backend.probe.subprocess.Popen", return_value=process):
                    with self.assertRaisesRegex(DebugError, "probe unavailable"):
                        self.service.connect(self.probe, 6666, timeout=.01)
                self.assertIsNone(self.service.process)
                if not exited:
                    process.terminate.assert_called_once()

    def test_missing_executable_and_manual_mode(self):
        with patch.object(self.service, "listening", return_value=False), patch("backend.probe.shutil.which", return_value=None), patch("backend.probe.subprocess.Popen") as launch:
            with self.assertRaisesRegex(DebugError, "找不到 OpenOCD"):
                self.service.connect(self.probe, 6666, executable="missing.exe")
            with self.assertRaisesRegex(DebugError, "未运行"):
                self.service.connect(self.probe, 6666, auto_start=False)
        launch.assert_not_called()

    def test_rtt_existing_server_needs_no_setup(self):
        reader = Mock()
        reader.start.return_value = None
        self.assertIsNone(start_rtt(self.probe, reader, 8888))
        self.probe.command.assert_not_called()

    def test_rtt_automatic_setup_and_optional_failure(self):
        reader = Mock()
        reader.start.side_effect = ["not listening", None]
        self.probe.command.return_value = "LIVERTT_OK"
        self.assertIsNone(start_rtt(self.probe, reader, 18888))
        commands = [call.args[0] for call in self.probe.command.call_args_list]
        self.assertEqual(len(commands), 4)
        self.assertIn("rtt server start 18888 0", commands[-1])
        self.assertTrue(all("catch" in command for command in commands))
        reader.start.side_effect = None
        reader.start.return_value = "not listening"
        self.probe.command.return_value = "LIVERTT_ERROR:No control block found"
        self.assertIn("RAM 采样仍可使用", start_rtt(self.probe, reader, 8888))


if __name__ == "__main__":
    unittest.main(verbosity=2)
