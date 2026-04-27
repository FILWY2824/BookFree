import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './lib/auth';
import { AuthGuard } from './lib/AuthGuard';
import { ToastProvider } from './components/Toast';

import LoginPage from './pages/LoginPage';
import LibraryPage from './pages/LibraryPage';
import ReaderPage from './pages/ReaderPage';
import SearchPage from './pages/SearchPage';
import NotesPage from './pages/NotesPage';
import StatsPage from './pages/StatsPage';
import SettingsPage from './pages/SettingsPage';

// Route inventory:
//
//   /             → redirect to /library
//   /login        → public auth form (login OR register toggle)
//   /library      → BookCard grid + upload     (auth)
//   /book/:id     → reader (TXT / EPUB / PDF)  (auth)
//   /search       → cross-library FTS5 search  (auth)
//   /notes        → all notes, newest first    (auth)
//   /stats        → library statistics         (auth)
//   /settings     → account + reader prefs     (auth)
export function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Navigate to="/library" replace />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/library"  element={<AuthGuard><LibraryPage /></AuthGuard>} />
            <Route path="/book/:id" element={<AuthGuard><ReaderPage /></AuthGuard>} />
            <Route path="/search"   element={<AuthGuard><SearchPage /></AuthGuard>} />
            <Route path="/notes"    element={<AuthGuard><NotesPage /></AuthGuard>} />
            <Route path="/stats"    element={<AuthGuard><StatsPage /></AuthGuard>} />
            <Route path="/settings" element={<AuthGuard><SettingsPage /></AuthGuard>} />
            <Route path="*" element={<Navigate to="/library" replace />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </AuthProvider>
  );
}
