import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { RoleSummary, UserRecord } from '@erp/shared';
import { useAuth, useSchoolId } from '../auth/AuthContext';
import {
  createUser,
  grantRole,
  listAcademicYears,
  listClasses,
  listRoles,
  listSections,
  listUsers,
  revokeRole,
  setUserStatus,
} from '../lib/endpoints';
import { errorMessage, fieldErrors } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { ConfirmDialog, Dialog } from '../components/Dialog';
import { useToast } from '../components/ToastProvider';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  Input,
  PageHeader,
  Select,
  TableSkeleton,
  cn,
} from '../components/ui';

type Tab = 'users' | 'roles';
type DialogState = { kind: 'user' } | { kind: 'role'; user: UserRecord } | null;
type ConfirmTarget =
  | { kind: 'status'; user: UserRecord; status: 'active' | 'locked' | 'disabled' }
  | { kind: 'revoke'; user: UserRecord; assignmentId: string; roleName: string }
  | null;

export function UsersPage(): ReactNode {
  const schoolId = useSchoolId();
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const allowed = can('access.roles.manage');

  const [tab, setTab] = useState<Tab>('users');
  const [dialog, setDialog] = useState<DialogState>(null);
  const [confirming, setConfirming] = useState<ConfirmTarget>(null);

  const roles = useQuery({
    queryKey: ['roles', schoolId],
    queryFn: () => listRoles(schoolId),
    enabled: allowed,
  });
  const users = useQuery({
    queryKey: ['users', schoolId],
    queryFn: () => listUsers(schoolId),
    enabled: allowed,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['users', schoolId] });
  };

  const lifecycle = useMutation({
    mutationFn: async (target: NonNullable<ConfirmTarget>) => {
      if (target.kind === 'status') {
        await setUserStatus(schoolId, target.user.id, target.status);
      } else {
        await revokeRole(schoolId, target.user.id, target.assignmentId);
      }
    },
    onSuccess: (_result, target) => {
      toast.notify(
        'success',
        target.kind === 'status' ? `Account marked ${target.status}.` : 'Role revoked.',
      );
      setConfirming(null);
      invalidate();
    },
    onError: (error) => {
      setConfirming(null);
      toast.notify('error', errorMessage(error));
    },
  });

  if (!allowed) {
    return (
      <div className="space-y-6">
        <PageHeader title="Users & roles" description="Manage accounts and role assignments." />
        <Card>
          <EmptyState
            title="You do not have access"
            description="Only roles with the access management permission can view this page."
            icon="shield"
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Users & roles"
        description="Accounts, role assignments and scopes. Roles decide what a person can do; scope decides which records they can touch."
        actions={
          <Button onClick={() => setDialog({ kind: 'user' })}>
            <Icon name="plus" className="h-4 w-4" />
            New user
          </Button>
        }
      />

      <div className="flex gap-1 border-b border-slate-200" role="tablist" aria-label="Access views">
        {(
          [
            ['users', 'Users'],
            ['roles', 'Roles'],
          ] as Array<[Tab, string]>
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={cn(
              'border-b-2 px-3 py-2 text-sm font-medium transition',
              tab === value
                ? 'border-brand-600 text-brand-700'
                : 'border-transparent text-slate-500 hover:text-slate-800',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'users' ? (
        <Card>
          <CardHeader
            title="Accounts"
            description="Disabling an account immediately revokes its sessions. You cannot disable your own account."
          />
          {users.isPending ? (
            <TableSkeleton rows={6} columns={6} />
          ) : users.isError ? (
            <ErrorState message={errorMessage(users.error)} onRetry={() => void users.refetch()} />
          ) : users.data.items.length === 0 ? (
            <EmptyState title="No users" description="Create the first account." icon="users" />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Email</th>
                    <th>Status</th>
                    <th>Roles & scope</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.data.items.map((user) => (
                    <tr key={user.id}>
                      <td className="font-medium text-slate-900">{user.displayName}</td>
                      <td className="text-sm text-slate-600">{user.email ?? '—'}</td>
                      <td>
                        <Badge
                          tone={
                            user.status === 'active'
                              ? 'success'
                              : user.status === 'locked'
                                ? 'warning'
                                : user.status === 'disabled'
                                  ? 'danger'
                                  : 'neutral'
                          }
                        >
                          {user.status}
                        </Badge>
                      </td>
                      <td>
                        <div className="flex flex-wrap gap-1">
                          {user.roles.length === 0 ? (
                            <span className="text-xs text-slate-400">No roles</span>
                          ) : (
                            user.roles.map((assignment) => (
                              <span
                                key={assignment.assignmentId}
                                className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700"
                                title={`${assignment.roleCode} · ${assignment.scopeType}`}
                              >
                                {assignment.roleName}
                                {assignment.scopeLabel && (
                                  <span className="text-slate-500">· {assignment.scopeLabel}</span>
                                )}
                                <button
                                  type="button"
                                  className="ml-0.5 rounded-full px-1 text-slate-400 hover:bg-slate-200 hover:text-rose-600"
                                  aria-label={`Revoke ${assignment.roleName}`}
                                  onClick={() =>
                                    setConfirming({
                                      kind: 'revoke',
                                      user,
                                      assignmentId: assignment.assignmentId,
                                      roleName: assignment.roleName,
                                    })
                                  }
                                >
                                  ×
                                </button>
                              </span>
                            ))
                          )}
                        </div>
                      </td>
                      <td>
                        <div className="flex flex-wrap justify-end gap-2">
                          <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'role', user })}>
                            Add role
                          </Button>
                          {user.status === 'active' ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setConfirming({ kind: 'status', user, status: 'disabled' })}
                            >
                              Disable
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setConfirming({ kind: 'status', user, status: 'active' })}
                            >
                              Enable
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : (
        <Card>
          <CardHeader
            title="Roles"
            description="Built-in role catalog loaded from the permission tables."
          />
          {roles.isPending ? (
            <TableSkeleton rows={5} columns={3} />
          ) : roles.isError ? (
            <ErrorState message={errorMessage(roles.error)} onRetry={() => void roles.refetch()} />
          ) : (
            <div className="divide-y divide-slate-100">
              {roles.data.items.map((role) => (
                <div key={role.code} className="px-5 py-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-medium text-slate-900">
                        {role.name}{' '}
                        <span className="font-mono text-xs text-slate-500">({role.code})</span>
                      </p>
                      <p className="text-sm text-slate-500">{role.description}</p>
                    </div>
                    <Badge tone="neutral">Default scope: {role.defaultScopeType}</Badge>
                  </div>
                  <p className="mt-2 text-xs text-slate-500">
                    {role.permissions.length} permissions · {role.permissions.slice(0, 8).join(', ')}
                    {role.permissions.length > 8 ? '…' : ''}
                  </p>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {dialog?.kind === 'user' && (
        <UserDialog
          roles={roles.data?.items ?? []}
          onClose={() => setDialog(null)}
          onSaved={() => {
            toast.notify('success', 'Account created. Share the password securely.');
            setDialog(null);
            invalidate();
          }}
        />
      )}

      {dialog?.kind === 'role' && (
        <RoleDialog
          user={dialog.user}
          roles={roles.data?.items ?? []}
          onClose={() => setDialog(null)}
          onSaved={() => {
            toast.notify('success', 'Role granted.');
            setDialog(null);
            invalidate();
          }}
        />
      )}

      <ConfirmDialog
        open={confirming !== null}
        title={
          confirming?.kind === 'status'
            ? confirming.status === 'disabled'
              ? 'Disable account'
              : 'Enable account'
            : 'Revoke role'
        }
        message={
          confirming?.kind === 'status' ? (
            <p>
              {confirming.status === 'disabled' ? 'Disable' : 'Enable'}{' '}
              <strong>{confirming.user.displayName}</strong>?
              {confirming.status === 'disabled' && ' Their active sessions will be revoked.'}
            </p>
          ) : confirming?.kind === 'revoke' ? (
            <p>
              Revoke <strong>{confirming.roleName}</strong> from{' '}
              <strong>{confirming.user.displayName}</strong>?
            </p>
          ) : null
        }
        confirmLabel={
          confirming?.kind === 'status'
            ? confirming.status === 'disabled'
              ? 'Disable'
              : 'Enable'
            : 'Revoke role'
        }
        destructive={confirming?.kind === 'revoke' || (confirming?.kind === 'status' && confirming.status === 'disabled')}
        busy={lifecycle.isPending}
        onConfirm={() => confirming && lifecycle.mutate(confirming)}
        onClose={() => setConfirming(null)}
      />
    </div>
  );
}

function UserDialog({
  roles,
  onClose,
  onSaved,
}: {
  roles: RoleSummary[];
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  const schoolId = useSchoolId();
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [roleCode, setRoleCode] = useState(roles[0]?.code ?? '');
  const [scopeId, setScopeId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});

  const selectedRole = roles.find((role) => role.code === roleCode);
  const scopeType = selectedRole?.defaultScopeType ?? 'school';
  const needsSection = scopeType === 'section';
  const needsClass = scopeType === 'class';

  const years = useQuery({
    queryKey: ['academic-years', schoolId],
    queryFn: () => listAcademicYears(schoolId),
    enabled: needsSection,
  });
  const sectionYear = years.data?.items.find((year) => year.status === 'active')?.id ?? '';
  const sections = useQuery({
    queryKey: ['sections', schoolId, sectionYear],
    queryFn: () => listSections(schoolId, { academicYearId: sectionYear }),
    enabled: needsSection && Boolean(sectionYear),
  });
  const classes = useQuery({
    queryKey: ['classes', schoolId],
    queryFn: () => listClasses(schoolId),
    enabled: needsClass,
  });

  useEffect(() => {
    setScopeId('');
  }, [roleCode]);

  const mutation = useMutation({
    mutationFn: () =>
      createUser(schoolId, {
        email,
        displayName,
        password,
        roleCode,
        scopeType,
        scopeId: needsSection || needsClass ? scopeId : null,
      }),
    onSuccess: onSaved,
    onError: (caught) => {
      setError(errorMessage(caught));
      setErrors(fieldErrors(caught));
    },
  });

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setError(null);
    setErrors({});
    mutation.mutate();
  }

  const scopeOptions = needsSection
    ? (sections.data?.items ?? []).map((section) => ({
        id: section.id,
        label: `${section.className} · ${section.name}`,
      }))
    : needsClass
      ? (classes.data?.items ?? []).map((klass) => ({ id: klass.id, label: klass.name }))
      : [];

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="New user"
      description="A strong temporary password is required because email delivery is not configured. Share it securely and ask the user to change it."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            form="user-form"
            type="submit"
            loading={mutation.isPending}
            disabled={!roleCode || ((needsSection || needsClass) && !scopeId)}
          >
            Create account
          </Button>
        </>
      }
    >
      <form id="user-form" className="space-y-4" onSubmit={submit} noValidate>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Display name" htmlFor="user-name" required error={errors.displayName?.[0]}>
            <Input
              id="user-name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              required
            />
          </Field>
          <Field label="Email" htmlFor="user-email" required error={errors.email?.[0]}>
            <Input
              id="user-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </Field>
          <Field
            label="Temporary password"
            htmlFor="user-password"
            required
            error={errors.password?.[0]}
            hint="At least 12 characters with a letter and a number."
          >
            <Input
              id="user-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              required
            />
          </Field>
          <Field label="Role" htmlFor="user-role" required error={errors.roleCode?.[0]}>
            <Select id="user-role" value={roleCode} onChange={(event) => setRoleCode(event.target.value)}>
              {roles.map((role) => (
                <option key={role.code} value={role.code}>
                  {role.name}
                </option>
              ))}
            </Select>
          </Field>
          {(needsSection || needsClass) && (
            <div className="sm:col-span-2">
              <Field
                label={needsSection ? 'Section scope' : 'Class scope'}
                htmlFor="user-scope"
                required
                error={errors.scopeId?.[0]}
                hint="A scoped role only sees records inside this selection."
              >
                <Select
                  id="user-scope"
                  value={scopeId}
                  onChange={(event) => setScopeId(event.target.value)}
                  required
                >
                  <option value="">Choose…</option>
                  {scopeOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          )}
        </div>
        {selectedRole && (
          <p className="text-xs text-slate-500">
            {selectedRole.description} · {selectedRole.permissions.length} permissions.
          </p>
        )}
      </form>
    </Dialog>
  );
}

function RoleDialog({
  user,
  roles,
  onClose,
  onSaved,
}: {
  user: UserRecord;
  roles: RoleSummary[];
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  const schoolId = useSchoolId();
  const [roleCode, setRoleCode] = useState(roles[0]?.code ?? '');
  const [scopeId, setScopeId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});

  const selectedRole = roles.find((role) => role.code === roleCode);
  const scopeType = selectedRole?.defaultScopeType ?? 'school';
  const needsSection = scopeType === 'section';
  const needsClass = scopeType === 'class';

  const years = useQuery({
    queryKey: ['academic-years', schoolId],
    queryFn: () => listAcademicYears(schoolId),
    enabled: needsSection,
  });
  const sectionYear = years.data?.items.find((year) => year.status === 'active')?.id ?? '';
  const sections = useQuery({
    queryKey: ['sections', schoolId, sectionYear],
    queryFn: () => listSections(schoolId, { academicYearId: sectionYear }),
    enabled: needsSection && Boolean(sectionYear),
  });
  const classes = useQuery({
    queryKey: ['classes', schoolId],
    queryFn: () => listClasses(schoolId),
    enabled: needsClass,
  });

  useEffect(() => {
    setScopeId('');
  }, [roleCode]);

  const mutation = useMutation({
    mutationFn: () =>
      grantRole(schoolId, user.id, {
        roleCode,
        scopeType,
        scopeId: needsSection || needsClass ? scopeId : null,
      }),
    onSuccess: onSaved,
    onError: (caught) => {
      setError(errorMessage(caught));
      setErrors(fieldErrors(caught));
    },
  });

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setError(null);
    setErrors({});
    mutation.mutate();
  }

  const scopeOptions = needsSection
    ? (sections.data?.items ?? []).map((section) => ({
        id: section.id,
        label: `${section.className} · ${section.name}`,
      }))
    : needsClass
      ? (classes.data?.items ?? []).map((klass) => ({ id: klass.id, label: klass.name }))
      : [];

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Add a role · ${user.displayName}`}
      description={`${formatDateTime(user.createdAt)} · ${user.status}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            form="role-form"
            type="submit"
            loading={mutation.isPending}
            disabled={!roleCode || ((needsSection || needsClass) && !scopeId)}
          >
            Grant role
          </Button>
        </>
      }
    >
      <form id="role-form" className="space-y-4" onSubmit={submit} noValidate>
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Role" htmlFor="grant-role" required error={errors.roleCode?.[0]}>
          <Select id="grant-role" value={roleCode} onChange={(event) => setRoleCode(event.target.value)}>
            {roles.map((role) => (
              <option key={role.code} value={role.code}>
                {role.name}
              </option>
            ))}
          </Select>
        </Field>
        {(needsSection || needsClass) && (
          <Field
            label={needsSection ? 'Section scope' : 'Class scope'}
            htmlFor="grant-scope"
            required
            error={errors.scopeId?.[0]}
          >
            <Select
              id="grant-scope"
              value={scopeId}
              onChange={(event) => setScopeId(event.target.value)}
              required
            >
              <option value="">Choose…</option>
              {scopeOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </form>
    </Dialog>
  );
}
