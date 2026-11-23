// Worldwide e-mail: recipients in any country, Unicode names, UTC storage with
// recipient-local formatting, the provider adapter (mocked HTTP), delivery
// events, suppression, the webhook and the migration. NOTHING here contacts a
// real provider or sends a real message: every send is a mock.
import {
  afterAll,
  afterEach,
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
import { DatabaseSync } from "node:sqlite";
vi.mock("server-only", () => ({}));
vi.mock("@/server/auth", () => import("./helpers/mock-auth"));
import { database } from "@/server/database";
import { checkRecipient, headerSafe } from "@/server/email/address";
import { emailConfig } from "@/server/email/config";
import { formatInstant, formatMoney } from "@/server/email/format";
import {
  notificationEmail,
  passwordResetEmail,
  paymentReceiptEmail,
  reportReadyEmail,
  sessionNoticeEmail,
  verificationEmail,
  invitationEmail,
} from "@/server/email/templates";
import {
  captured,
  EmailSendError,
  postmarkTransport,
  resetCapture,
  createTransport,
} from "@/server/email/transport";
import {
  deliveryStatuses,
  enqueueEmail,
  processOutbox,
  purgeFinished,
} from "@/server/email/outbox";
import {
  parsePostmarkEvent,
  recordDeliveryEvent,
} from "@/server/email/events";
import { migrateEmailDelivery } from "@/server/migrations/010-email-delivery";
import { POST as webhookRoute } from "@/app/api/email/webhooks/[provider]/route";
const webhook = (request: Request) =>
  webhookRoute(request, { params: Promise.resolve({ provider: "postmark" }) });

const filename = join(tmpdir(), `sportozen-global-mail-${randomUUID()}.sqlite`);
process.env.SPORTOZEN_DATABASE_PATH = filename;
const ORIGIN = "https://academy.sportozen.app";
const MAIL_ENV = {
  SPORTOZEN_EMAIL_TRANSPORT: "capture",
  SPORTOZEN_EMAIL_FROM: "Sportozen <notifications@academy.sportozen.app>",
};
const KEYS = [
  "SPORTOZEN_EMAIL_TRANSPORT",
  "SPORTOZEN_EMAIL_FROM",
  "SPORTOZEN_POSTMARK_TOKEN",
  "SPORTOZEN_POSTMARK_WEBHOOK_USER",
  "SPORTOZEN_POSTMARK_WEBHOOK_PASSWORD",
];
const setEnv = (env: Record<string, string>) => {
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, env);
};
beforeEach(() => {
  process.env.BETTER_AUTH_URL = ORIGIN;
  resetCapture();
  database().exec(
    "DELETE FROM email_outbox; DELETE FROM email_events; DELETE FROM email_suppressions;",
  );
  setEnv(MAIL_ENV);
});
afterEach(() => {
  vi.restoreAllMocks();
  setEnv({});
});
afterAll(() => {
  database().close();
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(filename + suffix, { force: true });
});
const row = (id: string) =>
  database().prepare("SELECT * FROM email_outbox WHERE id=?").get(id)!;

// The illustrative addresses from the requirements, plus others: none of these
// is special-cased anywhere; they only prove that no country or domain is.
const WORLD = [
  "rishi@gmail.com", // India
  "alex@yahoo.com", // USA
  "sarah@outlook.co.uk", // UK
  "ahmed@example.ae", // UAE
  "james@example.com.au", // Australia
  "anna@example.de", // Germany
  "priya.sharma+academy@example.in",
  "li.wei@example.cn",
  "joão@example.com.br",
  "user@mail.sub.example.academy", // a new generic TLD
  "x@a.io",
];

