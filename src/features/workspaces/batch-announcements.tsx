"use client";
import { AnnouncementShare } from "./announcement-sharing";
import { useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { Button } from "@/components/ui/primitives";
import { displayInstant } from "@/services/date-display";
import { useAnnouncements } from "@/hooks/use-announcements";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import type { useWorkspace } from "@/hooks/use-workspace";
import type {
  AnnouncementDraft,
  AnnouncementPreview,
  AnnouncementPublic,
} from "@/domain/batch-announcement";
import "./batch-announcements.css";
type Workspace = ReturnType<typeof useWorkspace>;
const kinds = {
  SESSION_CANCELLED: "Session cancelled",
  VENUE_CHANGED: "Venue changed",
  TIME_CHANGED: "Training time changed",
  ACADEMY_HOLIDAY: "Academy holiday",
  SPECIAL_PRACTICE: "Special practice session",
  OPERATIONAL: "Operational update",
} as const;
/** What the user is told after each step succeeds. Nothing here claims a
 * WhatsApp delivery: that is tracked per recipient once queued. */
const outcome = {
  save: "Draft saved. Use Send announcement for approval when it is ready.",
  submit:
    "Sent for approval. An owner or admin must approve it before guardians can see it.",
  approve:
    "Approved. Guardians of the selected batches can now read it in the app until it expires.",
  queue:
    "Queued for WhatsApp delivery. Delivery is tracked per recipient below; none is claimed until the provider confirms it.",
  cancel: "Announcement cancelled. Guardians no longer see it in the app.",
} as const;
export function BatchAnnouncements({ workspace }: { workspace: Workspace }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  if (
    !workspace.data ||
    !["OWNER", "ADMIN", "COACH"].includes(workspace.data.membership.role)
  )
    return null;
  return (
    <>
      <button
        ref={trigger}
        className="button secondary"
        onClick={() => setOpen(true)}
      >
        Batch announcements
      </button>
      {open && (
        <AnnouncementEditor
          workspace={workspace}
          onClose={() => setOpen(false)}
          returnFocus={() => trigger.current?.focus()}
        />
      )}
    </>
  );
}
function AnnouncementEditor({
  workspace: w,
  onClose,
  returnFocus,
}: {
  workspace: Workspace;
  onClose: () => void;
  returnFocus: () => void;
}) {
  const c = useAnnouncements(w.data!.academy.id);
  const [draft, setDraft] = useState<AnnouncementDraft>(() => ({
      kind: "OPERATIONAL",
      urgency: "NORMAL",
      batchIds: [],
      body: "",
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    })),
    [record, setRecord] = useState<AnnouncementPublic>(),
    [preview, setPreview] = useState<AnnouncementPreview>(),
    [verified, setVerified] = useState(false),
    [dirty, setDirty] = useState(false),
    [audience, setAudience] = useState("ONE"),
    [notice, setNotice] = useState("");
  useUnsavedChanges(dirty);
  const canApprove = ["OWNER", "ADMIN"].includes(w.data!.membership.role);
  function change(next: Partial<AnnouncementDraft>) {
    setDraft({ ...draft, ...next });
    setPreview(undefined);
    setVerified(false);
    setDirty(true);
    setNotice("");
  }
  function load(next: AnnouncementPublic) {
    setRecord(next);
    setDraft({
      kind: next.kind,
      urgency: next.urgency,
      batchIds: next.batchIds,
      body: next.body,
      expiresAt: next.expiresAt,
    });
    setAudience(next.batchIds.length === 1 ? "ONE" : "MULTIPLE");
    setDirty(false);
    setPreview(undefined);
    setVerified(false);
    setNotice("");
  }
  async function perform(action: string) {
    const next = await c.run<AnnouncementPublic>(
      action,
      action === "save"
        ? draft
        : {
            verified: true,
            genericPrivacyConfirmed: true,
            fingerprint: preview?.fingerprint,
          },
      record?.id,
      record?.version ?? 0,
    );
    if (next) {
      load(next);
      setNotice(outcome[action as keyof typeof outcome]);
    }
  }
  function close() {
    if (!dirty || window.confirm("Discard the unsaved announcement draft?"))
      onClose();
  }
  const hint = !draft.batchIds.length
    ? "Choose at least one batch to save the draft."
    : record?.status === "DRAFT" && dirty
      ? "You have unsaved changes. Save the draft before sending it for approval."
      : record?.status === "PENDING_APPROVAL"
        ? !canApprove
          ? "Waiting for an owner or admin to review and approve this announcement."
          : dirty
            ? "You have unsaved changes. Save the draft again, then resubmit it for approval."
            : !preview
              ? "To approve: preview the recipients and message, then tick the review box."
              : !verified
                ? "Tick the review box to enable Approve."
                : ""
        : record?.status === "APPROVED"
          ? `Guardians of the selected batches can read this in the app until ${displayInstant(
              record.expiresAt,
              w.data!.academy.timezone,
              {
                time: true,
                hour12: w.data!.academy.timeFormat !== "24_HOUR",
              },
            )}. To message them too, use the free buttons below (your own WhatsApp or mail).`
          : "";
  const localExpiry = new Date(
    Date.parse(draft.expiresAt) -
      new Date(draft.expiresAt).getTimezoneOffset() * 60000,
  )
    .toISOString()
    .slice(0, 16);
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !c.busy) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="batch-announcement-overlay" />
        <Dialog.Content
          className="batch-announcement-dialog"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocus();
          }}
          onEscapeKeyDown={(event) => {
            if (c.busy) event.preventDefault();
          }}
        >
          <header>
            <div>
              <Dialog.Title>Batch announcements</Dialog.Title>
              <Dialog.Description>
                Generic operational messages · {w.data!.academy.name}. Approved
                announcements appear in the app for the guardians of the
                selected batches; WhatsApp delivery is separate.
              </Dialog.Description>
            </div>
            <button
              className="portal-icon-button"
              aria-label="Close batch announcements"
              disabled={c.busy}
              onClick={close}
            >
              <X size={20} />
            </button>
          </header>
          <div className="batch-announcement-scroll">
            {!c.data ? (
              <p role="status">
                {c.error
                  ? "Authorised batches could not load. Close and reopen to retry."
                  : "Loading authorised batches…"}
              </p>
            ) : (
              <>
                {record && (
                  <Button
                    variant="secondary"
                    disabled={c.busy}
                    onClick={() => {
                      if (
                        dirty &&
                        !window.confirm(
                          "Discard the unsaved announcement draft?",
                        )
                      )
                        return;
                      setRecord(undefined);
                      setDraft({
                        kind: "OPERATIONAL",
                        urgency: "NORMAL",
                        batchIds: [],
                        body: "",
                        expiresAt: new Date(
                          Date.now() + 86400000,
                        ).toISOString(),
                      });
                      setPreview(undefined);
                      setVerified(false);
                      setDirty(false);
                      setNotice("");
                      setAudience("ONE");
                    }}
                  >
                    New announcement
                  </Button>
                )}
                {c.data.announcements.length > 0 && (
                  <label>
                    Saved announcements
                    <select
                      aria-label="Saved announcements"
                      value={record?.id ?? ""}
                      onChange={(event) => {
                        const next = c.data!.announcements.find(
                          (item) => item.id === event.target.value,
                        );
                        if (
                          next &&
                          (!dirty ||
                            window.confirm(
                              "Discard the unsaved announcement draft?",
                            ))
                        )
                          load(next);
                      }}
                    >
                      <option value="">New announcement</option>
                      {c.data.announcements.map((item) => (
                        <option key={item.id} value={item.id}>
                          {kinds[item.kind]} · {item.status}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <form
                  id="batch-announcement-form"
                  className="form-stack"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void perform("save");
                  }}
                >
                  <p>
                    Use generic batch information only. Do not include any
                    child’s name, personal goal, private report or guardian
                    contact. Urgency does not bypass consent, quiet hours or
                    approved templates.
                  </p>
                  <label>
                    Announcement type
                    <select
                      aria-label="Announcement type"
                      value={draft.kind}
                      onChange={(event) =>
                        change({
                          kind: event.target.value as AnnouncementDraft["kind"],
                        })
                      }
                    >
                      {Object.entries(kinds).map(([key, label]) => (
                        <option key={key} value={key}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Urgency
                    <select
                      aria-label="Urgency"
                      value={draft.urgency}
                      onChange={(event) =>
                        change({
                          urgency: event.target
                            .value as AnnouncementDraft["urgency"],
                        })
                      }
                    >
                      <option value="NORMAL">Normal</option>
                      <option value="URGENT">Urgent operational update</option>
                    </select>
                  </label>
                  <label>
                    Audience
                    <select
                      aria-label="Announcement audience"
                      value={audience}
                      onChange={(event) => {
                        const value = event.target.value;
                        setAudience(value);
                        change({
                          batchIds:
                            value === "ALL"
                              ? c.data!.batches.map((batch) => batch.id)
                              : [],
                        });
                      }}
                    >
                      <option value="ONE">One batch</option>
                      <option value="MULTIPLE">Multiple batches</option>
                      <option value="ALL">All batches</option>
                    </select>
                  </label>
                  {audience === "ONE" ? (
                    <label>
                      Batch
                      <select
                        aria-label="Announcement batch"
                        required
                        value={draft.batchIds[0] ?? ""}
                        onChange={(event) =>
                          change({ batchIds: [event.target.value] })
                        }
                      >
                        <option value="">Choose an authorised batch</option>
                        {c.data.batches.map((batch) => (
                          <option key={batch.id} value={batch.id}>
                            {batch.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <fieldset>
                      <legend>Authorised batches</legend>
                      <label className="check-row">
                        <input
                          type="checkbox"
                          checked={
                            !!c.data.batches.length &&
                            draft.batchIds.length === c.data.batches.length
                          }
                          onChange={(event) => {
                            setAudience("MULTIPLE");
                            change({
                              batchIds: event.target.checked
                                ? c.data!.batches.map((batch) => batch.id)
                                : [],
                            });
                          }}
                        />
                        Select all
                      </label>
                      {c.data.batches.map((batch) => (
                        <label className="check-row" key={batch.id}>
                          <input
                            type="checkbox"
                            checked={draft.batchIds.includes(batch.id)}
                            onChange={(event) => {
                              setAudience("MULTIPLE");
                              change({
                                batchIds: event.target.checked
                                  ? [...draft.batchIds, batch.id]
                                  : draft.batchIds.filter(
                                      (id) => id !== batch.id,
                                    ),
                              });
                            }}
                          />
                          {batch.name} · {batch.players} players
                        </label>
                      ))}
                    </fieldset>
                  )}
                  <label>
                    Generic announcement
                    <textarea
                      required
                      maxLength={400}
                      rows={4}
                      value={draft.body}
                      onChange={(event) => change({ body: event.target.value })}
                    />
                  </label>
                  <label>
                    Announcement expires
                    <input
                      required
                      type="datetime-local"
                      value={localExpiry}
                      onChange={(event) => {
                        if (event.target.value)
                          change({
                            expiresAt: new Date(
                              event.target.value,
                            ).toISOString(),
                          });
                      }}
                    />
                  </label>
                </form>
                <Button
                  variant="secondary"
                  disabled={
                    c.busy || !draft.batchIds.length || !draft.body.trim()
                  }
                  onClick={async () => {
                    const result = await c.run<AnnouncementPreview>(
                      "preview",
                      draft,
                    );
                    if (result) {
                      setPreview(result);
                      setVerified(false);
                    }
                  }}
                >
                  Preview recipients and message
                </Button>
                {preview && (
                  <section aria-label="Announcement recipient preview">
                    <h3>{preview.eligibleCount} eligible recipients</h3>
                    <p>
                      {preview.inAppCount} guardian
                      {preview.inAppCount === 1 ? "" : "s"} will read this in
                      the app once it is approved.
                    </p>
                    <p>
                      {preview.deduplicatedCount} duplicate child/contact
                      selections removed.
                    </p>
                    <p className="message-body">{preview.renderedBody}</p>
                    {preview.recipients.map((recipient) => (
                      <p key={recipient.guardianId}>
                        {w.data!.members.find(
                          (member) => member.userId === recipient.guardianId,
                        )?.name ?? "Authorised guardian"}{" "}
                        · contact ending {recipient.contactEnding}
                      </p>
                    ))}
                    {preview.excluded.map((item, index) => (
                      <p key={index}>Excluded: {item.reason}</p>
                    ))}
                    {!!preview.blockers.length && (
                      <p>
                        <strong>WhatsApp delivery is not ready yet:</strong>
                      </p>
                    )}
                    {preview.blockers.map((item) => (
                      <p className="notice amber" key={item}>
                        {item}
                      </p>
                    ))}
                    {!!preview.blockers.length && (
                      <p>
                        You do not need this. After approval, send the message
                        yourself, free, from your own WhatsApp or mail.
                      </p>
                    )}
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={verified}
                        onChange={(event) => setVerified(event.target.checked)}
                      />
                      I reviewed the final message, generic privacy, eligible
                      recipients and exclusions
                    </label>
                  </section>
                )}
                {record && ["APPROVED", "QUEUED"].includes(record.status) && (
                  <AnnouncementShare
                    workspace={w}
                    announcementId={record.id}
                  />
                )}
                {record && (
                  <p>
                    Saved status: {record.status}. External delivery is tracked
                    separately for each recipient.
                  </p>
                )}
                {record &&
                  c.data.jobs
                    .filter((job) => job.sourceId === record.id)
                    .map((job) => (
                      <p key={job.id}>
                        {job.state} · {job.reason ?? "Awaiting worker checks"}
                      </p>
                    ))}
              </>
            )}
          </div>
          <div className="batch-announcement-feedback">
            {c.error && <p role="alert">{c.error}</p>}
            {notice && <p role="status">{notice}</p>}
            {hint && !c.error && <p>{hint}</p>}
          </div>
          <footer>
            <Button
              form="batch-announcement-form"
              type="submit"
              disabled={
                c.busy ||
                !c.data ||
                !draft.batchIds.length ||
                (!!record && ["QUEUED", "CANCELLED"].includes(record.status))
              }
            >
              Save announcement draft
            </Button>
            {record?.status === "DRAFT" && (
              <Button
                variant="secondary"
                disabled={c.busy || dirty}
                onClick={() => void perform("submit")}
              >
                Send announcement for approval
              </Button>
            )}
            {record?.status === "PENDING_APPROVAL" && canApprove && (
              <Button
                disabled={c.busy || dirty || !verified || !preview}
                onClick={() => void perform("approve")}
              >
                Approve announcement
              </Button>
            )}
            {record?.status === "APPROVED" && (
              <Button
                disabled={
                  c.busy ||
                  dirty ||
                  !verified ||
                  !preview ||
                  !!preview.blockers.length
                }
                onClick={() => void perform("queue")}
              >
                Queue approved announcement
              </Button>
            )}
            {record && record.status !== "CANCELLED" && (
              <Button
                variant="secondary"
                disabled={c.busy || dirty}
                onClick={() => void perform("cancel")}
              >
                Cancel announcement
              </Button>
            )}
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
