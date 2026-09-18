#!/usr/bin/env python3
"""Exercise an installed CLI in a POSIX PTY or Windows ConPTY, with a local API."""
import argparse
import codecs
import json
import os
from pathlib import Path
import queue
import re
import signal
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pyte

PROMPT = "clawgod-smoke-182"
REPLY = "CLAWGOD_TUI_OK_182"
MISSING_API = "has no Bun.ant.CellSegmenter"


class Terminal:
    def __init__(self, command, cwd, env):
        self.output = queue.Queue()
        if os.name == "nt":
            from winpty import PtyProcess
            from winpty.enums import Backend
            self.process = PtyProcess.spawn(command, cwd=str(cwd), env=env,
                                            dimensions=(36, 120), backend=Backend.ConPTY)
        else:
            import fcntl
            import pty
            import struct
            import termios
            self.fd, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 36, 120, 0, 0))
            try:
                self.process = subprocess.Popen(command, cwd=cwd, env=env, stdin=slave,
                                                stdout=slave, stderr=slave, start_new_session=True)
            finally:
                os.close(slave)
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        try:
            while True:
                if os.name == "nt":
                    text = self.process.read(65536)
                else:
                    data = os.read(self.fd, 65536)
                    if not data:
                        break
                    text = decoder.decode(data)
                if text:
                    self.output.put(text)
        except (EOFError, OSError):
            pass
        finally:
            self.output.put(None)

    def write(self, text):
        if os.name == "nt":
            self.process.write(text)
        else:
            os.write(self.fd, text.encode())

    def close(self):
        if os.name == "nt":
            # Include the console child if a future launcher adds a process.
            subprocess.run(["taskkill", "/PID", str(self.process.pid), "/T", "/F"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            self.process.close(force=True)
        else:
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            self.process.wait(timeout=5)
            os.close(self.fd)


def run_case(args, name, command, shim, expect_error=False):
    home = args.output / (name + "-home")
    cwd = home / "project"
    cwd.mkdir(parents=True, exist_ok=True)
    (home / ".claude.json").write_text(json.dumps({
        "hasCompletedOnboarding": True, "lastOnboardingVersion": args.version,
        "theme": "dark", "customApiKeyResponses": {"approved": ["ci-local-only"]},
        "projects": {path: {"hasTrustDialogAccepted": True, "projectOnboardingSeenCount": 1}
                     for path in {str(cwd), cwd.as_posix()}},
    }), encoding="utf-8")
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
            saw_prompt = PROMPT in json.dumps(body.get("messages", []))
            requests.append({"path": self.path, "saw_prompt": saw_prompt})
            message = {"id": "msg_ci", "type": "message", "role": "assistant",
                       "model": body.get("model", "ci-model"),
                       "content": [{"type": "text", "text": REPLY}],
                       "stop_reason": "end_turn", "stop_sequence": None,
                       "usage": {"input_tokens": 10, "output_tokens": 8}}
            self.send_response(200)
            if "count_tokens" in self.path:
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"input_tokens":10}')
            elif body.get("stream"):
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                events = [
                    {"type": "message_start", "message": {**message, "content": [], "stop_reason": None}},
                    {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
                    {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": REPLY}},
                    {"type": "content_block_stop", "index": 0},
                    {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None},
                     "usage": {"output_tokens": 8}},
                    {"type": "message_stop"},
                ]
                for event in events:
                    self.wfile.write((f"event: {event['type']}\ndata: {json.dumps(event)}\n\n").encode())
                self.wfile.flush()
            else:
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(message).encode())

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    # Do not inherit developer credentials, providers, proxy settings or feature toggles.
    env = {k: v for k, v in os.environ.items() if k.upper() in {
        "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "LANG",
    }}
    env.update({
        "HOME": str(home), "USERPROFILE": str(home), "TERM": "xterm-256color",
        "COLORTERM": "truecolor", "ANTHROPIC_API_KEY": "ci-local-only",
        "ANTHROPIC_BASE_URL": f"http://127.0.0.1:{server.server_port}",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1", "DISABLE_AUTOUPDATER": "1",
        "DISABLE_TELEMETRY": "1", "CLAWGOD_FEATURE_BUN_ANT_SHIM": str(shim).lower(),
    })
    if args.native:
        env["CLAUDE_CODE_EXECPATH"] = str(args.native)
    if os.name == "nt":
        for key, directory in [("APPDATA", home / "AppData" / "Roaming"),
                               ("LOCALAPPDATA", home / "AppData" / "Local")]:
            directory.mkdir(parents=True, exist_ok=True)
            env[key] = str(directory)
    terminal = None
    raw, seen_queries, seen_cursor_queries, typed_at = "", 0, 0, None
    submitted, header_seen, passed = False, False, False
    screen = pyte.Screen(120, 36)
    stream = pyte.Stream(screen)
    started = time.monotonic()
    reason = "timeout waiting for interactive TUI"
    try:
        terminal = Terminal(command, cwd, env)
        while time.monotonic() - started < args.timeout:
            now = time.monotonic()
            if typed_at is not None and not submitted and now - typed_at >= 0.2:
                terminal.write("\r")
                submitted = True
            try:
                text = terminal.output.get(timeout=0.05)
            except queue.Empty:
                continue
            if text is None:
                reason = "process/PTY exited before the expected result"
                break
            raw += text
            stream.feed(text)
            visible = "\n".join(screen.display)
            if MISSING_API in raw:
                passed = expect_error
                reason = "expected missing CellSegmenter error" if passed else "renderer API is missing"
                break
            if "Uncaught exception" in raw:
                reason = "unexpected uncaught exception"
                break
            # Simulate a basic terminal's DA1 reply; ConPTY may answer queries itself.
            queries = len(re.findall(r"\x1b\[(?:0)?c", raw))
            for _ in range(queries - seen_queries):
                terminal.write("\x1b[?61;4;6;22;23;24;28;32;42;52c")
            seen_queries = queries
            cursor_queries = list(re.finditer(r"\x1b\[(\?)?6n", raw))
            for query in cursor_queries[seen_cursor_queries:]:
                private = "?" if query.group(1) else ""
                terminal.write(f"\x1b[{private}{screen.cursor.y + 1};{screen.cursor.x + 1}R")
            seen_cursor_queries = len(cursor_queries)
            header_seen |= "Claude Code" in visible and args.version in visible
            if not expect_error and header_seen and "❯" in visible and typed_at is None:
                terminal.write(PROMPT)
                typed_at = now
            if not expect_error and submitted and REPLY in visible and any(r["saw_prompt"] for r in requests):
                passed, reason = True, "header, keyboard input, local API request and rendered reply verified"
                break
    finally:
        try:
            if terminal:
                terminal.close()
        finally:
            server.shutdown()
            server.server_close()
            (args.output / f"{name}.raw.log").write_text(raw, encoding="utf-8")
            (args.output / f"{name}.screen.txt").write_text("\n".join(screen.display), encoding="utf-8")
            result = {"case": name, "passed": passed, "reason": reason, "header_seen": header_seen,
                      "submitted": submitted, "requests": requests, "seconds": round(time.monotonic() - started, 2)}
            (args.output / f"{name}.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
            print(json.dumps(result), flush=True)
    if not passed:
        raise RuntimeError(f"{name}: {reason}; see {args.output}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cli", required=True, type=Path)
    parser.add_argument("--bun", required=True, type=Path)
    parser.add_argument("--native", type=Path)
    parser.add_argument("--version", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--timeout", type=float, default=60)
    parser.add_argument("--expect-missing-without-shim", action="store_true")
    args = parser.parse_args()
    for key in ["cli", "bun", "native", "output"]:
        value = getattr(args, key)
        if value is not None:
            setattr(args, key, value.resolve())
    args.output.mkdir(parents=True, exist_ok=True)
    if args.native:
        run_case(args, "native", [str(args.native)], False)
    if args.expect_missing_without_shim:
        run_case(args, "shim-off", [str(args.bun), str(args.cli)], False, expect_error=True)
    run_case(args, "shim-on", [str(args.bun), str(args.cli)], True)


if __name__ == "__main__":
    main()
