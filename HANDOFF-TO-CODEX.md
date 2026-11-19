# Handoff: WhatsApp bot (from Claude Code to Codex, 30 Oct 2026)

You own this work now. Read this file, then `README.md`, `VERIFICATION.txt`, `src/` and `tools/`. Do not trust the claims below without checking the code.

## The owner's new request, verbatim

> just hand it over the whole thing with context to codex very high effort and model ok? also i expect the bot at start not sending anymessage until i test message in chat, locate that and find the chat id which is later used to be only receiving message from those channels groups or chats which reach the ai otherwise gated at the hard logic to save tokens.

## What that means (my reading; flag anything you read differently)

1. **Silent start.** Starting, reconnecting or restarting sends nothing to any chat. The first outbound message can only be an answer to something the owner typed in a chat that allows sending. Audit every send path: `router.js` replies, `moderator.js` warnings, `bot.js` setup test messages. The chooser currently offers "Send a test message to this chat now?", which is the bot messaging first, so remove that offer.
2. **Find the chat ID from a test message.** The owner types a test message in any chat from their own account. The bot locates that chat and records its ID, name and kind. It must work in chats not set up yet, so it needs one configured global phrase, since per-chat buzzwords don't exist there. Only an exact match from the owner's own account (`fromMe`) counts. It prints to the terminal (on the host that is `state/whatsapp.log`), saves to a local file under `data/`, and posts nothing in the chat. It must work under the unattended hosted worker, where there is no terminal to answer questions.
3. **That ID becomes the allowlist.** Discovered chats can then be enabled (chooser, config, or an owner-only flow you judge safest) and only enabled chats are received. A discovered chat must not become enabled by the test message alone unless you have a strong reason and say so.
4. **Hard gate before AI, to save tokens.** Everything is decided by plain code first (allowlist, buzzword, owner check, budgets). Only what passes may reach the AI. Build one chokepoint for AI calls so no path can bypass it, add a per-chat AI switch that defaults to off, and count blocked versus allowed calls so the owner can see the saving. Today the only AI call is the summary (`src/summarise.js`, reached from `commands.js` and `cli.js`).
5. **Do not build an AI auto-reply chatbot.** The owner said messages "reach the ai" but no such feature exists or was specified. Build the gate, and put the question "should allowed messages get automatic AI replies?" in your report.

Also reconsider `logOtherChats`: it prints the ID of every active unconfigured chat once. With discovery in place it should probably default to off, so unlisted chats are completely silent and cheap. Update the tests and the end-to-end run if you change it.

## Current state

- **Local bot:** this folder, not a git repo (the parent `.git` is broken). Node 26 locally, Node 22.23.4 on the host, so stay compatible with 22. It uses whatsapp-web.js 1.34.7, pinned. It merges the original spam detector with parts of whatsapp-reader (AGPL, see README credits).
- **Checks when handed over:** `node --test` 176 pass; `node tools/e2e/run.js` passes (simulated client, about a minute); `python -I tools/test_installer.py <this folder>` passes on Windows.
- **Never tested against real WhatsApp:** QR login, chat listing, receipt, sends, quoted messages, deletes, kicks, locks, join answers, ID resolution. No account has been linked. Say this plainly in anything you report.
- **Reviews:** three review rounds on spam deletion and two on admin commands. The last admin fixes (second lock replacing the timer, unlock retry, answers-only cap, spacing via `reserve`, withdrawn requests, marking order) are tested but were not re-reviewed by a fresh reader.
- **Design decisions to keep:**
  - Phrase rules only flag. Deletion acts only on owner-confirmed patterns (`!bot spam`, blocked domains, rules set to `"action": "delete"`), because reviewers found ordinary messages that any phrase rule would delete.
  - Owner commands are exact-match and `fromMe` only, and never post in the chat.
  - Pauses and budgets in `src/safety.js` persist across restarts; never weaken or reset them.
  - The bot never auto-reconnects after a block or logout.

## PythonAnywhere

- Account `EricH1425`. Always-on task `Bot1425 replacement 2026-08-13` runs `/home/EricH1425/shared-bot-task/supervisor.py run --config .../shared.json`, which runs the **Telegram bot** plus an optional WhatsApp worker (`node src/cli.js start`, private Node, Chrome 156, `SPAM_BOT_NO_SANDBOX=1`, `SPAM_BOT_UNATTENDED=1`, limits 1,536 MiB, 1,000 CPU-s/day, 5 MiB log). Local copy of the docs: `../shared-bot-task/`.
- Last recorded state (22 Oct): Telegram running; WhatsApp `waiting_for_arm`, unlinked, 0 groups, old version.
- The supervisor arms only if `groupIds` is non-empty and `.wwebjs_auth/session` exists. The running supervisor holds that check in memory, so `saveChats` keeps `groupIds` in step with chosen groups rather than changing the supervisor. Keep that property.
- **Upload status unknown.** The owner was given `../../work/whatsapp-spam-bot-update-20261029.zip` and a one-line install, and may or may not have run it. It installs through `tools/install_on_pythonanywhere.py`, tested only on a fake host; its npm step has never run. If you change code, build a new zip with `python -I tools/make_zip.py <this folder> <zip path>` under `../../work/`, with a new date in the name, and update the file name in the installer's docstring. A later install over an earlier one is fine.
- **This run cannot reach the host.** You are in Codex's workspace-write sandbox: you can write only to this folder and `../../work/`, with no network. Do not try to upload, install or reach PythonAnywhere, and do not try to escape the sandbox. Claude Code's permission check refused to start you with full access. The owner is logged in on Brave and will do the upload, so give them the exact steps: one file to upload and one line to paste.
- **Temp files:** if tests cannot write to the system temp folder under the sandbox, set `SPAM_BOT_TEST_TMP` to a new folder under `../../work/codex-handoff-20261030/` for that run, and make `tools/test_installer.py` use it too if needed. Leave no stray files in this project. `node_modules` is already installed.

## Limits on what you may do

Allowed: edit this project and build the zip.

Do not, without the owner saying so in that session:
- stop, restart or edit the always-on task, `supervisor.py`, `shared.json`, or anything in the Telegram bot;
- run `arm-whatsapp`, link WhatsApp, or send, delete or kick anything on WhatsApp;
- enter passwords, tokens or API keys, or print the QR code, session files or chat IDs into logs that leave the machine;
- commit, push, or publish anything; touch unrelated projects.

Machine notes: use `python`, not `python3`, locally. Pass `encoding="utf-8"` when opening text files, because the console default is cp950. Keep LF line endings.

## Done means

- New behaviour has tests, including: no send path fires on start; a test message in an unlisted chat records the ID and posts nothing; non-owners and near-miss phrases do nothing; unlisted or AI-off chats cannot reach the AI, shown by a test that fails if the gate is removed.
- `node --test`, `node tools/e2e/run.js` and `python -I tools/test_installer.py <this folder>` pass, with the end-to-end run extended to cover this flow. Paste the counts.
- `README.md` and `VERIFICATION.txt` match the code, and a new update zip is built.
- Final message: what changed, what ran and its results, what is still unverified, the zip path, whether the host was changed, the exact next steps for the owner, and any question for them. Keep it short and plain; the owner prefers concise.
