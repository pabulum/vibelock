import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Content-Security-Policy, injected into index.html at *build* time only. We can't ship it as a
// static <meta> in index.html because Vite's dev server (HMR) relies on inline scripts and eval,
// which a strict script-src would block — so dev would break. GitHub Pages can't set response
// headers, so a build-time <meta> is how we get a CSP onto the deployed site at all.
//
// The app's network surface is mostly two hosts: it fetches analytics/asset JSON from
// api.deadlock-api.com and loads icons from assets-bucket.deadlock-api.com. style-src needs
// 'unsafe-inline' because the UI sets inline style={} attributes (souls-bar widths, slot colors);
// since output is rendered as text/attributes (no dangerouslySetInnerHTML anywhere), this doesn't
// open a script vector.
//
// The in-game build export (lib/heroBuildCache) lazy-loads Pyodide (CPython in WASM) to read
// Deadlock's binary KV3 save file in the browser. That widens the policy only for that feature
// (it activates only when the export panel is opened):
//   - cdn.jsdelivr.net: the Pyodide loader (script-src) + the WASM runtime and C-extension wheels
//     it pulls (lz4/zstandard/… — connect-src).
//   - pypi.org + files.pythonhosted.org: micropip fetches the pure-Python `keyvalues3` wheel.
//   - 'wasm-unsafe-eval': WASM compilation. blob:: Pyodide's worker/url plumbing.
// Two follow-ups would tighten this back down: self-host the `keyvalues3` wheel (drops the two
// PyPI hosts), and/or port just the KV3 *reader* to TS (drops Pyodide + jsdelivr entirely).
const PYO_HOSTS =
  "https://cdn.jsdelivr.net https://pypi.org https://files.pythonhosted.org";
const CSP = [
  "default-src 'self'",
  // raw.githubusercontent.com serves wp-stats.json (the Lab), baked nightly onto the data branch.
  `connect-src 'self' https://api.deadlock-api.com https://raw.githubusercontent.com ${PYO_HOSTS}`,
  "img-src 'self' https://assets-bucket.deadlock-api.com data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'wasm-unsafe-eval' blob: https://cdn.jsdelivr.net",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join("; ");

function cspMeta(): Plugin {
  return {
    name: "inject-csp",
    apply: "build",
    transformIndexHtml(html) {
      return html.replace(
        "</title>",
        `</title>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      );
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  base: "/vibelock/",
  plugins: [react(), cspMeta()],
});
