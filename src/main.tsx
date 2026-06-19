import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import {LandingPage} from './pages/Landing.tsx';
import {initializeTracking} from './gtm';
import {initGA4} from './ga4';
import {initMetaPixel} from './metaPixel';
import './index.css';

// ── Initialise client-side tracking (GTM, GA4, Meta Pixel) ────────────
// This runs before any React render so that GTM is loaded before the first
// trackEvent() call on the landing page. Each init function guards itself
// against multiple calls and missing env vars.
initializeTracking(import.meta.env);

const ga4Id = import.meta.env.VITE_GA4_ID as string | undefined;
if (ga4Id) {
  initGA4(ga4Id);
}

const metaPixelId = import.meta.env.VITE_META_PIXEL_ID as string | undefined;
if (metaPixelId) {
  initMetaPixel(metaPixelId);
}
// ──────────────────────────────────────────────────────────────────────

// Public landing route — served without auth at /landing.
// Destination for paid ads (Meta / TikTok / Snap / Google).
const isLanding = typeof window !== 'undefined' && window.location.pathname === '/landing';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isLanding ? <LandingPage /> : <App />}
  </StrictMode>,
);
