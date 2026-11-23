"use client";
import { Component, type ReactNode } from "react";

/**
 * Catches a screen that failed to load or to draw. The usual cause is a page
 * left open while the application was updated: the screen's code file no longer
 * exists under the old name. Reloading fetches the new version and returns to
 * the same address. Keyed by screen, so moving to another screen starts clean.
 */
export class PortalScreenBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="portal-empty" role="alert">
        <h2>This screen could not be loaded</h2>
        <p>
          The application may have been updated while this page was open. Reload
          the page to continue; nothing you saved is lost.
        </p>
        <button
          className="button secondary"
          onClick={() => window.location.reload()}
        >
          Reload the page
        </button>
      </div>
    );
  }
}
