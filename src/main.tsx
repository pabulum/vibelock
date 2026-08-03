import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Self-hosted (bundled) brand fonts, three families with one job each: Space Grotesk for the
// wordmark and headings, Archivo for running text, IBM Plex Mono for every number, label and
// identifier. Latin subsets only — the UI has no non-latin copy, and the cyrillic/greek faces
// @fontsource also ships would triple the payload for nothing. Bundled rather than linked from
// Google Fonts so they stay same-origin (no CSP change, no third-party request that sees visitor
// IPs). All three are OFL-licensed.
import "@fontsource/space-grotesk/latin-500.css";
import "@fontsource/space-grotesk/latin-700.css";
import "@fontsource/archivo/latin-400.css";
import "@fontsource/archivo/latin-500.css";
import "@fontsource/archivo/latin-600.css";
import "@fontsource/archivo/latin-700.css";
import "@fontsource/archivo/latin-400-italic.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-600.css";
import "./tokens.css";
import "./index.css";
import App from "./App.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { applyTheme } from "./lib/theme";

// Before the first render, not inside a component: a pinned light/dark preference has to reach
// <html> ahead of the first paint or the page flashes the system scheme first. The usual fix is an
// inline <script> in index.html, which our CSP (script-src 'self') rightly forbids — this module
// runs early enough, since the only thing painted before it is an empty page background.
applyTheme();

// The boundary wraps <App/> here rather than inside it: a throw from the query provider itself (a
// corrupt persisted cache is the realistic one) has to be caught by something *outside* the
// provider, and that's also the only place a fallback can still render after the tree unmounts.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary scope="root" what="Vibelock">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
