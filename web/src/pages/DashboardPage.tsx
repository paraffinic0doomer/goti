import { Link } from 'react-router-dom';

import { api } from '../api/client';
import { useAsync } from '../hooks/useAsync';
import {
  Amount,
  Button,
  Card,
  Empty,
  ErrorBanner,
  Loading,
  StatusBadge,
} from '../components/ui';
import { useAuth } from '../auth/AuthContext';

/**
 * Wallet dashboard.
 *
 * Balance and history are two SEPARATE calls, deliberately:
 *
 *   GET /wallet          → uncached, straight from PostgreSQL
 *   GET /transactions    → reads the ledger via its composite index
 *
 * The full wallet endpoint is used rather than `/wallet/balance` because the
 * cached variant can be up to five seconds stale, and the number a user sees
 * immediately after sending money should be the authoritative one. The cached
 * endpoint is demonstrated on the monitoring page, where its `cached` flag is
 * the interesting part.
 */
export function DashboardPage(): JSX.Element {
  const { session } = useAuth();

  const wallet = useAsync(() => api.wallet.get(), []);
  // Security state and budget are shown on the dashboard because both change
  // what a user can actually spend — burying them one click away means someone
  // discovers a freeze or a reservation only when a transfer is refused.
  const security = useAsync(() => api.security.state(), []);
  const budget = useAsync(() => api.envelopes.list(), []);
  const history = useAsync(() => api.transactions.list({ page: 1, pageSize: 8 }), []);

  const refreshAll = (): void => {
    wallet.reload();
    history.reload();
  };

  return (
    <div className="space-y-6">
      {security.data && security.data.status !== 'ACTIVE' && (
        <div className="border border-debit bg-debit-soft px-4 py-3" role="alert">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.09em] text-debit">
            Wallet {security.data.status}
          </p>
          <p className="mt-1 text-sm text-ink">
            {security.data.freezeReason ?? 'Outgoing transfers are blocked.'}
            {security.data.canReceive && ' Money can still arrive.'}
          </p>
          <Link
            to="/security"
            className="mt-1 inline-block font-mono text-[11px] text-debit underline underline-offset-2"
          >
            Manage security
          </Link>
        </div>
      )}

      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.09em] text-ink-faint">
            Signed in as
          </p>
          <h1 className="text-2xl font-semibold text-ink">{session?.displayName}</h1>
          <p className="font-mono text-sm text-ink-soft">{session?.phone}</p>
        </div>

        <div className="flex gap-2">
          <Link to="/send">
            <Button>Send money</Button>
          </Link>
          <Link to="/requests">
            <Button variant="secondary">Request money</Button>
          </Link>
          <Link to="/security">
            <Button variant="secondary">Security</Button>
          </Link>
        </div>
      </header>

      {/* ---- Balance ---- */}
      <Card
        title="Current balance"
        action={
          <Button variant="secondary" onClick={refreshAll} className="px-3 py-1 text-xs">
            Refresh
          </Button>
        }
      >
        {wallet.loading ? (
          <Loading label="Reading balance" />
        ) : wallet.error ? (
          <ErrorBanner error={wallet.error} onRetry={wallet.reload} />
        ) : wallet.data ? (
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              {/* Rendered from the backend's own formatted string. The frontend
                  performs no balance arithmetic — that is the backend's job and
                  a second implementation here could disagree with it. */}
              <p className="font-mono text-4xl font-semibold tabular-nums text-ink">
                {wallet.data.balanceFormatted}
              </p>
              <p className="mt-1 font-mono text-xs text-ink-faint">
                Wallet {wallet.data.walletId.slice(0, 8)}… · {wallet.data.currency}
              </p>
            </div>
            <div className="text-right">
              <StatusBadge status={wallet.data.status} />
              {budget.data && Number(budget.data.reservedPoisha) > 0 && (
                <p className="mt-2 font-mono text-xs text-ink-soft">
                  spendable{' '}
                  <span className="text-taka">{budget.data.spendableFormatted}</span>
                  <span className="text-ink-faint">
                    {' '}
                    · {budget.data.reservedFormatted} reserved
                  </span>
                </p>
              )}
            </div>
          </div>
        ) : null}
      </Card>

      {/* ---- Recent transactions ---- */}
      <Card
        title="Recent transactions"
        action={
          <Link
            to="/transactions"
            className="font-mono text-[11px] uppercase tracking-[0.07em] text-taka underline underline-offset-2"
          >
            View all
          </Link>
        }
      >
        {history.loading ? (
          <Loading label="Loading history" />
        ) : history.error ? (
          <ErrorBanner error={history.error} onRetry={history.reload} />
        ) : !history.data || history.data.items.length === 0 ? (
          <Empty message="No transactions yet. Send money to get started." />
        ) : (
          <ul className="divide-y divide-rule">
            {history.data.items.map((item) => (
              <li key={`${item.transactionId}-${item.direction}`}>
                <Link
                  to={`/transactions/${item.transactionId}`}
                  className="flex items-center justify-between gap-4 py-3 transition-colors hover:bg-surface-alt"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">
                      {item.direction === 'SENT' ? 'To' : 'From'} {item.counterpartyName}
                    </p>
                    <p className="mt-0.5 font-mono text-xs text-ink-faint">
                      {new Date(item.occurredAt).toLocaleString()}
                      {item.note ? ` · ${item.note}` : ''}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-3">
                    <StatusBadge status={item.status} />
                    <Amount
                      formatted={item.amountFormatted}
                      direction={item.direction}
                      className="text-sm font-semibold"
                    />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