describe("recipient addresses are checked by standard rules, not by country", () => {
  it.each(WORLD)("accepts %s", (address) => {
    expect(checkRecipient(address)).toMatchObject({ ok: true });
  });
  it("accepts internationalised addresses and sends the ASCII form of the domain", () => {
    expect(checkRecipient("anna@münchen.de")).toEqual({
      ok: true,
      address: "anna@münchen.de",
      ascii: "anna@xn--mnchen-3ya.de",
    });
    expect(checkRecipient("अजय@उदाहरण.भारत")).toMatchObject({ ok: true });
    expect(checkRecipient("कुमार@example.in")).toMatchObject({ ok: true });
    expect(checkRecipient("δοκιμή@παράδειγμα.δοκιμή")).toMatchObject({ ok: true });
    expect(checkRecipient("测试@例え.jp")).toMatchObject({ ok: true });
  });
  it("is case-insensitive in the domain and keeps the local part as typed", () => {
    expect(checkRecipient("Rishi@GMAIL.COM")).toMatchObject({
      ok: true,
      address: "Rishi@gmail.com",
    });
  });
  it.each([
    "",
    "plain",
    "a@b",
    "a b@example.com",
    "a@@example.com",
    "@example.com",
    "a@",
    "a@.com",
    "a@example..com",
    "a@-example.com",
    "a@example-.com",
    "a@example.123",
    "<a@example.com>",
    "a@example.com, b@example.com",
    "a@[127.0.0.1]",
    '"quoted"@example.com',
    "a..b@example.com",
    ".a@example.com",
    "a@example.com\r\nBcc: victim@example.com",
    `${"a".repeat(65)}@example.com`,
    `a@${"b".repeat(64)}.com`,
  ])("refuses %j", (address) => {
    expect(checkRecipient(address).ok).toBe(false);
  });
  it("strips line breaks from anything placed in a header", () => {
    expect(headerSafe("Alex\r\nBcc: victim@example.com")).toBe(
      "Alex Bcc: victim@example.com",
    );
  });
});

describe("dates and amounts: UTC inside, the recipient's own zone outside", () => {
  const instant = "2026-11-03T13:00:00.000Z";
  const plain = (value: string) => value.replace(/\s/g, " ");
  it.each([
    ["Asia/Kolkata", "en-IN", "6:30"],
    ["Asia/Dubai", "en", "5:00"],
    ["Australia/Sydney", "en-AU", "12:00"],
    ["Europe/Berlin", "en-GB", "14:00"],
    ["America/New_York", "en-US", "8:00"],
  ])("shows the same instant in %s", (timeZone, locale, clock) => {
    const text = plain(formatInstant(instant, { timeZone, locale }));
    expect(text).toContain(clock);
    expect(text).toMatch(/2026/);
  });
  it("uses the recipient's language for the date and the 24-hour clock where they do", () => {
    const text = plain(
      formatInstant(instant, { timeZone: "Europe/Berlin", locale: "de-DE" }),
    );
    expect(text).toContain("Dienstag");
    expect(text).toContain("14:00");
  });
  it("shows UTC, and says so, when nothing is known about the recipient", () => {
    expect(plain(formatInstant(instant))).toMatch(/13:00|1:00/);
    expect(formatInstant(instant)).toContain("UTC");
  });
  it("ignores an unknown time zone or locale instead of guessing", () => {
    expect(formatInstant(instant, { timeZone: "Mars/Olympus", locale: "zz-??" })).toContain("UTC");
  });
  it("does not infer anything from the address: the same input gives the same text", () => {
    const a = sessionNoticeEmail({
      name: "A",
      academyName: "Academy",
      headline: "Session moved",
      startsAt: instant,
    });
    expect(a.text).toContain("UTC");
  });
  it("formats money in its own currency and the recipient's language", () => {
    expect(plain(formatMoney(150000, "INR", { locale: "en-IN" }))).toContain("1,500.00");
    expect(plain(formatMoney(150000, "EUR", { locale: "de-DE" }))).toContain("1.500,00");
    expect(plain(formatMoney(1500, "JPY", { locale: "ja-JP" }))).toMatch(/1,500/);
    expect(() => formatMoney(1, "RUPEES")).toThrow(/currency/);
  });
});

