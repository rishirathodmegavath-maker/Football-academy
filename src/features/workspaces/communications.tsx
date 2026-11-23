"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type {
  AudienceSummary,
  CommMessage,
  DeliveryRow,
  MessageChannel,
  MessagePreview,
  MessageRecipient,
  MessagingView,
  ShareItem,
} from "@/domain/messaging";
import { useMessaging } from "@/hooks/use-messaging";
import {
  COUNTRY_CALLING_CODE,
  gmailLink,
  mailtoLink,
  normalizePhone,
  outlookLink,
  savedPhoneLink,
} from "@/services/share-links";
import { resolveSessionTime } from "@/services/training-rules";
import type { PortalController } from "./portal-types";
import "./communications.css";
import { displayInstant } from "@/services/date-display";

/**
 * Communications: the same steps as the badminton app. Write an announcement, choose All families or only some, tick
 * Portal / Email / WhatsApp, approve, then schedule or send now. Families appear under "Ready to send" with free buttons
 * that open the sender's own mail or WhatsApp; Portal messages show in the family's app. "Opened" never means delivered.
 */
const TABS = [
  "Announcements",
  "Private conversations",
  "Templates",
  "Scheduled outbox",
  "Ready to send",
  "Delivery log",
] as const;
type Tab = (typeof TABS)[number];
const CHANNELS: MessageChannel[] = ["PORTAL", "EMAIL", "WHATSAPP"];
const CHANNEL_NAME: Record<MessageChannel, string> = {
  PORTAL: "Portal",
  EMAIL: "Email",
  WHATSAPP: "WhatsApp",
};
const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/** The one-sentence reason nobody can receive the message, with the fix. Null when at least one family can. */
export function whyNobody(
  audience: AudienceSummary,
  recipients: MessageRecipient[],
  channels: MessageChannel[],
): string | null {
  if (recipients.length) return null;
  if (!audience.players)
    return "No players are covered yet. Choose “All families”, or tick the batches or players you want to reach.";
  if (!audience.playersWithParent)
    return `${plural(audience.players, "player")} covered, but none has a parent account linked yet. Invite the parent first.`;
  if (audience.optedOut && !audience.reach.PORTAL)
    return `The ${plural(audience.optedOut, "parent")} for this audience opted out of messages, so nothing can be sent.`;
  const others = CHANNELS.filter(
    (c) => !channels.includes(c) && audience.reach[c] > 0,
  );
  if (others.length)
    return `None of the channels you ticked can reach anyone. Tick ${others
      .map((c) => `${CHANNEL_NAME[c]} (${plural(audience.reach[c], "family", "families")})`)
      .join(" or ")} instead.`;
  return "None of the parents can be reached on the channels you ticked. Tick another channel.";
}

