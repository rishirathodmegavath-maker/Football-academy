# Roles and invitations (football)

Written for: an academy owner running the football app.

## Who can do what

There is **one owner per academy**, and the owner controls everything: academy settings, venues, batches, players, sessions, fees, reports, invitations and removing access. There is no Admin role to invite; the server refuses an Admin invitation.

| Person | What they are | What they can do |
| ------ | ------------- | ---------------- |
| Owner  | Creates the academy. One per academy | Everything |
| Coach  | Staff member with a login | Works with the players, sessions and records assigned to them. Cannot invite or remove people or change academy settings |
| Parent | A guardian with a login | Sees only the child (or children) the owner linked to them: reports, schedule, fees |
| Player (joined by a player link) | A child's own login, created through a player link (below) and confirmed by you. Under 18 | Sees Home (announcements and the next session), Schedule and More. **The server** refuses everything written for parents and guardians: reports and their PDFs, progress, plans and the practice section built from them, updates, private conversations (the player cannot start or read one, and staff cannot address one to the player), dietary notes, fees and fee reminders, the delivery history and contact settings. Staff messages, reminders, WhatsApp and email are never addressed to this login. Hiding a menu item is not what enforces any of this |
| Player (older own login) | A person with their own login made before player links existed (an adult, or a young person with no parent in the academy) | Unchanged by player links: sees only their own record, reports, schedule, fees. These accounts are not marked and no rule above applies to them. See "Older own-login accounts" |

A player can be added two ways under **Players**: **Add player** (you type the details) or **Add player with invitation link** (the player fills in their own details and you confirm them). A child whose parent is invited needs no login of their own.

Admin memberships that already exist in stored data keep working; nothing was deleted or converted. New ones cannot be created.

## How to invite someone (one link, one step)

Open the academy, then **Settings, Team, Invite people**.

1. Choose **Coach**, **Parent** or **Player**.
2. Enter their email address.
3. For a parent, tick their child (or children). For a player, choose the player. Tick the confirmation that this really is the child's parent or the player themselves.
4. Press **Create invitation link**.
5. **Copy link** (or **Share on WhatsApp**, which opens your own WhatsApp with the message ready; nothing is sent for you) and give it to them.

**What the person does**
1. Opens the link. It says which academy invited them and in what role, and their email address is already filled in.
2. Chooses a name and a password (or continues with Google, using that same email address).
3. They are inside the academy.

Opening the link also confirms their email address, so there is no second email to wait for.

## Add player with invitation link

**This feature is switched off by default.** It makes a login for a person under 18, and parental consent for a child's data is a legal question this software does not answer. It stays off until whoever runs the deployment sets `SPORTOZEN_PLAYER_LINKS_ENABLED=1`, and they should do that only after the academy has had legal advice. While it is off no link can be made or opened, no player's details can be sent or confirmed (declining still works), and the Players screen says so.

Open **Players**, press **Add player with invitation link**, choose who looks after the player (you by default) and press **Create invitation link**. Copy it, or share it on WhatsApp.

- The link is **not tied to an email address**: whoever opens it first can use it, with any email address. It works **once** and expires after 7 days. Send it only to the player or their parent.
- The player opens it, signs up (or signs in), and is then asked for their own **name, date of birth and position**, and to say that a parent or guardian knows. They are then told the academy will confirm. **No player exists yet**, and their account sees nothing.
- On **Players** you see "Players waiting for your confirmation". Tick that **a parent or guardian has agreed** (the academy collects and keeps that agreement itself, for example on the enrolment form: this screen records only that you have it) and press **Confirm**. **Decline** removes the request and the account's access. Only the owner and admins can confirm or decline.
- The date-of-birth rule is the same as everywhere: players must be under 18. It is checked again when you confirm.
- **Possible duplicates:** when you confirm, the app compares the name (same words, any order) and date of birth with the players you already have, archived ones included. If it finds a likely match it lists it and asks you to tick that this is a different player. It only warns: nothing is merged, linked or changed for you, and the check runs again inside the confirmation so a player added a moment ago is seen.
- Once confirmed, the player appears under Players, looked after by the person you chose, with no batch: place them in a batch yourself. The player can change nothing else about their record. They reload the page and see their own Home.
- A player's login is limited by the server, not only by the screen (see the table above). Fees, reports and everything written for parents are for the parent or guardian.
- Under **Settings, Team, Invite people, Waiting to join** the link shows as "Player link". **New link** replaces it (the old one stops working); **Cancel** ends it. A link that has been used cannot be used again.
- Anyone who already belongs to the academy (a coach, a parent, another player) cannot use a player link.
- Where the deployment requires email confirmation, the player confirms their own address first, as for any account: the link cannot confirm an address because it is not tied to one.

