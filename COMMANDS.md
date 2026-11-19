# Bot commands

This list was checked against the bot's own help output for update **20261107b**. `!bot instructions`, `!bot ask+`, `!bot effort` and `!bot github` are new since 20261106a; the ideas board (`!bot idea`, `ideas`, `findings`) is new in 20261106f, and `!bot github issue N` for a spotted request in 20261107a. **New in 20261107b:** GitHub changes (comments, closing, merging, files, reverts), Google Docs, Sheets and Slides, AI drafts, and confirm codes.

## How a command works
- Start the message with the chat's buzzword (`!bot` in your chats), then the command: `!bot ping`.
- **Who can call it** is set per chat in `choose`: anyone, or only you. Commands marked "you only" below work only from your own account, whatever that setting says.
- After every bot start, a chat stays silent until you have used a command there yourself. Members' commands work after that.
- The bot's replies start with 🤖. In a chat with send off, nothing is ever posted, and the reply only shows in the server's log.

## Assistant in opted-in chats

After your first `!bot ping` on each start, a chat with `assistant: true` can use `@bot <question>`, reply to a bot post, or ask `What issues are open?` about the linked repo. See [Optional chat assistant](README.md#optional-chat-assistant) for AI and GitHub permissions.

With `githubAutoIssues: true` and a linked private repo, the bot can open an issue from a clear new task. From your linked WhatsApp account, send `Issue #21 done`, `Issue #21 reopen` or `Issue #21 progress: Tested the fix` to update that issue.

## Commands anyone allowed in the chat can use
| Command | What it does |
|---|---|
| `!bot ping` (also `id`, `test`) | Shows the chat's ID and what the bot may do there |
| `!bot help` | The command list. Members don't see the you-only commands. |
| `!bot check <text>` | Scores a message against the spam rules, without deleting anything |
| `!bot files` | Lists this chat's shared files (chats with a folder) |
| `!bot send <name>` | Posts one of those files here, up to 25 MB. Part of the name is enough. |
| `!bot remind <when> <what>` | Posts "Reminder N: what" here at that time, London time. Members can't put links in reminders. |
| `!bot issue <what>` (also `todo`) | Adds an open item without a time |
| `!bot issues` (also `reminders`, `todos`) | Lists open items and requests the AI spotted |
| `!bot keep N` / `!bot keep N <when>` | Turns spotted request N into a to-do, with a reminder before its deadline or at the time you give |
| `!bot done N` | Closes item N |
| `!bot drop N` | Removes item N |
| `!bot summary [hours]` | AI summary of recent messages. Listed for members, but answers only you unless `summary.ownerOnly` is turned off; on your subscription it's always you only. |
| `!bot idea <text>` | **New.** Saves an idea on the chat's ideas board (no AI). Members can't put links in it; at most 20 an hour from members. |
| `!bot ideas` | **New.** Lists the saved ideas |
| `!bot github issue <title>` / `issue N` / `issues` / `prs` / `pr N` / `#N` / `files` / `file <path>` / `commits` / `commit <id>` (also `gh`) | The chat's GitHub repository: open an issue (or turn item N into one), and read issues, pull requests, comments, files and commits. Only you, unless you linked the chat with `--members`. See "GitHub" below. |
| `!bot google` / `!bot doc <name>` / `!bot sheet <name> [range]` / `!bot slides <name>` | **New.** Reads the Google files linked to this chat. Only you, unless you linked them with `--members`. See "Google" below. |

## Commands only you can use
| Command | What it does |
|---|---|
| `!bot ask <question>` | AI answer from the chat's recent messages, its notes and (on your subscription) its files |
| `!bot ask+ <question>` | **New.** The same, thinking harder (`high` effort) for this one answer |
| `!bot findings` / `findings github` / `findings post` / `findings show` | **New.** The AI turns the saved ideas and recent messages into findings and saves them; `github` also opens a GitHub issue, `post` sends the saved ones to GitHub without a new AI run, `show` posts the last ones again. See "Ideas board" below. |
| `!bot ideas drop N` / `!bot ideas clear` | **New.** Removes one idea, or all of them (the findings stay) |
| `!bot effort` / `!bot effort <level> [time]` / `!bot effort reset` | **New.** How hard the AI thinks in this chat for a while: `low`, `medium`, `high`, `xhigh` or `max`, e.g. `!bot effort high 2h` or `!bot effort max 30m`. 1 hour if you give no time, at most 12. See below. |
| `!bot spot` | **New in 20261106a.** Looks for requests and deadlines in the new messages now and lists what it found |
| `!bot instructions` / `show` / `set <text>` / `clear` (also `instruction`, `rules`) | **New.** This chat's standing instructions for the AI: their size, the text, set them, remove them. E.g. `!bot instructions set Answer in Traditional Chinese`. See below. |
| `!bot github #N comment` / `label` / `close` / `reopen` / `title` / `body` / `delete`, `!bot github pr N merge` / `close`, `!bot github file <path> write` / `delete`, `!bot github commit <id> revert` | **New.** Changes on GitHub. Anything that removes, closes, merges or replaces waits for a confirm code. See "GitHub" below. |
| `!bot doc <name> append` / `replace`, `!bot sheet <name> add` / `set` / `clear`, `!bot slides <name> add` / `delete` / `replace` | **New.** Changes to the linked Google files; replacing, overwriting, clearing and deleting wait for a confirm code. See "Google" below. |
| `!bot draft doc <name> <what you want>` (or `sheet`, `slides`) / `!bot draft github #N <what you want>` / `!bot draft github file <path> <what you want>` | **New.** The AI drafts the change from the chat; it waits for your confirm code. See "AI drafts" below. |
| `!bot confirm <code>` / `!bot cancel [code]` | **New.** Go ahead with a change that waits for you, or drop it. Codes last 2 minutes and work once. |
| `!bot notes` | Size of the chat's notes (the text stays on the server) |
| `!bot sync` | Updates the chat's folder from its GitHub repo |
| `!bot spam` (as a reply to a message) | Deletes that message, and future copies of it |
| `!bot spam kick` / `!bot kick` (as a reply) | Deletes and removes the sender, or only removes them (you must be group admin) |
| `!bot trust` / `!bot untrust` (as a reply) | Exempts the sender from spam checks, or stops exempting them |
| `!bot lock [minutes]` / `!bot unlock` | Only admins can send (group admin needed) |
| `!bot discover` (exactly this) | Records the chat's ID quietly, without enabling it |

The commands that act on a message (`spam`, `kick`, `trust`, `lock`) never reply in the chat. Their result is in the server's log.

## Times `remind` and `keep` understand (London time)
`in 30 min`, `in 2 hours`, `in 3 days`, `in 2 days 5pm`, `today 17:00`, `tomorrow 9am`, `tomorrow 5.30pm`, `tomorrow 5 p.m.`, `Fri 17:00`, `Friday, 5pm`, `on Friday at 5pm`, `20 Nov 14:30`, `Nov 20, 17:00`, `2026-11-20 17:00`, `Fri 20 Nov 17:00`, `9am tomorrow`, `5pm Friday`, `17:00 on 20 Nov`, or a time alone. A date without a time means 09:00. Anything the bot can't read for certain is refused with examples, never guessed.

## What runs on its own (no command)
- **Reminders** are posted when due. They quote the message that set them, and are limited to 6 an hour per chat.
- **Spotting requests**, in chats where you turned it on, runs once a day at 20:00. What it finds is listed in `issues`, not posted.
- **Condensing**, in chats with "days to keep", runs between 04:00 and 07:00.
- **Spam handling** runs as set per chat: flag or delete.

## Server commands (PythonAnywhere Bash console)
Run these in `~/shared-bot-task/whatsapp-spam-bot` as `../node/bin/node src/cli.js <command>`. The ones marked "needs the bot stopped" refuse to run while the worker is running.

| Command | What it does |
|---|---|
| `status` | Each chat's settings, archive size, AI use and to-do counts, plus any pauses |
| `issues "<chat>"` | A chat's to-do list |
| `notes "<chat>"` | The chat's notes (never posted in a chat) |
| `transcript "<chat>" [--hours 24]` | Archived messages, pseudonymised, in London time |
| `summarise "<chat>" [--ask "question"] [--effort high]` | An AI summary or answer, at the effort you name for this run (needs the bot stopped) |
| `detect "<chat>" [--dry-run]` | Looks for requests now (needs the bot stopped unless `--dry-run`) |
| `ideas "<chat>"` | The chat's saved ideas and its latest findings. `summarise "<chat>" --findings` writes new findings (needs the bot stopped). |
| `instructions "<chat>" [--set "text" \| --clear]` | Shows, sets or clears the chat's AI instructions, without posting in the chat. Works while the bot runs. |
| `github "<chat>" [--repo OWNER/REPO [--members] \| --off]` | Links the chat to a GitHub repository (or unlinks it) and checks that `GITHUB_TOKEN` can see it. Works while the bot runs. |
| `condense "<chat>" [--dry-run]` | Folds old messages into notes now (same) |
| `sync "<chat>"`, `sync "<chat>" --clone <repo> --key <key>`, `sync "<chat>" --adopt` | The chat's file folder and its GitHub repo |
| `choose` | Chooses chats and their settings (needs the bot stopped) |
| `resume --reviewed` | Clears a pause after you've checked your phone |

Supervisor, in `~/shared-bot-task`: `python3 -B supervisor.py status`, `arm-whatsapp --reviewed` (start WhatsApp), `stop-whatsapp`.

## Ideas board
| You type | What happens |
|---|---|
| `!bot idea Let the judges try the demo on their own phones` | Saved as idea N (anyone in the chat; no AI) |
| `!bot ideas` | The saved ideas |
| `!bot findings` | The AI reads the ideas, the last findings, the notes and the last 24 hours of messages (and the files, on your subscription). It writes themes, the strongest ideas and why, open questions and next steps, posts them and saves them. |
| `!bot findings github` | The same, and also opens a GitHub issue "Findings – <date>" in the linked repo |
| `!bot findings post` | Sends the saved findings to GitHub without a new AI run (when the GitHub step failed, or you didn't ask for it) |
| `!bot findings show` | Posts the last saved findings again |

- Each findings run is one AI request of your day, like `ask`. Every later `!bot ask` and `!bot findings` in that chat reads the saved findings.
- The AI treats ideas, earlier findings and messages as data, never as instructions. Links and long numbers in its findings show as `[link]` and `[number]`.
- At most 200 ideas per chat: members can fill 150, at most 20 an hour. The last 10 findings are kept.
- With `github`, the findings text goes to GitHub. It comes from the ideas and messages, so names typed in the chat can be in it.

## GitHub: issues, pull requests, files and commits
**Reading** (you, and members too if you linked the chat with `--members`):

| In the chat | What it does |
|---|---|
| `!bot github issue Fix the login page` | Opens an issue with that title, and posts its link (members too with `--members`) |
| `!bot github issue 3` | Turns item 3 of `!bot issues` into an issue, with its deadline. If 3 is a request the AI spotted, it's kept first, so one command does both. |
| `!bot github issues` / `!bot github prs` | Open issues / pull requests (10 shown) |
| `!bot github pr 12` | Pull request 12: author, branches, size, whether it can be merged |
| `!bot github #12` | **New.** Issue or pull request 12, its description and its 3 latest comments (with their IDs) |
| `!bot github #12 comments` | **New.** Its 5 latest comments |
| `!bot github files` / `!bot github files src` | **New.** The repository's files, or one folder |
| `!bot github file README.md` | **New.** A file's first 60 lines |
| `!bot github commits` / `!bot github commits feature-x` | **New.** The 10 latest commits |
| `!bot github commit abc1234` | **New.** One commit and the files it changed |

**Changing** (**only you**). The ones marked ✱ show what will happen and wait for `!bot confirm <code>`:

| In the chat | What it does |
|---|---|
| `!bot github #12 comment Fixed on Safari too` | Adds a comment. The text can go on several lines. |
| `!bot github #12 label bug, help wanted` | Adds labels |
| `!bot github #12 close` ✱ (or `close not planned`) / `!bot github #12 reopen` ✱ | Closes or reopens an issue or pull request |
| `!bot github #12 title <new title>` ✱ / `!bot github #12 body <new text>` ✱ | Replaces the title or description. Refused if someone changed it on GitHub after the preview. |
| `!bot github #12 delete` ✱ | Deletes an issue for good, with its comments. GitHub allows this only for repository admins; pull requests can only be closed. |
| `!bot github comment 1234567 edit <new text>` ✱ / `delete` ✱ | Changes or removes a comment (IDs from `!bot github #12`) |
| `!bot github pr 12 merge` ✱ (or `merge squash`, `merge rebase`) | Merges it. The preview shows what GitHub says (checks, conflicts); it merges only the commit you saw, so nothing pushed after the preview gets in. Drafts and pull requests with conflicts are refused. |
| `!bot github pr 12 close` ✱ | Closes it without merging |
| `!bot github file docs/plan.md write` then the whole file on the next lines ✱ | Creates the file, or replaces it (the preview shows the size and about how many lines change) |
| `!bot github file old.txt delete` ✱ | Deletes one file |
| `!bot github commit abc1234 revert` ✱ | Undoes a commit with a new commit. Only commits in the default branch's own history. Refused for merge commits, renames, more than 20 files, or a file that changed again after it (a plain revert would undo that later work too). |

- **File changes and reverts go on a new branch** (`whatsapp/<date>-<what>`) with a pull request into the default branch, so someone can look before it lands. To commit straight onto the default branch instead, set `"changes": "direct"` under `github` in config.json.
- Nothing force-pushes or rewrites history. To undo a change, revert it (above) or close its pull request.
- At most 30 changes an hour from all chats (`github.maxWritesPerHour`), plus at most 10 new issues. Members' reads come 10 seconds apart, one at a time per chat.
- Every change is logged on the server as `[GITHUB] <chat>: <what>` (never the text).
- Text from GitHub (titles, comments, files) shows links and long numbers as `[link]` and `[number]`, so nobody can use the repository to post a phishing link from your account. Open the file on GitHub to see them.
- `github issue N` sends that item's text and deadline. In a public repository, everything you send is public.

**Set up once (PythonAnywhere):**
1. **Create a token on GitHub** (or edit the one you made for issues). Go to Settings → Developer settings → Personal access tokens → Fine-grained tokens.
   - Resource owner: you, or the organisation that owns the repository. An organisation may need to approve the token first.
   - Repository access: **Only select repositories**, then pick the repository.
   - Permissions: **Contents: Read and write**, **Issues: Read and write**, **Pull requests: Read and write** (Metadata: read-only is added by itself). To change files under `.github/workflows`, also **Workflows: Read and write**.
   - Deleting issues also needs you to be an admin of the repository. Whether the token needs an extra permission for that is unconfirmed; if `delete` is refused, close the issue instead or delete it on GitHub.
   - Pick an expiry.
2. **Put it in `.env` yourself.** Open `~/shared-bot-task/whatsapp-spam-bot/.env` on the Files page and add or replace the line `GITHUB_TOKEN=github_pat_...`. Never paste it in a chat. No restart is needed.
3. **Link the chat and check the token:**
   ```bash
   cd ~/shared-bot-task/whatsapp-spam-bot && ../node/bin/node src/cli.js github "<chat>" --repo OWNER/REPO
   ```
   It should end with `Checked: GITHUB_TOKEN can see OWNER/REPO (private).` Add `--members` to let members read and open issues; `--off` unlinks.

## Google Docs, Sheets and Slides
A chat reaches only the Google files you link to it, each by a short name. The bot signs in as a **service account**: a robot Google identity that sees only the files you share with its email address.

| In the chat | What it does |
|---|---|
| `!bot google` | The files linked to this chat |
| `!bot doc plan` | Reads the doc (first 50 lines) |
| `!bot doc plan append Judging is at 5pm` | Adds text at the end (only you). The text can go on several lines. |
| `!bot doc plan replace Goal => Aim` ✱ | Replaces that exact text everywhere (only you; capitals must match). Refused if someone edits the doc after the preview. |
| `!bot sheet budget` / `!bot sheet budget B2:D20` / `!bot sheet budget 'Tab 2'!A1:C9` | Reads cells (A1:J20 of the first tab unless you give a range) |
| `!bot sheet budget add Pizza \| 40 \| Kai` | Adds a row at the end of the first tab (only you) |
| `!bot sheet budget set B2 Done`, or `set A5` then rows on the next lines (cells split by `\|`) ✱ | Writes cells (only you). The preview shows what is there now. |
| `!bot sheet budget clear B2:D9` ✱ | Empties cells (only you) |
| `!bot slides pitch` | Lists the slides with their text |
| `!bot slides pitch add Results \| We built it` | Adds a slide at the end with a title and text (only you) |
| `!bot slides pitch delete 3` ✱ | Removes slide 3 (only you). Refused if someone edits the deck after the preview. |
| `!bot slides pitch replace 2026 => 2027` ✱ | Replaces text on every slide (only you) |

- Members can read the linked files only if you run `google "<chat>" --members` (their reads come 10 seconds apart). Only you can change them.
- Text read from a file shows links and long numbers as `[link]` and `[number]`, as for GitHub: anyone who can edit the file could otherwise get the bot to post a phishing link from your account. Open the file for them.
- Cells are written as typed: `=SUM(A1:A3)` stays text, so nothing typed in the chat becomes a formula.
- At most 30 changes an hour from all chats (`google.maxWritesPerHour`), each logged as `[GOOGLE] <chat>: <what> in <name>`.

**Set up once:**
1. **A Google Cloud project.** Go to console.cloud.google.com (any Google account; a personal one avoids company rules that block keys) and create a project, for example `whatsapp-bot`.
2. **Turn on four APIs.** APIs & Services → Library: **Google Docs API**, **Google Sheets API**, **Google Slides API** and **Google Drive API** (the Drive one lets the bot check a file's name and type when you link it). Each one: open it and press Enable.
3. **Create the service account.** IAM & Admin → Service Accounts → Create service account, name it `whatsapp-bot`, skip the optional roles. Open it, then Keys → Add key → Create new key → **JSON**. A `.json` file downloads. Treat it like a password: never post it in a chat.
4. **Put the key on PythonAnywhere yourself**, outside the bot folder so installs never touch it. On the Files page, create the folder `/home/EricH1425/google-key` and upload the file there. Then in a Bash console:
   ```bash
   chmod 700 ~/google-key && chmod 600 ~/google-key/*.json
   ```
   The bot refuses a key file other users could read.
5. **Name it in `.env`.** Add the line `GOOGLE_SERVICE_ACCOUNT_FILE=/home/EricH1425/google-key/<file name>.json` to `~/shared-bot-task/whatsapp-spam-bot/.env`. No restart is needed.
6. **Share each file with the robot.** Its email is the `client_email` in the key file (it ends in `.iam.gserviceaccount.com`). In Google Docs, Sheets or Slides, press Share and add that email: **Editor** if the bot may change it, **Viewer** if it only reads.
7. **Link the file to the chat:**
   ```bash
   cd ~/shared-bot-task/whatsapp-spam-bot && ../node/bin/node src/cli.js google "<chat>" --add "<link to the file>" --name plan
   ```
   It answers `Linked "<title>" (Google Doc) to <chat> as plan.` Run it without `--add` to list the chat's files and check each one; `--remove plan` unlinks one; `--members` / `--no-members` lets members read them or not.

If a reply says an API "is not turned on", enable it (step 2) and wait a few minutes. If it says "share the file with ...", do step 6 for that file.

## AI drafts (you only)
The AI can draft a change from the chat for you. It only proposes: **every draft waits for `!bot confirm <code>`**, additions too.

| In the chat | What the AI may draft |
|---|---|
| `!bot draft doc plan add a section on what we decided today` | Text to add at the end, or one text replacement |
| `!bot draft sheet budget add today's costs` | A new row, or cells to write |
| `!bot draft slides pitch add a slide with our results` | A new slide, or a text replacement |
| `!bot draft github #12 sum up the chat about this bug` | A comment, a new description, or a new title |
| `!bot draft github file README.md add the setup steps we agreed` | The whole new file (files up to 30,000 characters) |

- Each draft is one AI request, like `ask`. The AI sees your request, the file or issue as it is now, the last 24 hours of messages and the chat's notes. It never reads the chat's file folder for a draft.
- It is told to treat the file and the messages as data, never as instructions. Even so, read the preview before you confirm.
- Links the AI adds that were not already in the file become `[link]`: someone in the chat could have planted one.
- **The preview always shows the whole draft.** A draft too long for that (about 1,500 characters or 30 lines of text, 10 rows of cells, or 60 changed lines of a file) is refused: ask for a smaller change. A drafted file change lists every line it removes and adds.
- A drafted file change always goes on a new branch with a pull request, even with `"changes": "direct"`.
- If someone changes the file or issue while the AI is drafting, the draft is refused; ask again.
- If it cannot do what you asked with the changes allowed, it says why and nothing is waiting.

## Confirm codes
- A change marked ✱ (and every draft) replies with what will happen and a 4-digit code. Send `!bot confirm <code>` in the same chat within **2 minutes**. Each code works once.
- `!bot confirm` alone lists what is waiting; `!bot cancel <code>` or `!bot cancel` drops them.
- Only you can confirm. If the chat is busy with another request, or the hourly limit is reached, the code stays valid for another try.
- A restart forgets every waiting change, so an old code can never do something later. (While replies are paused, a confirmed change still happens, but its reply is not posted.)

## Thinking harder: ask+ and effort (you only)
The bot uses **Opus 5.5** (`claude-opus-5-5`) at effort **low** by default (`summary.model` and `summary.effort`). Effort is how much the AI thinks before answering. Higher answers take longer and use more of your plan or API credits; the model stays the same.

| You want | Type |
|---|---|
| One better answer | `!bot ask+ <question>`: this answer only, at `high` (`summary.boostEffort`) |
| A chat to think harder for a while | `!bot effort high 2h`, `!bot effort max 30m`, or `!bot effort xhigh` (1 hour) |
| To see the current setting | `!bot effort` |
| To end it early | `!bot effort reset` (also `off` or `default`) |
| One console run | `../node/bin/node src/cli.js summarise "<chat>" --ask "question" --effort max` |

- It applies to your own summaries, answers and spotted requests in that chat. Condensing and other chats keep the default.
- It's temporary on purpose: it ends at the time you set (at most 12 hours, `summary.maxBoostHours`), on `reset`, or when the bot restarts or the supervisor pauses it.
- Every run still counts against the usual AI limits.
- Members can't change the effort or use `ask+`. If you ever turn `summary.ownerOnly` off so members can ask for summaries (API key only), their summaries keep the default effort.
- With the API key, a higher effort also gets more room to answer. A reply cut off at that limit ends with "(Cut off at the length limit.)"; one cut off before any text says the run failed, never "Nothing important.".
- To change the default for good, edit `summary.effort` in config.json; the running bot uses it from the next run.

## Per-chat instructions (such as a language preference)
Only you can see or change them, from your own account in the chat or from the server console.

| Where | Check | Show the text | Set | Remove |
|---|---|---|---|---|
| In the chat | `!bot instructions` (size only) | `!bot instructions show` | `!bot instructions set Answer in Traditional Chinese, at most 3 lines.` | `!bot instructions clear` |
| Server console | | `../node/bin/node src/cli.js instructions "<chat>"` | `... instructions "<chat>" --set "Answer in Traditional Chinese"` | `... instructions "<chat>" --clear` |

- **Everyone in the chat can read what you type there, and the bot's replies.** That's why `!bot instructions` only gives the size, and only `show` posts the text. To set them quietly, use the console. It works while the bot runs, and the next AI run uses the change.
- They apply to that chat's summaries, `!bot ask` answers and spotted requests. No other chat gets them. For spotted requests they set the language and wording of each to-do and may say what to leave out.
- They are not used for the notes (condensing): a language rule would make the AI rewrite the notes, which the bot then refuses as "much shorter" every night. `!bot ask` still answers from the notes in your language.
- They can't switch off the bot's own rules: messages and files are still treated as data, people stay pseudonymised, and the output format and every limit stay. The AI is told never to quote or reveal them.
- At most 1000 characters and 20 lines (blank lines count). Line breaks, Chinese punctuation and emoji are kept as typed; hidden characters are removed.
- Members who try any of these get "Only the owner of this bot can see or change this chat's instructions." They never see the text or the size.
- Stored in `data/instructions/` on the server (owner-only), never in the GitHub repo. `status` shows each chat's size, or why a hand-edited file isn't used.

Good first instructions:
- `Answer in Traditional Chinese (Taiwan).`
- `Answer in English. Keep summaries to 5 lines.`
- `This is the family chat. 阿嬤 is Grandma. Dates are UK dates.`
