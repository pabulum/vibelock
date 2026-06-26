import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Self-hosted (bundled) brand fonts — Space Grotesk for the wordmark/headings, Archivo italic for
// hero flavor lines. Bundled rather than linked from Google Fonts so they stay same-origin (no CSP
// change, no third-party request that sees visitor IPs). Both are OFL-licensed.
import '@fontsource/space-grotesk/500.css'
import '@fontsource/space-grotesk/700.css'
import '@fontsource/archivo/400-italic.css'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
