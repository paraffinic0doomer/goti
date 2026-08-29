import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { api, formatPoisha, takaInputToPoisha } from '../api/client';
import type { Envelope, WalletBudget } from '../api/types';
import { useAction, useAsync } from '../hooks/useAsync';
import { Button, Card, Empty, ErrorBanner, Field, Loading } from '../components/ui';

/**
 * ============================================================================
 *  EXPENSE ENVELOPES
 * ============================================================================
 *
 * THE ONE THING THIS SCREEN MUST GET RIGHT
 *
 * The slider gives instant feedback while dragging — that is a UI affordance,
 * and computing it client-side is legitimate. But the number it shows is a
 * PREVIEW, never a decision.
 *
 * Nothing is committed until the pointer is released, and when it is, the
 * backend's response REPLACES the whole budget. If the server disagrees with
 * the preview — because a transfer landed mid-drag and changed the balance —
 * the server wins and the UI snaps to the truth.
 *
 * That is why every envelope endpoint returns the complete `WalletBudget`
 * rather than just the envelope that changed: the client can drop its optimistic
 * state entirely instead of patching one field and hoping the other three still
 * agree.
 *
 * The frontend NEVER decides whether a reservation is allowed. The check
 * `reserved + delta <= balance` runs in SQL, under the wallet's row lock,
 * because two concurrent adjustments must not both see room.
 */
