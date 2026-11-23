// Communications: who a message reaches, the write → approve → schedule → process steps, the free "ready to send" list,
// templates, and what a parent sees. All names and addresses are fictional.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
vi.mock("server-only", () => ({}));
vi.mock("@/server/auth", () => ({
  WorkspaceError: class extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
  authenticatedUser: vi.fn(),
}));
import { database } from "@/server/database";
import { saveRecord } from "@/server/workspace-service";
import { setMemberPhone } from "@/server/session-share-service";
import {
  guardianMessages,
  markOpened,
  messagingView,
  previewMessage,
  processMessages,
  saveMessage,
  saveTemplate,
  shareList,
} from "@/server/messaging-service";
import type { AcademyConfiguration, AcademyRole, WorkspacePlayer } from "@/domain/workspace";
import { actorFor, linkGuardian, memberId, newAcademyConfig, seedAcademy, statusOf } from "./helpers/academy-fixture";

const filename = join(tmpdir(), `sportozen-messaging-${randomUUID()}.sqlite`);
process.env.SPORTOZEN_DATABASE_PATH = filename;
afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"])
    try {
      rmSync(filename + suffix, { force: true });
    } catch {
      /* the temp folder is disposable */
    }
});

let academy: AcademyConfiguration;
const as = (role: AcademyRole) => actorFor(role, academy);
const coachId = () => memberId("COACH", academy);
const parentId = () => memberId("PARENT", academy);
const make = (name: string, over: Record<string, unknown> = {}) =>
  saveRecord(as("OWNER"), "player", {
    name,
    coachId: coachId(),
    sportIds: ["football"],
    birthDate: "2015-05-05",
    ...over,
  }) as WorkspacePlayer;
const addEmail = () => {
  const db = database();
  try {
    db.exec('ALTER TABLE "user" ADD COLUMN email TEXT');
  } catch {
    /* already there */
  }
  for (const role of ["OWNER", "COACH", "PARENT"] as const)
    db.prepare('UPDATE "user" SET email=? WHERE id=?').run(`${role.toLowerCase()}@example.test`, memberId(role, academy));
};
beforeEach(() => {
  academy = newAcademyConfig();
  seedAcademy(academy);
  addEmail();
});
const draft = (over: Record<string, unknown> = {}) => ({
  subject: "Training update",
  body: "Friday training starts at 6 pm at the main ground.",
  playerIds: [],
  batchIds: [],
  allBatches: true,
  channels: ["PORTAL", "EMAIL", "WHATSAPP"],
  templateId: null,
  ...over,
});
const save = (role: AcademyRole, data = draft()) =>
  saveMessage(as(role), { action: "save", scheduledAt: null, data });
const optOut = () =>
  database()
    .prepare("INSERT INTO guardian_contacts VALUES(?,?,?,?)")
    .run(
      academy.id,
      parentId(),
      "+919876543210",
      JSON.stringify({ academyId: academy.id, guardianId: parentId(), phone: "+919876543210", optedOutAt: new Date().toISOString() }),
    );
/** A message approved, scheduled for now and processed. */
function send(data = draft()) {
  const saved = save("OWNER", data);
  const approved = saveMessage(as("OWNER"), { id: saved.id, version: saved.version, action: "approve" });
  saveMessage(as("OWNER"), { id: saved.id, version: approved.version, action: "schedule", scheduledAt: new Date(Date.now() - 1000).toISOString() });
  return { id: saved.id, result: processMessages(as("OWNER")) };
}

describe("who a message reaches", () => {
  it("counts the players covered, the ones with a parent account and who can be offered each channel", () => {
    const kid = make("Rishi Kapoor");
    make("Meera Shah");
    linkGuardian(academy, parentId(), kid.id);
    const p = previewMessage(as("OWNER"), draft());
    expect(p.audience.players).toBe(2);
    expect(p.audience.playersWithParent).toBe(1);
    expect(p.audience.reach).toEqual({ PORTAL: 1, EMAIL: 1, WHATSAPP: 1 });
    expect(p.audience.needNumber).toBe(1);
    expect(p.recipients).toHaveLength(1);
    expect(p.recipients[0].channels).toEqual(["PORTAL", "EMAIL", "WHATSAPP"]);
  });
  it("covers nobody until an audience is chosen", () => {
    make("Rishi Kapoor");
    const p = previewMessage(as("OWNER"), draft({ allBatches: false }));
    expect(p.audience.players).toBe(0);
    expect(p.recipients).toEqual([]);
  });
  it("selected players only: the parents of those players", () => {
    const a = make("Rishi Kapoor"),
      b = make("Meera Shah");
    linkGuardian(academy, parentId(), a.id);
    expect(previewMessage(as("OWNER"), draft({ allBatches: false, playerIds: [b.id] })).recipients).toEqual([]);
    expect(previewMessage(as("OWNER"), draft({ allBatches: false, playerIds: [a.id] })).recipients).toHaveLength(1);
  });
  it("leaves out a parent who opted out, and says so", () => {
    const kid = make("Rishi Kapoor");
    linkGuardian(academy, parentId(), kid.id);
    optOut();
    const p = previewMessage(as("OWNER"), draft());
    expect(p.recipients).toEqual([]);
    expect(p.audience.optedOut).toBe(1);
    expect(p.audience.reach).toEqual({ PORTAL: 0, EMAIL: 0, WHATSAPP: 0 });
  });
  it("only the channels ticked are used", () => {
    const kid = make("Rishi Kapoor");
    linkGuardian(academy, parentId(), kid.id);
    expect(previewMessage(as("OWNER"), draft({ channels: ["PORTAL"] })).recipients[0].channels).toEqual(["PORTAL"]);
  });
  it("is for staff only", async () => {
    expect(await statusOf(() => previewMessage(as("PARENT"), draft()))).toBe(403);
    expect(await statusOf(() => messagingView(as("PARENT")))).toBe(403);
    expect(await statusOf(() => messagingView(as("SUPPORT")))).toBe(403);
  });
});

