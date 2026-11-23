"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { navigatePrivateWorkspace } from "@/lib/private-navigation";
import { useRouter } from "next/navigation";
import { Card, PageTitle, Button, Badge } from "@/components/ui/primitives";
import { AcademyForm } from "./academy-form";
import { workspaceRequest } from "@/hooks/use-workspace";
import type { AcademyConfiguration, AcademyRole } from "@/domain/workspace";
import { roleLabels } from "./role-labels";
import "./secure.css";
import { SportozenSymbol } from "@/components/brand/sportozen-symbol";
import { authClient } from "@/lib/auth-client";
import { AuthSplitShell } from "./auth-split-shell";
import { takeJustSignedIn } from "./just-signed-in";
export function WorkspaceChooser({
  initialToken = "",
  reviewRequired = true,
}: {
  /** False when this deployment approves a new academy as it is created. */
  reviewRequired?: boolean;
  /** From an emailed invitation link (?invitation=); never accepted automatically. */
  initialToken?: string;
}) {
  const router = useRouter(),
    [list, setList] = useState<
      { academy: AcademyConfiguration; role: AcademyRole }[]
    >([]),
    [mfaNeeded, setMfaNeeded] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [token, setToken] = useState(initialToken);
  // Remove the invitation token from the address bar once it has been read.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("invitation"))
      window.history.replaceState(null, "", window.location.pathname);
  }, []);
  useEffect(() => {
    const c = new AbortController();
    workspaceRequest<{
      workspaces: typeof list;
      account?: { required: boolean; enabled: boolean };
    }>("/api/workspaces", "GET", undefined, c.signal)
      .then((r) => {
        setList(r.workspaces);
        // Just signed in with exactly one academy: open it at once. Any other visit
        // to this page, or an emailed invitation, shows the list as usual.
        if (takeJustSignedIn() && r.workspaces.length === 1 && !initialToken)
          router.replace(`/workspace/${r.workspaces[0].academy.id}`);
        setMfaNeeded(Boolean(r.account?.required && !r.account.enabled));
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      });
    return () => c.abort();
    // Runs once on arrival; the token and router are read at that moment only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <AuthSplitShell
      story={{
        eyebrow: "YOUR ACADEMIES",
        title: (
          <>
            One account, every <em>academy.</em>
          </>
        ),
        lead: "Each academy keeps its own people, records and settings. You see only the one you open.",
      }}
    >
      <main className="secure-page">
        <div className="secure-topline">
          <Link className="secure-wordmark" href="/">
            <SportozenSymbol />
            <span className="secure-wordmark-text">
              Sportozen <span>ACADEMY</span>
            </span>
          </Link>
          <Button
            variant="secondary"
            onClick={async () => {
              await authClient.signOut();
              navigatePrivateWorkspace("/sign-in");
            }}
          >
            Sign out
          </Button>
        </div>
        <PageTitle
          title="Your academy workspaces"
          description="Independent customer academies, with membership verified by the server."
        />
        {mfaNeeded && (
          <p role="alert">
            Your role requires two-step verification.{" "}
            <Link className="text-link" href="/account/security">
              Turn it on under Account security
            </Link>{" "}
            to keep using your academy.
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        <p>
          <Link className="text-link" href="/account/security">
            Account security
          </Link>
        </p>
        <div className="workspace-grid">
          {list.map(({ academy, role }) => (
            <Card key={academy.id}>
              <Badge>
                {academy.demo ? "Fictional demo academy" : "Academy workspace"}
              </Badge>
              <h2>{academy.name}</h2>
              <p>
                {academy.sportIds.includes("football")
                  ? "Football academy"
                  : "Football configuration required"}{" "}
                · {roleLabels[role] ?? role}
              </p>
              <Link
                className="button primary"
                prefetch={false}
                href={`/workspace/${academy.id}`}
                onClick={(event) => {
                  event.preventDefault();
                  navigatePrivateWorkspace(`/workspace/${academy.id}`);
                }}
              >
                Open academy
              </Link>
            </Card>
          ))}
        </div>
        <div className="two-columns">
          <Card>
            <h2>Onboard an academy</h2>
            <p>
              Create football academy → configure region → add branches and
              programs → invite staff → add players → explicitly link guardians.
            </p>
            <AcademyForm
              busy={busy}
              reviewRequired={reviewRequired}
              onSave={async (value) => {
                setBusy(true);
                setError("");
                try {
                  const academy = await workspaceRequest<AcademyConfiguration>(
                    "/api/workspaces",
                    "POST",
                    value,
                  );
                  router.push(`/workspace/${academy.id}`);
                } catch (e) {
                  setError(
                    e instanceof Error
                      ? e.message
                      : "Could not create academy.",
                  );
                } finally {
                  setBusy(false);
                }
              }}
            />
          </Card>
          <Card>
            <h2>Accept a private invitation</h2>
            <p>
              Sign in with the invited account. Invitations do not automatically
              merge children or records between academies.
            </p>
            <form
              className="form-stack"
              onSubmit={async (e) => {
                e.preventDefault();
                setError("");
                try {
                  // A whole pasted link is accepted as well as the bare code.
                  const result = await workspaceRequest<{ academyId: string }>(
                    "/api/invitations/accept",
                    "POST",
                    {
                      token: token.match(/[0-9a-f]{64}/i)?.[0] ?? token.trim(),
                    },
                  );
                  router.push(`/workspace/${result.academyId}`);
                } catch (e) {
                  setError(
                    e instanceof Error ? e.message : "Invitation unavailable.",
                  );
                }
              }}
            >
              <label>
                Invitation link or code
                <input
                  required
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
              </label>
              <Button>Accept academy invitation</Button>
            </form>
            <Link className="text-link" href="/platform">
              Platform administration
            </Link>
            <p className="muted">
              Platform administrators manage customer accounts and entitlements.
              They do not receive routine access to private player records.
            </p>
          </Card>
        </div>
      </main>
    </AuthSplitShell>
  );
}
