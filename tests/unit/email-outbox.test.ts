// E-mail infrastructure: configuration, templates, the outbox (retries, expiry,
// redaction, concurrency) and invitation delivery. Uses the in-memory capture
// transport; no provider is contacted.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
vi.mock("server-only", () => ({}));
vi.mock("@/server/auth", () => import("./helpers/mock-auth"));
import { database } from "@/server/database";
import { emailConfig } from "@/server/email/config";
import {
  invitationEmail,
  passwordResetEmail,
  verificationEmail,
} from "@/server/email/templates";
import {
  captured,
  resetCapture,
  scriptCapture,
  createTransport,
} from "@/server/email/transport";
import {
  BACKOFF_SECONDS,
  MAX_ATTEMPTS,
  RECIPIENT_HOURLY_LIMIT,
  cancelEmails,
  deliveryStatuses,
  enqueueEmail,
  processOutbox,
  purgeFinished,
  sanitize,
} from "@/server/email/outbox";
import {
  acceptInvitation,
  invite,
  listInvitations,
  resendInvitation,
  revokeInvitation,
} from "@/server/membership-service";
import { requireVerifiedEmail } from "@/server/verified-email";
import { registerTestUser } from "./helpers/mock-auth";
import { A, B, contextFor, ids, seedApiFixture } from "./helpers/api-harness";

const filename = join(tmpdir(), `sportozen-email-${randomUUID()}.sqlite`);
process.env.SPORTOZEN_DATABASE_PATH = filename;
const ORIGIN = "https://academy.sportozen.app";
const MAIL_ENV = {
  SPORTOZEN_EMAIL_TRANSPORT: "capture",
  SPORTOZEN_EMAIL_FROM: "Sportozen <notifications@academy.sportozen.app>",
};
const KEYS = [
  "SPORTOZEN_EMAIL_TRANSPORT",
  "SPORTOZEN_EMAIL_FROM",
  "SPORTOZEN_EMAIL_VERIFICATION",
  "SPORTOZEN_PASSWORD_RECOVERY",
];
const setEnv = (env: Record<string, string>) => {
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, env);
};
beforeAll(() => {
  seedApiFixture();
});
afterAll(() => {
  database().close();
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(filename + suffix, { force: true });
});
beforeEach(() => {
  // The API harness sets its own origin when it loads; links must use this one.
  process.env.BETTER_AUTH_URL = ORIGIN;
  resetCapture();
  database().exec("DELETE FROM email_outbox");
  setEnv(MAIL_ENV);
});
afterEach(() => {
  vi.restoreAllMocks();
  setEnv({});
});
const rows = (where = "1=1") =>
  database().prepare(`SELECT * FROM email_outbox WHERE ${where}`).all();
const draft = (
  to = "someone@example.test",
  expiresAt = "2999-01-01T00:00:00.000Z",
) => ({
  purpose: "PASSWORD_RESET" as const,
  to,
  subject: "Subject",
  text: "Body with link https://academy.sportozen.app/x?token=SECRETTOKEN0123456789ABCDEF",
  expiresAt,
});
const transport = () => createTransport(emailConfig())!;

describe("e-mail configuration", () => {
  it("is off by default and changes nothing about how accounts work", () => {
    setEnv({});
    expect(emailConfig()).toMatchObject({
      enabled: false,
      verification: "off",
      recovery: false,
    });
  });
  it("refuses verification or recovery without a transport (users would be locked out)", () => {
    setEnv({ SPORTOZEN_EMAIL_VERIFICATION: "required" });
    expect(() => emailConfig()).toThrow(/locked out/);
    setEnv({ SPORTOZEN_PASSWORD_RECOVERY: "on" });
    expect(() => emailConfig()).toThrow(/locked out/);
  });
  it("refuses a provider nobody approved and the test transport in production", () => {
    setEnv({ SPORTOZEN_EMAIL_TRANSPORT: "sendgrid" });
    expect(() => emailConfig()).toThrow(/not available/);
    expect(() =>
      emailConfig({
        ...MAIL_ENV,
        NODE_ENV: "production",
        BETTER_AUTH_URL: ORIGIN,
      }),
    ).toThrow(/refused in production/);
  });
  it("needs a valid sender address and accepts a display name", () => {
    setEnv({
      SPORTOZEN_EMAIL_TRANSPORT: "capture",
      SPORTOZEN_EMAIL_FROM: "nonsense",
    });
    expect(() => emailConfig()).toThrow(/sender address/);
    setEnv(MAIL_ENV);
    expect(emailConfig()).toMatchObject({ enabled: true, origin: ORIGIN });
  });
  it("rejects invalid switch values", () => {
    setEnv({ ...MAIL_ENV, SPORTOZEN_EMAIL_VERIFICATION: "maybe" });
    expect(() => emailConfig()).toThrow(/off.*required/);
    setEnv({ ...MAIL_ENV, SPORTOZEN_PASSWORD_RECOVERY: "yes" });
    expect(() => emailConfig()).toThrow(/off.*on/);
  });
});

