import { loadFictionalExample } from "@/server/workspace-demo";
import { grantSupport } from "@/server/platform-service";
import { reviewAge } from "@/server/player-age-service";
import { announcementShare } from "@/server/batch-announcement-service";
import { issueCalendarToken } from "@/server/calendar-feed-service";
import {
  markOpened,
  messagingView,
  previewMessage,
  processMessages,
  saveMessage,
  saveTemplate,
  shareList,
} from "@/server/messaging-service";
import {
  reportShare,
  sessionShare,
  setMemberPhone,
  myPhone,
} from "@/server/session-share-service";
import { z } from "zod";
import {
  context,
  approveReport,
  withdrawReport,
  convertEnquiry,
  reviewUpdate,
  publishUpdate,
  reply,
  invite,
  revokeMembership,
} from "@/server/workspace-service";
import {
  sameOrigin,
  privateJson,
  apiError,
  readJson,
} from "@/server/workspace-access";
import { WorkspaceError } from "@/server/auth";
import {
  createPlayerLink,
  decideSelfPlayer,
  listSelfPlayers,
  selfPlayerStatus,
  submitSelfPlayer,
} from "@/server/player-link-service";
import { customiseDrill, setDrillArchived } from "@/server/drill-library-service";
export const runtime = "nodejs";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ academyId: string }> },
) {
  try {
    sameOrigin(request);
    const { academyId } = await params;
    const ctx = await context(request.headers, academyId),
      body = z
        .object({
          action: z.string(),
          id: z.string().optional(),
          verified: z.boolean().default(false),
          data: z.unknown().optional(),
        })
        .parse(await readJson(request));
    if (
      ![
        "loadDemo",
        "support",
        "invite",
        "playerLink",
        "selfPlayerStatus",
        "selfPlayerSubmit",
        "selfPlayerList",
        "selfPlayerDecide",
        "calendarLink",
        "setPhone",
        "myPhone",
        "messagingView",
        "messagingPreview",
        "messagingSave",
        "messagingProcess",
        "messagingShareList",
        "messagingTemplate",
      ].includes(body.action) &&
      !body.id
    )
      throw new WorkspaceError(400, "Select a record for this action.");
    const expected = [
      "approveReport",
      "submitUpdate",
      "approveUpdate",
      "publishUpdate",
      "rejectUpdate",
    ].includes(body.action)
      ? z
          .object({ expectedVersion: z.number().int().positive().optional() })
          .parse(body.data ?? {}).expectedVersion
      : undefined;
    switch (body.action) {
      case "loadDemo":
        return privateJson(loadFictionalExample(ctx));
      case "approveReport":
        return privateJson(
          approveReport(ctx, body.id!, body.verified, expected),
        );
      case "customiseDrill":
        return privateJson(customiseDrill(ctx, body.id!));
      case "archiveDrill":
      case "restoreDrill":
        return privateJson(
          setDrillArchived(
            ctx,
            body.id!,
            body.action === "archiveDrill",
            z
              .object({
                expectedVersion: z.number().int().nonnegative().optional(),
              })
              .parse(body.data ?? {}).expectedVersion,
            // Over HTTP the version is required (judged after permission), so
            // that a stale screen cannot archive or restore a changed drill.
            { requireVersion: true },
          ),
        );
      case "playerLink":
        return privateJson(createPlayerLink(ctx, body.data));
      case "selfPlayerStatus":
        return privateJson(selfPlayerStatus(ctx));
      case "selfPlayerSubmit":
        return privateJson(submitSelfPlayer(ctx, body.data));
      case "selfPlayerList":
        return privateJson(listSelfPlayers(ctx));
      case "selfPlayerDecide":
        return privateJson(decideSelfPlayer(ctx, body.data));
      case "calendarLink":
        return privateJson(issueCalendarToken(ctx));
      case "sessionShare":
        return privateJson(sessionShare(ctx, body.id!));
      case "announcementShare":
        return privateJson(announcementShare(ctx, body.id!));
      case "reportShare":
        return privateJson(reportShare(ctx, body.id!));
      case "myPhone":
        return privateJson(myPhone(ctx));
      case "setPhone":
        return privateJson(setMemberPhone(ctx, body.data));
      case "messagingView":
        return privateJson(messagingView(ctx));
      case "messagingPreview":
        return privateJson(previewMessage(ctx, body.data));
      case "messagingSave":
        return privateJson(saveMessage(ctx, body.data));
      case "messagingProcess":
        return privateJson(processMessages(ctx));
      case "messagingShareList":
        return privateJson(shareList(ctx));
      case "messagingOpened":
        return privateJson(markOpened(ctx, body.id!));
      case "messagingTemplate":
        return privateJson(saveTemplate(ctx, body.data));
      case "ageReview":
        return privateJson(reviewAge(ctx, body.id!, body.data));
      case "convertEnquiry":
        return privateJson(convertEnquiry(ctx, body.id!, body.data));
      case "withdrawReport":
        return privateJson(withdrawReport(ctx, body.id!, body.data));
      case "submitUpdate":
        return privateJson(
          reviewUpdate(ctx, body.id!, "submit", false, expected),
        );
      case "approveUpdate":
        return privateJson(
          reviewUpdate(ctx, body.id!, "approve", body.verified, expected),
        );
      case "publishUpdate":
        return privateJson(publishUpdate(ctx, body.id!, expected));
      case "rejectUpdate":
        return privateJson(
          reviewUpdate(ctx, body.id!, "reject", false, expected),
        );
      case "reply":
        return privateJson(reply(ctx, body.id!, body.data));
      case "support":
        return privateJson(grantSupport(ctx, body.data));
      case "invite":
        return privateJson(invite(ctx, body.data));
      case "revoke":
        return privateJson(revokeMembership(ctx, body.id!, body.data));
      default:
        throw new WorkspaceError(400, "Unknown action.");
    }
  } catch (e) {
    return apiError(e, request);
  }
}