describe("one template layout, text and HTML, any script", () => {
  const NAME = "José Ålvarez 李雷 अजय محمد";
  it("keeps international names exactly, in text and in HTML", () => {
    for (const m of [
      verificationEmail({ name: NAME, url: `${ORIGIN}/x`, hours: 24 }),
      passwordResetEmail({ name: NAME, url: `${ORIGIN}/x`, minutes: 60 }),
      sessionNoticeEmail({
        name: NAME,
        academyName: "Académie Sportozen",
        headline: "Training moved",
        startsAt: "2026-11-03T13:00:00Z",
        timeZone: "Asia/Kolkata",
      }),
      paymentReceiptEmail({
        name: NAME,
        academyName: "Académie Sportozen",
        receiptNumber: "R-1",
        amountMinor: 150000,
        currency: "INR",
        paidAt: "2026-11-03T13:00:00Z",
        locale: "en-IN",
        timeZone: "Asia/Kolkata",
      }),
      reportReadyEmail({
        name: NAME,
        academyName: "Académie Sportozen",
        reportTitle: "Monthly report",
        url: `${ORIGIN}/r`,
      }),
      notificationEmail({ name: NAME, subject: "Hello", paragraphs: ["Body"] }),
    ]) {
      expect(m.text).toContain(NAME);
      expect(m.html).toContain(NAME);
      expect(m.html.startsWith("<!doctype html>")).toBe(true);
      expect(m.html).toContain('charset="utf-8"');
    }
  });
  it("escapes markup in names, academy names and URLs in the HTML form", () => {
    const m = invitationEmail({
      academyName: '<img src=x onerror=alert(1)> & "Co"',
      role: "COACH",
      url: `${ORIGIN}/workspace?invitation=a"b&c=<d>`,
      days: 7,
    });
    expect(m.html).not.toContain("<img");
    expect(m.html).not.toContain('a"b');
    expect(m.html).toContain("&lt;img");
    expect(m.html).toContain("&amp;");
  });
  it("keeps line breaks and secrets out of the subject", () => {
    const m = invitationEmail({
      academyName: "Academy\r\nBcc: victim@example.com",
      role: "PARENT",
      url: `${ORIGIN}/workspace?invitation=TOKEN`,
      days: 7,
    });
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.subject).not.toContain("TOKEN");
  });
  it("gives every message the same brand header and footer", () => {
    const messages = [
      verificationEmail({ name: "A", url: `${ORIGIN}/x`, hours: 1 }),
      notificationEmail({ name: "A", subject: "S", paragraphs: ["P"] }),
    ];
    for (const m of messages) {
      expect(m.html).toContain("ACADEMY");
      expect(m.text).toContain("This is an automated message; replies are not read.");
    }
  });
});