describe("message templates", () => {
  const url = "https://academy.sportozen.app/api/auth/x?token=TOKENVALUE";
  it("keep the secret link out of the subject and say how long it works", () => {
    for (const message of [
      verificationEmail({ name: "Asha", url, hours: 24 }),
      passwordResetEmail({ name: "Asha", url, minutes: 60 }),
      invitationEmail({
        academyName: "Synthetic Academy",
        role: "COACH",
        url,
        days: 7,
      }),
    ]) {
      expect(message.subject).not.toContain("TOKENVALUE");
      expect(message.text).toContain(url);
      expect(message.text.match(/TOKENVALUE/g)).toHaveLength(1);
      expect(message.text).toMatch(/expires? in|works for/);
      expect(message.text).not.toContain("undefined");
      expect(message.text).toMatch(/ignore this message/);
    }
  });
  it("name the academy and role in an invitation and ask for the invited address", () => {
    const m = invitationEmail({
      academyName: "Synthetic Academy",
      role: "PARENT",
      url,
      days: 7,
    });
    expect(m.subject).toContain("Synthetic Academy");
    expect(m.text).toContain("a parent or guardian");
    expect(m.text).toContain("THIS email address");
  });
});

describe("the outbox", () => {
  it("sends once, records the provider id and erases the secret link", async () => {
    const queued = enqueueEmail(draft())!;
    const summary = await processOutbox({ transport: transport() });
    expect(summary).toEqual({ sent: 1, retried: 0, failed: 0, expired: 0 });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      to: "someone@example.test",
      from: MAIL_ENV.SPORTOZEN_EMAIL_FROM,
    });
    const [row] = rows(`id='${queued.id}'`);
    expect(row).toMatchObject({
      status: "SENT",
      textBody: null,
      providerMessageId: "capture-1",
      attempts: 1,
    });
    expect(JSON.stringify(row)).not.toContain("SECRETTOKEN");
    expect((await processOutbox({ transport: transport() })).sent).toBe(0);
  });
  it("retries a transient failure with growing delays, then succeeds", async () => {
    scriptCapture(["transient", "transient", "ok"]);
    const { id } = enqueueEmail(draft())!;
    let clock = Date.now();
    const run = () =>
      processOutbox({ transport: transport(), now: () => clock });
    expect(await run()).toMatchObject({ retried: 1 });
    let [row] = rows(`id='${id}'`);
    expect(row).toMatchObject({ status: "QUEUED", attempts: 1 });
    expect(Date.parse(String(row!.nextAttemptAt)) - clock).toBe(
      BACKOFF_SECONDS[0]! * 1000,
    );
    expect(row!.textBody).not.toBeNull(); // still needed for the next attempt
    expect(await run()).toMatchObject({ sent: 0, retried: 0 }); // not due yet
    clock += BACKOFF_SECONDS[0]! * 1000;
    expect(await run()).toMatchObject({ retried: 1 });
    [row] = rows(`id='${id}'`);
    expect(Date.parse(String(row!.nextAttemptAt)) - clock).toBe(
      BACKOFF_SECONDS[1]! * 1000,
    );
    clock += BACKOFF_SECONDS[1]! * 1000;
    expect(await run()).toMatchObject({ sent: 1 });
    [row] = rows(`id='${id}'`);
    expect(row).toMatchObject({ status: "SENT", attempts: 3, textBody: null });
  });
  it("gives up after the last attempt and erases the link", async () => {
    scriptCapture(Array(MAX_ATTEMPTS).fill("transient"));
    const { id } = enqueueEmail(draft())!;
    let clock = Date.now();
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await processOutbox({ transport: transport(), now: () => clock });
      clock += 24 * 3600_000;
    }
    const [row] = rows(`id='${id}'`);
    expect(row).toMatchObject({
      status: "FAILED",
      textBody: null,
      attempts: MAX_ATTEMPTS,
    });
    expect(String(row!.lastError)).toMatch(/RETRIES_EXHAUSTED/);
    expect(captured).toHaveLength(0);
  });
  it("does not retry a permanent rejection", async () => {
    scriptCapture(["permanent"]);
    const { id } = enqueueEmail(draft())!;
    expect(await processOutbox({ transport: transport() })).toMatchObject({
      failed: 1,
    });
    expect(rows(`id='${id}'`)[0]).toMatchObject({
      status: "FAILED",
      textBody: null,
      attempts: 1,
    });
    expect(String(rows(`id='${id}'`)[0]!.lastError)).toContain("REJECTED");
    expect(await processOutbox({ transport: transport() })).toMatchObject({
      sent: 0,
      retried: 0,
      failed: 0,
    });
  });
  it("never sends a message whose link has expired, and erases it", async () => {
    const { id } = enqueueEmail(
      draft("late@example.test", new Date(Date.now() - 1000).toISOString()),
    )!;
    expect(await processOutbox({ transport: transport() })).toMatchObject({
      expired: 1,
      sent: 0,
    });
    expect(captured).toHaveLength(0);
    expect(rows(`id='${id}'`)[0]).toMatchObject({
      status: "EXPIRED",
      textBody: null,
    });
  });
  it("a message that expires while waiting to retry is dropped, not sent late", async () => {
    scriptCapture(["transient"]);
    const soon = Date.now() + 90_000;
    const { id } = enqueueEmail(
      draft("soon@example.test", new Date(soon).toISOString()),
    )!;
    let clock = Date.now();
    await processOutbox({ transport: transport(), now: () => clock });
    clock = soon + 1000;
    expect(
      await processOutbox({ transport: transport(), now: () => clock }),
    ).toMatchObject({ expired: 1 });
    expect(rows(`id='${id}'`)[0]).toMatchObject({
      status: "EXPIRED",
      textBody: null,
    });
    expect(captured).toHaveLength(0);
  });
  it("limits how many messages one address receives per hour, silently", () => {
    for (let i = 0; i < RECIPIENT_HOURLY_LIMIT; i++)
      expect(enqueueEmail(draft("flood@example.test"))).not.toBeNull();
    expect(enqueueEmail(draft("flood@example.test"))).toBeNull();
    expect(enqueueEmail(draft("FLOOD@example.test"))).toBeNull(); // case-insensitive
    expect(enqueueEmail(draft("other@example.test"))).not.toBeNull();
    expect(rows("toAddress='flood@example.test'")).toHaveLength(
      RECIPIENT_HOURLY_LIMIT,
    );
  });
  it("a crashed run is recovered: an expired lease is claimed again", async () => {
    const { id } = enqueueEmail(draft())!;
    database()
      .prepare(
        "UPDATE email_outbox SET status='SENDING', attempts=1, leaseUntil=? WHERE id=?",
      )
      .run(new Date(Date.now() - 1000).toISOString(), id);
    expect(await processOutbox({ transport: transport() })).toMatchObject({
      sent: 1,
    });
    expect(rows(`id='${id}'`)[0]).toMatchObject({
      status: "SENT",
      attempts: 2,
    });
    // A lease that has NOT expired is left alone.
    const second = enqueueEmail(draft("b@example.test"))!;
    database()
      .prepare(
        "UPDATE email_outbox SET status='SENDING', leaseUntil=? WHERE id=?",
      )
      .run(new Date(Date.now() + 60_000).toISOString(), second.id);
    expect((await processOutbox({ transport: transport() })).sent).toBe(0);
  });
  it("two concurrent runs send each message exactly once", async () => {
    for (let i = 0; i < 12; i++) enqueueEmail(draft(`user${i}@example.test`));
    const results = await Promise.all([
      processOutbox({ transport: transport(), limit: 5 }),
      processOutbox({ transport: transport(), limit: 5 }),
      processOutbox({ transport: transport(), limit: 5 }),
    ]);
    await processOutbox({ transport: transport() });
    const total = results.reduce((n, r) => n + r.sent, 0);
    expect(total).toBeLessThanOrEqual(12);
    expect(new Set(captured.map((m) => m.to)).size).toBe(12);
    expect(captured).toHaveLength(12);
    expect(rows("status='SENT'")).toHaveLength(12);
  });
  it("cancels unsent messages and erases their links", () => {
    const { id } = enqueueEmail({
      ...draft(),
      purpose: "INVITATION",
      relatedId: "inv-1",
    })!;
    expect(cancelEmails("inv-1")).toBe(1);
    expect(rows(`id='${id}'`)[0]).toMatchObject({
      status: "CANCELLED",
      textBody: null,
    });
    expect(deliveryStatuses(["inv-1"]).get("inv-1")).toBe("NOT_SENT");
    expect(cancelEmails("inv-1")).toBe(0);
  });
  it("keeps tokens, links and addresses out of the logs, even on failure", async () => {
    const spies = (["log", "info", "warn", "error"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined),
    );
    scriptCapture(["transient", "permanent"]);
    enqueueEmail(draft("log-a@example.test"));
    enqueueEmail(draft("log-b@example.test"));
    await processOutbox({ transport: transport() });
    const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    expect(logged).toContain("email.attempt_failed");
    for (const secret of [
      "SECRETTOKEN",
      "https://",
      "log-a@example.test",
      "log-b@example.test",
      "Body with link",
    ])
      expect(logged).not.toContain(secret);
  });
  it("sanitises stored error text", () => {
    expect(
      sanitize(
        "failed for https://x.test/a?token=abc and AbCdEfGhIjKlMnOpQrStUvWxYz012345",
      ),
    ).toBe("failed for [link] and [token]");
    expect(sanitize("word ".repeat(100))).toHaveLength(200);
  });
  it("purges finished rows after the retention period only", async () => {
    const { id } = enqueueEmail(draft())!;
    await processOutbox({ transport: transport() });
    const pending = enqueueEmail(
      draft("keep@example.test", "2999-01-01T00:00:00.000Z"),
    )!;
    expect(purgeFinished(Date.now())).toBe(0);
    expect(purgeFinished(Date.now() + 91 * 86_400_000)).toBe(1);
    expect(rows(`id='${id}'`)).toHaveLength(0);
    expect(rows(`id='${pending.id}'`)).toHaveLength(1);
  });
});

