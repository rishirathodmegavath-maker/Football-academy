// Provider independence: the application talks to "an e-mail provider" through
// one interface (src/server/email/types.ts). These tests register a provider
// that does not exist anywhere in the product, drive it through configuration,
// the outbox, retries, delivery tracking and the generic webhook route, and
// check that no business code names a real provider. NOTHING here contacts a
// real provider or sends a real message.
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
vi.mock("server-only", () => ({}));
vi.mock("@/server/auth", () => import("./helpers/mock-auth"));
import { database } from "@/server/database";
import { emailConfig } from "@/server/email/config";
import {
  enqueueEmail,
  processOutbox,
  BACKOFF_SECONDS,
  MAX_ATTEMPTS,
} from "@/server/email/outbox";
import {
  createTransport,
  emailProvider,
  emailProviderNames,
  registerEmailProvider,
  unregisterEmailProvider,
  EmailSendError,
  type DeliveryEvent,
  type EmailProvider,
  type OutgoingEmail,
} from "@/server/email/transport";
import { handleEmailWebhook } from "@/server/email/webhook";
import {
  academyDecisionEmail,
  academySubmittedEmail,
} from "@/server/email/templates";
import { EMAIL_TRANSPORTS } from "../../scripts/lib/preflight.mjs";

const filename = join(tmpdir(), `sportozen-providers-${randomUUID()}.sqlite`);
process.env.SPORTOZEN_DATABASE_PATH = filename;
afterAll(() => {
  database().close();
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(filename + suffix, { force: true });
});

// ----------------------------------------------------- a provider that is not real
const SECRET_KEY = "mockmail-secret-api-key-0123456789abcdef";
const WEBHOOK_SECRET = "mockmail-webhook-signing-secret";
const sent: OutgoingEmail[] = [];
let respond: (
  call: number,
) => "ok" | "busy" | "rejected" | "auth" | "down" = () => "ok";
let calls = 0;
const mockmail: EmailProvider = {
  name: "mockmail",
  kind: "real",
  requiredEnv: [{ name: "MOCKMAIL_API_KEY", description: "the API key" }],
  create: (env) => ({
    name: "mockmail",
    async send(email) {
      calls++;
      const outcome = respond(calls);
      if (outcome === "down")
        throw new EmailSendError(
          `connect failed using key ${env.MOCKMAIL_API_KEY}`,
          false,
          "NETWORK",
        );
      if (outcome === "busy")
        throw new EmailSendError("slow down", false, "RATE_LIMITED");
      if (outcome === "auth") throw new EmailSendError("bad key", true, "AUTH");
      if (outcome === "rejected")
        throw new EmailSendError("address refused", true, "REJECTED");
      sent.push(email);
      return {
        providerMessageId: `mock-${sent.length}-${email.id.slice(0, 8)}`,
      };
    },
  }),
  webhook: {
    requiredEnv: ["MOCKMAIL_WEBHOOK_SECRET"],
    // An HMAC of the raw body, the way many providers sign (this one is
    // invented for the test; no real provider's format is assumed).
    authenticate(headers, env) {
      const given = headers.get("x-mockmail-signature") ?? "";
      const want = createHmac("sha256", env.MOCKMAIL_WEBHOOK_SECRET ?? "")
        .update(headers.get("x-mockmail-body") ?? "")
        .digest("hex");
      return (
        given.length === want.length &&
        timingSafeEqual(Buffer.from(given), Buffer.from(want))
      );
    },
    parse(body, now) {
      const list = Array.isArray((body as { events?: unknown }).events)
        ? (body as { events: Record<string, string>[] }).events
        : [];
      const kinds: Record<string, DeliveryEvent["kind"]> = {
        delivered: "DELIVERED",
        hard_bounce: "BOUNCED",
        soft_bounce: "DELAYED",
        spam: "COMPLAINED",
      };
      return list
        .filter((e) => kinds[e.type!] && e.id && e.message)
        .map((e) => ({
          provider: "mockmail",
          eventId: e.id!,
          providerMessageId: e.message!,
          kind: kinds[e.type!]!,
          occurredAt: new Date(now).toISOString(),
        }));
    },
  },
};

