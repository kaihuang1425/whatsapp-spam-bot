# PythonAnywhere hosting check — 22 October 2026

The existing paid-account always-on slot now selects a shared supervisor for Telegram and an optional WhatsApp worker. Chrome 156 installation, offline rendering, public WhatsApp Web HTTP 200 and the approved 1.5 GiB resource gate all passed before the task switch. The owner supplied a successful post-switch `/health` reply; Telegram readiness is operator-confirmed.

WhatsApp remains unlinked with zero selected groups and waits for explicit arming. No WhatsApp message has been received, sent or deleted. Follow `../shared-bot-task/WHATSAPP_SETUP.md` after Telegram readiness is confirmed.

| Item | Observed result |
| --- | --- |
| Runtime | Private Node v22.23.4/npm 10.9.9, pinned whatsapp-web.js 1.34.7/Puppeteer 24.38.0 |
| Browser | Private Chrome for Testing 156.0.8078.47; 301 files extracted and CRC/path checked |
| Full browser-tree gate | Peak aggregate RSS 1,275,633,664 bytes, 12 processes, 2.11 sampled CPU-seconds; clean exit and zero live tracked processes |
| WhatsApp offline tests | 71 passed locally and on the host |
| Supervisor tests | 15 passed on Linux; Windows 10 passed, 5 Linux cases skipped |
| Telegram preservation | Existing source/configuration/dependencies/database unchanged; original environment and cwd inherited by child |
| Host protection | Fresh verified online SQLite backup; exact 23-file manifest; protected source/configuration snapshots |
| Shared task | Original approved task reused; legacy task stopped and daily task disabled |
| Phone/group/deletion acceptance | Pending |

The 768 MiB and 1 GiB trial caps stopped the browser, so the owner explicitly approved one 1.5 GiB test. It passed. The final cap is 1,536 MiB aggregate descendant RSS, 1,000 sampled CPU-seconds/day and a 5 MiB launcher log. RSS can double-count shared pages; sampling is not a hard OS quota. The public-page smoke does not establish steady-state memory for a linked account.

The account dashboard showed 5 GB disk and 5,000 CPU-seconds/day; 1.2 GB disk was used at the 15:37 UTC snapshot. These figures are historical and must be refreshed before later changes. Both workers share account CPU/storage limits and host availability.

The owner approved running only the WhatsApp browser without its sandbox. This reduces isolation from other account files. Telegram does not inherit that setting. The unofficial WhatsApp client can still be restricted or banned; no automatic account rotation or enforcement-avoidance mechanism is implemented.

Deletion is enabled at score 5 for explicitly selected groups, requires group admin rights, exempts administrator senders, and requires a matching revoke confirmation. Errors or missing confirmation pause removals. Flags and outcomes remain in private local JSONL logs; automatic WhatsApp reports and Telegram moderator alerts are not installed.

See `../shared-bot-task/DEPLOYMENT.md` for exact task command, archive/hash provenance, backup evidence, tests and rollback.

- [PythonAnywhere always-on tasks](https://help.pythonanywhere.com/pages/AlwaysOnTasks/)
- [PythonAnywhere RAM limits](https://help.pythonanywhere.com/pages/RAMLimit/)
- [PythonAnywhere CPU allowance](https://www.pythonanywhere.com/tarpit/)
- [whatsapp-web.js authentication](https://wwebjs.dev/guide/creating-your-bot/authentication.html)
