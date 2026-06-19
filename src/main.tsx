import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import {LandingPage} from './pages/Landing.tsx';
import {LandingModern} from './pages/LandingModern.tsx';
import {initializeTracking} from './gtm';
import {initGA4} from './ga4';
import {initMetaPixel} from './metaPixel';
import './index.css';

// ── Initialise client-side tracking (GTM, GA4, Meta Pixel) ────────────
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

const path = typeof window !== 'undefined' ? window.location.pathname : '';

// Route: /landing → old page, /landing-v2 → new modern page
let page: JSX.Element;
if (path === '/landing-v2') {
  page = <LandingModern />;
} else if (path === '/landing') {
  page = <LandingPage />;
} else {
  page = <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {page}
  </StrictMode>,
);
