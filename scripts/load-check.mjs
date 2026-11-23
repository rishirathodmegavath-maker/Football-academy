// Usage: node scripts/load-check.mjs --base http://127.0.0.1:3000 [options]
//
// A small, dependency-free load check for a RUNNING application. It measures
// latency percentiles and counts status codes for four scenarios and prints one
// JSON report. It is a smoke-level capacity check, not a benchmark suite.
//
//   --base <url>        where the application listens (default http://127.0.0.1:3000)
//   --origin <url>      the public origin the application is configured with
//                       (BETTER_AUTH_URL; default: --base)
//   --seconds <n>       length of each timed scenario (default 15)
//   --concurrency <n>   simultaneous requests (default 20)
//   --users <n>         accounts used for reads and writes (default 10)
//   --players <n>       players created per academy before reading (default 60)
//
// WARNING: it CREATES accounts, academies and players. Point it only at a
// throw-away database (a copy, or a test server), never at production data.
// Every request carries a distinct X-Forwarded-For so the per-address sign-up
// limit of Better Auth does not hide the behaviour under test (this works only
// where that header is trusted, i.e. a test server not behind a real proxy).
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const base = option("base", "http://127.0.0.1:3000").replace(/\/$/, "");
const origin = option("origin", base).replace(/\/$/, "");
const seconds = Number(option("seconds", 15));
const concurrency = Number(option("concurrency", 20));
const userCount = Number(option("users", 10));
const playerCount = Number(option("players", 60));
let counter = 0;
const nextAddress = () =>
  `10.${(counter >> 16) & 255}.${(counter >> 8) & 255}.${(counter++ & 255) || 1}`;

async function call(method, path, { body, cookie, json = true } = {}) {
  const headers = { "x-forwarded-for": nextAddress() };
  if (method !== "GET") {
    headers["content-type"] = "application/json";
    headers.origin = origin;
  }
  if (cookie) headers.cookie = cookie;
  const started = performance.now();
  let status = 0,
    setCookie = [],
    data = null;
  try {
    const response = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    status = response.status;
    setCookie = response.headers.getSetCookie();
    const text = await response.text();
    if (json) {
      try {
        data = JSON.parse(text);
      } catch {
        /* not JSON */
      }
    }
  } catch {
    status = 0; // connection failure
  }
  return {
    status,
    ms: performance.now() - started,
    data,
    cookie: setCookie.map((c) => c.split(";")[0]).join("; "),
  };
}
const percentile = (sorted, p) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null;
function summarise(name, samples, elapsedSeconds) {
  const times = samples.map((s) => s.ms).sort((a, b) => a - b);
  const statuses = {};
  for (const s of samples) statuses[s.status] = (statuses[s.status] ?? 0) + 1;
  const round = (n) => (n === null ? null : Math.round(n * 10) / 10);
  return {
    scenario: name,
    requests: samples.length,
    perSecond: Math.round(samples.length / elapsedSeconds),
    p50ms: round(percentile(times, 50)),
    p95ms: round(percentile(times, 95)),
    p99ms: round(percentile(times, 99)),
    maxMs: round(times.at(-1) ?? null),
    statuses,
  };
}
/** Runs `task` from `concurrency` workers for `seconds`, collecting every result. */
async function timed(name, task) {
  const samples = [];
  const end = Date.now() + seconds * 1000;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async (_, worker) => {
      while (Date.now() < end) samples.push(await task(worker));
    }),
  );
  return summarise(name, samples, (performance.now() - started) / 1000);
}
const PASSWORD = `Load-check-${randomUUID()}`;
async function account(label) {
  const email = `${label}-${randomUUID()}@load-check.example`;
  const up = await call("POST", "/api/auth/sign-up/email", {
    body: { name: `Load ${label}`, email, password: PASSWORD },
  });
  if (up.status !== 200) throw new Error(`sign-up failed (${up.status}); is this a test server?`);
  const academy = await call("POST", "/api/workspaces", {
    cookie: up.cookie,
    body: {
      name: `Load Academy ${label}`,
      contactEmail: "load@load-check.example",
      country: "IN",
      language: "English",
      currency: "INR",
      timezone: "Asia/Kolkata",
      dateLocale: "en-IN",
      measurementSystem: "METRIC",
      brandAccent: "#008463",
      ageGroups: ["U12"],
      demo: false,
    },
  });
  if (academy.status !== 201) throw new Error(`academy creation failed (${academy.status})`);
  return { cookie: up.cookie, userId: up.data.user.id, academyId: academy.data.id };
}
const addPlayer = (a, name) =>
  call("POST", `/api/workspaces/${a.academyId}/records/player`, {
    cookie: a.cookie,
    body: { name, coachId: a.userId, sportIds: ["football"], status: "ACTIVE", ageCategory: "U12" },
  });

const report = { base, seconds, concurrency, users: userCount, playersPerAcademy: playerCount, scenarios: [] };
console.error(`[load-check] public pages, ${concurrency} concurrent for ${seconds}s`);
report.scenarios.push(await timed("GET /api/health", () => call("GET", "/api/health", { json: false })));
report.scenarios.push(await timed("GET /sign-in (server-rendered page)", () => call("GET", "/sign-in", { json: false })));

console.error(`[load-check] creating ${userCount} accounts with ${playerCount} players each`);
const accounts = [];
for (let i = 0; i < userCount; i++) {
  const a = await account(`u${i}`);
  for (let p = 0; p < playerCount; p++) {
    const r = await addPlayer(a, `Synthetic Player ${i}-${p}`);
    if (r.status !== 201 && r.status !== 200) throw new Error(`player creation failed (${r.status}): ${JSON.stringify(r.data)}`);
  }
  accounts.push(a);
}
console.error("[load-check] authenticated reads");
report.scenarios.push(
  await timed("GET academy payload (authenticated read)", (w) => {
    const a = accounts[w % accounts.length];
    return call("GET", `/api/workspaces/${a.academyId}`, { cookie: a.cookie, json: false });
  }),
);
report.scenarios.push(
  await timed("GET player list (authenticated read)", (w) => {
    const a = accounts[w % accounts.length];
    return call("GET", `/api/workspaces/${a.academyId}/records/player`, { cookie: a.cookie, json: false });
  }),
);
console.error("[load-check] concurrent writes (one writer connection; per-user write limit applies)");
report.scenarios.push(
  await timed("POST player (authenticated write)", (w) => {
    const a = accounts[w % accounts.length];
    return addPlayer(a, `Synthetic Load ${randomUUID().slice(0, 8)}`);
  }),
);
console.error("[load-check] concurrent sign-ups");
report.scenarios.push(
  await timed("POST sign-up (password hashing + shared connection)", () =>
    call("POST", "/api/auth/sign-up/email", {
      body: { name: "Load signup", email: `s-${randomUUID()}@load-check.example`, password: PASSWORD },
      json: false,
    }),
  ),
);
console.log(JSON.stringify(report, null, 2));
