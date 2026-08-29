import { useState } from 'react';
import { Link } from 'react-router-dom';

import { api, formatPoisha, newIdempotencyKey, takaInputToPoisha } from '../api/client';
import type { MoneyRequest } from '../api/types';
import { useAction, useAsync } from '../hooks/useAsync';
import {
  Button,
  Card,
  Empty,
  ErrorBanner,
  Field,
  Loading,
  StatusBadge,
} from '../components/ui';
import { useAuth } from '../auth/AuthContext';

/**
 * ============================================================================
 *  MONEY REQUESTS
 * ============================================================================
 *
 * A money request is a CLAIM, not money. It never touches a balance — only the
 * payer accepting it creates a transfer, and that transfer goes through the
 * identical engine path as a direct send.
 *
 * The UI reflects that: an incoming request shows an amount, but no balance
 * anywhere changes until Accept succeeds and the backend returns a transfer
 * result. Nothing here reserves, holds or projects funds.
 */
export function MoneyRequestsPage(): JSX.Element {
  const { session } = useAuth();
  const [tab, setTab] = useState<'incoming' | 'outgoing'>('incoming');

  const requests = useAsync(
    () =>
      api.moneyRequests.list({
        role: tab === 'incoming' ? 'payer' : 'requester',
        page: 1,
        pageSize: 25,
      }),
    [tab],
  );

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Money requests</h1>
          <p className="mt-1 text-sm text-ink-soft">
            A request is a claim. No balance moves until it is accepted.
          </p>
        </div>
        <Link to="/">
          <Button variant="secondary">Back to wallet</Button>
        </Link>
      </header>

      <CreateRequestForm onCreated={requests.reload} />

      <Card
        title={tab === 'incoming' ? 'Requests for you to pay' : 'Requests you sent'}
        action={
          <div className="flex gap-1">
            {(['incoming', 'outgoing'] as const).map((key) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.07em] transition-colors ${
                  tab === key
                    ? 'border-taka bg-taka text-white'
                    : 'border-rule-strong bg-surface text-ink-soft hover:bg-surface-alt'
                }`}
              >
                {key === 'incoming' ? 'Incoming' : 'Sent'}
              </button>
            ))}
          </div>
        }
      >
        {requests.loading ? (
          <Loading label="Loading requests" />
        ) : requests.error ? (
          <ErrorBanner error={requests.error} onRetry={requests.reload} />
        ) : !requests.data || requests.data.items.length === 0 ? (
          <Empty
            message={
              tab === 'incoming'
                ? 'Nobody has asked you for money.'
                : 'You have not requested money from anyone.'
            }
          />
        ) : (
          <ul className="divide-y divide-rule">
            {requests.data.items.map((request) => (
              <RequestRow
                key={request.id}
                request={request}
                // Only the payer can act, and the backend enforces that too —
                // hiding the buttons is convenience, never a control.
                actionable={tab === 'incoming' && request.payerUserId === session?.userId}
                onResolved={requests.reload}
              />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function CreateRequestForm({ onCreated }: { onCreated: () => void }): JSX.Element {
  const [payerPhone, setPayerPhone] = useState('');
  const [takaInput, setTakaInput] = useState('');
  const [note, setNote] = useState('');
  const [amountError, setAmountError] = useState<string | undefined>();

  const create = useAction(async () => {
    const amount = takaInputToPoisha(takaInput);
    if (amount === null) {
      setAmountError('Enter an amount like 250 or 250.75');
      throw new Error('invalid amount');
    }
    setAmountError(undefined);

    const result = await api.moneyRequests.create({
      payerPhone,
      amount,
      // A retried "ask Rahim for 500" must not put two claims in his inbox.
      idempotencyKey: newIdempotencyKey('REQ'),
      note: note || undefined,
    });

    setPayerPhone('');
    setTakaInput('');
    setNote('');
    onCreated();
    return result;
  });

  return (
    <Card title="Request money">
      <div className="grid gap-4 sm:grid-cols-3">
        <Field
          label="From (phone)"
          type="tel"
          placeholder="+8801712345678"
          value={payerPhone}
          onChange={(event) => setPayerPhone(event.target.value)}
        />
        <Field
          label="Amount (BDT)"
          inputMode="decimal"
          placeholder="500.00"
          error={amountError}
          value={takaInput}
          onChange={(event) => setTakaInput(event.target.value)}
        />
        <Field
          label="Note (optional)"
          maxLength={140}
          placeholder="Dinner split"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </div>

      {/* The thrown "invalid amount" is surfaced through the field, not the
          banner, so the same message does not appear twice. */}
      {create.error instanceof Error && create.error.message !== 'invalid amount' && (
        <div className="mt-4">
          <ErrorBanner error={create.error} />
        </div>
      )}

      <div className="mt-4 flex justify-end">
        <Button
          onClick={() => void create.run()}
          loading={create.pending}
          disabled={!payerPhone || !takaInput}
        >
          Send request
        </Button>
      </div>
    </Card>
  );
}

function RequestRow({
  request,
  actionable,
  onResolved,
}: {
  request: MoneyRequest;
  actionable: boolean;
  onResolved: () => void;
}): JSX.Element {
  const accept = useAction(async () => {
    // Accepting creates a TRANSFER, so it needs its own idempotency key —
    // the settlement is a money movement like any other.
    const result = await api.moneyRequests.accept(request.id, newIdempotencyKey('SETTLE'));
    onResolved();
    return result;
  });

  const reject = useAction(async () => {
    const result = await api.moneyRequests.reject(request.id);
    onResolved();
    return result;
  });

  const pending = request.status === 'REQUESTED';
  // The settlement can fail (insufficient funds) even though the API call
  // succeeded — the backend returns the request to REQUESTED in that case.
  const settlementFailed = accept.result?.transfer?.status === 'FAILED';

  return (
    <li className="flex flex-wrap items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <p className="text-sm text-ink">
          <span className="font-medium">{request.requesterName}</span>
          {' asked '}
          <span className="font-medium">{request.payerName}</span>
          {' for '}
          <span className="font-mono tabular-nums">
            {formatPoisha(request.amountPoisha, request.currency)}
          </span>
        </p>
        <p className="mt-0.5 font-mono text-xs text-ink-faint">
          {new Date(request.createdAt).toLocaleString()}
          {request.note ? ` · ${request.note}` : ''}
          {pending ? ` · expires ${new Date(request.expiresAt).toLocaleDateString()}` : ''}
        </p>

        {settlementFailed && (
          <p className="mt-1.5 text-xs text-debit">
            Settlement failed ({accept.result?.transfer?.failureReason}). The request is
            open again — top up and try once more.
          </p>
        )}
        {request.settlementTransactionId && (
          <Link
            to={`/transactions/${request.settlementTransactionId}`}
            className="mt-1 inline-block font-mono text-[11px] text-taka underline underline-offset-2"
          >
            View settlement
          </Link>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <StatusBadge status={request.status} />

        {actionable && pending && (
          <>
            <Button
              variant="secondary"
              onClick={() => void reject.run()}
              loading={reject.pending}
              className="px-3 py-1 text-xs"
            >
              Decline
            </Button>
            <Button
              onClick={() => void accept.run()}
              loading={accept.pending}
              className="px-3 py-1 text-xs"
            >
              Accept &amp; pay
            </Button>
          </>
        )}
      </div>

      {/* `unknown && JSX` is not a valid ReactNode — coerce the guard. */}
      {Boolean(accept.error ?? reject.error) && (
        <div className="w-full">
          <ErrorBanner error={accept.error ?? reject.error} />
        </div>
      )}
    </li>
  );
}
