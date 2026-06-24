import {StrictMode, type ReactElement} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import {LandingPage} from './pages/Landing.tsx';
import {LandingModern} from './pages/LandingModern.tsx';
import LegalPage from './pages/Legal.tsx';
import {ConsentBanner} from './components/ConsentBanner.tsx';
import {initializeTracking} from './gtm';
import {initGA4} from './ga4';
import {initMetaPixel} from './metaPixel';
import {hasConsent, onConsentChange} from './consent';
import './index.css';

// ── Client-side tracking, GATED ON CONSENT (PDPL + Meta ad-policy) ─────
// No third-party tracker loads until the visitor accepts the consent banner.
// A returning visitor who already accepted is initialised immediately.
function startTracking(): void {
  initializeTracking(import.meta.env);
  const ga4Id = import.meta.env.VITE_GA4_ID as string | undefined;
  if (ga4Id) initGA4(ga4Id);
  const metaPixelId = import.meta.env.VITE_META_PIXEL_ID as string | undefined;
  if (metaPixelId) initMetaPixel(metaPixelId);
}

if (hasConsent()) {
  startTracking();
} else {
  const off = onConsentChange((state) => {
    if (state === 'granted') {
      startTracking();
      off();
    }
  });
}
// ──────────────────────────────────────────────────────────────────────

const path = typeof window !== 'undefined' ? window.location.pathname : '';

// Routes:
//   /landing     → canonical ad-landing (light, brand-book accurate) — ad target
//   /landing-v2  → dark-mode A/B variant
//   /legal/*     → privacy / terms
//   everything else → the auth-gated CRM app
const isPublic = path === '/landing' || path === '/landing-v2' || path.startsWith('/legal/');

let page: ReactElement;
if (path.startsWith('/legal/')) {
  page = <LegalPage />;
} else if (path === '/landing-v2') {
  page = <LandingModern />;
} else if (path === '/landing') {
  page = <LandingPage />;
} else {
  page = <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {page}
    {isPublic ? <ConsentBanner /> : null}
  </StrictMode>,
);
