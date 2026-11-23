"use client";
import { useRef, useState, type CSSProperties, type RefObject } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Plus, X } from "lucide-react";
import type { FootballSquad } from "@/domain/training";
import type { WorkspaceBranch } from "@/domain/workspace";
import type { useWorkspace } from "@/hooks/use-workspace";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { useTraining, type TrainingSubmit } from "./training";

type Controller = ReturnType<typeof useWorkspace>;

const same = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();
const validZone = (zone: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

/**
 * Settings → Sessions: the academy's branches and batches. One place to create
 * either, with a table and search for each, and an edit dialog per row.
 */
export function BranchesAndBatches({ workspace: w }: { workspace: Controller }) {
  const d = w.data!,
    t = useTraining(w),
    [branchQuery, setBranchQuery] = useState(""),
    [batchQuery, setBatchQuery] = useState(""),
    [branchDialog, setBranchDialog] = useState<WorkspaceBranch | null | undefined>(),
    [batchDialog, setBatchDialog] = useState<FootballSquad | null | undefined>(),
    branchTrigger = useRef<HTMLButtonElement | null>(null),
    batchTrigger = useRef<HTMLButtonElement | null>(null);
  const branches = d.records.branch.filter((b) =>
      `${b.name} ${b.timezone}`.toLowerCase().includes(branchQuery.toLowerCase()),
    ),
    batches = d.records.squad.filter((s) =>
      `${s.name} ${d.records.branch.find((b) => b.id === s.branchId)?.name ?? ""}`
        .toLowerCase()
        .includes(batchQuery.toLowerCase()),
    );
  const noBranch = d.records.branch.length === 0;
  return (
    <section className="as-card" aria-labelledby="branches-batches-title">
      <div className="as-card-heading">
        <div>
          <h2 id="branches-batches-title">Branches &amp; batches</h2>
          <p>Create the places you train and the batches that train there.</p>
        </div>
      </div>
      <div className="bb-actions">
        <button
          ref={branchTrigger}
          type="button"
          className="as-button primary"
          disabled={w.busy}
          onClick={(e) => {
            branchTrigger.current = e.currentTarget;
            setBranchDialog(null);
          }}
        >
          <Plus size={16} /> Create branch
        </button>
        <button
          ref={batchTrigger}
          type="button"
          className="as-button"
          disabled={w.busy || noBranch}
          onClick={(e) => {
            batchTrigger.current = e.currentTarget;
            setBatchDialog(null);
          }}
        >
          <Plus size={16} /> Create batch
        </button>
        {noBranch && <small>Create a branch first, then a batch.</small>}
      </div>

      <label className="as-field bb-search">
        <span className="bb-sr">Search branches</span>
        <input
          type="search"
          placeholder="Search branches…"
          value={branchQuery}
          onChange={(e) => setBranchQuery(e.target.value)}
        />
      </label>
      <div className="as-venue-scroll" tabIndex={0} aria-label="Branches table">
        <table>
          <thead>
            <tr>
              <th>Branch</th>
              <th>Time zone</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {branches.map((b) => (
              <tr key={b.id}>
                <td>{b.name}</td>
                <td>{b.timezone}</td>
                <td>
                  <button
                    type="button"
                    className="as-text-button bb-edit"
                    onClick={(e) => {
                      branchTrigger.current = e.currentTarget;
                      setBranchDialog(b);
                    }}
                  >
                    Edit branch →
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!branches.length && (
        <p className="bb-empty">
          {d.records.branch.length ? "No branch matches your search." : "No branches yet."}
        </p>
      )}

      <label className="as-field bb-search">
        <span className="bb-sr">Search batches</span>
        <input
          type="search"
          placeholder="Search batches…"
          value={batchQuery}
          onChange={(e) => setBatchQuery(e.target.value)}
        />
      </label>
      <div className="as-venue-scroll" tabIndex={0} aria-label="Batches table">
        <table>
          <thead>
            <tr>
              <th>Batch</th>
              <th>Branch</th>
              <th>Players</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {batches.map((s) => (
              <tr key={s.id}>
                <td>{s.name}</td>
                <td>{d.records.branch.find((b) => b.id === s.branchId)?.name ?? "—"}</td>
                <td>{s.playerIds.length}</td>
                <td>
                  <button
                    type="button"
                    className="as-text-button bb-edit"
                    onClick={(e) => {
                      batchTrigger.current = e.currentTarget;
                      setBatchDialog(s);
                    }}
                  >
                    Edit batch →
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!batches.length && (
        <p className="bb-empty">
          {d.records.squad.length ? "No batch matches your search." : "No batches yet."}
        </p>
      )}
      {t.notice && <p role="status">{t.notice}</p>}

      {branchDialog !== undefined && (
        <BranchEditor
          key={branchDialog?.id ?? "new"}
          workspace={w}
          initial={branchDialog}
          returnFocus={branchTrigger}
          onClose={() => setBranchDialog(undefined)}
        />
      )}
      {batchDialog !== undefined && (
        <BatchEditor
          key={batchDialog?.id ?? "new"}
          workspace={w}
          submit={t.submit}
          initial={batchDialog}
          returnFocus={batchTrigger}
          onClose={() => setBatchDialog(undefined)}
        />
      )}
    </section>
  );
}

function Shell({
  workspace: w,
  title,
  description,
  closeLabel,
  returnFocus,
  onRequestClose,
  children,
}: {
  workspace: Controller;
  title: string;
  description: string;
  closeLabel: string;
  returnFocus: RefObject<HTMLButtonElement | null>;
  onRequestClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onRequestClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="ps-overlay" />
        <Dialog.Content
          className="portal-settings ps-dialog"
          style={{ "--hd-green": w.data!.academy.brandAccent } as CSSProperties}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            returnFocus.current?.focus();
          }}
        >
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.Description>{description}</Dialog.Description>
          {children}
          <Dialog.Close className="ps-close" aria-label={closeLabel} disabled={w.busy}>
            <X size={20} />
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function BranchEditor({
  workspace: w,
  initial,
  returnFocus,
  onClose,
}: {
  workspace: Controller;
  initial: WorkspaceBranch | null;
  returnFocus: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const d = w.data!,
    [name, setName] = useState(initial?.name ?? ""),
    [zone, setZone] = useState(initial?.timezone ?? d.academy.timezone),
    [error, setError] = useState("");
  const dirty = name !== (initial?.name ?? "") || zone !== (initial?.timezone ?? d.academy.timezone);
  useUnsavedChanges(dirty);
  const close = () => {
    if (!w.busy && (!dirty || window.confirm("Discard unsaved branch changes?"))) onClose();
  };
  return (
    <Shell
      workspace={w}
      title={initial ? "Edit branch" : "Create branch"}
      description="A branch is a place you train. Batches belong to a branch."
      closeLabel="Close branch editor"
      returnFocus={returnFocus}
      onRequestClose={close}
    >
      <form
        className="ps-form"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          const clean = name.trim();
          if (clean.length < 2) return setError("Enter a branch name of at least 2 characters.");
          if (!validZone(zone.trim()))
            return setError("Enter a valid IANA time zone, for example Asia/Kolkata.");
          if (d.records.branch.some((b) => b.id !== initial?.id && same(b.name, clean)))
            return setError(`A branch named “${clean}” already exists.`);
          const saved = await w.save("branch", { name: clean, timezone: zone.trim() }, initial?.id);
          if (saved) onClose();
        }}
      >
        <label className="as-field">
          Branch name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="as-field">
          Time zone
          <input value={zone} onChange={(e) => setZone(e.target.value)} />
        </label>
        {(error || w.error) && <p role="alert">{error || w.error}</p>}
        <button className="as-button primary" disabled={w.busy}>
          {w.busy ? "Saving…" : initial ? "Save branch" : "Create branch"}
        </button>
      </form>
    </Shell>
  );
}

function BatchEditor({
  workspace: w,
  submit,
  initial,
  returnFocus,
  onClose,
}: {
  workspace: Controller;
  submit: TrainingSubmit;
  initial: FootballSquad | null;
  returnFocus: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const d = w.data!,
    [name, setName] = useState(initial?.name ?? ""),
    [branchId, setBranchId] = useState(initial?.branchId ?? d.records.branch[0]?.id ?? ""),
    [players, setPlayers] = useState<string[]>(initial?.playerIds ?? []),
    [error, setError] = useState("");
  const dirty =
    name !== (initial?.name ?? "") ||
    branchId !== (initial?.branchId ?? d.records.branch[0]?.id ?? "") ||
    players.join() !== (initial?.playerIds ?? []).join();
  useUnsavedChanges(dirty);
  const close = () => {
    if (!w.busy && (!dirty || window.confirm("Discard unsaved batch changes?"))) onClose();
  };
  return (
    <Shell
      workspace={w}
      title={initial ? "Edit batch" : "Create batch"}
      description="Changes affect future planning. Published rosters and past session records keep their snapshots."
      closeLabel="Close batch editor"
      returnFocus={returnFocus}
      onRequestClose={close}
    >
      <form
        className="ps-form"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          const clean = name.trim();
          if (clean.length < 2) return setError("Enter a batch name of at least 2 characters.");
          if (!branchId) return setError("Choose the branch this batch trains at.");
          if (
            d.records.squad.some(
              (s) => s.id !== initial?.id && s.branchId === branchId && same(s.name, clean),
            )
          )
            return setError(`A batch named “${clean}” already exists in this branch.`);
          const saved = await submit(
            "squad",
            { name: clean, branchId, playerIds: players },
            initial?.id,
            initial?.version ?? 0,
          );
          if (saved) onClose();
        }}
      >
        <label className="as-field">
          Batch name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="as-field">
          Branch
          <select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            <option value="">Choose branch</option>
            {d.records.branch.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend>Batch roster</legend>
          {d.records.player.length === 0 && <p>No players yet. You can add them to the batch later.</p>}
          {d.records.player.map((p) => (
            <label className="ps-check" key={p.id}>
              <input
                type="checkbox"
                checked={players.includes(p.id)}
                onChange={(e) =>
                  setPlayers(e.target.checked ? [...players, p.id] : players.filter((id) => id !== p.id))
                }
              />
              {p.name}
            </label>
          ))}
        </fieldset>
        {(error || w.error) && <p role="alert">{error || w.error}</p>}
        <button className="as-button primary" disabled={w.busy}>
          {w.busy ? "Saving…" : initial ? "Save batch" : "Create batch"}
        </button>
      </form>
    </Shell>
  );
}
