"use client";
import { useEffect, useRef, useState } from "react";
import { whatsappLink } from "@/services/share-links";
import { isCalendarDay, isUnder18, todayIn } from "@/domain/player-age";
import { workspaceRequest } from "@/hooks/use-workspace";
import { displayDay } from "@/services/date-display";
import type { PortalController } from "./portal-types";
import "./portal-field.css";

/**
 * "Add player with invitation link" (owner and admin) and the player's own details form.
 * The server decides everything that matters (who may make a link, that it works once, what the player may set and the
 * under-18 rule: see server/player-link-service.ts); nothing here is relied on for any of it.
 */
const origin = () => window.location.origin;

export function PlayerLinkPanel({
  workspace: w,
  onClose,
}: {
  workspace: PortalController;
  onClose: () => void;
}) {
  const d = w.data!,
    coaches = d.members.filter(
      (m) => m.active && ["OWNER", "ADMIN", "COACH"].includes(m.role),
    ),
    [coachId, setCoachId] = useState(d.membership.userId),
    [link, setLink] = useState(""),
    [copied, setCopied] = useState(false),
    field = useRef<HTMLInputElement>(null),
    text = (url: string) =>
      `${d.academy.name} has invited you to join as a player. Open this link, sign in, and fill in your own details: ${url}`;
  return (
    <div className="portal-form-grid">
      <p>
        You do not need to type the player&apos;s details. Create a link, send it to the player yourself (copy it, or
        share it on WhatsApp), and they sign in and fill in their own name and date of birth. The link works once, for
        whoever opens it first, and expires in 7 days. What they type waits on this Players screen until you confirm it
        and say that a parent or guardian has agreed (the app does not collect or check that agreement). You can cancel the
        link or make a new one under Settings, Team, Invite people.
      </p>
      {!link ? (
        <>
          <label>
            Who looks after this player
            <select
              value={coachId}
              disabled={w.busy}
              onChange={(e) => setCoachId(e.target.value)}
            >
              {coaches.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                </option>
              ))}
            </select>
            <small className="muted">
              The player appears under this person. You can place them in a batch afterwards.
            </small>
          </label>
          {w.error && <p role="alert">{w.error}</p>}
          <button
            type="button"
            className="button primary"
            disabled={w.busy}
            onClick={async () => {
              const result = await w.action<{ token: string }>(
                "playerLink",
                undefined,
                { coachId },
              );
              if (result) setLink(`${origin()}/join/${result.token}`);
            }}
          >
            {w.busy ? "Creating…" : "Create invitation link"}
          </button>
        </>
      ) : (
        <div role="group" aria-label="Player invitation to share">
          <p role="status">
            Link ready. Anyone who opens it can use it once, so send it only to the player (or their parent).
          </p>
          <input
            ref={field}
            readOnly
            aria-label="Player invitation link"
            value={link}
            onFocus={(e) => e.currentTarget.select()}
          />
          <div className="portal-actions">
            <button
              type="button"
              className="button primary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(link);
                } catch {
                  field.current?.select();
                  document.execCommand("copy");
                }
                setCopied(true);
                setTimeout(() => setCopied(false), 2500);
              }}
            >
              {copied ? "Link copied" : "Copy link"}
            </button>
            <a
              className="button secondary"
              target="_blank"
              rel="noopener noreferrer"
              href={whatsappLink(undefined, text(link), null)}
            >
              Share on WhatsApp
            </a>
            <button type="button" className="button secondary" onClick={onClose}>
              Done
            </button>
          </div>
          <small className="muted">
            This link cannot be shown again after you close this window. If you lose it, make a new one.
          </small>
        </div>
      )}
    </div>
  );
}

export type SelfPlayerState = "details" | "waiting" | "none";

/**
 * Where a signed-in member is in joining with a player link: still to fill in their details, waiting for the academy to confirm
 * them, or neither. `state` is undefined while the server is being asked. The server holds the fact; this only asks.
 */
export function useSelfPlayerState(
  academyId: string,
  role: string | undefined,
): { state: SelfPlayerState | undefined; set: (next: SelfPlayerState) => void } {
  const [state, setState] = useState<SelfPlayerState | undefined>(
    role === "PARENT" ? undefined : "none",
  );
  useEffect(() => {
    if (role !== "PARENT") return;
    let current = true;
    workspaceRequest<{ state: SelfPlayerState }>(
      `/api/workspaces/${academyId}/actions`,
      "POST",
      { action: "selfPlayerStatus" },
    )
      .then((r) => current && setState(r.state))
      .catch(() => current && setState("none"));
    return () => {
      current = false;
    };
  }, [academyId, role]);
  return { state, set: setState };
}

/** Shown to a member who has sent their details and is waiting for the academy to confirm them. */
export function SelfPlayerWaiting({ academyName }: { academyName: string }) {
  return (
    <main className="portal-self-details" aria-labelledby="self-waiting-title">
      <h1 id="self-waiting-title">Thank you. Your details are with {academyName}.</h1>
      <p role="status">
        The academy will check them and confirm that a parent or guardian has agreed. When they have, reload this page and
        your home screen will open. You can close this page and come back later.
      </p>
    </main>
  );
}

