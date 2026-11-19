"""Offline installer/undo regression tests. Usage: python -I tools/test_installer.py <project>"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
project = Path(sys.argv[1]).resolve()
node_bin = Path(shutil.which("node")).parent
temp_root = Path(os.environ.get("SPAM_BOT_TEST_TMP", tempfile.gettempdir())).resolve()
temp_root.mkdir(parents=True, exist_ok=True)
work = Path(tempfile.mkdtemp(prefix="wa-inst-", dir=temp_root)).resolve()
scenarios = 0


def passed(message):
    global scenarios
    scenarios += 1
    print("PASS " + message, flush=True)


try:
    zip_path = work / "update.zip"
    subprocess.run([sys.executable, "-I", str(project / "tools" / "make_zip.py"), str(project), str(zip_path)],
                   check=True, stdout=subprocess.DEVNULL)
    with zipfile.ZipFile(zip_path) as archive:
        archive.extractall(work / "wa-update")
    source = work / "wa-update" / "whatsapp-spam-bot"
    installer = source / "tools" / "install_on_pythonanywhere.py"
    spec = importlib.util.spec_from_file_location("installer", installer)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    # Generic deep merge, list replacement, rules by name, new defaults, strict migration.
    defaults = {"threshold": 5, "keywords": ["new"], "nested": {"new": 1, "keep": 2},
                "strictRules": [{"name": "existing", "action": "flag", "needsLink": True}, {"name": "new", "anyOf": ["new"]}],
                "deletion": {"mode": "score"}}
    owner = {"threshold": 9, "keywords": ["mine"], "nested": {"keep": 7},
             "strictRules": [{"name": "existing", "action": "delete"}, {"name": "custom", "anyOf": ["mine"]}]}
    merged = module.carry_settings(owner, defaults)
    assert merged["nested"] == {"new": 1, "keep": 7} and merged["keywords"] == ["mine"]
    assert merged["threshold"] == 9 and merged["deletion"]["mode"] == "strict"
    assert merged["strictRules"][0] == {"name": "existing", "action": "delete", "needsLink": True}
    assert [r["name"] for r in merged["strictRules"]] == ["existing", "new", "custom"]
    assert defaults["threshold"] == 5 and owner["nested"] == {"keep": 7}
    passed("deep merge retains owner values and whole lists; strict rules merge by name; missing mode becomes strict")

    # npm may keep an old package of the same name; the installer compares installed versions with the lockfile.
    deps = work / "deps"
    (deps / "node_modules" / "whatsapp-web.js").mkdir(parents=True)
    (deps / "node_modules" / "@scope" / "pkg").mkdir(parents=True)
    (deps / "package.json").write_text(json.dumps({"dependencies": {"whatsapp-web.js": "file:vendor/w.tgz", "@scope/pkg": "1.0.0",
                                                                    "absent": "2.0.0"}}), encoding="utf-8")
    (deps / "package-lock.json").write_text(json.dumps({"packages": {
        "node_modules/whatsapp-web.js": {"version": "1.34.7-main.064a3d5"}, "node_modules/@scope/pkg": {"version": "1.0.0"},
        "node_modules/absent": {"version": "2.0.0"}}}), encoding="utf-8")
    (deps / "node_modules" / "whatsapp-web.js" / "package.json").write_text('{"version": "1.34.7"}', encoding="utf-8")
    (deps / "node_modules" / "@scope" / "pkg" / "package.json").write_text('{"version": "1.0.0"}', encoding="utf-8")
    assert module.dependency_mismatches(deps) == [("absent", None, "2.0.0"), ("whatsapp-web.js", "1.34.7", "1.34.7-main.064a3d5")]
    assert module.removable_module(deps, "whatsapp-web.js") == deps / "node_modules" / "whatsapp-web.js"
    assert module.removable_module(deps, "@scope/pkg") == deps / "node_modules" / "@scope" / "pkg"
    assert module.removable_module(deps, "absent") is None
    linked = work / "linked"
    linked.mkdir()
    shutil.copy2(deps / "package.json", linked / "package.json")
    if os.name == "nt":
        subprocess.run(["cmd", "/c", "mklink", "/J", str(linked / "node_modules"), str(deps / "node_modules")],
                       check=True, stdout=subprocess.DEVNULL)
    else:
        (linked / "node_modules").symlink_to(deps / "node_modules", target_is_directory=True)
    assert module.removable_module(linked, "whatsapp-web.js") is None, "must never delete through a linked node_modules"
    passed("finds dependencies whose installed version differs from the lockfile; removes only real, local package folders")

    root = work / "home" / "shared-bot-task"
    target = root / "whatsapp-spam-bot"
    (target / "src").mkdir(parents=True)
    (target / "src" / "bot.js").write_text("old code", encoding="utf-8")
    protected = [".runtime/safety.json", "data/learned-spam.json", "logs/keep.log", ".wwebjs_auth/session/keep.txt",
                 "node_modules/keep.txt", ".env", "hubs/class/slides.pdf"]
    for name in protected:
        if name.startswith("node_modules/"):
            continue
        path = target / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("original " + name, encoding="utf-8")
    # Dependencies remain outside backup/undo and are shared only for these local tests.
    if os.name == "nt":
        subprocess.run(["cmd", "/c", "mklink", "/J", str(target / "node_modules"), str(project / "node_modules")],
                       check=True, stdout=subprocess.DEVNULL)
    else:
        (target / "node_modules").symlink_to(project / "node_modules", target_is_directory=True)
    old = json.loads((project / "config.json").read_text(encoding="utf-8"))
    old.pop("managedGroupIds", None)
    old["groupIds"] = ["120363000000000001@g.us"]
    old["trustedSenderIds"] = ["alice@lid"]
    old["links"]["blockedDomains"] = ["bad.example"]
    old["links"]["shortenerDomains"] = ["short.example"]
    old["discoveryPhrase"] = "my exact discovery phrase"
    old["chats"] = [{"id": "120363000000000001@g.us", "receive": True, "ai": True}]
    old["summary"]["maxPerHour"] = 1
    old["summary"]["maxPerDay"] = 2
    old["summary"].pop("maxTranscriptChars", None)
    old["threshold"] = 7
    old["deletion"]["threshold"] = 8
    old["deletion"].pop("mode", None)
    old["keywords"] = [{"phrase": "owner-only keyword", "score": 8}]
    old["replyPrefix"] = "OWNERBOT"
    old["strictRules"] = [{"name": old["strictRules"][0]["name"], "action": "delete", "anyOf": ["owner pattern"]}]
    config_file = target / "config.json"
    config_file.write_text(json.dumps(old, indent=1) + "\n", encoding="utf-8", newline="\n")
    config_before = config_file.read_bytes()
    (root / "state").mkdir()
    status = root / "state" / "status.json"
    shared = root / "shared.json"
    shared.write_text(json.dumps({"whatsapp": {"env": {"CHROME_PATH": "/home/test/Chrome with spaces/chrome"}}}), encoding="utf-8")
    shared_before = shared.read_bytes()
    safety_file = target / ".runtime" / "safety.json"
    safety = {"connectionPause": {"time": 1, "reason": "TOS_BLOCK"}, "warningPause": None,
              "warningAttempts": [], "aiAttempts": [{"time": 2, "chat": "hashed"}],
              "aiStats": {"allowed": 1, "blocked": 3, "reasons": {"ai_off": 3}}}
    safety_file.write_text(json.dumps(safety), encoding="utf-8")
    safety_before = safety_file.read_bytes()
    session_before = (target / ".wwebjs_auth" / "session" / "keep.txt").read_bytes()
    modules_before = (project / "node_modules" / ".package-lock.json").read_bytes()
    modules_mode_before = os.stat(project / "node_modules").st_mode

    def install(*extra):
        return subprocess.run([sys.executable, "-B", str(installer), "--root", str(root), "--node-bin", str(node_bin),
                               "--skip-npm", *extra], capture_output=True, encoding="utf-8", errors="replace",
                              env={**os.environ, "PYTHONIOENCODING": "utf-8"}, timeout=900)

    status.write_text(json.dumps({"telegram": "running", "whatsapp": "running"}), encoding="utf-8")
    r = install()
    assert r.returncode == 1 and "worker is running" in r.stdout, r.stdout + r.stderr
    assert config_file.read_bytes() == config_before and (target / "src" / "bot.js").read_text() == "old code"
    assert not (root.parent / "shared-bot-task-backups").exists()
    passed("refuses a running worker without changing files")

    status.write_text(json.dumps({"telegram": "running", "whatsapp": "waiting_for_arm"}), encoding="utf-8")
    status_before = status.read_bytes()
    (target / ".runtime" / "instance.lock").write_text("{}", encoding="utf-8")
    r = install()
    assert r.returncode == 1 and "instance lock" in r.stdout, r.stdout + r.stderr
    (target / ".runtime" / "instance.lock").unlink()
    passed("refuses an instance lock")

    # Fail the actual Node checks twice; live config must stay byte-identical across retries.
    test_file = source / "test" / "router.test.js"
    test_before = test_file.read_bytes()
    test_file.write_text("require('node:assert').fail('installer regression fixture');\n", encoding="utf-8")
    for attempt in range(2):
        r = install()
        assert r.returncode == 1 and "candidate checks failed" in r.stdout and "INSTALLED" not in r.stdout, r.stdout + r.stderr
        assert config_file.read_bytes() == config_before, "failed rerun overwrote the owner's live config"
        assert safety_file.read_bytes() == safety_before
    test_file.write_bytes(test_before)
    passed("two actual failed installs keep config and safety state byte-identical")

    # --full adds the end-to-end run after the unit tests. A failing end-to-end fixture stops it with live config
    # unchanged. The fixture stays in place until the final default install, which must not run it.
    e2e_file = source / "tools" / "e2e" / "run.js"
    e2e_before = e2e_file.read_bytes()
    e2e_file.write_text("console.log('installer e2e fixture'); process.exit(3);\n", encoding="utf-8")
    r = install("--full")
    assert r.returncode == 1 and "Checking candidate: --test" in r.stdout, r.stdout + r.stderr
    assert "Checking candidate: tools/e2e/run.js" in r.stdout and "installer e2e fixture" in r.stdout, r.stdout + r.stderr
    assert "candidate checks failed" in r.stdout and "INSTALLED" not in r.stdout and "Skipped the simulated" not in r.stdout
    assert config_file.read_bytes() == config_before and safety_file.read_bytes() == safety_before
    passed("--full also runs the end-to-end check after the unit tests; its failure stops the install, config unchanged")

    # Check backups and undo BEFORE a successful retry: restore old code and remove added files for real.
    backups = sorted((root.parent / "shared-bot-task-backups").rglob("*.tar.gz"))
    first = backups[0]
    with tarfile.open(first) as tar:
        names = tar.getnames()
        assert sorted(names) == ["config.json", "src/bot.js"], names
        assert tar.extractfile("src/bot.js").read() == b"old code"
    assert module.manifest_path(first).is_file()
    # State learned after backup must survive undo (not merely the original bytes).
    (target / "data" / "learned-spam.json").write_text("new learned spam after backup", encoding="utf-8")
    (target / "logs" / "keep.log").write_text("new log after backup", encoding="utf-8")
    # Undo from a copy of the backup somewhere else: its lockdown must still touch only the installer's own folders.
    elsewhere = work / "home" / "elsewhere" / "a"
    elsewhere.mkdir(parents=True)
    shutil.copy2(first, elsewhere / first.name)
    shutil.copy2(module.manifest_path(first), elsewhere / module.manifest_path(first).name)
    sibling = work / "home" / "sibling.txt"
    sibling.write_text("someone else's", encoding="utf-8")
    if os.name != "nt":
        os.chmod(sibling, 0o644)
        os.chmod(work / "home" / "elsewhere", 0o755)
    r = install("--undo", str(elsewhere / first.name))
    assert r.returncode == 0 and "UNDONE" in r.stdout, r.stdout + r.stderr
    if os.name != "nt":
        assert oct(os.stat(sibling).st_mode & 0o777) == "0o644", "undo locked down a folder outside the installer's own"
        assert oct(os.stat(work / "home" / "elsewhere").st_mode & 0o777) == "0o755"
    assert config_file.read_bytes() == config_before
    assert (target / "src" / "bot.js").read_text() == "old code"
    assert not (target / "src" / "discovery.js").exists() and not (target / "tools").exists()
    assert sorted(p.relative_to(target).as_posix() for p in module.code_files(target)) == ["config.json", "src/bot.js"]
    assert safety_file.read_bytes() == safety_before
    assert (target / "data" / "learned-spam.json").read_text() == "new learned spam after backup"
    assert (target / "logs" / "keep.log").read_text() == "new log after backup"
    assert (target / ".wwebjs_auth" / "session" / "keep.txt").read_bytes() == session_before
    assert (target / "hubs" / "class" / "slides.pdf").read_text() == "original hubs/class/slides.pdf", "undo touched a chat's files"
    assert (project / "node_modules" / ".package-lock.json").read_bytes() == modules_before
    passed("real --undo restores only code/config, removes added files, keeps current safety/data/logs/session/dependencies")

    # A malformed merged config also leaves the live config unchanged. Run just the merge-check path locally.
    original_run = module.run
    def merge_failure(command, cwd, env):
        return (1, "synthetic merged config rejection") if command[-1] == "status" else (0, "fixture checks passed")
    module.run = merge_failure
    argv_before = sys.argv
    umask_before = os.umask(0o022)
    sys.argv = [str(installer), "--root", str(root), "--node-bin", str(node_bin), "--skip-npm"]
    try:
        try:
            module.main()
            raise AssertionError("expected merged config check to fail")
        except SystemExit as error:
            assert error.code == 1
        assert config_file.read_bytes() == config_before
    finally:
        module.run = original_run
        sys.argv = argv_before
        os.umask(umask_before)  # main() sets 077 for its own process; this test process keeps its own
    passed("failed merged-config validation leaves live config unchanged")

    # Before the final install: things outside the bot folder reached through links, and private files loosened
    # again, so the install's own lockdown has real work and must leave the outside alone.
    outside = work / "outside"
    (outside / "dir").mkdir(parents=True)
    for name in ("shared.txt", "hard.txt"):
        (outside / name).write_text("not ours", encoding="utf-8")
    if os.name != "nt":
        os.chmod(outside / "dir", 0o755)
        for name in ("shared.txt", "hard.txt"):
            os.chmod(outside / name, 0o644)
        os.symlink(outside / "shared.txt", target / "data" / "link-file")
        os.symlink(outside / "dir", target / "data" / "link-dir")
        os.link(outside / "hard.txt", target / "data" / "hard.txt")
        for path in (target, target / "data", target / ".wwebjs_auth", target / ".wwebjs_auth" / "session"):
            os.chmod(path, 0o755)
        for path in (config_file, target / ".env", target / "data" / "learned-spam.json", target / ".wwebjs_auth" / "session" / "keep.txt"):
            os.chmod(path, 0o644)

    # The successful default install runs the real unit tests against shipped config, not the owner's custom settings.
    # The failing end-to-end fixture is still in place, so this passes only if the default really skips that run.
    r = install()
    e2e_file.write_bytes(e2e_before)
    print(r.stdout[-2500:], flush=True)
    assert r.returncode == 0 and "INSTALLED" in r.stdout, r.stdout + r.stderr
    assert "Checking candidate: --test" in r.stdout and "Checking candidate: tools/e2e/run.js" not in r.stdout, r.stdout
    assert "Skipped the simulated end-to-end run" in r.stdout and "add --full" in r.stdout, r.stdout
    new = json.loads(config_file.read_text(encoding="utf-8"))
    for key in ("groupIds", "trustedSenderIds", "chats", "threshold", "keywords", "replyPrefix", "discoveryPhrase"):
        assert new[key] == old[key], (key, new[key], old[key])
    assert new["links"]["blockedDomains"] == ["bad.example"]
    assert new["links"]["shortenerDomains"] == ["short.example"]
    assert new["summary"]["maxPerHour"] == 1 and new["summary"]["maxPerDay"] == 2
    assert new["summary"]["maxTranscriptChars"] == 60000
    assert new["deletion"]["mode"] == "strict"
    assert new["managedGroupIds"] == old["groupIds"]
    assert new["strictRules"][0]["action"] == "delete" and len(new["strictRules"]) > 1
    assert safety_file.read_bytes() == safety_before
    assert status.read_bytes() == status_before and shared.read_bytes() == shared_before
    assert (target / ".wwebjs_auth" / "session" / "keep.txt").read_bytes() == session_before
    passed("successful default retry runs isolated real unit tests and skips the end-to-end run (says to use --full), "
           "preserves owner settings and safety, adds new defaults/rules")

    lines = r.stdout.splitlines()
    start = next(i for i, line in enumerate(lines) if line.startswith("1. cd "))
    choose = next(i for i, line in enumerate(lines) if line.startswith("2. cd "))
    arm = next(i for i, line in enumerate(lines) if line.startswith("3. cd "))
    assert start < choose < arm
    for index, command in [(start, "start"), (choose, "choose")]:
        assert "SPAM_BOT_NO_SANDBOX=1" in lines[index] and "-u SPAM_BOT_UNATTENDED" in lines[index]
        assert "CHROME_PATH='/home/test/Chrome with spaces/chrome'" in lines[index]
        assert str(node_bin / "node") in lines[index] and lines[index].endswith("src/cli.js " + command)
    assert "python3 -B supervisor.py arm-whatsapp --reviewed" in lines[arm]
    assert "Direct-only setups cannot arm" in r.stdout and "--undo" in r.stdout
    passed("final instructions use private Node and shared CHROME_PATH: start, choose at least one group, arm; print --undo")

    # Owner-only access, as on a shared server. The protected files above were created readable by everyone.
    if os.name != "nt":
        def mode(path):
            return oct(os.stat(path).st_mode & 0o777)[2:]
        assert mode(target) == "700", mode(target)
        for name in [".wwebjs_auth", ".wwebjs_auth/session", "data", "logs", ".runtime", "hubs", "hubs/class"]:
            assert mode(target / name) == "700", (name, mode(target / name))
        for name in [".wwebjs_auth/session/keep.txt", "data/learned-spam.json", "logs/keep.log", ".runtime/safety.json", ".env", "config.json",
                     "hubs/class/slides.pdf"]:
            assert mode(target / name) == "600", (name, mode(target / name))
        backups_dir = root.parent / "shared-bot-task-backups"
        assert mode(backups_dir) == "700"
        loose = [p for p in backups_dir.rglob("*") if os.stat(p).st_mode & 0o077]
        assert not loose, loose
        assert os.stat(project / "node_modules").st_mode == modules_mode_before, "followed the node_modules link"
        assert "Making private files owner-only" in r.stdout and "made owner-only" in r.stdout, r.stdout[-3000:]
        for name, wanted in (("shared.txt", "644"), ("hard.txt", "644"), ("dir", "755")):
            assert mode(outside / name) == wanted, (name, mode(outside / name), "a link or hard link was followed out")
        assert "left as it is" in r.stdout and "hard.txt" in r.stdout, r.stdout[-3000:]
        passed("bot folder, private files and backups are owner-only after install; links, hard links and the linked node_modules lead nowhere")
    else:
        print("SKIP owner-only permissions: Windows controls access with ACLs", flush=True)
    print(f"INSTALLER PASS: {scenarios} scenarios (npm skipped; fake host only)", flush=True)
finally:
    if work.parent != temp_root or not work.name.startswith("wa-inst-"):
        raise RuntimeError("Unsafe installer-test cleanup path")
    junction = work / "home" / "shared-bot-task" / "whatsapp-spam-bot" / "node_modules"
    if junction.is_symlink():
        junction.unlink()
    elif junction.exists():
        os.rmdir(junction)
    shutil.rmtree(work, ignore_errors=True)
