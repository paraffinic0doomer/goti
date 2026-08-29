import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { ApiError, api, challengeFrom, newIdempotencyKey, takaInputToPoisha } from '../api/client';
import type { SecurityChallenge } from '../api/types';
import { SecurityChallengeDialog } from '../components/SecurityChallengeDialog';
import { useAction, useAsync } from '../hooks/useAsync';
import {
  Button,
  Card,
  ErrorBanner,
  Field,
  Loading,
  Spinner,
  StatusBadge,
} from '../components/ui';

type Step = 'compose' | 'confirm' | 'processing' | 'done';

/**
 * ============================================================================
 *  SEND MONEY — select receiver → enter amount → confirm
 * ============================================================================
 *
 * THE IDEMPOTENCY KEY IS THE IMPORTANT PART OF THIS SCREEN.
 *
 * It is minted ONCE, when the user reaches the confirmation step, and reused
 * for every retry of that same intent. Generating a fresh key on retry would
 * defeat the entire mechanism and turn one intent into two payments — which is
 * precisely the failure the backend's two-tier idempotency exists to prevent.
 *
 * Generating it here is legitimate client responsibility: only the client knows
 * that a retry is the SAME intent rather than a new one. The server cannot
 * infer that, which is why the DTO makes the field required.
 *
 * WHAT THIS SCREEN DOES NOT DO: it never checks whether the balance is
 * sufficient, never verifies the receiver exists, and never decides whether a
 * transfer is allowed. It submits and renders the answer. A client-side balance
 * check would be a second implementation of a rule the backend already owns —
 * and it would be wrong the moment two transfers race.
 */
export function SendMoneyPage(): JSX.Element {
  const navigate = useNavigate();
  const wallet = useAsync(() => api.wallet.get(), []);

  const [step, setStep] = useState<Step>('compose');
  const [receiverPhone, setReceiverPhone] = useState('');
  const [takaInput, setTakaInput] = useState('');
  const [note, setNote] = useState('');
  const [amountError, setAmountError] = useState<string | undefined>();

  /**
   * Minted once per confirmed intent and held for the lifetime of this attempt.
   * Cleared only when the user starts a genuinely new transfer.
   */
  const [idempotencyKey, setIdempotencyKey] = useState<string>(() => newIdempotencyKey());

  /**
   * A pending security challenge, if the backend raised one.
   *
   * Large transfers require the owner to answer a security question. The KEY IS
   * NOT REGENERATED for the retry — the challenge is bound to this exact
   * idempotency key and amount, so a new key would raise a fresh challenge
   * instead of redeeming the one just passed.
   */
  const [challenge, setChallenge] = useState<SecurityChallenge | null>(null);

  const amountPoisha = useMemo(() => takaInputToPoisha(takaInput), [takaInput]);

  const transfer = useAction(async () =>
    api.wallet.sendMoney({
      receiverPhone,
      amount: amountPoisha!,
      idempotencyKey,
      note: note || undefined,
    }),
  );

  const goToConfirm = (): void => {
    if (amountPoisha === null) {
      setAmountError('Enter an amount like 250 or 250.75');
      return;
    }
    setAmountError(undefined);
    setStep('confirm');
  };

  const submit = async (): Promise<void> => {
    setStep('processing');
    const result = await transfer.run();

    if (result) return setStep('done');

    // A 428 is not a failure — it is "prove you are the owner first". Surface
    // the question rather than the error.
    const raised = challengeFrom(transfer.error);
    if (raised) {
      setChallenge(raised);
      transfer.reset();
    }
    setStep('confirm');
  };

  const startOver = (): void => {
    transfer.reset();
    setReceiverPhone('');
    setTakaInput('');
    setNote('');
    // A NEW intent gets a NEW key. This is the only place a key is regenerated.
    setIdempotencyKey(newIdempotencyKey());
    setStep('compose');
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Send money</h1>
        <p className="mt-1 text-sm text-ink-soft">
          {wallet.loading
            ? 'Reading your balance…'
            : wallet.data
              ? `Available: ${wallet.data.balanceFormatted}`
              : 'Balance unavailable'}
        </p>
      </header>

      <StepIndicator step={step} />

      {step === 'compose' && (
        <Card title="Recipient and amount">
          <div className="space-y-4">
            <Field
              label="Send to (phone)"
              type="tel"
              placeholder="+8801712345678"
              hint="The receiver is resolved and verified by the server."
              value={receiverPhone}
              onChange={(event) => setReceiverPhone(event.target.value)}
            />
            <Field
              label="Amount (BDT)"
              inputMode="decimal"
              placeholder="250.00"
              hint="Converted to integer poisha before sending. No floating point touches the amount."
              error={amountError}
              value={takaInput}
              onChange={(event) => setTakaInput(event.target.value)}
            />
            <Field
              label="Note (optional)"
              maxLength={140}
              placeholder="Lunch yesterday"
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />

            <div className="flex justify-end gap-2 pt-2">
              <Link to="/">
                <Button variant="secondary">Cancel</Button>
              </Link>
              <Button onClick={goToConfirm} disabled={!receiverPhone || !takaInput}>
                Review
              </Button>
            </div>
          </div>
        </Card>
      )}

      {step === 'confirm' && (
        <Card title="Confirm transfer">
          <dl className="divide-y divide-rule">
            <Row label="To" value={receiverPhone} />
            <Row
              label="Amount"
              value={`${takaInput} BDT`}
              mono
              emphasis
            />
            <Row label="In poisha" value={String(amountPoisha)} mono />
            {note && <Row label="Note" value={note} />}
            <Row label="Idempotency key" value={idempotencyKey} mono />
          </dl>

          <p className="mt-4 border-l-2 border-taka bg-taka-soft px-3 py-2 text-xs text-ink-soft">
            This key makes the transfer safe to retry. If the network drops and you
            send again, the server returns the original result instead of paying twice.
          </p>

          <ErrorBanner
            error={transfer.error}
            onRetry={transfer.error instanceof ApiError && transfer.error.retryable
              ? () => void submit()
              : undefined}
          />

          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setStep('compose')}>
              Back
            </Button>
            <Button onClick={() => void submit()} loading={transfer.pending}>
              Confirm and send
            </Button>
          </div>
        </Card>
      )}

      {step === 'processing' && (
        <Card title="Processing">
          <div className="flex flex-col items-center gap-4 py-10 text-center">
            <Spinner className="h-8 w-8 text-taka" />
            <div>
              <p className="text-sm font-medium text-ink">Moving your money</p>
              <p className="mt-1 text-xs text-ink-faint">
                Locking both wallets, debiting, crediting and posting to the ledger —
                all inside one database transaction.
              </p>
            </div>
          </div>
        </Card>
      )}

      {step === 'done' && transfer.result && (
        <Card title="Result">
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <StatusBadge status={transfer.result.status} />
              <p className="text-sm text-ink">
                {transfer.result.status === 'COMPLETED'
                  ? 'Transfer completed.'
                  : 'Transfer was not completed.'}
              </p>
            </div>

            <dl className="divide-y divide-rule border-y border-rule">
              <Row label="Transaction ID" value={transfer.result.transactionId} mono />
              <Row label="Status" value={transfer.result.status} mono />
              <Row
                label="Timestamp"
                value={new Date(transfer.result.timestamp).toLocaleString()}
              />
            </dl>

            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="secondary" onClick={startOver}>
                Send another
              </Button>
              <Button
                onClick={() => navigate(`/transactions/${transfer.result!.transactionId}`)}
              >
                View timeline
              </Button>
            </div>
          </div>
        </Card>
      )}

      {challenge && (
        <SecurityChallengeDialog
          challenge={challenge}
          onPassed={() => {
            setChallenge(null);
            // Same key, same amount — this redeems the challenge just passed.
            void submit();
          }}
          onCancel={() => setChallenge(null)}
        />
      )}

      {wallet.loading && step === 'compose' && <Loading label="Loading wallet" />}
    </div>
  );
}