describe("write, approve, schedule", () => {
  it("keeps the wording generic: no child names, no contact details", async () => {
    make("Rishi Kapoor");
    expect(await statusOf(() => save("OWNER", draft({ body: "Rishi Kapoor was late today." })))).toBe(400);
    expect(await statusOf(() => save("OWNER", draft({ body: "Call me on +91 98765 43210 please." })))).toBe(400);
    expect(save("OWNER").status).toBe("DRAFT");
  });
  it("a coach writes drafts for their own players only and cannot approve", async () => {
    const mine = make("Rishi Kapoor"),
      other = make("Meera Shah", { coachId: memberId("ADMIN", academy) });
    expect(save("COACH", draft({ allBatches: false, playerIds: [mine.id] })).status).toBe("DRAFT");
    expect(await statusOf(() => save("COACH", draft({ allBatches: false, playerIds: [other.id] })))).toBe(403);
    const saved = save("COACH", draft({ allBatches: false, playerIds: [mine.id] }));
    expect(await statusOf(() => saveMessage(as("COACH"), { id: saved.id, version: saved.version, action: "approve" }))).toBe(403);
  });
  it("a coach sees only their own messages; the owner sees all", () => {
    const kid = make("Rishi Kapoor");
    linkGuardian(academy, parentId(), kid.id);
    save("COACH", draft({ allBatches: false, playerIds: [kid.id], subject: "From the coach" }));
    save("OWNER", draft({ subject: "From the owner" }));
    expect(messagingView(as("COACH")).messages.map((m) => m.data.subject)).toEqual(["From the coach"]);
    expect(messagingView(as("OWNER")).messages.map((m) => m.data.subject).sort()).toEqual(["From the coach", "From the owner"]);
  });
  it("approval freezes who receives it and refuses when nobody can", async () => {
    const saved = save("OWNER");
    expect(await statusOf(() => saveMessage(as("OWNER"), { id: saved.id, version: saved.version, action: "approve" }))).toBe(409);
    const kid = make("Rishi Kapoor");
    linkGuardian(academy, parentId(), kid.id);
    const approved = saveMessage(as("OWNER"), { id: saved.id, version: saved.version, action: "approve" });
    expect(approved.status).toBe("APPROVED");
    expect(approved.data.recipients.map((r) => r.userId)).toEqual([parentId()]);
    expect(approved.data.approvalHash).toMatch(/^[0-9a-f]{64}$/);
  });
  it("cannot be scheduled before it is approved, and cannot be edited once approved", async () => {
    const kid = make("Rishi Kapoor");
    linkGuardian(academy, parentId(), kid.id);
    const saved = save("OWNER");
    expect(
      await statusOf(() => saveMessage(as("OWNER"), { id: saved.id, version: saved.version, action: "schedule", scheduledAt: new Date().toISOString() })),
    ).toBe(409);
    const approved = saveMessage(as("OWNER"), { id: saved.id, version: saved.version, action: "approve" });
    expect(await statusOf(() => saveMessage(as("OWNER"), { id: saved.id, version: approved.version, action: "save", data: draft() }))).toBe(409);
    const revised = saveMessage(as("OWNER"), { id: saved.id, version: approved.version, action: "revise" });
    expect(revised.status).toBe("DRAFT");
    expect(revised.data.recipients).toEqual([]);
    expect(revised.data.approvalHash).toBeNull();
  });
  it("refuses a stale version", async () => {
    const saved = save("OWNER");
    expect(await statusOf(() => saveMessage(as("OWNER"), { id: saved.id, version: saved.version + 5, action: "save", data: draft() }))).toBe(409);
  });
});

