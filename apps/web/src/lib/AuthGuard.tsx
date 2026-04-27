import { type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './auth';

// AuthGuard wraps any route that requires login. It handles three
// states:
//
//  - loading: we don't know yet (show spinner — NOT redirect).
//    Without this branch, a hard refresh on /library would redirect
//    to /login before /api/auth/me has had a chance to respond.
//  - unauthenticated: redirect to /login, preserving the intended
//    destination via state so post-login can come back here.
//  - authenticated: render children.
export function AuthGuard({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div style={{ padding: '4rem', textAlign: 'center', color: '#666' }}>
        加载中…
      </div>
    );
  }
  if (!user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  return <>{children}</>;
}
