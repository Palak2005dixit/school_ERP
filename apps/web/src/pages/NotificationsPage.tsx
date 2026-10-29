import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import type {
  InAppNotification,
  NotificationPreference,
  NotificationTemplate,
} from '@erp/shared';
import { useAuth, useSchoolId } from '../auth/AuthContext';
import {
  createNotificationTemplate,
  dispatchNotifications,
  getNotificationOutboxRecord,
  getNotificationProviderStatus,
  listInbox,
  listNotificationOutbox,
  listNotificationPreferences,
  listNotificationTemplates,
  listUsers,
  markAllNotificationsRead,
  markNotificationRead,
  queueNotification,
  saveNotificationPreference,
  sendInAppNotification,
  sendNotification,
  updateNotificationTemplate,
} from '../lib/endpoints';
import { errorMessage } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { Dialog } from '../components/Dialog';
import { Tabs } from '../components/Tabs';
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
  StatCard,
  TableSkeleton,
  Textarea,
} from '../components/ui';

type Tab = 'inbox' | 'outbox' | 'templates' | 'preferences';

const CHANNELS = ['email', 'sms', 'whatsapp'] as const;
const ALL_CHANNELS = ['inapp', 'email', 'sms', 'whatsapp'] as const;
const OUTBOX_STATUSES = [
  'queued',
  'processing',
  'sent',
  'failed',
  'blocked',
  'cancelled',
] as const;
const TEMPLATE_CHANNELS = ['inapp', 'email', 'sms', 'whatsapp'] as const;

type DialogState =
  | { kind: 'in-app' }
  | { kind: 'queue' }
  | { kind: 'template'; template?: NotificationTemplate }
  | { kind: 'outbox'; id: string }
  | null;

