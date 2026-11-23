// WP4: history and audit tables can be neither edited nor deleted. Real
// workflows only ever append to them; test cleanup lifts the guard explicitly.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
vi.mock("server-only", () => ({}));
vi.mock("@/server/auth", () => import("./helpers/mock-auth"));
import { database } from "@/server/database";
import {
  APPEND_ONLY_TABLES,
  migrateIntegrityGuards,
} from "@/server/migrations/008-integrity-guards";
import { resetTables } from "./helpers/reset-tables";
import { seedApiFixture } from "./helpers/api-harness";

const filename = join(tmpdir(), `sportozen-history-${randomUUID()}.sqlite`);
process.env.SPORTOZEN_DATABASE_PATH = filename;
beforeAll(() => {
  seedApiFixture();
});
afterAll(() => {
  database().close();
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(filename + suffix, { force: true });
});
const db = () => database();
const count = (table: string) =>
  Number(db().prepare(`SELECT COUNT(*) n FROM ${table}`).get()?.n);
const trigger = (name: string) =>
  Boolean(
    db()
      .prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?")
      .get(name),
  );
// One valid row per table, to have something to try to change.
const rows: Record<string, string> = {
  training_history:
    "INSERT INTO training_history(academyId,kind,recordId,version,body,actorId,at) VALUES('academy-a','session','s-h',1,'{}','u','t')",
  academy_finance_history:
    "INSERT INTO academy_finance_history(academyId,kind,recordId,version,body,actorId,at) VALUES('academy-a','invoice','i-h',1,'{}','u','t')",
  report_approval_history:
    "INSERT INTO report_approval_history(id,academyId,reportId,snapshot,approvedPlan,approvedBy,at) VALUES('h-1','academy-a','r','{}','{}','u','t')",
  update_approval_history:
    "INSERT INTO update_approval_history(id,academyId,updateId,version,body,source,approvedBy,at) VALUES('h-2','academy-a','u',1,'{}','s','u','t')",
  batch_announcement_history:
    "INSERT INTO batch_announcement_history(academyId,id,version,body) VALUES('academy-a','b-h',1,'{}')",
  workspace_audit:
    "INSERT INTO workspace_audit(academyId,userId,action,at) VALUES('academy-a','u','test action','t')",
};

describe("history and audit tables", () => {
  it("guards every table the migration lists", () => {
    expect([...APPEND_ONLY_TABLES].sort()).toEqual(Object.keys(rows).sort());
    for (const table of APPEND_ONLY_TABLES) {
      expect(trigger(`${table}_no_delete`), table).toBe(true);
      expect(trigger(`${table}_append_only`), table).toBe(true);
    }
  });
  it.each(APPEND_ONLY_TABLES)(
    "%s accepts new rows but refuses edits and deletes",
    (table) => {
      db().exec(rows[table]);
      const before = count(table);
      expect(before).toBeGreaterThan(0);
      expect(() => db().exec(`DELETE FROM ${table}`)).toThrow(/append-only/);
      expect(() =>
        db().exec(
          `DELETE FROM ${table} WHERE rowid=(SELECT MIN(rowid) FROM ${table})`,
        ),
      ).toThrow(/append-only/);
      expect(() =>
        db().exec(`UPDATE ${table} SET academyId=academyId`),
      ).toThrow(/append-only/);
      expect(count(table)).toBe(before);
    },
  );
  it("cannot be rewritten with INSERT OR REPLACE or an upsert", () => {
    db().exec(rows.workspace_audit);
    const id = Number(
      db().prepare("SELECT MAX(id) id FROM workspace_audit").get()?.id,
    );
    const action = () =>
      db().prepare("SELECT action FROM workspace_audit WHERE id=?").get(id)
        ?.action;
    expect(action()).toBe("test action");
    // REPLACE deletes the old row; without recursive_triggers that delete
    // would bypass the guard.
    expect(() =>
      db().exec(
        `INSERT OR REPLACE INTO workspace_audit(id,academyId,userId,action,at) VALUES(${id},'academy-a','u','rewritten','t')`,
      ),
    ).toThrow(/append-only/);
    expect(() =>
      db().exec(
        `INSERT INTO workspace_audit(id,academyId,userId,action,at) VALUES(${id},'academy-a','u','rewritten','t') ON CONFLICT(id) DO UPDATE SET action=excluded.action`,
      ),
    ).toThrow(/append-only/);
    expect(action()).toBe("test action");
  });
});

describe("the test cleanup helper", () => {
  it("empties a history table, then restores the guard", () => {
    db().exec(rows.workspace_audit);
    resetTables(db(), "DELETE FROM workspace_audit");
    expect(count("workspace_audit")).toBe(0);
    for (const table of APPEND_ONLY_TABLES)
      expect(trigger(`${table}_no_delete`), table).toBe(true);
    db().exec(rows.workspace_audit);
    expect(() => db().exec("DELETE FROM workspace_audit")).toThrow(
      /append-only/,
    );
  });
  it("restores the guard even when the cleanup itself fails", () => {
    expect(() => resetTables(db(), "DELETE FROM no_such_table")).toThrow();
    for (const table of APPEND_ONLY_TABLES)
      expect(trigger(`${table}_no_delete`), table).toBe(true);
  });
});

describe("the migration", () => {
  it("restores a removed delete guard and is safe to run repeatedly", () => {
    db().exec("DROP TRIGGER workspace_audit_no_delete");
    migrateIntegrityGuards(db());
    migrateIntegrityGuards(db());
    expect(trigger("workspace_audit_no_delete")).toBe(true);
  });
});

describe("real workflows still append", () => {
  it("wrote approval, training, finance and audit history through the services", () => {
    // The fixture used the real services: approving reports, saving sessions,
    // issuing invoices and recording payments, with the guards in place.
    for (const table of [
      "report_approval_history",
      "training_history",
      "academy_finance_history",
      "workspace_audit",
    ])
      expect(count(table), table).toBeGreaterThan(0);
  });
});
