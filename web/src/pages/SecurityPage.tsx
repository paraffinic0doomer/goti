import { useState } from 'react';
import { Link } from 'react-router-dom';

import { api, challengeFrom } from '../api/client';
import type { SecurityChallenge } from '../api/types';
import { SecurityChallengeDialog } from '../components/SecurityChallengeDialog';
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
 *  SECURITY — emergency freeze, risk flags, account
 * ============================================================================
 *
 * The freeze button is the most important control in the whole application, and
 * it is treated that way: one tap, no confirmation dialog beyond typing a
 * reason, and no rate limit anywhere in its path.
 *
 * The reason field is required because a freeze with no explanation becomes a
 * wallet somebody finds locked weeks later with no idea why — and the support
 * call that follows has nothing to work from.
 *
 * WHAT THIS SCREEN DOES NOT DECIDE: whether the freeze takes effect. The status
 * is checked inside the same UPDATE that moves a balance, so a freeze issued
 * while a transfer is mid-flight still wins. Nothing here needs to race
 * anything — the database settles it.
 */
export function SecurityPage(): JSX.Element {
  const { session } = useAuth();
  const security = useAsync(() => api.security.state(), []);
  const risk = useAsync(() => api.risk.flags(), []);
  const profile = useAsync(() => api.users.profile(), []);

  const [reason, setReason] = useState('');
  /** Unfreezing requires proving ownership — otherwise a thief undoes the freeze. */
  const [challenge, setChallenge] = useState<SecurityChallenge | null>(null);

  const freeze = useAction(async () => {
    const next = await api.security.freeze(reason || 'Emergency freeze from the app');
    setReason('');
    security.reload();
    return next;
  });

  const unfreeze = useAction(async () => {
    try {
      const next = await api.security.unfreeze(reason || 'Unfrozen by owner');
      setReason('');
      security.reload();
      return next;
    } catch (error) {
      const raised = challengeFrom(error);
      if (raised) {
        setChallenge(raised);
        // Swallowed: a challenge is a step, not an error to show in a banner.
        return null as never;
      }
      throw error;
    }
  });

  const state = security.data;
  const frozen = state?.status === 'FROZEN';
  const underReview = state?.status === 'UNDER_REVIEW';

  return (
    <div className="space-y-6">
      {challenge && (
        <SecurityChallengeDialog
          challenge={challenge}
          onPassed={() => {
            setChallenge(null);
            // The pass is recorded server-side; retrying now succeeds.
            void unfreeze.run();
          }}
          onCancel={() => setChallenge(null)}
        />
      )}

      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Security</h1>
          <p className="mt-1 max-w-xl text-sm text-ink-soft">
            Freeze your wallet instantly if something looks wrong. Incoming money still
            arrives — a freeze stops leaks, not salaries.
          </p>
        </div>
        <Link to="/">
          <Button variant="secondary">Back to wallet</Button>
        </Link>
      </header>

      {/* ---- Freeze control ---- */}
      {security.loading && !state ? (
        <Loading label="Checking wallet security" />
      ) : security.error ? (
        <ErrorBanner error={security.error} onRetry={security.reload} />
      ) : state ? (
        <Card title="Wallet status">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-3">
                <StatusBadge status={state.status} />
                <span className="text-sm text-ink">
                  {frozen
                    ? 'Your wallet is frozen. Nothing can leave it.'
                    : underReview
                      ? 'Held by our team pending review.'
                      : 'Your wallet is active and can send money.'}
                </span>
              </div>
              {state.freezeReason && (
                <p className="mt-2 text-sm text-ink-soft">
                  Reason: <span className="text-ink">{state.freezeReason}</span>
                </p>
              )}
            </div>

            {/* Capability chips make the asymmetry visible: a frozen wallet
                cannot send but can still receive. */}
            <div className="flex gap-2">
              <Capability label="Send" allowed={state.canSend} />
              <Capability label="Receive" allowed={state.canReceive} />
            </div>
          </div>

          <div className="mt-5 border-t border-rule pt-4">
            <Field
              label={frozen ? 'Why are you unfreezing?' : 'Why are you freezing?'}
              placeholder={frozen ? 'Changed my password, all clear' : 'Suspicious login detected'}
              maxLength={200}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              hint="Recorded permanently in your security history."
            />

            <ErrorBanner error={freeze.error ?? unfreeze.error} />

            <div className="mt-4 flex justify-end gap-2">
              {frozen ? (
                <Button
                  onClick={() => void unfreeze.run()}
                  loading={unfreeze.pending}
                  disabled={!state.canSelfUnfreeze}
                >
                  Unfreeze my wallet
                </Button>
              ) : underReview ? (
                <p className="text-xs text-ink-faint">
                  A wallet under review cannot be unfrozen from the app. Contact support.
                </p>
              ) : (
                <Button variant="danger" onClick={() => void freeze.run()} loading={freeze.pending}>
                  Freeze my wallet now
                </Button>
              )}
            </div>
          </div>
        </Card>
      ) : null}

      {/* ---- Security history ---- */}
      <Card title="Security history">
        {!state || state.history.length === 0 ? (
          <Empty message="No freeze or unfreeze events yet." />
        ) : (
          <ol className="divide-y divide-rule">
            {state.history.map((event) => (
              <li key={event.id} className="flex items-start justify-between gap-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm text-ink">
                    <span
                      className={`font-mono text-[11px] font-semibold uppercase tracking-[0.06em] ${
                        event.newStatus === 'ACTIVE' ? 'text-taka' : 'text-debit'
                      }`}
                    >
                      {event.action}
                    </span>{' '}
                    <span className="font-mono text-[11px] text-ink-faint">
                      {event.previousStatus} → {event.newStatus}
                    </span>
                  </p>
                  <p className="mt-0.5 text-sm text-ink-soft">{event.reason}</p>
                </div>
                <span className="shrink-0 font-mono text-[11px] text-ink-faint">
                  {new Date(event.occurredAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Card>

      {/* ---- Risk flags — the explainable fraud engine, read side ---- */}
      <Card title="Fraud detection">
        {risk.loading && !risk.data ? (
          <Loading label="Loading risk flags" />
        ) : risk.error ? (
          <ErrorBanner error={risk.error} onRetry={risk.reload} />
        ) : risk.data ? (
          ((riskData) => (
          <>
            <div className="mb-4 grid grid-cols-3 gap-2">
              {(['LOW', 'MEDIUM', 'HIGH'] as const).map((level) => (
                <div
                  key={level}
                  className={`border px-3 py-2 text-center ${
                    level === 'HIGH'
                      ? 'border-debit bg-debit-soft'
                      : level === 'MEDIUM'
                        ? 'border-warn bg-warn-soft'
                        : 'border-rule bg-surface-alt'
                  }`}
                >
                  <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.07em] text-ink-faint">
                    {level}
                  </p>
                  <p className="font-mono text-xl tabular-nums text-ink">
                    {riskData.counts[level]}
                  </p>
                </div>
              ))}
            </div>

            <p className="mb-4 text-xs text-ink-soft">
              Scores are additive across five rules. {riskData.policy.mediumAt}+ is medium,{' '}
              {riskData.policy.highAt}+ is high, and {riskData.policy.blockAt}+ blocks the
              transfer — which takes at least two rules firing together.
            </p>

            {riskData.flags.length === 0 ? (
              <Empty message="No risk flags on your account." />
            ) : (
              <ul className="space-y-3">
                {riskData.flags.map((flag) => (
                  <li key={flag.id} className="border border-rule bg-surface-alt p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <StatusBadge status={flag.severity} />
                        <code className="ml-2 font-mono text-[11px] text-taka">{flag.rule}</code>
                      </div>
                      <span className="shrink-0 font-mono text-xs text-ink-faint">
                        score {flag.score}
                      </span>
                    </div>

                    {/* Each rule's own sentence — this is what "explainable"
                        means in practice, as opposed to a bare score. */}
                    <ul className="mt-2 space-y-1">
                      {flag.triggeredRules.map((rule, index) => (
                        <li key={index} className="text-xs text-ink-soft">
                          <span className="font-mono text-[10px] text-ink-faint">
                            +{rule.weight}
                          </span>{' '}
                          {rule.explanation}
                        </li>
                      ))}
                    </ul>

                    <div className="mt-2 flex items-center gap-3">
                      <span className="font-mono text-[10px] text-ink-faint">
                        {new Date(flag.createdAt).toLocaleString()}
                      </span>
                      {flag.transactionId && (
                        <Link
                          to={`/transactions/${flag.transactionId}`}
                          className="font-mono text-[10px] text-taka underline underline-offset-2"
                        >
                          view transaction
                        </Link>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
          ))(risk.data)
        ) : null}
      </Card>

      {/* ---- Account ---- */}
      <Card title="Account">
        {profile.data ? (
          <dl className="divide-y divide-rule">
            <Row label="Name" value={profile.data.displayName} />
            <Row label="Phone" value={profile.data.phone} mono />
            <Row label="Status" value={profile.data.status} mono />
            <Row label="User ID" value={profile.data.userId} mono />
            <Row label="Wallet ID" value={profile.data.walletId ?? '—'} mono />
          </dl>
        ) : (
          <Loading label="Loading profile" />
        )}
        <p className="mt-3 text-xs text-ink-faint">
          Signed in as {session?.phone}. Tokens expire after one hour and cannot be revoked
          early — that is why they are short-lived.
        </p>
      </Card>
    </div>
  );
}

function Capability({ label, allowed }: { label: string; allowed: boolean }): JSX.Element {
  return (
    <div
      className={`border px-3 py-1.5 text-center ${
        allowed ? 'border-taka bg-taka-soft text-taka' : 'border-debit bg-debit-soft text-debit'
      }`}
    >
      <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.07em]">{label}</p>
      <p className="font-mono text-[11px]">{allowed ? 'allowed' : 'blocked'}</p>
    </div>
  );
}

function Row({
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
