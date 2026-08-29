import { useState } from 'react';
import { Link } from 'react-router-dom';

import { api, formatPoisha, newIdempotencyKey, takaInputToPoisha } from '../api/client';
import type { Pot, PotPreview } from '../api/types';
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
 *  GROUP POTS
 * ============================================================================
 *
 * A pot is a shared savings goal, and its balance lives in a real wallet — so
 * every contribution on this screen is an ordinary transfer through the
 * Transaction Engine, with the same idempotency key, the same atomic debit and
 * the same two balanced ledger postings a peer-to-peer send gets.
 *
 * That is why "collected" is never computed here by summing member cards: the
 * backend reads it from the pot's WALLET. Summing in the UI would produce a
 * second, subtly different number the moment a contribution was in flight.
 */
export function PotsPage(): JSX.Element {
  const { session } = useAuth();
  const [showCreate, setShowCreate] = useState(false);
  const [openPotId, setOpenPotId] = useState<string | null>(null);

  const pots = useAsync(() => api.pots.list({ page: 1, pageSize: 20 }), []);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Pots</h1>
          <p className="mt-1 max-w-xl text-sm text-ink-soft">
            Collect money together for a trip, a gift, a shared bill. Every contribution
            is a real transfer — the pot holds its own wallet.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setShowCreate((open) => !open)}>
            {showCreate ? 'Cancel' : 'New pot'}
          </Button>
          <Link to="/">
            <Button variant="secondary">Back to wallet</Button>
          </Link>
        </div>
      </header>

      {showCreate && (
        <CreatePotForm
          onCreated={() => {
            setShowCreate(false);
            pots.reload();
          }}
        />
      )}

      <JoinByCodePanel onJoined={pots.reload} />

      {pots.loading && !pots.data ? (
        <Loading label="Loading your pots" />
      ) : pots.error ? (
        <ErrorBanner error={pots.error} onRetry={pots.reload} />
      ) : !pots.data || pots.data.items.length === 0 ? (
        <Empty message="No pots yet. Create one and invite people to chip in." />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {pots.data.items.map((pot) => (
            <PotCard
              key={pot.id}
              pot={pot}
              currentUserId={session?.userId ?? ''}
              expanded={openPotId === pot.id}
              onToggle={() => setOpenPotId(openPotId === pot.id ? null : pot.id)}
              onChanged={pots.reload}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Join a pot from a code someone shared.
 *
 * This panel is the ONLY way into a pot you did not create. `GET /pots` returns
 * pots you already belong to, so without it a pot would be invisible to exactly
 * the people it exists to collect from.
 *
 * The code is previewed BEFORE joining — the server returns the pot's name,
 * target and progress but deliberately not the member list, so someone holding
 * a code can decide whether to join without seeing who else is in and how much
 * each has given.
 */
function JoinByCodePanel({ onJoined }: { onJoined: () => void }): JSX.Element {
  const [code, setCode] = useState('');
  const [preview, setPreview] = useState<PotPreview | null>(null);

  const look = useAction(async () => {
    const found = await api.pots.preview(code.trim().toUpperCase());
    setPreview(found);
    return found;
  });

  const join = useAction(async () => {
    const joined = await api.pots.joinByCode(code.trim().toUpperCase());
    setCode('');
    setPreview(null);
    onJoined();
    return joined;
  });

  return (
    <Card title="Join a pot">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Field
            label="Invite code"
            placeholder="K6TY7PEM"
            hint="Someone shares this with you — it is how you find their pot."
            value={code}
            maxLength={12}
            onChange={(event) => {
              setCode(event.target.value.toUpperCase());
              setPreview(null);
            }}
            className="font-mono tracking-[0.18em]"
          />
        </div>
        <Button
          variant="secondary"
          onClick={() => void look.run()}
          loading={look.pending}
          disabled={code.trim().length < 6}
          className="mb-[1px]"
        >
          Look up
        </Button>
      </div>

      <ErrorBanner error={look.error ?? join.error} />

      {preview && (
        <div className="mt-4 border border-rule bg-surface-alt p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-semibold text-ink">{preview.name}</p>
              <p className="mt-0.5 font-mono text-[11px] text-ink-faint">
                by {preview.creatorName} · {preview.memberCount} member
                {preview.memberCount === 1 ? '' : 's'}
                {preview.note ? ` · ${preview.note}` : ''}
              </p>
            </div>
            <StatusBadge status={preview.status} />
          </div>

          <p className="mt-2 font-mono text-sm tabular-nums text-taka">
            {formatPoisha(preview.collectedPoisha, preview.currency)}
            <span className="text-ink-faint">
              {' '}
              of {formatPoisha(preview.targetPoisha, preview.currency)}
            </span>
          </p>

          <div className="mt-3 flex justify-end">
            {preview.alreadyMember ? (
              <p className="text-xs text-ink-faint">You are already in this pot.</p>
            ) : (
              <Button onClick={() => void join.run()} loading={join.pending}>
                Join {preview.name}
              </Button>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function PotCard({
  pot,
  currentUserId,
  expanded,
  onToggle,
  onChanged,
}: {
  pot: Pot;
  currentUserId: string;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void;
}): JSX.Element {
  const [amountInput, setAmountInput] = useState('');
  const [amountError, setAmountError] = useState<string | undefined>();

  const collected = Number(pot.collectedPoisha);
  const target = Number(pot.targetPoisha);
  const progress = target > 0 ? Math.min(100, (collected / target) * 100) : 0;

  const isCreator = pot.creatorUserId === currentUserId;
  const isOpen = pot.status === 'OPEN' || pot.status === 'FUNDED';

  const contribute = useAction(async () => {
    const amount = takaInputToPoisha(amountInput);
    if (amount === null) {
      setAmountError('Enter an amount like 500 or 500.50');
      throw new Error('invalid amount');
    }
    setAmountError(undefined);

    // A contribution IS a transfer, so it carries an idempotency key exactly
    // like /wallet/send-money. Minted per attempt, reused if that attempt is
    // retried — never regenerated on retry.
    const result = await api.pots.contribute(pot.id, amount, newIdempotencyKey('POT'));
    setAmountInput('');
    onChanged();
    return result;
  });

  const [invitePhone, setInvitePhone] = useState('');

  const addMember = useAction(async () => {
    const result = await api.pots.addMember(pot.id, invitePhone);
    setInvitePhone('');
    onChanged();
    return result;
  });

  const settle = useAction(async () => {
    const result = await api.pots.settle(pot.id, newIdempotencyKey('SETTLE'));
    onChanged();
    return result;
  });

  // The API call can succeed while the TRANSFER inside it fails — insufficient
  // funds, a frozen wallet. Those are two different outcomes and the UI must
  // not collapse them.
  const transferFailed = contribute.result?.transfer?.status === 'FAILED';

  return (
    <article className="border border-rule bg-surface p-5">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-ink">{pot.name}</h3>
          <p className="mt-0.5 font-mono text-[11px] text-ink-faint">
            by {pot.creatorName}
            {pot.note ? ` · ${pot.note}` : ''}
          </p>
        </div>
        <StatusBadge status={pot.status} />
      </header>

      {/* Progress toward the target. `collected` comes from the pot's wallet —
          never summed from the member list. */}
      <div className="mt-4">
        <div className="flex items-baseline justify-between">
          <span className="font-mono text-xl tabular-nums text-taka">
            {formatPoisha(pot.collectedPoisha, pot.currency)}
          </span>
          <span className="font-mono text-xs text-ink-faint">
            of {formatPoisha(pot.targetPoisha, pot.currency)}
          </span>
        </div>
        <div className="mt-2 h-2 w-full overflow-hidden bg-surface-alt">
          <div
            className={`h-full transition-all ${progress >= 100 ? 'bg-taka' : 'bg-warn'}`}
            style={{ width: `${progress}%` }}
          />
        </div>
        <p className="mt-1 font-mono text-[10px] text-ink-faint">
          {progress.toFixed(0)}% · {pot.memberCount} member{pot.memberCount === 1 ? '' : 's'}
        </p>
      </div>

      {/* ---- Actions ---- */}
      <div className="mt-4 space-y-3">
        {isOpen && (
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Field
                label="Contribute (BDT)"
                inputMode="decimal"
                placeholder="500"
                error={amountError}
                value={amountInput}
                onChange={(event) => setAmountInput(event.target.value)}
              />
            </div>
            <Button
              onClick={() => void contribute.run()}
              loading={contribute.pending}
              disabled={!amountInput}
              className="mb-[1px]"
            >
              Chip in
            </Button>
          </div>
        )}

        {isCreator && isOpen && collected > 0 && (
          <Button
            variant="secondary"
            onClick={() => void settle.run()}
            loading={settle.pending}
            className="w-full"
          >
            Pay out {formatPoisha(pot.collectedPoisha, pot.currency)} to me
          </Button>
        )}

        {transferFailed && (
          <p className="border border-debit bg-debit-soft px-3 py-2 text-xs text-debit">
            Contribution rejected: {contribute.result?.transfer?.failureReason}.
            {contribute.result?.transfer?.failureReason === 'INSUFFICIENT_FUNDS' &&
              ' Check your spendable balance — envelope reservations reduce it.'}
          </p>
        )}

        {Boolean(addMember.error ?? settle.error) && (
          <ErrorBanner error={addMember.error ?? settle.error} />
        )}
        {contribute.error instanceof Error &&
          contribute.error.message !== 'invalid amount' && (
            <ErrorBanner error={contribute.error} />
          )}
      </div>

      {/* ---- Invite: the code, and the creator's direct add ---- */}
      {isOpen && (
        <div className="mt-4 border-t border-rule pt-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.07em] text-ink-faint">
            Invite code — share this so people can join
          </p>
          <div className="mt-1.5 flex items-center gap-2">
            <code className="flex-1 border border-rule-strong bg-surface-alt px-3 py-1.5 font-mono
              text-lg tracking-[0.18em] text-taka">
              {pot.inviteCode}
            </code>
            <Button
              variant="secondary"
              className="px-3 py-1.5 text-xs"
              onClick={() => void navigator.clipboard?.writeText(pot.inviteCode)}
            >
              Copy
            </Button>
          </div>

          {isCreator && (
            <div className="mt-3 flex items-end gap-2">
              <div className="flex-1">
                <Field
                  label="Or add someone by phone"
                  type="tel"
                  placeholder="+8801712345678"
                  value={invitePhone}
                  onChange={(event) => setInvitePhone(event.target.value)}
                />
              </div>
              <Button
                variant="secondary"
                onClick={() => void addMember.run()}
                loading={addMember.pending}
                disabled={!invitePhone}
                className="mb-[1px] px-3 py-2 text-xs"
              >
                Add
              </Button>
            </div>
          )}
        </div>
      )}

      {/* ---- Member breakdown ---- */}
      <button
        onClick={onToggle}
        className="mt-4 w-full border-t border-rule pt-3 text-left font-mono text-[10px]
          uppercase tracking-[0.07em] text-ink-faint hover:text-taka"
      >
        {expanded ? '▾ Hide' : '▸ Show'} who contributed
      </button>

      {expanded && (
        <ul className="mt-2 divide-y divide-rule">
          {pot.members.map((member) => (
            <li key={member.userId} className="flex items-center justify-between py-2">
              <div className="min-w-0">
                <p className="truncate text-sm text-ink">
                  {member.displayName}
                  {member.userId === currentUserId && (
                    <span className="ml-1 text-xs text-ink-faint">(you)</span>
                  )}
                </p>
                <p className="font-mono text-[10px] text-ink-faint">
                  {member.contributionCount} contribution
                  {member.contributionCount === 1 ? '' : 's'}
                </p>
              </div>
              <span className="shrink-0 font-mono text-sm tabular-nums text-taka">
                {formatPoisha(member.contributedPoisha, pot.currency)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {pot.settlementTransactionId && (
        <Link
          to={`/transactions/${pot.settlementTransactionId}`}
          className="mt-3 inline-block font-mono text-[11px] text-taka underline underline-offset-2"
        >
          View payout transaction
        </Link>
      )}
    </article>
  );
}

function CreatePotForm({ onCreated }: { onCreated: () => void }): JSX.Element {
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [target, setTarget] = useState('');
  const [targetError, setTargetError] = useState<string | undefined>();

  const create = useAction(async () => {
    const targetAmount = takaInputToPoisha(target);
    if (targetAmount === null) {
      setTargetError('Enter a target like 20000');
      throw new Error('invalid amount');
    }
    setTargetError(undefined);

    const result = await api.pots.create({ name, note: note || undefined, targetAmount });
    setName('');
    setNote('');
    setTarget('');
    onCreated();
    return result;
  });

  return (
    <Card title="New pot">
      <div className="grid gap-4 sm:grid-cols-3">
        <Field
          label="Name"
          placeholder="Cox Bazar Trip"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <Field
          label="Target (BDT)"
          inputMode="decimal"
          placeholder="20000"
          error={targetError}
          value={target}
          onChange={(event) => setTarget(event.target.value)}
        />
        <Field
          label="Note (optional)"
          maxLength={280}
          placeholder="December weekend"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </div>

      <p className="mt-3 border-l-2 border-taka bg-taka-soft px-3 py-2 text-xs text-ink-soft">
        You are enrolled automatically, and the pot gets its own wallet. Contributions
        move real money through the same engine as a normal transfer.
      </p>

      {create.error instanceof Error && create.error.message !== 'invalid amount' && (
        <div className="mt-3">
          <ErrorBanner error={create.error} />
        </div>
      )}

      <div className="mt-4 flex justify-end">
        <Button
          onClick={() => void create.run()}
          loading={create.pending}
          disabled={!name || !target}
        >
          Create pot
        </Button>
      </div>
    </Card>
  );
}
