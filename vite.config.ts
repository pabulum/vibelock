import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// Content-Security-Policy, injected into index.html at *build* time only. We can't ship it as a
// static <meta> in index.html because Vite's dev server (HMR) relies on inline scripts and eval,
// which a strict script-src would block — so dev would break. GitHub Pages can't set response
// headers, so a build-time <meta> is how we get a CSP onto the deployed site at all.
//
// The app's whole network surface is two hosts: it fetches analytics/asset JSON from
// api.deadlock-api.com and loads icons from assets-bucket.deadlock-api.com. Everything else is
// locked to 'self'. style-src needs 'unsafe-inline' because the UI sets inline style={} attributes
// (souls-bar widths, slot colors); since output is rendered as text/attributes (no
// dangerouslySetInnerHTML anywhere), this doesn't open a script vector.
const CSP = [
  "default-src 'self'",
  "connect-src 'self' https://api.deadlock-api.com",
  "img-src 'self' https://assets-bucket.deadlock-api.com data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ')

function cspMeta(): Plugin {
  return {
    name: 'inject-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '</title>',
        `</title>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      )
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  base: '/vibelock/',
  plugins: [react(), cspMeta()],
})
