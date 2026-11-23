// Consistent, verified, encrypted, off-server database backups and restores.
// Node built-ins only, so it runs even when the application cannot start.
//
//   createBackup   online snapshot -> verify -> gzip -> encrypt -> round-trip
//                  verify -> store -> upload -> prune
//   verifyArtifact decrypt + decompress + hash + integrity check
//   restoreBackup  verify, then write to a NEW path; never to the live database
//
// Nothing here prints or stores a key. Manifests hold names, sizes, hashes and
// row counts, never record contents.
import { DatabaseSync } from "node:sqlite";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { execFile } from "node:child_process";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

export const MAGIC = Buffer.from("SZBK1");
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const NAME_PATTERN =
  /^sportozen-(\d{8}T\d{6}Z)-([a-z0-9-]{1,40})\.sqlite\.gz(\.enc)?$/;
const STALE_LOCK_MS = 6 * 60 * 60 * 1000;
const PROTECT_LABELLED_DAYS = 14;

// ---------------------------------------------------------------- helpers
const inside = (parent, child) => {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};
const same = (a, b) =>
  process.platform === "win32"
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
    : resolve(a) === resolve(b);
export const stamp = (date) =>
  date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
const parseStamp = (value) =>
  new Date(
    `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`,
  );
export function redact(text, secrets) {
  let out = String(text);
  for (const secret of secrets)
    if (secret && secret.length >= 8)
      out = out.split(secret).join("[redacted]");
  return out;
}
export async function sha256File(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}
const privateDir = (path) => mkdirSync(path, { recursive: true, mode: 0o700 });
const restrict = (path) => {
  if (process.platform !== "win32") chmodSync(path, 0o600);
};
const remove = (path) =>
  rmSync(path, {
    force: true,
    recursive: true,
    maxRetries: 5,
    retryDelay: 100,
  });

