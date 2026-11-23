import type {
  AcademyConfiguration,
  AcademyMembership,
  WorkspacePayload,
} from "@/domain/workspace";

type SourceContext = {
  academy: Pick<AcademyConfiguration, "id">;
  membership: Pick<AcademyMembership, "role">;
  records: Pick<WorkspacePayload["records"], "player" | "weekly"> & {
    report: SourceReport[];
  };
};
/** A report, in full or as listed (a listed report names whether it has a
 * snapshot instead of carrying it). */
export interface SourceReport {
  id: string;
  playerId: string;
  academyId: string;
  sportId: string;
  status: string;
  snapshot?: unknown;
  hasSnapshot?: boolean;
}

/** Resolve only records already released by the academy/role-authorised service. */
export function portalSourceAvailable(
  data: SourceContext,
  playerId: string,
  sourceId: string,
  type: "WEEKLY" | "MONTHLY",
) {
  if (!playerId || !sourceId) return false;
  const player = data.records.player.find(
    (record) =>
      record.id === playerId &&
      record.academyId === data.academy.id &&
      record.sportIds.includes("football"),
  );
  if (!player) return false;
  const parentView = ["PARENT", "SUPPORT"].includes(data.membership.role);
  if (type === "WEEKLY") {
    const source = data.records.weekly.find(
      (record) =>
        record.id === sourceId &&
        record.playerId === player.id &&
        record.academyId === data.academy.id &&
        record.sportId === "football",
    );
    return (
      !!source &&
      (!parentView ||
        (source.status === "APPROVED" &&
          !!source.snapshot &&
          !!source.issuedAt))
    );
  }
  const source = data.records.report.find(
    (record) =>
      record.id === sourceId &&
      record.playerId === player.id &&
      record.academyId === data.academy.id &&
      record.sportId === "football",
  );
  return (
    !!source &&
    (!parentView ||
      (source.status === "Approved" &&
        (!!source.snapshot || !!source.hasSnapshot)))
  );
}
