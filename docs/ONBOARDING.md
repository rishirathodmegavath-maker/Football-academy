# Football academy onboarding

Football-only release. Multiple independent academies. Personalised player development. No rankings.

**A new academy is reviewed first.** It starts as "Setting up": the owner completes the academy profile and submits it, a Sportozen platform administrator reviews it (and may reject it with feedback, after which the owner edits and resubmits), and only an approved academy can add players, batches, sessions, fees, messages and invitations. See `ACADEMY_APPROVAL.md`. The steps below describe what the owner does once the academy is approved.

Register/sign in at `/sign-in`, then create an empty academy at `/workspace`. Football is automatic. Configure academy identity/PNG branding, country, language, currency, time zone, date locale, units and modules. Add independent branches and football programmes in Settings.

Invite the intended registered coach account using a single-use manual token; no email is delivered. Add a football player, squad label and assigned academy coach. Explicitly verify the guardian before preparing a parent invitation for the selected player. The parent accepts using the invited account. No names or families are merged across academies.

Assigned coaches create plans from actual academy drills and reviewed observations. Approve the recorded report after source verification. Prepare/review a parent update; approval publishes only to authorised in-app recipients subject to preferences. External delivery remains NOT_SENT. Parents read approved snapshots and reply privately; staff notes are excluded server-side.

Continue onboarding in the authenticated Training tab: create an explicit squad and venue under a branch, schedule a dated session, personalise objectives, mark attendance and capture/review coach-recorded evidence. That evidence can populate an approved report and private parent update/reply. Do not use fictional demo routes as customer onboarding steps. Video upload/AI remain separate work; production requires secure identity/guardian verification, consent, durable operations and deployment controls. See FOOTBALL_SESSION_WORKFLOW.md and PILOT_READINESS.md for the supervised synthetic-data boundary.

International fixtures use India/INR/Asia-Kolkata, UK/GBP/Europe-London and Australia/AUD/Australia-Perth. Stored currency/time-zone settings do not establish daylight-saving scheduling, unit conversion or complete localisation.