// ---------------------------------------------------------------- config
/** Throws an Error with a plain message on any unsafe or malformed setting. */
export function loadBackupConfig(env, { cwd = process.cwd() } = {}) {
  const need = (name) => {
    const value = env[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };
  const database = need("SPORTOZEN_DATABASE_PATH");
  const directory = need("SPORTOZEN_BACKUP_DIR");
  if (!isAbsolute(database))
    throw new Error("SPORTOZEN_DATABASE_PATH must be absolute");
  if (!isAbsolute(directory))
    throw new Error("SPORTOZEN_BACKUP_DIR must be absolute");
  if (inside(cwd, directory))
    throw new Error(
      "SPORTOZEN_BACKUP_DIR must be outside the application directory",
    );
  if (inside(dirname(database), directory) || inside(directory, database))
    throw new Error(
      "SPORTOZEN_BACKUP_DIR must not overlap the database directory",
    );
  const integer = (name, fallback, min = 0) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    if (!/^\d+$/.test(raw) || Number(raw) < min)
      throw new Error(`${name} must be an integer of at least ${min}`);
    return Number(raw);
  };
  const retention = {
    hourly: integer("SPORTOZEN_BACKUP_KEEP_HOURLY", 24, 1),
    daily: integer("SPORTOZEN_BACKUP_KEEP_DAILY", 30),
    monthly: integer("SPORTOZEN_BACKUP_KEEP_MONTHLY", 12),
  };
  let key = null;
  if (env.SPORTOZEN_BACKUP_ENCRYPTION_KEY) {
    key = Buffer.from(env.SPORTOZEN_BACKUP_ENCRYPTION_KEY, "base64");
    if (key.length !== 32)
      throw new Error(
        "SPORTOZEN_BACKUP_ENCRYPTION_KEY must be 32 random bytes, base64 encoded",
      );
  } else if (env.SPORTOZEN_BACKUP_ALLOW_UNENCRYPTED !== "1")
    throw new Error(
      "refusing to write unencrypted backups of children's data: set SPORTOZEN_BACKUP_ENCRYPTION_KEY (or SPORTOZEN_BACKUP_ALLOW_UNENCRYPTED=1 for a local test)",
    );
  const targetDir = env.SPORTOZEN_BACKUP_TARGET_DIR || null;
  if (targetDir) {
    if (!isAbsolute(targetDir))
      throw new Error("SPORTOZEN_BACKUP_TARGET_DIR must be absolute");
    if (
      inside(cwd, targetDir) ||
      inside(dirname(database), targetDir) ||
      inside(directory, targetDir) ||
      inside(targetDir, directory)
    )
      throw new Error(
        "SPORTOZEN_BACKUP_TARGET_DIR must be separate from the application, database and staging directories",
      );
  }
  let targetCommand = null;
  if (env.SPORTOZEN_BACKUP_TARGET_COMMAND) {
    try {
      targetCommand = JSON.parse(env.SPORTOZEN_BACKUP_TARGET_COMMAND);
    } catch {
      targetCommand = null;
    }
    if (
      !Array.isArray(targetCommand) ||
      targetCommand.length === 0 ||
      !targetCommand.every((part) => typeof part === "string" && part)
    )
      throw new Error(
        'SPORTOZEN_BACKUP_TARGET_COMMAND must be a JSON array of strings, e.g. ["rclone","copyto","{file}","remote:bucket/{name}"]',
      );
    if (!targetCommand.some((part) => part.includes("{file}")))
      throw new Error("SPORTOZEN_BACKUP_TARGET_COMMAND must contain {file}");
  }
  if (targetDir && targetCommand)
    throw new Error(
      "set only one of SPORTOZEN_BACKUP_TARGET_DIR and SPORTOZEN_BACKUP_TARGET_COMMAND",
    );
  return {
    database: resolve(database),
    directory: resolve(directory),
    targetDir: targetDir ? resolve(targetDir) : null,
    targetCommand,
    key,
    retention,
    rpoMinutes: integer("SPORTOZEN_BACKUP_RPO_MINUTES", null, 1),
    rtoMinutes: integer("SPORTOZEN_BACKUP_RTO_MINUTES", null, 1),
    secrets: [
      env.SPORTOZEN_BACKUP_ENCRYPTION_KEY,
      env.BETTER_AUTH_SECRET,
    ].filter(Boolean),
  };
}
export const keyFingerprint = (key) =>
  key ? createHash("sha256").update(key).digest("hex").slice(0, 8) : null;

// ---------------------------------------------------------------- streams
async function* encryptChunks(source, key) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(MAGIC);
  yield MAGIC;
  yield iv;
  for await (const chunk of source) {
    const out = cipher.update(chunk);
    if (out.length) yield out;
  }
  const last = cipher.final();
  if (last.length) yield last;
  yield cipher.getAuthTag();
}
/** Gzip then (optionally) encrypt `plain` into `artifact`. */
async function pack(plain, artifact, key) {
  const gzip = createReadStream(plain).pipe(createGzip({ level: 6 }));
  if (!key) return pipeline(gzip, createWriteStream(artifact, { mode: 0o600 }));
  return pipeline(
    encryptChunks(gzip, key),
    createWriteStream(artifact, { mode: 0o600 }),
  );
}
/** Decrypt (when needed) and decompress `artifact` into `plain`. Throws on a
 * wrong key, tampering or truncation; the caller discards `plain` then. */
