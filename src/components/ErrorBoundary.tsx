// The last line of defence: a render that throws.
//
// Everything the app *expects* to go wrong is already handled — a failed fetch becomes the error
// banner, a rejected schema becomes "Unexpected response shape", a missing asset degrades. What none
// of that catches is a throw during render, and React's answer to an uncaught one is to unmount the
// whole tree: a blank page, no message, no way back. That is the worst possible failure for a static
// site with no server to notice it, and the likeliest trigger is the one this project already keeps
// notes on — upstream quietly changing a payload's shape under a component that read it.
//
// So there are two levels. The root boundary keeps a crash legible and, crucially, offers the one
// recovery a no-backend app can actually need: dropping its own persisted caches, because a stored
// response that a newer schema no longer accepts would otherwise crash again on every reload. The
// per-modal boundary (see ModalShell) keeps a broken panel *local* — when the Match view died on a
// shape change, the page it was opened from had nothing wrong with it.

import { Component, type ErrorInfo, type ReactNode } from "react";
import { clearAnalyticsCache } from "../lib/idbCache";
import "./ErrorBoundary.css";

/** Drop every client-side cache and reload. Deliberately not selective: the caller is already in a
 * state we don't understand, so "start from nothing" is the only honestly safe reset. Each step is
 * independent — a private-mode profile that refuses IndexedDB must not stop the reload. */
async function resetAndReload(): Promise<void> {
  try {
    localStorage.clear();
  } catch {
    /* storage denied — nothing cached there to poison us either */
  }
  try {
    await clearAnalyticsCache();
  } catch {
    /* ignore */
  }
  // Same URL, minus any query state: a deep link is a plausible cause of the crash we're escaping.
  window.location.replace(window.location.pathname);
}

interface Props {
  children: ReactNode;
  /** What broke, in the user's terms — names the panel for a scoped boundary. */
  what?: string;
  /** Scoped boundaries render a note in place; the root one takes over the page. */
  scope?: "root" | "panel";
}

interface State {
  message: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { message: null };

  static getDerivedStateFromError(error: unknown): State {
    return {
      message: error instanceof Error ? error.message : String(error),
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // No telemetry to send it to (no backend, no tracking — see the README), so the console is the
    // whole report. Logged as an error with the component stack so a bug report can be pasted.
    console.error("Vibelock crashed:", error, info.componentStack);
  }

  render() {
    const { message } = this.state;
    if (message === null) return this.props.children;

    const what = this.props.what ?? "This";
    if (this.props.scope === "panel") {
      return (
        <div className="crash crash-panel">
          <p className="crashlead">{what} couldn&apos;t be rendered.</p>
          <p className="crashwhy">{message}</p>
          <p className="crashhint">
            The rest of the page is unaffected — close this and carry on.
          </p>
        </div>
      );
    }

    return (
      <div className="crash">
        <p className="lbl">Error</p>
        <h1 className="crashlead">{what} stopped rendering.</h1>
        {/* The raw message, not a friendly translation: this is a bug rather than a condition the
            player can act on, so the useful thing is text they can quote in an issue. */}
        <p className="crashwhy">{message}</p>
        <p className="crashhint">
          Reloading usually fixes it. If it doesn&apos;t, the second button
          clears everything Vibelock has stored in this browser — a cached
          response the app can no longer read would otherwise fail the same way
          on every reload. Nothing is lost but speed: it all re-fetches.
        </p>
        <div className="crashacts">
          <button type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
          <button type="button" onClick={() => void resetAndReload()}>
            Clear cached data and reload
          </button>
        </div>
      </div>
    );
  }
}
