import { useState, type FormEvent, type ReactNode } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ApiError, errorMessage } from '../lib/api';
import { requestPasswordReset, resetPassword } from '../lib/endpoints';
import { Alert, Button, Field, Icon, Input } from '../components/ui';

const DEMO_ACCOUNTS = [
  { email: 'admin@demo.test', password: 'Admin@12345', role: 'Main Administrator' },
  { email: 'coordinator@demo.test', password: 'Coord@12345', role: 'Academic Coordinator' },
  { email: 'teacher@demo.test', password: 'Teacher@12345', role: 'Teacher (G1-A only)' },
  { email: 'parent@demo.test', password: 'Parent@12345', role: 'Parent (two children)' },
  { email: 'finance@demo.test', password: 'Finance@12345', role: 'Finance Officer' },
  { email: 'auditor@demo.test', password: 'Auditor@12345', role: 'Auditor' },
];

export function LoginPage(): ReactNode {
  const { status, login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showDemo, setShowDemo] = useState(false);
  const [mode, setMode] = useState<'signin' | 'forgot' | 'reset'>('signin');
  const [resetToken, setResetToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  if (status === 'authenticated') {
    return <Navigate to="/" replace />;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(email.trim(), password, needsCode ? totpCode.trim() : undefined);
      navigate('/', { replace: true });
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'mfa_required') {
        setNeedsCode(true);
        setError(null);
        setNotice('Enter the 6-digit code from your authenticator app to finish signing in.');
      } else if (caught instanceof ApiError && caught.code === 'invalid_totp') {
        setNeedsCode(true);
        setError(errorMessage(caught));
      } else {
        setError(errorMessage(caught));
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleForgot(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const result = await requestPasswordReset(email.trim());
      setNotice(result.message);
      if (result.devToken) {
        setResetToken(result.devToken);
        setMode('reset');
      }
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleReset(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setNotice(null);
    if (newPassword !== confirmPassword) {
      setError('The new password and confirmation do not match.');
      setSubmitting(false);
      return;
    }
    try {
      await resetPassword(resetToken.trim(), newPassword);
      setNotice('Your password has been replaced. Sign in with the new password.');
      setMode('signin');
      setPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setNeedsCode(false);
      setTotpCode('');
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      <section className="relative hidden flex-col justify-between overflow-hidden bg-slate-900 p-12 text-white lg:flex">
        <div
          className="pointer-events-none absolute inset-0 opacity-70"
          style={{
            background:
              'radial-gradient(60% 60% at 20% 10%, rgba(99,102,241,0.45) 0%, transparent 60%), radial-gradient(50% 50% at 90% 90%, rgba(14,165,233,0.3) 0%, transparent 65%)',
          }}
        />
        <div className="relative">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/10 ring-1 ring-white/20">
              <Icon name="book" />
            </div>
            <div>
              <p className="text-sm font-semibold tracking-tight">School ERP</p>
              <p className="text-xs text-white/60">Greenfield Public School</p>
            </div>
          </div>
        </div>

        <div className="relative max-w-md">
          <h1 className="text-3xl font-semibold tracking-tight">
            Run the school day from one honest place.
          </h1>
          <p className="mt-4 text-sm leading-relaxed text-white/70">
            Academic structure, admissions, guardian records and a tamper-evident audit trail.
            Every number on screen is computed from live database rows for this school.
          </p>
          <ul className="mt-8 space-y-3 text-sm text-white/80">
            {[
              'Server-side authorization with least-privilege roles',
              'Section-scoped access for teaching staff',
              'Guardian portal limited to verified linked children',
            ].map((item) => (
              <li key={item} className="flex items-start gap-2.5">
                <span className="mt-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-emerald-400/20 text-emerald-300">
                  <Icon name="check" className="h-3.5 w-3.5" />
                </span>
                {item}
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-xs text-white/40">
          Increment 1 · Academic structure and admissions
        </p>
      </section>

      <section className="flex items-center justify-center bg-slate-50 px-5 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600 text-white">
              <Icon name="book" className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm font-semibold text-slate-900">School ERP</p>
              <p className="text-xs text-slate-500">Greenfield Public School</p>
            </div>
          </div>

          <h2 className="text-xl font-semibold tracking-tight text-slate-900">
            {mode === 'signin' ? 'Sign in' : mode === 'forgot' ? 'Reset your password' : 'Choose a new password'}
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            {mode === 'signin'
              ? 'Use your school account. Sessions are stored in an httpOnly cookie.'
              : mode === 'forgot'
                ? 'We will issue a single-use reset link if the address belongs to an account.'
                : 'Paste your reset token and choose a new password.'}
          </p>

          {error && (
            <div className="mt-4">
              <Alert tone="danger">{error}</Alert>
            </div>
          )}
          {notice && (
            <div className="mt-4">
              <Alert tone="info">{notice}</Alert>
            </div>
          )}

          {mode === 'signin' && (
            <form className="mt-6 space-y-4" onSubmit={handleSubmit} noValidate>
              <Field label="Work email" htmlFor="email">
                <Input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@school.test"
                />
              </Field>

              <Field label="Password" htmlFor="password">
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="••••••••••••"
                />
              </Field>

              {needsCode && (
                <Field
                  label="Authenticator code"
                  htmlFor="totp"
                  hint="Six digits from your authenticator app."
                >
                  <Input
                    id="totp"
                    name="totp"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={6}
                    autoComplete="one-time-code"
                    required
                    value={totpCode}
                    onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, ''))}
                    placeholder="123456"
                  />
                </Field>
              )}

              <Button type="submit" className="w-full" loading={submitting}>
                Sign in
              </Button>

              <button
                type="button"
                className="w-full text-center text-xs font-medium text-brand-700 hover:underline"
                onClick={() => {
                  setMode('forgot');
                  setError(null);
                  setNotice(null);
                }}
              >
                Forgot your password?
              </button>
            </form>
          )}

          {mode === 'forgot' && (
            <form className="mt-6 space-y-4" onSubmit={handleForgot} noValidate>
              <Field label="Work email" htmlFor="forgot-email">
                <Input
                  id="forgot-email"
                  name="email"
                  type="email"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@school.test"
                />
              </Field>
              <Button type="submit" className="w-full" loading={submitting}>
                Send reset link
              </Button>
              <button
                type="button"
                className="w-full text-center text-xs font-medium text-brand-700 hover:underline"
                onClick={() => {
                  setMode('signin');
                  setError(null);
                  setNotice(null);
                }}
              >
                Back to sign in
              </button>
            </form>
          )}

          {mode === 'reset' && (
            <form className="mt-6 space-y-4" onSubmit={handleReset} noValidate>
              <Field label="Reset token" htmlFor="reset-token" hint="Paste the token from your reset link.">
                <Input
                  id="reset-token"
                  name="token"
                  required
                  value={resetToken}
                  onChange={(event) => setResetToken(event.target.value)}
                  placeholder="Reset token"
                />
              </Field>
              <Field
                label="New password"
                htmlFor="new-password"
                hint="At least 12 characters with a letter and a number."
              >
                <Input
                  id="new-password"
                  name="new-password"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                />
              </Field>
              <Field label="Confirm new password" htmlFor="confirm-password">
                <Input
                  id="confirm-password"
                  name="confirm-password"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                />
              </Field>
              <Button type="submit" className="w-full" loading={submitting}>
                Replace password
              </Button>
              <button
                type="button"
                className="w-full text-center text-xs font-medium text-brand-700 hover:underline"
                onClick={() => {
                  setMode('signin');
                  setError(null);
                  setNotice(null);
                }}
              >
                Back to sign in
              </button>
            </form>
          )}

          {mode === 'signin' && (
            <div className="mt-6 rounded-lg border border-slate-200 bg-white">
              <button
                type="button"
                className="flex w-full items-center justify-between px-3 py-2.5 text-left text-xs font-medium text-slate-600"
                onClick={() => setShowDemo((open) => !open)}
                aria-expanded={showDemo}
              >
                Demo accounts (synthetic data)
                <Icon
                  name={showDemo ? 'chevronLeft' : 'chevronRight'}
                  className={showDemo ? 'h-4 w-4 rotate-90' : 'h-4 w-4'}
                />
              </button>
              {showDemo && (
                <ul className="divide-y divide-slate-100 border-t border-slate-100">
                  {DEMO_ACCOUNTS.map((account) => (
                    <li key={account.email}>
                      <button
                        type="button"
                        className="w-full px-3 py-2 text-left hover:bg-slate-50"
                        onClick={() => {
                          setEmail(account.email);
                          setPassword(account.password);
                          setError(null);
                          setNeedsCode(false);
                          setTotpCode('');
                        }}
                      >
                        <p className="text-xs font-medium text-slate-800">{account.role}</p>
                        <p className="font-mono text-[11px] text-slate-500">
                          {account.email} · {account.password}
                        </p>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