export function EnvelopesPage(): JSX.Element {
  const budget = useAsync(() => api.envelopes.list(), []);
  const [showCreate, setShowCreate] = useState(false);

  /**
   * Server truth, held separately from any in-progress drag.
   *
   * Every mutation writes its response here, so the screen is always showing
   * what the backend last confirmed.
   */
  const [committed, setCommitted] = useState<WalletBudget | null>(null);
  useEffect(() => {
    if (budget.data) setCommitted(budget.data);
  }, [budget.data]);

  /** The envelope currently being dragged, and its previewed value. */
  const [draft, setDraft] = useState<{ envelopeId: string; reservedPoisha: number } | null>(null);

  const adjust = useAction(async (envelopeId: string, deltaPoisha: number) => {
    const next =
      deltaPoisha > 0
        ? await api.envelopes.reserve(envelopeId, deltaPoisha)
        : await api.envelopes.unlock(envelopeId, -deltaPoisha);
    // The server's figures replace ours wholesale — see the note above.
    setCommitted(next);
    setDraft(null);
    return next;
  });

  const remove = useAction(async (envelopeId: string) => {
    const next = await api.envelopes.remove(envelopeId);
    setCommitted(next);
    return next;
  });

  /**
   * Preview figures while dragging.
   *
   * Pure arithmetic on the committed numbers — it does not ask the server, and
   * it does not persist anything. `Number` is safe here because these are
   * display-only previews, never values sent back as money.
   */
  const preview = useMemo(() => {
    if (!committed) return null;
    const balance = Number(committed.balancePoisha);
    const reservedNow = Number(committed.reservedPoisha);

    if (!draft) {
      return { reserved: reservedNow, spendable: balance - reservedNow, balance };
    }

    const envelope = committed.envelopes.find((e) => e.id === draft.envelopeId);
    const delta = draft.reservedPoisha - Number(envelope?.reservedPoisha ?? '0');
    const reserved = reservedNow + delta;

    return { reserved, spendable: balance - reserved, balance };
  }, [committed, draft]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Envelopes</h1>
          <p className="mt-1 max-w-xl text-sm text-ink-soft">
            Set money aside without moving it. Your balance never changes — the wallet
            simply refuses to spend below what you have reserved.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setShowCreate((open) => !open)}>
            {showCreate ? 'Cancel' : 'New envelope'}
          </Button>
          <Link to="/">
            <Button variant="secondary">Back to wallet</Button>
          </Link>
        </div>
      </header>

      {budget.loading && !committed ? (
        <Loading label="Loading your budget" />
      ) : budget.error ? (
        <ErrorBanner error={budget.error} onRetry={budget.reload} />
      ) : committed && preview ? (
        <>
          {/* ---- The three numbers that matter ---- */}
          <Card title="Balance breakdown">
            <div className="grid gap-4 sm:grid-cols-3">
              <Figure
                label="Total balance"
                value={formatPoisha(String(preview.balance), committed.currency)}
                hint="Unchanged by reserving — nothing moved"
              />
              <Figure
                label="Reserved"
                value={formatPoisha(String(preview.reserved), committed.currency)}
                tone="warn"
                hint="Fenced off across your envelopes"
                dirty={draft !== null}
              />
              <Figure
                label="Spendable"
                value={formatPoisha(String(Math.max(0, preview.spendable)), committed.currency)}
                tone="good"
                hint="What a transfer may actually use"
                dirty={draft !== null}
              />
            </div>

            {/* A single bar showing reserved vs spendable, so the trade-off is
                visible rather than something the user has to compute. */}
            <div className="mt-5">
              <div className="flex h-3 w-full overflow-hidden border border-rule">
                <div
                  className="bg-warn transition-all duration-150"
                  style={{
                    width: `${preview.balance > 0 ? (preview.reserved / preview.balance) * 100 : 0}%`,
                  }}
                />
                <div className="flex-1 bg-taka" />
              </div>
              <div className="mt-1.5 flex justify-between font-mono text-[10px] uppercase tracking-[0.07em] text-ink-faint">
                <span className="text-warn">Reserved</span>
                <span className="text-taka">Spendable</span>
              </div>
            </div>

            {draft !== null && (
              <p className="mt-3 border-l-2 border-warn bg-warn-soft px-3 py-2 text-xs text-ink-soft">
                Preview only. Release the slider to save — the server confirms the final
                figures.
              </p>
            )}
          </Card>

          <ErrorBanner error={adjust.error ?? remove.error} />

          {showCreate && (
            <CreateEnvelopeForm
              onCreated={(next) => {
                setCommitted(next);
                setShowCreate(false);
              }}
            />
          )}

          {/* ---- Envelope cards ---- */}
          {committed.envelopes.length === 0 ? (
            <Empty message="No envelopes yet. Create one to start setting money aside." />
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {committed.envelopes.map((envelope) => (
                <EnvelopeCard
                  key={envelope.id}
                  envelope={envelope}
                  currency={committed.currency}
                  balancePoisha={Number(committed.balancePoisha)}
                  otherReservedPoisha={
                    Number(committed.reservedPoisha) - Number(envelope.reservedPoisha)
                  }
                  draftValue={draft?.envelopeId === envelope.id ? draft.reservedPoisha : null}
                  pending={adjust.pending}
                  onDrag={(value) => setDraft({ envelopeId: envelope.id, reservedPoisha: value })}
                  onCommit={(value) => {
                    const delta = value - Number(envelope.reservedPoisha);
                    if (delta === 0) return setDraft(null);
                    void adjust.run(envelope.id, delta);
                  }}
                  onRemove={() => void remove.run(envelope.id)}
                />
              ))}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

function Figure({
  label,
  value,
  hint,
  tone = 'default',
  dirty = false,
}: {
  label: string;
  value: string;
  hint: string;
  tone?: 'default' | 'good' | 'warn';
  dirty?: boolean;
}): JSX.Element {
  const toneClass = { default: 'text-ink', good: 'text-taka', warn: 'text-warn' }[tone];

  return (
    <div className="border border-rule bg-surface-alt px-4 py-3">
      <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.09em] text-ink-faint">
        {label}
        {dirty && tone !== 'default' && <span className="ml-1 text-warn">•</span>}
      </p>
      <p className={`mt-1 font-mono text-xl tabular-nums ${toneClass}`}>{value}</p>
      <p className="mt-1 text-[11px] text-ink-faint">{hint}</p>
    </div>
  );
}

/**
 * One envelope, with the slider.
 *
 * The slider's maximum is `this envelope's reservation + what is still
 * unreserved` — so a user can never drag past what the wallet could possibly
 * cover. That is a UI convenience; the backend enforces the same bound in SQL
 * regardless of what the client sends.
 */
function EnvelopeCard({
  envelope,
  currency,
  balancePoisha,
  otherReservedPoisha,
  draftValue,
  pending,
  onDrag,
  onCommit,
  onRemove,
}: {
  envelope: Envelope;
  currency: string;
  balancePoisha: number;
  otherReservedPoisha: number;
  draftValue: number | null;
  pending: boolean;
  onDrag: (value: number) => void;
  onCommit: (value: number) => void;
  onRemove: () => void;
}): JSX.Element {
  const committedValue = Number(envelope.reservedPoisha);
  const value = draftValue ?? committedValue;
  const maximum = Math.max(0, balancePoisha - otherReservedPoisha);
  const dirty = draftValue !== null && draftValue !== committedValue;

  return (
    <article className="border border-rule bg-surface p-5">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-base font-semibold text-ink">
            {envelope.icon && <span aria-hidden>{envelope.icon}</span>}
            {envelope.name}
          </h3>
          {envelope.category && (
            <p className="mt-0.5 font-mono text-[11px] uppercase tracking-[0.07em] text-ink-faint">
              {envelope.category}
            </p>
          )}
        </div>
        <button
          onClick={onRemove}
          className="shrink-0 font-mono text-[10px] uppercase tracking-[0.07em] text-ink-faint
            underline-offset-2 hover:text-debit hover:underline"
        >
          Remove
        </button>
      </header>

      <p className={`mt-3 font-mono text-2xl tabular-nums ${dirty ? 'text-warn' : 'text-ink'}`}>
        {formatPoisha(String(value), currency)}
        {dirty && <span className="ml-2 text-xs">unsaved</span>}
      </p>

      {envelope.targetPoisha && (
        <div className="mt-2">
          <div className="h-1.5 w-full overflow-hidden bg-surface-alt">
            <div
              className="h-full bg-taka transition-all"
              style={{
                width: `${Math.min(100, (value / Number(envelope.targetPoisha)) * 100)}%`,
              }}
            />
          </div>
          <p className="mt-1 font-mono text-[10px] text-ink-faint">
            goal {formatPoisha(envelope.targetPoisha, currency)}
          </p>
        </div>
      )}

      <div className="mt-4">
        <input
          type="range"
          min={0}
          max={maximum}
          // 100 poisha = 1 BDT. Sliding in whole taka keeps the value clean and
          // stops the control emitting sub-taka noise.
          step={100}
          value={value}
          disabled={pending}
          aria-label={`Amount reserved for ${envelope.name}`}
          onChange={(event) => onDrag(Number(event.target.value))}
          // Committing on release, not on every change, means one request per
          // gesture instead of one per pixel.
          onPointerUp={(event) => onCommit(Number((event.target as HTMLInputElement).value))}
          onKeyUp={(event) => onCommit(Number((event.target as HTMLInputElement).value))}
          className="w-full accent-taka disabled:opacity-50"
        />
        <div className="flex justify-between font-mono text-[10px] text-ink-faint">
          <span>0</span>
          <span>max {formatPoisha(String(maximum), currency)}</span>
        </div>
      </div>
    </article>
  );
}

function CreateEnvelopeForm({
  onCreated,
}: {
  onCreated: (budget: WalletBudget) => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [icon, setIcon] = useState('');
  const [target, setTarget] = useState('');

  const create = useAction(async () => {
    const targetPoisha = target ? takaInputToPoisha(target) : null;
    const next = await api.envelopes.create({
      name,
      category: category || undefined,
      icon: icon || undefined,
      targetAmount: targetPoisha ?? undefined,
    });
    setName('');
    setCategory('');
    setIcon('');
    setTarget('');
    onCreated(next);
    return next;
  });

  return (
    <Card title="New envelope">
      <div className="grid gap-4 sm:grid-cols-4">
        <Field label="Name" placeholder="Rent" value={name} onChange={(e) => setName(e.target.value)} />
        <Field
          label="Category"
          placeholder="Housing"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        />
        <Field
          label="Icon"
          placeholder="🏠"
          maxLength={4}
          value={icon}
          onChange={(e) => setIcon(e.target.value)}
        />
        <Field
          label="Goal (BDT, optional)"
          inputMode="decimal"
          placeholder="50000"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        />
      </div>

      <ErrorBanner error={create.error} />

      <div className="mt-4 flex justify-end">
        <Button onClick={() => void create.run()} loading={create.pending} disabled={!name}>
          Create envelope
        </Button>
      </div>
    </Card>
  );
}
