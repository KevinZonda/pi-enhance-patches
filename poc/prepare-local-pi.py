"""Prepare an isolated agent directory using installed package paths; never copy auth or sessions.
Run: python3 poc/prepare-local-pi.py [--timeout-ms 60000]
"""
import argparse
import json
import pathlib
import shlex
import shutil
import tempfile


def read_config(path):
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"Cannot read configuration {path}: {error}") from error


parser = argparse.ArgumentParser()
parser.add_argument("--timeout-ms", type=int, default=60000)
args = parser.parse_args()
assert 1000 <= args.timeout_ms <= 86400000
source = pathlib.Path.home() / ".pi/agent"
root = pathlib.Path(tempfile.mkdtemp(prefix="pi-local-ask-poc-"))
agent = root / "agent"
cwd = root / "work"
agent.mkdir()
cwd.mkdir()
settings = read_config(source / "settings.json")
packages = []
versions = []
for spec in settings["packages"]:
    declaration = spec if isinstance(spec, dict) else {"source": spec}
    name = declaration["source"]
    if name.startswith("npm:"):
        path = source / "npm/node_modules" / name[4:]
    elif name.startswith("git:"):
        path = source / "git" / name[4:]
    else:
        raise ValueError(f"Unsupported local package mapping: {name}")
    manifest = read_config(path / "package.json")
    versions.append({"name": manifest["name"], "version": manifest["version"], "path": str(path)})
    packages.append({**declaration, "source": str(path)})
safe_keys = ["compaction", "tuiMode", "theme", "terminal", "quietStartup", "treeFilterMode", "branchSummary"]
local_settings = {key: settings[key] for key in safe_keys if key in settings}
local_settings.update(packages=packages, defaultProvider="local-poc", defaultModel="deterministic", enableInstallTelemetry=False)
(agent / "settings.json").write_text(json.dumps(local_settings, indent=2))
for filename in ["keybindings.json", "pi-cc-extensions.json", "pi-tab-title.json"]:
    if (source / filename).exists():
        shutil.copyfile(source / filename, agent / filename)
permission = source / "extensions/pi-permission-system/config.json"
if permission.exists():
    target = agent / "extensions/pi-permission-system/config.json"
    target.parent.mkdir(parents=True)
    shutil.copyfile(permission, target)
patches = read_config(source / "pi-enhance-patches.json")
patches.update(askUserTimeoutMs=args.timeout_ms, backgroundTaskAutopatchEnabled=False, subagentNotificationAutopatchEnabled=False)
(agent / "pi-enhance-patches.json").write_text(json.dumps(patches, indent=2))
(root / "environment.json").write_text(json.dumps({"tuiMode": settings.get("tuiMode"), "timeoutMs": args.timeout_ms, "packages": versions}, indent=2))
version = (source / "install/current-version").read_text().strip()
assert version == "1.1.0", "Review host paths before testing another Pi version"
provider = pathlib.Path(__file__).with_name("local-pi-provider.ts").resolve()
command = ["env", f"PI_CODING_AGENT_DIR={agent}", f"PI_POC_LOG={root / 'events.jsonl'}",
           "PI_ENHANCE_BACKGROUND_AUTOPATCH=0", "PI_ENHANCE_SUBAGENT_AUTOPATCH=0",
           "PI_ENHANCE_INTERACTIVE_SHELL_AUTOPATCH=0",
           "PI_TUI_WRITE_LOG=" + str(root / "terminal.log"),
           str(source / "bin/pi"), "--provider", "local-poc", "--model", "deterministic", "-e", str(provider)]
print(json.dumps({"root": str(root), "cwd": str(cwd), "command": shlex.join(command), "tuiMode": settings.get("tuiMode"), "packageCount": len(packages), "timeoutMs": args.timeout_ms}, indent=2))
