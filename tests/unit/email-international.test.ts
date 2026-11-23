// Phase 7: international address handling, probed with the cases a provider
// integration meets in practice (ZeptoMail readiness, docs/EMAIL.md section 16.5).
// Complements email-global.test.ts; no message is sent.
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  checkRecipient,
  accountEmail,
  headerSafe,
} from "@/server/email/address";

describe("internationalised domains become their ASCII form", () => {
  it.each([
    ["anna@münchen.de", "anna@xn--mnchen-3ya.de"],
    ["x@例え.jp", "x@xn--r8jz45g.jp"],
    ["x@пример.рф", "x@xn--e1afmkfd.xn--p1ai"],
    ["user@faß.de", "user@xn--fa-hia.de"],
    ["a@éxample.com", "a@xn--xample-9ua.com"],
    ["a@x.xn--p1ai", "a@x.xn--p1ai"],
    ["A.B+tag@Example.COM", "A.B+tag@example.com"],
  ])("%s -> %s", (input, ascii) => {
    const r = checkRecipient(input);
    expect(r.ok && r.ascii).toBe(ascii);
  });
  it("gives a sign-in account only for an address that is ASCII once the domain is converted", () => {
    expect(accountEmail("anna@münchen.de")).toBe("anna@xn--mnchen-3ya.de");
    expect(accountEmail("A.B+tag@Example.COM")).toBe("a.b+tag@example.com");
    for (const unicodeLocal of [
      "josé@example.es",
      "名前@example.jp",
      "उदाहरण@परीक्षा.भारत",
    ]) {
      expect(checkRecipient(unicodeLocal).ok, unicodeLocal).toBe(true);
      expect(accountEmail(unicodeLocal), unicodeLocal).toBeNull();
    }
  });
});

describe("addresses no provider could deliver are refused before anything is sent", () => {
  it.each([
    "a@b.com.",
    "a@b..com",
    "a@-b.com",
    "a@b-.com",
    "a@b_c.com",
    "a@xn--.com",
    "a@xn--zz.com",
    "a@localhost",
    "a@1.2.3.4",
    "a@[127.0.0.1]",
    `a@${"x".repeat(64)}.com`,
    `a@${("x".repeat(60) + ".").repeat(5)}com`,
    "a@a‮b.com",
    '"quoted"@x.com',
    "a b@x.com",
    "..a@x.com",
    "a..b@x.com",
    ".a@x.com",
    "a.@x.com",
    "a@x.com\r\nBcc: victim@example.com",
    "a@x.com,b@y.com",
    "<a@x.com>",
  ])("refuses %j", (address) => {
    expect(checkRecipient(address).ok).toBe(false);
  });
});

describe("headers cannot be split by a name", () => {
  it("replaces every line break and control character", () => {
    const controls = [
      "\r",
      "\n",
      String.fromCharCode(0x2028),
      String.fromCharCode(0),
    ];
    const out = headerSafe(`Anna${controls.join("")}Bcc: victim@example.com`);
    for (const c of controls) expect(out).not.toContain(c);
    expect(out.startsWith("Anna")).toBe(true);
  });
  it("keeps names in any script", () => {
    expect(headerSafe("  Zoë 李小龍 Ñandú  ")).toBe("Zoë 李小龍 Ñandú");
  });
});
