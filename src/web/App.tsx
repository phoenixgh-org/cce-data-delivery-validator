/**
 * Client router (DESIGN §5/§13): `/` → landing, `/d/:uuid` → dashboard. A
 * BrowserRouter is used; the backend serves index.html for deep links to
 * `/d/:uuid` (SPA fallback in src/app.ts), so the client router resolves the
 * uuid from the path.
 */
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { Dashboard } from './routes/Dashboard';
import { Landing } from './routes/Landing';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/d/:uuid" element={<Dashboard />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
