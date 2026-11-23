// Wave 3 (loading): the portal's loading placeholder keeps the plain status sentence that screen readers and tests rely on,
// and its skeleton is decoration only.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PortalLoading } from "@/features/workspaces/portal-loading";

describe("PortalLoading", () => {
  it("announces the label as a status and marks the region busy", () => {
    const html = renderToStaticMarkup(createElement(PortalLoading, { label: "Loading your academy…" }));
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('<p role="status">Loading your academy…</p>');
  });
  it("hides the skeleton from assistive technology", () => {
    const html = renderToStaticMarkup(createElement(PortalLoading));
    expect(html).toContain('class="portal-skeleton" aria-hidden="true"');
    expect(html.match(/<span><\/span>/g)).toHaveLength(3);
    // The skeleton adds no readable text of its own.
    expect(html.replace(/<[^>]+>/g, "")).toBe("Loading this screen…");
  });
  it("defaults to the wording the lazy screens always used", () => {
    expect(renderToStaticMarkup(createElement(PortalLoading))).toContain("Loading this screen…");
  });
});
