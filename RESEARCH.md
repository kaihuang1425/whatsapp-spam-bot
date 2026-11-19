# Account-risk research

Checked 22 October 2026. Scope: a keyword spam detector watching an existing WhatsApp group. The owner chose to retain live monitoring despite the remaining account risk.

## Finding

There is no verified setting that makes an unofficial WhatsApp Web bot immune to restrictions. WhatsApp explicitly warns that linking unofficial clients can lead to temporary or permanent bans. Low message volume does not remove that separate client risk. The linked-device guidance is particularly relevant to this QR-linked implementation. [WhatsApp: linked devices](https://faq.whatsapp.com/378279804439436/), [WhatsApp: unofficial apps](https://faq.whatsapp.com/1217634902127718/).

The library itself warns that it cannot guarantee users will avoid being blocked. Its browser-based design does not constitute WhatsApp approval. [whatsapp-web.js README](https://github.com/wwebjs/whatsapp-web.js#disclaimer).

## Measures selected for this bot

These controls reduce avoidable activity, duplicate sessions and repeated errors. They are engineering precautions, not WhatsApp-approved rates or measured reductions in ban probability.

| Measure | Implementation and limit |
| --- | --- |
| Local alerts; optional account actions | Warning replies remain off. Following the owner's later request, deletion is now enabled in the supplied config; set `deletion.enabled: false` for passive review. Neither mode is an official exemption. |
| One bot process and a persistent session | A local process lock prevents two copies sharing the session. Keep LocalAuth; do not delete credentials or repeatedly scan QR codes as a routine restart procedure. This protects session integrity, not account eligibility. |
| Stop after session/account failures | Persist a pause after authentication failure, logout, conflict or reported blocked states. Restarting does not silently reconnect. The operator must check the official phone app and clear the local pause manually. |
| Strict optional warning budget | At most 4 attempted replies per rolling hour and 12 per rolling 24 hours, with a 5-minute group cooldown and the existing sender cooldown. Reservations survive restarts; a send error pauses warnings. These are deliberately small local limits, not established safe thresholds. |
| Bounded account actions | Only selected groups are scored. Group-message deletion now requires admin capability and confirmation, with persistent attempt limits. There are no unsolicited DMs, bulk sends, automatic joining, contact harvesting, account reports, member removal or blocking. Unhandled flags require manual review. |

WhatsApp's current messaging guidelines, updated 23 September 2026, cover groups and communities, identify unwanted contact/spam as violations, describe automated and human review, and allow account restrictions. Avoiding unwanted automated output is therefore relevant. The guidelines do not publish a bot-safe sending allowance. [WhatsApp Messaging Guidelines](https://www.whatsapp.com/legal/messaging-guidelines).

The library documents persistent LocalAuth sessions and the `takeoverOnConflict` option. We preserve the session and explicitly disable takeover. Neither setting is advertised here as an anti-ban feature. [LocalAuth](https://wwebjs.dev/guide/creating-your-bot/authentication.html), [Client options](https://docs.wwebjs.dev/Client.html).

## What first-hand reports show

In issue #532, opened in February 2021, a promotional sender reported bans despite one-minute spacing and other changes. A project member explained why that bulk-messaging use case was likely to be flagged. This is old and concerns marketing, not passive group moderation, so it supports caution about simplistic delay advice rather than a numerical risk estimate. [Original report and maintainer discussion](https://github.com/wwebjs/whatsapp-web.js/issues/532).

Issue #1872 includes a March 2024 report of a ban on login before sending messages, and earlier comments that changing a user-agent did not fix the issue. It contains contradictory, uncontrolled advice. It establishes that users have reported failures even without a sending workload; it does not establish the mechanism or how often this happens. [Original discussion](https://github.com/wwebjs/whatsapp-web.js/issues/1872).

Issue #3594, opened in June 2025, reports an unofficial-client warning during QR connection and was closed as not planned/duplicate. The reporter's version details are inconsistent with normal library versioning, so this is weaker evidence than the official warning or the library's own disclaimer. [Original report](https://github.com/wwebjs/whatsapp-web.js/issues/3594).

A recent Reddit author reported restrictions with two numbers after using Web/Desktop, while also disclosing earlier WhatsApp automation on that computer. The report has uncontrolled account, device and network history. It cannot prove an IP blacklist, identify a detection mechanism, or predict this bot's outcome. [First-hand Reddit report](https://www.reddit.com/r/whatsapp/comments/1vwstew/whatsapp_web_seems_to_trigger_account/).

I did not find credible controlled evidence for a protective warming period, a safe number of messages, sleeping overnight, running under PM2, changing user-agents, using a VPN/proxy, rotating numbers, or adding random delays. The report threads contain such suggestions, but not reliable validation. Those techniques were not added. In particular, switching numbers or identities after enforcement is not a substitute for resolving the restriction.

## Official alternative

WhatsApp's Business Platform is the authorized route for supported programmatic messaging, with documented onboarding and policy obligations. It can still be restricted for poor quality or violations. Simply installing the Business phone app does not make this unofficial client an approved API integration. [Official platform](https://whatsappbusiness.com/products/business-platform/), [official onboarding](https://whatsappbusiness.com/resources/resource-library/api-onboarding/).

I attempted to verify Meta's current Groups API documentation directly, but both the overview and get-started pages returned HTTP 429 to the research tool. I have therefore not treated third-party descriptions of eligibility, participant limits, or support for joining existing consumer groups as confirmed current facts. Do not buy a provider plan or migrate this group on that assumption. The specific account and existing-group workflow need confirmation against the [official Groups API documentation](https://developers.facebook.com/documentation/business-messaging/whatsapp/groups) before any migration.

If account preservation becomes more important than live automation, the lower-exposure alternative is to export the chat using the official app and run the keyword detector on local text, without linking this client. That removes this tool's live account access; it does not promise immunity from unrelated WhatsApp enforcement. [Official chat export instructions](https://faq.whatsapp.com/1180414079177245/).

## Operating recommendation

Keeping warning replies and deletion disabled minimizes automated actions. The owner subsequently requested deletion and accepted local moderator flags, so the current config enables deletion with 20/hour and 100/day attempt caps, a 2-second interval and a durable pause on errors or missing confirmation. These are implementation choices, not evidence of a safe enforcement threshold. Protect the saved session and QR code, use the official phone app to check any account warning, and stop at the first restriction. A separate legitimate bot account limits the impact on a personal account but does not prevent a ban and must not be used to evade an existing restriction. No account has been linked or tested against enforcement during development.
