"""Install from an unpacked update zip in a PythonAnywhere Bash console:

    cd ~ && python3 -m zipfile -e whatsapp-spam-bot-update-20261110.zip wa-update-20261110 && python3 -B wa-update-20261110/whatsapp-spam-bot/tools/install_on_pythonanywhere.py

Only WhatsApp code/config is updated. No connection, arming, supervisor or Telegram changes.
Before anything goes live, a candidate copy runs the unit tests (node --test). The simulated end-to-end run
(tools/e2e/run.js: about 2 minutes more, mostly waiting) already passed before the zip was made; add --full to run it
here as well.
Use --undo <archive> to restore code/config without reverting live state or learned spam.
"""
import argparse
import copy
import hashlib
import json
import os
import shlex
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

PRESERVE = {"node_modules", ".wwebjs_auth", ".wwebjs_cache", ".browser-cache", ".runtime", "data", "logs", "hubs",
            ".git", "__pycache__", ".env"}
TIMEOUT = 600


def fail(message):
    print(f"STOPPED: {message}", flush=True)
    raise SystemExit(1)


def step(message):
    print(f"\n== {message}", flush=True)


def worker_state(root):
    status = root / "state" / "status.json"
    return json.loads(status.read_text(encoding="utf-8")).get("whatsapp") if status.exists() else None


def code_files(folder):
    return sorted(p for p in folder.rglob("*") if p.is_file() and
                  not PRESERVE.intersection(p.relative_to(folder).parts) and p.suffix != ".pyc")


def manifest_path(archive):
    return archive.with_name("whatsapp-spam-bot.manifest.json")


def back_up(target, backups, update_paths):
    folder = backups / f"{datetime.now(timezone.utc):%Y%m%d-%H%M%S-%f}-whatsapp-before-update"
    folder.mkdir(parents=True)
    archive = folder / "whatsapp-spam-bot.tar.gz"
    before = [p.relative_to(target).as_posix() for p in code_files(target)]
    with tarfile.open(archive, "w:gz") as tar:
        for name in before:
            tar.add(target / name, arcname=name, recursive=False)
    manifest = {"version": 1, "target": str(target), "before": before,
                "added": sorted(set(update_paths) - set(before)),
                "sha256": hashlib.sha256(archive.read_bytes()).hexdigest()}
    manifest_path(archive).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return archive


def safe_path(target, name):
    relative = PurePosixPath(name)
    if relative.is_absolute() or not relative.parts or any(p in ("..", ".") or ":" in p or "\\" in p for p in relative.parts) or PRESERVE.intersection(relative.parts):
        fail(f"unsafe undo path: {name}")
    result = target.joinpath(*relative.parts)
    if not result.resolve().is_relative_to(target):
        fail(f"undo path leaves the target: {name}")
    return result


def undo(target, archive):
    archive = archive.resolve()
    manifest = json.loads(manifest_path(archive).read_text(encoding="utf-8"))
    if manifest.get("version") != 1 or Path(manifest["target"]).resolve() != target:
        fail("undo manifest does not match this installed folder")
    if hashlib.sha256(archive.read_bytes()).hexdigest() != manifest["sha256"]:
        fail("backup archive checksum does not match its manifest")
    with tarfile.open(archive, "r:gz") as tar:
        members = tar.getmembers()
        if sorted(m.name for m in members) != sorted(manifest["before"]) or not all(m.isfile() for m in members):
            fail("backup must contain exactly the regular files in its manifest")
        # Validate every destination before changing anything. Never extract runtime state or links.
        restored = [(member, safe_path(target, member.name)) for member in members]
        added = [safe_path(target, name) for name in manifest["added"]]
        for destination in added:
            if destination.exists():
                if not destination.is_file():
                    fail(f"expected an added file: {destination}")
                destination.unlink()
            parent = destination.parent
            while parent != target:
                try:
                    parent.rmdir()  # only empty directories created by this update
                except OSError:
                    break
                parent = parent.parent
        for member, destination in restored:
            destination.parent.mkdir(parents=True, exist_ok=True)
            with tar.extractfile(member) as source, destination.open("wb") as output:
                shutil.copyfileobj(source, output)
            destination.chmod(member.mode)
    # Restored files take their old modes from the backup; keep the private ones owner-only. Always the installer's
    # own backups folder, never one derived from where the given archive happens to be.
    backups = target.parent.parent / "shared-bot-task-backups"
    report_lock_down(target, backups, lock_down(target, backups))
    print("UNDONE. Code/config restored; runtime, data, logs, sessions and node_modules untouched.")


PRIVATE_TREES = (".wwebjs_auth", "data", "logs", ".runtime", "hubs")
PRIVATE_FILES = (".env", "config.json")
MAX_ENTRIES = 200000