const ENV_KEYS = [
  "SPORTOZEN_EMAIL_TRANSPORT",
  "SPORTOZEN_EMAIL_FROM",
  "MOCKMAIL_API_KEY",
  "MOCKMAIL_WEBHOOK_SECRET",
  "NODE_ENV",
];
const setEnv = (env: Record<string, string>) => {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
};
const ON = {
  SPORTOZEN_EMAIL_TRANSPORT: "mockmail",
  SPORTOZEN_EMAIL_FROM: "Sportozen <notifications@mail.example.test>",
  MOCKMAIL_API_KEY: SECRET_KEY,
};
beforeEach(() => {
  process.env.BETTER_AUTH_URL = "https://academy.example.test";
  registerEmailProvider(mockmail);
  sent.length = 0;
  calls = 0;
  respond = () => "ok";
  database().exec(
    "DELETE FROM email_outbox; DELETE FROM email_events; DELETE FROM email_suppressions;",
  );
  setEnv(ON);
});
afterEach(() => {
  unregisterEmailProvider("mockmail");
  setEnv({});
  vi.restoreAllMocks();
});
const queue = (to = "parent@example.com", days = 1) =>
  enqueueEmail({
    purpose: "NOTIFICATION",
    to,
    subject: "A notice",
    text: "Hello",
    expiresAt: new Date(Date.now() + days * 86_400_000).toISOString(),
  })!.id;
const row = (id: string) =>
  database().prepare("SELECT * FROM email_outbox WHERE id=?").get(id)!;

describe("selecting a provider by configuration", () => {
  it("knows the built-in providers and one registered later", () => {
    expect(emailProviderNames().sort()).toEqual([
      "capture",
      "file",
      "mockmail",
      "postmark",
    ]);
    expect(emailProvider("mockmail")).toBe(mockmail);
    unregisterEmailProvider("mockmail");
    expect(emailProviderNames().sort()).toEqual([
      "capture",
      "file",
      "postmark",
    ]);
  });
  it("uses the provider the configuration names, with no change to any other code", async () => {
    const config = emailConfig();
    expect(config).toMatchObject({ transport: "mockmail", enabled: true });
    expect(createTransport(config)?.name).toBe("mockmail");
    queue();
    expect(await processOutbox()).toMatchObject({ sent: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: "parent@example.com",
      from: ON.SPORTOZEN_EMAIL_FROM,
    });
  });
  it("refuses a provider that is not registered and lists the ones that are", () => {
    setEnv({ ...ON, SPORTOZEN_EMAIL_TRANSPORT: "nosuchmail" });
    expect(() => emailConfig()).toThrow(
      /not available; use one of disabled, .*mockmail/,
    );
  });
  it("refuses a provider whose credentials are missing, naming the variable but not guessing a value", () => {
    setEnv({ ...ON, MOCKMAIL_API_KEY: "  " });
    expect(() => emailConfig()).toThrow(/MOCKMAIL_API_KEY \(the API key\)/);
  });
  it("keeps the local and test transports out of a deployment", () => {
    setEnv({
      SPORTOZEN_EMAIL_TRANSPORT: "capture",
      SPORTOZEN_EMAIL_FROM: ON.SPORTOZEN_EMAIL_FROM,
      NODE_ENV: "production",
    });
    expect(() => emailConfig()).toThrow(/refused in production/);
    setEnv({
      SPORTOZEN_EMAIL_TRANSPORT: "file",
      SPORTOZEN_EMAIL_FROM: ON.SPORTOZEN_EMAIL_FROM,
    });
    expect(() => emailConfig()).toThrow(/localhost/);
  });
  it("accepts only valid provider names", () => {
    for (const bad of ["Postmark", "disabled", "a", "mail provider", "x;y", ""])
      expect(
        () => registerEmailProvider({ ...mockmail, name: bad }),
        bad,
      ).toThrow();
  });
  it("keeps the deployment preflight's list equal to the real providers", () => {
    const real = emailProviderNames()
      .filter(
        (name) => emailProvider(name)!.kind === "real" && name !== "mockmail",
      )
      .sort();
    expect(
      [...EMAIL_TRANSPORTS].filter((n: string) => n !== "disabled").sort(),
    ).toEqual(real);
  });
});

