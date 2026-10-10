"""Real installed Pi CLI + offline model + PTY + terminal screen decoder.

Run with Python containing pyte, e.g. /tmp/pi-submit-poc-venv/bin/python.
No installation patches, production sessions, auth, or render calls.
"""
import argparse
import codecs
import fcntl
import json
import os
import pathlib
import pty
import select
import shlex
import signal
import struct
import subprocess
import termios
import time

import pyte

parser = argparse.ArgumentParser()
parser.add_argument("--mode", choices=["fullscreen", "main"], default="fullscreen")
parser.add_argument("--timeout-ms", type=int, default=60000)
parser.add_argument("--minimal", action="store_true")
parser.add_argument("--no-observer", action="store_true")
parser.add_argument("--columns", type=int, default=120)
parser.add_argument("--rows", type=int, default=40)
parser.add_argument("--stream-followup", action="store_true")
parser.add_argument("--resize-on-submit", action="store_true")
args = parser.parse_args()
here = pathlib.Path(__file__).resolve().parent
environment = json.loads(subprocess.check_output([
    "python3", str(here / "prepare-local-pi.py"), "--timeout-ms", "60000"
]))
root = pathlib.Path(environment["root"])
agent = root / "agent"
settings_path = agent / "settings.json"
settings = json.loads(settings_path.read_text())
settings["tuiMode"] = "fullscreen" if args.mode == "fullscreen" else "inline"
if args.minimal:
    settings["packages"] = [spec for spec in settings["packages"] if any(
        name in spec["source"] for name in ["rpiv-ask-user-question", "pi-enhance-patches"]
    )]
settings_path.write_text(json.dumps(settings, indent=2))
config_path = agent / "pi-enhance-patches.json"
config = json.loads(config_path.read_text())
config["askUserTimeoutMs"] = args.timeout_ms
config_path.write_text(json.dumps(config, indent=2))
command = shlex.split(environment["command"])
if args.stream_followup:
    command.insert(1, "PI_POC_FOLLOWUP_CHUNKS=100")
if not args.no_observer:
    command += ["-e", str(here / "ask-submit-observer.ts")]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", args.rows, args.columns, 0, 0))
child_env = dict(os.environ, TERM="xterm-256color")
process = subprocess.Popen(command, cwd=environment["cwd"], env=child_env,
                           stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
screen = pyte.Screen(args.columns, args.rows)
stream = pyte.Stream(screen)
decoder = codecs.getincrementaldecoder("utf-8")("replace")
raw = open(root / "pty-output.bin", "wb")
results = []


def events():
    path = root / "events.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines()]


def pump(seconds):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        readable, _, _ = select.select([master], [], [], min(0.05, max(0, until - time.monotonic())))
        if readable:
            try:
                data = os.read(master, 65536)
            except OSError:
                return
            if not data:
                return
            raw.write(data)
            raw.flush()
            stream.feed(decoder.decode(data))


def wait_for(predicate, label, seconds=20):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        pump(0.05)
        if predicate():
            return
        if process.poll() is not None:
            raise RuntimeError(f"CLI exited {process.returncode}: {label}")
    raise TimeoutError(f"Waiting for {label}; screen:\n" + "\n".join(screen.display))


def send(data):
    os.write(master, data)


def save_screen(name):
    text = "\n".join(screen.display)
    (root / f"{name}.txt").write_text(text)
    return text


try:
    wait_for(lambda: any(event["event"] == "session-start" for event in events()), "session start", 60)
    pump(0.75)
    # Repeated questionnaires share a real session, including growing tool/chat history.
    for index, (count, key) in enumerate([(2, b"\r"), (3, b"\r"), (4, b"\r"), (2, b"\x1b[13;1:1u"), (2, b"\r")]):
        label = f"case-{index + 1}-{count}-{'kitty' if len(key) > 1 else 'enter'}"
        start = len(events())
        send(f"/poc-run {count}\r".encode())
        wait_for(lambda: "Local environment question 1?" in "\n".join(screen.display), "questionnaire")
        for _ in range(count):
            send(key)
            pump(0.15)
        wait_for(lambda: "Ready to submit your answers?" in "\n".join(screen.display), "submit review")
        save_screen(label + "-review")
        send(key)
        if args.resize_on_submit:
            columns = args.columns - 10 if index % 2 == 0 else args.columns
            rows = args.rows - 4 if index % 2 == 0 else args.rows
            screen.resize(lines=rows, columns=columns)
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
            process.send_signal(signal.SIGWINCH)
        wait_for(lambda: any(event["event"] == "questionnaire-result" for event in events()[start:]), "tool result")
        samples = []
        for delay in [0.05, 0.45, 1.5]:
            pump(delay)
            text = save_screen(label + f"-after-{len(samples)}")
            samples.append({"questionnairePainted": "Ready to submit your answers?" in text or "Review your answers" in text})
        wait_for(lambda: any(event["event"] == "agent-end" for event in events()[start:]), "agent followup")
        send(b"/poc-ping\r")
        wait_for(lambda: any(event["event"] == "ping" for event in events()[start:]), "editor ping")
        pump(0.25)
        recent = events()[start:]
        result = next(event for event in recent if event["event"] == "questionnaire-result")
        ui = [event["details"] for event in recent if event["event"] == "ui-sample"]
        results.append({"case": label, "toolResult": result["details"], "ptySamples": samples,
                        "uiSamples": [{key: value for key, value in item.items() if key != "screen"} for item in ui],
                        "ping": True})
        print(json.dumps(results[-1], ensure_ascii=False), flush=True)
        assert result["details"].get("cancelled") is False, "must submit normally"
        assert result["details"]["answerCount"] == count
        assert not samples[-1]["questionnairePainted"], "persistent questionnaire on terminal"
        assert all(not item["hasOverlayEntries"] and not item["questionnairePainted"]
                   for item in ui if item["phase"] == "close+2000ms"), "persistent questionnaire in UI"
    send(b"/poc-exit\r")
    pump(0.5)
finally:
    (root / "summary.json").write_text(json.dumps({"arguments": vars(args), "results": results}, ensure_ascii=False, indent=2))
    save_screen("final-screen")
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
    os.close(master)
    raw.close()
    print(f"Evidence: {root}", flush=True)