function AudienceNote({
  audience,
  recipients,
  channels,
  showPeople = false,
}: {
  audience: AudienceSummary | null;
  recipients: MessageRecipient[] | null;
  channels: MessageChannel[];
  showPeople?: boolean;
}) {
  if (!audience || !recipients)
    return <p className="cm-muted">Checking who this would reach…</p>;
  const problem = whyNobody(audience, recipients, channels);
  return (
    <div className="cm-audience" role="status">
      <h3>
        {recipients.length
          ? `${plural(recipients.length, "family", "families")} will receive this`
          : "Nobody can receive this yet"}
      </h3>
      <p className="cm-muted">
        {plural(audience.players, "player")} covered · {audience.playersWithParent} with a parent account · can be reached:{" "}
        {CHANNELS.map((c) => `${CHANNEL_NAME[c]} ${audience.reach[c]}`).join(" · ")}
        {audience.optedOut > 0 && ` · ${audience.optedOut} opted out`}
      </p>
      {problem && (
        <div className="cm-error" role="alert">
          {problem}
        </div>
      )}
      {!problem && audience.needNumber > 0 && channels.includes("WHATSAPP") && (
        <p className="cm-muted">
          {plural(audience.needNumber, "parent")} {audience.needNumber === 1 ? "has" : "have"} no WhatsApp number saved yet. You
          can add it under “Ready to send”.
        </p>
      )}
      {showPeople &&
        recipients.map((r) => (
          <p key={r.userId}>
            {r.name} · {r.channels.map((c) => CHANNEL_NAME[c]).join(", ")}
          </p>
        ))}
    </div>
  );
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="cm-overlay" />
        <Dialog.Content className="cm-dialog" aria-describedby={undefined}>
          <header>
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close className="cm-icon" aria-label="Close">
              <X size={18} />
            </Dialog.Close>
          </header>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const STATE: Record<CommMessage["status"], { label: string; tone: string }> = {
  DRAFT: { label: "Draft", tone: "muted" },
  APPROVED: { label: "Approved", tone: "" },
  SCHEDULED: { label: "Scheduled", tone: "warn" },
  PROCESSED: { label: "Processed", tone: "" },
};
function Badge({ tone = "", children }: { tone?: string; children: ReactNode }) {
  return <span className={`portal-status ${tone}`}>{children}</span>;
}
const when = (iso: string | null, view: MessagingView) =>
  iso
    ? displayInstant(iso, view.timezone, { time: true })
    : "";

export function Communications({
  workspace: w,
  conversations,
  initialTab = "Announcements",
}: {
  workspace: PortalController;
  /** Opens on the private conversations when a player is already chosen. */
  initialTab?: Tab;
  /** The private-conversation screen (a player's conversations and parent development updates), shown in its own tab. */
  conversations: ReactNode;
}) {
  const academyId = (w.data ?? w.shell)!.academy.id;
  const m = useMessaging(academyId);
  const [tab, setTab] = useState<Tab>(initialTab);
  const view = m.view;
  // Scheduled messages are run when this page opens (only for a message that is due), so nothing waits for a button.
  const processed = useRef(false);
  useEffect(() => {
    if (!view?.permissions.approve || processed.current) return;
    const now = new Date().toISOString();
    if (
      !view.messages.some(
        (x) => x.status === "SCHEDULED" && (x.data.scheduledAt ?? "") <= now,
      )
    )
      return;
    processed.current = true;
    void m.run("messagingProcess");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);
  if (!view)
    return m.error ? (
      <p className="portal-card" role="alert">
        {m.error}
      </p>
    ) : (
      <p className="portal-card" role="status">
        Loading communications…
      </p>
    );
  return (
    <div className="cm">
      <nav className="cm-tabs" role="tablist" aria-label="Communications sections">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? "active" : ""}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </nav>
      {m.error && (
        <div className="cm-error" role="alert">
          {m.error}
        </div>
      )}
      {tab === "Announcements" && <Announcements view={view} m={m} />}
      {tab === "Private conversations" && (
        <div className="portal-workflow">{conversations}</div>
      )}
      {tab === "Templates" && <Templates view={view} m={m} />}
      {tab === "Scheduled outbox" && <Outbox view={view} m={m} />}
      {tab === "Ready to send" && <ReadyToSend view={view} m={m} />}
      {tab === "Delivery log" && <DeliveryLog view={view} rows={view.deliveries} />}
    </div>
  );
}
type Messaging = ReturnType<typeof useMessaging>;

function Announcements({ view, m }: { view: MessagingView; m: Messaging }) {
  const [editing, setEditing] = useState<{ id: string; version: number } | null>(null);
  const [templateId, setTemplateId] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  // "All families" or "Only selected" (the ticked batches and players). Choosing one never throws the other list away.
  const [audience, setAudience] = useState<"ALL" | "SELECTED">("ALL");
  const [batchIds, setBatchIds] = useState<string[]>([]);
  const [playerIds, setPlayerIds] = useState<string[]>([]);
  const [channels, setChannels] = useState<MessageChannel[]>(["PORTAL"]);
  const [channel, setChannel] = useState<MessageChannel>("PORTAL");
  const [recipients, setRecipients] = useState<MessageRecipient[] | null>(null);
  const [summary, setSummary] = useState<AudienceSummary | null>(null);
  const [dialog, setDialog] = useState<ReactNode>(null);
  const allBatches = audience === "ALL";
  const data = {
    subject,
    body,
    playerIds: allBatches ? [] : playerIds,
    batchIds: allBatches ? [] : batchIds,
    allBatches,
    channels,
    templateId: templateId || null,
  };
  // Who it would reach depends only on the audience and channels, so it is re-checked when those change (not while typing).
  const check = useRef(0);
  const key = JSON.stringify([allBatches, data.playerIds, data.batchIds, channels]);
  useEffect(() => {
    if (!channels.length) {
      setRecipients([]);
      setSummary({
        players: 0,
        playersWithParent: 0,
        reach: { PORTAL: 0, EMAIL: 0, WHATSAPP: 0 },
        needNumber: 0,
        optedOut: 0,
      });
      return;
    }
    const mine = ++check.current;
    m.call<MessagePreview>("messagingPreview", {
      data: {
        ...data,
        // The wording does not change who is covered, so placeholders keep the check working before anything is typed.
        subject: subject.length >= 2 ? subject : "Preview",
        body: body.length >= 3 ? body : "Preview",
      },
    })
      .then((r) => {
        if (mine !== check.current) return;
        setRecipients(r.recipients);
        setSummary(r.audience);
      })
      .catch(() => {
        if (mine === check.current) {
          setRecipients(null);
          setSummary(null);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, view.messages.length]);
  const reset = () => {
    setEditing(null);
    setSubject("");
    setBody("");
    setTemplateId("");
  };
  const toggle = (list: string[], set: (v: string[]) => void, id: string, on: boolean) =>
    set(on ? [...list, id] : list.filter((x) => x !== id));
  async function saveDraft(e: React.FormEvent) {
    e.preventDefault();
    const saved = await m.run<CommMessage>("messagingSave", {
      data: {
        action: "save",
        id: editing?.id,
        version: editing?.version,
        scheduledAt: null,
        data,
      },
    });
    if (saved) reset();
  }
  function edit(x: CommMessage) {
    setEditing({ id: x.id, version: x.version });
    setSubject(x.data.subject);
    setBody(x.data.body);
    setTemplateId(x.data.templateId ?? "");
    setAudience(x.data.allBatches ? "ALL" : "SELECTED");
    setBatchIds(x.data.batchIds);
    setPlayerIds(x.data.playerIds);
    setChannels(x.data.channels);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  async function review(x: CommMessage, approve: boolean) {
    let preview: MessagePreview;
    if (x.status === "DRAFT") {
      try {
        preview = await m.call<MessagePreview>("messagingPreview", {
          data: {
            subject: x.data.subject,
            body: x.data.body,
            playerIds: x.data.playerIds,
            batchIds: x.data.batchIds,
            allBatches: x.data.allBatches,
            channels: x.data.channels,
            templateId: x.data.templateId,
          },
        });
      } catch (e) {
        m.setError(e instanceof Error ? e.message : "Could not check the recipients.");
        return;
      }
    } else
      preview = {
        recipients: x.data.recipients,
        audience: {
          players: 0,
          playersWithParent: 0,
          reach: { PORTAL: 0, EMAIL: 0, WHATSAPP: 0 },
          needNumber: 0,
          optedOut: 0,
        },
      };
    const frozen = x.status !== "DRAFT";
    const blocked = !frozen && !preview.recipients.length;
    setDialog(
      <Modal
        title={approve && !blocked ? "Approve announcement" : blocked ? "Cannot approve yet" : "Recipient & message preview"}
        onClose={() => setDialog(null)}
      >
        <h3>{x.data.subject}</h3>
        <p className="cm-pre">{x.data.body}</p>
        {frozen ? (
          <div className="cm-audience">
            <h3>{plural(preview.recipients.length, "family", "families")} approved</h3>
            {preview.recipients.map((r) => (
              <p key={r.userId}>
                {r.name} · {r.channels.map((c) => CHANNEL_NAME[c]).join(", ")}
              </p>
            ))}
          </div>
        ) : (
          <AudienceNote
            audience={preview.audience}
            recipients={preview.recipients}
            channels={x.data.channels}
            showPeople
          />
        )}
        {blocked && (
          <p className="cm-muted">
            Use “Edit” on this draft to change who it goes to or which channels it uses, then approve.
          </p>
        )}
        <div className="cm-actions">
          <button className="button secondary" type="button" onClick={() => setDialog(null)}>
            {approve && !blocked ? "Back" : "Close"}
          </button>
          {approve && !blocked && (
            <button
              className="button primary"
              type="button"
              onClick={async () => {
                const ok = await m.run("messagingSave", {
                  data: { action: "approve", id: x.id, version: x.version },
                });
                if (ok) setDialog(null);
              }}
            >
              Approve exact message &amp; recipients
            </button>
          )}
        </div>
      </Modal>,
    );
  }
  function schedule(x: CommMessage) {
    setDialog(<ScheduleDialog view={view} m={m} x={x} onClose={() => setDialog(null)} />);
  }
  async function sendNow(x: CommMessage) {
    const ok = await m.run("messagingSave", {
      data: {
        action: "schedule",
        id: x.id,
        version: x.version,
        scheduledAt: new Date().toISOString(),
      },
    });
    if (ok) await m.run("messagingProcess");
  }
  const canWrite = true;
  return (
    <div className="cm-grid">
      <section className="portal-card cm-pane" aria-labelledby="cm-compose">
        <div className="cm-head">
          <h2 id="cm-compose">{editing ? "Edit announcement" : "Compose announcement"}</h2>
        </div>
        <form onSubmit={saveDraft} className="cm-form">
          <fieldset disabled={m.busy || !canWrite}>
            <label>
              Saved template
              <select
                value={templateId}
                onChange={(e) => {
                  setTemplateId(e.target.value);
                  const t = view.templates.find((x) => x.id === e.target.value);
                  if (t) {
                    setSubject(t.subject);
                    setBody(t.body);
                  }
                }}
              >
                <option value="">Choose template</option>
                {view.templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Subject
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                required
                minLength={2}
                maxLength={150}
              />
            </label>
            <label>
              Message
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={6}
                required
                minLength={3}
                maxLength={2000}
              />
              <small className="cm-muted">
                Keep it general: no child names or contact details. Use a private conversation for individual information.
              </small>
            </label>
            <fieldset className="cm-choice">
              <legend>Who should get it?</legend>
              <label>
                <input
                  type="radio"
                  name="cm-audience"
                  checked={audience === "ALL"}
                  onChange={() => setAudience("ALL")}
                />
                All families (every player you are allowed to message)
              </label>
              <label>
                <input
                  type="radio"
                  name="cm-audience"
                  checked={audience === "SELECTED"}
                  onChange={() => setAudience("SELECTED")}
                />
                Only the batches / players I choose
              </label>
            </fieldset>
            {audience === "SELECTED" && (
              <>
                <fieldset className="cm-choice">
                  <legend>Batches</legend>
                  {!view.batches.length && <p className="cm-muted">No batches available.</p>}
                  {view.batches.map((b) => (
                    <label key={b.id}>
                      <input
                        type="checkbox"
                        checked={batchIds.includes(b.id)}
                        onChange={(e) => toggle(batchIds, setBatchIds, b.id, e.target.checked)}
                      />
                      {b.name} <small className="cm-muted">({plural(b.players, "player")})</small>
                    </label>
                  ))}
                </fieldset>
                <fieldset className="cm-choice">
                  <legend>Players’ parents</legend>
                  {!view.players.length && <p className="cm-muted">No players available.</p>}
                  {view.players.map((p) => (
                    <label key={p.id}>
                      <input
                        type="checkbox"
                        checked={playerIds.includes(p.id)}
                        onChange={(e) => toggle(playerIds, setPlayerIds, p.id, e.target.checked)}
                      />
                      {p.name}
                    </label>
                  ))}
                </fieldset>
              </>
            )}
            <fieldset className="cm-choice">
              <legend>How</legend>
              {CHANNELS.map((c) => (
                <label key={c}>
                  <input
                    type="checkbox"
                    checked={channels.includes(c)}
                    onChange={(e) =>
                      setChannels(
                        e.target.checked ? [...channels, c] : channels.filter((x) => x !== c),
                      )
                    }
                  />
                  {CHANNEL_NAME[c]}
                  {c !== "PORTAL" &&
                    ` · you send it from your own ${c === "EMAIL" ? "mail app" : "WhatsApp"} (free)`}
                </label>
              ))}
            </fieldset>
            <div className="cm-actions">
              {editing && (
                <button type="button" className="button secondary" onClick={reset}>
                  Cancel edit
                </button>
              )}
              <button className="button primary" disabled={!channels.length}>
                {editing ? "Save changes" : "Save draft"}
              </button>
            </div>
          </fieldset>
        </form>
      </section>
      <div className="cm-side">
        <section className="portal-card cm-pane" aria-labelledby="cm-preview">
          <h2 id="cm-preview">Channel preview</h2>
          <div className="cm-tabs small" role="tablist" aria-label="Channel preview">
            {CHANNELS.map((c) => (
              <button
                key={c}
                type="button"
                role="tab"
                aria-selected={channel === c}
                className={channel === c ? "active" : ""}
                onClick={() => setChannel(c)}
              >
                {CHANNEL_NAME[c]}
              </button>
            ))}
          </div>
          <div className={`cm-sample ${channel.toLowerCase()}`}>
            <small>{view.academyName}</small>
            <h3>{subject || "Announcement subject"}</h3>
            <p className="cm-pre">{body || "Your message preview appears here as you write."}</p>
          </div>
          <Badge tone="muted">{channel === "PORTAL" ? "Private portal" : "Ready to share"}</Badge>
          <AudienceNote audience={summary} recipients={recipients} channels={channels} showPeople />
          <p className="cm-note">
            Save, review exact recipients, approve, then schedule or send now. Email and WhatsApp are free: after you send, each
            family appears under “Ready to send” with a button that opens your own WhatsApp or mail app.
          </p>
        </section>
      </div>
      <section className="portal-card cm-pane cm-wide" aria-labelledby="cm-saved">
        <h2 id="cm-saved">Saved announcements</h2>
        <MessageTable
          view={view}
          rows={view.messages}
          empty="No announcements yet. Write one above."
          actions={(x) => (
            <>
              <button type="button" className="cm-link" onClick={() => void review(x, false)}>
                Review recipients
              </button>
              {x.status === "DRAFT" && (
                <>
                  <button type="button" className="cm-link" onClick={() => edit(x)}>
                    Edit
                  </button>
                  {view.permissions.approve && (
                    <button type="button" className="cm-link" onClick={() => void review(x, true)}>
                      Approve
                    </button>
                  )}
                </>
              )}
              {x.status === "APPROVED" && view.permissions.approve && (
                <>
                  <button type="button" className="cm-link" disabled={m.busy} onClick={() => void sendNow(x)}>
                    Send now
                  </button>
                  <button type="button" className="cm-link" onClick={() => schedule(x)}>
                    Schedule
                  </button>
                </>
              )}
              {["APPROVED", "SCHEDULED"].includes(x.status) && (
                <button
                  type="button"
                  className="cm-link"
                  disabled={m.busy}
                  onClick={() =>
                    void m.run("messagingSave", {
                      data: { action: "revise", id: x.id, version: x.version },
                    })
                  }
                >
                  Revise draft
                </button>
              )}
            </>
          )}
        />
      </section>
      {dialog}
    </div>
  );
}

function MessageTable({
  view,
  rows,
  empty,
  actions,
}: {
  view: MessagingView;
  rows: CommMessage[];
  empty: string;
  actions?: (x: CommMessage) => ReactNode;
}) {
  if (!rows.length) return <p className="cm-muted">{empty}</p>;
  return (
    <div className="portal-table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Message</th>
            <th scope="col">Recipients</th>
            <th scope="col">State</th>
            {actions && <th scope="col">Actions</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((x) => (
            <tr key={x.id}>
              <td>
                <strong>{x.data.subject}</strong>
                <small className="cm-block cm-muted">{x.data.body.slice(0, 90)}</small>
              </td>
              <td>
                {x.data.recipients.length
                  ? `${x.data.recipients.length} approved`
                  : "Not approved yet"}
                <small className="cm-block cm-muted">
                  {x.data.channels.map((c) => CHANNEL_NAME[c]).join(" · ")}
                </small>
              </td>
              <td>
                <Badge tone={STATE[x.status].tone}>{STATE[x.status].label}</Badge>
                {x.status === "SCHEDULED" && (
                  <small className="cm-block cm-muted">{when(x.data.scheduledAt, view)}</small>
                )}
                {x.status === "PROCESSED" && (
                  <small className="cm-block cm-muted">{when(x.data.processedAt, view)}</small>
                )}
              </td>
              {actions && <td className="cm-row-actions">{actions(x)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ScheduleDialog({
  view,
  m,
  x,
  onClose,
}: {
  view: MessagingView;
  m: Messaging;
  x: CommMessage;
  onClose: () => void;
}) {
  const [date, setDate] = useState(view.today),
    [time, setTime] = useState("17:00"),
    [problem, setProblem] = useState("");
  return (
    <Modal title="Schedule approved announcement" onClose={onClose}>
      <p className="cm-note">
        Times use {view.timezone}. When the time comes, Email and WhatsApp appear under “Ready to send” with a button that opens
        your own mail app or WhatsApp (free), and Portal messages show in the family’s app.
      </p>
      <form
        className="cm-form"
        onSubmit={async (e) => {
          e.preventDefault();
          let scheduledAt: string;
          try {
            scheduledAt = resolveSessionTime(`${date}T${time}`, view.timezone);
          } catch {
            setProblem("Choose a valid local date and time.");
            return;
          }
          const ok = await m.run("messagingSave", {
            data: { action: "schedule", id: x.id, version: x.version, scheduledAt },
          });
          if (ok) onClose();
        }}
      >
        {problem && (
          <div className="cm-error" role="alert">
            {problem}
          </div>
        )}
        <label>
          Delivery date
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </label>
        <label>
          Delivery time
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} required />
        </label>
        <div className="cm-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Back
          </button>
          <button className="button primary" disabled={m.busy}>
            Schedule approved message
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Outbox({ view, m }: { view: MessagingView; m: Messaging }) {
  return (
    <section className="portal-card cm-pane">
      <div className="cm-head">
        <h2>Scheduled outbox</h2>
        {view.permissions.approve && (
          <button
            className="button secondary"
            disabled={m.busy}
            onClick={() => void m.run("messagingProcess")}
          >
            Process due approved messages
          </button>
        )}
      </div>
      <MessageTable
        view={view}
        rows={view.messages.filter((x) => x.status === "SCHEDULED")}
        empty="Nothing is scheduled. Approve an announcement, then press Schedule."
      />
    </section>
  );
}

function Templates({ view, m }: { view: MessagingView; m: Messaging }) {
  const [creating, setCreating] = useState(false),
    [name, setName] = useState(""),
    [subject, setSubject] = useState(""),
    [body, setBody] = useState("");
  return (
    <section className="portal-card cm-pane">
      <div className="cm-head">
        <h2>Saved templates</h2>
        {view.permissions.templates && (
          <button className="button primary" onClick={() => setCreating(true)}>
            Create template
          </button>
        )}
      </div>
      {view.templates.length ? (
        <div className="portal-table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Template</th>
                <th scope="col">Subject</th>
                <th scope="col">Message</th>
              </tr>
            </thead>
            <tbody>
              {view.templates.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td>{t.subject}</td>
                  <td>{t.body}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="cm-muted">
          No saved templates yet. A template is a message you write once and reuse; choosing one fills in the subject and message
          on the Announcements tab. They are optional.
        </p>
      )}
      {creating && (
        <Modal title="Create template" onClose={() => setCreating(false)}>
          <form
            className="cm-form"
            onSubmit={async (e) => {
              e.preventDefault();
              const ok = await m.run("messagingTemplate", { data: { name, subject, body } });
              if (ok) {
                setCreating(false);
                setName("");
                setSubject("");
                setBody("");
              }
            }}
          >
            {m.error && (
              <div className="cm-error" role="alert">
                {m.error}
              </div>
            )}
            <label>
              Template name
              <input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={80} />
            </label>
            <label>
              Subject
              <input value={subject} onChange={(e) => setSubject(e.target.value)} required minLength={2} maxLength={150} />
            </label>
            <label>
              Message
              <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} required minLength={3} maxLength={2000} />
            </label>
            <div className="cm-actions">
              <button type="button" className="button secondary" onClick={() => setCreating(false)}>
                Back
              </button>
              <button className="button primary" disabled={m.busy}>
                Save template
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}

function ReadyToSend({ view, m }: { view: MessagingView; m: Messaging }) {
  const [items, setItems] = useState<ShareItem[] | null>(null),
    [numbers, setNumbers] = useState<Record<string, string>>({}),
    [problem, setProblem] = useState("");
  const code = COUNTRY_CALLING_CODE[view.country] ?? null;
  const { call } = m;
  const load = useCallback(async () => {
    try {
      setItems((await call<{ items: ShareItem[] }>("messagingShareList")).items);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "Could not load the list.");
    }
  }, [call]);
  useEffect(() => {
    void load();
  }, [load]);
  const text = (i: ShareItem) => `${i.body}\n\n— ${view.academyName}`;
  const opened = async (i: ShareItem) => {
    if (i.status === "OPENED") return;
    try {
      await call("messagingOpened", { id: i.id });
      await Promise.all([load(), m.reload()]);
    } catch {
      /* recording that a button was pressed must never block opening the app */
    }
  };
  async function saveNumber(userId: string) {
    setProblem("");
    const typed = numbers[userId] ?? "";
    if (!normalizePhone(typed, code)) {
      setProblem("Enter the number with its country code, for example +91 98765 43210.");
      return;
    }
    const ok = await m.run("setPhone", { data: { userId, phone: typed } }, { refresh: false });
    if (ok) await load();
  }
  return (
    <section className="portal-card cm-pane">
      <h2>Ready to send</h2>
      <p className="cm-note">
        Nothing is sent from here. Press a button and your own mail app or WhatsApp opens with the family’s message ready; you press
        Send there. “Opened” only means you pressed the button, not that the message was sent or read.
      </p>
      {problem && (
        <div className="cm-error" role="alert">
          {problem}
        </div>
      )}
      {!items ? (
        <p className="cm-muted" role="status">
          Loading…
        </p>
      ) : !items.length ? (
        <p className="cm-muted">
          Nothing is waiting. After you send an approved announcement with Email or WhatsApp ticked, each family appears here.
        </p>
      ) : (
        <div className="portal-table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Message</th>
                <th scope="col">To</th>
                <th scope="col">Send</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td>
                    <strong>{i.subject}</strong>
                  </td>
                  <td>
                    {i.name}{" "}
                    <small className="cm-muted">
                      · {i.channel === "EMAIL" ? i.email : (i.phone ?? "no WhatsApp number yet")}
                    </small>
                  </td>
                  <td className="cm-row-actions">
                    {i.channel === "EMAIL" ? (
                      <>
                        <a
                          className="button primary"
                          href={mailtoLink(i.email, i.subject, text(i))}
                          onClick={() => void opened(i)}
                        >
                          {i.status === "OPENED" ? "Opened mail app" : "Open mail app"}
                        </a>
                        <a
                          className="button secondary"
                          target="_blank"
                          rel="noopener noreferrer"
                          href={gmailLink(i.email, i.subject, text(i))}
                          onClick={() => void opened(i)}
                        >
                          Gmail
                        </a>
                        <a
                          className="button secondary"
                          target="_blank"
                          rel="noopener noreferrer"
                          href={outlookLink(i.email, i.subject, text(i))}
                          onClick={() => void opened(i)}
                        >
                          Outlook
                        </a>
                      </>
                    ) : i.phone ? (
                      <a
                        className="button primary"
                        target="_blank"
                        rel="noopener noreferrer"
                        href={savedPhoneLink(i.phone, text(i))}
                        onClick={() => void opened(i)}
                      >
                        {i.status === "OPENED" ? "Opened WhatsApp" : "Open WhatsApp"}
                      </a>
                    ) : (
                      <span className="cm-inline">
                        <input
                          type="tel"
                          aria-label={`WhatsApp number for ${i.name}`}
                          placeholder="+91 98765 43210"
                          value={numbers[i.userId] ?? ""}
                          onChange={(e) => setNumbers({ ...numbers, [i.userId]: e.target.value })}
                        />
                        <button
                          type="button"
                          className="button secondary"
                          disabled={m.busy || !(numbers[i.userId] ?? "").trim()}
                          onClick={() => void saveNumber(i.userId)}
                        >
                          Save number
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function DeliveryLog({ view, rows }: { view: MessagingView; rows: DeliveryRow[] }) {
  const tone = (s: DeliveryRow["status"]) =>
    s === "SKIPPED" ? "warn" : s === "OPENED" ? "" : s === "AVAILABLE" ? "" : "muted";
  const label: Record<DeliveryRow["status"], string> = {
    AVAILABLE: "In the app",
    READY_TO_SHARE: "Ready to share",
    OPENED: "Opened",
    SKIPPED: "Skipped",
  };
  return (
    <section className="portal-card cm-pane">
      <h2>Delivery history</h2>
      {rows.length ? (
        <div className="portal-table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Message</th>
                <th scope="col">Family</th>
                <th scope="col">Channel</th>
                <th scope="col">Status</th>
                <th scope="col">When</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.subject}</td>
                  <td>{r.name}</td>
                  <td>{CHANNEL_NAME[r.channel]}</td>
                  <td>
                    <Badge tone={tone(r.status)}>{label[r.status]}</Badge>
                    {r.status === "SKIPPED" && <small className="cm-block cm-muted">{r.detail}</small>}
                  </td>
                  <td>{when(r.openedAt ?? r.createdAt, view)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="cm-muted">No deliveries yet. They appear once an approved announcement is sent.</p>
      )}
      <p className="cm-note">
        “Opened” means a send button was pressed. The app cannot know whether an email or WhatsApp message was sent or read.
      </p>
    </section>
  );
}
