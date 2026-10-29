import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { PERMISSION_DESCRIPTIONS, type Permission } from '@erp/shared/permissions';
import { useAuth } from '../auth/AuthContext';
import { api, errorMessage, fieldErrors } from '../lib/api';
import { disableMfa, enableMfa, getMfaStatus, setupMfa } from '../lib/endpoints';
import { roleLabel } from '../lib/format';
import { useToast } from '../components/ToastProvider';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  Field,
  Input,
  PageHeader,
} from '../components/ui';

export function ProfilePage(): ReactNode {
  const { user, membership } = useAuth();
  const toast = useToast();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});

  const changePassword = useMutation({
    mutationFn: () =>
      api<void>('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      }),
    onSuccess: () => {
      toast.notify('success', 'Password changed. Other sessions were signed out.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setError(null);
      setErrors({});
    },
    onError: (caught) => {
      setError(errorMessage(caught));
      setErrors(fieldErrors(caught));
    },
  });

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setError(null);
    setErrors({});
    if (newPassword !== confirmPassword) {
      setError('The new password and confirmation do not match.');
      return;
    }
    changePassword.mutate();
  }

  const permissions = [...(membership?.permissions ?? [])].sort() as Permission[];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Profile & security"
        description="Your account is shared across every school you belong to. Passwords are hashed with scrypt."
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_1.1fr]">
        <div className="space-y-6">
          <Card>
            <CardHeader title="Account" />
            <dl className="divide-y divide-slate-100">
              <Row label="Name" value={user?.displayName ?? '—'} />
              <Row label="Email" value={user?.email ?? '—'} />
              <Row label="Status" value={<Badge tone="success">{user?.status ?? '—'}</Badge>} />
              <Row
                label="School"
                value={membership ? `${membership.schoolName} (${membership.schoolCode})` : '—'}
              />
              <Row
                label="Roles"
                value={
                  <span className="flex flex-wrap justify-end gap-1">
                    {(membership?.roles ?? []).map((role) => (
                      <Badge key={role} tone="brand">
                        {roleLabel(role)}
                      </Badge>
                    ))}
                    {membership?.roles.length === 0 && '—'}
                  </span>
                }
              />
            </dl>
          </Card>

          <Card>
            <CardHeader
              title={`Permissions (${permissions.length})`}
              description="Checked on the server for every request; this list is informational."
            />
            <ul className="max-h-96 divide-y divide-slate-100 overflow-y-auto">
              {permissions.map((permission) => (
                <li key={permission} className="px-5 py-2.5">
                  <p className="font-mono text-xs text-slate-700">{permission}</p>
                  <p className="text-xs text-slate-500">{PERMISSION_DESCRIPTIONS[permission]}</p>
                </li>
              ))}
              {permissions.length === 0 && (
                <li className="px-5 py-4 text-sm text-slate-500">No permissions assigned.</li>
              )}
            </ul>
          </Card>
        </div>

        <Card>
          <CardHeader
            title="Change password"
            description="At least 12 characters with a letter and a number. Other active sessions are revoked."
          />
          <form className="space-y-4 p-5" onSubmit={submit} noValidate>
            {error && <Alert tone="danger">{error}</Alert>}
            <Field label="Current password" htmlFor="current-password" required>
              <Input
                id="current-password"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                required
              />
            </Field>
            <Field
              label="New password"
              htmlFor="new-password"
              required
              error={errors.newPassword?.[0]}
            >
              <Input
                id="new-password"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                required
              />
            </Field>
            <Field label="Confirm new password" htmlFor="confirm-password" required>
              <Input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                required
              />
            </Field>
            <Button
              type="submit"
              loading={changePassword.isPending}
              disabled={!currentPassword || newPassword.length < 12}
            >
              Change password
            </Button>
          </form>
        </Card>

        <MfaCard />
      </div>
    </div>
  );
}

/* -------------------------- two-factor authentication --------------------- */