def lock_down(target, backups):
    """Owner-only access, as on a shared server: the bot folder, its private files and folders, and the update
    backups (they hold config). Removes group/other bits only. Symbolic links, hard-linked files (possibly the same
    file as one elsewhere) and other file systems are left alone. Returns (changed, failed, left_alone)."""
    changed, failed, left_alone = [], [], []
    if os.name == "nt":  # Windows uses ACLs; chmod only toggles read-only there.
        return changed, failed, left_alone
    device = []
    seen = [0]

    def tighten(path, named=False):
        try:
            info = os.lstat(path)
        except FileNotFoundError:
            return None
        except OSError as error:
            failed.append((path, str(error)))
            return None
        foreign = (device and info.st_dev != device[0]) or (stat.S_ISREG(info.st_mode) and info.st_nlink > 1)
        if stat.S_ISLNK(info.st_mode) or foreign:
            if named or foreign:
                left_alone.append(path)
            return None
        if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
            return None
        mode = stat.S_IMODE(info.st_mode)
        if mode & ~0o700:
            try:
                os.chmod(path, mode & 0o700)
                changed.append((path, mode, mode & 0o700))
            except OSError as error:
                failed.append((path, str(error)))
        return info

    def tree(top):
        stack = [top]
        while stack:
            current = stack.pop()
            seen[0] += 1
            if seen[0] > MAX_ENTRIES:
                failed.append((current, f"stopped after {MAX_ENTRIES} items"))
                return
            info = tighten(current, named=current == top)
            if info is None or not stat.S_ISDIR(info.st_mode):
                continue
            try:
                stack.extend(Path(current) / name for name in os.listdir(current))
            except OSError as error:
                failed.append((current, str(error)))

    root_info = tighten(target, named=True)
    if root_info is None:
        return changed, failed, left_alone
    device.append(root_info.st_dev)
    for name in PRIVATE_TREES:
        tree(target / name)
    for name in PRIVATE_FILES:
        tighten(target / name, named=True)
    tree(backups)
    return changed, failed, left_alone


def report_lock_down(target, backups, result):
    changed, failed, left_alone = result
    if os.name == "nt":
        print("Skipped: Windows controls access with ACLs.")
        return
    top = {Path(target), Path(backups)} | {Path(target) / name for name in PRIVATE_TREES + PRIVATE_FILES}
    for path, before, after in changed:
        if Path(path) in top:
            print(f"  {oct(before)[2:]} -> {oct(after)[2:]}  {path}")
    print(f"{len(changed)} item(s) made owner-only." if changed else "Already owner-only.")
    for path in left_alone[:5]:
        print(f"NOTE: left as it is (a link, a hard link or another drive, so possibly not ours): {path}")
    for path, error in failed[:5]:
        print(f"WARNING: could not make {path} owner-only: {error}")


def carry_settings(old, new):
    """Deep merge owner values over defaults; lists replace, strictRules merge by name."""
    def merge(defaults, owner):
        if isinstance(defaults, dict) and isinstance(owner, dict):
            result = copy.deepcopy(defaults)
            for key, value in owner.items():
                result[key] = merge(result[key], value) if key in result else copy.deepcopy(value)
            return result
        return copy.deepcopy(owner)
    result = merge(new, old)
    if isinstance(old.get("strictRules", []), list) and isinstance(new.get("strictRules", []), list):
        rules = {rule["name"]: copy.deepcopy(rule) for rule in new.get("strictRules", [])}
        for rule in old.get("strictRules", []):
            rules[rule["name"]] = merge(rules.get(rule["name"], {}), rule)
        result["strictRules"] = list(rules.values())
    if "mode" not in old.get("deletion", {}):
        result.setdefault("deletion", {})["mode"] = "strict"
    # Migrate mirrors created by earlier choosers, so later hand removal cannot escalate to legacy policy.
    if "managedGroupIds" not in old:
        result["managedGroupIds"] = [chat["id"] for chat in old.get("chats", []) if chat["id"] in old.get("groupIds", [])]
    return result


def run(command, cwd, env):
    result = subprocess.run(command, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            encoding="utf-8", errors="replace", timeout=TIMEOUT)
    return result.returncode, result.stdout


@contextmanager
def candidate_copy(source, target, directory):
    with tempfile.TemporaryDirectory(prefix="candidate-", dir=directory) as folder:
        candidate = Path(folder)
        for path in code_files(source):
            destination = candidate / path.relative_to(source)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, destination)
        modules = candidate / "node_modules"
        try:
            if os.name == "nt":
                subprocess.run(["cmd", "/c", "mklink", "/J", str(modules), str(target / "node_modules")],
                               check=True, stdout=subprocess.DEVNULL)
            else:
                modules.symlink_to(target / "node_modules", target_is_directory=True)
            yield candidate
        finally:
            if modules.is_symlink():
                modules.unlink()
            elif modules.exists():
                modules.rmdir()  # junction only, never traverse the installed dependencies


