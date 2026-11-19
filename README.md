# WhatsApp chat bot

A Node.js bot that runs on your own WhatsApp account through a linked device. For each chat you choose:

- **receive**: whether the bot reads the chat (spam checks, local archive, commands);
- **send**: whether the bot may post there (command replies, optional spam warnings);
- **buzzword**: the word that calls it, such as `!bot`, and whether anyone or only you may use it;
- **spam**: off, flag in the terminal, or delete.
- **AI** is off by default in every chat. Enable it for summaries, questions, or the optional assistant.

Starting, restarting and reconnecting send no chat messages. Each chat stays silent until a command typed from your own account receives a successful reply there, with receive and send enabled. That opens other members' replies, optional warnings and the assistant in that chat for this run. Discovery never opens sending. Setup never sends a test message.

Automatic deletion and startup join approval can act before any owner test: the chat must be explicitly set to `spam: "delete"` or `joinRequests: "screen"`, respectively. Silent start holds back messages; it does not postpone those actions.

Spam handling uses fixed rules and needs no AI or API key. Rules flag likely spam for you to review; deletion only acts on patterns you confirm, mainly by replying `!bot spam` to a spam message. Where your account is a group admin, you can also remove members, lock the group and screen join requests with owner-only commands.

This project merges the earlier spam detector with parts of [whatsapp-reader](https://github.com/Adellama75/whatsapp-reader): the chat index, chat settings that reload without a restart, the local archive, pseudonymised transcripts and Claude summaries. See [Credits and licence](#credits-and-licence).

**This uses the unofficial [whatsapp-web.js client](https://github.com/wwebjs/whatsapp-web.js). Its maintainers warn that accounts can be blocked.** A separate bot account is preferable to an important personal account. Read [the research findings](RESEARCH.md) before relying on it.

## Start on Windows

1. Open `TRY-DEMO.cmd` to see the spam rules working offline. Requires [Node.js 22 or newer](https://nodejs.org/).
2. Open `SETUP.cmd` to install the packages. It uses installed Chrome/Edge, or downloads Chrome if needed.
3. Open `CHOOSE-CHATS.cmd`. On your phone, go to **WhatsApp → Linked devices → Link a device** and scan the terminal QR code (first time only).
4. The terminal lists your chats with their IDs. Type the numbers of the chats to set up, then answer the questions for each one (see below). Your answers are saved to `config.json`.
5. The bot keeps running after setup. Test each chat as described in [Test each chat](#test-each-chat). Later, open `START.cmd` to run it with the saved settings.

## Choose chats

`CHOOSE-CHATS.cmd` (or `npm.cmd run setup`) shows every group and your 25 most recent direct chats:

```
  1. [group] Course chat 48 members
       ID: 120363012345678901@g.us   not set up
  2. [direct] Alice
       ID: 447700900123@c.us   receive, send, buzzword "!bot" (me only)
```

Channels may appear in the list or discovery metadata, but cannot be enabled because message receipt has not been verified. Selecting one prints a clear refusal and keeps the chooser running with your earlier answers.

The full list, including older direct chats, is written to `data/chats.tsv`; paste an ID from there to set up a chat that is not shown. For each chat you pick, it asks:

| Question | Default for a new chat | Meaning |
| --- | --- | --- |
| Receive (read) messages? | yes | Off means the bot ignores the chat completely. |
| Allow the bot to send? | no | Off means nothing is ever posted there. Replies are shown in the terminal as `[NOT SENT]` instead. |
| Buzzword | `!bot` | The message must start with it: `!bot ping`. Type `-` for none. |
| Who can call it | anyone | `me` only accepts the buzzword from your own account. |
| Spam handling | flag | `flag` writes to the terminal and log only; `delete` also removes spam matching your own patterns (see below). Type the whole word or its first letter. |
| Screen join requests? (groups) | no | Approve your contacts and trusted people, reject people you removed; needs admin. See Admin commands. |
| Allow explicitly requested AI summaries? | no | Asked where receive, send and a buzzword are on. Enables AI for this chat subject to its permissions and limits. |
| Most AI requests a day for this chat (AI on) | 3 | `aiPerDay`: summaries and questions in this chat over any 24 hours, on top of the bot-wide limits. |
| Days to keep messages (AI on) | 0 (keep all) | `keepDays`, 0 or 3-365: messages older than this are folded into the chat's notes and deleted. At least 3 days, so a message deleted for everyone (possible for about two and a half days) never reaches the notes. See "Notes: condensing older messages". |
| Spot requests and deadlines on a schedule? (AI on) | no | `detect`: at the times in `reminders.detectTimes` (20:00 London time by default) the AI looks at the chat's new messages for things someone has to do. You can also ask any time with `!bot spot`, in any chat with AI on. What it finds only shows up in `!bot issues` until someone keeps it. See "Reminders and open items". |

Answer no to both receive and send to remove a chat. `npm.cmd run chats` lists chats and IDs without changing anything.

You can also edit `chats` in `config.json` by hand. While the bot runs, it reloads chat settings within a few seconds of saving; a broken edit is reported and the previous settings stay in use:

```json
"chats": [
  {
    "id": "120363012345678901@g.us",
    "label": "Course chat",
    "receive": true,
    "send": true,
    "ai": false,
    "buzzword": "!bot",
    "callers": "anyone",
    "spam": "delete",
    "archive": true,
    "pseudonymise": true
  }
]
```

True legacy groups listed only in `groupIds` are still moderated, with no buzzword and no archive, using the current `deletion` settings. The chooser mirrors its active groups into `groupIds` for the hosted supervisor and records those IDs in `managedGroupIds`. A managed group has no legacy fallback: deleting its `chats` entry makes it completely ignored after reload. Keep `managedGroupIds` when editing. To remove a true legacy group, remove its ID from `groupIds` too. The installer also migrates existing chat mirrors from earlier choosers.

## Optional chat assistant

1. In one test chat's `config.json` entry, set `assistant: true` with `receive` and `send` on. Send `!bot ping` from your linked account after each start.
2. Try `@bot What did we decide?`, a reply to a bot message from this run, or `What issues are open?` in a chat linked to GitHub. The assistant quotes one message per burst. Named and quoted questions use recent chat text with `ai: true` and the existing AI permissions. Supported GitHub questions read the linked repo directly and respect `githubMembers`.
3. To enable writes, set `githubAutoIssues: true` for a chat linked to a private GitHub repo with Issues enabled. AI can turn a clear task into one issue. From your linked account, `Issue #21 done`, `Issue #21 reopen` and `Issue #21 progress: Tested the fix` act on that issue directly. Comments stay quiet in WhatsApp.

Both switches default to off. Set either back to `false` to turn off that feature. Automatic GitHub writes use the existing permissions and rate limits. The AI sees a short batch of scrubbed text, and new issues contain a short task title and a fixed body. Announcements link to the issue. The existing `!bot spot` review flow is also available.

## Test each chat

First, discover a chat without enabling it: from **your own account**, type exactly `!bot discover` in that chat. This global phrase is configured as `discoveryPhrase` in `config.json`; case, whitespace and extra text must match exactly. Nobody else can discover a chat. The bot posts nothing, prints `[DISCOVERED]` with the ID, name and kind in the terminal (supervised worker: `state/whatsapp.log`), and saves the latest metadata for up to 1,000 chats in `data/discovered-chats.json`. Old history and bot echoes are ignored. Only the owner's exact text discovery phrase bypasses normal handling. Everything else, including a member's exact phrase, near misses and image captions, goes through the enabled chat's normal moderation and archive handling; reserved phrases only suppress command replies. Owner near misses such as `!Bot discover` print a terminal hint and post nothing.

Discovery does **not** change permissions. Enable that ID later in the chooser or add it to `chats` in `config.json`, with `receive: true`, a buzzword and your desired send/AI settings. A running bot reloads those settings within three seconds. Only enabled chats enter moderation, the archive or commands. Standalone `start` supports discovery with zero configured chats and needs no terminal prompt. On PythonAnywhere, discover first in an interactive Bash console while the worker is idle, then choose at least one group, then arm the supervisor: use the exact commands in [PythonAnywhere setup](#pythonanywhere-setup). The unattended hosted worker cannot perform discover-first because the supervisor requires a linked session and nonempty `groupIds` before it starts. A recorded channel ID is metadata only; the chooser refuses channels and continues because receipt is unverified.

Corrupt discovery metadata is set aside as `data/discovered-chats.json.bad-*`, with a terminal warning, and the bot continues. A discovery metadata lookup times out after 5 seconds so later messages can still be processed.

With the bot running, type the buzzword in each chat you set up. Use your own phone for these tests: your own messages are never spam-checked, while a message from another member goes through the spam rules first, and if it is flagged the bot does not answer it.

| Message | Reply |
| --- | --- |
| `!bot ping` | the chat's ID and what the bot may do there |
| `!bot check You have won! Claim at https://x.example` | the spam score, pattern matches and whether it would be deleted |
| `!bot summary 6` | summary of the last 6 hours (needs AI on for this chat and an API key or your subscription; only you can ask by default) |
| `!bot ask when is the exam?` | an answer from this chat's recent messages and notes, and its files with the subscription (only you, AI on) |
| `!bot notes` | how big this chat's notes are and how to read them on the server; the notes themselves are never posted (only you) |
| `!bot files` / `!bot send week1.pdf` | list this chat's shared files / post one here (chats with a file hub) |
| `!bot sync` | update this chat's file folder from the git repo it was cloned from, fast-forward only (only you) |
| `!bot remind Fri 17:00 submit report` | sets reminder 1; at that time (London time) the bot posts "Reminder 1: submit report" here |
| `!bot issue book the venue` | adds an open item without a time |
| `!bot issues` | the chat's open items, and requests spotted in messages that nobody has kept yet |
| `!bot keep 3` / `!bot keep 3 Mon 9am` | turns spotted request 3 into an open item, with a reminder before its deadline or at the time given |
| `!bot done 2` / `!bot drop 3` | closes an item / removes it from the list |
| `!bot spot` | looks for requests and deadlines in the chat's new messages now and lists what it found (only you, AI on) |
| `!bot spam` (as a reply to a message) | no reply; deletes that message on your behalf and future copies (only you can do this) |
| `!bot kick`, `!bot trust`, `!bot lock` | no reply; admin actions, see Admin commands (only you) |
| `!bot help` | the command list |

The terminal shows every call (`[CALL]`), every reply (`[SENT]`), replies held back because send is off (`[NOT SENT]`, with the full reply including the chat ID), and calls refused because callers is `me` (`[IGNORED]`). Unlisted chats are silent by default (`logOtherChats: false`); the optional old activity-ID log is available only if explicitly switched on. The bot's replies start with 🤖 and it never answers its own messages.

## Spam: what gets flagged and what gets deleted

No AI is involved. The bot separates **flagging** (written to the terminal and `logs/` for you to review) from **deleting**, because no fixed list of phrases is precise enough to delete messages on your account by itself: an independent review found ordinary messages ("you won the bet, claim your pint", "can you forward it, I accidentally deleted the email", "part time job at the campus cafe, no experience needed") that any phrase rule strict enough to catch scams would also catch.

**Flagged only** (never deleted on their own):

- **Score rules** (`keywords`, `links`, `repetition`, `threshold`): a message reaching `threshold` is flagged.
- **Pattern rules** (`strictRules`) look for two or three scam signals together: a win phrase with "claim" and a link, a request for a login code "sent by mistake", guaranteed profit with crypto words and a link, a job offer with "no experience" or "earn $" and a link, an account-suspension notice with a link, the same link posted 3 times in a minute, and a WhatsApp/Telegram invite promising "signals" or "airdrops". A link only counts when written as one (`https://`, `www.`, a shortener or an invite), and phrases do not match across hyphens ("non-profit" is not "profit").

**Deleted** automatically in chats whose spam setting is `delete` (with the default `deletion.mode: "strict"`), only on patterns you chose:

1. **Spam you mark.** Reply to the message with exactly `!bot spam` (your chat's buzzword plus `spam`, nothing else). The bot deletes that message on your behalf in any chat where it has receive on, whatever the chat's spam setting, and remembers its exact text and exact links. From then on, in every chat set to `delete`, a message with the same text or one of those links is deleted automatically.
   - Only links to a specific page are remembered (`https://odd.example/r?x=1`), never a whole site: if the scam also mentions `https://www.instagram.com`, that is skipped and the terminal says so. Paths are matched exactly, including upper and lower case.
   - The text is remembered only if it is at least 60 characters, or at least 20 with a link, so a short greeting or "ok" can never be learned.
   - Only your own account can mark spam, whatever the chat's callers setting; the quoted message must be from someone else in the same chat; and marking never posts anything in the chat. The terminal shows `[MARKED]` with exactly what was learned.
   - The list is in `data/learned-spam.json`. To forget an entry, stop the bot, delete it from the file, and start again (the running bot rewrites the file on the next mark).
2. **Domains you block** in `links.blockedDomains`, such as `"scam-shop.example"` (subdomains included).
3. **Pattern rules you switch to delete.** Change a rule's `"action"` from `"flag"` to `"delete"` once you have watched it flag only real spam for a while.

```json
{ "name": "fake delivery fee", "action": "flag", "anyOf": ["parcel is on hold", "redelivery fee"], "needsLink": true }
```

Rule conditions: `anyOf` (one of these phrases), `alsoAnyOf` (and one of these too), `needsLink`, `linkDomains` (a link to one of these domains), `needsRepeat` (sent 3+ times). Every condition you include must hold, and a rule must have `anyOf`, `linkDomains` or `needsRepeat`. A rule without `"action"` only flags. Rule, domain and `deletion` changes apply after a restart; marked spam applies immediately. Set `deletion.mode` to `"score"` to go back to deleting at `deletion.threshold`, as the original detector did; a config file with no `mode` gets `"strict"`.

`test/strict.test.js` holds ordinary messages the pattern rules must leave alone, scams they must flag, and the review's examples that must never be deleted. Known gaps: deliberately misspelt text ("Y0u h4ve w0n") and broken-up links ("bit[.]ly"). Run `TRY-DEMO.cmd` to see the whole flow, including marking, or `npm.cmd run check -- "text"` to test a message (it includes spam you marked).

## Deleting spam on your behalf

The bot acts as your account, so it can only do what you could do on your phone:

- **Groups where you are admin:** the message is deleted for everyone. Messages from group admins are never deleted.
- **Groups where you are not admin, and direct chats:** WhatsApp does not allow deleting someone else's message for everyone here. With `deletion.forMeFallback: true` (the default), the bot deletes it from your own phone only, so you stop seeing it; everyone else still does. Set it to `false` to leave these in place.
- **A sender the bot cannot match to the group's member list** (WhatsApp sometimes reports the same person under two IDs): automatic deletion leaves the message alone, since the sender might be an admin. A message you marked yourself is hidden from your own phone in that case.

```json
"deletion": {
  "enabled": true,
  "mode": "strict",
  "forMeFallback": true,
  "keepDeletedText": true,
  "threshold": 5,
  "minIntervalSeconds": 2,
  "maxPerHour": 20,
  "maxPerDay": 100
}
```

Every flag is written to the terminal and `logs/flags-YYYY-MM-DD.jsonl` with a `classification`: `suspected_spam` (score), `pattern_match` (a pattern rule, flag only), `owner_pattern_match` (one of your patterns) or `owner_marked` (you replied `!bot spam`). A second record with `event: "moderation"` records the outcome, and with `keepDeletedText: true` (the default) the text of anything removed, so a mistake can be reviewed and the text recovered. These logs are private, local files.

| Status | Meaning |
| --- | --- |
| `confirmed` | deleted for everyone; the client saw the matching revoke event |
| `deleted-for-me` | removed from your devices only; the client saw the local delete |
| `requested-for-me` | delete-for-me was requested but WhatsApp Web sent no event; check your phone |
| `skipped`, `failed`, `unconfirmed` | not removed; the reason is logged |

For everyone-deletion, the bot never silently falls back to a local delete inside the same request: it checks admin rights, the sender and that the message is revocable first, and waits for WhatsApp's confirmation. The deletion code uses WhatsApp Web internals through the pinned library and may need repair when WhatsApp changes them.

At most 20 deletion attempts per rolling hour and 100 per rolling day are reserved across all chats, with at least 2 seconds between attempts; marked spam uses the same budget. Messages inside the interval or beyond the cap stay flagged for manual review. These are local engineering limits, not verified safe WhatsApp rates. A deletion error or a missing everyone-deletion confirmation pauses all further removals, including after restart; flags continue.

## Admin commands (you only)

These run only when **you** send them from your own account, whatever the chat's callers setting; from anyone else they are ignored and logged. They never post anything in the chat: results appear in the terminal as `[ADMIN ...]` lines and in `logs/`. Group actions need your account to be an admin of that group, and the bot never acts on another admin.

| Send this | As a reply to a message? | What happens |
| --- | --- | --- |
| `!bot kick` | yes | Removes that message's sender from the group. The bot waits for WhatsApp to confirm the removal (or checks the member list) and remembers the person, so a later join request from them can be rejected. |
| `!bot spam kick` | yes | Marks the message as spam (deletes it and learns it, as `!bot spam` does), then removes the sender. |
| `!bot trust` / `!bot untrust` | yes | Adds or removes the sender from your trusted list: trusted people are exempt from all spam checks in every chat. Works without admin. |
| `!bot lock` / `!bot lock 30` | no | Only admins can send in this group, for 30 minutes if you give a number. Locking again replaces the bot's own timer: `!bot lock` keeps it locked, `!bot lock 120` moves the unlock. If someone else had already made the group admins-only, nothing changes and no timed unlock is set, so the bot never opens a group you had closed. |
| `!bot unlock` | no | Everyone can send again. |

The command must be exactly that text (with your chat's buzzword), so "hey, kick off is at 3" is never a command even with the buzzword "hey". Something close to a command ("!bot kick him", "!bot lock 30 min") does nothing and is never answered in the chat; if you sent it, the terminal says why. The quoted message must be from someone else in the same chat. `!bot help` lists these commands only when you ask. Community groups and their announcement groups are refused for kick and lock.

**Timed unlock.** It lives in memory: if the bot restarts first, the group stays locked until `!bot unlock`. It is not held back by the admin budget or an admin pause (it only restores normal sending); if WhatsApp refuses or errors, it tries twice more a minute apart, then asks you to unlock in WhatsApp. If you remove the chat from the bot's settings before then, the unlock is cancelled and the terminal tells you.

**Join screening.** For groups where WhatsApp's "approve new members" is on, set the chat's `joinRequests` to `"screen"` (the chooser asks, and can keep a group for screening alone without reading or sending). When someone asks to join, and once for requests waiting when the bot starts, it decides:

1. reject people you removed with `!bot kick` (`joinScreening.rejectRemoved`);
2. reject numbers starting with a country code in `joinScreening.rejectCountryCodes`, such as `["234", "92"]` (prefix match on the phone number, so `"1"` would match all of North America). People WhatsApp shows only by privacy ID have no number to check, so this rule cannot catch them;
3. approve people you trust;
4. approve your saved contacts (`joinScreening.approveContacts`);
5. leave everyone else pending for you to decide in WhatsApp.

Answers are spaced by the admin budget's minimum interval (also between groups at startup), at most 10 answers per pass; requests left pending don't count towards that, so they never hold up ones the rules can answer. The rest wait for the next join request or restart. Requests that arrive during a pass are handled in one follow-up pass. An answer only counts when WhatsApp confirms it. If WhatsApp reports a problem with one request (for example you already answered it on your phone), that is logged and screening goes on; no answer at all, or a refusal without a reason, pauses admin actions. Screening rules and admin limits apply after a restart.

**Limits.** Kicks, locks and join decisions share one budget (`admin`): at least 3 seconds apart, at most 20 an hour and 60 a day. A failed or unconfirmed removal, a WhatsApp error, or an unconfirmed join answer pauses all admin actions until you run the resume command (`npm.cmd run resume -- --reviewed` on Windows; the pause message prints the exact command for the machine). The trusted and removed lists are in `data/members.json`; stop the bot before editing it.

**People with two IDs.** WhatsApp sometimes names a person by phone number in one place and by a privacy ID in another. Deletion, kicks and join screening look up both forms, so a member list kept by phone number still matches a message sent under a privacy ID; when the other form cannot be resolved, a kick or deletion is skipped and a join request is left pending rather than guessed at. Trust stores every form WhatsApp reports at the time; if the terminal says only one form was known, trust the person again from a message sent under their other ID.

## Archive, transcripts and summaries

Chats with receive and `archive` on are saved locally to `data/archive/<chat id>.jsonl`, as text only: media becomes a placeholder such as `[image] caption` and is never downloaded. Messages deleted for everyone (or for you) leave the archive, and flagged spam is never added. Set `archive.enabled: false` to turn it off everywhere. Each chat file rolls at `archive.maxFileMiB` (20 MiB) and keeps one previous file.

```powershell
npm.cmd run transcript -- "Course chat" --hours 24
npm.cmd run summarise -- "Course chat" --hours 24 --dry-run
npm.cmd run status
```

Transcripts and summaries show senders as `Member-xxxx` and scrub phone numbers, emails and link tokens, using a secret in `data/pseudonym.secret`; losing it changes every label. Labels are computed per chat, so one person has a different label in each chat and summaries posted in two groups cannot be matched up (labels changed once with this version). Set `"pseudonymise": false` on a chat only if everyone in it has agreed to real names. Names typed inside messages are not removed.

**Each chat's AI context is its own.** A summary or question carries that chat's archived messages (and, for questions, its notes) only, in one request. Nothing from the conversation with the AI is kept afterwards; the only thing that persists is the chat's own notes from condensing (below). No other chat's messages, notes or files are ever included. The AI has no web access and cannot reach GitHub; with the subscription it can only read the chat's own hub folder.

Summaries (`!bot summary` and `npm.cmd run summarise`) and questions (`!bot ask <question>`, `npm.cmd run summarise -- "<chat>" --ask "<question>"`) need `ai: true` on the chat and one of two providers, set by `summary.provider`:

- **`"api"` (default):** the Claude API with `ANTHROPIC_API_KEY` in `.env`, billed to API credits.
- **`"claude-code"`: your own Claude subscription** through the official Claude Code program (`claude -p`), with `CLAUDE_CODE_OAUTH_TOKEN` in `.env` from `claude setup-token`. Anthropic's terms allow signing in to Claude Code with your own plan for ordinary individual use, and do not allow routing other people's requests through it, so **only you can start these runs**, whatever the chat's settings. Each run is sealed off: its own empty folder (deleted afterwards), or that chat's file hub read-only; no tools, or only Read/Grep/Glob confined to that folder (`--restricted`); no Bash, web, MCP servers, CLAUDE.md, memory, settings or saved sessions; a fresh home folder; and an environment holding only the token, never `ANTHROPIC_API_KEY` or other secrets. `@` in the prompt is neutralised, so a chat message cannot name a file for Claude Code to attach. Only `ask` may read the chat's hub, and only when the whole folder (hidden entries and any depth included) holds no links. One subscription run at a time; a run still going when the bot stops is killed, and leftover run folders are removed at the next start. `summary.claudeCommand` names the program if it is not on PATH or in `~/.local/bin`; `summary.claudeTimeoutSeconds` (300) stops a stuck run. Claude Code lists 4 GB RAM as a system requirement; on a small host, check memory before relying on it.

Questions are owner-only with either provider. Without a provider, other features still work. The model and effort remain in `summary` in `config.json` (`claude-opus-5-5`, effort `low`); the running bot uses a changed value from its next AI run.

**Thinking harder, for a while (owner only).** Effort is how much the AI thinks before it answers: `low`, `medium`, `high`, `xhigh` or `max`. Higher answers take longer and use more of your plan or API credits; the model stays the same.
- **One question:** `!bot ask+ <question>` answers that one question at `summary.boostEffort` (`high`), or at the chat's own effort if that is higher. The next `!bot ask` is back to normal.
- **One chat for a while:** `!bot effort high 2h` (or `30m`; 1 hour if you give no time; at most `summary.maxBoostHours`, 12) makes your summaries, answers and spotted requests in that chat use `high` until then (the time shown is when it ends, to the minute). `!bot effort` shows what it is and until when; `!bot effort reset` (or `off`, `default`) ends it early. Condensing always keeps `summary.effort`, other chats are not affected, and a member's summary (only possible with `summary.ownerOnly` off) keeps `summary.effort` too. It is kept in memory only, so a restart or a supervisor pause also ends it: a higher setting can never stay on by accident.
- **One console run:** `summarise "<chat>" --ask "question" --effort max`. It is refused with `--dry-run` and `transcript`, where no AI runs.
- None of these lets anyone else start an AI run or change the effort, and each run still counts against the same limits.
- With the API key, `high` and above get room for 16000 tokens instead of 4096 (2048 for spotting), so a longer think is not cut short. If an answer still hits the limit, the reply ends with "(Cut off at the length limit.)"; with no text at all it is reported as a failed run, never as "Nothing important.". A cut-off to-do list counts as a failed spotting run.
- With the subscription, a `max` run can take longer than `summary.claudeTimeoutSeconds` (300); raise that if answers time out.

**Limits.** Each chat allows `aiPerDay` requests (default 3) in any 24 hours, inside the bot-wide `summary.maxPerHour` (4) and `summary.maxPerDay` (12), with `summary.cooldownSeconds` (60) between requests in one chat. A refused request costs nothing and says which limit it hit; `npm.cmd run status` shows each chat's use.

**What can spend AI, and who can start it.** Other members cannot start any AI run:
- On your subscription, summaries, questions and `!bot spot` answer only you.
- With an API key, questions and `!bot spot` answer only you, and summaries do too while `summary.ownerOnly` stays true (the default).
- Messages the spam rules flag are never archived, so they never reach the AI.
- The automatic runs happen only at set times and within their own daily caps: spotting at `reminders.detectTimes`, and condensing after `summary.condenseAt`. The most a chat full of junk messages can cost is those few capped runs.
- Reminders and the to-do list use no AI at all.

## Notes: condensing older messages

With `keepDays` set on a chat (and AI on), the bot condenses only at night: in the three hours after `summary.condenseAt` (04:00 London time, `reminders.timeZone`), checking every 10 minutes, for archived messages older than that many days. With the per-chat gap `summary.condenseEveryHours` (6), that is one batch per chat per night. It sends the oldest batch (up to `summary.maxMessages` and `summary.maxTranscriptChars`, pseudonymised like a summary) together with the chat's current notes, and asks for updated notes: decisions, dates, commitments, rules, shared files and links, open questions. Chit-chat is dropped. Only after the notes are saved are those messages taken out of the archive. A large backlog goes a batch a night, and each pass starts with the next chat in turn. A single message longer than the batch limit is sent whole, never cut, because what is sent is what gets removed.

- **Nothing is taken out when the answer looks wrong.** An AI error, an empty answer, an answer cut off by the token limit, notes longer than `summary.maxNotesChars` (6000), or new notes less than half as long as the longest version of the past week are all refused: the notes stay as they were and the messages stay archived. The log says why. A message deleted for everyone while the AI was working sends the batch round again without it.
- **A cold copy first.** Messages taken out of the archive are first copied, exactly as written, to `data/condensed/<chat id>.jsonl` (owner-only) and deleted from there after `summary.condensedKeepDays` (30; 0 keeps no copy). It is never sent to the AI or read by any command; it is there so a bad run can be undone by hand. Expired copies are removed every hour for every chat, including chats whose condensing was later turned off. Messages deleted for everyone are never copied, and a condensing run also clears them out of the archive file once they are older than `keepDays`.
- **Notes** live in `data/notes/<chat id>.md` (owner-only), one file per chat. Each replaced version goes to `data/notes/history/`: all versions from the last `condensedKeepDays` (at least 7), and the newest 10 beyond that. If you trim a chat's notes by hand, also delete its files in `history/`, or the next run may refuse new notes for being much shorter. `!bot ask` reads the notes; summaries do not. `!bot notes` only tells you their size, because notes can hold things from before someone joined or from messages since deleted; read them on the server with `npm.cmd run notes -- "<chat>"` (PythonAnywhere: `../node/bin/node src/cli.js notes "<chat>"`).
- **Only bare bot commands** (`!bot ping`, `!bot summary 6`, the discovery phrase and the like) are taken out without an AI call. Ordinary messages that start with a word-like buzzword, and commands with text after them, go to the AI.
- **What the AI cannot keep:** phone numbers, emails and link query strings are scrubbed before the AI sees them, so a meeting password inside a link survives only in the cold copy. Keep such links in the chat's hub folder or pin them.
- **Budget:** condensing has its own, separate from summaries and questions: at most `summary.maxCondensePerDay` (4) runs a day across all chats, and one per chat every `summary.condenseEveryHours` (6, at most 24). It never posts anything in a chat. If a chat has to wait (no key, budget used up), the bot's log says so during the night's window.
- Run it now, or preview it: `npm.cmd run condense -- "<chat>" --dry-run`. A real run needs the bot stopped, like `summarise`; the dry run does not.
- The archive's own size limit still applies: each chat file rolls at `archive.maxFileMiB` (20 MiB) and keeps one previous file, so a chat whose backlog outgrows condensing loses its oldest messages at the roll, as it always did.
- With the subscription provider, condensing runs Claude Code on its own, inside the bot. On PythonAnywhere, check its memory first (see the PythonAnywhere section), or WhatsApp may pause during a run.

## Per-chat instructions

You can give the AI standing instructions for one chat, such as "Answer in Traditional Chinese, at most 3 lines" or "Use British English. Call the course CS101." Only you can see or change them.

- **From the chat, on your own account:** `!bot instructions set <text>` saves them and `!bot instructions clear` removes them. `!bot instructions` only says whether there are any and how long they are, since everyone in the chat reads the bot's reply; `!bot instructions show` posts the text itself. (`!bot rules` and `!bot instruction` work too.) Line breaks, Chinese punctuation and emoji are saved as you typed them. Members who try get "Only the owner of this bot can see or change this chat's instructions." and nothing else.
- **From the server, without posting anything in the chat:** `npm.cmd run instructions -- "<chat>" --set "text"`, `--clear`, or no option to show them (PythonAnywhere: `../node/bin/node src/cli.js instructions "<chat>" --set "text"`). It works while the bot runs, and the next AI run uses the change; no restart needed. Use this when you don't want the chat to read what you set.
- **Where they apply:** that chat's summaries, `!bot ask` answers, automatic assistant replies, proposed issue titles and spotted requests. No other chat sees them. They may change language, wording and what to leave out; JSON formats, privacy rules and action permissions stay unchanged.
- **Not for the notes.** Condensing never gets them. The notes are never posted, `!bot ask` answers from them in your chosen language anyway, and a language rule would make the AI rewrite the notes in another language, which the notes' "much shorter" check would then refuse every night.
- **What they can't change:** they go after the bot's own rules, and the AI is told to follow them only where they don't conflict with those, and never to quote or reveal them. Messages and files stay data, never instructions; people stay `Member-xxxx`; the output format and every limit stay as they are. They cost no AI by themselves and never let anyone else start an AI run.
- **Limits and storage:** at most 1000 characters and 20 lines (blank lines count). Hidden and control characters are removed, extra spaces tidied. They are kept in `data/instructions/<chat id>.txt` (owner-only), never in the chat's folder or its GitHub repo, where others could change them. A file edited by hand is checked against the same limits each time it is read; if it breaks them, the AI runs without it and the log, `status` and `!bot instructions` say why. `npm.cmd run status` shows each chat's size. Your own `!bot instructions` commands are left out of the notes; members' messages that happen to start with "rules" or "instructions" are not.

## Reminders and open items

Every chat with receive, send and a buzzword has a list of open items. Anyone the chat lets call the bot (its "who can call" setting) can add to it and close items, including items someone else added; `!bot help` lists the commands. Members can use them only after you have used a command there since the bot started, as with every command.

- **Reminders.** `!bot remind <when> <what>` posts "Reminder N: what" in the chat at that time, as a reply to the message that set it. Times are in `reminders.timeZone` (`Europe/London`, with summer time). Understood: `in 30 min`, `in 2 hours`, `in 3 days`, `in 2 days 5pm`, `today 17:00`, `tomorrow 9am`, `tomorrow 5.30pm`, `tomorrow 5 p.m.`, `Fri 17:00`, `Friday, 5pm`, `on Friday at 5pm`, `20 Nov 14:30`, `Nov 20, 17:00`, `2026-11-20 17:00`, the bot's own `Fri 20 Nov 17:00` (the day name must match the date), and a time alone (today, or tomorrow once it has passed). Punctuation after the time is fine (`tomorrow 5pm: call mum`). The time can come first when the day is clear: `9am tomorrow`, `5pm Friday`, `17:00 on 20 Nov`, or a short day name at the very end (`5pm Fri`). A date without a time means `reminders.defaultHour` (9:00). Anything else is refused with examples, never guessed: something that looks like a time but is not one of these (`1700`, `at 5:3`, `5pm:call`), two times in a row, or a short day name or date after the time in the middle of the text (`5pm sun cream` asks whether "sun" is the day). Reminders can be at most `reminders.maxDaysAhead` (400) days ahead. Only you can put a link in a reminder (anything like `bit.ly/x`, `example.shop`, an IP address or a web address). A chat with send off cannot have reminders.
- **Open items.** `!bot issue <what>` adds one without a time. `!bot issues` lists them, `!bot done N` closes one and `!bot drop N` removes one. A chat holds at most `reminders.maxOpenPerChat` (50) open items. The same text is not listed twice for the same time, so "take the bins out" can be set for Monday and for Thursday, and again for next week. A spotted request with the same text as anything already on the list is not added at all.
- **The list tidies itself** (every 10 minutes, and before each `!bot issues`). An item whose reminder went out (or could not go out) is closed after `reminders.closeAfterDays` (3), but not before that many days past its own deadline, so a request kept with an early reminder stays listed until it is due. Spotted requests nobody kept go after `reminders.suggestionDays` (7) or once their deadline has passed, and a chat keeps at most `reminders.maxSuggestedPerChat` (20): a new one pushes out the oldest. Closed items are forgotten after `reminders.keepClosedDays` (30). Open items without a reminder stay until someone closes them.
- **Posting.** A reminder is the one thing the bot posts without a command at that moment. It was set by a command in that chat, and it still needs send on (checked again just before posting) and goes through the reply budget and pauses. On top of that, at most `reminders.maxRemindersPerChatPerHour` (6) per chat, and reminders may use at most half of `replies.maxPerHour`, so half the reply budget stays for replies to commands. These counts come from the lists themselves, so a restart does not reset them. The rest wait their turn, and each round starts with the next chat. Each is posted once: it is marked as posted just before sending, so a crash at that moment can lose one but never doubles it, and a `drop`, `done` or new time that comes in meanwhile wins. A list that cannot be saved (disk full) posts nothing and uses no budget; the log says so once. A failed send, or one WhatsApp does not confirm within 90 seconds, pauses replies like a failed reply does; that reminder is not tried again, and `!bot issues` shows it as possibly not posted. A reminder that comes due while the bot is stopped, paused or waiting is posted when it can be, unless it is more than `reminders.lateGraceHours` (6, at least 2) late; then it stays on the list, marked as not posted.
- **Spotting requests** never runs around the clock. It runs only at set times or when you ask:
  - **On a schedule:** in chats with `detect` on (a chooser question once AI is on), once in the hour after each time in `reminders.detectTimes` (`["20:00"]`, London time). `[]` means never on a schedule.
  - **When you ask:** `!bot spot`, in any chat with AI on, only from your own account. It looks now and replies with what it found. Two asks need `summary.cooldownSeconds` (60) between them.
  - Either way, the chat's messages since the last look go to the AI in one run, pseudonymised like a summary, with message times in London time. A chat whose spotting was off for a while starts again from one day back, and a chat checked within `reminders.detectEveryMinutes` (60) skips its scheduled run. The chat's list goes along so nothing is suggested twice; it is scrubbed the same way. Bot commands and replies are left out. Messages with nothing that usually marks a request (a number, a day, words like please, need, by, deadline, or their Chinese equivalents) are counted as looked at without an AI run. With the subscription, at most one scheduled run a minute, so your own questions are not kept waiting.
  - What the AI finds goes on the list as "spotted by the AI", at most `reminders.maxSuggestions` (5) a run. A scheduled run posts nothing; `!bot spot` answers you with what it found. If that answer could not be posted (send off, replies paused, reply budget used up), `!bot spot` does not run at all. Links (the same kinds members cannot put in reminders) and long phone or account numbers are taken out of its text, since a message could plant them for the AI to repeat. Someone keeps it with `!bot keep N`, which sets a reminder `reminders.leadHours` (24) before its deadline, or an hour before if that is too soon, or `!bot keep N <when>` for a time of their choosing. In a chat linked to GitHub, `!bot github issue N` keeps it the same way and opens an issue for it too. Anything else is removed with `!bot drop N`, or expires.
  - An answer that is not a JSON list adds nothing, and those messages are not looked at again. A failed run (network, refusal, limits) leaves them for one more try; after a second failure they are skipped, so one chat cannot use up the shared daily limit. A message deleted for everyone while the AI was looking sends the batch round again without it.
  - Its own budget, apart from summaries, questions and condensing: at most `reminders.maxDetectPerDay` (24) runs a day across all chats, and `reminders.maxDetectPerChatPerDay` (3) per chat. Each run sends at most `reminders.maxDetectChars` (20000) characters of messages, the oldest new ones first, and never anything more than a day old. A flood of junk messages therefore costs a few small runs at most. `npm.cmd run status` shows how often each chat was looked at.
  - With the subscription provider, these runs start Claude Code inside the bot on their own, like condensing. Check its memory on PythonAnywhere first.
  - A message deleted for everyone after the AI looked at it can leave its suggestion behind until it expires. `!bot drop N` removes it sooner.
- **On the server:** `npm.cmd run issues -- "<chat>"` prints the list, and `npm.cmd run detect -- "<chat>" [--dry-run]` looks for requests now. A real run needs the bot stopped; the dry run does not. The lists are in `data/items/<chat id>.json` (owner-only).

## File hubs: shared files per chat

A chat can have its own folder of files, `hubs/<name>/`, set with the chooser's last question (`"hub"` in its `chats` entry). In that chat, `!bot files` lists the folder and `!bot send <name>` posts one file as a document (up to `hubs.maxSendMiB`, 25 MB). With the subscription provider, `!bot ask` can also read that folder.

- **One folder, one chat.** Config refuses two chats with the same hub. A chat's commands only ever open its own folder: a file is picked from the folder's own listing, never by a path someone typed, so `../other/x` or a name from another chat finds nothing.
- **Links are skipped** in listings, a hub that is itself a link is refused, hidden files (such as `.git`) are not offered, and the AI is not given a hub that contains links.
- **You fill the folders** on the server, for example through PythonAnywhere's Files page, or from one private GitHub repo per chat with that repo's own read-only deploy key (a deploy key opens one repo only). Nothing a chat sends is saved into a hub.
- **A GitHub repo per chat, kept in step with `!bot sync`.** Set a chat's empty folder up once, on the server: `npm run sync -- "<chat>" --clone git@github.com:OWNER/REPO.git --key ~/.ssh/<deploy key>` (PythonAnywhere: `../node/bin/node src/cli.js sync ...`). Run `ssh -i ~/.ssh/<deploy key> -T git@github.com` once beforehand and confirm GitHub's fingerprint, because the bot's git cannot answer questions. After that, push from your PC and send `!bot sync` in the chat (you only), or run `npm run sync -- "<chat>"`. A folder cloned by hand earlier is moved over with `--adopt`.
  - The git data lives in `data/hub-git/<folder>.git`, not in the folder, so the AI never sees the repo address or key path. The AI does not read a folder that still holds a `.git`. A lock file next to the git data keeps one sync per folder at a time, across the worker and console runs, and the AI takes the same lock while it reads the folder.
  - Files over `hubs.maxSendMiB` (25 MB) are never downloaded: the clone is partial (also after `--adopt`), single-branch and without tags. Before anything changes, the new version is checked, and the pull is refused if a file was left on GitHub for being too big, if there are more than `hubs.maxSyncFiles` (5000) files or more than `hubs.maxSyncMiB` (200 MB) in all, or if the git data on the server has grown past twice that. Downloading a file takes about twice its size in memory inside the WhatsApp worker, so keep files well under the limit.
  - Pulls are fast-forward only: a folder with its own commits, or with files a pull would overwrite, is left as it is. A clone that fails leaves no git data and an empty folder. Nothing typed in the chat reaches git.
  - Nothing in a pushed commit runs a program: hooks, submodules, fsmonitor, background maintenance, LFS and the machine's and your own git settings are all off for the run, and symlinks arrive as plain files holding their target. git gets only PATH, HOME and locale (no API keys or tokens) and no terminal. A run is stopped after 60 seconds (asked to stop, then killed with anything it started).
  - The chat sees a short summary such as "1 file changed", never git's output; details go to the log.
- **Once posted, a file can be forwarded** by anyone in that chat. The hub decides which chat gets a file, not what members do with it afterwards.
- `hubs/` is private like the rest (folders 700, files 600) and the installer never backs it up or restores it.

Both entry points pass through one service in `src/summarise.js`; its provider adapter is private. Before reading a transcript or creating an API client, plain code checks the current allowlist, receive/send/AI permissions, archive switch, caller/owner, the buzzword and summary command for chat requests, pauses, reply availability, and the AI budget. Local CLI requests count as explicit owner requests and need no chat buzzword; CLI summaries refuse while another instance owns the session lock. With `summary.ownerOnly: true` (default), other members cannot request a summary even when callers is anyone. The optional assistant uses the same AI budget and takes its context from the current burst.

Summary input is bounded by `summary.maxMessages` (500) and `summary.maxTranscriptChars` (60000), keeping the newest messages. Oldest messages are dropped whole; if the newest message alone exceeds the character cap, its newest characters are kept. The local summary dry run uses the same size caps. If a summary finishes after another reply uses the reply budget, its full result is printed to the terminal as `[NOT SENT]`. Message times in summaries, questions, condensing and `transcript` are shown in `reminders.timeZone` (London time), not the server's own, and the AI is told so. A question explains why the chat's files were not read: the subscription is off, the folder is missing, being synced, holds a `.git` folder or contains links. It also explains this when there are no recent messages.

AI defaults: at least 3 seconds between attempts, 60 seconds per chat, at most 4 per rolling hour and 12 per rolling day. Attempts are reserved in `.runtime/safety.json` before the provider call; errors consume the reservation, automatic SDK retries are disabled, and restarting/resuming retains the budget. `npm.cmd run status` prints allowed and blocked AI requests with denial reasons. These are request counts, not measured token savings; ordinary/unlisted traffic discarded by routing never makes an AI request and is not included. `transcript` and `summarise --dry-run` stay local and bypass the network gate because they make no API call; the dry run previews archive text, while actual summaries also omit bot replies and commands.

## GitHub: issues, pull requests, files and commits

A chat can be linked to one GitHub repository (`githubRepo` in its `chats` entry). The full command list with examples is in COMMANDS.md under "GitHub"; in short:
- **Opening issues.** `!bot github issue <title>` opens one. `!bot github issue N` turns item N of `!bot issues` into one, with its deadline, and the list then shows "GitHub #12" next to the item; an item becomes an issue only once. N can also be a request the AI spotted that nobody kept yet: it is kept first, with the reminder `!bot keep N` would set, and then opened. It is kept only once the request may go ahead (a token in `.env`, the chat not busy, no wait for a member, the hourly limit not reached, the list not full). If GitHub then refuses, the reply says it was kept and to try again.
- **Reading.** `!bot github issues` and `prs` (10 of each, newest activity first), `pr N`, `#N` (an issue or pull request with its latest comments and their IDs), `#N comments`, `files [folder]`, `file <path>` (the first 60 lines), `commits [branch]` and `commit <id>`. `!bot gh` works the same.
- **Changing (you only).** Comments and labels are added at once. Closing, reopening, a new title or description, deleting an issue, editing or deleting a comment, merging or closing a pull request, writing or deleting a file and reverting a commit each wait for your confirm code (below), and the preview says exactly what will happen.

**What a change can and cannot do:**
- A new title or description is refused if someone changed the issue on GitHub after the preview. A merge sends the commit you saw, so GitHub refuses it if anything was pushed in between. Drafts and pull requests with conflicts are refused before a code is given.
- A file change is one commit through GitHub's contents API, with the version you saw, so GitHub refuses it if the file changed in between. Files up to 200 KB of text; one file at a time.
- A revert builds one new commit that puts the commit's files back as they were before it. It accepts only a commit in the default branch's own history (GitHub's compare says the branch is ahead of it): a commit from a fork or another branch has a parent the branch never had, and "reverting" it would write that parent's files onto the branch. It refuses merge commits, renames, more than 20 files, and any file that changed again after the commit, because a plain revert would quietly undo that later work too. The new commit's parent is the branch head the preview saw.
- File changes and reverts go on a new branch `whatsapp/<date>-<what>` with a pull request into the default branch (`github.changes: "pull"`, the default). With `"direct"` they go straight onto the default branch, which only ever moves forward (never a force-push).
- Deleting an issue uses GitHub's GraphQL API, the only way to delete one, and GitHub allows it only for repository admins. If it is refused, the reply says so and suggests closing.

**Who and how often:** only you change things. Link with `--members` to let members read and open issues; members can't put links in issue titles.
- One GitHub request per chat runs at a time, and members' requests wait `github.cooldownSeconds` (10) after the last one; yours never wait.
- At most `github.maxIssuesPerHour` (10) new issues and `github.maxWritesPerHour` (30) other changes an hour from all chats together, kept in memory (a restart starts the counts again). Every change is logged as `[GITHUB] <chat>: <what>`, never with its text.

**Set it up (once per repository):**
1. On GitHub, create a fine-grained token: **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token** (or edit the one you have).
   - Resource owner: you, or the organisation that owns the repository. An organisation may have to allow fine-grained tokens, or approve this one, before it works; until then the check says the repository was not found.
   - Repository access: **Only select repositories**, and pick the repository.
   - Permissions: **Contents: Read and write**, **Issues: Read and write**, **Pull requests: Read and write**. Metadata: Read-only is added by itself. Changing files under `.github/workflows` also needs **Workflows: Read and write**. Deleting issues also needs admin rights on the repository; whether a fine-grained token needs anything more for it is unconfirmed.
   - Choose an expiry; you'll need a new token when it runs out.
2. Put it in the bot's `.env` yourself: a line `GITHUB_TOKEN=...` (on PythonAnywhere, edit `~/shared-bot-task/whatsapp-spam-bot/.env` on the Files page). Never paste it in a chat. The bot reads it each time, so there is no restart.
3. Link the chat and check the token: `npm.cmd run github -- "<chat>" --repo OWNER/REPO` (PythonAnywhere: `../node/bin/node src/cli.js github "<chat>" --repo OWNER/REPO`). Add `--members` for members too. Run it again without `--repo` to check later; `--off` unlinks. It works while the bot runs.

One token can cover several repositories; pick them all under Repository access. The deploy key used by `!bot sync` stays separate and read-only.

**What goes where:**
- **From the chat to GitHub:** what you type in a GitHub command (titles, comments, descriptions, file contents), and for `!bot github issue N` that item's text (which a member may have written, or the AI may have spotted) with its deadline and reminder times. In a public repository all of that is public.
- **From GitHub to the chat:** titles, comments, file text, branch names and logins, with links and long numbers replaced by `[link]` and `[number]`. Anyone who can open an issue (in a public repository, anyone) could otherwise post a phishing link in the group from your account. A bare domain under an unusual ending (`something.zip`) can still get through, so treat addresses from GitHub with care. Only GitHub's own `https://github.com/` links are posted as they are.

## Google Docs, Sheets and Slides

A chat can be linked to up to 20 Google files (`googleFiles` in its `chats` entry: a short name, the file ID and its kind), with `npm run google`. The bot reaches them through a Google **service account**, a robot identity that sees only the files shared with its email address; a chat reaches only its own linked files, by name. Commands and the step-by-step setup are in COMMANDS.md under "Google".
- **Reading:** `!bot google` lists the files; `!bot doc <name>`, `!bot sheet <name> [range]` and `!bot slides <name>` show them. Only you, unless `--members` (then members can read; only you change).
- **Adding (you, at once):** `doc <name> append`, `sheet <name> add` (a row at the end of the first tab), `slides <name> add` (a slide at the end).
- **Replacing, overwriting, clearing, deleting (you, with a confirm code):** `doc <name> replace`, `sheet <name> set` and `clear`, `slides <name> delete` and `replace`. The preview shows what is there now. Docs and slides are changed only at the revision the preview read, so an edit made in between makes Google refuse. Sheets have no such check.
- Cells are written as RAW values, so text typed in the chat never becomes a formula (`=IMPORTDATA(...)` and the like stay text).
- At most `google.maxWritesPerHour` (30) changes an hour from all chats, each logged as `[GOOGLE] <chat>: <what> in <name>`; one Google request per chat at a time, members' `google.cooldownSeconds` (10) apart; `google.timeoutSeconds` (15) per request.
- Replacing in a doc counts the matches in its main text; other tabs, headers and footers are changed too if they contain the text, and the preview says so. A doc or deck change is offered only if Google reports the revision it read. A sheet clear over more than 200 rows or 26 columns says "at least N cells".

**The key file.** `.env` names it: `GOOGLE_SERVICE_ACCOUNT_FILE=/home/EricH1425/google-key/<file>.json` (a relative path is taken from the bot's folder). Keep it outside the bot's folder so installs never touch it, and owner-only (`chmod 600`): on Linux the bot refuses a key other users could read. It is read at each use, so adding or replacing it needs no restart. The bot signs in with its own signed request to `https://oauth2.googleapis.com/token` (whatever the file says), talks only to Google's API hosts, never follows redirects, and never shows the key or its access token in a reply or a log.

**What goes where:** the text you type in a Google command goes into that file. What a file says goes into the chat when someone reads it, with links and long numbers shown as `[link]` and `[number]` as for GitHub: anyone who can edit a shared file could otherwise get the bot to post a phishing link from your account.

## AI drafts

`!bot draft doc|sheet|slides <name> <what you want>`, `!bot draft github #N <what you want>` and `!bot draft github file <path> <what you want>` (you only) ask the AI to draft one change. The bot reads the target first and sends the AI your request, the target as it is now (up to 15,000 characters of a doc, A1:Z200 of a sheet's first tab, a deck's slide texts, an issue with its last 10 comments, or a text file up to 30,000 characters), the actions allowed for that target, the last 24 hours of messages (pseudonymised as for questions) and the chat's notes. It never reads the chat's file folder for a draft.
- It is one AI request, with the same budget, cooldown and owner-only rule as `!bot ask`, at the chat's effort.
- The AI answers with one JSON object. The bot checks it against what that target allows (src/drafts.js): text to add or one replacement in a doc; a row or a block of cells in a sheet; a slide or a replacement in a deck; a comment, description or title for an issue; the whole new file for a repository file. Anything else, broken JSON or an answer cut off at the length limit is refused and nothing waits.
- **Every draft waits for your confirm code**, additions too, and the preview starts "Drafted by the AI."
- Links in the draft that were not already in the target become `[link]`, because someone in the chat could have planted one for the AI to copy into your file.
- **The preview shows the whole draft**, or the draft is refused: text up to about 1,500 characters and 30 lines, up to 10 rows of cells of at most 100 characters, and a file change of at most 60 changed lines, each listed (a longest-common-subsequence line diff, so a moved line shows as removed and added).
- A drafted file change always goes on a new branch with a pull request, whatever `github.changes` says.
- The version the AI drafted from (the file's sha, the issue's update time, the doc's or deck's revision) is checked again before the change is offered; if someone changed the target meanwhile, the draft is refused.
- The prompt tells the AI that the file and the messages are data, never instructions. Read the preview before you confirm anyway.

## Confirm codes

A change that removes, closes, merges or replaces something, and every AI draft, replies with a preview and a 4-digit code. `!bot confirm <code>` in the same chat, from your own account, within 2 minutes, makes the change once; `!bot confirm` alone lists what is waiting and `!bot cancel [code]` drops it. At most 5 changes wait per chat (a sixth pushes out the oldest). If the chat is busy with another request or the hourly limit is reached, the confirm says so and the code stays valid. Waiting changes are kept in memory only, so a restart forgets them all and an old code can never make a change later. While replies are paused, commands still run: a confirmed change happens but its reply is not posted.

## Ideas board and findings

Each chat with a buzzword has an ideas board. The team saves ideas as they come; when you ask, the AI turns them into findings, which are kept and built on.

- **Ideas, no AI:** `!bot idea <text>` saves one, and `!bot ideas` lists them (the newest 30 when there are more). Anyone the chat lets call the bot can add ideas; members can't put links in them. The same idea is not saved twice. You remove one with `!bot ideas drop N`, or all of them with `!bot ideas clear`; the findings stay.
- **Findings, AI, you only:** `!bot findings` runs one AI request. It reads the saved ideas (the newest 100), the last findings, the chat's notes and the last 24 hours of messages, plus the chat's files on the subscription. It writes themes, the strongest ideas and why, open questions and next steps, posts them in the chat and saves them. The next findings build on them, and every `!bot ask` in that chat reads the latest ones too. `!bot findings show` posts the last saved findings again without the AI.
- **On GitHub:** `!bot findings github` does the same and also opens a GitHub issue "Findings – <date>" in the chat's linked repository (see "GitHub issues and pull requests"). If that fails, or GitHub is busy, the findings are still saved; `!bot findings post` sends them later without a new AI run.
- **Limits:** a findings run is an AI request like `ask`: owner only, AI on, the chat's `aiPerDay`, the cooldown and the bot-wide hourly and daily limits. A chat holds at most 200 ideas, and members can fill at most 150 of them, at most 20 an hour, so a member can't crowd out your own. The last 10 findings are kept, oldest dropped first.
- **What the AI is told:** the ideas, the earlier findings, the notes, messages and files are data, not instructions, and nothing that reads like an instruction is carried into the findings. Ideas are scrubbed like a transcript (phone numbers and emails out, people pseudonymised) before the AI sees them. Links and long numbers in the AI's findings become `[link]` and `[number]` before they are posted, saved, reused or sent to GitHub.
- **What goes where:** ideas and findings stay on the server in `data/ideas/<chat id>.json` (owner-only). `!bot findings github` sends the findings text to GitHub; it is written from the ideas, the notes, the messages and, on the subscription, the chat's files, so names typed in the chat can be in it. In a public repository that is public.
- **On the server:** `npm.cmd run ideas -- "<chat>"` (PythonAnywhere: `../node/bin/node src/cli.js ideas "<chat>"`) prints the ideas and the latest findings. `summarise "<chat>" --findings` writes new findings from the console, with the bot stopped.

## Send limits and warning replies

Everything the bot posts on request goes through one budget (`replies`): at least 3 seconds between messages, 5 seconds per chat, at most 30 per hour and 200 per day. A failed send pauses further replies until you review and resume. A chat with send off never receives anything, whatever the budget.

Optional spam warning replies (`warning.enabled`, off by default) reply to a flagged message with a short review request, only after a successful owner command reply in that same chat during this run and only in chats where receive and send are still on, within their own small budget: 4 per hour, 12 per day, 5 minutes per group and 120 seconds per sender.

## Connection, deletion, reply and admin pauses

Only one copy can use the session at a time. Conflict, authentication failure, logout, blocked states or a WhatsApp Web startup failure persist a connection pause. A Chrome that never started does not, because nothing reached WhatsApp. The bot stops instead of automatically reconnecting or taking over another session. A worker crash leaves a lock that must be reviewed manually. A CLI summary lock marked `purpose: "summary"` is automatically reclaimed only when its process has ended: on the same machine, when the process is gone; from another machine, after 3 minutes without its sign of life. This preserves pauses and budgets. Live processes still block a second instance. Locks from older versions without that marker require the reviewed recovery below.

1. Check the official WhatsApp phone app for warnings, restrictions or unfamiliar linked devices. If WhatsApp restricts the account, stop using the bot and follow the official review process.
2. Close the bot and resolve the cause. Do not repeatedly relink, delete the session, rotate numbers or change IPs to get around enforcement.
3. If the account is unrestricted and the cause is resolved, run the command below. It clears local connection, deletion, warning, reply and admin pauses and any stale process lock, keeps all budgets, and does not connect to WhatsApp.

```powershell
npm.cmd run resume -- --reviewed
```

On PythonAnywhere, where there is no npm: `cd /home/EricH1425/shared-bot-task/whatsapp-spam-bot && ../node/bin/node src/cli.js resume --reviewed`. The pause message prints the right command for the machine it runs on.

Open `START.cmd` separately when ready. Resuming cannot unban an account. Saved safety state lives in `.runtime/`; do not delete it to reset a budget or ignore a warning.

## Commands

Run these inside this folder. `demo`, `check`, `status`, `transcript` and `test` work offline without a WhatsApp login.

```powershell
npm.cmd start                       # start silently; discovery works before chats are enabled
npm.cmd run setup                   # choose chats, then run
npm.cmd run chats                   # list chats and IDs, then exit
npm.cmd run status                  # chat settings, archive size, pauses
npm.cmd run transcript -- "<chat>"  # archived messages
npm.cmd run summarise -- "<chat>"   # summary via the Claude API (add --ask "question", --effort high)
npm.cmd run condense -- "<chat>"    # fold messages older than keepDays into the chat's notes now
npm.cmd run issues -- "<chat>"      # the chat's open items, reminders and spotted requests
npm.cmd run detect -- "<chat>"      # look for requests in the chat's new messages now (bot stopped)
npm.cmd run instructions -- "<chat>" --set "Answer in Traditional Chinese"   # the AI's standing instructions for one chat
npm.cmd run github -- "<chat>" --repo OWNER/REPO   # link the chat to a GitHub repository and check GITHUB_TOKEN
npm.cmd run google -- "<chat>" --add "<link>" --name plan   # link a Google Doc, Sheet or Slides file; without --add, list and check them
npm.cmd run demo
npm.cmd run check -- "free money https://bit.ly/example"
npm.cmd test
```

`<chat>` is a label or ID from `chats`. For macOS/Linux, use `npm ci --ignore-scripts`, then `node src/install-browser.js` and `npm start`. Linux may require additional Chrome system packages; see the [Puppeteer troubleshooting guide](https://pptr.dev/troubleshooting).

## Local data and stopping

Press **Ctrl+C** or close the terminal to stop. The computer must stay awake and online.

| Path | Contents | Keep private |
| --- | --- | --- |
| `.wwebjs_auth/` | the linked session; anyone with it can read your chats | yes |
| `data/archive/` | archived message text for chats you set up | yes |
| `data/notes/` | each chat's notes from condensing older messages, and their earlier versions in `history/` | yes |
| `data/hub-git/` | the git data of hub folders kept in step with a repo (`sync --clone`) | yes |
| `data/condensed/` | copies of messages condensing took out of the archive, kept `summary.condensedKeepDays` (30) | yes |
| `data/items/` | each chat's open items, reminders and spotted requests | yes |
| `data/instructions/` | your standing instructions for the AI, one file per chat | yes |
| `data/pseudonym.secret` | the key behind `Member-xxxx` labels | yes |
| `data/chats.tsv` | chat names and IDs | yes |
| `data/discovered-chats.json` | metadata found by your exact discovery phrase; never an allowlist | yes |
| `data/learned-spam.json` | fingerprints and links of spam you marked | yes |
| `data/members.json` | people you trusted or removed | yes |
| `logs/` | flags and deletion outcomes; the text of deleted messages (`keepDeletedText`), and of every flag only if `logMessageText` is true | yes |
| `.runtime/` | pauses, budgets and the instance lock | do not delete |
| `.env` | your API key or subscription token (`CLAUDE_CODE_OAUTH_TOKEN`), and `GITHUB_TOKEN`, if any | yes |
| `hubs/` | each chat's shared files | yes |

All of these are in `.gitignore`. To revoke the bot's access, unlink the device in WhatsApp on your phone.

**Owner-only access (Linux and macOS).** Everything the bot and its browser create is readable by your account only (umask 077). Before `start`, `setup`, `choose`, `chats` and `groups`, the bot also removes other accounts' access from older files: the bot folder itself, everything under `.wwebjs_auth/`, `data/`, `logs/`, `.runtime/` and `hubs/`, plus `.env` and `config.json` (folders 700, files 600). It prints what it changed. The PythonAnywhere installer does the same, also for `shared-bot-task-backups/` (which also holds the supervisor deployment's older snapshots; their contents are unchanged, only other accounts' access is removed), and prints each change as before -> after. Symbolic links, hard-linked files and anything on another drive are left as they are and reported, since they may be someone else's file. This protects against other accounts on the machine, not against your own programs: the Telegram bot runs as the same user and can still read these files. If `SPAM_BOT_CONFIG` points at a config elsewhere, that file is not locked down (the bot still writes it 0600). Windows controls access with ACLs and is skipped.

## PythonAnywhere setup

The existing supervisor needs a linked session and at least one group in groupIds. Direct-only setups cannot arm. Keep the hosted WhatsApp worker idle throughout discovery and choosing; do not run a console copy alongside it.

Upload **whatsapp-spam-bot-update-20261110.zip** to your PythonAnywhere home directory. Run this in a PythonAnywhere Bash console.

```bash
cd ~ && python3 -m zipfile -e whatsapp-spam-bot-update-20261110.zip wa-update-20261110 && python3 -B wa-update-20261110/whatsapp-spam-bot/tools/install_on_pythonanywhere.py
```

The installer refuses a running worker or an instance lock. It backs up code/config only, deep-merges owner settings over defaults, replaces lists whole, and merges strictRules by name so an owner's delete action survives while new rules arrive. A config with no deletion.mode gets strict. Offline tests use a disposable copy with shipped defaults. Until tests and merged-config validation pass, live config.json stays untouched, including on a failed rerun. The installer does not link, start, arm, change the supervisor or change Telegram. If the host's Node has no `bin/npm`, it runs npm from `node/lib/node_modules/npm/bin/npm-cli.js`.

The installer runs `node --test` on the disposable copy. Add `--full` to also run the simulated end-to-end check, which takes about 2 minutes.

**Do not use `--skip-npm` for this update.** The npm step installs whatsapp-web.js from `vendor/`, built from upstream main at commit 064a3d5 (28 Sep 2026). npm's 1.34.7 cannot read any message since WhatsApp Web's July 2026 update renamed the ID field `_serialized` to `$1`, so every message was dropped in silence. Skipping npm leaves the old library in place, and the installer's checks then stop the install.

Then follow this order (the installer prints equivalent commands using shared.json's CHROME_PATH when present):

1. **Start in the console for discovery.** This reads CHROME_PATH from shared.json or your console environment; if neither supplies it, set it to the installed Chrome executable first. Use the private Node and host sandbox opt-in:

```bash
cd /home/EricH1425/shared-bot-task/whatsapp-spam-bot
export CHROME_PATH="$(python3 -c 'import json,os; from pathlib import Path; p=Path("../shared.json"); c=json.loads(p.read_text()) if p.exists() else {}; print(c.get("whatsapp",{}).get("env",{}).get("CHROME_PATH") or os.environ.get("CHROME_PATH",""))')"
env -u SPAM_BOT_UNATTENDED CHROME_PATH="$CHROME_PATH" SPAM_BOT_NO_SANDBOX=1 /home/EricH1425/shared-bot-task/node/bin/node src/cli.js start
```

Scan the QR on your phone if asked. Type exactly your configured discoveryPhrase (default !bot discover) in each chat, read the [DISCOVERED] lines in this console, then press **Ctrl+C**. Console discovery output is here; the supervised worker's output later goes to state/whatsapp.log.

2. **Choose chats with the same environment**, including at least one group with receive or join screening enabled, then finish the chooser:

```bash
cd /home/EricH1425/shared-bot-task/whatsapp-spam-bot
env -u SPAM_BOT_UNATTENDED CHROME_PATH="$CHROME_PATH" SPAM_BOT_NO_SANDBOX=1 /home/EricH1425/shared-bot-task/node/bin/node src/cli.js choose
```

3. **Arm only after reviewing those settings:**

```bash
cd /home/EricH1425/shared-bot-task && python3 -B supervisor.py arm-whatsapp --reviewed
```

**Memory: set `max_rss_mb` to about 4096.** Every half second the supervisor adds up the memory of every process in the WhatsApp worker's tree. It pauses WhatsApp (Telegram keeps running) once that passes `max_rss_mb` in shared.json, without recording why.
- With a linked account, Chrome's dozen processes add up to about 2.3 GB this way within half a minute of starting (measured 6 Nov 2026). Memory they share is counted once per process.
- The old figure of 1.28 GB was measured before the phone was linked, and a limit of 1536 stops WhatsApp seconds after every start.
- PythonAnywhere's own limit is 3 GB per process ([RAM limits](https://help.pythonanywhere.com/pages/RAMLimit)), not per tree. A Claude Code run adds about 200 MB to the tree.
- The supervisor reads shared.json only when it starts, so restart the always-on task after changing it.

**Chrome's profile lock.** Chrome marks the WhatsApp profile as in use, and removes the mark when it closes normally. A Chrome that was killed leaves it behind: a supervisor stop does that, and so does Ctrl+C in a console. A Chrome on another machine then refuses the profile, and on PythonAnywhere the consoles and the always-on task run on different machines.
- The bot clears such a leftover itself before starting, and reports it in its log. It can be sure no other copy of the bot is running anywhere because it holds its instance lock (`.runtime/instance.lock`).
  - That lock records the machine and process holding it, plus a sign of life written every minute.
  - A lock from another machine counts as left over only after 3 minutes without one, both for `resume` and for taking over a console summary's lock. So running `resume` in a console while the worker runs elsewhere is refused instead of breaking its lock.
- A lock from another machine is also kept while the profile changed in the last 3 minutes, in case a Chrome outlived its bot. Start again a few minutes after a stop.
- A lock held by a Chrome still running on the same machine is left alone, and the bot says so without starting. On Linux, a process number that now belongs to something other than that Chrome doesn't count.
- A Chrome that cannot start at all (it fails, or never answers) no longer records a connection pause, since nothing reached WhatsApp.

**Measure a Claude Code run** in a console while the worker is stopped, before turning on `summary.provider: "claude-code"` or `keepDays`. The snippet shows the largest single process, which is Claude Code's own size, not the total the supervisor counts:

```bash
cd /home/EricH1425/shared-bot-task/whatsapp-spam-bot && python3 -c 'import resource, subprocess, sys; subprocess.run(sys.argv[1:]); r = resource.getrusage(resource.RUSAGE_CHILDREN); print("Peak memory %d MB, CPU %.1f s" % (r.ru_maxrss // 1024, r.ru_utime + r.ru_stime))' ../node/bin/node src/cli.js summarise "<chat>" --ask "Which files can you see? One line."
```

The installer prints an exact **python3 -B .../install_on_pythonanywhere.py --root ... --undo <archive>** command. Use that command while the worker is idle to restore the backed-up code/config and remove files the update added, using the manifest beside the archive. Keep the archive and manifest together. Undo leaves current .runtime, data, logs, .wwebjs_auth and node_modules intact, preserving block pauses, AI budgets and learned spam. It also preserves .env and browser caches. Do not restore an old tar archive over live runtime state.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| A Google reply says an API "is not turned on" | In the service account's Google Cloud project, APIs & Services → Library, enable the Google Docs, Sheets, Slides and Drive APIs, then wait a few minutes. |
| A Google reply says "share the file with ..." or "not found" | Share that file with the service account's email (the `client_email` in the key file): Editor to change it, Viewer to read it. |
| A GitHub change says "the token may not do that" | Give the token Contents, Issues and Pull requests: Read and write (Settings → Developer settings → Fine-grained tokens → edit). |
| `node` is not recognised | Install Node.js 22 or newer, then reopen the launcher. |
| Cannot find Chrome or a package | Run `SETUP.cmd` again, or install Google Chrome. You can also set `CHROME_PATH` to an existing Chrome/Edge executable. |
| A chat is missing from the list | Older direct chats are only in `data/chats.tsv`; paste the ID. For groups, add the linked account to the group first. |
| The buzzword does nothing | The chat needs receive on, and the message must start with the buzzword. Check the terminal for `[NOT SENT]` or `[IGNORED]`. |
| `[NOT SENT] reply budget or pause` | Wait a few seconds between calls, or run `npm.cmd run status` to see whether replies are paused. |
| Spam is flagged but not deleted | Expected: rules only flag. Reply `!bot spam` to it (from your own phone), block its domain, or switch that rule to `"action": "delete"`. Also check the chat's spam setting is `delete`. |
| `!bot kick` or `!bot lock` did nothing | Check the terminal: `you-are-not-admin`, `target-is-admin`, `not-a-current-member` or an admin pause (`npm.cmd run status`). |
| `!bot spam` did nothing | It must be a reply to someone else's message, sent from your own account, in a chat with receive on. Check the terminal for `[MARKED]` or `[MARK]`. |
| Disconnected, login failed, or instance lock found | Follow the pause procedure above. Check the phone app before attempting another connection. |
| `Connection paused after STARTUP_FAILURE` | WhatsApp Web did not finish loading. The line before it, `WhatsApp startup failed: ...`, says why (in the console, or in `state/whatsapp.log` for the hosted worker). Fix that, check the phone's Linked devices, then run the resume command the message prints. |
| The hosted worker goes from `running` to `paused` within seconds, `whatsapp_exit: 0`, and the log stops after its first lines | The supervisor stopped it: usually `max_rss_mb` too low for Chrome (see "Memory" above), otherwise `daily_cpu_seconds` used up (`state/whatsapp.cpu.json`). |
| `The WhatsApp browser profile is locked (...)` | Either a Chrome on this machine still has the profile open, or a Chrome elsewhere used it less than 3 minutes ago. The message says which. Wait a few minutes, or stop that Chrome, then start or arm again. No pause was recorded. |
| `The bot is still running (process … on …)` when you run `resume` | Another copy, for example the hosted worker, holds the instance lock and showed a sign of life within 3 minutes. Stop it first (`python3 -B supervisor.py status`). |
| `Chrome could not start, so no WhatsApp connection was made` | Chrome itself failed (the line before says why). Nothing to check on the phone; fix the cause and start or arm again. |
| `this chat's limit of N AI requests a day is reached` | That chat's `aiPerDay`; raise it with the chooser, or wait until the oldest request is 24 hours old. |
| A reminder was not posted | The chat needs send on, and replies must not be paused (`npm.cmd run status`). A reminder more than `reminders.lateGraceHours` late is not posted; the log says `[REMINDER] ... not posted` and `!bot issues` shows it as missed. |
| `!bot remind` answers "Start with when" | Put the time first: `!bot remind Fri 17:00 submit report`, not `!bot remind submit report on Friday`. |
| The AI ignores a chat's instructions | `npm.cmd run instructions -- "<chat>"` shows what it has. They apply only where AI is on, and never against the bot's own rules: an instruction to name people, follow what a message says, or write more than the format allows is not followed. |
| Nothing is ever spotted in a chat | The chat needs AI and `detect` on (`npm.cmd run status` shows "spots requests"), an API key or subscription, and new messages. The log shows when a chat waits for the AI budget. |
| Stuck at "Account linked. Loading chats..." | WhatsApp Web is loading inside Chrome; the log shows "WhatsApp Web loading: 25%" and so on as it goes. If it is not done `startup.readyTimeoutSeconds` (300) after the login, the bot stops by itself with "did not finish loading". It doesn't keep Chrome busy, which on PythonAnywhere used up the supervisor's daily CPU budget in 10 minutes. Nothing is recorded against the account. Check CPU Usage on the Dashboard, then start or arm again. A first link on a large account can take longer; raise `startup.readyTimeoutSeconds` for it if the percentage was still rising. |

## Verification

See `VERIFICATION.txt`. `npm.cmd test` runs the offline tests; `node tools/e2e/run.js` runs the bot end to end against a simulated WhatsApp client in a temporary copy. Together they cover routing, permissions, strict rules, the deletion fallback, the archive and budgets. They do not demonstrate a real WhatsApp login, delivery, removal or ban avoidance.

## Credits and licence

The assistant's reply and task-selection rules are adapted from [chat-agent](https://github.com/Adellama75/chat-agent) (AGPL-3.0-or-later), reviewed at commit `1e26f40f2b15c212dc2fdb318c242254f81bd8b8` on 16 November 2026. The runtime rules in `src/summarise.js` lead with outcomes, keep replies short, distinguish proposed/tested/live work, and avoid private-life details and speculative tasks. They apply to both API and Claude Code providers; the bot does not load external `CLAUDE.md` files. Chat permissions and GitHub opt-ins remain enforced by this bot's own code.

The chat index, chat settings that reload without a restart, the archive format, pseudonymised transcripts and the summary prompt are adapted from [whatsapp-reader](https://github.com/Adellama75/whatsapp-reader) (AGPL-3.0-or-later; full text in `LICENSE-AGPL-3.0.txt`). Its Go bridge, systemd services and GitHub-issue agent are not included. Using this privately has no extra obligations; if you share a modified version, or run it as a service for other people, the AGPL requires you to publish the source.