async function unpack(artifact, plain, key, encrypted) {
  let input;
  if (encrypted) {
    if (!key) throw new Error("the backup is encrypted; a key is required");
    const size = statSync(artifact).size;
    if (size < MAGIC.length + IV_BYTES + TAG_BYTES)
      throw new Error("backup file is truncated");
    const head = Buffer.alloc(MAGIC.length + IV_BYTES);
    const tag = Buffer.alloc(TAG_BYTES);
    const fd = openSync(artifact, "r");
    try {
      readSync(fd, head, 0, head.length, 0);
      readSync(fd, tag, 0, TAG_BYTES, size - TAG_BYTES);
    } finally {
      closeSync(fd);
    }
    if (!head.subarray(0, MAGIC.length).equals(MAGIC))
      throw new Error("not a Sportozen backup");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      head.subarray(MAGIC.length),
    );
    decipher.setAAD(MAGIC);
    decipher.setAuthTag(tag);
    input = createReadStream(artifact, {
      start: head.length,
      end: size - TAG_BYTES - 1,
    }).pipe(decipher);
  } else input = createReadStream(artifact);
  await pipeline(
    input,
    createGunzip(),
    createWriteStream(plain, { mode: 0o600 }),
  );
}

// ---------------------------------------------------------------- database facts
/** @returns {Record<string, number>} */
function tableCounts(db) {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => String(row.name));
  const counts = {};
  for (const name of tables)
    counts[name] = Number(
      db.prepare(`SELECT COUNT(*) n FROM "${name.replaceAll('"', '""')}"`).get()
        .n,
    );
  return counts;
}
/** Opens read-only; returns what a restore must be able to rely on. */
export function inspectDatabase(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=5000");
    const integrity = db
      .prepare("PRAGMA integrity_check")
      .all()
      .map((r) => String(r.integrity_check));
    const foreignKeyViolations = db
      .prepare("PRAGMA foreign_key_check")
      .all().length;
    return {
      integrityOk: integrity.length === 1 && integrity[0] === "ok",
      integrity: integrity.slice(0, 5),
      foreignKeyViolations,
      userVersion: Number(db.prepare("PRAGMA user_version").get().user_version),
      counts: tableCounts(db),
    };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------- retention
/**
 * Which backups to keep. The newest `hourly`, the newest of each of the latest
 * `daily` UTC days and `monthly` UTC months that have a backup, anything that
 * is not a scheduled backup (for example pre-deploy) for 14 days, and always
 * the single newest. Pure: no files are touched.
 */
export function selectRetained(entries, now, retention) {
  const sorted = [...entries].sort((a, b) => b.createdAt - a.createdAt);
  const keep = new Set();
  if (sorted[0]) keep.add(sorted[0].name);
  sorted.slice(0, retention.hourly).forEach((e) => keep.add(e.name));
  const newestPer = (limit, key) => {
    const seen = new Set();
    for (const entry of sorted) {
      const bucket = key(entry.createdAt);
      if (seen.has(bucket)) continue;
      if (seen.size >= limit) break;
      seen.add(bucket);
      keep.add(entry.name);
    }
  };
  newestPer(retention.daily, (d) => d.toISOString().slice(0, 10));
  newestPer(retention.monthly, (d) => d.toISOString().slice(0, 7));
  for (const entry of sorted)
    if (
      entry.label !== "scheduled" &&
      now - entry.createdAt < PROTECT_LABELLED_DAYS * 86_400_000
    )
      keep.add(entry.name);
  return { keep, remove: sorted.filter((e) => !keep.has(e.name)) };
}
/** Backups in `directory` that have BOTH a well-formed artifact and manifest. */
export function listBackups(directory) {
  if (!existsSync(directory)) return [];
  const names = new Set(readdirSync(directory));
  const out = [];
  for (const name of names) {
    const match = NAME_PATTERN.exec(name);
    if (!match || !names.has(`${name}.json`)) continue;
    out.push({
      name,
      createdAt: parseStamp(match[1]),
      label: match[2],
      encrypted: Boolean(match[3]),
    });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}
function prune(directory, now, retention, log) {
  const entries = listBackups(directory);
  const { remove: doomed } = selectRetained(entries, now, retention);
  for (const entry of doomed) {
    // Manifest first: an artifact without a manifest is invisible to listBackups.
    remove(join(directory, `${entry.name}.json`));
    remove(join(directory, entry.name));
    log(`pruned ${entry.name}`);
  }
  return doomed.map((e) => e.name);
}

// ---------------------------------------------------------------- lock + status
function acquireLock(directory, now) {
  const path = join(directory, ".backup.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(
        fd,
        JSON.stringify({ pid: process.pid, at: new Date(now).toISOString() }),
      );
      closeSync(fd);
      return () => remove(path);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (now - statSync(path).mtimeMs > STALE_LOCK_MS) remove(path);
      else throw new Error("another backup is already running");
    }
  }
  throw new Error("could not take the backup lock");
}
const statusPath = (directory) => join(directory, "status.json");
export function readStatus(directory) {
  try {
    return JSON.parse(readFileSync(statusPath(directory), "utf8"));
  } catch {
    return {};
  }
}
function writeStatus(directory, patch) {
  const next = { ...readStatus(directory), ...patch };
  const temporary = `${statusPath(directory)}.tmp`;
  writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
  renameSync(temporary, statusPath(directory));
}