describe("verified e-mail guard", () => {
  it("only applies when verification is required", () => {
    expect(() => requireVerifiedEmail({ emailVerified: false })).not.toThrow();
    setEnv({ ...MAIL_ENV, SPORTOZEN_EMAIL_VERIFICATION: "required" });
    expect(() => requireVerifiedEmail({ emailVerified: false })).toThrow(
      /Verify your email/,
    );
    expect(() => requireVerifiedEmail({})).toThrow(/Verify your email/);
    expect(() => requireVerifiedEmail({ emailVerified: true })).not.toThrow();
  });
});

describe("invitation delivery", () => {
  const owner = () => contextFor("ownerA");
  const as = (user: string) => new Headers({ "x-test-user": user });
  const input = (email: string) => ({ email, role: "COACH" });
  const idOf = (r: { id: string }) => r.id;

  it("keeps working exactly as before while e-mail is disabled", () => {
    setEnv({});
    const result = invite(owner(), input("plain@example.test"));
    expect(result.status).toBe("NOT_SENT");
    expect(result.token).toHaveLength(64);
    expect(rows()).toHaveLength(0);
    const audit = database()
      .prepare("SELECT action FROM workspace_audit WHERE resourceId=?")
      .get(result.id);
    expect(audit?.action).toBe(
      "Invitation prepared for manual sharing; not sent",
    );
  });
  it.each([
    ["rishi@gmail.com", "COACH"], // India
    ["alex@yahoo.com", "COACH"], // USA
    ["sarah@outlook.co.uk", "PARENT"], // UK
    ["ahmed@example.ae", "COACH"], // UAE
    ["james@example.com.au", "PARENT"], // Australia
    ["anna@example.de", "COACH"], // Germany
    ["Anna@Münchner-Akademie.de", "PARENT"], // internationalised domain, mixed case
  ])("invites %s as %s and queues one message for exactly that address", async (address, role) => {
    const result = invite(owner(), {
      email: address,
      role,
      playerIds: role === "PARENT" ? [ids.p1] : [],
      guardianVerified: role === "PARENT",
    });
    expect(result.status).toBe("QUEUED");
    await processOutbox({ transport: transport() });
    expect(captured).toHaveLength(1);
    const { accountEmail } = await import("@/server/email/address");
    expect(captured[0]!.to).toBe(accountEmail(address));
    expect(captured[0]!.html).toContain("Open the invitation");
    // The person signs in with the address as they type it; the stored invitation matches.
    expect(
      database().prepare("SELECT email FROM workspace_invitations WHERE id=?").get(result.id)!.email,
    ).toBe(accountEmail(address));
  });
  it("refuses an address that is not valid anywhere, without queueing anything", () => {
    for (const bad of ["not an address", "a@b", "a@@example.com", "a@example.com Bcc: x@y.com"])
      expect(() => invite(owner(), { email: bad, role: "COACH" })).toThrow();
    expect(rows()).toHaveLength(0);
  });
  it("queues the message in the same step, with a link on the public origin", async () => {
    const result = invite(owner(), input("new-coach@example.test"));
    expect(result.status).toBe("QUEUED");
    const [row] = rows(`relatedId='${result.id}'`);
    expect(row).toMatchObject({
      purpose: "INVITATION",
      toAddress: "new-coach@example.test",
      academyId: A,
      status: "QUEUED",
    });
    expect(String(row!.textBody)).toContain(
      `${ORIGIN}/workspace?invitation=${result.token}`,
    );
    expect(String(row!.subject)).not.toContain(result.token);
    await processOutbox({ transport: transport() });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.text).toContain(result.token);
    expect(rows(`relatedId='${result.id}'`)[0]).toMatchObject({
      status: "SENT",
      textBody: null,
    });
    expect(
      listInvitations(owner()).invitations.find((i) => i.id === result.id),
    ).toMatchObject({
      state: "PENDING",
      delivery: "SENT",
      email: "new-coach@example.test",
    });
  });
  it("an invitation and its message are created or refused together", () => {
    const before = Number(
      database().prepare("SELECT COUNT(*) n FROM workspace_invitations").get()!
        .n,
    );
    const outbox = Number(
      database().prepare("SELECT COUNT(*) n FROM email_outbox").get()!.n,
    );
    expect(() =>
      invite(owner(), {
        email: "bad@example.test",
        role: "COACH",
        playerIds: [ids.p1],
      }),
    ).toThrow();
    expect(
      Number(
        database()
          .prepare("SELECT COUNT(*) n FROM workspace_invitations")
          .get()!.n,
      ),
    ).toBe(before);
    expect(
      Number(
        database().prepare("SELECT COUNT(*) n FROM email_outbox").get()!.n,
      ),
    ).toBe(outbox);
  });
  it("shows a delivery failure to the administrator and still allows manual sharing", async () => {
    scriptCapture(["permanent"]);
    const result = invite(owner(), input("rejected@example.test"));
    await processOutbox({ transport: transport() });
    expect(
      listInvitations(owner()).invitations.find((i) => i.id === result.id),
    ).toMatchObject({
      state: "PENDING",
      delivery: "FAILED",
    });
    registerTestUser("rejected", "Rejected");
    await expect(
      acceptInvitation(as("rejected"), result.token),
    ).resolves.toMatchObject({ academyId: A });
  });
  it("lists no tokens and only for owners and administrators of that academy", () => {
    invite(owner(), input("listed@example.test"));
    expect(JSON.stringify(listInvitations(owner()))).not.toMatch(
      /[0-9a-f]{64}/,
    );
    expect(() => listInvitations(contextFor("coachA"))).toThrow(
      /cannot perform/,
    );
    expect(() => listInvitations(contextFor("parent1"))).toThrow(
      /cannot perform/,
    );
    expect(
      listInvitations(contextFor("ownerB")).invitations.some(
        (i) => i.email === "listed@example.test",
      ),
    ).toBe(false);
  });
  it("resend replaces the token and the unsent message; the old token stops working", async () => {
    const first = invite(owner(), input("resend@example.test"));
    const second = resendInvitation(owner(), first.id);
    expect(second.token).not.toBe(first.token);
    expect(rows(`relatedId='${first.id}' AND status='CANCELLED'`)).toHaveLength(
      1,
    );
    expect(rows(`relatedId='${first.id}' AND status='QUEUED'`)).toHaveLength(1);
    await processOutbox({ transport: transport() });
    expect(captured.map((m) => m.text).join()).not.toContain(first.token);
    expect(captured[0]!.text).toContain(second.token);
    registerTestUser("resend", "Resend");
    await expect(
      acceptInvitation(as("resend"), first.token),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      acceptInvitation(as("resend"), second.token),
    ).resolves.toMatchObject({ academyId: A });
    expect(() => resendInvitation(owner(), first.id)).toThrow(
      /already accepted/,
    );
  });
  it("resend works after a failed delivery and after expiry", async () => {
    scriptCapture(["permanent"]);
    const first = invite(owner(), input("again@example.test"));
    await processOutbox({ transport: transport() });
    database()
      .prepare(
        "UPDATE workspace_invitations SET expiresAt='2000-01-01T00:00:00.000Z' WHERE id=?",
      )
      .run(first.id);
    expect(
      listInvitations(owner()).invitations.find((i) => i.id === first.id)
        ?.state,
    ).toBe("EXPIRED");
    const again = resendInvitation(owner(), first.id);
    expect(again.status).toBe("QUEUED");
    await processOutbox({ transport: transport() });
    expect(
      listInvitations(owner()).invitations.find((i) => i.id === first.id),
    ).toMatchObject({ state: "PENDING", delivery: "SENT" });
  });
  it("revoke ends the invitation and withdraws the unsent message", async () => {
    const result = invite(owner(), input("revoked@example.test"));
    expect(revokeInvitation(owner(), result.id)).toMatchObject({
      state: "EXPIRED",
    });
    expect(rows(`relatedId='${result.id}'`)[0]).toMatchObject({
      status: "CANCELLED",
      textBody: null,
    });
    await processOutbox({ transport: transport() });
    expect(captured).toHaveLength(0);
    registerTestUser("revoked", "Revoked");
    await expect(
      acceptInvitation(as("revoked"), result.token),
    ).rejects.toMatchObject({ status: 403 });
    const audit = database()
      .prepare(
        "SELECT action FROM workspace_audit WHERE resourceId=? ORDER BY id",
      )
      .all(result.id)
      .map((r) => r.action);
    expect(audit).toContain("Invitation revoked");
  });
  it("another academy's administrator cannot resend or revoke it", () => {
    const result = invite(owner(), input("tenant@example.test"));
    expect(() => resendInvitation(contextFor("ownerB"), result.id)).toThrow(
      /not found/,
    );
    expect(() => revokeInvitation(contextFor("ownerB"), result.id)).toThrow(
      /not found/,
    );
    expect(() => resendInvitation(contextFor("coachA"), result.id)).toThrow(
      /cannot perform/,
    );
    expect(B).not.toBe(A);
  });
  it("is refused for an unverified account when verification is required", async () => {
    setEnv({ ...MAIL_ENV, SPORTOZEN_EMAIL_VERIFICATION: "required" });
    const result = invite(owner(), input("unverified@example.test"));
    const user = registerTestUser("unverified", "Unverified");
    await expect(
      acceptInvitation(as("unverified"), result.token),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      database()
        .prepare("SELECT acceptedAt FROM workspace_invitations WHERE id=?")
        .get(result.id)?.acceptedAt,
    ).toBeNull();
    user.emailVerified = true;
    await expect(
      acceptInvitation(as("unverified"), result.token),
    ).resolves.toMatchObject({ academyId: A });
  });
  it("does not queue more than the hourly cap to one address, but the invitation still works", async () => {
    const results = Array.from({ length: RECIPIENT_HOURLY_LIMIT + 1 }, () =>
      invite(owner(), input("cap@example.test")),
    );
    expect(
      results
        .slice(0, RECIPIENT_HOURLY_LIMIT)
        .every((r) => r.status === "QUEUED"),
    ).toBe(true);
    expect(results.at(-1)!.status).toBe("NOT_SENT");
    expect(idOf(results.at(-1)!)).toBeTruthy();
  });
});
