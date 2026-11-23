"use client";
import { useState } from "react";
import { Button, Card, Badge } from "@/components/ui/primitives";
import {
  usePlayerReportSummaries,
  usePlayerWeeklyPlans,
} from "@/hooks/use-player-records";
import {
  useCommunication,
  communicationCommand,
  type CommunicationView,
} from "@/hooks/use-communication";
import { useWorkspace } from "@/hooks/use-workspace";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { DeliveryJobList } from "./delivery-job-list";
import "./delivery-job-list.css";
import type { CommunicationSettings } from "@/domain/communication";
type Controller = ReturnType<typeof useWorkspace>;
/**
 * Messaging is free and needs no business account. WhatsApp and e-mail are sent by a person from their own WhatsApp or
 * mail app, with one button that opens it with the message ready (invitations, parent updates). The automatic sender that
 * needed a Meta business account is not offered: its server code stays dormant and switched off.
 */
export function CommunicationSettingsPanel(_props: { workspace: Controller }) {
  void _props;
  return (
    <Card>
      <h2>WhatsApp and email: free</h2>
      <Badge>No business account needed</Badge>
      <p>
        You send messages yourself, from your own WhatsApp and mail app, with
        one button. WhatsApp or your mail app opens with the person and the
        message already filled in, and you press Send there. It costs nothing
        and the message comes from your own number or address.
      </p>
      <ul>
        <li>
          <strong>Invitations:</strong> Settings, Team, Invite people. After you
          create a link, press Send on WhatsApp or Send by email.
        </li>
        <li>
          <strong>Parent updates:</strong> Messages, on an approved update, open
          “Send this yourself, free”.
        </li>
      </ul>
      <p>
        Nothing is sent by the server, so Sportozen cannot tell whether a
        message was sent, delivered or read.
      </p>
    </Card>
  );
}
function SenderSettings({
  workspace: w,
  settings: s,
}: {
  workspace: Controller;
  settings: CommunicationSettings;
}) {
  const [draft, setDraft] = useState(s);
  useUnsavedChanges(JSON.stringify(s) !== JSON.stringify(draft));
  function set<K extends keyof CommunicationSettings>(
    key: K,
    value: CommunicationSettings[K],
  ) {
    setDraft({ ...draft, [key]: value });
  }
  return (
    <Card>
      <h3>Academy communication schedules</h3>
      <form
        className="form-stack"
        onSubmit={async (e) => {
          e.preventDefault();
          await communicationCommand(w, {
            action: "settings",
            data: { ...draft, expectedVersion: s.version },
          });
        }}
      >
        <p>
          Reporting time zone: {s.timezone}. Schedules start disabled. A missed
          weekly send expires after 24 hours or when the training week begins.
        </p>
        {(["enabled", "paused"] as const).map((key) => (
          <label className="check-row" key={key}>
            <input
              type="checkbox"
              checked={draft[key]}
              onChange={(e) => set(key, e.target.checked)}
            />
            {key === "enabled"
              ? "Enable schedules"
              : "Pause notifications and scheduled drafts"}
          </label>
        ))}
        <label>
          Weekly sending day
          <select
            value={draft.weeklyDay}
            onChange={(e) => set("weeklyDay", Number(e.target.value))}
          >
            {[
              "Sunday",
              "Monday",
              "Tuesday",
              "Wednesday",
              "Thursday",
              "Friday",
              "Saturday",
            ].map((v, i) => (
              <option value={i} key={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label>
          Planning lead days before Monday
          <input
            type="number"
            min="0"
            max="6"
            value={draft.weeklyLeadDays}
            onChange={(e) => set("weeklyLeadDays", Number(e.target.value))}
          />
        </label>
        <label>
          Weekly sending time
          <input
            type="time"
            value={draft.weeklyTime}
            onChange={(e) => set("weeklyTime", e.target.value)}
          />
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={draft.weeklyDraftEnabled ?? false}
            onChange={(event) =>
              set("weeklyDraftEnabled", event.target.checked)
            }
          />
          Prepare weekly drafts automatically — ordinary coach approval is still
          required
        </label>
        <label>
          Weekly draft preparation lead days before Monday
          <input
            type="number"
            min="0"
            max="6"
            value={draft.weeklyDraftLeadDays ?? 2}
            onChange={(event) =>
              set("weeklyDraftLeadDays", Number(event.target.value))
            }
          />
        </label>
        <label>
          Weekly draft preparation time
          <input
            type="time"
            value={draft.weeklyDraftTime ?? "09:00"}
            onChange={(event) => set("weeklyDraftTime", event.target.value)}
          />
        </label>
        <label>
          Monthly draft generation day
          <input
            type="number"
            min="1"
            max="28"
            value={draft.monthlyDraftDay}
            onChange={(e) => set("monthlyDraftDay", Number(e.target.value))}
          />
        </label>
        <label>
          Monthly notification day
          <input
            type="number"
            min="1"
            max="28"
            value={draft.monthlyDay}
            onChange={(e) => set("monthlyDay", Number(e.target.value))}
          />
        </label>
        <label>
          Monthly notification time
          <input
            type="time"
            value={draft.monthlyTime}
            onChange={(e) => set("monthlyTime", e.target.value)}
          />
        </label>
        {(["quietStart", "quietEnd"] as const).map((key) => (
          <label key={key}>
            {key === "quietStart" ? "Quiet hours start" : "Quiet hours end"}
            <input
              type="time"
              value={draft[key]}
              onChange={(e) => set(key, e.target.value)}
            />
          </label>
        ))}
        {(
          [
            "phoneNumberId",
            "wabaId",
            "credentialRef",
            "weeklyTemplate",
            "monthlyTemplate",
            "announcementTemplate",
          ] as const
        ).map((key) => (
          <label key={key}>
            {
              {
                phoneNumberId: "Meta phone-number ID",
                wabaId: "WhatsApp Business Account ID",
                credentialRef: "Server credential reference",
                weeklyTemplate: "Provider weekly template name",
                monthlyTemplate: "Provider monthly template name",
                announcementTemplate:
                  "Provider operational announcement template name (optional)",
              }[key]
            }
            <input
              value={draft[key] ?? ""}
              onChange={(e) => set(key, e.target.value)}
            />
          </label>
        ))}
        <p>
          Template language: en_GB. Exact local template definitions must be
          approved by Meta.
        </p>
        <label>
          Sending mode
          <select
            value={draft.mode}
            onChange={(e) => set("mode", e.target.value as "TEST" | "LIVE")}
          >
            <option>TEST</option>
            <option>LIVE</option>
          </select>
        </label>
        <Button disabled={w.busy}>Save communication settings</Button>
      </form>
      <Button
        variant="secondary"
        disabled={w.busy || JSON.stringify(s) !== JSON.stringify(draft)}
        onClick={() =>
          communicationCommand(w, { action: "verifyProvider", data: {} })
        }
      >
        Verify sender and provider templates
      </Button>
    </Card>
  );
}
function GuardianSettings({
  workspace: w,
  data,
}: {
  workspace: Controller;
  data: CommunicationView;
}) {
  const parent = w.data!.membership.role === "PARENT",
    admin = ["OWNER", "ADMIN"].includes(w.data!.membership.role);
  const initial = parent
    ? data.contacts.find((c) => c.guardianId === w.data!.membership.userId)
    : undefined;
  const [guardian, setGuardian] = useState(
      parent ? w.data!.membership.userId : "",
    ),
    [phone, setPhone] = useState(initial?.phone ?? ""),
    [verification, setVerification] = useState(
      initial?.verificationReference ?? "",
    ),
    [consent, setConsent] = useState(initial?.consentReference ?? ""),
    [verified, setVerified] = useState(false),
    [optedIn, setOptedIn] = useState(
      !!initial?.consentAt && !initial?.optedOutAt,
    ),
    [weekly, setWeekly] = useState(initial?.weekly ?? false),
    [monthly, setMonthly] = useState(initial?.monthly ?? false),
    [operational, setOperational] = useState(initial?.operational ?? false);
  const old = data.contacts.find((c) => c.guardianId === guardian);
  function select(id: string) {
    setGuardian(id);
    const c = data.contacts.find((c) => c.guardianId === id);
    setPhone(c?.phone ?? "");
    setVerification(c?.verificationReference ?? "");
    setConsent(c?.consentReference ?? "");
    setVerified(false);
    setOptedIn(!!c?.consentAt && !c.optedOutAt);
    setWeekly(c?.weekly ?? false);
    setMonthly(c?.monthly ?? false);
    setOperational(c?.operational ?? false);
  }
  if (!parent && !admin) return null;
  return (
    <Card>
      <h3>Verified guardian contact and consent</h3>
      <p>
        Consent must name {w.data!.academy.name} and the selected notification
        categories. Contact verification needs recorded evidence from academy
        staff.
      </p>
      {data.contacts.map((c) => (
        <p key={c.guardianId}>
          Contact ending {c.phone.slice(-4)} ·{" "}
          {c.verifiedAt ? "Verified" : "Awaiting verification"} ·{" "}
          {c.optedOutAt
            ? "Opted out"
            : c.consentAt
              ? "Opted in"
              : "Consent missing"}
        </p>
      ))}
      <form
        className="form-stack"
        onSubmit={async (e) => {
          e.preventDefault();
          await communicationCommand(w, {
            action: "contact",
            data: {
              guardianId: guardian,
              expectedVersion: old?.version ?? 0,
              phone,
              verificationReference: verification,
              consentReference: consent,
              verified,
              optedIn,
              weekly,
              monthly,
              operational,
            },
          });
        }}
      >
        {!parent && (
          <label>
            Authorised guardian
            <select
              required
              value={guardian}
              onChange={(e) => select(e.target.value)}
            >
              <option value="">Choose guardian</option>
              {w
                .data!.members.filter((m) => m.role === "PARENT")
                .map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.name}
                  </option>
                ))}
            </select>
          </label>
        )}
        <label>
          Phone with country code
          <input
            type="tel"
            required
            placeholder="+countrycode…"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </label>
        {admin && (
          <>
            <label>
              Verification evidence reference
              <input
                value={verification}
                onChange={(e) => setVerification(e.target.value)}
              />
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={verified}
                onChange={(e) => setVerified(e.target.checked)}
              />
              I verified this guardian controls this phone
            </label>
          </>
        )}
        <label>
          Consent evidence or parent confirmation
          <textarea
            value={consent}
            onChange={(e) => setConsent(e.target.value)}
          />
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={optedIn}
            onChange={(e) => setOptedIn(e.target.checked)}
          />
          Explicitly opted in to messages from this academy
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={weekly}
            onChange={(e) => setWeekly(e.target.checked)}
          />
          Weekly training plans
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={monthly}
            onChange={(e) => setMonthly(e.target.checked)}
          />
          Monthly report notifications
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={operational}
            onChange={(event) => setOperational(event.target.checked)}
          />
          Operational batch announcements
        </label>
        <Button disabled={w.busy}>Save contact and preferences</Button>
      </form>
      {old && (
        <Button
          variant="secondary"
          disabled={w.busy}
          onClick={() =>
            communicationCommand(w, {
              action: "optOut",
              data: {
                guardianId: guardian,
                expectedVersion: old.version,
                verificationReference: old.verificationReference,
                consentReference: old.consentReference,
                weekly: false,
                monthly: false,
              },
            })
          }
        >
          Opt out of WhatsApp
        </Button>
      )}
    </Card>
  );
}
export function DeliveryPanel({
  workspace: w,
  playerId,
}: {
  workspace: Controller;
  playerId: string;
}) {
  const c = useCommunication(w),
    [source, setSource] = useState(""),
    [recipients, setRecipients] = useState<string[]>([]),
    [verified, setVerified] = useState(false);
  const parent = w.data!.membership.role === "PARENT";
  // This player's approved weekly plans and monthly reports, read on their own
  // rather than from the whole-academy payload.
  const weekly = usePlayerWeeklyPlans(w, playerId),
    monthly = usePlayerReportSummaries(w, playerId);
  const sources = [
    ...(weekly.data ?? [])
      .filter((r) => r.playerId === playerId && r.status === "APPROVED")
      .map((r) => ({
        id: r.id,
        type: "WEEKLY",
        label: `Weekly plan ${r.content.period.key}${r.correctionOf ? " — correction" : ""}`,
      })),
    ...(monthly.data ?? [])
      .filter(
        (r) =>
          r.playerId === playerId &&
          r.status === "Approved" &&
          r.reportingPeriod,
      )
      .map((r) => ({
        id: r.id,
        type: "MONTHLY",
        label: `Monthly report ${r.period}`,
      })),
  ];
  return (
    <Card>
      <h2>Weekly plans and monthly notifications</h2>
      {c.error && <p role="alert">{c.error}</p>}
      {c.data && (
        <>
          <Badge>{c.data.settings.mode} MODE</Badge>
          <p>
            Approval, parent-app publication and WhatsApp delivery are separate.
            Provider acceptance is not delivery.
          </p>
          {!parent && (
            <form
              className="form-stack"
              onSubmit={async (e) => {
                e.preventDefault();
                const chosen = sources.find((s) => s.id === source);
                if (chosen)
                  await communicationCommand(w, {
                    action: "queue",
                    data: {
                      type: chosen.type,
                      sourceId: source,
                      guardianIds: recipients,
                      verified,
                    },
                  });
              }}
            >
              <label>
                Approved source
                <select
                  required
                  value={source}
                  onChange={(e) => {
                    setSource(e.target.value);
                    setVerified(false);
                  }}
                >
                  <option value="">Choose reviewed content</option>
                  {sources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
              <fieldset>
                <legend>Review recipients</legend>
                {c.data.contacts.map((c) => (
                  <label className="check-row" key={c.guardianId}>
                    <input
                      type="checkbox"
                      checked={recipients.includes(c.guardianId)}
                      onChange={(e) =>
                        setRecipients(
                          e.target.checked
                            ? [...recipients, c.guardianId]
                            : recipients.filter((id) => id !== c.guardianId),
                        )
                      }
                    />{" "}
                    {
                      w.data!.members.find((m) => m.userId === c.guardianId)
                        ?.name
                    }{" "}
                    · contact ending {c.phone.slice(-4)} ·{" "}
                    {c.verifiedAt ? "Verified" : "Unverified"} ·{" "}
                    {c.optedOutAt
                      ? "Opted out"
                      : c.consentAt
                        ? "Consent recorded"
                        : "Consent missing"}
                  </label>
                ))}
              </fieldset>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={verified}
                  onChange={(e) => setVerified(e.target.checked)}
                />
                I reviewed this individual content and intended recipients
              </label>
              <Button disabled={w.busy || !verified || !recipients.length}>
                Queue WhatsApp notification
              </Button>
            </form>
          )}
          <DeliveryJobList
            academyId={w.shell?.academy.id}
            playerId={playerId}
            refreshKey={c.data}
            guardianName={(id) =>
              w.data!.members.find((m) => m.userId === id)?.name ??
              "Your contact"
            }
            canCancel={!parent}
            busy={w.busy}
            onCancel={(j) =>
              communicationCommand(w, {
                action: "cancel",
                data: { id: j.id },
              })
            }
          />
          {!parent && (
            <>
              {c.data.reminders
                .filter((r) => r.playerId === playerId)
                .map((r, i) => (
                  <p className="notice amber" key={i}>
                    {r.period}: {r.reason}
                  </p>
                ))}
              {c.data.unrouted.map((e) => (
                <div key={e.id}>
                  {e.guardianId && (
                    <strong>
                      {w.data!.members.find((m) => m.userId === e.guardianId)
                        ?.name ?? "Verified guardian"}
                    </strong>
                  )}
                  {e.body && <p>{e.body}</p>}
                  <p>
                    {e.outcome} · {e.receivedAt}. Staff must confirm the child
                    with the parent.
                  </p>
                  {e.outcome === "AMBIGUOUS_CHILD" && (
                    <Button
                      variant="secondary"
                      onClick={() =>
                        communicationCommand(w, {
                          action: "resolveReply",
                          data: { eventId: e.id, playerId },
                        })
                      }
                    >
                      Attach after confirming this child
                    </Button>
                  )}
                </div>
              ))}
            </>
          )}
        </>
      )}
    </Card>
  );
}
