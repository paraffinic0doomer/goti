import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import { api } from '../api/client';
import { useAction, useAsync } from '../hooks/useAsync';
import { Button, ErrorBanner, Field } from '../components/ui';

/**
 * Auth screens.
 *
 * NO SECURITY LOGIC LIVES HERE. The forms collect input and hand it to the API;
 * the backend hashes with argon2id, issues the JWT, and decides whether the
 * credentials are valid. The only client-side validation is the `required`
 * attribute and input types — a convenience that saves a round trip, never a
 * control. Every rule is re-enforced server-side by the DTO and the use case.
 */

function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  footer: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-page px-6 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8">
          <h1 className="font-sans text-5xl font-bold leading-none tracking-tight text-ink">
            Goti <span className="text-taka">/</span> গতি
          </h1>
          <p className="mt-3 text-sm text-ink-soft">{subtitle}</p>
        </div>

        <div className="border border-rule bg-surface p-6">
          <h2 className="mb-5 font-mono text-[11px] font-semibold uppercase tracking-[0.09em] text-ink-soft">
            {title}
          </h2>
          {children}
        </div>

        <p className="mt-5 text-center text-sm text-ink-soft">{footer}</p>
      </div>
    </div>
  );
}

export function LoginPage(): JSX.Element {
  const { login, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');

  const action = useAction(async () => {
    await login(phone, password);
    navigate('/', { replace: true });
  });

  if (isAuthenticated) return <Navigate to="/" replace />;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    void action.run();
  };

  return (
    <AuthShell
      title="Sign in"
      subtitle="A digital money movement platform."
      footer={
        <>
          No account?{' '}
          <Link to="/register" className="text-taka underline underline-offset-2">
            Create one
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <Field
          label="Phone"
          type="tel"
          required
          autoComplete="username"
          placeholder="+8801712345678"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
        />
        <Field
          label="Password"
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />

        {/* The backend returns ONE error for every auth failure, so the UI
            cannot accidentally reveal whether an account exists. */}
        <ErrorBanner error={action.error} />

        <Button type="submit" loading={action.pending} className="w-full">
          Sign in
        </Button>
      </form>
    </AuthShell>
  );
}

export function RegisterPage(): JSX.Element {
  const { register, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ phone: '', displayName: '', password: '', email: '' });

  // The question catalogue is public — the form needs it before an account
  // exists. Listing prompts reveals nothing; only the answers are secret.
  const catalogue = useAsync(() => api.security_questions.catalogue(), []);

  /**
   * Three chosen questions and their answers.
   *
   * Defaults to the first three so the form is usable immediately, but every
   * slot is a real select — a user who wants different questions changes them.
   */
  const [answers, setAnswers] = useState<{ questionKey: string; answer: string }[]>([
    { questionKey: 'FIRST_SCHOOL', answer: '' },
    { questionKey: 'BEST_FRIEND_NAME', answer: '' },
    { questionKey: 'BIRTH_CITY', answer: '' },
  ]);

  const action = useAction(async () => {
    await register({
      phone: form.phone,
      displayName: form.displayName,
      password: form.password,
      email: form.email || undefined,
      securityAnswers: answers as never,
    });
    navigate('/', { replace: true });
  });

  const setAnswerAt = (index: number, patch: Partial<{ questionKey: string; answer: string }>) =>
    setAnswers((current) =>
      current.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)),
    );

  const questionsReady =
    answers.every((entry) => entry.answer.trim().length >= 2) &&
    new Set(answers.map((entry) => entry.questionKey)).size === 3;

  if (isAuthenticated) return <Navigate to="/" replace />;

  const update = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm((previous) => ({ ...previous, [key]: event.target.value }));

  return (
    <AuthShell
      title="Create account"
      subtitle="Every new wallet opens with ৳100,000 — issued from the genesis account, so the ledger still sums to zero."
      footer={
        <>
          Already registered?{' '}
          <Link to="/login" className="text-taka underline underline-offset-2">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={(event) => { event.preventDefault(); void action.run(); }} className="space-y-4">
        <Field
          label="Phone"
          type="tel"
          required
          placeholder="+8801712345678"
          hint="Bangladeshi mobile number in E.164 format"
          value={form.phone}
          onChange={update('phone')}
        />
        <Field
          label="Name"
          required
          placeholder="Rahim Uddin"
          value={form.displayName}
          onChange={update('displayName')}
        />
        <Field
          label="Email (optional)"
          type="email"
          value={form.email}
          onChange={update('email')}
        />
        <Field
          label="Password"
          type="password"
          required
          autoComplete="new-password"
          minLength={10}
          hint="At least 10 characters. Length beats symbol requirements."
          value={form.password}
          onChange={update('password')}
        />

        {/* ---- Security questions: MANDATORY ---- */}
        <div className="border-t border-rule pt-4">
          <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-soft">
            Security questions
          </p>
          <p className="mt-1 text-xs text-ink-soft">
            Three different questions. These protect you if someone steals your
            password — a large transfer will ask one, and a wrong answer freezes
            your wallet instead of paying out.
          </p>

          <div className="mt-3 space-y-3">
            {answers.map((entry, index) => (
              <div key={index} className="space-y-1.5">
                <select
                  value={entry.questionKey}
                  onChange={(event) => setAnswerAt(index, { questionKey: event.target.value })}
                  className="w-full border border-rule-strong bg-surface px-3 py-2 text-sm text-ink
                    focus:outline focus:outline-2 focus:outline-offset-[-1px] focus:outline-taka"
                >
                  {(catalogue.data?.questions ?? []).map((question) => (
                    <option
                      key={question.key}
                      value={question.key}
                      // Prevent picking the same question twice — three copies
                      // of one answer is one secret, not three.
                      disabled={answers.some(
                        (other, i) => i !== index && other.questionKey === question.key,
                      )}
                    >
                      {question.prompt}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  autoComplete="off"
                  placeholder="Your answer"
                  value={entry.answer}
                  maxLength={120}
                  onChange={(event) => setAnswerAt(index, { answer: event.target.value })}
                  className="w-full border border-rule-strong bg-surface px-3 py-2 text-sm text-ink
                    placeholder:text-ink-faint focus:outline focus:outline-2
                    focus:outline-offset-[-1px] focus:outline-taka"
                />
              </div>
            ))}
          </div>
        </div>

        <ErrorBanner error={action.error} />

        <Button
          type="submit"
          loading={action.pending}
          disabled={!questionsReady}
          className="w-full"
        >
          Create account
        </Button>
      </form>
    </AuthShell>
  );
}
