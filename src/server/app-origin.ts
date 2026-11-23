import "server-only";

type Env = Record<string, string | undefined>;

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
export const isLoopbackHost = (hostname: string) =>
  LOOPBACK_HOSTS.includes(hostname.toLowerCase());

/**
 * The public address of this deployment. BETTER_AUTH_URL when set (required,
 * and https, for every real deployment: see auth.ts). Without it the
 * application is a local one, and a local server learns its own port from
 * Next.js (PORT) instead of assuming 3000, so `next dev --port 3005` and
 * `next start -p 3005` are trusted without any setting.
 */
export function configuredBaseUrl(env: Env = process.env): string {
  if (env.BETTER_AUTH_URL) return env.BETTER_AUTH_URL;
  const port = /^\d{2,5}$/.test(env.PORT ?? "") ? env.PORT : "3000";
  return `http://127.0.0.1:${port}`;
}
export const publicOrigin = (env: Env = process.env) =>
  new URL(configuredBaseUrl(env)).origin;
export const isLocalDeployment = (env: Env = process.env) =>
  isLoopbackHost(new URL(configuredBaseUrl(env)).hostname);

/** One configured extra origin: scheme, host and port only. No wildcard, no path. */
function exactOrigin(value: string): string {
  if (/[*?]/.test(value))
    throw new Error(
      `BETTER_AUTH_TRUSTED_ORIGINS: wildcards are not allowed ("${value}"); list each origin exactly.`,
    );
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`BETTER_AUTH_TRUSTED_ORIGINS: "${value}" is not a URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error(
      `BETTER_AUTH_TRUSTED_ORIGINS: "${value}" must start with http:// or https://.`,
    );
  if (url.origin !== value.trim().replace(/\/$/, "").toLowerCase())
    throw new Error(
      `BETTER_AUTH_TRUSTED_ORIGINS: "${value}" must be an origin only (scheme, host and port, no path).`,
    );
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname))
    throw new Error(
      `BETTER_AUTH_TRUSTED_ORIGINS: "${value}" must use https; plain http is only for localhost.`,
    );
  return url.origin;
}

/**
 * The exact origins a browser may send. Always the public origin. In
 * development against a loopback address, the other loopback names for the same
 * scheme and port (so localhost, 127.0.0.1 and [::1] all work for the one
 * server): never in production, never for a public host. Anything else comes
 * only from BETTER_AUTH_TRUSTED_ORIGINS, a comma-separated list that is
 * validated here, because Better Auth reads the same variable without checking
 * it. Throws on an invalid entry rather than ignoring it.
 */
export function trustedOrigins(env: Env = process.env): string[] {
  const base = new URL(configuredBaseUrl(env));
  const origins = new Set([base.origin]);
  if (isLoopbackHost(base.hostname) && env.NODE_ENV !== "production")
    for (const host of LOOPBACK_HOSTS)
      origins.add(`${base.protocol}//${host}${base.port ? `:${base.port}` : ""}`);
  for (const entry of (env.BETTER_AUTH_TRUSTED_ORIGINS ?? "").split(",")) {
    if (entry.trim()) origins.add(exactOrigin(entry.trim()));
  }
  return [...origins];
}
export const isTrustedOrigin = (
  origin: string | null | undefined,
  env: Env = process.env,
) => !!origin && trustedOrigins(env).includes(origin);
