"use client";
import { Fragment, useState, type ReactNode, type CSSProperties } from "react";
import Image from "next/image";
import Link from "next/link";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Home,
  CalendarDays,
  Users,
  BookOpen,
  MessageSquare,
  ClipboardList,
  WalletCards,
  Menu,
  Layers,
  ChevronDown,
  GitBranch,
  Plus,
  List,
  Settings,
  Search,
  CircleHelp,
  ChevronRight,
  ChevronLeft,
  X,
  LogOut,
} from "lucide-react";
import { confirmUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { authClient } from "@/lib/auth-client";
import { navigatePrivateWorkspace } from "@/lib/private-navigation";
import type { WorkspaceShell } from "@/domain/home-summary";
import type { PortalSection, PortalNavigate } from "./portal-types";
import { navigationFor } from "./portal-access";
import { roleLabels, academyMonogram } from "./role-labels";
import { SportozenSymbol } from "@/components/brand/sportozen-symbol";

// The items, their names and their order come from navigationFor (portal-access.ts); only the icons live here.
// "More" (the family's last item) keeps the menu icon; staff Settings has its own.
const icons = {
  home: Home,
  calendar: CalendarDays,
  players: Users,
  training: BookOpen,
  messages: MessageSquare,
  reports: ClipboardList,
  fees: WalletCards,
  settings: Settings,
} as const;

export function PortalShell({
  data: d,
  section,
  onNavigate,
  children,
  limited = false,
}: {
  data: WorkspaceShell;
  section: PortalSection;
  onNavigate: PortalNavigate;
  children: ReactNode;
  /** A member who has not been confirmed yet: only Home is offered. */
  limited?: boolean;
}) {
  const [mobileOpen, setMobileOpen] = useState(false),
    [collapsed, setCollapsed] = useState(false),
    [help, setHelp] = useState(false),
    [batchesOpen, setBatchesOpen] = useState(false),
    [search, setSearch] = useState("");
  const parent = d.membership.role === "PARENT";
  const name = d.viewer?.name ?? d.membership.role.toLowerCase();
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase();
  // Only what this role can open is listed: nothing is shown disabled. The server still authorises every request.
  const nav = limited
    ? [{ key: "home" as const, label: "Home" }]
    : navigationFor(d.membership.role, d.academy.modules, !!d.viewer?.playerLogin);
  const identity = (
    <>
      <span className="portal-academy-logo">
        {d.academy.logoData ? (
          <Image
            src={d.academy.logoData}
            alt={`${d.academy.name} logo`}
            width={54}
            height={56}
            unoptimized
          />
        ) : (
          <span
            className="portal-crest"
            role="img"
            aria-label={`${d.academy.name} (no logo uploaded)`}
          >
            {academyMonogram(d.academy.name)}
          </span>
        )}
      </span>
      {!collapsed && (
        <span>
          <strong>{d.academy.name}</strong>
          <small>{d.academy.location || d.academy.country}</small>
        </span>
      )}
    </>
  );
  // A collapsible "Batches" group right after Calendar for those who manage branches and batches. Its entries open the Settings
  // pane that holds them (and, for the two Create entries, the same dialogs); what a person may save is still decided by the server.
  const showBatches = !limited && !parent && ["OWNER", "ADMIN"].includes(d.membership.role);
  const openStructure = (open?: "branch" | "batch") => {
    setMobileOpen(false);
    onNavigate("settings", { tab: "sessions", open: open ? `${open}-${Date.now()}` : undefined });
  };
  const batchesGroup = (
    <>
      <button
        type="button"
        data-leave-editor
        className="portal-nav-group"
        aria-expanded={batchesOpen && !collapsed}
        aria-controls="portal-batches-group"
        title="Batches"
        onClick={() => {
          // In the icon-only sidebar there is no room for a list: the first press widens it and opens the group.
          if (collapsed) setCollapsed(false);
          setBatchesOpen(collapsed ? true : !batchesOpen);
        }}
      >
        <Layers size={22} />
        {!collapsed && (
          <>
            <span>Batches</span>
            <ChevronDown size={16} className="portal-group-chevron" />
          </>
        )}
      </button>
      <div
        id="portal-batches-group"
        role="group"
        aria-label="Batches"
        className="portal-subnav"
        hidden={!batchesOpen || collapsed}
      >
        <button type="button" data-leave-editor onClick={() => openStructure()}>
          <List size={16} />
          <span>Branches &amp; batches</span>
        </button>
        <button type="button" data-leave-editor onClick={() => openStructure("branch")}>
          <GitBranch size={16} />
          <span>Create branch</span>
        </button>
        <button type="button" data-leave-editor onClick={() => openStructure("batch")}>
          <Plus size={16} />
          <span>Create batch</span>
        </button>
      </div>
    </>
  );
  const navigation = (
    <nav aria-label={d.viewer?.playerLogin ? "Player navigation" : parent ? "Parent navigation" : "Academy navigation"}>
      {nav.map(({ key, label }) => {
        const Icon =
          parent && key === "settings" ? Menu : icons[key as keyof typeof icons];
        const item = (
          <button
            key={key}
            data-leave-editor
            type="button"
            className={
              section === key ||
              (key === "players" && section === "development") ||
              (key === "settings" && section === "practice")
                ? "active"
                : ""
            }
            aria-current={section === key ? "page" : undefined}
            title={label}
            onClick={() => {
              setMobileOpen(false);
              if (key === "settings") {
                onNavigate("settings", { tab: "academy" });
              } else {
                onNavigate(key);
              }
            }}
          >
            <Icon size={22} />
            {!collapsed && <span>{label}</span>}
          </button>
        );
        return key === "calendar" && showBatches ? (
          <Fragment key={key}>
            {item}
            {batchesGroup}
          </Fragment>
        ) : (
          item
        );
      })}
    </nav>
  );
  return (
    <div
      className={`academy-portal ${parent ? "portal-parent" : ""} ${collapsed ? "sidebar-collapsed" : ""}`}
      style={{ "--portal-green": d.academy.brandAccent } as CSSProperties}
    >
      <a className="skip-link" href="#portal-content">
        Skip to content
      </a>
      {!parent && (
        <aside className="portal-sidebar">
          <div className="portal-sidebar-header">
            <button
              data-leave-editor
              className="portal-brand"
              onClick={() => onNavigate("home")}
              title="Sportozen Academy overview"
            >
              <SportozenSymbol />
              {!collapsed && (
                <span>
                  Sportozen<small>Academy</small>
                </span>
              )}
            </button>
            <button
              type="button"
              className="portal-collapse-toggle"
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              onClick={() => setCollapsed((prev) => !prev)}
            >
              {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
            </button>
          </div>
          <button
            data-leave-editor
            className="portal-academy"
            title={d.academy.name}
            onClick={() => onNavigate("settings", { tab: "academy" })}
          >
            {identity}
          </button>
          {navigation}
          <button
            data-leave-editor
            className="portal-account"
            title={`${name} (${roleLabels[d.membership.role]})`}
            onClick={() => onNavigate("settings", { tab: "account" })}
          >
            <span className="portal-avatar">{initials}</span>
            {!collapsed && (
              <>
                <span>
                  <strong>{name}</strong>
                  <small>{roleLabels[d.membership.role]}</small>
                </span>
                <ChevronRight size={18} />
              </>
            )}
          </button>
        </aside>
      )}
      <div className="portal-workspace">
        <header className="portal-header">
          {parent ? (
            <button
              data-leave-editor
              className="portal-parent-identity"
              onClick={() => onNavigate("home")}
            >
              {identity}
            </button>
          ) : (
            <Dialog.Root open={mobileOpen} onOpenChange={setMobileOpen}>
              <Dialog.Trigger
                className="portal-mobile-menu"
                aria-label="Open academy navigation"
              >
                <Menu size={23} />
              </Dialog.Trigger>
              <Dialog.Portal>
                <Dialog.Overlay className="portal-overlay" />
                <Dialog.Content className="portal-menu-dialog">
                  <div className="portal-menu-brand">
                    <SportozenSymbol />
                    <span>
                      Sportozen<small>Academy</small>
                    </span>
                  </div>
                  <Dialog.Title>Academy navigation</Dialog.Title>
                  <Dialog.Description>{d.academy.name}</Dialog.Description>
                  <Dialog.Close
                    className="portal-icon close"
                    aria-label="Close navigation"
                  >
                    <X />
                  </Dialog.Close>
                  {navigation}
                  <Link href="/workspace" prefetch={false}>
                    Your academies
                  </Link>
                </Dialog.Content>
              </Dialog.Portal>
            </Dialog.Root>
          )}
          {!parent && (
            <form
              className="portal-search"
              onSubmit={(e) => {
                e.preventDefault();
                if (!confirmUnsavedChanges()) return;
                onNavigate("players", { q: search });
              }}
            >
              <button aria-label="Search academy players">
                <Search size={19} />
              </button>
              <input
                aria-label="Search academy players"
                placeholder="Search academy players…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </form>
          )}
          <button
            className="portal-icon portal-help"
            aria-label="Help and academy access"
            onClick={() => setHelp(true)}
          >
            <CircleHelp size={21} />
          </button>
          <button
            className="portal-avatar"
            data-leave-editor
            aria-label={`${initials} account settings`}
            onClick={() => onNavigate("settings", { tab: "account" })}
          >
            {initials}
          </button>
        </header>
        <main className="portal-content" id="portal-content">
          {children}
        </main>
        {parent && <footer className="portal-parent-nav">{navigation}</footer>}
      </div>
      <Dialog.Root open={help} onOpenChange={setHelp}>
        <Dialog.Portal>
          <Dialog.Overlay className="portal-overlay" />
          <Dialog.Content className="portal-dialog">
            <Dialog.Title>Your academy workspace</Dialog.Title>
            <Dialog.Description>
              Private football training, reports and communication for{" "}
              {d.academy.name}.
            </Dialog.Description>
            <Dialog.Close className="portal-icon close" aria-label="Close help">
              <X />
            </Dialog.Close>
            <p>
              Your access is checked using your current academy membership.
              Contact the academy owner for changes to assignments or access.
            </p>
            <Link
              className="button secondary"
              href="/workspace"
              prefetch={false}
            >
              Your academies
            </Link>
            <button
              className="button secondary"
              onClick={async () => {
                await authClient.signOut();
                navigatePrivateWorkspace("/sign-in");
              }}
            >
              <LogOut size={16} /> Sign out
            </button>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
