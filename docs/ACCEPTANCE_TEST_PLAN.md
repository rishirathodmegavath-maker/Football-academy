# Sportozen Academy: manual acceptance test plan

Written for: the application owner and the people who will test with them. No technical knowledge is needed to follow the steps.

**Status of every test in this document: NOT PERFORMED.** The "Actual" and "Result" columns are empty on purpose. Automated tests and the author's own checks (see `docs/PHASE7_REPORT.md`) are not a substitute for a person using the product, on a real phone, with a real screen reader. Record `PASS`, `FAIL` or `BLOCKED` only for steps you actually did, and write what you saw in "Actual".

## 0. Before you start

**Environment.** Test on a local or staging copy, never with real children's data and never with real payment details. WhatsApp and email are not connected (`SPORTOZEN_EMAIL_TRANSPORT=disabled` unless you are using the `file` developer transport), so tests that mention a message "to a parent" mean the message shown **inside the application**. Money screens record payments that someone reports; no payment is taken.

**People you need (create them as you go; use made-up names and addresses such as `owner1@example.test`):**

| Short name | Role                                                    | How it is created                                                                            |
| ---------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| PA         | Platform administrator                                  | created by the technical person with `scripts/platform-admin.mjs` (see `docs/OPERATIONS.md`) |
| O1         | Owner of Academy 1                                      | sign up, then create the academy                                                             |
| O2         | Owner of Academy 2                                      | a second academy, to check that two academies never see each other                           |
| C1, C2     | Coaches of Academy 1                                    | invited by O1                                                                                |
| P1, P2     | Parents of Academy 1 (P1 has one child, P2 has another) | invited by O1                                                                                |

**Devices.** Chrome or Edge on a computer; Firefox and Safari if you can; a real iPhone and a real Android phone; a tablet if you have one. Section 6 says what to check on them.