function MfaCard(): ReactNode {
  const toast = useToast();
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ['mfa-status'], queryFn: getMfaStatus });
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [enableCode, setEnableCode] = useState('');
  const [password, setPassword] = useState('');
  const [disableCode, setDisableCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['mfa-status'] });
  };

  const beginSetup = useMutation({
    mutationFn: setupMfa,
    onSuccess: (data) => {
      setSetup(data);
      setError(null);
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  const enable = useMutation({
    mutationFn: () => enableMfa(enableCode.trim()),
    onSuccess: () => {
      toast.notify('success', 'Two-factor authentication enabled.');
      setSetup(null);
      setEnableCode('');
      setError(null);
      refresh();
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  const disable = useMutation({
    mutationFn: () => disableMfa(password, disableCode.trim()),
    onSuccess: () => {
      toast.notify('success', 'Two-factor authentication disabled.');
      setPassword('');
      setDisableCode('');
      setSetup(null);
      setError(null);
      refresh();
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  return (
    <Card>
      <CardHeader
        title="Two-factor authentication"
        description="Add a six-digit authenticator code to every sign-in. The secret is only shown once while you set it up."
        actions={
          status.data ? (
            <Badge tone={status.data.enabled ? 'success' : 'neutral'}>
              {status.data.enabled ? 'Enabled' : 'Not enabled'}
            </Badge>
          ) : undefined
        }
      />
      <div className="space-y-4 p-5">
        {status.isError && (
          <Alert tone="danger">
            Two-factor status could not be loaded. {errorMessage(status.error)}
          </Alert>
        )}

        {error && <Alert tone="danger">{error}</Alert>}

        {status.data?.enabled ? (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              setError(null);
              disable.mutate();
            }}
          >
            <p className="text-sm text-slate-600">
              Two-factor is on. Enter your password and a current authenticator code to turn it off.
            </p>
            <Field label="Password" htmlFor="mfa-disable-password" required>
              <Input
                id="mfa-disable-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </Field>
            <Field
              label="Authenticator code"
              htmlFor="mfa-disable-code"
              hint="Six digits from your authenticator app."
              required
            >
              <Input
                id="mfa-disable-code"
                inputMode="numeric"
                maxLength={6}
                value={disableCode}
                onChange={(event) => setDisableCode(event.target.value.replace(/\D/g, ''))}
                required
              />
            </Field>
            <Button
              type="submit"
              variant="secondary"
              loading={disable.isPending}
              disabled={!password || disableCode.length !== 6}
            >
              Disable two-factor
            </Button>
          </form>
        ) : setup ? (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              setError(null);
              enable.mutate();
            }}
          >
            <p className="text-sm text-slate-600">
              Add this secret to your authenticator app, then enter the current code to finish.
            </p>
            <div className="rounded-lg bg-slate-50 px-3 py-2">
              <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">Secret</p>
              <p className="mt-1 font-mono text-sm break-all text-slate-900">{setup.secret}</p>
            </div>
            <div className="rounded-lg bg-slate-50 px-3 py-2">
              <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">Setup link</p>
              <p className="mt-1 font-mono text-xs break-all text-slate-600">{setup.otpauthUrl}</p>
            </div>
            <Field label="Authenticator code" htmlFor="mfa-enable-code" required>
              <Input
                id="mfa-enable-code"
                inputMode="numeric"
                maxLength={6}
                value={enableCode}
                onChange={(event) => setEnableCode(event.target.value.replace(/\D/g, ''))}
                required
              />
            </Field>
            <div className="flex gap-2">
              <Button
                type="submit"
                loading={enable.isPending}
                disabled={enableCode.length !== 6}
              >
                Confirm and enable
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setSetup(null);
                  setEnableCode('');
                  setError(null);
                }}
                disabled={enable.isPending}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-slate-600">
              No authenticator app is linked to this account. You can add one now; you will need it
              each time you sign in.
            </p>
            <Button onClick={() => beginSetup.mutate()} loading={beginSetup.isPending}>
              Set up two-factor
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }): ReactNode {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-3">
      <dt className="text-sm text-slate-500">{label}</dt>
      <dd className="text-right text-sm text-slate-900">{value}</dd>
    </div>
  );
}
