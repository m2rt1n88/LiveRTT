"""Loopback HTTP API and static frontend entry point."""
import argparse
import json
import secrets
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit
from . import ROOT
from .errors import DebugError
from .elf_index import ElfIndex
from .probe import OpenOCD, OpenOCDService, RttReader, start_rtt
from .session import DebugSession
from .profiles import ProfileStore, validate_profile

class Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, session, data_root=None):
        self.session = session
        self.token = secrets.token_urlsafe(32)
        self.profiles = ProfileStore(data_root or ROOT / "data")
        super().__init__(address, Handler)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / "frontend"), **kwargs)

    def log_message(self, fmt, *args):
        if "/api/sample" not in str(args):
            super().log_message(fmt, *args)

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()

    def trusted(self):
        allowed = {"127.0.0.1:" + str(self.server.server_port), "localhost:" + str(self.server.server_port)}
        host = self.headers.get("Host", "")
        origin = self.headers.get("Origin")
        if host not in allowed or (origin and origin not in {"http://" + h for h in allowed}):
            self.json_response({"error": "仅接受本机同源请求。"}, 403)
            return False
        return True

    def json_response(self, data, status=200):
        encoded = json.dumps(data, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self):
        if not self.trusted():
            return
        url = urlsplit(self.path)
        params = parse_qs(url.query)
        if not url.path.startswith("/api/"):
            # Serve only the debugger's public assets, never ELF files, sources, .venv or directory listings.
            allowed = {"/", "/index.html", "/assets/css/app.css", "/assets/js/app.js",
                       "/assets/js/api.js", "/assets/js/charts.js", "/assets/js/profiles.js", "/assets/js/motors.js", "/assets/js/motion.js", "/assets/js/vehicle.js",
                       "/assets/js/mechanisms.js", "/assets/js/mechanism-view.js", "/assets/js/motor-control.js", "/assets/js/motor-ai.js", "/assets/js/motor-plots.js", "/assets/models/library.json"}
            if url.path not in allowed:
                self.send_error(404)
                return
            return super().do_GET()
        try:
            with self.server.session.lock:
                session = self.server.session
                if url.path == "/api/status":
                    return self.json_response({"token": self.server.token, "presets": session.presets(), "connected": session.probe.sock is not None,
                                               "openocd": session.service.defaults(), "service": session.service.snapshot(), "profiles": self.server.profiles.list()})
                if self.headers.get("X-Debug-Token") != self.server.token:
                    return self.json_response({"error": "请刷新调试器页面。"}, 403)
                if url.path == "/api/profiles":
                    return self.json_response({"profiles": self.server.profiles.list()})
                if url.path == "/api/profile":
                    return self.json_response(self.server.profiles.get(params.get("id", [""])[0]))
                if url.path == "/api/rtt":
                    return self.json_response(session.rtt.snapshot(max(0, int(params.get("after", ["0"])[0]))))
                if url.path == "/api/service":
                    return self.json_response(session.service.snapshot())
                index = session.require_elf(params.get("sha", [""])[0])
                if url.path == "/api/variables":
                    offset = max(0, min(100000, int(params.get("offset", ["0"])[0])))
                    return self.json_response(index.search(params.get("q", [""])[0], offset))
                if url.path == "/api/children":
                    return self.json_response({"items": index.children(params.get("path", [""])[0])})
                raise DebugError("未知接口。")
        except (DebugError, ValueError) as exc:
            self.json_response({"error": str(exc)}, 400)
        except Exception as exc:
            self.json_response({"error": "ELF 解析失败：" + str(exc)}, 500)

    def do_POST(self):
        if not self.trusted():
            return
        if self.headers.get("X-Debug-Token") != self.server.token:
            return self.json_response({"error": "请刷新调试器页面。"}, 403)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 64000:
                raise DebugError("请求长度无效。")
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise DebugError("请求必须是对象。")
            path = urlsplit(self.path).path
            session = self.server.session
            with session.lock:
                if path == "/api/profile/validate":
                    return self.json_response(validate_profile(body))
                if path == "/api/profile/save":
                    return self.json_response(self.server.profiles.save(body))
                if path == "/api/elf":
                    return self.json_response(session.load(body.get("path", "")))
                if path == "/api/inspect":
                    index = session.require_elf(body.get("sha", ""))
                    _, die = index.resolve(body.get("path", ""))
                    return self.json_response(index.describe(body["path"], body["path"], die))
                if path == "/api/connect":
                    session.require_elf(body.get("sha", ""))
                    if body.get("confirmed") is not True:
                        raise DebugError("请确认 ELF 来自当前板上固件的同一次构建。")
                    port = int(body.get("port", 6666))
                    if not 1 <= port <= 65535:
                        raise DebugError("端口无效。")
                    rtt_port = int(body.get("rttPort", 8888))
                    if not 1 <= rtt_port <= 65535 or rtt_port == port:
                        raise DebugError("RTT 端口无效或与 Tcl 端口重复。")
                    executable, config = body.get("executable", ""), body.get("config", "")
                    if not isinstance(executable, str) or not isinstance(config, str):
                        raise DebugError("OpenOCD 路径必须是文本。")
                    session.verified_sha = None
                    session.rtt.close()
                    try:
                        result = session.service.connect(session.probe, port, executable, config, body.get("autoStart", True) is True)
                        result.update(session.verify(body["sha"]))
                        result["rttError"] = start_rtt(session.probe, session.rtt, rtt_port)
                    except Exception:
                        session.disconnect()
                        raise
                    return self.json_response(result)
                if path == "/api/disconnect":
                    session.disconnect()
                    return self.json_response({"connected": False})
                if path == "/api/sample":
                    return self.json_response(session.sample(body.get("paths"), body.get("sha", ""), body.get("motorPaths")))
                if path == "/api/motors/scan":
                    return self.json_response(session.scan_motors(body.get("sha", "")))
                if path == "/api/motors/write":
                    return self.json_response(session.write_motor(body))
                if path == "/api/motors/enable":
                    return self.json_response(session.set_motor_enabled(body))
                raise DebugError("未知接口。")
        except (DebugError, ValueError, TypeError, OSError) as exc:
            self.json_response({"error": str(exc)}, 400)
        except Exception as exc:
            self.json_response({"error": "操作失败：" + str(exc)}, 500)


def main():
    parser = argparse.ArgumentParser(description="LiveRTT local SWD variable debugger")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--firmware-root", default=str(ROOT.parent / "UICRM-Embedded"))
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--data-dir", default=str(ROOT / "data"))
    args = parser.parse_args()
    server = Server(("127.0.0.1", args.port), DebugSession(args.firmware_root), args.data_dir)
    url = "http://127.0.0.1:" + str(server.server_port) + "/#workspace"
    print("LiveRTT debugger: " + url, flush=True)
    print("SWD + integrated OpenOCD/RTT. Ctrl+C to stop managed services.", flush=True)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.session.disconnect()
        server.server_close()


if __name__ == "__main__":
    main()