def next_steps(root, target, node_bin, phrase):
    shared = root / "shared.json"
    chrome = ""
    if shared.exists():
        try:
            chrome = json.loads(shared.read_text(encoding="utf-8-sig")).get("whatsapp", {}).get("env", {}).get("CHROME_PATH", "")
        except (OSError, ValueError, AttributeError):
            print("Could not read CHROME_PATH from shared.json; set it explicitly for the console commands.")
    chrome = chrome or os.environ.get("CHROME_PATH", "")
    if not chrome:
        print("Set CHROME_PATH to the installed Chrome executable before these commands.")
    chrome_assignment = f"CHROME_PATH={shlex.quote(chrome)}" if chrome else 'CHROME_PATH="$CHROME_PATH"'
    prefix = f"env -u SPAM_BOT_UNATTENDED {chrome_assignment} SPAM_BOT_NO_SANDBOX=1 {shlex.quote(str(node_bin / 'node'))} src/cli.js"
    print("\nNext steps, in order, in a PythonAnywhere Bash console while the worker is idle:")
    print(f"1. cd {shlex.quote(str(target))} && {prefix} start")
    print(f'   Scan the QR; type exactly "{phrase}" in each chat; read [DISCOVERED] here; press Ctrl+C.')
    print(f"2. cd {shlex.quote(str(target))} && {prefix} choose")
    print("   Choose chats, including at least one group. Direct-only setups cannot arm under this supervisor.")
    print(f"3. cd {shlex.quote(str(root))} && python3 -B supervisor.py arm-whatsapp --reviewed")


NPM_CLI = Path("lib") / "node_modules" / "npm" / "bin" / "npm-cli.js"


def npm_command(node, node_bin):
    """npm as a command list. A Node unpacked without its symlinks has no bin/npm, but npm itself is still in lib."""
    npm = shutil.which("npm", path=str(node_bin))
    if npm:
        return [npm]
    cli = Path(node_bin).parent / NPM_CLI
    return [node, str(cli)] if cli.is_file() else None


def dependency_mismatches(target):
    """Direct dependencies whose installed version differs from package-lock.json, as (name, installed, locked)."""
    lock = json.loads((target / "package-lock.json").read_text(encoding="utf-8-sig")).get("packages", {})
    wanted = json.loads((target / "package.json").read_text(encoding="utf-8-sig")).get("dependencies", {})
    found = []
    for name in sorted(wanted):
        locked = lock.get(f"node_modules/{name}", {}).get("version")
        manifest = target / "node_modules" / name / "package.json"
        installed = json.loads(manifest.read_text(encoding="utf-8-sig")).get("version") if manifest.is_file() else None
        if installed != locked:
            found.append((name, installed, locked))
    return found


def removable_module(target, name):
    """The installed folder for one dependency, only when it really sits inside this target's own node_modules."""
    modules = target / "node_modules"
    folder = modules / name
    if modules.is_symlink() or not folder.is_dir() or folder.is_symlink():
        return None
    real_modules, real_folder = modules.resolve(), folder.resolve()
    if real_modules.parent != target.resolve() or real_modules not in real_folder.parents:
        return None
    return folder


