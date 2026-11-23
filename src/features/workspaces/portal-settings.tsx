"use client";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type CSSProperties,
  type RefObject,
} from "react";
import Image from "next/image";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Camera,
  Mail,
  Phone,
  Link as LinkIcon,
  MapPin,
  Upload,
  Trash2,
  Plus,
  MoreHorizontal,
  Check,
  X,
  Pencil,
} from "lucide-react";
import type { AcademyConfiguration } from "@/domain/workspace";
import type { FootballVenue } from "@/domain/training";
import { academySchema } from "@/domain/academy-configuration-schema";
import { useAcademySettings } from "@/hooks/use-academy-settings";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import type { useWorkspace } from "@/hooks/use-workspace";
import { workspaceRequest } from "@/hooks/use-workspace";
import { authClient } from "@/lib/auth-client";
import { navigatePrivateWorkspace } from "@/lib/private-navigation";
import { AcademyStructure } from "./academy-structure";
import { CommunicationSettingsPanel } from "./communication-controls";
import { ParentPreferences } from "./parent-preferences";
import { sessionThemes } from "@/services/session-themes";
import {
  COUNTRY_CALLING_CODE,
  mailtoLink,
  gmailLink,
  normalizePhone,
  whatsappLink,
} from "@/services/share-links";
import { roleLabels } from "./role-labels";
import "./portal-settings.css";

type Controller = ReturnType<typeof useWorkspace>;
const tabs = [
  "Academy",
  "Team",
  "Sessions",
  "Notifications",
  "Account",
  "Integrations",
] as const;
type Tab = (typeof tabs)[number];
const PERSONAL_TABS: readonly Tab[] = [
  "Notifications",
  "Account",
  "Integrations",
];
type TextSetting =
  | "name"
  | "location"
  | "city"
  | "contactEmail"
  | "phone"
  | "website"
  | "country"
  | "currency"
  | "dateLocale"
  | "reviewFrequency";
