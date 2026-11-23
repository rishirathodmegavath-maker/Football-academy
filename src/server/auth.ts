import "server-only";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";
import { nextCookies } from "better-auth/next-js";
import { twoFactor } from "better-auth/plugins/two-factor";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { audit, database } from "./database";
import { accountEmail } from "./email/address";
import {
  configuredBaseUrl,
  isLocalDeployment,
  trustedOrigins,
} from "./app-origin";
import { clientIpOptions } from "./proxy-config";
import {
  accountRef,
  clearSignInFailures,
  countSignInAttempt,
  pastAbsoluteLimit,
  sessionPolicy,
} from "./account-security";
import { securityEvent } from "./security-events";
import {
  AFTER_GOOGLE_SIGN_IN,
  GOOGLE_ERROR_LANDING,
  googleGate,
  googleOAuthConfig,
} from "./google-oauth";
import { errorFields, log as writeLog } from "./log";
import {
  emailConfig,
  queuePasswordResetEmail,
  queueVerificationEmail,
  RESET_MINUTES,
  VERIFICATION_HOURS,
} from "./email";
function localSecret() {
  const dir = resolve(".local");
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, "auth-secret");
  if (!existsSync(path))
    writeFileSync(path, randomBytes(48).toString("hex"), {
      mode: 0o600,
      flag: "wx",
    });
  return readFileSync(path, "utf8");
}
// The deployment's public address, and the exact origins a browser may send
// (src/server/app-origin.ts). Without BETTER_AUTH_URL a local server follows
// its own port, so `next dev --port 3005` is trusted without any setting;
// a real deployment must set an https BETTER_AUTH_URL (checked below).
const baseURL = configuredBaseUrl();
const local = isLocalDeployment();
// Throws at start-up on a wildcard or malformed BETTER_AUTH_TRUSTED_ORIGINS.
const origins = trustedOrigins();
if (
  !local &&
  (!process.env.BETTER_AUTH_SECRET || !baseURL.startsWith("https://"))
)
  throw new Error(
    "Deployment requires HTTPS BETTER_AUTH_URL and server-side BETTER_AUTH_SECRET.",
  );
// Throws at start-up when e-mail is switched on without a transport (users would
// be locked out). With the defaults nothing below changes how accounts work.
const email = emailConfig();
// Throws at start-up on an invalid SPORTOZEN_SESSION_* value.
const session = sessionPolicy();
// Null unless GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are both set (setting
// one alone throws at start-up). With Google off nothing below changes.
const google = googleOAuthConfig();
const secret = process.env.BETTER_AUTH_SECRET ?? localSecret();
// Browsers share cookies between ports of one host: two servers on 127.0.0.1 (or a test copy next to the real one) read and
// overwrite the same "better-auth.session_token", each rejects the other's signature, and the person is signed out every time
// they switch. SPORTOZEN_COOKIE_PREFIX gives a server its own cookie name. Unset keeps the default name (nothing changes).
const cookiePrefix = process.env.SPORTOZEN_COOKIE_PREFIX?.trim() || undefined;
if (cookiePrefix && !/^[A-Za-z0-9-]{1,32}$/.test(cookiePrefix))
  throw new Error(
    "SPORTOZEN_COOKIE_PREFIX must be 1 to 32 letters, digits or hyphens.",
  );

/** The proxy-assigned id of the request being handled, for the log line. */
const requestIdOf = (ctx: { headers?: Headers | null }) =>
  ctx.headers?.get("x-request-id") ?? undefined;
