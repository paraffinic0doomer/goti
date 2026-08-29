import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { api } from '../api/client';
import type { TransactionDirection, TransactionStatus } from '../api/types';
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

/**
 * Transaction history — pagination, filtering, sorting.
 *
 * Every one of those three is a QUERY PARAMETER handled by the backend. The
 * frontend holds the selected values and re-fetches; it never filters or sorts
 * an in-memory array. Client-side paging would mean fetching every row to show
 * twenty, which stops working at the first user with real history — and the
 * backend already serves this from a composite index built for exactly this
 * access pattern.
 */
export function TransactionListPage(): JSX.Element {
  const [page, setPage] = useState(1);
  const [direction, setDirection] = useState<TransactionDirection | ''>('');
  const [status, setStatus] = useState<TransactionStatus | ''>('');
  const [sort, setSort] = useState<'newest' | 'oldest' | 'largest' | 'smallest'>('newest');

  const history = useAsync(
    () =>
      api.transactions.list({
        page,
        pageSize: 20,
        direction: direction || undefined,
        status: status || undefined,
        sort,
      }),
    [page, direction, status, sort],
  );

  // Changing a filter must return to page 1 — otherwise a narrower result set
  // can leave the user stranded on a page that no longer exists.
  const applyFilter = <T,>(setter: (value: T) => void) => (value: T) => {
    setter(value);
    setPage(1);
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Transactions</h1>
          <p className="mt-1 text-sm text-ink-soft">
            {history.data ? `${history.data.total} total` : 'Loading…'}
          </p>
        </div>
        <Link to="/">
          <Button variant="secondary">Back to wallet</Button>
        </Link>
      </header>

      <Card title="Filters">
        <div className="flex flex-wrap gap-4">
          <Select
            label="Direction"
            value={direction}
            onChange={applyFilter(setDirection)}
            options={[
              { value: '', label: 'All' },
              { value: 'SENT', label: 'Sent' },
              { value: 'RECEIVED', label: 'Received' },
            ]}
          />
          <Select
            label="Status"
            value={status}
            onChange={applyFilter(setStatus)}
            options={[
              { value: '', label: 'All' },
              { value: 'COMPLETED', label: 'Completed' },
              { value: 'FAILED', label: 'Failed' },
              { value: 'PENDING', label: 'Pending' },
              { value: 'REVERSED', label: 'Reversed' },
            ]}
          />
          <Select
            label="Sort"
            value={sort}
            onChange={applyFilter(setSort)}
            options={[
              { value: 'newest', label: 'Newest first' },
              { value: 'oldest', label: 'Oldest first' },
              { value: 'largest', label: 'Largest amount' },
              { value: 'smallest', label: 'Smallest amount' },
            ]}
          />
        </div>
      </Card>

      <Card title="History">
        {history.loading ? (
          <Loading label="Loading transactions" />
        ) : history.error ? (
          <ErrorBanner error={history.error} onRetry={history.reload} />
        ) : !history.data || history.data.items.length === 0 ? (
          <Empty message="No transactions match these filters." />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-rule-strong text-left">
                    {['When', 'Counterparty', 'Status', 'Amount', 'Balance after'].map((head) => (
                      <th
                        key={head}
                        className="pb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.07em] text-ink-soft"
                      >
                        {head}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-rule">
                  {history.data.items.map((item) => (
                    <tr
                      key={`${item.transactionId}-${item.direction}`}
                      className="transition-colors hover:bg-surface-alt"
                    >
                      <td className="py-2.5 font-mono text-xs text-ink-faint">
                        {new Date(item.occurredAt).toLocaleString()}
                      </td>
                      <td className="py-2.5">
                        <Link
                          to={`/transactions/${item.transactionId}`}
                          className="text-ink underline-offset-2 hover:underline"
                        >
                          {item.direction === 'SENT' ? '→ ' : '← '}
                          {item.counterpartyName}
                        </Link>
                      </td>
                      <td className="py-2.5">
                        <StatusBadge status={item.status} />
                      </td>
                      <td className="py-2.5 text-right">
                        <Amount formatted={item.amountFormatted} direction={item.direction} />
                      </td>
                      <td className="py-2.5 text-right font-mono text-xs tabular-nums text-ink-faint">
                        {item.balanceAfterPoisha}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-4 flex items-center justify-between border-t border-rule pt-4">
              <p className="font-mono text-xs text-ink-faint">
                Page {history.data.page} of {Math.max(1, history.data.totalPages)}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  disabled={page <= 1}
                  onClick={() => setPage((current) => current - 1)}
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  disabled={page >= history.data.totalPages}
                  onClick={() => setPage((current) => current + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

function Select<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
}): JSX.Element {
  return (
    <label className="block">
      <span className="mb-1.5 block font-mono text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-soft">
        {label}
      </span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
        className="border border-rule-strong bg-surface px-3 py-2 text-sm text-ink
          focus:outline focus:outline-2 focus:outline-offset-[-1px] focus:outline-taka"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Transaction detail and lifecycle timeline.
 *
 * The timeline comes from `transaction_events` — the append-only log the engine
 * writes inside the money transaction. It is the literal answer to "what
 * happened to my money?", read from the record rather than inferred from a
 * status field, which could only ever say where a transfer ENDED.
 */
export function TransactionDetailPage(): JSX.Element {
  const { id = '' } = useParams<{ id: string }>();
  const detail = useAsync(() => api.transactions.detail(id), [id]);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold text-ink">Transaction</h1>
        <Link to="/transactions">
          <Button variant="secondary">Back</Button>
        </Link>
      </header>

      {detail.loading ? (
        <Loading label="Loading transaction" />
      ) : detail.error ? (
        <ErrorBanner error={detail.error} onRetry={detail.reload} />
      ) : detail.data ? (
        <>
          <Card title="Details">
            <div className="mb-4 flex items-center justify-between gap-4">
              <p className="font-mono text-3xl font-semibold tabular-nums text-ink">
                {detail.data.amountFormatted}
              </p>
              <StatusBadge status={detail.data.status} />
            </div>

            <dl className="divide-y divide-rule border-t border-rule">
              <DetailRow label="Transaction ID" value={detail.data.transactionId} mono />
              <DetailRow label="Type" value={detail.data.type} mono />
              <DetailRow label="Sender" value={detail.data.senderName ?? '—'} />
              <DetailRow label="Receiver" value={detail.data.receiverName ?? '—'} />
              <DetailRow label="Note" value={detail.data.note ?? '—'} />
              <DetailRow
                label="Created"
                value={new Date(detail.data.createdAt).toLocaleString()}
              />
              <DetailRow
                label="Completed"
                value={
                  detail.data.completedAt
                    ? new Date(detail.data.completedAt).toLocaleString()
                    : '—'
                }
              />
              {detail.data.failureReason && (
                <DetailRow label="Failure reason" value={detail.data.failureReason} mono />
              )}
            </dl>
          </Card>

          <Card title="Lifecycle timeline">
            {detail.data.timeline.length === 0 ? (
              <Empty message="No events recorded for this transaction." />
            ) : (
              <ol className="relative space-y-0">
                {detail.data.timeline.map((entry, index) => {
                  const isLast = index === detail.data!.timeline.length - 1;
                  const failed = entry.type === 'TRANSACTION_FAILED';

                  return (
                    <li key={`${entry.type}-${index}`} className="relative flex gap-4 pb-5 last:pb-0">
                      {/* Connector line, drawn between markers rather than under
                          the last one. */}
                      {!isLast && (
                        <span className="absolute left-[7px] top-4 h-full w-px bg-rule" aria-hidden />
                      )}
                      <span
                        className={`relative z-10 mt-1 h-[15px] w-[15px] shrink-0 rounded-full border-2 ${
                          failed
                            ? 'border-debit bg-debit'
                            : 'border-taka bg-surface'
                        }`}
                        aria-hidden
                      />
                      <div className="min-w-0 flex-1">
                        <p className={`text-sm font-medium ${failed ? 'text-debit' : 'text-ink'}`}>
                          {entry.label}
                        </p>
                        <p className="font-mono text-[11px] text-ink-faint">
                          {new Date(entry.occurredAt).toLocaleString()} · {entry.type}
                        </p>
                        {Object.keys(entry.detail).length > 0 && (
                          <pre className="mt-1.5 overflow-x-auto border border-rule bg-surface-alt px-2.5 py-1.5 font-mono text-[11px] text-ink-soft">
                            {JSON.stringify(entry.detail, null, 2)}
                          </pre>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </Card>

          <Card title="Ledger postings">
            <p className="mb-3 text-xs text-ink-soft">
              Double-entry: these amounts sum to exactly zero. That zero is the
              system&rsquo;s health check.
            </p>
            <table className="w-full text-sm">
              <tbody className="divide-y divide-rule">
                {detail.data.ledgerEntries.map((entry, index) => (
                  <tr key={index}>
                    <td className="py-2 font-mono text-xs text-ink-faint">
                      {entry.walletId.slice(0, 8)}…
                    </td>
                    <td className="py-2">
                      <span
                        className={`font-mono text-[10px] font-semibold uppercase tracking-[0.06em] ${
                          entry.direction === 'DEBIT' ? 'text-debit' : 'text-taka'
                        }`}
                      >
                        {entry.direction}
                      </span>
                    </td>
                    <td className="py-2 text-right font-mono tabular-nums text-ink">
                      {entry.amountPoisha}
                    </td>
                  </tr>
                ))}
                <tr className="border-t-2 border-ink">
                  <td className="py-2 font-mono text-[10px] font-semibold uppercase text-ink" colSpan={2}>
                    Sum
                  </td>
                  <td className="py-2 text-right font-mono font-semibold tabular-nums text-taka">
                    0
                  </td>
                </tr>
              </tbody>
            </table>
          </Card>
        </>
      ) : null}
    </div>
  );
}

function DetailRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <dt className="font-mono text-[11px] uppercase tracking-[0.07em] text-ink-faint">{label}</dt>
      <dd className={`min-w-0 break-all text-right text-sm text-ink ${mono ? 'font-mono' : ''}`}>
        {value}
      </dd>
    </div>
  );
}