describe("delivery through a provider: failure, retry and success", () => {
  it("retries a temporary failure on the documented schedule and then delivers", async () => {
    respond = (call) => (call < 3 ? "down" : "ok");
    const id = queue();
    let now = Date.now();
    expect(await processOutbox({ now: () => now })).toMatchObject({
      retried: 1,
    });
    expect(row(id)).toMatchObject({ status: "QUEUED", attempts: 1 });
    // Not due yet: nothing is attempted early.
    now += (BACKOFF_SECONDS[0]! - 1) * 1000;
    expect(await processOutbox({ now: () => now })).toMatchObject({
      sent: 0,
      retried: 0,
    });
    now += 2000;
    expect(await processOutbox({ now: () => now })).toMatchObject({
      retried: 1,
    });
    now += (BACKOFF_SECONDS[1]! + 1) * 1000;
    expect(await processOutbox({ now: () => now })).toMatchObject({ sent: 1 });
    expect(row(id)).toMatchObject({ status: "SENT", attempts: 3 });
    expect(sent).toHaveLength(1);
  });
  it("gives up on a permanent failure at once, and after the last attempt on a temporary one", async () => {
    respond = () => "rejected";
    const rejected = queue("a@example.com");
    expect(await processOutbox()).toMatchObject({ failed: 1 });
    expect(row(rejected)).toMatchObject({ status: "FAILED", attempts: 1 });
    expect(String(row(rejected).lastError)).toContain("REJECTED");
    respond = () => "busy";
    const busy = queue("b@example.com", 30);
    let now = Date.now();
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await processOutbox({ now: () => now });
      now += 7 * 3600 * 1000;
    }
    expect(row(busy)).toMatchObject({
      status: "FAILED",
      attempts: MAX_ATTEMPTS,
    });
    expect(String(row(busy).lastError)).toContain("RETRIES_EXHAUSTED");
    expect(sent).toHaveLength(0);
  });
  it("treats a refusal of the credentials as permanent, not as something to retry", async () => {
    respond = () => "auth";
    const id = queue();
    await processOutbox();
    expect(row(id)).toMatchObject({ status: "FAILED", attempts: 1 });
  });
  it("never lets the provider's secret reach the stored error or the log", async () => {
    respond = () => "down";
    const logged: string[] = [];
    for (const channel of ["log", "warn", "error", "info"] as const)
      vi.spyOn(console, channel).mockImplementation((...args) => {
        logged.push(args.map(String).join(" "));
      });
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      logged.push(String(chunk));
      return true;
    });
    const id = queue("secret@example.com");
    await processOutbox();
    expect(String(row(id).lastError)).not.toContain(SECRET_KEY);
    expect(String(row(id).lastError)).toContain("[token]");
    expect(logged.join("\n")).not.toContain(SECRET_KEY);
    expect(logged.join("\n")).not.toContain("secret@example.com");
  });
  it("erases the message text once it is sent, whatever the provider", async () => {
    const id = queue();
    await processOutbox();
    expect(row(id)).toMatchObject({
      textBody: null,
      htmlBody: null,
      status: "SENT",
    });
  });
});

describe("delivery tracking through the generic webhook", () => {
  const WEBHOOK_ENV = { ...ON, MOCKMAIL_WEBHOOK_SECRET: WEBHOOK_SECRET };
  const post = (events: unknown[], signWith = WEBHOOK_SECRET) => {
    const body = JSON.stringify({ events });
    const sign = createHmac("sha256", signWith).update(body).digest("hex");
    return handleEmailWebhook(
      new Request("https://academy.example.test/api/email/webhooks/mockmail", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-mockmail-signature": sign,
          "x-mockmail-body": body,
        },
        body,
      }),
      "mockmail",
      process.env,
    );
  };
  it("does not exist until the provider's webhook secret is configured", async () => {
    expect((await post([])).status).toBe(404);
    setEnv(WEBHOOK_ENV);
    expect((await post([])).status).toBe(200);
  });
  it("does not exist for a provider that is unknown or has no webhook", async () => {
    setEnv(WEBHOOK_ENV);
    for (const name of [
      "nosuchmail",
      "capture",
      "file",
      "__proto__",
      "../postmark",
    ]) {
      const res = await handleEmailWebhook(
        new Request("https://academy.example.test/x", {
          method: "POST",
          body: "{}",
        }),
        name,
        process.env,
      );
      expect(res.status, name).toBe(404);
    }
  });
  it("refuses a request that is not authentic", async () => {
    setEnv(WEBHOOK_ENV);
    const id = queue();
    await processOutbox();
    const providerId = String(row(id).providerMessageId);
    const res = await post(
      [{ type: "hard_bounce", id: "e1", message: providerId }],
      "someone-elses-secret",
    );
    expect(res.status).toBe(401);
    expect(row(id).deliveryStatus ?? null).toBeNull();
  });
  it("records a delivery, applies a bounce once, suppresses the address, and ignores a replay", async () => {
    setEnv(WEBHOOK_ENV);
    const ok = queue("fine@example.com");
    const bad = queue("gone@example.com");
    await processOutbox();
    const okId = String(row(ok).providerMessageId),
      badId = String(row(bad).providerMessageId);
    expect(
      (await post([{ type: "delivered", id: "d1", message: okId }])).status,
    ).toBe(200);
    expect(row(ok).deliveryStatus).toBe("DELIVERED");
    const bounce = [{ type: "hard_bounce", id: "b1", message: badId }];
    expect((await post(bounce)).status).toBe(200);
    expect((await post(bounce)).status).toBe(200); // the provider retries
    expect(row(bad).deliveryStatus).toBe("BOUNCED");
    expect(
      database()
        .prepare("SELECT COUNT(*) n FROM email_events WHERE eventId='b1'")
        .get()?.n,
    ).toBe(1);
    expect(
      database()
        .prepare(
          "SELECT source FROM email_suppressions WHERE address='gone@example.com'",
        )
        .get()?.source,
    ).toBe("mockmail");
    // Nothing more is queued for a suppressed address.
    expect(queueOrNull("gone@example.com")).toBeNull();
    // A later "delivered" never undoes a bounce.
    await post([{ type: "delivered", id: "d2", message: badId }]);
    expect(row(bad).deliveryStatus).toBe("BOUNCED");
  });
  it("treats a soft bounce as a delay, not a suppression, and ignores events it does not act on", async () => {
    setEnv(WEBHOOK_ENV);
    const id = queue("slow@example.com");
    await processOutbox();
    const providerId = String(row(id).providerMessageId);
    await post([
      { type: "soft_bounce", id: "s1", message: providerId },
      { type: "opened", id: "o1", message: providerId },
      { type: "delivered" },
    ]);
    expect(row(id).deliveryStatus).toBe("DELAYED");
    expect(
      database().prepare("SELECT COUNT(*) n FROM email_suppressions").get()?.n,
    ).toBe(0);
    expect(
      database().prepare("SELECT COUNT(*) n FROM email_events").get()?.n,
    ).toBe(1);
  });
  it("rejects a body that is not JSON and one that is too large", async () => {
    setEnv(WEBHOOK_ENV);
    const raw = (body: string) => {
      const sign = createHmac("sha256", WEBHOOK_SECRET)
        .update(body.slice(0, 100))
        .digest("hex");
      return handleEmailWebhook(
        new Request("https://academy.example.test/x", {
          method: "POST",
          headers: {
            "x-mockmail-signature": sign,
            "x-mockmail-body": body.slice(0, 100),
          },
          body,
        }),
        "mockmail",
        process.env,
      );
    };
    expect((await raw("not json")).status).toBe(400);
    expect((await raw("x".repeat(200_000))).status).toBe(413);
  });
});
const queueOrNull = (to: string) =>
  enqueueEmail({
    purpose: "NOTIFICATION",
    to,
    subject: "s",
    text: "t",
    expiresAt: new Date(Date.now() + 1e6).toISOString(),
  });