**Defects.** Write each problem in the table in section 9 with the test ID, what you did, what you expected, what happened, and a photo or screen recording. Mark it Critical (data loss, wrong money, a person sees someone else's data), High (a main task cannot be completed), Medium (a task is hard) or Low (cosmetic).

How to read a row: do the steps in order; compare with Expected; write what actually happened in Actual (even when it matches: "as expected" is a valid entry).

## 1. Platform administrator (PA)

| ID    | Steps                                                                                          | Expected                                                                                                                    | Actual | Result |
| ----- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------ | ------ |
| PA-01 | Sign in as PA. Open the platform page (`/platform`)                                            | You see the list of all academies with name, country, status, plan and modules. You do not see any child, parent or invoice |        |        |
| PA-02 | Choose Academy 1 and pause it. Then, as O1, C1 and P1 in other browser windows, reload         | All three see that the academy is unavailable; Academy 2 still works for O2                                                 |        |        |
| PA-03 | Resume Academy 1. Reload as O1, C1, P1                                                         | All three work again; nothing was lost                                                                                      |        |        |
| PA-04 | Change which modules Academy 1 has (for example switch off Fees) and save. As O1 open the menu | The Fees entry is unavailable for O1 and P1; switching it back restores it                                                  |        |        |
| PA-05 | As PA, try to open `/workspace/<Academy 1 id>` directly                                        | You are refused: a platform administrator is not a member of an academy                                                     |        |        |
| PA-06 | Sign in as O1 (not PA) and open `/platform`                                                    | You are refused                                                                                                             |        |        |
| PA-07 | Look for a way to approve or reject a new academy                                              | **There is none today** (known gap, `docs/ACADEMY_APPROVAL_PROPOSAL.md`). Record whether this is acceptable for your launch |        |        |
| PA-08 | Look for an audit or monitoring screen                                                         | **There is none today.** Record whether you need one                                                                        |        |        |

## 2. Owner (O1)

### 2.1 Account and academy management

| ID   | Steps                                                                                 | Expected                                                                                                       | Actual | Result |
| ---- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------ | ------ |
| O-01 | Sign up with a new email and a password. Sign out and sign in again                   | Account created; sign-in works; a wrong password shows a clear message and does not say which part was wrong   |        |        |
| O-02 | Create an academy: name, country, language, currency, time zone, a logo (a small PNG) | The academy opens empty. A logo that is not a real PNG (rename a .jpg to .png) is refused with a clear message |        |        |
| O-03 | Settings → Academy: change the name, contact email, accent colour; save; reload       | The change is kept. Buttons and headings use the new colour and remain readable                                |        |        |
| O-04 | Settings → Academy: change something in two browser windows and save in both          | The second save tells you the data changed and asks you to review; nothing is silently overwritten             |        |        |
| O-05 | Settings → Account: change your password; sign out; sign in with the new one          | Works; the old password no longer works                                                                        |        |        |
| O-06 | Settings → Account: turn on two-step sign-in (if offered), sign out and in            | A code is requested; a wrong code is refused                                                                   |        |        |
| O-07 | Settings → Team: look at the people list                                              | You see yourself, coaches and parents of your academy only                                                     |        |        |

### 2.2 Players and batches

| ID   | Steps                                                                                        | Expected                                                                                  | Actual | Result |
| ---- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------ | ------ |
| O-10 | Players → Add Player: fill the form with a made-up child; save                               | The player appears in the list and on Home counts. Required fields are explained if empty |        |        |
| O-11 | Add a player with a very long name (60 letters) and a name with accents or non-Latin letters | Saved; nothing overflows the screen on a phone                                            |        |        |
| O-12 | Edit a player, change the position; save; reload                                             | Change kept                                                                               |        |        |
| O-13 | Create a batch (a group of players) and put 3 players in it; create a second batch           | Batches show their members; a player can be moved                                         |        |        |
| O-14 | Search and filter the player list                                                            | Results match; clearing the filter shows everyone                                         |        |        |

### 2.3 Invitations

| ID   | Steps                                                                                | Expected                                                                                                                    | Actual | Result |
| ---- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------ | ------ |
| O-20 | Settings → Team (or the player's "Invite a verified guardian"): invite C1 as a coach | An invitation link is shown (email is off). Open it in a private window, create the account, accept: C1 appears in the team |        |        |
| O-21 | Invite P1 as a parent of one child                                                   | P1 accepts and sees only that child                                                                                         |        |        |
| O-22 | Use the same invitation link a second time, or a link with a letter changed          | Refused; no account gains access                                                                                            |        |        |
| O-23 | Revoke an invitation before it is used, then try the link                            | Refused                                                                                                                     |        |        |
| O-24 | Remove a coach (or parent) from the academy while they are signed in elsewhere       | Their next action is refused immediately                                                                                    |        |        |

### 2.4 Training sessions and attendance

| ID   | Steps                                                           | Expected                                                                             | Actual | Result |
| ---- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------ | ------ |
| O-30 | Training → Create Session for a batch, tomorrow, 18:00          | The session appears in Calendar and Training; the time is in the academy's time zone |        |        |
| O-31 | Two sessions that overlap for the same batch                    | You are warned about the overlap (or it is refused)                                  |        |        |
| O-32 | Open a session → Agenda: add a drill; Objectives: add one; save | Kept after reload                                                                    |        |        |
| O-33 | Open a session → Attendance: mark players present, absent, late | Counts update; kept after reload                                                     |        |        |
| O-34 | Open a session → Evidence: add a note or observation            | Kept; visible only to staff until reviewed                                           |        |        |
| O-35 | Reschedule and cancel a session                                 | Calendar shows the new time and the cancelled state                                  |        |        |
| O-36 | Calendar: switch Week, Month and Agenda views                   | Same sessions in each; keyboard and touch scrolling work                             |        |        |

### 2.5 Fees, invoices and payments (use test amounts)

| ID   | Steps                                                                                  | Expected                                                                                                   | Actual | Result |
| ---- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------ | ------ |
| O-40 | Fees → create a fee plan (monthly, an amount) and assign it to a batch                 | The plan appears; zero, negative or text amounts are refused                                               |        |        |
| O-41 | Create an invoice for a player for 12,345.67                                           | Invoice appears as pending with that exact amount                                                          |        |        |
| O-42 | Collect Payment: record 5,000.00 with a bank reference                                 | Status becomes partial; balance 7,345.67; collected total on the Fees screen updates                       |        |        |
| O-43 | Record the same bank reference again (also with different capitals or spaces)          | Refused as a duplicate; nothing is double counted                                                          |        |        |
| O-44 | Record a payment larger than the balance                                               | Refused                                                                                                    |        |        |
| O-45 | Record the rest of the payment                                                         | Status paid; a receipt can be downloaded                                                                   |        |        |
| O-46 | Add a discount (credit) to another invoice                                             | The billed amount drops by exactly that amount; the invoice PDF shows the adjustment **with a minus sign** |        |        |
| O-47 | Download an invoice and a receipt as PDF; open them                                    | Amounts, names, dates and currency match the screen to the last digit                                      |        |        |
| O-48 | Compare totals (billed, collected, outstanding) with your own addition of the invoices | Equal                                                                                                      |        |        |
| O-49 | Mark a payment rejected (if the screen offers it)                                      | It never counts toward the balance                                                                         |        |        |

### 2.6 Reports and PDFs

| ID   | Steps                                                                  | Expected                                                                   | Actual | Result |
| ---- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------ | ------ |
| O-50 | Reports: prepare the monthly report for a player who attended sessions | A draft appears from the real sessions and attendance; nothing is invented |        |        |
| O-51 | Edit the wording; save; preview                                        | Preview matches; long text wraps                                           |        |        |
| O-52 | Approve the report; download the PDF                                   | PDF opens, readable, correct names, dates, no cut-off text                 |        |        |
| O-53 | Change a session after the draft was prepared, then try to approve     | You are told the sources changed and must refresh                          |        |        |
| O-54 | As P1, open Reports                                                    | Only the approved report for their own child appears                       |        |        |

### 2.7 Announcements and messaging

| ID   | Steps                                                                                                             | Expected                                                                                                                           | Actual | Result |
| ---- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------ | ------ |
| O-60 | Messages → Batch announcements: write an announcement for one batch; Save draft                                   | Draft kept; a clear message says what happens next                                                                                 |        |        |
| O-61 | Submit, preview (see how many guardians will read it in the app), approve                                         | The status changes at each step; a message under the form always says what happened                                                |        |        |
| O-62 | As P1 (child in that batch) open Home and Messages                                                                | The announcement is shown. As P2 (child in another batch) it is **not** shown                                                      |        |        |
| O-63 | Cancel the announcement; reload as P1                                                                             | It disappears                                                                                                                      |        |        |
| O-64 | An announcement whose batch has no linked parent                                                                  | Approval is refused with a message that nobody would see it                                                                        |        |        |
| O-65 | Messages: choose a player and send a private message to the guardian; as P1 reply                                 | Both sides see the conversation in order; staff-only notes are not visible to P1                                                   |        |        |
| O-66 | Settings → Integrations: look at the WhatsApp section                                                             | It says WhatsApp is not connected; no message is claimed as sent                                                                   |        |        |
| O-67 | Open a player's "Delivery and approval details" in Messages: filter by status, search, "Show older notifications" | With no WhatsApp history it says there are no notifications; with history it pages 25 at a time and never loads everything at once |        |        |

## 3. Coach (C1)

| ID   | Steps                                                          | Expected                                                                                                            | Actual | Result |
| ---- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------ | ------ |
| C-01 | Accept the invitation and sign in                              | Dashboard shows only the coach's batches and players                                                                |        |        |
| C-02 | Open Players                                                   | Only players of your batches are listed; a player of another coach's batch cannot be opened by changing the address |        |        |
| C-03 | Create a session for your batch; take attendance; add evidence | Works as for the owner                                                                                              |        |        |
| C-04 | Try to open Fees (menu and by typing the address)              | Not available                                                                                                       |        |        |
| C-05 | Try to open Settings → Team and invite someone                 | Not available                                                                                                       |        |        |
| C-06 | Draft a batch announcement and submit it                       | You can draft and submit; **you cannot approve**                                                                    |        |        |
| C-07 | Prepare a monthly report for your player and submit for review | Works; approval is by the owner                                                                                     |        |        |
| C-08 | Message a guardian of your player                              | Works; you cannot open a conversation about a player outside your batches                                           |        |        |

## 4. Parent (P1, P2)

| ID   | Steps                                                                  | Expected                                                                                                               | Actual | Result |
| ---- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------ | ------ |
| P-01 | Accept the invitation; sign in                                         | You see only your own child                                                                                            |        |        |
| P-02 | Home                                                                   | Next session, latest update, announcements for your child's batch; no other child anywhere                             |        |        |
| P-03 | Calendar                                                               | Your child's sessions only; times in the academy's time zone                                                           |        |        |
| P-04 | Reports                                                                | Approved reports of your child only; open and download the PDF                                                         |        |        |
| P-05 | Fees                                                                   | Your child's invoices, payments and receipts; amounts equal what the owner sees; no "manage" buttons, no staff wording |        |        |
| P-06 | Download an invoice and a receipt                                      | PDFs open; amounts correct                                                                                             |        |        |
| P-07 | Messages                                                               | Announcements and your private conversation with the coach; send a reply                                               |        |        |
| P-08 | Change the address from your child's id to a made-up id                | Refused or empty; never another child's data                                                                           |        |        |
| P-09 | Settings → Account: change password, sign out, sign in                 | Works                                                                                                                  |        |        |
| P-10 | Two children: ask the owner to link a second child; switch child       | Each child's data shown separately                                                                                     |        |        |
| P-11 | Try (by typing addresses) to open Players, Training, the platform page | Refused                                                                                                                |        |        |

## 5. Cross-role and two-academy checks

| ID   | Steps                                                                   | Expected                                                                    | Actual | Result |
| ---- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------ | ------ |
| X-01 | O2 creates a player with the same name as one in Academy 1              | The two academies show their own players only                               |        |        |
| X-02 | As O2, paste an address of an Academy 1 page (copy it from O1's window) | Refused                                                                     |        |        |
| X-03 | O1 pauses nothing; O2's data and sign-in unaffected by O1's actions     | Independent                                                                 |        |        |
| X-04 | Sign in on two devices as the same person; change the password on one   | The other session is ended at its next action                               |        |        |
| X-05 | Leave a form half-filled and navigate away                              | You are asked before losing changes                                         |        |        |
| X-06 | Use the browser Back and Forward buttons through five screens           | You land on the same screens; nothing breaks                                |        |        |
| X-07 | Reload on every screen                                                  | You stay on the same screen with the same data                              |        |        |
| X-08 | Lose the network (aeroplane mode) while saving, then reconnect          | A clear message; your text is not lost; no duplicate record after you retry |        |        |

## 6. Real-device testing guidance

Why: the automated tests used desktop browsers pretending to be phones. They cannot show real touch behaviour, real keyboards covering the screen, real fonts, real battery and network.

**Minimum devices.** One recent iPhone (Safari), one Android phone (Chrome), one tablet or an iPad, one laptop (Chrome or Edge), one more browser (Firefox). Also one older or cheaper Android phone if parents in your academy use such phones: performance problems appear there first.

**Do on each phone (parent and owner roles):**

1. Open the sign-in page from a link. Sign in with the on-screen keyboard. Is the keyboard type right (email keyboard for email)? Does the keyboard hide the button you need?
2. Go through Home, Calendar, Reports, Fees, Messages for a parent; Home, Players, Training, Fees, Messages for an owner. Is any text cut off, overlapping or too small to read? Can you tap each button with a thumb without hitting the next one? (Targets should be about the size of a fingertip.)
3. Rotate to landscape and back.
4. Zoom the page (pinch) and change the phone's text size to the largest setting. Nothing should become unreadable or unreachable.
5. Download an invoice PDF and a report PDF. Do they open in the phone's viewer? Can you share or save them?
6. Switch the phone to a slow connection (or move away from the router / use mobile data with a weak signal). How long until you can read the Home screen? Note the time with a stopwatch: the lab figure is about 2.5 to 3 seconds on a deliberately slow profile; tell us the real figure.
7. Put the app in the background for ten minutes and come back: are you still signed in as expected, with no stale data?
8. Dark mode or high-contrast settings on: is everything readable?
9. Add the page to the home screen if you plan to tell parents they can.

**Record** device model, operating system version, browser and version, and the connection for each result.

## 7. Screen-reader and keyboard testing guidance

Automated checks (axe) found and fixed many problems, but they cannot judge whether a screen **makes sense when spoken**. Someone should use the product without looking at it.

**Tools.** Windows: NVDA (free) with Firefox or Chrome. macOS and iPhone: VoiceOver with Safari. Android: TalkBack with Chrome. If possible, ask a person who uses a screen reader every day: they will find in minutes what a sighted tester will not.

**Keyboard only (no mouse), on a computer, as owner and as parent:**

1. Press Tab from the top of the sign-in page. A visible outline must move through every control in a sensible order. The first stop should offer to skip to the main content.
2. Open and close a dialog (for example Add Player or Batch announcements): focus must move into the dialog, stay inside it while you press Tab, return to the button that opened it on Escape.
3. Use the Calendar and a long list with the arrow keys / Tab only.
4. Submit a form with an error: is the error announced and does focus go somewhere useful?

**With a screen reader:**

| Check                   | What good looks like                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| Page title and headings | Each screen has one main heading; the heading list is a sensible outline                          |
| Landmarks               | Navigation, main content and account controls are announced as such                               |
| Buttons and links       | The name says what it does ("Open Asha Sharma Monthly fee details"), not "button" or "click here" |
| Tables (fee list)       | Row and column headers are read with each cell                                                    |
| Forms                   | Every field has its label read; required fields and errors are announced                          |
| Dynamic messages        | "Saved", "Sent", errors and loading states are announced without moving focus                     |
| Dialogs                 | The dialog title is read when it opens                                                            |
| Money and dates         | Read in a way that makes sense (the currency, a negative amount "minus")                          |
| Initials in circles     | Ignored (decorative); the person's name is read once                                              |
| PDFs                    | The PDF is readable text (not an image) and in a sensible order                                   |

**Also check, by eye:** text contrast in sunlight (outdoors on a phone); colour is never the only way to tell status (for example "overdue" also has a word).

## 8. Sign-off

Acceptance is **not** given by this document. It is given by the owner after reading the results. Suggested conditions: no open Critical or High defect; every test in sections 2 to 5 performed at least once by a person; section 6 performed on one iPhone and one Android phone; section 7 performed by at least one person with a screen reader; decisions D1 and D2 of `docs/ACADEMY_APPROVAL_PROPOSAL.md` and D1 to D6 of `docs/DELIVERY_DATA_RETENTION.md` recorded.

| Tester | Role tested | Date | Device and browser | Tests done | Passed | Failed | Blocked |
| ------ | ----------- | ---- | ------------------ | ---------- | ------ | ------ | ------- |
|        |             |      |                    |            |        |        |         |

## 9. Defect log

| #   | Test ID | Severity | What you did | What you expected | What happened | Photo or video |
| --- | ------- | -------- | ------------ | ----------------- | ------------- | -------------- |
|     |         |          |              |                   |               |                |