const text = (value: unknown) => (typeof value === "string" ? value : "");
/** Profile fields this application never uses are not accepted at all. */
function rejectProfileAbuse(body: Record<string, unknown>) {
  if (body.name !== undefined && text(body.name).length > 100)
    throw new APIError("BAD_REQUEST", {
      message: "Use a name of 100 characters or fewer.",
    });
  if (body.image !== undefined && body.image !== null && body.image !== "")
    throw new APIError("BAD_REQUEST", {
      message: "Profile images are not supported.",
    });
}
type HookContext = {
  path?: string;
  headers?: Headers | null;
  body?: unknown;
  context: {
    returned?: unknown;
    session?: {
      session: { token: string };
      user: { id: string; twoFactorEnabled?: boolean | null };
    } | null;
    newSession?: { session: { token: string }; user: { id: string } } | null;
  };
};
/** The only fields the Google button sends. */
const SOCIAL_FIELDS = new Set(["provider", "callbackURL"]);
const hooks = {
  before: createAuthMiddleware(async (ctx) => {
    const sent = (ctx.body ?? {}) as Record<string, unknown>;
    // An address is used in its account form (lower case, internationalised
    // domain in ASCII) everywhere below and by Better Auth itself, so
    // anna@münchen.de can register, sign in and recover its password.
    const accountForm =
      typeof sent.email === "string" ? accountEmail(sent.email) : null;
    const reshaped = !!accountForm && accountForm !== sent.email;
    const body = reshaped ? { ...sent, email: accountForm } : sent;
    const withBody = reshaped ? { context: { ...ctx, body } } : undefined;
    // A session past its absolute limit is ended before any endpoint sees it,
    // so none of Better Auth's own endpoints can keep it alive.
    const token = await ctx.getSignedCookie(
      ctx.context.authCookies.sessionToken.name,
      ctx.context.secret,
    );
    if (token) {
      const row = database()
        .prepare('SELECT id,createdAt FROM "session" WHERE token=?')
        .get(token);
      if (row && pastAbsoluteLimit(String(row.createdAt)))
        database().prepare('DELETE FROM "session" WHERE id=?').run(row.id);
    }
    switch (ctx.path) {
      case "/sign-in/email": {
        const paused = countSignInAttempt(text(body.email), secret);
        if (paused) {
          if (paused.first)
            securityEvent("signin.locked", {
              requestId: requestIdOf(ctx),
              accountRef: accountRef(text(body.email), secret),
              retryAfterSeconds: paused.retryAfterSeconds,
            });
          // Same answer for every address, existing or not.
          throw new APIError(
            "TOO_MANY_REQUESTS",
            {
              message:
                "Too many sign-in attempts. Wait a few minutes and try again.",
            },
            { "Retry-After": String(paused.retryAfterSeconds) },
          );
        }
        return withBody;
      }
      case "/sign-up/email":
      case "/update-user":
        rejectProfileAbuse(body);
        return withBody;
      case "/request-password-reset":
        return withBody;
      case "/sign-in/social":
        // Only the Google button's request is understood, and only the provider
        // is taken from it: the destinations are fixed here, so a browser cannot
        // pick another redirect, ask for extra scopes, or sign in with an ID
        // token it obtained itself. Better Auth checks the Origin only for
        // requests that carry a session cookie; a sign-in start must come from
        // this application's own pages whether or not one is present.
        if (!origins.includes(ctx.headers?.get("origin") ?? ""))
          throw new APIError("FORBIDDEN", {
            message: "Start Google sign-in from the Sportozen sign-in page.",
          });
        // The replacement body below is MERGED with the one the browser sent, so
        // a stray field would survive it: anything but these two is refused.
        if (Object.keys(sent).some((key) => !SOCIAL_FIELDS.has(key)))
          throw new APIError("BAD_REQUEST", {
            message: "Use the Continue with Google button.",
          });
        if (text(body.provider) !== "google")
          throw new APIError("BAD_REQUEST", {
            message: "Only Google sign-in is available.",
          });
        return {
          context: {
            ...ctx,
            body: {
              provider: "google",
              callbackURL: AFTER_GOOGLE_SIGN_IN,
              newUserCallbackURL: AFTER_GOOGLE_SIGN_IN,
              errorCallbackURL: GOOGLE_ERROR_LANDING,
            },
          },
        };
      case "/link-social":
        // A signed-in person could otherwise attach Google to an account whose
        // address is not verified. Linking happens only when signing in with
        // Google, for an account whose own address is already verified.
        throw new APIError("FORBIDDEN", {
          message:
            "Google is linked by signing in with Google, for an account whose email address is verified.",
        });
      case "/change-password":
        // Changing the password ends every other session, whatever the client asks.
        return {
          context: { ...ctx, body: { ...body, revokeOtherSessions: true } },
        };
      case "/two-factor/verify-totp":
      case "/two-factor/verify-backup-code":
      case "/two-factor/verify-otp":
        // "Trust this device" would skip the second step for 30 days; not offered.
        return { context: { ...ctx, body: { ...body, trustDevice: false } } };
    }
  }),
  after: createAuthMiddleware(async (rawCtx) => {
    const ctx = rawCtx as unknown as HookContext;
    const body = (ctx.body ?? {}) as Record<string, unknown>,
      failed = isAPIError(ctx.context.returned),
      actor = (ctx.context.newSession ?? ctx.context.session)?.user.id;
    switch (ctx.path) {
      case "/sign-in/email": {
        const address = accountEmail(text(body.email)) ?? text(body.email),
          code = failed
            ? (ctx.context.returned as { body?: { code?: string } }).body?.code
            : undefined;
        // Bookkeeping never turns a completed sign-in into an error.
        try {
          if (code === "INVALID_EMAIL_OR_PASSWORD")
            securityEvent("signin.failed", {
              requestId: requestIdOf(ctx),
              accountRef: accountRef(address, secret),
            });
          // The attempt was counted before the password was checked; a correct
          // password (even one that then needs e-mail verification or a second
          // step) starts the count again.
          else clearSignInFailures(address, secret);
        } catch {
          // ignored on purpose
        }
        return;
      }
      case "/callback/:id": {
        // A refusal is recorded with its machine code only (never an address).
        try {
          const location =
            (
              ctx.context.returned as { headers?: Headers } | undefined
            )?.headers?.get("location") ?? "";
          const code = new URL(location, "http://local").searchParams.get(
            "error",
          );
          if (code)
            securityEvent("signin.google_refused", {
              requestId: requestIdOf(ctx),
              reason: /^[a-z_]{1,40}$/.test(code) ? code : "other",
            });
        } catch {
          // ignored on purpose
        }
        return;
      }
      case "/change-password":
        if (!failed && actor) {
          audit(null, actor, "Password changed; other sessions ended");
          securityEvent("password.changed", {
            requestId: requestIdOf(ctx),
            userId: actor,
          });
        }
        return;
      case "/revoke-other-sessions":
      case "/revoke-sessions":
        if (!failed && actor) {
          audit(null, actor, "Other sessions signed out by the account owner");
          securityEvent("session.others_revoked", {
            requestId: requestIdOf(ctx),
            userId: actor,
          });
        }
        return;
      case "/two-factor/verify-totp":
        // With a session this confirms enrolment; without one it is a sign-in.
        if (
          !failed &&
          ctx.context.session &&
          !ctx.context.session.user.twoFactorEnabled
        ) {
          // Sessions opened before the second step existed no longer count.
          database()
            .prepare('DELETE FROM "session" WHERE userId=? AND token<>?')
            .run(
              ctx.context.session.user.id,
              // Enrolling replaces the active session; keep the new one.
              (ctx.context.newSession ?? ctx.context.session).session.token,
            );
          audit(
            null,
            ctx.context.session.user.id,
            "Two-step verification turned on; other sessions ended",
          );
          securityEvent("mfa.enabled", {
            requestId: requestIdOf(ctx),
            userId: ctx.context.session.user.id,
          });
        }
        return;
      case "/two-factor/disable":
        if (!failed && actor) {
          audit(null, actor, "Two-step verification turned off");
          securityEvent("mfa.disabled", {
            requestId: requestIdOf(ctx),
            userId: actor,
          });
        }
        return;
      case "/two-factor/generate-backup-codes":
        if (!failed && actor) {
          audit(null, actor, "Two-step recovery codes regenerated");
          securityEvent("mfa.codes_regenerated", {
            requestId: requestIdOf(ctx),
            userId: actor,
          });
        }
        return;
    }
  }),
};
const authOptions = {
  database: database(),
  baseURL,
  // Exact origins only; never a wildcard. CSRF and redirect checks stay on.
  trustedOrigins: origins,
  secret,
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
    ...(email.verification === "required"
      ? { requireEmailVerification: true }
      : {}),
    ...(email.recovery
      ? {
          // Only queues a message: the response never waits for the provider,
          // so timing does not reveal whether an address has an account.
          sendResetPassword: async ({
            user,
            url,
          }: {
            user: { email: string; name?: string | null };
            url: string;
          }) => queuePasswordResetEmail(user, url),
          resetPasswordTokenExpiresIn: RESET_MINUTES * 60,
          // A password reset ends every existing session of that account.
          revokeSessionsOnPasswordReset: true,
          onPasswordReset: async ({ user }: { user: { id: string } }) =>
            audit(null, user.id, "Password reset by emailed link"),
        }
      : {}),
  },
  ...(email.verification === "required"
    ? {
        emailVerification: {
          sendVerificationEmail: async ({
            user,
            url,
          }: {
            user: { email: string; name?: string | null };
            url: string;
          }) => queueVerificationEmail(user, url),
          sendOnSignUp: true,
          // An unverified person who tries to sign in gets a fresh link.
          sendOnSignIn: true,
          autoSignInAfterVerification: false,
          expiresIn: VERIFICATION_HOURS * 3600,
          afterEmailVerification: async (user: { id: string }) =>
            audit(null, user.id, "Email address verified"),
        },
      }
    : {}),
  ...(google
    ? {
        socialProviders: {
          google: {
            clientId: google.clientId,
            clientSecret: google.clientSecret,
            // Always show Google's account chooser, so a shared computer does
            // not silently continue as whoever signed in last.
            prompt: "select_account" as const,
            includeGrantedScopes: false,
          },
        },
        // Google is linked to an existing account only when that account's own
        // address is already verified, and Google vouches for the same address.
        // No provider is trusted without that proof, and linking never marks a
        // local address as verified or touches its password.
        account: {
          accountLinking: {
            enabled: true,
            trustedProviders: [] as string[],
            requireLocalEmailVerified: true,
          },
        },
        // A callback that cannot be matched to a started sign-in (a replayed or
        // forged address) lands on the sign-in screen, not Better Auth's page.
        onAPIError: { errorURL: GOOGLE_ERROR_LANDING },
      }
    : {}),
  session: {
    expiresIn: session.expiresIn,
    ...(session.updateAge ? { updateAge: session.updateAge } : {}),
    cookieCache: { enabled: false },
  },
  // Reset, verification and sign-in challenge tokens are stored as hashes, so a
  // copy of the database (or a backup) holds nothing that can be replayed.
  verification: { storeIdentifier: "hashed" as const },
  rateLimit: {
    enabled: true,
    storage: "database" as const,
    window: 60,
    max: 60,
  },
  advanced: {
    useSecureCookies: !local,
    ipAddress: clientIpOptions(),
    ...(cookiePrefix ? { cookiePrefix } : {}),
  },
  // Better Auth's own messages go through the structured, redacting logger
  // instead of printing raw error objects.
  logger: {
    level: "warn" as const,
    log: (level: string, message: string, ...details: unknown[]) => {
      const error = details.find((d): d is Error => d instanceof Error);
      writeLog(level === "error" ? "error" : "warn", "auth.library", {
        message: String(message),
        ...(error ? errorFields(error) : {}),
      });
    },
  },
  user: { validateUserInfo: googleGate },
  databaseHooks: {
    user: {
      create: {
        after: async (user: { id: string }) =>
          audit(null, user.id, "Account created"),
      },
    },
    account: {
      create: {
        after: async (account: { userId: string; providerId: string }) => {
          if (account.providerId === "google")
            audit(null, account.userId, "Google sign-in linked to the account");
        },
      },
    },
  },
  hooks,
  plugins: [
    // Authenticator-app codes and one-time recovery codes. Enrolment is always
    // available; who MUST use it is SPORTOZEN_MFA (mfa-policy.ts).
    twoFactor({ issuer: "Sportozen Academy" }),
    nextCookies(),
  ],
};
let auth: ReturnType<typeof betterAuth<typeof authOptions>> | undefined;
let migrations: Promise<void> | undefined;
export async function authentication() {
  migrations ??= (async () => {
    const migration = await getMigrations(authOptions);
    await migration.runMigrations();
  })();
  await migrations;
  auth ??= betterAuth(authOptions);
  return auth;
}
/** The signed-in session, or null. The idle limit is Better Auth's own
 * expiry; the absolute limit is applied here (and to Better Auth's own
 * endpoints by the hook above), because renewing a session never moves its
 * creation time. */
export async function currentSession(headers: Headers) {
  const found = await (await authentication()).api.getSession({ headers });
  if (found && pastAbsoluteLimit(found.session.createdAt)) {
    database()
      .prepare('DELETE FROM "session" WHERE id=?')
      .run(found.session.id);
    return null;
  }
  return found;
}
export async function authenticatedUser(headers: Headers) {
  const found = await currentSession(headers);
  if (!found)
    throw new WorkspaceError(401, "Sign in to access academy workspaces.");
  return found.user;
}
export class WorkspaceError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Extra response headers, for example Retry-After on a 429. */
    public headers: Record<string, string> = {},
    /** Machine-readable reason a screen can act on, for example MFA_REQUIRED. */
    public code?: string,
  ) {
    super(message);
  }
}
