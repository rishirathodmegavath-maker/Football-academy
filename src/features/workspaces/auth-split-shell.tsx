import Link from "next/link";
import type { ReactNode } from "react";
import { CheckCircle2, Lock, Users } from "lucide-react";
import { SportozenSymbol } from "@/components/brand/sportozen-symbol";
import "./sign-in-split.css";

const HIGHLIGHTS = [
  {
    icon: CheckCircle2,
    text: "Structured training plans, attendance and player development",
  },
  {
    icon: Users,
    text: "Role-scoped workspaces for owners, coaches, players and families",
  },
  {
    icon: Lock,
    text: "Private academy records with verified session security",
  },
];

/**
 * The two-column sign-in layout: a dark story panel on the left, the form on
 * the right. Below 900 px the panel is hidden and the form's own wordmark
 * shows instead, so exactly one brand link is ever reachable by keyboard.
 * The panel is text and drawing only; it holds no form control.
 */
export function AuthSplitShell({
  registering = false,
  story,
  children,
}: {
  registering?: boolean;
  /** Other wording for the story panel (for example the academy list). */
  story?: { eyebrow: string; title: ReactNode; lead: string };
  children: ReactNode;
}) {
  return (
    <div className="auth-split">
      <aside className="auth-split-showcase" aria-label="Sportozen Academy">
        <div className="auth-split-pitch" aria-hidden="true">
          <svg viewBox="0 0 420 520" fill="none">
            <rect
              x="20"
              y="20"
              width="380"
              height="480"
              rx="6"
              stroke="currentColor"
              strokeWidth="1.2"
            />
            <line
              x1="20"
              y1="260"
              x2="400"
              y2="260"
              stroke="currentColor"
              strokeWidth="1.4"
            />
            <circle
              cx="210"
              cy="260"
              r="62"
              stroke="currentColor"
              strokeWidth="1.2"
            />
            <circle cx="210" cy="260" r="3" fill="currentColor" />
            <rect
              x="100"
              y="20"
              width="220"
              height="96"
              stroke="currentColor"
              strokeWidth="1.2"
            />
            <rect
              x="150"
              y="20"
              width="120"
              height="38"
              stroke="currentColor"
              strokeWidth="1.2"
            />
            <rect
              x="100"
              y="404"
              width="220"
              height="96"
              stroke="currentColor"
              strokeWidth="1.2"
            />
            <rect
              x="150"
              y="462"
              width="120"
              height="38"
              stroke="currentColor"
              strokeWidth="1.2"
            />
          </svg>
        </div>
        <div className="auth-split-top">
          <Link className="auth-split-brand" href="/">
            <SportozenSymbol />
            <span>
              Sportozen <small>ACADEMY</small>
            </span>
          </Link>
        </div>
        <div className="auth-split-body">
          <span className="auth-split-eyebrow">
            {story
              ? story.eyebrow
              : registering
                ? "GET STARTED"
                : "ACADEMY PLATFORM"}
          </span>
          <p className="auth-split-title">
            {story ? (
              story.title
            ) : registering ? (
              <>
                Set up your <em>academy.</em>
              </>
            ) : (
              <>
                Built for every session on the <em>pitch.</em>
              </>
            )}
          </p>
          <p className="auth-split-lead">
            {story
              ? story.lead
              : registering
                ? "Join your academy's coaching team or family portal with clean permissions and clear progress records."
                : "One calm workspace connecting coaches, academy leadership, players and families."}
          </p>
          <ul className="auth-split-highlights">
            {HIGHLIGHTS.map(({ icon: Icon, text }) => (
              <li key={text}>
                <Icon size={16} aria-hidden="true" />
                <span>{text}</span>
              </li>
            ))}
          </ul>
        </div>
        <small className="auth-split-footer">
          Private academy workspaces · Role-scoped access
        </small>
      </aside>
      {children}
    </div>
  );
}
