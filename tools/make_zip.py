"""Zip the bot for upload: code, tests, tools, config and docs; never node_modules, sessions, data or logs.

Usage: python -I make_zip.py <project dir> <output zip>
Entries use forward slashes (Linux unzip) and sit under whatsapp-spam-bot/.
"""
import hashlib
import sys
import zipfile
from pathlib import Path

project = Path(sys.argv[1])
output = Path(sys.argv[2])
# vendor/ holds whatsapp-web.js built from upstream main: npm's 1.34.7 cannot read messages since WhatsApp Web's July 2026 update.
INCLUDE_DIRS = ["src", "test", "tools", "vendor"]
INCLUDE_FILES = ["config.json", "package.json", "package-lock.json", "README.md", "COMMANDS.md", "VERIFICATION.txt", "RESEARCH.md",
                 "PYTHONANYWHERE_CHECK.md", "LICENSE-AGPL-3.0.txt", ".env.example", ".gitignore", ".puppeteerrc.cjs",
                 "SETUP.cmd", "START.cmd", "TRY-DEMO.cmd", "CHOOSE-CHATS.cmd"]

entries = []
for name in INCLUDE_FILES:
    entries.append(project / name)
for folder in INCLUDE_DIRS:
    entries.extend(sorted(p for p in (project / folder).rglob("*") if p.is_file() and "__pycache__" not in p.parts and p.suffix != ".pyc"))

with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for path in entries:
        relative = path.relative_to(project).as_posix()
        archive.write(path, f"whatsapp-spam-bot/{relative}")

digest = hashlib.sha256(output.read_bytes()).hexdigest()
print(f"{output} {output.stat().st_size} bytes, {len(entries)} files, sha256 {digest}")