// ---------------------------------------------------------------- verify
/**
 * Proves an artifact can be restored: hash matches its manifest, it decrypts
 * and decompresses, the database passes integrity_check, and the schema
 * version and per-table row counts match what was recorded at backup time.
 * Writes the restored database to `output` and leaves it there when ok.
 */
export async function verifyArtifact({ artifact, key, output }) {
  const problems = [];
  const manifestPath = `${artifact}.json`;
  if (!existsSync(artifact))
    return { ok: false, problems: ["backup file not found"] };
  if (!existsSync(manifestPath))
    return { ok: false, problems: ["manifest not found"] };
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return { ok: false, problems: ["manifest is not valid JSON"] };
  }
  if ((await sha256File(artifact)) !== manifest.artifactSha256) {
    return {
      ok: false,
      manifest,
      problems: [
        "backup file hash does not match its manifest (corrupt or altered)",
      ],
    };
  }
  try {
    await unpack(artifact, output, key, manifest.encrypted);
  } catch (error) {
    remove(output);
    const reason = /authenticate|unsupported state/i.test(String(error.message))
      ? "decryption failed: wrong key or the file was altered"
      : error.message;
    return { ok: false, manifest, problems: [reason] };
  }
  if ((await sha256File(output)) !== manifest.plainSha256)
    problems.push("restored database hash differs from the manifest");
  let facts;
  try {
    facts = inspectDatabase(output);
  } catch (error) {
    problems.push(`database cannot be opened: ${error.message}`);
  }
  if (facts) {
    if (!facts.integrityOk)
      problems.push(`integrity_check failed: ${facts.integrity.join("; ")}`);
    if (facts.userVersion !== manifest.userVersion)
      problems.push("schema version differs from the manifest");
    for (const [table, count] of Object.entries(manifest.counts))
      if (facts.counts[table] !== count)
        problems.push(
          `table ${table}: ${facts.counts[table] ?? "missing"} rows, expected ${count}`,
        );
    for (const table of Object.keys(facts.counts))
      if (!(table in manifest.counts))
        problems.push(`unexpected table ${table}`);
  }
  if (problems.length) remove(output);
  return { ok: problems.length === 0, manifest, facts, problems };
}

