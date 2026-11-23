// Break-glass recovery for a person who lost BOTH their authenticator and their
// recovery codes. There is intentionally no way to do this from the product: an
// operator checks the person's identity by another route first (a call to a
// known number, an owner vouching for a staff member), then runs this on the
// server. It removes the second step, ends every session of the account and
// writes an audit entry; the person signs in with their password and enrols
// again. Nothing is printed except the outcome.
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

const email = process.argv[2],
  verified = process.argv.includes("--identity-verified");
if (!email || email.startsWith("--") || !verified) {
  console.error(
    "Usage: node scripts/reset-mfa.mjs <account-email> --identity-verified\n" +
      "Run only after confirming the person's identity by another route.",
  );
  process.exit(2);
}
const db = new DatabaseSync(
  resolve(process.env.SPORTOZEN_DATABASE_PATH ?? ".local/workspaces.sqlite"),
);
// Same settings as the application: wait for the live server's write lock and
// keep the append-only protections effective for this connection.
db.exec("PRAGMA busy_timeout=5000");
db.exec("PRAGMA recursive_triggers=ON");
const user = db
  .prepare('SELECT id FROM "user" WHERE lower(email)=lower(?)')
  .get(email);
if (!user) {
  console.error("No account has that address.");
  process.exit(1);
}
db.exec("BEGIN IMMEDIATE");
try {
  db.prepare('DELETE FROM "twoFactor" WHERE userId=?').run(user.id);
  db.prepare('UPDATE "user" SET twoFactorEnabled=0 WHERE id=?').run(user.id);
  db.prepare('DELETE FROM "session" WHERE userId=?').run(user.id);
  db.prepare("INSERT INTO workspace_audit(userId,action,at) VALUES(?,?,?)").run(
    user.id,
    "Two-step verification reset by local operator after an identity check; all sessions ended",
    new Date().toISOString(),
  );
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}
console.log(
  JSON.stringify({
    level: "warn",
    event: "security",
    type: "mfa.reset_by_operator",
    userId: user.id,
    at: new Date().toISOString(),
  }),
);
console.log(
  "Two-step verification removed and all sessions ended. The person can sign in with their password and set it up again.",
);