function Row({
  label,
  value,
  mono = false,
  emphasis = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  emphasis?: boolean;
}): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <dt className="font-mono text-[11px] uppercase tracking-[0.07em] text-ink-faint">
        {label}
      </dt>
      <dd
        className={`min-w-0 break-all text-right ${mono ? 'font-mono' : ''} ${
          emphasis ? 'text-lg font-semibold text-ink' : 'text-sm text-ink'
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

function StepIndicator({ step }: { step: Step }): JSX.Element {
  const steps: { key: Step; label: string }[] = [
    { key: 'compose', label: 'Details' },
    { key: 'confirm', label: 'Confirm' },
    { key: 'processing', label: 'Processing' },
    { key: 'done', label: 'Result' },
  ];
  const activeIndex = steps.findIndex((entry) => entry.key === step);

  return (
    <ol className="flex items-center gap-2">
      {steps.map((entry, index) => {
        const state = index < activeIndex ? 'done' : index === activeIndex ? 'active' : 'todo';
        return (
          <li key={entry.key} className="flex flex-1 items-center gap-2">
            <span
              className={`flex h-6 w-6 shrink-0 items-center justify-center border font-mono text-[11px] ${
                state === 'active'
                  ? 'border-taka bg-taka text-white'
                  : state === 'done'
                    ? 'border-taka bg-taka-soft text-taka'
                    : 'border-rule-strong bg-surface text-ink-faint'
              }`}
            >
              {index + 1}
            </span>
            <span
              className={`font-mono text-[11px] uppercase tracking-[0.07em] ${
                state === 'todo' ? 'text-ink-faint' : 'text-ink-soft'
              }`}
            >
              {entry.label}
            </span>
            {index < steps.length - 1 && <span className="h-px flex-1 bg-rule" />}
          </li>
        );
      })}
    </ol>
  );
}