def main():
    sys.stdout.reconfigure(errors="replace")
    os.umask(0o077)  # backups, copied files and npm's downloads are created owner-only
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.home() / "shared-bot-task")
    parser.add_argument("--node-bin", type=Path, help="default: <root>/node/bin")
    parser.add_argument("--skip-npm", action="store_true", help="for offline testing")
    parser.add_argument("--full", action="store_true",
                        help="also run the simulated end-to-end check (tools/e2e/run.js) on the candidate")
    parser.add_argument("--undo", type=Path, help="restore a backup and remove added files using its adjacent manifest")
    args = parser.parse_args()
    source = Path(__file__).resolve().parents[1]
    root = args.root.resolve()
    target = root / "whatsapp-spam-bot"
    node_bin = (args.node_bin or root / "node" / "bin").resolve()
    step("Checking the host")
    if not target.is_dir():
        fail(f"{target} does not exist.")
    state = worker_state(root)
    if state == "running":
        fail("the WhatsApp worker is running. Run: cd ~/shared-bot-task && python3 -B supervisor.py stop-whatsapp, wait, then try again.")
    if (target / ".runtime" / "instance.lock").exists():
        fail("a bot instance lock exists; stop the process or follow README's reviewed stale-lock recovery")
    if args.undo:
        undo(target, args.undo)
        return 0
    if source == target:
        fail("run this from the unpacked update, not from the installed folder.")
    node = shutil.which("node", path=str(node_bin))
    if not node:
        fail(f"no node found in {node_bin}.")
    old_config = json.loads((target / "config.json").read_text(encoding="utf-8-sig"))
    defaults = json.loads((source / "config.json").read_text(encoding="utf-8-sig"))
    merged = carry_settings(old_config, defaults)
    files = code_files(source)
    step("Backing up code and config only")
    archive = back_up(target, root.parent / "shared-bot-task-backups", [p.relative_to(source).as_posix() for p in files])
    rollback = shlex.join(["python3", "-B", str(Path(__file__).resolve()), "--root", str(root), "--undo", str(archive)])
    print(f"Backup: {archive}\nTo undo: {rollback}")
    step("Copying code; keeping live config unchanged until every check passes")
    for path in files:
        if path.relative_to(source).as_posix() == "config.json":
            continue
        destination = target / path.relative_to(source)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, destination)
    env = {**os.environ, "PATH": f"{node_bin}{os.pathsep}{os.environ.get('PATH', '')}"}
    env.pop("SPAM_BOT_CONFIG", None)
    if not args.skip_npm:
        step("Installing locked dependencies without scripts or browser downloads")
        npm = npm_command(node, node_bin)
        if not npm:
            fail(f"no npm found in {node_bin} or {node_bin.parent / NPM_CLI}. To undo: {rollback}")
        code, output = run([*npm, "install", "--ignore-scripts", "--no-audit", "--no-fund"], target, env)
        print(output[-1500:])
        if code:
            fail(f"npm install failed; live config unchanged. To undo: {rollback}")
        stale = dependency_mismatches(target)
        if stale:
            # npm can call a package "up to date" when only where it comes from changed; reinstall just those.
            step("Replacing outdated dependencies: " + ", ".join(f"{n} {i or 'missing'} -> {l}" for n, i, l in stale))
            removed = []
            for name, _, _ in stale:
                folder = removable_module(target, name)
                if folder:
                    shutil.rmtree(folder)
                    removed.append(name)
            code, output = run([*npm, "install", "--ignore-scripts", "--no-audit", "--no-fund"], target, env)
            print(output[-1500:])
            if code:
                # Undo restores code/config only, so a removed package must come back from a rerun first.
                gone = f" Removed {', '.join(removed)} from node_modules: run this installer again before starting or undoing." if removed else ""
                fail(f"npm install failed; live config unchanged.{gone} To undo: {rollback}")
    stale = dependency_mismatches(target)
    if stale:
        found = ", ".join(f"{n} {i or 'missing'} (needs {l})" for n, i, l in stale)
        hint = "run the installer again without --skip-npm" if args.skip_npm else "npm did not install the locked versions"
        fail(f"installed dependencies do not match this update: {found}; {hint}. Live config unchanged. To undo: {rollback}")
    # Run the tests in a disposable copy with SHIPPED defaults, never the owner's config/state.
    checks = [[node, "--test"]] + ([[node, "tools/e2e/run.js"]] if args.full else [])
    with candidate_copy(source, target, archive.parent) as candidate:
        for command in checks:
            step("Checking candidate: " + " ".join(command[1:]))
            code, output = run(command, candidate, env)
            print("\n".join(output.splitlines()[-12:]))
            if code:
                fail(f"candidate checks failed; live config unchanged. To undo: {rollback}")
        if not args.full:
            print("Skipped the simulated end-to-end run (tools/e2e/run.js), which passed before this zip was made; "
                  "add --full to the install command to run it here too.", flush=True)
        (candidate / "config.json").write_text(json.dumps(merged, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        code, output = run([node, "src/cli.js", "status"], candidate, env)
        if code:
            print(output[-1500:])
            fail(f"merged config did not load; live config unchanged. To undo: {rollback}")
    step("Saving merged owner settings atomically")
    temporary = target / f"config.json.{os.getpid()}.tmp"
    try:
        temporary.write_text(json.dumps(merged, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        temporary.replace(target / "config.json")
    finally:
        temporary.unlink(missing_ok=True)
    step("Making private files owner-only (before -> after)")
    backups = root.parent / "shared-bot-task-backups"
    report_lock_down(target, backups, lock_down(target, backups))
    print(f"\nINSTALLED. Worker state unchanged: {state}. Telegram and supervisor untouched.")
    print(f"To undo: {rollback}")
    next_steps(root, target, node_bin, merged["discoveryPhrase"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
