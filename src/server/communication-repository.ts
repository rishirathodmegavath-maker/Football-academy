import "server-only";
import type {
  CommunicationSettings,
  GuardianContact,
  DeliveryJob,
  DeliveryJobRow,
  DeliveryState,
} from "@/domain/communication";
import { database } from "./database";
export const communicationRepository = {
  settings(academyId: string): CommunicationSettings | undefined {
    const r = database()
      .prepare("SELECT body FROM communication_settings WHERE academyId=?")
      .get(academyId);
    return r ? JSON.parse(String(r.body)) : undefined;
  },
  saveSettings(s: CommunicationSettings) {
    database()
      .prepare(
        "INSERT INTO communication_settings VALUES(?,?) ON CONFLICT(academyId) DO UPDATE SET body=excluded.body",
      )
      .run(s.academyId, JSON.stringify(s));
  },
  contact(academyId: string, guardianId: string): GuardianContact | undefined {
    const r = database()
      .prepare(
        "SELECT body FROM guardian_contacts WHERE academyId=? AND guardianId=?",
      )
      .get(academyId, guardianId);
    return r ? JSON.parse(String(r.body)) : undefined;
  },
  saveContact(c: GuardianContact) {
    database()
      .prepare(
        "INSERT INTO guardian_contacts VALUES(?,?,?,?) ON CONFLICT(academyId,guardianId) DO UPDATE SET phone=excluded.phone,body=excluded.body",
      )
      .run(c.academyId, c.guardianId, c.phone, JSON.stringify(c));
  },
  jobs(academyId: string): DeliveryJob[] {
    return database()
      .prepare(
        "SELECT * FROM delivery_jobs WHERE academyId=? ORDER BY dueAt DESC",
      )
      .all(academyId) as unknown as DeliveryJob[];
  },
  /**
   * One page of an academy's person-addressed delivery jobs (not announcements),
   * newest first or oldest first by (dueAt, id), read by keyset so a page costs
   * the same however many jobs exist and jobs arriving between two requests can
   * neither repeat nor skip a row. Returns up to `limit + 1` rows; the caller
   * trims the extra one and turns it into the next cursor.
   *
   * `playerIds` restricts to those players (null: every player of the academy),
   * `guardianId` to one guardian. `match` narrows by free text: the players and
   * guardians already resolved from the search words, plus the same words
   * against the period and the reason.
   */
  jobsPage(
    academyId: string,
    q: {
      playerIds: string[] | null;
      guardianId?: string;
      state?: DeliveryState;
      type?: DeliveryJob["type"];
      match?: { playerIds: string[]; guardianIds: string[]; like: string };
      order: "newest" | "oldest";
      after?: { dueAt: string; id: string };
      limit: number;
    },
  ): DeliveryJobRow[] {
    const where = ["academyId=?", "playerId<>''"],
      args: (string | number)[] = [academyId],
      newest = q.order === "newest";
    if (q.playerIds) {
      where.push("playerId IN (SELECT value FROM json_each(?))");
      args.push(JSON.stringify(q.playerIds));
    }
    if (q.guardianId) {
      where.push("guardianId=?");
      args.push(q.guardianId);
    }
    if (q.state) {
      where.push("state=?");
      args.push(q.state);
    }
    if (q.type) {
      where.push("type=?");
      args.push(q.type);
    }
    if (q.match) {
      where.push(
        "(playerId IN (SELECT value FROM json_each(?)) OR guardianId IN (SELECT value FROM json_each(?)) OR period LIKE ? ESCAPE '\\' OR reason LIKE ? ESCAPE '\\')",
      );
      args.push(
        JSON.stringify(q.match.playerIds),
        JSON.stringify(q.match.guardianIds),
        q.match.like,
        q.match.like,
      );
    }
    if (q.after) {
      where.push(`(dueAt,id) ${newest ? "<" : ">"} (?,?)`);
      args.push(q.after.dueAt, q.after.id);
    }
    return database()
      .prepare(
        `SELECT id,playerId,guardianId,type,sourceId,period,correction,dueAt,state,attempts,reason FROM delivery_jobs WHERE ${where.join(" AND ")} ORDER BY dueAt ${newest ? "DESC" : "ASC"}, id ${newest ? "DESC" : "ASC"} LIMIT ?`,
      )
      .all(...args, q.limit + 1) as unknown as DeliveryJobRow[];
  },
  /** The announcement jobs of one academy (optionally of one announcement),
   * read through delivery_jobs_announcements instead of loading every job the
   * academy has ever had. */
  announcementJobs(academyId: string, sourceId?: string): DeliveryJob[] {
    return (sourceId === undefined
      ? database()
          .prepare(
            "SELECT * FROM delivery_jobs WHERE academyId=? AND type='ANNOUNCEMENT' ORDER BY dueAt DESC",
          )
          .all(academyId)
      : database()
          .prepare(
            "SELECT * FROM delivery_jobs WHERE academyId=? AND type='ANNOUNCEMENT' AND sourceId=? ORDER BY dueAt DESC",
          )
          .all(academyId, sourceId)) as unknown as DeliveryJob[];
  },
  job(id: string): DeliveryJob | undefined {
    return database()
      .prepare("SELECT * FROM delivery_jobs WHERE id=?")
      .get(id) as unknown as DeliveryJob | undefined;
  },
  setState(
    id: string,
    state: DeliveryJob["state"],
    reason: string,
    providerId?: string,
  ) {
    database()
      .prepare(
        "UPDATE delivery_jobs SET state=?,reason=?,providerId=COALESCE(?,providerId),claim=NULL,claimedAt=NULL WHERE id=?",
      )
      .run(state, reason, providerId ?? null, id);
  },
};