### What the guardian-consent step does and does not do

- It records **only your statement** that a parent or guardian has agreed: you tick it, and the academy's activity log keeps who ticked it and when. The tick is not evidence of consent.
- The app does **not** collect, check, store or time-stamp the agreement itself, does not record which guardian agreed, does not link any guardian account to the player, and has no way for a guardian to withdraw consent.
- The player's own "a parent or guardian knows" tick is awareness only. It is checked and then not stored.
- Whether this is enough under India's data-protection law (or any other law that applies to you) is **not decided here**. Nothing in this software or this document is legal advice or a statement of compliance. Do not use player links for real players under 18 until you have advice, and keep the agreement itself with your enrolment records.

### Older own-login accounts

Before player links, an account could be a player's own login (the `player_self_login` table, migration 015). Those accounts are **not** changed: the limits above apply only to accounts created through a player link and confirmed (they are recorded in `player_link_login`). To see whether a deployment has any older own-login accounts, count the rows in `player_self_login`. If you want the same limits for an older account that belongs to a child, that is a separate decision.

### The link is in the address

A player link is `/join/<token>`, so the secret is part of the address. That address can appear in the browser's history, in a web server's access log, and in a shared screen. What already limits the harm: the page is never indexed or cached, the server sends `Referrer-Policy: no-referrer` and `Cache-Control: no-store` for every `/join/` address (so a browser does not pass the address on to another site), the application's own logs and security-event lines replace the token with a placeholder, the app loads no third-party analytics, the link works once, and it expires after 7 days. What still helps: set the reverse proxy to leave `/join/` paths out of access logs, and send the link privately to the player or their parent. A longer-term improvement (not made here, because it changes how every invitation works) is to carry the token in the part of the address after `#`, which a browser never sends to a server.

## Signing in again

The link is for the first time only. Afterwards a person signs in with the same email and password, or with Google, and goes straight to their academy. They stay signed in on that device until they choose **Sign out**, when the deployment has `SPORTOZEN_SESSION_PERSISTENT=1` (see docs/AUTHENTICATION.md). Without that setting the stricter default limits apply (8 hours).

## Keeping track

Under **Invite people**, **Waiting to join** lists everyone who has not used their link yet.

- **New link**: makes a fresh link for that person. The earlier link stops working at once.
- **Cancel**: ends the invitation.

An email invitation works once, for that email address only, and expires after 7 days. A player link works once, for anyone, and also expires after 7 days. A link cannot be shown again after it has been created (only its fingerprint is stored), so use **New link** if it is lost.

## Taking access away

In Settings, Team, **Revoke access** on a member's row. The owner's own access cannot be revoked.

## Notes

- An invitation is tied to one email address. Someone signed in with a different address is told which address the invitation is for.
- Anyone holding the link can use it until it is used or expires, so share it only with the person it is for.
- Where the deployment sends email, an email with the same link is also queued. Sharing by hand always works.
- The older `/workspace?invitation=<code>` address still works and opens the same page. The pasted-code box on the academy list is still there as a fallback.

### Attendance for a player's own login

A player's own login can read the attendance history of that player only (sessions, present, absent, excused and the percentage). It cannot read any other player's history or the follow-up list, and it does not see the staff-only follow-up flag or correction notes. This is checked on the server in `attendance-history-service.ts` and pinned by `tests/unit/player-link-restrictions.test.ts`.
