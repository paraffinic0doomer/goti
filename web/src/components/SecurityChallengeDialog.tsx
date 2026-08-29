import { useState } from 'react';

import { api } from '../api/client';
import type { AnswerChallengeResult, SecurityChallenge } from '../api/types';
import { useAction } from '../hooks/useAsync';
import { Button, ErrorBanner, Field } from './ui';

/**
 * ============================================================================
 *  SECURITY CHALLENGE DIALOG
 * ============================================================================
 *
 * Shown when the backend answers 428 — a large transfer, or an unfreeze.
 *
 * THE WARNING IS NOT DECORATION. On a transfer challenge one wrong answer
 * freezes the wallet, and the user must know that before they guess. A control
 * whose consequence is hidden is a control that feels like a trap when it
 * fires.
 *
 * The dialog performs NO verification itself. It collects an answer and posts
 * it; the server compares against an argon2id hash and decides. Nothing here
 * knows whether the answer is right, which is exactly why nothing here can be
 * bypassed to find out.
 */
export function SecurityChallengeDialog({
  challenge,
  onPassed,
  onCancel,
}: {
  challenge: SecurityChallenge;
  onPassed: (result: AnswerChallengeResult) => void;
  onCancel: () => void;
}): JSX.Element {
  const [answer, setAnswer] = useState('');

  const submit = useAction(async () => {
    const result = await api.security_questions.answer(challenge.challengeId, answer);
    setAnswer('');
    onPassed(result);
    return result;
  });

  const isTransfer = challenge.prompt !== undefined;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Security verification"
    >
      <div className="w-full max-w-md border border-rule bg-surface p-6 shadow-lg">
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.09em] text-taka">
          Security verification
        </p>
        <h2 className="mt-2 text-lg font-semibold text-ink">{challenge.prompt}</h2>

        {/* The stakes, stated before the user answers. */}
        <p className="mt-3 border-l-2 border-debit bg-debit-soft px-3 py-2 text-xs text-ink">
          One incorrect answer will <strong>freeze your wallet</strong> to protect it.
          Take your time — capitalisation and punctuation do not matter.
        </p>

        <div className="mt-4">
          <Field
            label="Your answer"
            autoFocus
            autoComplete="off"
            value={answer}
            maxLength={120}
            onChange={(event) => setAnswer(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && answer.trim()) void submit.run();
            }}
          />
        </div>

        <ErrorBanner error={submit.error} />

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={submit.pending}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit.run()}
            loading={submit.pending}
            disabled={answer.trim().length < 1}
          >
            Verify
          </Button>
        </div>

        <p className="mt-3 text-center font-mono text-[10px] text-ink-faint">
          {isTransfer ? 'Expires' : 'Expires'}{' '}
          {new Date(challenge.expiresAt).toLocaleTimeString()}
        </p>
      </div>
    </div>
  );
}