const moduleLabels: Record<string, string> = {
  development: "Football training and development",
  reports: "Reviewed player reports",
  communication: "Parent communication",
  fees: "Academy fee management",
};
// Plan names as people read them; the stored tier values stay as they are.
const tierLabels: Record<string, string> = {
  LOCAL_FOUNDATION: "Local foundation",
  PILOT: "Pilot",
  STANDARD: "Standard",
};
function Card({
  title,
  note,
  action,
  children,
  className = "",
}: {
  title: string;
  note?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={"as-card " + className}>
      <div className="as-card-heading">
        <div>
          <h2>{title}</h2>
          {note && <p>{note}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
function Logo({
  value,
  name,
  large = false,
}: {
  value?: string;
  name: string;
  large?: boolean;
}) {
  return (
    <span className={"as-logo" + (large ? " large" : "")}>
      {value ? (
        <Image
          src={value}
          width={large ? 122 : 110}
          height={large ? 122 : 110}
          alt="Academy logo preview"
          unoptimized
        />
      ) : (
        // Decoration, drawn from data-initials by CSS so the letters are not text
        // in the page: the control that holds the logo is named by its label.
        <span
          aria-hidden="true"
          data-initials={name
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 2)
            .map((part) => Array.from(part)[0])
            .join("")
            .toUpperCase()}
        />
      )}
    </span>
  );
}
function AgeCategories({
  value,
  onChange,
  disabled,
}: {
  value: string[];
  onChange: (value: string[]) => void;
  disabled: boolean;
}) {
  const [category, setCategory] = useState("");
  function add() {
    const additions = category
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    if (!additions.length) return;
    onChange(Array.from(new Set([...value, ...additions])));
    setCategory("");
  }
  return (
    <div className="as-field ps-categories">
      <label htmlFor="ps-age-category">Configured age categories</label>
      <div className="ps-category-entry">
        <input
          id="ps-age-category"
          name="ageGroups"
          value={category}
          placeholder="e.g. U10, U12"
          maxLength={200}
          disabled={disabled}
          onChange={(e) => setCategory(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button
          type="button"
          className="as-button"
          disabled={disabled || !category.trim()}
          onClick={add}
        >
          Add
        </button>
      </div>
      <ul>
        {value.map((item, index) => (
          <li key={index}>
            {item}
            <button
              type="button"
              disabled={disabled}
              aria-label={"Remove age category " + item}
              onClick={() =>
                onChange(value.filter((_, position) => position !== index))
              }
            >
              <X size={13} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
export function PortalSettings({
  workspace,
  playerId,
  requestedTab,
}: {
  workspace: Controller;
  playerId?: string;
  requestedTab?: string;
}) {
  if (!workspace.data)
    return (
      <div>
        <h1>Settings</h1>
        <p role="status">Loading your academy settings…</p>
      </div>
    );
  return (
    <ReadySettings
      key={
        workspace.data.academy.id +
        ":" +
        workspace.data.membership.userId +
        ":" +
        (requestedTab ?? "")
      }
      workspace={workspace}
      requestedTab={requestedTab}
      playerId={
        workspace.data.records.player.some((player) => player.id === playerId)
          ? playerId
          : undefined
      }
    />
  );
}
function ReadySettings({
  workspace: w,
  playerId,
  requestedTab,
}: {
  workspace: Controller;
  playerId?: string;
  requestedTab?: string;
}) {
  const data = w.data!,
    s = useAcademySettings(w),
    parent = data.membership.role === "PARENT";
  // Academy, team and session administration are owner and admin screens: a
  // coach or guardian is not offered tabs that can only say "unavailable".
  const shownTabs = s.permitted
    ? tabs
    : tabs.filter((item) => PERSONAL_TABS.includes(item));
  const [tab, setTab] = useState<Tab>(() => {
    const requested =
      requestedTab?.toLowerCase() ??
      (typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get("tab")?.toLowerCase()
        : undefined);
    return (
      shownTabs.find((item) => item.toLowerCase() === requested) ??
      (s.permitted ? "Academy" : "Account")
    );
  });

  useEffect(() => {
    if (requestedTab) {
      const match = shownTabs.find(
        (item) => item.toLowerCase() === requestedTab.toLowerCase(),
      );
      if (match) setTab(match);
    }
  }, [requestedTab, shownTabs]);
  const [review, setReview] = useState(false),
    [reviewError, setReviewError] = useState(""),
    [venue, setVenue] = useState<FootballVenue | null | undefined>(undefined),
    [isEditing, setIsEditing] = useState(false);
  const file = useRef<HTMLInputElement>(null),
    form = useRef<HTMLFormElement>(null),
    save = useRef<HTMLButtonElement>(null),
    venueTrigger = useRef<HTMLButtonElement>(null);
  const input = (
    label: string,
    key: TextSetting,
    type = "text",
    icon?: ReactNode,
  ) => (
    <label className="as-field">
      {label}
      <span className={icon ? "as-input-icon" : ""}>
        {icon}
        <input
          name={key}
          aria-label={label}
          type={type}
          value={String(s.draft[key] ?? "")}
          aria-invalid={!!s.errors[key]}
          aria-describedby={s.errors[key] ? "ps-error-" + key : undefined}
          onChange={(e) => s.update(key, e.target.value)}
        />
      </span>
      {s.errors[key] && (
        <small className="as-field-error" id={"ps-error-" + key}>
          {s.errors[key]}
        </small>
      )}
    </label>
  );
  const fieldSelect = (
    label: string,
    key: "timezone" | "language" | "weekStartsOn" | "dateFormat" | "timeFormat",
    options: readonly (readonly [string, string])[],
  ) => (
    <label className="as-field">
      {label}
      <select
        name={key}
        aria-label={label}
        value={String(s.draft[key] ?? "")}
        aria-invalid={!!s.errors[key]}
        aria-describedby={s.errors[key] ? "ps-error-" + key : undefined}
        onChange={(e) => {
          const value = e.target.value;
          if (key === "weekStartsOn") s.update(key, value === "0" ? 0 : 1);
          else if (key === "dateFormat")
            s.update(key, value as AcademyConfiguration["dateFormat"]);
          else if (key === "timeFormat")
            s.update(key, value as AcademyConfiguration["timeFormat"]);
          else s.update(key, value);
        }}
      >
        {options.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
      {s.errors[key] && (
        <small id={"ps-error-" + key} className="as-field-error">
          {s.errors[key]}
        </small>
      )}
    </label>
  );
  const chooseLogo = () => file.current?.click();
  return (
    <div
      className="portal-settings"
      style={{ "--hd-green": data.academy.brandAccent } as CSSProperties}
    >
      <div className="as-title">
        <h1>Settings</h1>
        <p>
          {parent
            ? "Your account, notification preferences and sign out."
            : "Manage your academy, team, notifications and preferences."}
        </p>
      </div>
      <nav
        className="as-tabs"
        role="tablist"
        aria-label="Settings sections"
        onKeyDown={(e) => {
          const buttons = Array.from(
              e.currentTarget.querySelectorAll("button"),
            ),
            index = buttons.indexOf(e.target as HTMLButtonElement);
          const next =
            e.key === "ArrowRight"
              ? (index + 1) % buttons.length
              : e.key === "ArrowLeft"
                ? (index - 1 + buttons.length) % buttons.length
                : e.key === "Home"
                  ? 0
                  : e.key === "End"
                    ? buttons.length - 1
                    : -1;
          if (next >= 0) {
            e.preventDefault();
            buttons[next]?.focus();
          }
        }}
      >
        {shownTabs.map((item) => (
          <button
            key={item}
            type="button"
            id={"ps-tab-" + item}
            role="tab"
            aria-selected={tab === item}
            aria-controls="ps-panel"
            tabIndex={tab === item ? 0 : -1}
            className={tab === item ? "active" : ""}
            data-leave-editor
            onClick={() => setTab(item)}
          >
            {item}
          </button>
        ))}
      </nav>
      <div role="tabpanel" id="ps-panel" aria-labelledby={"ps-tab-" + tab}>
        {tab === "Academy" &&
          (s.permitted ? (
            <>
              {s.error && (
                <div className="as-state error" role="alert">
                  {s.error}
                  <button
                    type="button"
                    className="as-text-button"
                    onClick={async () => {
                      setReviewError("");
                      try {
                        await w.reload();
                        setReview(true);
                      } catch (failure) {
                        setReviewError(
                          failure instanceof Error
                            ? failure.message
                            : "Saved values could not be loaded. Your draft remains here.",
                        );
                      }
                    }}
                  >
                    Review saved configuration
                  </button>
                </div>
              )}
              {reviewError && (
                <p className="as-state error" role="alert">
                  {reviewError}
                </p>
              )}
              {s.notice && (
                <p className="as-state success" role="status">
                  {s.notice}
                </p>
              )}
              {s.newerVersion && (
                <p className="as-state">
                  A newer configuration is available. Your draft has been
                  retained.{" "}
                  <button
                    type="button"
                    className="as-text-button"
                    onClick={() => setReview(true)}
                  >
                    Review saved values
                  </button>
                </p>
              )}
              <form
                ref={form}
                noValidate
                aria-label="Academy configuration"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const checked = academySchema.safeParse(s.draft);
                  if (!checked.success) {
                    const key = String(checked.error.issues[0]?.path[0]);
                    const target = form.current?.elements.namedItem(key);
                    if (target instanceof HTMLElement) {
                      const disclosure = target.closest("details");
                      if (disclosure) disclosure.open = true;
                      target.focus();
                    }
                  }
                  await s.save();
                }}
              >
                <input
                  ref={file}
                  type="file"
                  accept="image/png"
                  tabIndex={-1}
                  className="as-file-input"
                  aria-label="Choose academy PNG logo"
                  disabled={s.busy}
                  onChange={(e) => {
                    const selected = e.target.files?.[0];
                    e.target.value = "";
                    void s.stageLogo(selected);
                  }}
                />
                <div className={"as-layout" + (s.dirty ? " is-dirty" : "")}>
                  <div className="as-main-column">
                    <Card
                      title="Academy profile"
                      note="Update your academy details and brand information."
                      action={
                        !isEditing ? (
                          <button
                            type="button"
                            className="as-button secondary as-edit-btn"
                            onClick={() => setIsEditing(true)}
                          >
                            <Pencil size={15} /> Edit
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="as-button text"
                            onClick={() => {
                              s.discard();
                              setIsEditing(false);
                            }}
                          >
                            Cancel
                          </button>
                        )
                      }
                    >
                      <fieldset
                        className="as-profile-grid"
                        disabled={s.busy || !isEditing}
                      >
                        <button
                          type="button"
                          className="as-thumbnail-button"
                          aria-label="Change academy profile logo"
                          onClick={chooseLogo}
                        >
                          <Logo value={s.draft.logoData} name={s.draft.name} />
                          <span className="as-camera">
                            <Camera size={17} />
                          </span>
                        </button>
                        <div className="as-profile-fields">
                          {input("Academy name", "name")}
                          {input(
                            "Location",
                            "location",
                            "text",
                            <MapPin size={16} />,
                          )}
                        </div>
                        <label className="as-field as-about">
                          About academy
                          <textarea
                            name="about"
                            aria-label="About academy"
                            maxLength={250}
                            value={s.draft.about ?? ""}
                            onChange={(e) => s.update("about", e.target.value)}
                            aria-invalid={!!s.errors.about}
                            aria-describedby={
                              s.errors.about ? "ps-error-about" : undefined
                            }
                          />
                          <small className="as-counter">
                            {(s.draft.about ?? "").length}/250
                          </small>
                          {s.errors.about && (
                            <small
                              id="ps-error-about"
                              className="as-field-error"
                            >
                              {s.errors.about}
                            </small>
                          )}
                        </label>
                      </fieldset>
                      {s.dirty && (
                        <p className="as-unsaved" role="status">
                          Unsaved changes
                        </p>
                      )}
                    </Card>
                    <Card
                      title="Contact information"
                      note="This information will be used for communication with parents and players."
                    >
                      <fieldset disabled={s.busy} className="as-contact-grid">
                        {input(
                          "Primary email",
                          "contactEmail",
                          "email",
                          <Mail size={16} />,
                        )}
                        {input(
                          "Phone number",
                          "phone",
                          "tel",
                          <Phone size={16} />,
                        )}
                        {input(
                          "Website (optional)",
                          "website",
                          "url",
                          <LinkIcon size={16} />,
                        )}
                      </fieldset>
                    </Card>
                    <Card
                      title="Academy settings"
                      note="Configure how your academy works."
                      className="as-preferences-card"
                    >
                      <fieldset
                        disabled={s.busy}
                        className="as-preferences-grid"
                      >
                        {fieldSelect(
                          "Default time zone",
                          "timezone",
                          Array.from(
                            new Set([
                              s.draft.timezone,
                              "Asia/Kolkata",
                              "Europe/London",
                              "UTC",
                              "Australia/Perth",
                            ]),
                          ).map((zone) => [
                            zone,
                            zone === "Asia/Kolkata"
                              ? "(GMT+5:30) Asia/Kolkata"
                              : zone,
                          ]),
                        )}
                        {fieldSelect("Week starts on", "weekStartsOn", [
                          ["1", "Monday"],
                          ["0", "Sunday"],
                        ])}
                        <label className="as-field">
                          Age group format
                          <input
                            aria-label="Age group format"
                            readOnly
                            value={
                              s.draft.ageGroups.join(", ") ||
                              "No categories configured"
                            }
                          />
                        </label>
                        {fieldSelect("Date format", "dateFormat", [
                          ["DD_MMM_YYYY", "DD MMM YYYY"],
                          ["MM_DD_YYYY", "MM/DD/YYYY"],
                          ["YYYY_MM_DD", "YYYY-MM-DD"],
                        ])}
                        {fieldSelect("Time format", "timeFormat", [
                          ["12_HOUR", "12-hour (e.g. 5:00 PM)"],
                          ["24_HOUR", "24-hour (e.g. 17:00)"],
                        ])}
                        {fieldSelect(
                          "Language",
                          "language",
                          Array.from(
                            new Set([s.draft.language, "English"]),
                          ).map((language) => [language, language]),
                        )}
                      </fieldset>
                      <details className="ps-advanced">
                        <summary>
                          Additional regional settings and modules
                        </summary>
                        <p className="as-support-note">
                          Display preferences do not change birth dates or
                          reschedule recorded sessions. The current interface is
                          English.
                        </p>
                        <fieldset disabled={s.busy} className="as-contact-grid">
                          {input("City", "city")}
                          {input("Country code", "country")}
                          {input("Currency code", "currency")}
                          {input("Date and number locale", "dateLocale")}
                          {input("Review frequency", "reviewFrequency")}
                          <label className="as-field">
                            Measurement units
                            <select
                              aria-label="Measurement units"
                              value={s.draft.measurementSystem}
                              onChange={(e) =>
                                s.update(
                                  "measurementSystem",
                                  e.target.value as "METRIC" | "IMPERIAL",
                                )
                              }
                            >
                              <option value="METRIC">Metric</option>
                              <option value="IMPERIAL">Imperial</option>
                            </select>
                          </label>
                          <label className="as-field">
                            Brand accent
                            <select
                              aria-label="Brand accent"
                              value={s.draft.brandAccent}
                              onChange={(e) =>
                                s.update("brandAccent", e.target.value)
                              }
                            >
                              <option value="#008463">Green</option>
                              <option value="#2364a1">Blue</option>
                              <option value="#6750a4">Purple</option>
                            </select>
                          </label>
                          <AgeCategories
                            value={s.draft.ageGroups}
                            disabled={s.busy}
                            onChange={(values) => s.update("ageGroups", values)}
                          />
                        </fieldset>
                        <p className="as-support-note">
                          These labels do not reclassify existing players.
                          Modules also require your recorded subscription
                          entitlement.
                        </p>
                        {[
                          "development",
                          "reports",
                          "communication",
                          "fees",
                        ].map((module) => (
                          <label className="ps-check" key={module}>
                            <input
                              type="checkbox"
                              checked={s.draft.modules.includes(module)}
                              disabled={
                                s.busy ||
                                !data.subscription?.modules.includes(module)
                              }
                              onChange={(e) =>
                                s.update(
                                  "modules",
                                  e.target.checked
                                    ? [...s.draft.modules, module]
                                    : s.draft.modules.filter(
                                        (item) => item !== module,
                                      ),
                                )
                              }
                            />
                            {module}
                            {!data.subscription?.modules.includes(module) &&
                              " — unavailable in current entitlement"}
                          </label>
                        ))}
                      </details>
                    </Card>
                    <Card
                      title="Venues / training locations"
                      note="Manage your training grounds and facilities."
                      action={
                        <button
                          ref={venueTrigger}
                          type="button"
                          className="as-button"
                          disabled={
                            w.busy ||
                            !data.records.branch.length ||
                            !data.academy.modules.includes("development")
                          }
                          onClick={(e) => {
                            venueTrigger.current = e.currentTarget;
                            setVenue(null);
                          }}
                        >
                          <Plus size={16} />
                          Add venue
                        </button>
                      }
                    >
                      <div
                        className="as-venue-scroll"
                        tabIndex={0}
                        aria-label="Training locations table"
                      >
                        <table>
                          <thead>
                            <tr>
                              {[
                                "Name",
                                "Address",
                                "Type",
                                "Status",
                                "Actions",
                              ].map((title) => (
                                <th key={title}>{title}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {data.records.venue.map((item) => (
                              <tr key={item.id}>
                                <td>{item.name}</td>
                                <td>{item.location}</td>
                                <td>{item.parentVenueId ? "Zone" : "Venue"}</td>
                                <td>
                                  <span className="as-badge">Recorded</span>
                                </td>
                                <td>
                                  <details className="as-venue-actions">
                                    <summary
                                      aria-label={"Actions for " + item.name}
                                    >
                                      <MoreHorizontal size={19} />
                                    </summary>
                                    <button
                                      type="button"
                                      className="as-text-button"
                                      onClick={(e) => {
                                        venueTrigger.current = e.currentTarget;
                                        setVenue(item);
                                      }}
                                    >
                                      Edit venue
                                    </button>
                                  </details>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {!data.records.venue.length && (
                        <p>
                          No venues recorded. Add a branch, then your training
                          ground.
                        </p>
                      )}
                    </Card>
                  </div>
                  <div className="as-support-column">
                    <Card
                      title="Academy logo"
                      note="PNG under 200 KB; JPG unavailable. Recommended: 512 × 512 px."
                    >
                      <div className="as-logo-actions">
                        <Logo
                          value={s.draft.logoData}
                          name={s.draft.name}
                          large
                        />
                        <div>
                          <button
                            type="button"
                            className="as-text-button"
                            disabled={s.busy}
                            onClick={chooseLogo}
                          >
                            <Upload size={17} />
                            Change logo
                          </button>
                          <button
                            type="button"
                            className="as-text-button danger"
                            disabled={s.busy || !s.draft.logoData}
                            onClick={() => s.update("logoData", "")}
                          >
                            <Trash2 size={17} />
                            Remove
                          </button>
                        </div>
                      </div>
                      {s.errors.logoData && (
                        <p className="as-field-error" role="alert">
                          {s.errors.logoData}
                        </p>
                      )}
                    </Card>
                    <Card
                      title="Academy plan"
                      note={
                        data.subscription
                          ? "Software subscription · " +
                            data.subscription.status.toLowerCase()
                          : "Your Sportozen software subscription."
                      }
                      action={
                        data.subscription && (
                          <span className="as-badge">
                            {tierLabels[data.subscription.tier] ??
                              data.subscription.tier.replaceAll("_", " ")}
                          </span>
                        )
                      }
                    >
                      <ul className="as-plan-features">
                        {data.subscription?.modules.map((module) => (
                          <li key={module}>
                            <Check size={16} />
                            <span>{moduleLabels[module] ?? module}</span>
                          </li>
                        ))}
                      </ul>
                      {!data.subscription && (
                        <p>Subscription information is unavailable.</p>
                      )}
                      <p className="as-support-note">
                        Player training fees are managed separately in Fees.
                      </p>
                    </Card>
                  </div>
                </div>
                {isEditing && s.dirty && (
                  <div
                    className="as-save-popup"
                    role="region"
                    aria-label="Unsaved changes"
                  >
                    <div className="as-save-popup-content">
                      <div className="as-save-popup-text">
                        <strong>Unsaved changes</strong>
                        <p>Save changes to academy profile or discard.</p>
                      </div>
                      <div className="as-save-popup-actions">
                        <button
                          type="button"
                          className="as-button secondary"
                          disabled={s.busy}
                          onClick={() => {
                            s.discard();
                            setIsEditing(false);
                          }}
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          className="as-button primary"
                          disabled={s.busy}
                          onClick={async (e) => {
                            e.preventDefault();
                            const ok = await s.save();
                            if (ok) setIsEditing(false);
                          }}
                        >
                          {s.busy ? "Saving…" : "Save changes"}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </form>
              <p id="ps-save-scope" className="as-support-note">
                Save changes covers academy profile, contacts, branding,
                regional preferences and modules. Venue, staff and communication
                actions use their separate authorised workflows.
              </p>
            </>
          ) : (
            <Card title="Academy administration is unavailable for this role">
              <p>
                Use your account and notification preferences. Academy
                configuration and subscription actions require owner or admin
                permission.
              </p>
            </Card>
          ))}
        {tab === "Team" &&
          (s.permitted ? (
            <StaffSettings workspace={w} />
          ) : (
            <Card title="Staff access">
              <p>Your role cannot invite or revoke academy staff.</p>
            </Card>
          ))}
        {tab === "Sessions" &&
          (s.permitted ? (
            <>
              <Card
                title="Football session themes"
                note="Suggested themes for the academy. Coaches can also enter a Custom Theme for a session."
              >
                <form
                  className="form-stack"
                  noValidate
                  onSubmit={async (event) => {
                    event.preventDefault();
                    await s.save();
                  }}
                >
                  <label>
                    Suggested session themes · one per line
                    <textarea
                      aria-label="Suggested session themes"
                      rows={8}
                      value={sessionThemes(s.draft).join("\n")}
                      disabled={s.busy}
                      aria-invalid={Boolean(s.errors.sessionThemes)}
                      aria-describedby={
                        s.errors.sessionThemes
                          ? "session-themes-error"
                          : undefined
                      }
                      onChange={(event) =>
                        s.update(
                          "sessionThemes",
                          event.target.value.split("\n"),
                        )
                      }
                    />
                  </label>
                  {s.errors.sessionThemes && (
                    <small id="session-themes-error" className="as-field-error">
                      {s.errors.sessionThemes}
                    </small>
                  )}
                  <p>
                    Use 1–30 distinct football themes, up to 200 characters
                    each. Existing session themes and approved snapshots stay
                    unchanged.
                  </p>
                  <button
                    type="submit"
                    className="as-button as-primary"
                    disabled={s.busy}
                  >
                    Save session preferences
                  </button>
                  {s.notice && <p role="status">{s.notice}</p>}
                  {s.error && <p role="alert">{s.error}</p>}
                </form>
              </Card>
              <AcademyStructure workspace={w} sportId="football" />
            </>
          ) : (
            <Card title="Session preferences">
              <p>
                Recorded branch schedules and academy defaults are managed by
                your academy administrator.
              </p>
            </Card>
          ))}
        {tab === "Notifications" &&
          (parent ? (
            <ParentPreferences
              key={playerId ?? "account"}
              workspace={w}
              playerId={playerId}
            />
          ) : (
            <CommunicationSettingsPanel workspace={w} />
          ))}
        {tab === "Integrations" && <CommunicationSettingsPanel workspace={w} />}
        {tab === "Account" && <AccountSettings workspace={w} />}
      </div>
      {venue !== undefined && (
        <VenueEditor
          key={venue?.id ?? "new"}
          workspace={w}
          initial={venue}
          returnFocus={venueTrigger}
          onClose={() => setVenue(undefined)}
        />
      )}
      <Dialog.Root open={review} onOpenChange={setReview}>
        <Dialog.Portal>
          <Dialog.Overlay className="ps-overlay" />
          <Dialog.Content
            className="portal-settings ps-dialog"
            style={{ "--hd-green": data.academy.brandAccent } as CSSProperties}
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              const target = save.current?.disabled
                ? form.current?.elements.namedItem("name")
                : save.current;
              if (target instanceof HTMLElement) target.focus();
            }}
          >
            <Dialog.Title>Review saved configuration</Dialog.Title>
            <Dialog.Description>
              Your draft remains unchanged. Review the current saved record
              before retrying. Keeping your draft applies its entered fields on
              the next save.
            </Dialog.Description>
            <dl className="ps-review">
              {[
                ["Academy", data.academy.name],
                ["Location", data.academy.location],
                ["About", data.academy.about],
                ["Email", data.academy.contactEmail],
                ["Phone", data.academy.phone],
                ["Website", data.academy.website],
                ["Time zone", data.academy.timezone],
                ["City", data.academy.city],
                [
                  "Country / currency",
                  data.academy.country + " / " + data.academy.currency,
                ],
                ["Locale", data.academy.dateLocale],
                ["Language", data.academy.language],
                [
                  "Week starts",
                  data.academy.weekStartsOn === 0 ? "Sunday" : "Monday",
                ],
                ["Date format", data.academy.dateFormat],
                ["Time format", data.academy.timeFormat],
                ["Measurement", data.academy.measurementSystem],
                ["Brand accent", data.academy.brandAccent],
                ["Age categories", data.academy.ageGroups.join(", ")],
                ["Review frequency", data.academy.reviewFrequency],
                ["Modules", data.academy.modules.join(", ")],
                ["Saved version", String(data.academy.configVersion ?? 0)],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value || "Not recorded"}</dd>
                </div>
              ))}
            </dl>
            <p>Saved academy logo</p>
            <Logo value={data.academy.logoData} name={data.academy.name} />
            <button
              type="button"
              className="as-button primary"
              disabled={
                (data.academy.configVersion ?? 0) < (s.base.configVersion ?? 0)
              }
              onClick={() => {
                s.keepDraftWithSavedVersion();
                setReview(false);
              }}
            >
              Keep draft with reviewed version
            </button>
            <button
              type="button"
              className="as-button"
              onClick={() => {
                s.discard();
                setReview(false);
              }}
            >
              Discard draft and load saved values
            </button>
            <Dialog.Close
              className="ps-close"
              aria-label="Close configuration review"
            >
              <X size={20} />
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
function VenueEditor({
  workspace: w,
  initial,
  onClose,
  returnFocus,
}: {
  workspace: Controller;
  initial: FootballVenue | null;
  onClose: () => void;
  returnFocus: RefObject<HTMLButtonElement | null>;
}) {
  const data = w.data!,
    [name, setName] = useState(initial?.name ?? ""),
    [branchId, setBranch] = useState(initial?.branchId ?? ""),
    [location, setLocation] = useState(initial?.location ?? ""),
    [parentVenueId, setParent] = useState(initial?.parentVenueId ?? ""),
    [exclusive, setExclusive] = useState(initial?.exclusive ?? true),
    [independent, setIndependent] = useState(
      initial?.independentChildren ?? false,
    ),
    [buffer, setBuffer] = useState(initial?.bufferMinutes ?? 0),
    [error, setError] = useState("");
  const submission = useRef<{ digest: string; requestId: string } | undefined>(
    undefined,
  );
  const dirty =
    name !== (initial?.name ?? "") ||
    branchId !== (initial?.branchId ?? "") ||
    location !== (initial?.location ?? "") ||
    parentVenueId !== (initial?.parentVenueId ?? "") ||
    exclusive !== (initial?.exclusive ?? true) ||
    independent !== (initial?.independentChildren ?? false) ||
    buffer !== (initial?.bufferMinutes ?? 0);
  useUnsavedChanges(dirty);
  const close = () => {
    if (
      !w.busy &&
      (!dirty || window.confirm("Discard unsaved training-location changes?"))
    )
      onClose();
  };
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="ps-overlay" />
        <Dialog.Content
          className="portal-settings ps-dialog"
          style={{ "--hd-green": data.academy.brandAccent } as CSSProperties}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            returnFocus.current?.focus();
          }}
        >
          <Dialog.Title>
            {initial ? "Edit training location" : "Add training location"}
          </Dialog.Title>
          <Dialog.Description>
            Locations and zones remain linked to their recorded branch. Existing
            session snapshots will not be rewritten.
          </Dialog.Description>
          <form
            className="ps-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setError("");
              const values = {
                name,
                branchId,
                location,
                parentVenueId: parentVenueId || undefined,
                exclusive,
                independentChildren: independent,
                bufferMinutes: buffer,
              };
              const digest = JSON.stringify(values);
              if (!submission.current || submission.current.digest !== digest)
                submission.current = { digest, requestId: crypto.randomUUID() };
              const result = await w.training({
                action: "venue",
                requestId: submission.current.requestId,
                id: initial?.id,
                expectedVersion: initial?.version ?? 0,
                data: values,
              });
              if (result) onClose();
              else
                setError(
                  "The training location was not saved. Review the current values and retry.",
                );
            }}
          >
            <label className="as-field">
              Name
              <input
                name="name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="as-field">
              Branch
              <select
                required
                value={branchId}
                onChange={(e) => {
                  setBranch(e.target.value);
                  setParent("");
                }}
              >
                <option value="">Choose branch</option>
                {data.records.branch.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="as-field">
              Address / location
              <input
                required
                value={location}
                onChange={(e) => setLocation(e.target.value)}
              />
            </label>
            <label className="as-field">
              Parent venue (optional zone)
              <select
                value={parentVenueId}
                onChange={(e) => setParent(e.target.value)}
              >
                <option value="">Independent venue</option>
                {data.records.venue
                  .filter(
                    (item) =>
                      item.branchId === branchId && item.id !== initial?.id,
                  )
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
              </select>
            </label>
            <label className="ps-check">
              <input
                type="checkbox"
                checked={exclusive}
                onChange={(e) => setExclusive(e.target.checked)}
              />
              Exclusive space during a session
            </label>
            <label className="ps-check">
              <input
                type="checkbox"
                checked={independent}
                onChange={(e) => setIndependent(e.target.checked)}
              />
              Child zones can be booked independently
            </label>
            <label className="as-field">
              Scheduling buffer (minutes)
              <input
                type="number"
                min={0}
                max={120}
                value={buffer}
                onChange={(e) => setBuffer(Number(e.target.value))}
              />
            </label>
            {(error || w.error) && <p role="alert">{w.error || error}</p>}
            <button className="as-button primary" disabled={w.busy}>
              {w.busy ? "Saving…" : "Save training location"}
            </button>
          </form>
          <Dialog.Close
            className="ps-close"
            aria-label="Close location editor"
            disabled={w.busy}
          >
            <X size={20} />
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
function StaffSettings({ workspace: w }: { workspace: Controller }) {
  const data = w.data!,
    [revoke, setRevoke] = useState<string>(),
    [replacement, setReplacement] = useState(""),
    [leaveUnassigned, setLeaveUnassigned] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null),
    members = useRef<HTMLDivElement>(null);
  const revoking = data.members.find((m) => m.id === revoke),
    revokingCoach = revoking?.role === "COACH" && revoking.active;
  return (
    <>
      <InvitePeople workspace={w} />
      <Card
        title="Staff and access"
        note="Academy membership is separate from Sportozen platform administration."
      >
        <div
          className="as-venue-scroll"
          tabIndex={0}
          ref={members}
          aria-label="Academy memberships"
        >
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.members.map((member) => (
                <tr key={member.id}>
                  <td>{member.name}</td>
                  <td>{roleLabels[member.role]}</td>
                  <td>{member.active ? "Active" : "Inactive"}</td>
                  <td>
                    {member.active && member.role !== "OWNER" && (
                      <button
                        type="button"
                        className="as-text-button danger"
                        onClick={(e) => {
                          trigger.current = e.currentTarget;
                          setRevoke(member.id);
                        }}
                      >
                        Revoke access
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Dialog.Root
        open={!!revoke}
        onOpenChange={(open) => {
          if (!open && !w.busy) setRevoke(undefined);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="ps-overlay" />
          <Dialog.Content
            className="portal-settings ps-dialog"
            style={{ "--hd-green": data.academy.brandAccent } as CSSProperties}
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              (trigger.current?.isConnected
                ? trigger.current
                : members.current
              )?.focus();
            }}
          >
            <Dialog.Title>Revoke academy access?</Dialog.Title>
            <Dialog.Description>
              This removes this membership’s access. Historical records remain.
              The academy owner cannot be revoked.
            </Dialog.Description>
            {revokingCoach && (
              <fieldset>
                <legend>Hand over this coach’s work</legend>
                <p>
                  Their players, upcoming sessions and weekly series move to the
                  coach you choose. Sessions already held keep their coach.
                </p>
                <label>
                  Replacement coach
                  <select
                    value={replacement}
                    disabled={leaveUnassigned}
                    onChange={(event) => setReplacement(event.target.value)}
                  >
                    <option value="">Choose a replacement</option>
                    {data.members
                      .filter(
                        (m) =>
                          m.active &&
                          m.id !== revoke &&
                          ["OWNER", "ADMIN", "COACH"].includes(m.role),
                      )
                      .map((m) => (
                        <option key={m.id} value={m.userId}>
                          {m.name} · {roleLabels[m.role]}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={leaveUnassigned}
                    onChange={(event) => {
                      setLeaveUnassigned(event.target.checked);
                      if (event.target.checked) setReplacement("");
                    }}
                  />
                  Leave their players and sessions unassigned for now
                </label>
              </fieldset>
            )}
            {w.error && <p role="alert">{w.error}</p>}
            <button
              type="button"
              className="as-button danger"
              disabled={w.busy}
              onClick={async () => {
                const handover = revokingCoach
                  ? replacement
                    ? { replacementCoachId: replacement }
                    : leaveUnassigned
                      ? { leaveUnassigned: true }
                      : undefined
                  : undefined;
                if (revoke && (await w.action("revoke", revoke, handover))) {
                  setRevoke(undefined);
                  setReplacement("");
                  setLeaveUnassigned(false);
                }
              }}
            >
              Confirm revocation
            </button>
            <Dialog.Close className="as-button" disabled={w.busy}>
              Cancel
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
const inviteRoles = [
  { value: "COACH", label: "Coach", note: "Staff who run sessions" },
  { value: "PARENT", label: "Parent", note: "Sees their child only" },
] as const;
type PendingInvitation = {
  id: string;
  email: string;
  /** A player link: not tied to an address; it works once, for whoever holds it. */
  open?: boolean;
  role: string;
  players: string[];
  expiresAt: string;
  state: "PENDING" | "ACCEPTED" | "EXPIRED";
};
/** Ready-to-share text for one link; sharing is always the owner's own action. */
function shareText(academy: string, role: string, link: string) {
  const as =
    role === "COACH" ? "a coach" : role === "PLAYER" ? "a player" : "a parent";
  return `${academy} has invited you to join as ${as}. Open this link to set up your sign-in: ${link}`;
}
function LinkBox({
  link,
  academy,
  role,
  email,
  phone,
  callingCode,
  note,
}: {
  link: string;
  academy: string;
  role: string;
  email: string;
  phone?: string;
  callingCode?: string | null;
  note?: string;
}) {
  const [copied, setCopied] = useState(false),
    field = useRef<HTMLInputElement>(null);
  return (
    <div className="ps-linkbox" role="group" aria-label="Invitation to share">
      <p role="status">
        Link ready{email ? ` for ${email}` : ""}. It works once and expires in 7 days.
        {note ? ` ${note}` : ""}
      </p>
      <input
        ref={field}
        readOnly
        aria-label="Invitation link"
        value={link}
        onFocus={(e) => e.currentTarget.select()}
      />
      <div className="ps-linkbox-actions">
        <button
          type="button"
          className="as-button primary"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(link);
            } catch {
              field.current?.select();
              document.execCommand("copy");
            }
            setCopied(true);
            setTimeout(() => setCopied(false), 2500);
          }}
        >
          {copied ? "Link copied" : "Copy link"}
        </button>
        <a
          className="as-button"
          target="_blank"
          rel="noopener noreferrer"
          href={whatsappLink(
            phone,
            shareText(academy, role, link),
            callingCode ?? null,
          )}
        >
          {phone ? "Send on WhatsApp" : "Share on WhatsApp"}
        </a>
        {email && (
          <>
            <a
              className="as-button"
              href={mailtoLink(
                email,
                `Your invitation to ${academy}`,
                shareText(academy, role, link),
              )}
            >
              Send by email
            </a>
            <a
              className="as-button"
              target="_blank"
              rel="noopener noreferrer"
              href={gmailLink(
                email,
                `Your invitation to ${academy}`,
                shareText(academy, role, link),
              )}
            >
              Send with Gmail
            </a>
          </>
        )}
      </div>
    </div>
  );
}
/** Invite a coach, a parent or a player: the academy gets a link to share by hand. */
function InvitePeople({ workspace: w }: { workspace: Controller }) {
  const data = w.data!,
    academyId = data.academy.id,
    [email, setEmail] = useState(""),
    [phone, setPhone] = useState(""),
    [role, setRole] = useState<string>("COACH"),
    [players, setPlayers] = useState<string[]>([]),
    [verified, setVerified] = useState(false),
    [link, setLink] = useState(""),
    [queued, setQueued] = useState(false),
    [pending, setPending] = useState<PendingInvitation[]>([]),
    [fresh, setFresh] = useState<{ id: string; link: string }>(),
    [problem, setProblem] = useState(""),
    [listVersion, setListVersion] = useState(0);
  const origin = () => window.location.origin;
  // Reading the list is a convenience: creating a link does not depend on it.
  useEffect(() => {
    let current = true;
    workspaceRequest<{ invitations: PendingInvitation[] }>(
      `/api/workspaces/${academyId}/invitations`,
      "GET",
    )
      .then((result) => {
        if (current) setPending(result.invitations);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [academyId, listVersion]);
  const load = () => setListVersion((version) => version + 1);
  const reset = () => {
    setLink("");
    setProblem("");
  };
  const waiting = pending.filter((item) => item.state === "PENDING");
  return (
    <Card
      title="Invite people"
      note="Create a link for a coach or a parent. They open it, choose a password (or use Google) and are in. Send it yourself, free, from your own WhatsApp or mail app. For a player, use Players, Add player with invitation link: the player signs in and fills in their own details."
    >
      <form
        className="ps-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setProblem("");
          if (
            phone.trim() &&
            !normalizePhone(
              phone,
              COUNTRY_CALLING_CODE[data.academy.country] ?? null,
            )
          ) {
            setProblem(
              "Enter the WhatsApp number with its country code, for example +91 98765 43210, or leave it empty.",
            );
            return;
          }
          const result = await w.action<{ token: string; status?: string }>(
            "invite",
            undefined,
            {
              email,
              role,
              playerIds: role === "COACH" ? [] : players,
              guardianVerified: verified,
            },
          );
          if (result) {
            setLink(`${origin()}/join/${result.token}`);
            setQueued(result.status === "QUEUED");
            setFresh(undefined);
            load();
          }
        }}
      >
        <fieldset className="ps-roles">
          <legend>Who are you inviting?</legend>
          {inviteRoles.map((item) => (
            <label key={item.value} className="ps-role">
              <input
                type="radio"
                name="invite-role"
                value={item.value}
                disabled={w.busy}
                checked={role === item.value}
                onChange={() => {
                  reset();
                  setRole(item.value);
                  setPlayers([]);
                  setVerified(false);
                }}
              />
              <span>
                <strong>{item.label}</strong>
                <small>{item.note}</small>
              </span>
            </label>
          ))}
        </fieldset>
        <label className="as-field">
          Their email address
          <input
            type="email"
            required
            disabled={w.busy}
            value={email}
            onChange={(e) => {
              reset();
              setEmail(e.target.value);
            }}
          />
        </label>
        <label className="as-field">
          Their WhatsApp number (optional)
          <input
            type="tel"
            disabled={w.busy}
            value={phone}
            placeholder="+91 98765 43210"
            onChange={(e) => {
              reset();
              setPhone(e.target.value);
            }}
          />
          <small>
            Only used to open WhatsApp on your device with the link ready. It
            is not stored.
          </small>
        </label>
        {role !== "COACH" && (
          <>
              <fieldset>
                <legend>Their children</legend>
                {data.records.player.map((player) => (
                  <label key={player.id} className="ps-check">
                    <input
                      type="checkbox"
                      disabled={w.busy}
                      checked={players.includes(player.id)}
                      onChange={(e) => {
                        reset();
                        setPlayers(
                          e.target.checked
                            ? [...players, player.id]
                            : players.filter((id) => id !== player.id),
                        );
                      }}
                    />
                    {player.name}
                  </label>
                ))}
              </fieldset>
            <label className="ps-check">
              <input
                type="checkbox"
                required
                disabled={w.busy}
                checked={verified}
                onChange={(e) => {
                  reset();
                  setVerified(e.target.checked);
                }}
              />
              I confirm this person is the child’s parent or guardian
            </label>
          </>
        )}
        <button
          className="as-button primary"
          disabled={
            w.busy ||
            (role === "PARENT" && !players.length)
          }
        >
          Create invitation link
        </button>
        {link && (
          <LinkBox
            link={link}
            academy={data.academy.name}
            role={role}
            email={email}
            phone={phone}
            callingCode={COUNTRY_CALLING_CODE[data.academy.country] ?? null}
            note={
              queued
                ? "An email with this link was also queued for delivery."
                : undefined
            }
          />
        )}
        {(problem || w.error) && <p role="alert">{problem || w.error}</p>}
      </form>
      {!!waiting.length && (
        <div className="ps-pending">
          <h3>Waiting to join</h3>
          <ul>
            {waiting.map((item) => (
              <li key={item.id}>
                <div>
                  <strong>
                    {item.open ? "Player link (anyone with it, once)" : item.email}
                  </strong>
                  <small>
                    {item.role === "PLAYER"
                      ? "Player"
                      : item.role === "COACH"
                        ? "Coach"
                        : "Parent"}
                    {item.players.length ? ` · ${item.players.join(", ")}` : ""}
                    {" · "}expires{" "}
                    {new Date(item.expiresAt).toLocaleDateString()}
                  </small>
                </div>
                <div className="ps-pending-actions">
                  <button
                    type="button"
                    className="as-text-button"
                    disabled={w.busy}
                    onClick={async () => {
                      setProblem("");
                      try {
                        const result = await workspaceRequest<{
                          token: string;
                        }>(
                          `/api/workspaces/${academyId}/invitations/${item.id}`,
                          "POST",
                        );
                        setFresh({
                          id: item.id,
                          link: `${origin()}/join/${result.token}`,
                        });
                        setLink("");
                      } catch (failure) {
                        setProblem(
                          failure instanceof Error
                            ? failure.message
                            : "Could not make a new link.",
                        );
                      }
                    }}
                  >
                    New link
                  </button>
                  <button
                    type="button"
                    className="as-text-button danger"
                    disabled={w.busy}
                    onClick={async () => {
                      setProblem("");
                      try {
                        await workspaceRequest(
                          `/api/workspaces/${academyId}/invitations/${item.id}`,
                          "DELETE",
                        );
                        if (fresh?.id === item.id) setFresh(undefined);
                        load();
                      } catch (failure) {
                        setProblem(
                          failure instanceof Error
                            ? failure.message
                            : "Could not cancel the invitation.",
                        );
                      }
                    }}
                  >
                    Cancel
                  </button>
                </div>
                {fresh?.id === item.id && (
                  <LinkBox
                    link={fresh.link}
                    academy={data.academy.name}
                    role={item.role}
                    email={item.email}
                    note="The earlier link no longer works."
                  />
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
/** The signed-in person's own WhatsApp number: saved once, used by the academy for messages, never asked for again. */
function MyWhatsAppNumber({ workspace: w }: { workspace: Controller }) {
  const d = w.data!,
    [saved, setSaved] = useState<string | null>(null),
    [value, setValue] = useState(""),
    [busy, setBusy] = useState(false),
    code = COUNTRY_CALLING_CODE[d.academy.country] ?? null,
    bad = !!value.trim() && !normalizePhone(value, code);
  const academyId = d.academy.id;
  useEffect(() => {
    let live = true;
    // A plain read: it must not refresh every workspace record the way a save does.
    workspaceRequest<{ phone: string | null }>(
      `/api/workspaces/${academyId}/actions`,
      "POST",
      { action: "myPhone", data: {} },
    )
      .then((r) => {
        if (live) setSaved(r.phone);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [academyId]);
  return (
    <form
      className="ps-phone"
      aria-label="Your WhatsApp number"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const result = await w.action<{ phone: string | null }>(
          "setPhone",
          undefined,
          { userId: d.viewer?.id, phone: value },
        );
        setBusy(false);
        if (result) {
          setSaved(result.phone);
          setValue("");
        }
      }}
    >
      <label>
        Your WhatsApp number
        <input
          type="tel"
          autoComplete="tel"
          placeholder="+91 98765 43210"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </label>
      <button
        type="submit"
        className="as-button"
        disabled={busy || bad || !value.trim()}
      >
        {saved ? "Change number" : "Save number"}
      </button>
      <small className="muted">
        {saved
          ? `Saved (ending ${saved.slice(-4)}). The academy uses it to WhatsApp you.`
          : "Add it once and the academy can WhatsApp you. You will not be asked again."}
      </small>
    </form>
  );
}
function AccountSettings({ workspace: w }: { workspace: Controller }) {
  const session = authClient.useSession(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <Card
      title="Your account"
      note="Your identity and membership are verified by the existing authentication service."
    >
      <p>{session.data?.user.name || "Signed-in account"}</p>
      <p>{session.data?.user.email}</p>
      <p>Academy role: {roleLabels[w.data!.membership.role]}</p>
      <MyWhatsAppNumber workspace={w} />
      <button
        type="button"
        data-leave-editor
        className="as-button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            const result = await authClient.signOut();
            if (result.error)
              setError(result.error.message || "Sign out failed.");
            else navigatePrivateWorkspace("/sign-in");
          } catch (failure) {
            setError(
              failure instanceof Error
                ? failure.message
                : "Sign out failed. Please retry.",
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        Sign out
      </button>
      {error && <p role="alert">{error}</p>}
    </Card>
  );
}