// ---------------------------------------------------------------- upload
function run(argv, secrets, timeoutMs = 30 * 60_000) {
  return new Promise((resolvePromise) => {
    execFile(
      argv[0],
      argv.slice(1),
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) =>
        resolvePromise({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          output: redact(`${stdout}\n${stderr}`, secrets).trim().slice(0, 500),
        }),
    );
  });
}
async function upload(config, artifact, manifest, log) {
  const files = [artifact, manifest]; // manifest last: its presence marks a complete backup
  if (config.targetDir) {
    privateDir(config.targetDir);
    for (const file of files) {
      const destination = join(config.targetDir, basename(file));
      const partial = `${destination}.partial`;
      copyFileSync(file, partial);
      restrict(partial);
      if ((await sha256File(partial)) !== (await sha256File(file))) {
        remove(partial);
        throw new Error(
          `copy of ${basename(file)} to the target does not match the original`,
        );
      }
      renameSync(partial, destination);
    }
    return "directory";
  }
  if (config.targetCommand) {
    for (const file of files) {
      const argv = config.targetCommand.map((part) =>
        part.replaceAll("{file}", file).replaceAll("{name}", basename(file)),
      );
      const result = await run(argv, config.secrets);
      if (result.code !== 0)
        throw new Error(
          `upload command failed for ${basename(file)} (exit ${result.code}): ${result.output}`,
        );
      log(`uploaded ${basename(file)}`);
    }
    return "command";
  }
  return null;
}

// ---------------------------------------------------------------- create
/**
 * Takes a backup. Returns { name, uploaded, bytes, ... }. Throws on any
 * failure after recording it in status.json; a failed backup leaves no
 * partial files in the backup directory.
 */
