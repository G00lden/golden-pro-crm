import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import {LandingPage} from './pages/Landing.tsx';
import './index.css';

// Public landing route — served without auth at /landing.
// Destination for paid ads (Meta / TikTok / Snap / Google).
// See docs/brand-identity.md and docs/commercial-release-checklist.md §5.
const isLanding = typeof window !== 'undefined' && window.location.pathname === '/landing';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isLanding ? <LandingPage /> : <App />}
  </StrictMode>,
);
