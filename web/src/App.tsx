import type { ReactNode } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';

import { useAuth } from './auth/AuthContext';
import { Button } from './components/ui';
import { LoginPage, RegisterPage } from './pages/AuthPages';
import { DashboardPage } from './pages/DashboardPage';
import { EnvelopesPage } from './pages/EnvelopesPage';
import { PotsPage } from './pages/PotsPage';
import { SecurityPage } from './pages/SecurityPage';
import { MoneyRequestsPage } from './pages/MoneyRequestsPage';
import { MonitoringPage } from './pages/MonitoringPage';
import { SendMoneyPage } from './pages/SendMoneyPage';
import { TransactionDetailPage, TransactionListPage } from './pages/TransactionPages';

/**
 * Route protection.
 *
 * This is NAVIGATION, not security. Redirecting an unauthenticated visitor to
 * the login screen is a convenience so they are not shown a page that would
 * only fill with 401s. Every endpoint behind it is guarded server-side by
 * `JwtAuthGuard`, and every use case re-checks ownership against the database.
 *
 * Bypassing this component in a browser console gets you an empty shell that
 * cannot load any data — which is the correct outcome.
 */
function RequireAuth({ children }: { children: ReactNode }): JSX.Element {
  const { isAuthenticated } = useAuth();
  const location = useLocation();

  if (!isAuthenticated) {
    // `state` preserves the intended destination so login can return there.
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}

function AppShell({ children }: { children: ReactNode }): JSX.Element {
  const { session, logout } = useAuth();

  const navItems = [
    { to: '/', label: 'Wallet', end: true },
    { to: '/transactions', label: 'Transactions', end: false },
    { to: '/envelopes', label: 'Envelopes', end: false },
    { to: '/pots', label: 'Pots', end: false },
    { to: '/requests', label: 'Requests', end: false },
    { to: '/security', label: 'Security', end: false },
    { to: '/monitor', label: 'Monitor', end: false },
  ];

  return (
    <div className="min-h-screen bg-surface-page">
      <header className="border-b border-rule bg-surface">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-6 py-3">
          <div className="flex items-center gap-6">
            <span className="font-sans text-xl font-bold tracking-tight text-ink">
              Goti <span className="text-taka">/</span> গতি
            </span>

            <nav className="flex gap-1">
              {navItems.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    `border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.07em] transition-colors ${
                      isActive
                        ? 'border-taka bg-taka-soft text-taka'
                        : 'border-transparent text-ink-soft hover:bg-surface-alt'
                    }`
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </div>

          <div className="flex items-center gap-3">
            <span className="font-mono text-xs text-ink-faint">{session?.phone}</span>
            <Button variant="secondary" onClick={logout} className="px-3 py-1 text-xs">
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>

      <footer className="mx-auto max-w-5xl px-6 pb-8">
        <p className="border-t border-rule pt-4 font-mono text-[11px] uppercase tracking-[0.07em] text-ink-faint">
          Goti · গতি — motion · PostgreSQL is the source of truth · the backend decides
        </p>
      </footer>
    </div>
  );
}

export function App(): JSX.Element {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />

      <Route
        path="/*"
        element={
          <RequireAuth>
            <AppShell>
              <Routes>
                <Route index element={<DashboardPage />} />
                <Route path="send" element={<SendMoneyPage />} />
                <Route path="transactions" element={<TransactionListPage />} />
                <Route path="transactions/:id" element={<TransactionDetailPage />} />
                <Route path="envelopes" element={<EnvelopesPage />} />
                <Route path="pots" element={<PotsPage />} />
                <Route path="security" element={<SecurityPage />} />
                <Route path="requests" element={<MoneyRequestsPage />} />
                <Route path="monitor" element={<MonitoringPage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </AppShell>
          </RequireAuth>
        }
      />
    </Routes>
  );
}
