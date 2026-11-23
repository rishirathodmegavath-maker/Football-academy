"use client";
import { useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Plus,
  Upload,
  Users,
  ClipboardList,
  UserRound,
  Target,
  CalendarDays,
  MessageSquare,
  FileText,
  Pencil,
  X,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import type { WorkspacePlayer } from "@/domain/workspace";
import { isCalendarDay, isUnder18, todayIn } from "@/domain/player-age";
import "./portal-field.css";
import { AgeReview } from "./age-review";
import { Enquiries } from "./enquiries";
import { PlayerApprovals, PlayerLinkPanel, useSelfPlayerList } from "./player-link";
import {
  PLAYER_STATUSES,
  PLAYER_STATUS_LABELS,
  isArchived,
  participates,
  transitionNeedsManager,
} from "@/domain/player-lifecycle";
import { usePlayerSessions, useReportList } from "@/hooks/use-reports";
import {
  currentPlayerPlan,
  playerBatch,
  playerReportHistory,
  portalDate,
  playerAge,
  academyDate,
} from "@/services/portal-records";
import {
  confirmUnsavedChanges,
  useUnsavedChanges,
} from "@/hooks/use-unsaved-changes";
import {
  FOOTBALL_PLAYER_POSITIONS,
  STANDARD_PLAYER_AGE_CATEGORIES,
  UNDECIDED_PLAYER_POSITION,
  UNASSIGNED_PLAYER_BATCH,
  isKnownPlayerPosition,
  playerPositionLabel,
} from "@/services/player-form-options";
import type { PortalController, PortalNavigate } from "./portal-types";
import { PortalTrials } from "./portal-trials";

function PlayerEditor({
  workspace: w,
  player,
  onSaved,
}: {
  workspace: PortalController;
  player?: WorkspacePlayer;
  onSaved: (id: string) => void;
}) {
  const d = w.data!,
    admin = ["OWNER", "ADMIN"].includes(d.membership.role);
  const currentBatchId =
    player?.squadId ||
    (player
      ? (d.records.squad.find((s) => s.playerIds.includes(player.id))?.id ?? "")
      : "");
  const initial = {
    name: player?.name ?? "",
    squad: player?.squad ?? "",
    squadId: currentBatchId,
    coachId: player?.coachId ?? d.membership.userId,
    ageCategory: player?.ageCategory ?? "",
    birthDate: player?.birthDate ?? "",
    position: player?.position ?? "",
    status: player?.status ?? "ACTIVE",
    placementReviewed: false,
  };
  const [form, setForm] = useState(initial),
    [notice, setNotice] = useState(""),
    [errors, setErrors] = useState<{
      name?: string;
      birthDate?: string;
      placement?: string;
    }>({});
  const nameInput = useRef<HTMLInputElement | null>(null),
    birthInput = useRef<HTMLInputElement | null>(null),
    placementInput = useRef<HTMLInputElement | null>(null);
  const ageCategories = [
    ...new Set([
      ...d.academy.ageGroups,
      ...STANDARD_PLAYER_AGE_CATEGORIES,
      ...(form.ageCategory ? [form.ageCategory] : []),
    ]),
  ];
  const currentBatchUnavailable =
    !!initial.squadId && !d.records.squad.some((s) => s.id === initial.squadId);
  const legacyPosition =
    player?.position && !isKnownPlayerPosition(player.position)
      ? player.position
      : undefined;
  useUnsavedChanges(JSON.stringify(initial) !== JSON.stringify(form));
  const field = (key: keyof typeof form, value: string | boolean) => {
    setForm({ ...form, [key]: value });
    if (key === "name" || key === "birthDate")
      setErrors((current) => ({ ...current, [key]: undefined }));
    if (key === "placementReviewed")
      setErrors((current) => ({ ...current, placement: undefined }));
  };
  const placement = !!player && form.squadId !== initial.squadId;
  // What is missing or impossible, in the order the fields appear. The server checks everything again.
  const problems = () => {
    const found: { name?: string; birthDate?: string; placement?: string } = {};
    if (!form.name.trim()) found.name = "Enter the player's name.";
    if (!form.birthDate) found.birthDate = "Enter the player's date of birth.";
    else if (!isCalendarDay(form.birthDate))
      found.birthDate = "Enter a real date of birth.";
    else if (form.birthDate > todayIn(d.academy.timezone))
      found.birthDate = "The date of birth cannot be in the future.";
    // The form no longer lets the browser check its fields (the two above have their own messages), so the one other required
    // control, the placement-review tick, is checked here: the same rule the browser applied before.
    if (placement && !form.placementReviewed)
      found.placement = "Tick the box to confirm you reviewed the training placement change.";
    return found;
  };
  return (
    <form
      className="form-stack"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        setNotice("");
        const found = problems();
        setErrors(found);
        if (found.name || found.birthDate || found.placement) {
          (found.name
            ? nameInput
            : found.birthDate
              ? birthInput
              : placementInput
          ).current?.focus();
          return;
        }
        const result = await w.save<WorkspacePlayer>(
          "player",
          {
            name: form.name,
            ageCategory: form.ageCategory,
            birthDate: form.birthDate,
            position: form.position,
            ...(!player || placement ? { squadId: form.squadId } : {}),
            coachId: form.coachId,
            status: form.status,
            placementReviewed: form.placementReviewed,
            sportIds: ["football"],
            expectedVersion: player?.recordVersion,
          },
          player?.id,
        );
        if (result) onSaved(result.id);
        else
          setNotice(
            "Player was not confirmed. Your draft is retained; review the error before retrying.",
          );
      }}
    >
      <div className="portal-form-grid">
        <label>
          <span id="player-name-label">Player name</span>
          <input
            ref={nameInput}
            aria-labelledby="player-name-label"
            aria-required="true"
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={errors.name ? "player-name-error" : undefined}
            maxLength={200}
            value={form.name}
            onChange={(e) => field("name", e.target.value)}
          />
          {errors.name && (
            <small id="player-name-error" role="alert" className="portal-field-error">
              {errors.name}
            </small>
          )}
        </label>
        <label>
          Age category
          <select
            value={form.ageCategory}
            onChange={(e) => field("ageCategory", e.target.value)}
          >
            <option value="">Not recorded</option>
            {ageCategories.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span id="player-birth-label">Date of birth (players must be under 18)</span>
          <input
            ref={birthInput}
            aria-labelledby="player-birth-label"
            type="date"
            aria-required="true"
            aria-invalid={errors.birthDate ? true : undefined}
            aria-describedby={errors.birthDate ? "player-birth-error" : undefined}
            max={new Date().toISOString().slice(0, 10)}
            value={form.birthDate}
            onChange={(e) => field("birthDate", e.target.value)}
          />
          {errors.birthDate && (
            <small id="player-birth-error" role="alert" className="portal-field-error">
              {errors.birthDate}
            </small>
          )}
        </label>
        <label>
          Position
          <select
            value={form.position}
            onChange={(e) => field("position", e.target.value)}
          >
            <option value="">{UNDECIDED_PLAYER_POSITION}</option>
            {FOOTBALL_PLAYER_POSITIONS.map((position) => (
              <option key={position} value={position}>
                {position}
              </option>
            ))}
            {legacyPosition && (
              <option value={legacyPosition}>
                Current position: {legacyPosition}
              </option>
            )}
          </select>
        </label>
        <label>
          Training batch
          <select
            disabled={!admin}
            value={form.squadId}
            onChange={(e) => field("squadId", e.target.value)}
          >
            <option value="">{UNASSIGNED_PLAYER_BATCH}</option>
            {currentBatchUnavailable && (
              <option value={initial.squadId}>
                Current batch unavailable — assignment retained
              </option>
            )}
            {d.records.squad.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Assigned coach
          <select
            required
            disabled={!admin}
            value={form.coachId}
            onChange={(e) => field("coachId", e.target.value)}
          >
            {d.members
              .filter(
                (m) => m.active && ["OWNER", "ADMIN", "COACH"].includes(m.role),
              )
              .map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          Status
          <select
            value={form.status}
            disabled={
              !admin && transitionNeedsManager(player?.status, form.status)
            }
            onChange={(e) => field("status", e.target.value)}
          >
            {PLAYER_STATUSES.filter(
              (s) =>
                admin ||
                s === form.status ||
                !transitionNeedsManager(player?.status ?? "ACTIVE", s),
            ).map((s) => (
              <option key={s} value={s}>
                {PLAYER_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!participates(form.status) && (
        <p role="note">
          {isArchived(form.status)
            ? "Archived: the profile and its history stay readable, but no new records, invoices or announcements are created until an owner or admin restores it."
            : "Not taking part: this player is left off new session rosters, recurring fee suggestions and announcements. Existing history is kept."}
        </p>
      )}
      <p>
        Age category is separate from training placement. Optional individual
        tasks never promote a player automatically.
      </p>
      {placement && (
        <>
          <label className="check-row">
            <input
              ref={placementInput}
              type="checkbox"
              required
              aria-invalid={errors.placement ? true : undefined}
              aria-describedby={errors.placement ? "player-placement-error" : undefined}
              checked={form.placementReviewed}
              onChange={(e) => field("placementReviewed", e.target.checked)}
            />
            I reviewed this training placement change.
          </label>
          {errors.placement && (
            <small id="player-placement-error" role="alert" className="portal-field-error">
              {errors.placement}
            </small>
          )}
        </>
      )}
      {notice && <p role="alert">{notice}</p>}
      {w.error && <p role="alert">{w.error}</p>}
      <button className="button primary" disabled={w.busy}>
        {w.busy ? "Saving…" : player ? "Save player" : "Add player"}
      </button>
    </form>
  );
}
function PlayerImport({
  workspace: w,
  onDone,
  onSaving,
}: {
  workspace: PortalController;
  onDone: () => void;
  onSaving: (saving: boolean) => void;
}) {
  const [text, setText] = useState(""),
    [results, setResults] = useState(""),
    [review, setReview] = useState<string[][] | null>(null),
    [saving, setSaving] = useState(false);
  const pending = useRef(false);
  useUnsavedChanges(!!text.trim());
  return (
    <form
      className="form-stack"
      onSubmit={async (e) => {
        e.preventDefault();
        if (
          pending.current ||
          !["OWNER", "ADMIN"].includes(w.data!.membership.role)
        )
          return;
        if (review) {
          pending.current = true;
          setSaving(true);
          onSaving(true);
          let count = 0;
          try {
            for (const row of review) {
              const result = await w.save("player", {
                name: row[0],
                squad: row[1],
                ageCategory: row[2],
                birthDate: row[3],
                coachId: w.data!.membership.userId,
                sportIds: ["football"],
              });
              if (!result) {
                setText(
                  review
                    .slice(count)
                    .map((row) => row.join(", "))
                    .join("\n"),
                );
                setReview(null);
                setResults(
                  `${count} players saved. Remaining rows are retained for correction and another review; confirmed rows were removed.`,
                );
                return;
              }
              count++;
            }
            setText("");
            setReview(null);
            setResults(`${count} players saved to this academy.`);
          } finally {
            pending.current = false;
            setSaving(false);
            onSaving(false);
          }
          return;
        }
        const lines = text
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean);
        if (!lines.length || lines.length > 100) {
          setResults("Import up to 100 players at a time.");
          return;
        }
        const parsed = lines.map((l) => l.split(",").map((s) => s.trim()));
        if (parsed.some((r) => r.length !== 4 || r[0].length < 2 || !r[1])) {
          setResults(
            "Each row must contain name, batch label, age category, date of birth (YYYY-MM-DD). Commas inside values are not supported.",
          );
          return;
        }
        const today = todayIn(w.data!.academy.timezone);
        const bad = parsed.findIndex(
          (r) => !isCalendarDay(r[3]) || r[3] > today || !isUnder18(r[3], today),
        );
        if (bad >= 0) {
          setResults(
            `Row ${bad + 1} (${parsed[bad][0]}): the date of birth must be a real day (YYYY-MM-DD) that makes the player under 18. Players must be under 18.`,
          );
          return;
        }
        setReview(parsed);
        setResults(
          `${parsed.length} rows validated. Review the names, batch labels and age categories below. Nothing has been saved yet.`,
        );
      }}
    >
      <p>
        Paste one player per line: name, batch label, age category, date of
        birth (YYYY-MM-DD). Players must be under 18. New players
        are assigned to your staff account. Configure roster membership and
        guardian invitations after review.
      </p>
      <textarea
        required
        rows={8}
        aria-label="Player import rows"
        value={text}
        disabled={Boolean(review) || saving}
        onChange={(e) => {
          setText(e.target.value);
          setReview(null);
        }}
        placeholder="Player name, U12 Foundations, U12, 2014-05-20"
      />
      {review && (
        <>
          <div className="portal-table-wrap">
            <table>
              <caption>Players ready for your review</caption>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Batch label</th>
                  <th>Age category</th>
                  <th>Date of birth</th>
                </tr>
              </thead>
              <tbody>
                {review.map((row, index) => (
                  <tr key={index}>
                    <td>{row[0]}</td>
                    <td>{row[1]}</td>
                    <td>{row[2] || "Not recorded"}</td>
                    <td>{row[3]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            type="button"
            className="button secondary"
            disabled={saving}
            onClick={() => {
              setReview(null);
              setResults("");
            }}
          >
            Edit rows
          </button>
          <p>
            Confirming creates these academy player records. These labels do not
            assign a dated session roster or invite a guardian.
          </p>
        </>
      )}
      {results && <p role="status">{results}</p>}
      {w.error && <p role="alert">{w.error}</p>}
      <div className="portal-actions">
        <button
          className="button primary"
          disabled={w.busy || saving || !text.trim()}
        >
          {saving
            ? "Importing reviewed players…"
            : review
              ? `Confirm import of ${review.length} players`
              : "Validate and review rows"}
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={saving || w.busy}
          onClick={() => {
            if (confirmUnsavedChanges()) onDone();
          }}
        >
          Close import
        </button>
      </div>
    </form>
  );
}
export function PortalPlayers({
  workspace: w,
  playerId,
  onNavigate,
  query = "",
  create = false,
}: {
  workspace: PortalController;
  playerId: string;
  onNavigate: PortalNavigate;
  query?: string;
  create?: boolean;
}) {
  const d = w.data!,
    reportList = useReportList(w),
    scheduled = usePlayerSessions(w, playerId),
    [today] = useState(() => academyDate(d)),
    [search, setSearch] = useState(query),
    [batch, setBatch] = useState(""),
    [age, setAge] = useState(""),
    [position, setPosition] = useState(""),
    [status, setStatus] = useState(""),
    [page, setPage] = useState(1),
    [tab, setTab] = useState("Overview"),
    [edit, setEdit] = useState<WorkspacePlayer | null>(null),
    [importing, setImport] = useState(false),
    [linking, setLinking] = useState(false),
    [importSaving, setImportSaving] = useState(false);
  const filtering = Boolean(search || batch || age || position || status);
  const clearFilters = () => {
    setSearch("");
    setBatch("");
    setAge("");
    setPosition("");
    setStatus("");
    setPage(1);
  };
  const player = d.records.player.find((p) => p.id === playerId),
    admin = ["OWNER", "ADMIN"].includes(d.membership.role),
    selfPlayers = useSelfPlayerList(w, admin),
    canWrite = ["OWNER", "ADMIN", "COACH"].includes(d.membership.role);
  const rows = d.records.player.filter(
    (p) =>
      (!search || p.name.toLowerCase().includes(search.toLowerCase())) &&
      (!batch || playerBatch(d, p) === batch) &&
      (!age || p.ageCategory === age) &&
      (!position ||
        (position === "__unset__"
          ? !p.position?.trim()
          : p.position === position)) &&
      (!status || (p.status ?? "ACTIVE") === status),
  );
  const legacyPositions = [
    ...new Set(
      d.records.player
        .map((p) => p.position)
        .filter(
          (value): value is string =>
            typeof value === "string" &&
            !!value.trim() &&
            !isKnownPlayerPosition(value),
        ),
    ),
  ];
  const currentPage = Math.min(page, Math.max(1, Math.ceil(rows.length / 10))),
    display = rows.slice((currentPage - 1) * 10, currentPage * 10);
  const plan = player && currentPlayerPlan(d, player.id),
    history = player
      ? playerReportHistory(reportList.data ?? [], player.id)
      : [];
  const next =
    player &&
    (scheduled.data ?? [])
      .filter(
        (s) =>
          s.roster.some((p) => p.playerId === player.id) &&
          s.status === "SCHEDULED" &&
          s.endAt > new Date().toISOString(),
      )
      .sort((a, b) => a.startAt.localeCompare(b.startAt))[0];
  const closeEditor = () => {
    if (w.busy) return;
    if (confirmUnsavedChanges()) {
      setEdit(null);
      if (create) onNavigate("players", { create: "" });
    }
  };
  return (
    <>
      <div
        className={
          player
            ? "portal-detail-grid portal-players-layout"
            : "portal-players-layout"
        }
      >
        <div>
          <div className="portal-page-heading">
            <div>
              <h1>Players</h1>
              <p>
                Manage your squad, track development and personalise training.
              </p>
            </div>
            <div className="portal-actions">
              {admin && (
                <Enquiries workspace={w} today={today} onNavigate={onNavigate} />
              )}
              {admin && (
                <button
                  className="button secondary"
                  onClick={() => setImport(true)}
                >
                  <Upload size={16} /> Import players
                </button>
              )}
              {admin && selfPlayers.enabled === true && (
                <button
                  className="button secondary"
                  disabled={w.busy}
                  onClick={() => setLinking(true)}
                >
                  <Plus size={16} /> Add player with invitation link
                </button>
              )}
              {canWrite && (
                <button
                  className="button primary"
                  disabled={w.busy}
                  onClick={() => onNavigate("players", { create: "player" })}
                >
                  <Plus size={17} /> Add player
                </button>
              )}
            </div>
          </div>
          {admin && selfPlayers.enabled === false && (
            <p className="muted" role="note">
              Player invitation links are switched off for this deployment. Add players with Add player.
            </p>
          )}
          {admin && <PlayerApprovals workspace={w} list={selfPlayers} />}
          {canWrite && (
            <AgeReview workspace={w} today={today} onEdit={(p) => setEdit(p)} />
          )}
          <div className="portal-filters">
            <label className="portal-filter-label">
              <span className="sr-only">Search players</span>
              <input
                aria-label="Search player directory"
                placeholder="Search players…"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
              />
            </label>
            {[
              {
                label: "All batches",
                value: batch,
                set: setBatch,
                values: [
                  ...new Set(d.records.player.map((p) => playerBatch(d, p))),
                ],
              },
              {
                label: "All age groups",
                value: age,
                set: setAge,
                values: [
                  ...new Set(
                    d.records.player.map((p) => p.ageCategory).filter(Boolean),
                  ),
                ],
              },
            ].map((f) => (
              <select
                aria-label={f.label}
                key={f.label}
                value={f.value}
                onChange={(e) => {
                  f.set(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">{f.label}</option>
                {f.values.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            ))}
            <select
              aria-label="All positions"
              value={position}
              onChange={(e) => {
                setPosition(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All positions</option>
              <option value="__unset__">{UNDECIDED_PLAYER_POSITION}</option>
              {FOOTBALL_PLAYER_POSITIONS.map((position) => (
                <option key={position} value={position}>
                  {position}
                </option>
              ))}
              {legacyPositions.map((position) => (
                <option key={position} value={position}>
                  {position} (existing)
                </option>
              ))}
            </select>
            <select
              aria-label="Player status filter"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All statuses</option>
              {PLAYER_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {PLAYER_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
          <div className="portal-stat-grid">
            {/* Each card does something: Total players clears every filter, Trial players shows the trial players, and for the
                owner and admin Batches and Assigned coaches open the screens that manage them. A card with nothing to open
                stays a plain figure. */}
            {(
              [
                {
                  n: d.records.player.length,
                  label: "Total players",
                  Icon: Users,
                  hint: "Show every player",
                  pressed: !search && !batch && !age && !position && !status,
                  go: () => {
                    setSearch("");
                    setBatch("");
                    setAge("");
                    setPosition("");
                    setStatus("");
                    setPage(1);
                  },
                },
                {
                  n: d.records.squad.length,
                  label: "Batches",
                  Icon: ClipboardList,
                  hint: "Open branches and batches",
                  go: admin
                    ? () => onNavigate("settings", { tab: "sessions" })
                    : undefined,
                },
                {
                  n: new Set(d.records.player.map((p) => p.coachId)).size,
                  label: "Assigned coaches",
                  Icon: UserRound,
                  hint: "Open the team",
                  go: admin
                    ? () => onNavigate("settings", { tab: "team" })
                    : undefined,
                },
                {
                  n: d.records.player.filter((p) => p.status === "TRIAL").length,
                  label: "Trial players",
                  Icon: Users,
                  hint: "Show trial players only",
                  pressed: status === "TRIAL",
                  go: () => {
                    setStatus(status === "TRIAL" ? "" : "TRIAL");
                    setPage(1);
                  },
                },
              ] as {
                n: number;
                label: string;
                Icon: typeof Users;
                hint: string;
                pressed?: boolean;
                go?: () => void;
              }[]
            ).map(({ n, label, Icon, hint, pressed, go }) => {
              const body = (
                <>
                  <span className="portal-round">
                    <Icon size={23} />
                  </span>
                  <span>
                    <strong>{n}</strong>
                    <p>{label}</p>
                  </span>
                </>
              );
              return go ? (
                <button
                  type="button"
                  className={`portal-card portal-stat portal-stat-button${pressed ? " active" : ""}`}
                  key={label}
                  title={hint}
                  aria-label={`${label}: ${n}. ${hint}`}
                  aria-pressed={pressed}
                  data-leave-editor
                  onClick={go}
                >
                  {body}
                </button>
              ) : (
                <div className="portal-card portal-stat" key={label}>
                  {body}
                </div>
              );
            })}
          </div>
          <div className="portal-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Player</th>
                  <th>Age</th>
                  <th>Category</th>
                  <th>Position</th>
                  <th>Batch</th>
                  <th>Status</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {display.map((p) => (
                  <tr
                    key={p.id}
                    className={p.id === player?.id ? "selected" : ""}
                  >
                    <td>
                      <button
                        className="portal-player-name"
                        onClick={() => {
                          setTab("Overview");
                          onNavigate("players", { player: p.id });
                        }}
                      >
                        <span className="portal-initials">
                          <UserRound size={22} />
                        </span>
                        <strong>{p.name}</strong>
                      </button>
                    </td>
                    <td>{playerAge(p.birthDate, today) ?? "—"}</td>
                    <td>{p.ageCategory || "—"}</td>
                    <td>{playerPositionLabel(p.position)}</td>
                    <td>{playerBatch(d, p)}</td>
                    <td>
                      <span
                        className={`portal-status ${p.status === "TRIAL" ? "muted" : p.status && !participates(p.status) ? "warn" : ""}`}
                      >
                        {(p.status ?? "ACTIVE").toLowerCase()}
                      </span>
                    </td>
                    <td>
                      {canWrite ? (
                        <button
                          className="portal-icon"
                          disabled={w.busy}
                          aria-label={`Edit ${p.name}`}
                          onClick={() => setEdit(p)}
                        >
                          <Pencil size={16} />
                        </button>
                      ) : (
                        <span aria-label="Read-only support access">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!rows.length &&
              (d.records.player.length ? (
                <div className="portal-empty" role="status">
                  <Users size={30} />
                  <h2>No players match these filters</h2>
                  <p>Try a different search, or clear the filters to see everyone.</p>
                  {filtering && (
                    <button className="button secondary" onClick={clearFilters}>
                      Clear filters
                    </button>
                  )}
                </div>
              ) : (
                <div className="portal-empty">
                  <Users size={30} />
                  <h2>Add your first football player</h2>
                  <p>
                    Each academy starts empty. Player records and guardian
                    relationships belong only to this academy.
                  </p>
                  {canWrite && (
                    <button
                      className="button primary"
                      disabled={w.busy}
                      onClick={() => onNavigate("players", { create: "player" })}
                    >
                      Add player
                    </button>
                  )}
                </div>
              ))}
            <div className="portal-table-footer">
              <span>
                {rows.length
                  ? `${(currentPage - 1) * 10 + 1}–${Math.min(currentPage * 10, rows.length)} of ${rows.length} players`
                  : "0 players"}
              </span>
              <div className="portal-actions">
                <button
                  className="portal-icon"
                  disabled={currentPage === 1}
                  aria-label="Previous player page"
                  onClick={() => setPage(currentPage - 1)}
                >
                  <ChevronLeft size={17} />
                </button>
                <span>{currentPage}</span>
                <button
                  className="portal-icon"
                  disabled={currentPage * 10 >= rows.length}
                  aria-label="Next player page"
                  onClick={() => setPage(currentPage + 1)}
                >
                  <ChevronRight size={17} />
                </button>
              </div>
            </div>
          </div>
          {playerId && !player && (
            <p role="alert">
              The selected player is unavailable for your current academy and
              assignment. Choose an authorised player.
            </p>
          )}
        </div>
        {player && (
          <aside className="portal-detail-panel portal-player-detail">
            <div className="portal-detail-title">
              <span className="portal-initials large">
                <UserRound size={48} />
              </span>
              <div>
                <h2>{player.name}</h2>
                <p>
                  {player.ageCategory || "Age category not recorded"} ·{" "}
                  {playerPositionLabel(player.position)}
                </p>
                <div className="portal-player-status-actions">
                  <span className="portal-status">
                    {(player.status ?? "ACTIVE").toLowerCase()}
                  </span>
                  {canWrite && (
                    <button
                      className="button secondary portal-edit-player"
                      disabled={w.busy}
                      onClick={() => setEdit(player)}
                    >
                      <Pencil size={16} /> Edit player
                    </button>
                  )}
                </div>
              </div>
              <button
                className="portal-icon"
                aria-label="Close player details"
                onClick={() => onNavigate("players", { player: "" })}
              >
                <X size={18} />
              </button>
            </div>
            <nav className="portal-tabs" aria-label="Player details">
              {[
                "Overview",
                "Training",
                "Reports",
                ...(admin ? ["Fees"] : []),
                "Parents",
              ].map((t) => (
                <button
                  className={tab === t ? "active" : ""}
                  key={t}
                  onClick={() => setTab(t)}
                >
                  {t}
                </button>
              ))}
            </nav>
            {tab === "Overview" && (
              <>
                <div className="portal-focus">
                  <span className="portal-round">
                    <Target size={24} />
                  </span>
                  <div>
                    <h3>Current focus</h3>
                    <h3>{plan?.focus ?? "Follows the shared batch plan"}</h3>
                    <p>
                      {plan?.observe ??
                        "Optional personal focus can be added after coach review."}
                    </p>
                  </div>
                </div>
                <div className="portal-info-grid">
                  <div>
                    <small>Age group</small>
                    <strong>{player.ageCategory || "Not recorded"}</strong>
                  </div>
                  <div>
                    <small>Position</small>
                    <strong>{playerPositionLabel(player.position)}</strong>
                  </div>
                  <div>
                    <small>Batch</small>
                    <strong>{playerBatch(d, player)}</strong>
                  </div>
                  <div>
                    <small>Coach</small>
                    <strong>
                      {d.members.find((m) => m.userId === player.coachId)
                        ?.name ?? "Assigned coach"}
                    </strong>
                  </div>
                </div>
                <section className="portal-card portal-player-journey">
                  <div className="portal-card-heading">
                    <h3>Development journey</h3>
                    <button
                      className="portal-link"
                      onClick={() => setTab("Reports")}
                    >
                      View all
                    </button>
                  </div>
                  {!reportList.data ? (
                    <p role="status">Loading reports…</p>
                  ) : history.length ? (
                    history.slice(0, 3).map((r) => (
                      <button
                        key={r.id}
                        className="portal-player-history"
                        onClick={() =>
                          onNavigate("reports", {
                            player: player.id,
                            report: r.id,
                          })
                        }
                      >
                        <time>{r.period}</time>
                        <span>
                          {r.focus}
                          <small>{r.nextStep}</small>
                        </span>
                      </button>
                    ))
                  ) : (
                    <p>
                      Approved development reports will appear here after
                      review.
                    </p>
                  )}
                </section>
                <section className="portal-card portal-player-next">
                  <div className="portal-card-heading">
                    <h3>Next session</h3>
                    {canWrite && (
                      <button
                        className="portal-link"
                        onClick={() =>
                          onNavigate("calendar", {
                            player: player.id,
                            session: next?.id,
                          })
                        }
                      >
                        View in calendar
                      </button>
                    )}
                  </div>
                  {next ? (
                    <>
                      <p>
                        <CalendarDays size={17} /> {portalDate(next.startAt, d)}
                      </p>
                      <p>
                        {portalDate(next.startAt, d, true)} –{" "}
                        {portalDate(next.endAt, d, true)}
                      </p>
                      <p>{next.location}</p>
                      <button
                        className="button primary"
                        onClick={() =>
                          onNavigate("training", {
                            player: player.id,
                            session: next.id,
                          })
                        }
                      >
                        View plan
                      </button>
                    </>
                  ) : (
                    <p>No upcoming confirmed session recorded.</p>
                  )}
                </section>
                <PortalTrials key={player.id} workspace={w} player={player} />
              </>
            )}
            {tab === "Training" && (
              <div className="portal-workflow">
                <h3>{plan?.focus ?? "Shared batch plan"}</h3>
                <p>
                  {plan?.reason ??
                    "Players inherit their session’s batch plan. Personalisation is optional."}
                </p>
                <button
                  className="button primary"
                  onClick={() =>
                    onNavigate("development", { player: player.id })
                  }
                >
                  {canWrite ? "View or personalise plan" : "View approved plan"}
                </button>
                {canWrite && (
                  <button
                    className="button secondary"
                    onClick={() =>
                      onNavigate("training", {
                        player: player.id,
                        session: next?.id,
                      })
                    }
                  >
                    Open training
                  </button>
                )}
              </div>
            )}
            {tab === "Reports" && (
              <div className="portal-workflow">
                {history.map((r) => (
                  <button
                    className="button secondary"
                    key={r.id}
                    onClick={() =>
                      onNavigate("reports", { player: player.id, report: r.id })
                    }
                  >
                    <FileText size={16} /> {r.period} · Approved
                  </button>
                ))}
                {reportList.data && !history.length && (
                  <p>No approved reports yet.</p>
                )}
                <button
                  className="button primary"
                  onClick={() => onNavigate("reports", { player: player.id })}
                >
                  Open player reports
                </button>
              </div>
            )}
            {tab === "Fees" && (
              <div className="portal-workflow">
                <p>
                  View this player’s actual invoices, verified payments and
                  outstanding balance.
                </p>
                <button
                  className="button primary"
                  onClick={() => onNavigate("fees", { player: player.id })}
                >
                  Open fee account
                </button>
              </div>
            )}
            {tab === "Parents" && (
              <div className="portal-workflow">
                <h3>Verified guardian relationships</h3>
                {d.guardians
                  ?.filter((g) => g.playerId === player.id)
                  .map((g) => (
                    <p key={g.userId}>
                      <UserRound size={16} /> {g.name}
                    </p>
                  ))}
                {!d.guardians?.some((g) => g.playerId === player.id) && (
                  <p>No guardian account is linked yet.</p>
                )}
                {admin && (
                  <button
                    className="button secondary"
                    onClick={() =>
                      onNavigate("settings", { player: player.id, tab: "team" })
                    }
                  >
                    Invite a verified guardian
                  </button>
                )}
              </div>
            )}
            <div className="portal-actions portal-player-footer">
              {canWrite && (
                <button
                  className="button secondary"
                  onClick={() => onNavigate("messages", { player: player.id })}
                >
                  <MessageSquare size={17} /> Message parent
                </button>
              )}
              <button
                className="button secondary"
                onClick={() => onNavigate("development", { player: player.id })}
              >
                <ClipboardList size={17} />{" "}
                {canWrite ? "Coach notes" : "Approved development plan"}
              </button>
            </div>
          </aside>
        )}
      </div>
      <Dialog.Root
        open={canWrite && (!!edit || create)}
        onOpenChange={(open) => {
          if (!open) closeEditor();
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="portal-overlay" />
          <Dialog.Content
            className="portal-dialog"
            onEscapeKeyDown={(e) => {
              e.preventDefault();
              closeEditor();
            }}
            onPointerDownOutside={(e) => e.preventDefault()}
          >
            <Dialog.Title>{edit ? "Edit player" : "Add player"}</Dialog.Title>
            <Dialog.Description>
              Save football player details in {d.academy.name}.
            </Dialog.Description>
            <button
              className="portal-icon close"
              aria-label="Close player editor"
              onClick={closeEditor}
            >
              <X />
            </button>
            <PlayerEditor
              key={edit?.id ?? "new"}
              workspace={w}
              player={edit ?? undefined}
              onSaved={(id) => {
                setEdit(null);
                onNavigate("players", { player: id, create: "" });
              }}
            />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root open={admin && linking} onOpenChange={setLinking}>
        <Dialog.Portal>
          <Dialog.Overlay className="portal-overlay" />
          <Dialog.Content className="portal-dialog">
            <Dialog.Title>Add player with invitation link</Dialog.Title>
            <Dialog.Description>
              The player signs in and fills in their own details.
            </Dialog.Description>
            <button
              className="portal-icon close"
              aria-label="Close invitation link"
              onClick={() => setLinking(false)}
            >
              <X />
            </button>
            <PlayerLinkPanel workspace={w} onClose={() => setLinking(false)} />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root
        open={admin && importing}
        onOpenChange={(open) => {
          if (!open && !importSaving && !w.busy && confirmUnsavedChanges())
            setImport(false);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="portal-overlay" />
          <Dialog.Content
            className="portal-dialog"
            onPointerDownOutside={(e) => e.preventDefault()}
          >
            <Dialog.Title>Import players</Dialog.Title>
            <Dialog.Description>
              Review the rows before saving academy records.
            </Dialog.Description>
            <PlayerImport
              workspace={w}
              onSaving={setImportSaving}
              onDone={() => setImport(false)}
            />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