export function NotificationsPage(): ReactNode {
  const schoolId = useSchoolId();
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();

  const canView = can('notifications.view');
  const canManage = can('notifications.manage');
  const canSend = can('notifications.send');
  const canListUsers = can('access.roles.manage');

  const [tab, setTab] = useState<Tab>('inbox');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [outboxStatus, setOutboxStatus] = useState('');
  const [outboxChannel, setOutboxChannel] = useState('');
  const [dialog, setDialog] = useState<DialogState>(null);
  const [formError, setFormError] = useState('');

  const inbox = useQuery({
    queryKey: ['inbox', schoolId, unreadOnly],
    queryFn: () => listInbox(schoolId, unreadOnly),
    enabled: canView && tab === 'inbox',
  });
  const providers = useQuery({
    queryKey: ['notification-provider', schoolId],
    queryFn: () => getNotificationProviderStatus(schoolId),
    enabled: canManage,
  });
  const outbox = useQuery({
    queryKey: ['notification-outbox', schoolId, outboxStatus, outboxChannel],
    queryFn: () =>
      listNotificationOutbox(schoolId, {
        status: outboxStatus || undefined,
        channel: outboxChannel || undefined,
      }),
    enabled: canManage && tab === 'outbox',
  });
  const templates = useQuery({
    queryKey: ['notification-templates', schoolId],
    queryFn: () => listNotificationTemplates(schoolId),
    enabled: canManage && (tab === 'templates' || tab === 'outbox'),
  });
  const preferences = useQuery({
    queryKey: ['notification-preferences', schoolId],
    queryFn: () => listNotificationPreferences(schoolId),
    enabled: canView && tab === 'preferences',
  });
  const users = useQuery({
    queryKey: ['users', schoolId],
    queryFn: () => listUsers(schoolId),
    enabled: canListUsers && canManage && (tab === 'outbox' || dialog?.kind === 'in-app'),
  });
  const outboxDetail = useQuery({
    queryKey: ['notification-outbox-record', schoolId, dialog?.kind === 'outbox' ? dialog.id : ''],
    queryFn: () => getNotificationOutboxRecord(schoolId, dialog?.kind === 'outbox' ? dialog.id : ''),
    enabled: canManage && dialog?.kind === 'outbox',
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['inbox', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['notification-outbox', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['notification-outbox-record', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['notification-templates', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['notification-preferences', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['notification-provider', schoolId] });
  };

  const read = useMutation({
    mutationFn: (id: string) => markNotificationRead(schoolId, id),
    onSuccess: invalidate,
    onError: (error) => toast.notify('error', errorMessage(error)),
  });
  const readAll = useMutation({
    mutationFn: () => markAllNotificationsRead(schoolId),
    onSuccess: () => {
      toast.notify('success', 'Inbox marked as read.');
      invalidate();
    },
    onError: (error) => toast.notify('error', errorMessage(error)),
  });
  const sendInApp = useMutation({
    mutationFn: (input: Parameters<typeof sendInAppNotification>[1]) =>
      sendInAppNotification(schoolId, input),
    onSuccess: () => {
      toast.notify('success', 'In-app notification sent.');
      setDialog(null);
      invalidate();
    },
    onError: (error) => setFormError(errorMessage(error)),
  });
  const saveTemplate = useMutation({
    mutationFn: (input: { id?: string; body: Record<string, unknown> }) =>
      input.id
        ? updateNotificationTemplate(schoolId, input.id, input.body)
        : createNotificationTemplate(
            schoolId,
            input.body as Parameters<typeof createNotificationTemplate>[1],
          ),
    onSuccess: () => {
      toast.notify('success', 'Template saved.');
      setDialog(null);
      invalidate();
    },
    onError: (error) => setFormError(errorMessage(error)),
  });
  const savePreference = useMutation({
    mutationFn: (input: { channel: string; enabled: boolean; consent?: boolean }) =>
      saveNotificationPreference(schoolId, input),
    onSuccess: () => {
      toast.notify('success', 'Preference saved.');
      invalidate();
    },
    onError: (error) => toast.notify('error', errorMessage(error)),
  });
  const queue = useMutation({
    mutationFn: (input: Parameters<typeof queueNotification>[1]) => queueNotification(schoolId, input),
    onSuccess: (result) => {
      toast.notify(
        'success',
        result.status === 'blocked'
          ? 'Message recorded as blocked: no external provider is configured.'
          : 'Message queued.',
      );
      setDialog(null);
      invalidate();
    },
    onError: (error) => setFormError(errorMessage(error)),
  });
  const send = useMutation({
    mutationFn: (id: string) => sendNotification(schoolId, id),
    onSuccess: () => {
      toast.notify('success', 'Delivery attempted. Check the outbox status.');
      invalidate();
    },
    onError: (error) => toast.notify('error', errorMessage(error)),
  });
  const dispatch = useMutation({
    mutationFn: () => dispatchNotifications(schoolId),
    onSuccess: (result) => {
      toast.notify(
        'success',
        `Dispatch finished: ${result.sent} sent, ${result.failed} failed, ${result.blocked} blocked.`,
      );
      invalidate();
    },
    onError: (error) => toast.notify('error', errorMessage(error)),
  });

  const templateOptions = templates.data?.items ?? [];
  const userOptions = (users.data?.items ?? [])
    .filter((user) => user.status === 'active')
    .map((user) => ({ id: user.id, name: user.displayName }));

  const tabs: Array<{ value: Tab; label: string }> = [
    { value: 'inbox', label: 'Inbox' },
    ...(canManage
      ? [
          { value: 'outbox' as Tab, label: 'Outbox' },
          { value: 'templates' as Tab, label: 'Templates' },
        ]
      : []),
    { value: 'preferences', label: 'Preferences' },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Notifications"
        description="In-app messages are always delivered. Email, SMS and WhatsApp are only queued with recorded consent and are only marked sent after a configured provider confirms delivery."
        actions={
          <div className="flex flex-wrap gap-2">
            {canManage && canSend && canListUsers && (
              <Button variant="secondary" onClick={() => setDialog({ kind: 'in-app' })}>
                <Icon name="user" className="h-4 w-4" />
                Send in-app
              </Button>
            )}
            {canSend && (
              <Button onClick={() => setDialog({ kind: 'queue' })}>
                <Icon name="paperclip" className="h-4 w-4" />
                Queue message
              </Button>
            )}
          </div>
        }
      />

      <Tabs value={tab} onChange={setTab} tabs={tabs} label="Notification views" />

      {tab === 'inbox' && canView && (
        <Card>
          <CardHeader
            title="Inbox"
            description="Your in-app notifications. Unread counts are per user and are never shared between staff."
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-2 text-sm text-slate-600">
                  <input
                    type="checkbox"
                    checked={unreadOnly}
                    onChange={(event) => setUnreadOnly(event.target.checked)}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                  Unread only
                </label>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={readAll.isPending}
                  onClick={() => readAll.mutate()}
                >
                  Mark all read
                </Button>
              </div>
            }
          />
          {inbox.isPending ? (
            <TableSkeleton rows={5} columns={3} />
          ) : inbox.isError ? (
            <ErrorState message={errorMessage(inbox.error)} onRetry={() => void inbox.refetch()} />
          ) : (inbox.data?.items.length ?? 0) === 0 ? (
            <EmptyState
              title="Nothing here"
              description="You have no notifications in this view."
              icon="shield"
            />
          ) : (
            <ul className="divide-y divide-slate-100">
              <li className="bg-slate-50 px-4 py-2 text-xs text-slate-500">
                {inbox.data!.unread} unread
              </li>
              {inbox.data!.items.map((item) => (
                <InboxRow key={item.id} item={item} onRead={() => read.mutate(item.id)} />
              ))}
            </ul>
          )}
        </Card>
      )}

      {tab === 'outbox' && canManage && (
        <div className="space-y-4">
          <ProviderBanner
            status={providers.data}
            loading={providers.isPending}
            error={providers.isError ? errorMessage(providers.error) : ''}
            onRetry={() => void providers.refetch()}
            onDispatch={() => dispatch.mutate()}
            dispatching={dispatch.isPending}
            canSend={canSend}
          />
          <Card>
            <CardHeader
              title="Delivery outbox"
              description="Blocked rows mean no provider is configured. Nothing is reported as sent without a provider response."
              actions={
                <div className="flex flex-wrap gap-2">
                  <Select
                    aria-label="Filter outbox by status"
                    value={outboxStatus}
                    onChange={(event) => setOutboxStatus(event.target.value)}
                    className="w-36"
                  >
                    <option value="">All statuses</option>
                    {OUTBOX_STATUSES.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </Select>
                  <Select
                    aria-label="Filter outbox by channel"
                    value={outboxChannel}
                    onChange={(event) => setOutboxChannel(event.target.value)}
                    className="w-32"
                  >
                    <option value="">All channels</option>
                    {CHANNELS.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </Select>
                </div>
              }
            />
            {outbox.isPending ? (
              <TableSkeleton rows={6} columns={5} />
            ) : outbox.isError ? (
              <ErrorState
                message={errorMessage(outbox.error)}
                onRetry={() => void outbox.refetch()}
              />
            ) : (outbox.data?.items.length ?? 0) === 0 ? (
              <EmptyState
                title="Outbox empty"
                description="Queue an external message to see it here."
                icon="paperclip"
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Recipient</th>
                      <th>Channel</th>
                      <th>Subject</th>
                      <th>Status</th>
                      <th className="text-right">Attempts</th>
                      <th>Created</th>
                      <th className="text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {outbox.data!.items.map((row) => (
                      <tr key={row.id}>
                        <td className="text-sm text-slate-700">{row.recipientAddress}</td>
                        <td>
                          <Badge tone="info">{row.channel}</Badge>
                        </td>
                        <td className="max-w-xs truncate text-sm text-slate-600">
                          {row.subject ?? row.templateCode ?? '—'}
                        </td>
                        <td>
                          <Badge
                            tone={
                              row.status === 'sent'
                                ? 'success'
                                : row.status === 'failed'
                                  ? 'danger'
                                  : row.status === 'blocked'
                                    ? 'warning'
                                    : 'neutral'
                            }
                          >
                            {row.status}
                          </Badge>
                        </td>
                        <td className="text-right tabular-nums">
                          {row.attempts}/{row.maxAttempts}
                        </td>
                        <td className="text-sm text-slate-600">{formatDateTime(row.createdAt)}</td>
                        <td>
                          <div className="flex flex-wrap justify-end gap-2">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setDialog({ kind: 'outbox', id: row.id })}
                            >
                              Details
                            </Button>
                            {canSend && row.status !== 'sent' && row.status !== 'cancelled' && (
                              <Button
                                size="sm"
                                loading={send.isPending}
                                onClick={() => send.mutate(row.id)}
                              >
                                Attempt
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
        </div>
      )}

      {tab === 'templates' && canManage && (
        <Card>
          <CardHeader
            title="Message templates"
            description="Templates are reusable subject/body pairs per channel. They never bypass consent or provider checks."
            actions={
              <Button size="sm" onClick={() => setDialog({ kind: 'template' })}>
                New template
              </Button>
            }
          />
          {templates.isPending ? (
            <TableSkeleton rows={5} columns={4} />
          ) : templates.isError ? (
            <ErrorState
              message={errorMessage(templates.error)}
              onRetry={() => void templates.refetch()}
            />
          ) : templateOptions.length === 0 ? (
            <EmptyState
              title="No templates"
              description="Add a template to standardise messages."
              icon="book"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Channel</th>
                    <th>Subject</th>
                    <th>Status</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {templateOptions.map((row) => (
                    <tr key={row.id}>
                      <td className="font-mono text-xs">{row.code}</td>
                      <td>
                        <Badge tone="info">{row.channel}</Badge>
                      </td>
                      <td className="max-w-md truncate text-sm text-slate-600">
                        {row.subject ?? row.body}
                      </td>
                      <td>
                        <Badge tone={row.active ? 'success' : 'neutral'}>
                          {row.active ? 'active' : 'inactive'}
                        </Badge>
                      </td>
                      <td className="text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDialog({ kind: 'template', template: row })}
                        >
                          Edit
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'preferences' && canView && (
        <PreferencesPanel
          items={preferences.data?.items}
          loading={preferences.isPending}
          error={preferences.isError ? errorMessage(preferences.error) : ''}
          saving={savePreference.isPending}
          onRetry={() => void preferences.refetch()}
          onSave={(input) => savePreference.mutate(input)}
        />
      )}

      {dialog?.kind === 'in-app' && (
        <InAppDialog
          users={userOptions}
          error={formError}
          saving={sendInApp.isPending}
          onClose={() => {
            setDialog(null);
            setFormError('');
          }}
          onSave={(body) => sendInApp.mutate(body)}
        />
      )}

      {dialog?.kind === 'queue' && (
        <QueueDialog
          users={userOptions}
          canListUsers={canListUsers}
          templates={templateOptions.filter((template) => template.active)}
          providerConfigured={providers.data?.configured ?? false}
          error={formError}
          saving={queue.isPending}
          onClose={() => {
            setDialog(null);
            setFormError('');
          }}
          onSave={(body) => queue.mutate(body)}
        />
      )}

      {dialog?.kind === 'template' && (
        <TemplateDialog
          key={dialog.template?.id ?? 'new-template'}
          template={dialog.template}
          error={formError}
          saving={saveTemplate.isPending}
          onClose={() => {
            setDialog(null);
            setFormError('');
          }}
          onSave={(body) => saveTemplate.mutate({ id: dialog.template?.id, body })}
        />
      )}

      {dialog?.kind === 'outbox' && (
        <Dialog
          open
          onClose={() => setDialog(null)}
          title="Delivery record"
          description="Every attempt is recorded. Blocked means the message was never sent."
          size="lg"
        >
          {outboxDetail.isPending ? (
            <TableSkeleton rows={4} columns={2} />
          ) : outboxDetail.isError ? (
            <ErrorState
              message={errorMessage(outboxDetail.error)}
              onRetry={() => void outboxDetail.refetch()}
            />
          ) : outboxDetail.data ? (
            <div className="space-y-4">
              <div className="grid gap-3 text-sm sm:grid-cols-2">
                <Detail label="Recipient" value={outboxDetail.data.recipientAddress} />
                <Detail label="Channel" value={outboxDetail.data.channel} />
                <Detail label="Status" value={outboxDetail.data.status} />
                <Detail label="Provider" value={outboxDetail.data.provider ?? 'None'} />
                <Detail label="Created" value={formatDateTime(outboxDetail.data.createdAt)} />
                <Detail
                  label="Sent"
                  value={
                    outboxDetail.data.sentAt ? formatDateTime(outboxDetail.data.sentAt) : 'Not sent'
                  }
                />
              </div>
              {outboxDetail.data.lastError && (
                <Alert tone="warning">{outboxDetail.data.lastError}</Alert>
              )}
              <div>
                <p className="text-sm font-semibold text-slate-800">Message</p>
                <p className="mt-1 whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                  {outboxDetail.data.body}
                </p>
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-800">Attempts</p>
                {outboxDetail.data.attemptsLog.length === 0 ? (
                  <p className="mt-1 text-sm text-slate-500">No attempts recorded yet.</p>
                ) : (
                  <ul className="mt-1 space-y-1 text-sm">
                    {outboxDetail.data.attemptsLog.map((attempt) => (
                      <li
                        key={attempt.attemptNo}
                        className="rounded border border-slate-100 px-2 py-1"
                      >
                        <span className="font-medium">#{attempt.attemptNo}</span> · {attempt.outcome}
                        {attempt.provider ? ` · ${attempt.provider}` : ''} ·{' '}
                        {formatDateTime(attempt.occurredAt)}
                        {attempt.error && (
                          <p className="text-xs text-rose-600">{attempt.error}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ) : null}
        </Dialog>
      )}
    </div>
  );
}

function InboxRow({
  item,
  onRead,
}: {
  item: InAppNotification;
  onRead: () => void;
}): ReactNode {
  return (
    <li className={item.readAt ? 'px-4 py-3' : 'bg-brand-50/40 px-4 py-3'}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium text-slate-900">{item.title}</p>
            <Badge tone="neutral">{item.category}</Badge>
            {!item.readAt && <Badge tone="brand">unread</Badge>}
          </div>
          <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{item.body}</p>
          <p className="mt-1 text-xs text-slate-400">{formatDateTime(item.createdAt)}</p>
          {item.link && (
            <a href={item.link} className="mt-1 inline-block text-sm text-brand-700 hover:underline">
              Open link
            </a>
          )}
        </div>
        {!item.readAt && (
          <Button size="sm" variant="ghost" onClick={onRead}>
            Mark read
          </Button>
        )}
      </div>
    </li>
  );
}

function ProviderBanner({
  status,
  loading,
  error,
  onRetry,
  onDispatch,
  dispatching,
  canSend,
}: {
  status: { configured: boolean; provider: string | null; message: string } | undefined;
  loading: boolean;
  error: string;
  onRetry: () => void;
  onDispatch: () => void;
  dispatching: boolean;
  canSend: boolean;
}): ReactNode {
  if (loading) return <TableSkeleton rows={1} columns={1} />;
  if (error) return <ErrorState message={error} onRetry={onRetry} />;
  return (
    <div className="space-y-2">
      <Alert tone={status?.configured ? 'success' : 'warning'} title="External delivery">
        {status?.message}
      </Alert>
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-4 py-3">
        <div className="flex flex-wrap gap-3 text-sm text-slate-600">
          <StatCard label="Provider" value={status?.provider ?? 'Not configured'} />
        </div>
        {canSend && (
          <Button
            size="sm"
            variant="secondary"
            loading={dispatching}
            disabled={!status?.configured}
            onClick={onDispatch}
          >
            Dispatch queued
          </Button>
        )}
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div>
      <p className="text-xs text-slate-500">{label}</p>
      <p className="font-medium text-slate-800">{value}</p>
    </div>
  );
}

function InAppDialog({
  users,
  error,
  saving,
  onClose,
  onSave,
}: {
  users: Array<{ id: string; name: string }>;
  error: string;
  saving: boolean;
  onClose: () => void;
  onSave: (body: Parameters<typeof sendInAppNotification>[1]) => void;
}): ReactNode {
  const [userId, setUserId] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [category, setCategory] = useState('general');
  const [link, setLink] = useState('');

  return (
    <Dialog
      open
      onClose={onClose}
      title="Send in-app notification"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="in-app-form" loading={saving}>
            Send
          </Button>
        </>
      }
    >
      <form
        id="in-app-form"
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({ userId, title, body, category: category || undefined, link: link || undefined });
        }}
      >
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Recipient" htmlFor="app-user" required>
          <Select
            id="app-user"
            value={userId}
            onChange={(event) => setUserId(event.target.value)}
            required
          >
            <option value="">Select user</option>
            {users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Title" htmlFor="app-title" required>
          <Input
            id="app-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            required
          />
        </Field>
        <Field label="Message" htmlFor="app-body" required>
          <Textarea
            id="app-body"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            maxLength={4000}
            required
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Category" htmlFor="app-category">
            <Input
              id="app-category"
              value={category}
              onChange={(event) => setCategory(event.target.value)}
            />
          </Field>
          <Field label="Link" htmlFor="app-link" hint="Optional in-app path or URL.">
            <Input id="app-link" value={link} onChange={(event) => setLink(event.target.value)} />
          </Field>
        </div>
      </form>
    </Dialog>
  );
}

function QueueDialog({
  users,
  canListUsers,
  templates,
  providerConfigured,
  error,
  saving,
  onClose,
  onSave,
}: {
  users: Array<{ id: string; name: string }>;
  canListUsers: boolean;
  templates: NotificationTemplate[];
  providerConfigured: boolean;
  error: string;
  saving: boolean;
  onClose: () => void;
  onSave: (body: Parameters<typeof queueNotification>[1]) => void;
}): ReactNode {
  const [channel, setChannel] = useState<(typeof CHANNELS)[number]>('email');
  const [recipientUserId, setRecipientUserId] = useState('');
  const [recipientAddress, setRecipientAddress] = useState('');
  const [templateCode, setTemplateCode] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');

  return (
    <Dialog
      open
      onClose={onClose}
      title="Queue external message"
      description="The recipient must have recorded consent for the chosen channel when a linked user is selected. Without a provider the message is saved as blocked."
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="queue-form" loading={saving}>
            Queue message
          </Button>
        </>
      }
    >
      <form
        id="queue-form"
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({
            channel,
            recipientUserId: recipientUserId || undefined,
            recipientAddress,
            templateCode: templateCode || undefined,
            subject: subject || undefined,
            body,
          });
        }}
      >
        {error && <Alert tone="danger">{error}</Alert>}
        {!providerConfigured && (
          <Alert tone="warning">
            No external provider is configured. This message will be recorded with status blocked,
            not sent.
          </Alert>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Channel" htmlFor="queue-channel" required>
            <Select
              id="queue-channel"
              value={channel}
              onChange={(event) => setChannel(event.target.value as typeof channel)}
            >
              {CHANNELS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Template" htmlFor="queue-template">
            <Select
              id="queue-template"
              value={templateCode}
              onChange={(event) => {
                const code = event.target.value;
                setTemplateCode(code);
                const template = templates.find((row) => row.code === code);
                if (template) {
                  setSubject(template.subject ?? '');
                  setBody(template.body);
                }
              }}
            >
              <option value="">No template</option>
              {templates.map((template) => (
                <option key={template.id} value={template.code}>
                  {template.code} · {template.channel}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field
          label="Linked user"
          htmlFor="queue-user"
          hint={
            canListUsers
              ? 'Optional. Consent is checked for the linked user before queueing.'
              : 'Listing users requires the roles management permission. Enter an address instead.'
          }
        >
          {canListUsers ? (
            <Select
              id="queue-user"
              value={recipientUserId}
              onChange={(event) => {
                setRecipientUserId(event.target.value);
                const user = users.find((row) => row.id === event.target.value);
                if (user && !recipientAddress) {
                  setRecipientAddress(user.name);
                }
              }}
            >
              <option value="">No linked user</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name}
                </option>
              ))}
            </Select>
          ) : (
            <Input id="queue-user" value="" disabled placeholder="Unavailable" />
          )}
        </Field>
        <Field label="Recipient address" htmlFor="queue-address" required>
          <Input
            id="queue-address"
            value={recipientAddress}
            onChange={(event) => setRecipientAddress(event.target.value)}
            required
          />
        </Field>
        <Field label="Subject" htmlFor="queue-subject">
          <Input
            id="queue-subject"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
          />
        </Field>
        <Field label="Message" htmlFor="queue-body" required>
          <Textarea
            id="queue-body"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            maxLength={10000}
            required
          />
        </Field>
      </form>
    </Dialog>
  );
}

function TemplateDialog({
  template,
  error,
  saving,
  onClose,
  onSave,
}: {
  template?: NotificationTemplate;
  error: string;
  saving: boolean;
  onClose: () => void;
  onSave: (body: Record<string, unknown>) => void;
}): ReactNode {
  const [code, setCode] = useState(template?.code ?? '');
  const [channel, setChannel] = useState<(typeof TEMPLATE_CHANNELS)[number]>(
    template?.channel ?? 'email',
  );
  const [subject, setSubject] = useState(template?.subject ?? '');
  const [body, setBody] = useState(template?.body ?? '');
  const [active, setActive] = useState(template?.active ?? true);

  return (
    <Dialog
      open
      onClose={onClose}
      title={template ? 'Edit template' : 'New template'}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="template-form" loading={saving}>
            Save template
          </Button>
        </>
      }
    >
      <form
        id="template-form"
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({ code, channel, subject: subject || undefined, body, active });
        }}
      >
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Code" htmlFor="tpl-code" required>
            <Input
              id="tpl-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              pattern="[a-z0-9_-]+"
              required
            />
          </Field>
          <Field label="Channel" htmlFor="tpl-channel">
            <Select
              id="tpl-channel"
              value={channel}
              onChange={(event) => setChannel(event.target.value as typeof channel)}
            >
              {TEMPLATE_CHANNELS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Subject" htmlFor="tpl-subject">
          <Input
            id="tpl-subject"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
          />
        </Field>
        <Field label="Body" htmlFor="tpl-body" required>
          <Textarea
            id="tpl-body"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            maxLength={10000}
            required
          />
        </Field>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={active}
            onChange={(event) => setActive(event.target.checked)}
            className="h-4 w-4 rounded border-slate-300"
          />
          Active
        </label>
      </form>
    </Dialog>
  );
}

function PreferencesPanel({
  items,
  loading,
  error,
  saving,
  onRetry,
  onSave,
}: {
  items: NotificationPreference[] | undefined;
  loading: boolean;
  error: string;
  saving: boolean;
  onRetry: () => void;
  onSave: (input: { channel: string; enabled: boolean; consent?: boolean }) => void;
}): ReactNode {
  const [draft, setDraft] = useState<Record<string, { enabled: boolean; consent: boolean }>>({});

  if (loading) return <TableSkeleton rows={4} columns={3} />;
  if (error) return <ErrorState message={error} onRetry={onRetry} />;

  const rows = (items ?? ALL_CHANNELS.map((channel) => ({
    channel,
    enabled: channel === 'inapp',
    consentGivenAt: null,
  }))) as NotificationPreference[];

  const stateFor = (row: NotificationPreference) =>
    draft[row.channel] ?? { enabled: row.enabled, consent: row.consentGivenAt !== null };

  return (
    <Card>
      <CardHeader
        title="Your notification preferences"
        description="External channels require recorded consent before they can be enabled. These are your own preferences, not another user's."
      />
      <div className="space-y-4 p-4">
        <ul className="space-y-3">
          {rows.map((row) => {
            const state = stateFor(row);
            const external = row.channel !== 'inapp';
            return (
              <li key={row.channel} className="rounded-lg border border-slate-200 p-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-slate-900">{row.channel}</p>
                      {row.consentGivenAt ? (
                        <Badge tone="success">consent recorded</Badge>
                      ) : external ? (
                        <Badge tone="neutral">no consent</Badge>
                      ) : null}
                    </div>
                    {row.consentGivenAt && (
                      <p className="text-xs text-slate-500">
                        Consent recorded {formatDateTime(row.consentGivenAt)}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-4">
                    {external && (
                      <label className="flex items-center gap-2 text-sm text-slate-600">
                        <input
                          type="checkbox"
                          checked={state.consent}
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              [row.channel]: { ...state, consent: event.target.checked },
                            }))
                          }
                          className="h-4 w-4 rounded border-slate-300"
                        />
                        I consent to this channel
                      </label>
                    )}
                    <label className="flex items-center gap-2 text-sm text-slate-600">
                      <input
                        type="checkbox"
                        checked={state.enabled}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            [row.channel]: { ...state, enabled: event.target.checked },
                          }))
                        }
                        className="h-4 w-4 rounded border-slate-300"
                      />
                      Enabled
                    </label>
                    <Button
                      size="sm"
                      loading={saving}
                      onClick={() =>
                        onSave({
                          channel: row.channel,
                          enabled: state.enabled,
                          consent: state.consent,
                        })
                      }
                    >
                      Save
                    </Button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
        <p className="text-xs text-slate-500">
          Turning off in-app notifications hides new in-app messages from your inbox. Existing
          messages remain visible.
        </p>
      </div>
    </Card>
  );
}