type Duplicate = {
  id: string;
  name: string;
  birthDate: string;
  status: string;
  reason: string;
};
type Waiting = {
  userId: string;
  name: string;
  birthDate: string;
  position: string;
  submittedAt: string;
  coachName: string;
  possibleDuplicates: Duplicate[];
};
export type SelfPlayerList = {
  /** undefined while the server is being asked; false when player links are switched off for this deployment. */
  enabled: boolean | undefined;
  items: Waiting[];
  setItems: (update: (list: Waiting[]) => Waiting[]) => void;
};

/** Owner and admin: asks the server once for the players waiting to be confirmed, and whether player links are switched on. */
export function useSelfPlayerList(workspace: PortalController, admin: boolean): SelfPlayerList {
  const academyId = workspace.data!.academy.id,
    [items, setItems] = useState<Waiting[]>([]),
    [enabled, setEnabled] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    if (!admin) return;
    let current = true;
    workspaceRequest<{ enabled: boolean; items: Waiting[] }>(
      `/api/workspaces/${academyId}/actions`,
      "POST",
      { action: "selfPlayerList" },
    )
      .then((r) => {
        if (!current) return;
        setItems(r.items);
        setEnabled(r.enabled);
      })
      .catch(() => current && setItems([]));
    return () => {
      current = false;
    };
  }, [academyId, admin]);
  return { enabled, items, setItems };
}