describe("the outbox accepts every kind of message for any valid recipient", () => {
  it.each(WORLD)("queues, sends and finishes a message for %s", async (to) => {
    const queued = enqueueEmail({
      purpose: "NOTIFICATION",
      to,
      subject: "Hello",
      text: "Body",
      html: "<p>Body</p>",
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
    expect(queued).not.toBeNull();
    const summary = await processOutbox();
    expect(summary.sent).toBe(1);
    expect(captured.at(-1)).toMatchObject({ to: to.toLowerCase(), html: "<p>Body</p>" });
    expect(row(queued!.id)).toMatchObject({ status: "SENT", textBody: null, htmlBody: null });
  });
  it.each(["SESSION_NOTICE", "PAYMENT_RECEIPT", "REPORT_READY", "NOTIFICATION"] as const)(
    "accepts the %s kind",
    (purpose) => {
      expect(
        enqueueEmail({
          purpose,
          to: "someone@example.org",
          subject: "S",
          text: "T",
          expiresAt: "2999-01-01T00:00:00.000Z",
        }),
      ).not.toBeNull();
    },
  );
  it("drops an invalid recipient without queueing and without logging the address", () => {
    const lines: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((l) => void lines.push(String(l)));
    vi.spyOn(console, "log").mockImplementation((l) => void lines.push(String(l)));
    expect(
      enqueueEmail({
        purpose: "NOTIFICATION",
        to: "not an address",
        subject: "S",
        text: "T",
        expiresAt: "2999-01-01T00:00:00.000Z",
      }),
    ).toBeNull();
    expect(
      database().prepare("SELECT COUNT(*) n FROM email_outbox").get()!.n,
    ).toBe(0);
    expect(lines.join("")).not.toContain("not an address");
  });
  it("sends no more mail to an address that hard-bounced or complained", async () => {
    const first = enqueueEmail({
      purpose: "NOTIFICATION",
      to: "gone@example.de",
      subject: "S",
      text: "T",
      expiresAt: "2999-01-01T00:00:00.000Z",
    })!;
    await processOutbox();
    const providerId = String(row(first.id).providerMessageId);
    recordDeliveryEvent({
      provider: "postmark",
      eventId: "bounce:1",
      providerMessageId: providerId,
      kind: "BOUNCED",
      occurredAt: "2026-11-03T00:00:00.000Z",
    });
    expect(
      enqueueEmail({
        purpose: "PASSWORD_RESET",
        to: "GONE@example.de",
        subject: "S",
        text: "T",
        expiresAt: "2999-01-01T00:00:00.000Z",
      }),
    ).toBeNull();
    // Other addresses are unaffected.
    expect(
      enqueueEmail({
        purpose: "PASSWORD_RESET",
        to: "there@example.de",
        subject: "S",
        text: "T",
        expiresAt: "2999-01-01T00:00:00.000Z",
      }),
    ).not.toBeNull();
  });
});

describe("the Postmark adapter (HTTP mocked: no message leaves this machine)", () => {
  const email = {
    id: "message-1",
    to: "anna@münchen.de",
    from: "Sportozen <notifications@mail.sportozen.app>",
    subject: "Hallo",
    text: "Body",
    html: "<p>Body</p>",
  };
  const reply = (status: number, body: unknown) => ({
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  });
  const make = (fetch: Parameters<typeof postmarkTransport>[0]["fetch"]) =>
    postmarkTransport({ token: "SECRET-SERVER-TOKEN-123", stream: "outbound", fetch });

  it("posts the documented request and returns the provider's message id", async () => {
    const calls: { url: string; init: Record<string, unknown> }[] = [];
    const t = make(async (url, init) => {
      calls.push({ url, init });
      return reply(200, { ErrorCode: 0, MessageID: "pm-123", Message: "OK" });
    });
    await expect(t.send(email)).resolves.toEqual({ providerMessageId: "pm-123" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.postmarkapp.com/email");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["X-Postmark-Server-Token"]).toBe("SECRET-SERVER-TOKEN-123");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({
      From: email.from,
      To: "anna@xn--mnchen-3ya.de",
      Subject: "Hallo",
      TextBody: "Body",
      HtmlBody: "<p>Body</p>",
      MessageStream: "outbound",
      TrackOpens: false,
      TrackLinks: "None",
      Metadata: { outboxId: "message-1" },
    });
  });
  it.each([
    [500, { ErrorCode: 0 }, false, "PROVIDER_ERROR"],
    [503, "Service Unavailable", false, "PROVIDER_ERROR"],
    [429, { Message: "slow down" }, false, "RATE_LIMITED"],
    [401, { ErrorCode: 10, Message: "Bad or missing API token" }, true, "AUTH"],
    [403, {}, true, "AUTH"],
    [422, { ErrorCode: 406, Message: "inactive recipient" }, true, "INACTIVE_RECIPIENT"],
    [422, { ErrorCode: 300, Message: "invalid email" }, true, "REJECTED"],
    [422, { ErrorCode: 400, Message: "sender signature not found" }, true, "REJECTED"],
  ])("maps HTTP %s to permanent=%s %s", async (status, body, permanent, code) => {
    const t = make(async () => reply(status as number, body));
    const error = await t.send(email).catch((e) => e);
    expect(error).toBeInstanceOf(EmailSendError);
    expect(error).toMatchObject({ permanent, code });
  });
  it("treats a network failure or timeout as transient", async () => {
    const t = make(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await t.send(email).catch((e) => e)).toMatchObject({
      permanent: false,
      code: "NETWORK",
    });
  });
  it("treats a 200 without a message id as a failure, not a send", async () => {
    const t = make(async () => reply(200, { ErrorCode: 0 }));
    await expect(t.send(email)).rejects.toBeInstanceOf(EmailSendError);
  });
  it("refuses an invalid recipient before any request is made", async () => {
    const fetch = vi.fn();
    const t = make(fetch as never);
    expect(await t.send({ ...email, to: "no way" }).catch((e) => e)).toMatchObject({
      permanent: true,
      code: "INVALID_RECIPIENT",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("never puts the token, an address or a link into an error", async () => {
    const t = make(async () =>
      reply(422, { ErrorCode: 300, Message: "bad anna@münchen.de https://x.example/secret" }),
    );
    const error = (await t.send(email).catch((e) => e)) as Error;
    expect(error.message).not.toContain("SECRET-SERVER-TOKEN-123");
    expect(error.message).not.toContain("anna@");
    expect(error.message).not.toContain("https://");
  });
  it("is chosen by configuration and fails loudly without a token", () => {
    const env = {
      ...MAIL_ENV,
      SPORTOZEN_EMAIL_TRANSPORT: "postmark",
      BETTER_AUTH_URL: ORIGIN,
    };
    expect(() => emailConfig(env)).toThrow(/SPORTOZEN_POSTMARK_TOKEN/);
    const config = emailConfig({ ...env, SPORTOZEN_POSTMARK_TOKEN: "t" });
    expect(config).toMatchObject({ transport: "postmark", enabled: true });
    expect(createTransport(config, { SPORTOZEN_POSTMARK_TOKEN: "t" })?.name).toBe("postmark");
  });
  it("processes through the outbox: transient retries, a permanent rejection fails at once", async () => {
    setEnv({ ...MAIL_ENV });
    let calls = 0;
    const transport = make(async () => {
      calls++;
      return calls === 1
        ? reply(503, "down")
        : reply(200, { ErrorCode: 0, MessageID: `pm-${calls}` });
    });
    const queued = enqueueEmail({
      purpose: "NOTIFICATION",
      to: "ahmed@example.ae",
      subject: "S",
      text: "T",
      expiresAt: "2999-01-01T00:00:00.000Z",
    })!;
    const t0 = Date.now();
    expect(await processOutbox({ transport, now: () => t0 })).toMatchObject({ retried: 1 });
    expect(row(queued.id)).toMatchObject({ status: "QUEUED", attempts: 1 });
    expect(await processOutbox({ transport, now: () => t0 + 61_000 })).toMatchObject({ sent: 1 });
    expect(row(queued.id)).toMatchObject({ status: "SENT", providerMessageId: "pm-2" });

    const rejected = enqueueEmail({
      purpose: "NOTIFICATION",
      to: "james@example.com.au",
      subject: "S",
      text: "T",
      expiresAt: "2999-01-01T00:00:00.000Z",
    })!;
    const reject = make(async () => reply(422, { ErrorCode: 406 }));
    expect(await processOutbox({ transport: reject })).toMatchObject({ failed: 1 });
    expect(String(row(rejected.id).lastError)).toContain("INACTIVE_RECIPIENT");
  });
});

describe("delivery events", () => {
  async function sent(to = "sarah@outlook.co.uk") {
    const queued = enqueueEmail({
      purpose: "INVITATION",
      to,
      subject: "S",
      text: "T",
      expiresAt: "2999-01-01T00:00:00.000Z",
      relatedId: `inv-${randomUUID()}`,
    })!;
    await processOutbox();
    return { id: queued.id, provider: String(row(queued.id).providerMessageId) };
  }
  const event = (providerMessageId: string, kind: "DELIVERED" | "DELAYED" | "BOUNCED" | "COMPLAINED", eventId = `e-${randomUUID()}`) => ({
    provider: "postmark",
    eventId,
    providerMessageId,
    kind,
    occurredAt: "2026-11-03T10:00:00.000Z",
  });

  it("records a delivery on the message", async () => {
    const m = await sent();
    expect(recordDeliveryEvent(event(m.provider, "DELIVERED"))).toEqual({ recorded: true, matched: true });
    expect(row(m.id)).toMatchObject({ deliveryStatus: "DELIVERED", deliveredAt: "2026-11-03T10:00:00.000Z" });
  });
  it("ignores a replayed event", async () => {
    const m = await sent();
    recordDeliveryEvent(event(m.provider, "DELIVERED", "same"));
    expect(recordDeliveryEvent(event(m.provider, "DELIVERED", "same"))).toMatchObject({ recorded: false });
    expect(
      database().prepare("SELECT COUNT(*) n FROM email_events").get()!.n,
    ).toBe(1);
  });
  it("suppresses the address after a hard bounce or a complaint, and not after a delay", async () => {
    const delayed = await sent("a@example.de");
    recordDeliveryEvent(event(delayed.provider, "DELAYED"));
    expect(database().prepare("SELECT COUNT(*) n FROM email_suppressions").get()!.n).toBe(0);
    const bounced = await sent("b@example.de");
    recordDeliveryEvent(event(bounced.provider, "BOUNCED"));
    const complained = await sent("c@example.de");
    recordDeliveryEvent(event(complained.provider, "COMPLAINED"));
    expect(
      database().prepare("SELECT address FROM email_suppressions ORDER BY address").all().map((r) => r.address),
    ).toEqual(["b@example.de", "c@example.de"]);
  });
  it("never lets a late 'delivered' undo a bounce", async () => {
    const m = await sent();
    recordDeliveryEvent(event(m.provider, "BOUNCED"));
    recordDeliveryEvent(event(m.provider, "DELIVERED"));
    expect(row(m.id).deliveryStatus).toBe("BOUNCED");
  });
  it("records an event for an unknown message without inventing a suppression", () => {
    expect(recordDeliveryEvent(event("not-ours", "BOUNCED"))).toEqual({ recorded: true, matched: false });
    expect(database().prepare("SELECT COUNT(*) n FROM email_suppressions").get()!.n).toBe(0);
  });
  it("shows a bounced invitation as failed to the administrator", async () => {
    const m = await sent();
    const related = String(row(m.id).relatedId);
    expect(deliveryStatuses([related]).get(related)).toBe("SENT");
    recordDeliveryEvent(event(m.provider, "BOUNCED"));
    expect(deliveryStatuses([related]).get(related)).toBe("FAILED");
  });
  it("purges old events with the finished messages", async () => {
    const m = await sent();
    recordDeliveryEvent(event(m.provider, "DELIVERED"));
    purgeFinished(Date.now() + 100 * 86_400_000);
    expect(database().prepare("SELECT COUNT(*) n FROM email_events").get()!.n).toBe(0);
  });
  it("keeps addresses, links and text out of the log", async () => {
    const lines: string[] = [];
    for (const method of ["log", "warn", "error", "info"] as const)
      vi.spyOn(console, method).mockImplementation((l) => void lines.push(String(l)));
    const m = await sent("private.person@example.de");
    recordDeliveryEvent({ ...event(m.provider, "BOUNCED"), detail: "mailbox private.person@example.de https://x.example/abc" });
    const logged = lines.join("\n");
    expect(logged).toContain("email.delivery_event");
    expect(logged).not.toContain("private.person");
    expect(logged).not.toContain("https://x.example");
  });
});

describe("Postmark payloads", () => {
  it("maps delivery, hard bounce, soft bounce and complaint", () => {
    expect(parsePostmarkEvent({ RecordType: "Delivery", MessageID: "m", DeliveredAt: "2026-11-03T10:00:00Z" })).toMatchObject({ kind: "DELIVERED", providerMessageId: "m" });
    expect(parsePostmarkEvent({ RecordType: "Bounce", ID: 42, MessageID: "m", Type: "HardBounce" })).toMatchObject({ kind: "BOUNCED", eventId: "bounce:42" });
    expect(parsePostmarkEvent({ RecordType: "Bounce", ID: 43, MessageID: "m", Type: "SoftBounce" })).toMatchObject({ kind: "DELAYED" });
    expect(parsePostmarkEvent({ RecordType: "SpamComplaint", ID: 7, MessageID: "m" })).toMatchObject({ kind: "COMPLAINED" });
  });
  it("ignores everything else", () => {
    expect(parsePostmarkEvent({ RecordType: "Open", MessageID: "m" })).toBeNull();
    expect(parsePostmarkEvent({ RecordType: "Bounce" })).toBeNull();
    expect(parsePostmarkEvent("nonsense")).toBeNull();
    expect(parsePostmarkEvent(null)).toBeNull();
  });
});

describe("the Postmark webhook", () => {
  const USER = "postmark-hook";
  const PASS = "a-long-random-webhook-password";
  const auth = (user = USER, pass = PASS) =>
    `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
  const call = (body: unknown, authorization?: string) =>
    webhook(
      new Request(`${ORIGIN}/api/email/webhooks/postmark`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
  it("does not exist until both credentials are configured", async () => {
    expect((await call({}, auth())).status).toBe(404);
    setEnv({ ...MAIL_ENV, SPORTOZEN_POSTMARK_WEBHOOK_USER: USER, SPORTOZEN_POSTMARK_WEBHOOK_PASSWORD: "short" });
    expect((await call({}, auth(USER, "short"))).status).toBe(404);
  });
  it("refuses missing or wrong credentials", async () => {
    setEnv({ ...MAIL_ENV, SPORTOZEN_POSTMARK_WEBHOOK_USER: USER, SPORTOZEN_POSTMARK_WEBHOOK_PASSWORD: PASS });
    expect((await call({})).status).toBe(401);
    expect((await call({}, auth(USER, "wrong-password-wrong"))).status).toBe(401);
    expect((await call({}, auth("someone", PASS))).status).toBe(401);
    expect((await call({}, "Bearer abc")).status).toBe(401);
  });
  it("applies a bounce once, even when Postmark retries it", async () => {
    setEnv({ ...MAIL_ENV, SPORTOZEN_POSTMARK_WEBHOOK_USER: USER, SPORTOZEN_POSTMARK_WEBHOOK_PASSWORD: PASS });
    const queued = enqueueEmail({
      purpose: "PASSWORD_RESET",
      to: "ahmed@example.ae",
      subject: "S",
      text: "T",
      expiresAt: "2999-01-01T00:00:00.000Z",
    })!;
    await processOutbox();
    const id = String(row(queued.id).providerMessageId);
    const payload = { RecordType: "Bounce", ID: 9001, MessageID: id, Type: "HardBounce", Description: "mailbox does not exist" };
    expect((await call(payload, auth())).status).toBe(200);
    expect((await call(payload, auth())).status).toBe(200);
    expect(row(queued.id).deliveryStatus).toBe("BOUNCED");
    expect(database().prepare("SELECT COUNT(*) n FROM email_events").get()!.n).toBe(1);
    expect(database().prepare("SELECT address FROM email_suppressions").get()).toMatchObject({ address: "ahmed@example.ae" });
  });
  it("answers 200 to record types it does not use, and 400 to a body that is not JSON", async () => {
    setEnv({ ...MAIL_ENV, SPORTOZEN_POSTMARK_WEBHOOK_USER: USER, SPORTOZEN_POSTMARK_WEBHOOK_PASSWORD: PASS });
    expect((await call({ RecordType: "Open", MessageID: "m" }, auth())).status).toBe(200);
    expect((await call("not json", auth())).status).toBe(400);
  });
});

describe("migration 010 keeps existing messages", () => {
  it("rebuilds an older outbox, keeps its rows and is repeatable", () => {
    const old = new DatabaseSync(":memory:");
    old.exec(`CREATE TABLE email_outbox(
      id TEXT PRIMARY KEY,
      purpose TEXT NOT NULL CHECK(purpose IN ('VERIFICATION','PASSWORD_RESET','INVITATION')),
      toAddress TEXT NOT NULL, subject TEXT NOT NULL, textBody TEXT, academyId TEXT, relatedId TEXT,
      status TEXT NOT NULL CHECK(status IN ('QUEUED','SENDING','SENT','FAILED','EXPIRED','CANCELLED')),
      attempts INTEGER NOT NULL DEFAULT 0, nextAttemptAt TEXT NOT NULL, leaseUntil TEXT, lastError TEXT,
      providerMessageId TEXT, createdAt TEXT NOT NULL, expiresAt TEXT NOT NULL, finishedAt TEXT);
      INSERT INTO email_outbox(id,purpose,toAddress,subject,textBody,status,nextAttemptAt,createdAt,expiresAt,providerMessageId)
      VALUES('old-1','INVITATION','a@example.de','Subject','Body','QUEUED','2026-01-01','2026-01-01','2999-01-01','prov-1');`);
    migrateEmailDelivery(old);
    expect(old.prepare("SELECT id,purpose,textBody,providerMessageId,deliveryStatus,htmlBody FROM email_outbox").all()).toEqual([
      { id: "old-1", purpose: "INVITATION", textBody: "Body", providerMessageId: "prov-1", deliveryStatus: null, htmlBody: null },
    ]);
    expect(() =>
      old.exec(
        `INSERT INTO email_outbox(id,purpose,toAddress,subject,status,nextAttemptAt,createdAt,expiresAt) VALUES('n','PAYMENT_RECEIPT','b@example.com','S','QUEUED','x','x','x')`,
      ),
    ).not.toThrow();
    expect(() =>
      old.exec(
        `INSERT INTO email_outbox(id,purpose,toAddress,subject,status,nextAttemptAt,createdAt,expiresAt) VALUES('m','NOT_A_KIND','b@example.com','S','QUEUED','x','x','x')`,
      ),
    ).toThrow();
    migrateEmailDelivery(old); // second run changes nothing
    expect(old.prepare("SELECT COUNT(*) n FROM email_outbox").get()!.n).toBe(2);
    for (const table of ["email_events", "email_suppressions"])
      expect(old.prepare("SELECT name FROM sqlite_master WHERE name=?").get(table)).toBeTruthy();
    old.close();
  });
});
