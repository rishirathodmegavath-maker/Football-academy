import { isIP } from "node:net";

/** The invalid entries of a comma separated list of IP addresses or CIDR ranges. */
export function invalidProxyEntries(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => {
      const [address = "", prefix, extra] = entry.split("/");
      const version = isIP(address);
      if (!version || extra !== undefined) return true;
      if (prefix === undefined) return false;
      return (
        !/^\d{1,3}$/.test(prefix) || Number(prefix) > (version === 4 ? 32 : 128)
      );
    });
}

/**
 * How Better Auth finds the client address for its sign-in limiter.
 *
 * With nothing configured only a single-valued X-Forwarded-For is trusted: the
 * supplied nginx and Caddy configurations overwrite the header with the TCP
 * peer address, so exactly one value arrives. A header with several values
 * (a client-supplied prefix) resolves to no address and shares one bucket, so
 * it cannot be used to dodge the limit.
 *
 * SPORTOZEN_TRUSTED_PROXIES lists the addresses of proxies that APPEND to the
 * header (a CDN in front of nginx): the chain is read from the right and the
 * first address that is not a listed proxy is the client.
 * SPORTOZEN_CLIENT_IP_HEADER names a header the front proxy sets itself.
 * A bad value stops start-up: Better Auth would only log a warning and carry on
 * with the wrong trust.
 */
export function clientIpOptions(
  env: Record<string, string | undefined> = process.env,
) {
  const configured = env.SPORTOZEN_TRUSTED_PROXIES?.trim() ?? "";
  const invalid = invalidProxyEntries(configured);
  if (invalid.length)
    throw new Error(
      `SPORTOZEN_TRUSTED_PROXIES has ${invalid.length} invalid entr${invalid.length === 1 ? "y" : "ies"}; use IP addresses or CIDR ranges.`,
    );
  const header = (
    env.SPORTOZEN_CLIENT_IP_HEADER?.trim() || "x-forwarded-for"
  ).toLowerCase();
  if (!/^[a-z0-9-]+$/.test(header))
    throw new Error("SPORTOZEN_CLIENT_IP_HEADER must be a single header name.");
  const trustedProxies = configured
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return {
    ipAddressHeaders: [header],
    ...(trustedProxies.length ? { trustedProxies } : {}),
  };
}