describe("processing: ready to send, the delivery log and the parent's app", () => {
  it("sends nothing itself: Portal becomes visible, E-mail and WhatsApp wait for a button", () => {
    const kid = make("Rishi Kapoor");
    linkGuardian(academy, parentId(), kid.id);
    const { id, result } = send();
    expect(result).toMatchObject({ processed: 1, available: 1, ready: 2, skipped: 0 });
    const view = messagingView(as("OWNER"));
    expect(view.messages.find((m) => m.id === id)!.status).toBe("PROCESSED");
    expect(view.deliveries.map((d) => `${d.channel}:${d.status}`).sort()).toEqual(["EMAIL:READY_TO_SHARE", "PORTAL:AVAILABLE", "WHATSAPP:READY_TO_SHARE"]);
    const items = shareList(as("OWNER")).items;
    expect(items.map((i) => i.channel).sort()).toEqual(["EMAIL", "WHATSAPP"]);
    expect(items.find((i) => i.channel === "EMAIL")!.email).toBe("parent@example.test");
    expect(items.find((i) => i.channel === "WHATSAPP")!.phone).toBeNull();
    expect(processMessages(as("OWNER")).processed).toBe(0);
  });
  it("shows the saved WhatsApp number, and pressing a button records 'opened' only", () => {
    const kid = make("Rishi Kapoor");
    linkGuardian(academy, parentId(), kid.id);
    setMemberPhone(as("OWNER"), { userId: parentId(), phone: "+919876543210" });
    send();
    const items = shareList(as("OWNER")).items;
    expect(items.find((i) => i.channel === "WHATSAPP")!.phone).toBe("919876543210");
    markOpened(as("OWNER"), items[0].id);
    const after = shareList(as("OWNER")).items;
    expect(after.find((i) => i.id === items[0].id)!.status).toBe("OPENED");
    expect(messagingView(as("OWNER")).deliveries.some((d) => d.status === "OPENED" && d.openedAt)).toBe(true);
  });
  it("skips a parent who opted out after approval, and logs why", () => {
    const kid = make("Rishi Kapoor");
    linkGuardian(academy, parentId(), kid.id);
    const saved = save("OWNER");
    const approved = saveMessage(as("OWNER"), { id: saved.id, version: saved.version, action: "approve" });
    optOut();
    saveMessage(as("OWNER"), { id: saved.id, version: approved.version, action: "schedule", scheduledAt: new Date(Date.now() - 1000).toISOString() });
    expect(processMessages(as("OWNER"))).toMatchObject({ processed: 1, available: 0, ready: 0, skipped: 3 });
    expect(messagingView(as("OWNER")).deliveries.every((d) => d.status === "SKIPPED" && /opted out/.test(d.detail))).toBe(true);
    expect(shareList(as("OWNER")).items).toEqual([]);
  });
  it("a scheduled message that is not due yet is left alone", () => {
    const kid = make("Rishi Kapoor");
    linkGuardian(academy, parentId(), kid.id);
    const saved = save("OWNER");
    const approved = saveMessage(as("OWNER"), { id: saved.id, version: saved.version, action: "approve" });
    saveMessage(as("OWNER"), { id: saved.id, version: approved.version, action: "schedule", scheduledAt: new Date(Date.now() + 86_400_000).toISOString() });
    expect(processMessages(as("OWNER")).processed).toBe(0);
  });
  it("only the owner or an admin can process", async () => {
    expect(await statusOf(() => processMessages(as("COACH")))).toBe(403);
  });
  it("a coach cannot open another person's delivery or see their ready-to-send rows", async () => {
    const kid = make("Rishi Kapoor");
    linkGuardian(academy, parentId(), kid.id);
    send();
    expect(shareList(as("COACH")).items).toEqual([]);
    const row = shareList(as("OWNER")).items[0];
    expect(await statusOf(() => markOpened(as("COACH"), row.id))).toBe(404);
  });
  it("a parent reads a processed Portal message for their own child only", () => {
    const kid = make("Rishi Kapoor");
    linkGuardian(academy, parentId(), kid.id);
    expect(guardianMessages(as("PARENT"))).toEqual([]);
    send(draft({ subject: "Match day", body: "Bring water and shin guards." }));
    const shown = guardianMessages(as("PARENT"));
    expect(shown.map((m) => [m.title, m.body])).toEqual([["Match day", "Bring water and shin guards."]]);
    expect(guardianMessages(as("PARENT"), new Date(Date.now() + 40 * 86_400_000))).toEqual([]);
    database().prepare("DELETE FROM guardian_relationships WHERE academyId=? AND userId=?").run(academy.id, parentId());
    expect(guardianMessages(as("PARENT"))).toEqual([]);
  });
  it("a message without the Portal channel is not shown in the app", () => {
    const kid = make("Rishi Kapoor");
    linkGuardian(academy, parentId(), kid.id);
    send(draft({ channels: ["EMAIL"] }));
    expect(guardianMessages(as("PARENT"))).toEqual([]);
  });
});

describe("templates", () => {
  it("the owner saves one and everyone on the screen sees it; a coach cannot create one", async () => {
    const t = saveTemplate(as("OWNER"), { name: "Rain", subject: "Training cancelled", body: "Training is cancelled today due to rain." });
    expect(messagingView(as("COACH")).templates.map((x) => x.id)).toEqual([t.id]);
    expect(await statusOf(() => saveTemplate(as("COACH"), { name: "Mine", subject: "Hello there", body: "A message body." }))).toBe(403);
  });
  it("keeps the wording generic", async () => {
    make("Rishi Kapoor");
    expect(await statusOf(() => saveTemplate(as("OWNER"), { name: "Bad", subject: "About Rishi Kapoor", body: "He did well today." }))).toBe(400);
  });
});