/** Owner and admin: the players who filled in their own details and wait to be confirmed. Renders nothing when nobody is waiting. */
export function PlayerApprovals({
  workspace: w,
  list,
}: {
  workspace: PortalController;
  list: SelfPlayerList;
}) {
  const academyId = w.data!.academy.id,
    url = `/api/workspaces/${academyId}/actions`,
    { items, setItems, enabled } = list,
    [agreed, setAgreed] = useState<Record<string, boolean>>({}),
    [different, setDifferent] = useState<Record<string, boolean>>({}),
    [declining, setDeclining] = useState(""),
    [busy, setBusy] = useState(""),
    [problem, setProblem] = useState("");
  if (!items.length && !problem) return null;
  const decide = async (userId: string, decision: "approve" | "decline") => {
    setBusy(userId);
    setProblem("");
    try {
      await workspaceRequest(url, "POST", {
        action: "selfPlayerDecide",
        data: {
          userId,
          decision,
          consentOnFile: decision === "approve" ? agreed[userId] === true : undefined,
          differentPlayer: decision === "approve" ? different[userId] === true : undefined,
        },
      });
      setItems((list) => list.filter((x) => x.userId !== userId));
      setDeclining("");
      void w.invalidate("workspace", "home");
    } catch (failure) {
      setProblem(
        failure instanceof Error
          ? failure.message
          : "That could not be saved. Please try again.",
      );
    } finally {
      setBusy("");
    }
  };
  return (
    <section className="portal-card portal-approvals" aria-labelledby="player-approvals-title">
      <h2 id="player-approvals-title">Players waiting for your confirmation</h2>
      <p className="muted">
        These players filled in their own details after using a player link. They are not on your player list until you
        confirm them. Confirm only when a parent or guardian has agreed to the player joining. This screen records only that
        you say they have: it does not collect or check the agreement, so keep it with your enrolment records.
      </p>
      {enabled === false && (
        <p role="status">
          Player invitation links are switched off for this deployment, so players cannot be confirmed now. You can still decline a
          request.
        </p>
      )}
      {problem && <p role="alert">{problem}</p>}
      <ul>
        {items.map((x) => (
          <li key={x.userId}>
            <strong>{x.name}</strong>
            <span>
              {" "}
              · born {displayDay(x.birthDate)}
              {x.position ? ` · ${x.position}` : ""}
              {x.coachName ? ` · looked after by ${x.coachName}` : ""}
            </span>
            {x.possibleDuplicates.length > 0 && (
              <div role="group" aria-label={`Possible duplicates of ${x.name}`} className="portal-duplicates">
                <p>
                  <strong>This may be a player you already have.</strong> Nothing is merged. Check the list, then tick the box
                  below only if this is a different person.
                </p>
                <ul>
                  {x.possibleDuplicates.map((p) => (
                    <li key={p.id}>
                      {p.name}
                      {p.birthDate ? ` · born ${displayDay(p.birthDate)}` : ""} · {p.status.toLowerCase()} ({p.reason.toLowerCase()})
                    </li>
                  ))}
                </ul>
                <label className="portal-check">
                  <input
                    type="checkbox"
                    checked={different[x.userId] === true}
                    onChange={(e) => setDifferent((a) => ({ ...a, [x.userId]: e.target.checked }))}
                  />
                  <span>{x.name} is a different player from the ones listed.</span>
                </label>
              </div>
            )}
            <label className="portal-check">
              <input
                type="checkbox"
                checked={agreed[x.userId] === true}
                onChange={(e) => setAgreed((a) => ({ ...a, [x.userId]: e.target.checked }))}
              />
              <span>A parent or guardian of {x.name} has agreed to this player joining.</span>
            </label>
            <div className="portal-actions">
              <button
                type="button"
                className="button primary"
                disabled={
                  busy === x.userId ||
                  enabled === false ||
                  agreed[x.userId] !== true ||
                  (x.possibleDuplicates.length > 0 && different[x.userId] !== true)
                }
                onClick={() => decide(x.userId, "approve")}
              >
                Confirm {x.name}
              </button>
              {declining === x.userId ? (
                <>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy === x.userId}
                    onClick={() => decide(x.userId, "decline")}
                  >
                    Yes, decline and remove access
                  </button>
                  <button type="button" className="button secondary" onClick={() => setDeclining("")}>
                    Keep waiting
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy === x.userId}
                  onClick={() => setDeclining(x.userId)}
                >
                  Decline {x.name}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function SelfPlayerDetails({
  academyId,
  academyName,
  timezone,
  onDone,
}: {
  academyId: string;
  academyName: string;
  timezone: string;
  onDone: () => void;
}) {
  const [name, setName] = useState(""),
    [birthDate, setBirthDate] = useState(""),
    [position, setPosition] = useState(""),
    [aware, setAware] = useState(false),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [problem, setProblem] = useState(""),
    [busy, setBusy] = useState(false),
    nameInput = useRef<HTMLInputElement>(null),
    birthInput = useRef<HTMLInputElement>(null);
  const check = () => {
    const found: Record<string, string> = {},
      today = todayIn(timezone);
    if (name.trim().length < 2) found.name = "Enter your name.";
    if (!birthDate) found.birth = "Enter your date of birth.";
    else if (!isCalendarDay(birthDate) || birthDate > today)
      found.birth = "Choose a valid date of birth.";
    else if (!isUnder18(birthDate, today))
      found.birth =
        "Players at this academy must be under 18. Ask the academy owner for help.";
    if (!aware) found.aware = "Confirm that a parent or guardian knows you are joining.";
    return found;
  };
  return (
    <main className="portal-self-details" aria-labelledby="self-details-title">
      <h1 id="self-details-title">Tell {academyName} about yourself</h1>
      <p>
        You are signed in. Fill in your own details. The academy will check them and confirm that a parent or guardian has
        agreed before you can use the app.
      </p>
      <form
        className="portal-form-grid"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          setProblem("");
          const found = check();
          setErrors(found);
          if (found.name) return nameInput.current?.focus();
          if (found.birth) return birthInput.current?.focus();
          if (found.aware) return;
          setBusy(true);
          try {
            await workspaceRequest(
              `/api/workspaces/${academyId}/actions`,
              "POST",
              {
                action: "selfPlayerSubmit",
                data: { name, birthDate, position, guardianAware: true },
              },
            );
            onDone();
          } catch (failure) {
            setProblem(
              failure instanceof Error
                ? failure.message
                : "Your details could not be saved. Please try again.",
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          <span id="self-name-label">Your name</span>
          <input
            ref={nameInput}
            aria-labelledby="self-name-label"
            autoComplete="name"
            aria-required="true"
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={errors.name ? "self-name-error" : undefined}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setErrors((x) => ({ ...x, name: "" }));
            }}
          />
          {errors.name && (
            <small id="self-name-error" role="alert" className="portal-field-error">
              {errors.name}
            </small>
          )}
        </label>
        <label>
          <span id="self-birth-label">Date of birth (players must be under 18)</span>
          <input
            ref={birthInput}
            aria-labelledby="self-birth-label"
            type="date"
            aria-required="true"
            aria-invalid={errors.birth ? true : undefined}
            aria-describedby={errors.birth ? "self-birth-error" : undefined}
            value={birthDate}
            onChange={(e) => {
              setBirthDate(e.target.value);
              setErrors((x) => ({ ...x, birth: "" }));
            }}
          />
          {errors.birth && (
            <small id="self-birth-error" role="alert" className="portal-field-error">
              {errors.birth}
            </small>
          )}
        </label>
        <label>
          <span id="self-position-label">Position (optional)</span>
          <input
            aria-labelledby="self-position-label"
            value={position}
            maxLength={200}
            onChange={(e) => setPosition(e.target.value)}
          />
        </label>
        <label className="portal-check">
          <input
            type="checkbox"
            aria-labelledby="self-aware-label"
            checked={aware}
            aria-invalid={errors.aware ? true : undefined}
            aria-describedby={errors.aware ? "self-aware-error" : undefined}
            onChange={(e) => {
              setAware(e.target.checked);
              setErrors((x) => ({ ...x, aware: "" }));
            }}
          />
          <span id="self-aware-label">
            A parent or guardian knows that I am joining this academy. The academy will ask them to confirm.
          </span>
          {errors.aware && (
            <small id="self-aware-error" role="alert" className="portal-field-error">
              {errors.aware}
            </small>
          )}
        </label>
        {problem && <p role="alert">{problem}</p>}
        {busy && <p role="status">Saving your details…</p>}
        <button className="button primary" disabled={busy}>
          Send my details
        </button>
      </form>
    </main>
  );
}