describe("no business code names a provider", () => {
  it("mentions Postmark only in its own adapter, the registry and the compatibility re-exports", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name)) files.push(path);
      }
    };
    walk(join(process.cwd(), "src"));
    const mentions = files
      .filter((f) => /postmark/i.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(process.cwd().length + 1).replace(/\\/g, "/"))
      .sort();
    expect(mentions).toEqual([
      "src/server/email/config.ts", // a sentence in the doc comment
      "src/server/email/events.ts", // re-export of the adapter's parser
      "src/server/email/postmark.ts", // the adapter
      "src/server/email/transport.ts", // registers it
    ]);
  });
  it("lets the outbox, the events and the webhook handler depend on the interface only", () => {
    for (const file of [
      "outbox.ts",
      "webhook.ts",
      "index.ts",
      "templates.ts",
    ]) {
      const source = readFileSync(
        join(process.cwd(), "src/server/email", file),
        "utf8",
      );
      expect(/postmark|zeptomail|zoho/i.test(source), file).toBe(false);
    }
  });
});

describe("the academy notices are safe", () => {
  it("escapes the reviewer's text in HTML and keeps it out of the subject", () => {
    const reason =
      '<script>alert(1)</script>\r\nBcc: attacker@example.test "quoted"';
    const mail = academyDecisionEmail({
      name: "Owner",
      academyName: "Academy <b>",
      outcome: "rejected",
      reason,
      url: "https://academy.example.test/workspace/x",
    });
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("&lt;script&gt;");
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.subject).not.toContain("attacker");
    // The detail row is made header-safe, so no line starts a new header.
    expect(mail.text).not.toMatch(/\r\nBcc:/);
  });
  it("says which outcome it is, and tells administrators whether it is a resubmission", () => {
    for (const outcome of [
      "approved",
      "rejected",
      "suspended",
      "reactivated",
    ] as const)
      expect(
        academyDecisionEmail({
          name: "O",
          academyName: "A",
          outcome,
        }).subject.toLowerCase(),
      ).toContain(outcome === "rejected" ? "not approved" : outcome);
    expect(
      academySubmittedEmail({
        name: "x",
        academyName: "A",
        resubmission: true,
        url: "https://a.test/platform",
      }).subject,
    ).toContain("Resubmitted");
    expect(
      academySubmittedEmail({
        name: "x",
        academyName: "A",
        resubmission: false,
        url: "https://a.test/platform",
      }).subject,
    ).toContain("New");
  });
});