export async function createBackup({
  config,
  label = "scheduled",
  now = Date.now(),
  log = () => {},
  upload: doUpload = true,
}) {
  if (!/^[a-z0-9-]{1,40}$/.test(label))
    throw new Error("label must be 1-40 lowercase letters, digits or hyphens");
  if (!existsSync(config.database))
    throw new Error("the database file does not exist");
  privateDir(config.directory);
  const release = acquireLock(config.directory, now);
  const started = Date.now();
  const work = join(
    config.directory,
    `.work-${process.pid}-${stamp(new Date(now))}`,
  );
  let stage = "start";
  try {
    privateDir(work);
    const plain = join(work, "snapshot.sqlite");
    stage = "snapshot";
    // VACUUM INTO reads one consistent snapshot inside a single read
    // transaction, so it completes however busy the application is. (The
    // incremental backup API restarts whenever another connection writes.)
    // WAL readers do not block the application's writers.
    const source = new DatabaseSync(config.database, { readOnly: true });
    try {
      source.exec("PRAGMA busy_timeout=10000");
      source.prepare("VACUUM INTO ?").run(plain);
    } finally {
      source.close();
    }
    stage = "inspect";
    const facts = inspectDatabase(plain);
    if (!facts.integrityOk)
      throw new Error(
        `the snapshot failed integrity_check: ${facts.integrity.join("; ")}`,
      );
    const created = new Date(now);
    const name = `sportozen-${stamp(created)}-${label}.sqlite.gz${config.key ? ".enc" : ""}`;
    const artifact = join(work, name);
    stage = "pack";
    const plainSha256 = await sha256File(plain);
    await pack(plain, artifact, config.key);
    const manifest = {
      format: 1,
      name,
      createdAt: created.toISOString(),
      label,
      encrypted: Boolean(config.key),
      keyFingerprint: keyFingerprint(config.key),
      plainSha256,
      artifactSha256: await sha256File(artifact),
      plainBytes: statSync(plain).size,
      artifactBytes: statSync(artifact).size,
      userVersion: facts.userVersion,
      foreignKeyViolations: facts.foreignKeyViolations,
      counts: facts.counts,
      node: process.version,
      sqlite: new DatabaseSync(":memory:")
        .prepare("SELECT sqlite_version() v")
        .get().v,
    };
    writeFileSync(`${artifact}.json`, JSON.stringify(manifest, null, 2), {
      mode: 0o600,
    });
    stage = "verify";
    const check = await verifyArtifact({
      artifact,
      key: config.key,
      output: join(work, "roundtrip.sqlite"),
    });
    if (!check.ok)
      throw new Error(
        `round-trip verification failed: ${check.problems.join("; ")}`,
      );
    remove(plain);
    remove(join(work, "roundtrip.sqlite"));
    stage = "store";
    renameSync(artifact, join(config.directory, name));
    renameSync(`${artifact}.json`, join(config.directory, `${name}.json`)); // manifest last
    log(
      `stored ${name} (${manifest.artifactBytes} bytes, verified by restoring it)`,
    );
    let uploaded = null,
      uploadError = null;
    if (doUpload) {
      stage = "upload";
      try {
        uploaded = await upload(
          config,
          join(config.directory, name),
          join(config.directory, `${name}.json`),
          log,
        );
        log(
          uploaded
            ? `uploaded to the ${uploaded} target`
            : "no off-server target configured; this backup exists only on this server",
        );
      } catch (error) {
        uploadError = error;
      }
    }
    stage = "prune";
    const pruned = prune(config.directory, now, config.retention, log);
    if (uploaded === "directory")
      prune(config.targetDir, now, config.retention, log);
    // A stored but not uploaded backup is still recorded, as NOT off-server.
    writeStatus(config.directory, {
      lastSuccess: {
        at: created.toISOString(),
        name,
        label,
        bytes: manifest.artifactBytes,
        encrypted: manifest.encrypted,
        offServer: Boolean(uploaded),
        target: uploaded,
        durationMs: Date.now() - started,
      },
      ...(uploaded
        ? { lastOffServer: { at: created.toISOString(), name } }
        : {}),
    });
    if (uploadError) {
      stage = "upload";
      throw uploadError;
    }
    return {
      name,
      manifest,
      uploaded,
      pruned,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    const message = redact(error.message, config.secrets).slice(0, 500);
    try {
      writeStatus(config.directory, {
        lastFailure: { at: new Date().toISOString(), stage, message },
      });
    } catch {
      // The status file is advisory.
    }
    const failure = new Error(`backup failed during ${stage}: ${message}`);
    failure.stage = stage;
    throw failure;
  } finally {
    remove(work);
    release();
  }
}

// ---------------------------------------------------------------- restore
/**
 * Restores `artifact` to `target`, a path that must not exist and must not be
 * the live database. The target only appears (atomically) once the restored
 * file has passed every check. Cutting over to it is a separate, manual step.
 */
/**
 * @param {{ artifact: string, key: Buffer | null, target: string, liveDatabase?: string }} options
 */
export async function restoreBackup({ artifact, key, target, liveDatabase }) {
  const started = Date.now();
  if (!isAbsolute(target))
    throw new Error("the restore target must be an absolute path");
  if (liveDatabase && same(target, liveDatabase))
    throw new Error(
      "refusing to restore over the live database; restore to a new path, verify it, then switch over (docs/BACKUP_AND_RECOVERY.md)",
    );
  for (const suffix of ["", "-wal", "-shm"])
    if (existsSync(target + suffix))
      throw new Error(`${target + suffix} already exists; choose a new path`);
  privateDir(dirname(target));
  const partial = `${target}.restoring`;
  remove(partial);
  const result = await verifyArtifact({ artifact, key, output: partial });
  if (!result.ok) {
    remove(partial);
    return {
      ok: false,
      problems: result.problems,
      manifest: result.manifest,
      durationMs: Date.now() - started,
    };
  }
  restrict(partial);
  renameSync(partial, target);
  return {
    ok: true,
    problems: [],
    manifest: result.manifest,
    facts: result.facts,
    target,
    durationMs: Date.now() - started,
  };
}
/** Restore into a throwaway directory, verify, report the time taken, delete. */
export async function rehearseRestore({ artifact, key, scratch }) {
  const directory = join(
    scratch,
    `rehearsal-${randomBytes(4).toString("hex")}`,
  );
  privateDir(directory);
  try {
    return await restoreBackup({
      artifact,
      key,
      target: join(directory, "restored.sqlite"),
    });
  } finally {
    remove(directory);
  }
}
export function latestBackup(directory) {
  const [latest] = listBackups(directory);
  return latest ? join(directory, latest.name) : null;
}
