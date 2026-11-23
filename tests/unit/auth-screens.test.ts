// The sign-in and reset screens for the e-mail features, rendered on the server
// (no browser). With the features off the sign-in screen is unchanged.
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, refresh: () => undefined }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: Record<string, unknown>) =>
    createElement("a", { href, ...rest }, children as never),
}));
vi.mock("@/lib/auth-client", () => ({ authClient: {} }));
import { SignIn } from "@/features/workspaces/sign-in";
import { ResetPassword } from "@/features/workspaces/reset-password";

const signIn = (props: Parameters<typeof SignIn>[0] = {}) =>
  renderToStaticMarkup(createElement(SignIn, props));
const reset = (props: Parameters<typeof ResetPassword>[0]) =>
  renderToStaticMarkup(createElement(ResetPassword, props));

describe("sign-in screen", () => {
  it("shows no engineering note by default and still offers 'Forgot your password?'", () => {
    // The link is always visible (it explains, instead of promising a message,
    // when e-mail delivery is not switched on for the deployment).
    const html = signIn();
    expect(html).not.toContain("Local foundation");
    expect(html).not.toContain("deployment hardening");
    expect(html).toContain("Forgot your password?");
    expect(html).toContain("Create an account");
    expect(html).toContain(">Sign in<");
    // Same with recovery switched on or verification required (the old note's two exits).
    const recovery = signIn({ recoveryAvailable: true });
    expect(recovery).toContain("Forgot your password?");
    expect(recovery).not.toContain("Local foundation");
    expect(signIn({ verificationRequired: true })).not.toContain(
      "Local foundation",
    );
  });
  it("shows the environment notice only when the server passes one (non-production)", () => {
    const notice = "Pilot environment. Please do not enter real customer information yet.";
    expect(signIn({ environmentNotice: notice })).toContain(notice);
    expect(signIn({ environmentNotice: null })).not.toContain("Pilot environment");
    // The notice no longer depends on whether e-mail features are on.
    expect(signIn({ environmentNotice: notice, recoveryAvailable: true })).toContain(notice);
    expect(signIn({ environmentNotice: notice, verificationRequired: true })).toContain(notice);
  });
  it("shows the result of following the emailed confirmation link", () => {
    expect(signIn({ landing: "verified" })).toContain(
      "Your email address is confirmed",
    );
    const bad = signIn({ landing: "invalid-link" });
    expect(bad).toContain("not valid or has expired");
    expect(bad).toContain('role="alert"');
  });
});

describe("sign-in client calls", () => {
  it("never pass callbackURL: Better Auth's client would then redirect the browser there instead of to /workspace", () => {
    // Found by the browser suite: the owner stayed on /sign-in. The emailed link's
    // landing page is set on the server (server/email), so the client needs none.
    const source = readFileSync("src/features/workspaces/sign-in.tsx", "utf8");
    expect(source).not.toMatch(/callbackURL/);
  });
});

describe("password field", () => {
  it("starts hidden, with a named show / hide button beside the label (the field stays named exactly Password)", () => {
    const html = signIn();
    expect(html).toMatch(/<input[^>]*type="password"/);
    expect(html).toContain("Show password");
    expect(html).toContain('aria-pressed="false"');
    expect(html).toMatch(
      /<button[^>]*type="button"[^>]*class="password-toggle"/,
    );
    // The button is not inside the label, so the label text is only "Password".
    expect(html).toMatch(/<label>Password<input/);
    expect(html).not.toMatch(/<label>[^]*password-toggle[^]*<\/label>/);
  });
});

describe("Continue with Google", () => {
  it("is shown above the e-mail form with an OR divider, disabled and explained until Google is configured", () => {
    const html = signIn();
    expect(html).toContain("Continue with Google");
    expect(html).toContain("Google sign-in is not switched on");
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*>[^]*Continue with Google/,
    );
    const at = (text: string) => html.indexOf(text);
    expect(at("Continue with Google")).toBeGreaterThan(-1);
    expect(at("Continue with Google")).toBeLessThan(at(">OR<"));
    expect(at(">OR<")).toBeLessThan(at("<form"));
    expect(html).toContain('role="separator"');
  });
  it("is enabled, with no 'not switched on' note, when the server says Google is configured", () => {
    const html = signIn({ googleAvailable: true });
    expect(html).not.toContain("not switched on");
    const button =
      /<button[^>]*>(?:(?!<\/button>)[^])*Continue with Google/.exec(html)![0];
    expect(button).not.toContain("disabled");
  });
  it("draws the G inline, hidden from screen readers, without loading anything from Google", () => {
    const html = signIn({ googleAvailable: true });
    expect(html).toContain('class="google-mark"');
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(html).not.toMatch(/https?:\/\/[^"' ]*google/i);
  });
  it("leaves the e-mail form, forgot-password and registration controls as they were", () => {
    const html = signIn({ googleAvailable: true });
    for (const text of [
      "Forgot your password?",
      "Create an account",
      'type="password"',
      'type="email"',
      ">Sign in<",
    ])
      expect(html).toContain(text);
    expect(html.match(/<form/g)).toHaveLength(1);
  });
  it("only starts Better Auth's social sign-in, to a fixed landing page, and never touches the secret", () => {
    const source = readFileSync(
      "src/features/workspaces/google-sign-in.tsx",
      "utf8",
    );
    expect(source).toContain("authClient.signIn.social");
    expect(source).toContain('provider: "google"');
    expect(source).toContain('const AFTER_GOOGLE = "/workspace"');
    // No other way of leaving the page, no other network call, no credentials.
    expect(source).not.toMatch(
      /window\.location|location\.href|fetch\(|window\.open/,
    );
    expect(source).not.toMatch(/process\.env|GOOGLE_CLIENT/);
    // The only value the browser supplies is "google".
    expect(source).not.toMatch(/\brole\s*:|academyId/i);
  });
  it("hands the page only whether Google is configured, never a value", () => {
    const page = readFileSync("src/app/sign-in/page.tsx", "utf8");
    expect(page).toContain("googleAvailable={googleSignInAvailable()}");
    expect(page).not.toMatch(/process\.env\.GOOGLE/);
    // The failure text on the screen comes from a fixed table, never from the address.
    expect(page).toContain("googleErrorMessage(error, {");
  });
});

describe("reset-password screen", () => {
  it("asks for the new password twice, 12 characters or more", () => {
    const html = reset({ token: "abc", linkFailed: false });
    expect(html.match(/type="password"/g)).toHaveLength(2);
    expect(html.match(/minLength="12"/g)).toHaveLength(2);
    expect(html).toContain("Change password");
    expect(html).not.toContain("abc"); // the token is never rendered
  });
  it("explains an invalid link and offers no form", () => {
    const html = reset({ token: "", linkFailed: true });
    expect(html).toContain("not valid or has expired");
    expect(html).not.toContain('type="password"');
    expect(html).toContain('href="/sign-in"');
  });
});
