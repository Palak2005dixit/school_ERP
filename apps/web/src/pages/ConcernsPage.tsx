import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import type { ConcernCategory } from '@erp/shared';
import { useAuth, useSchoolId } from '../auth/AuthContext';
import {
  addConcernNote,
  concernAttachmentUrl,
  createConcern,
  createConcernCategory,
  escalateConcern,
  getConcern,
  listConcernCategories,
  listConcerns,
  listStudents,
  listUsers,
  updateConcern,
  updateConcernCategory,
  uploadConcernAttachment,
} from '../lib/endpoints';
import { errorMessage } from '../lib/api';
import { formatBytes, formatDateTime } from '../lib/format';
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
  TableSkeleton,
  Textarea,
} from '../components/ui';

type Tab = 'queue' | 'categories';

const STATUSES = ['open', 'in_progress', 'waiting', 'resolved', 'closed', 'cancelled'] as const;
const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
const VISIBILITIES = ['internal', 'requester'] as const;

type DialogState =
  | { kind: 'new' }
  | { kind: 'detail'; id: string }
  | { kind: 'category'; category?: ConcernCategory }
  | null;

export function ConcernsPage(): ReactNode {
  const schoolId = useSchoolId();
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();

  const canView = can('concerns.view') || can('concerns.manage');
  const canManage = can('concerns.manage');
  const canAssign = can('concerns.assign');
  const canCategories = can('concerns.category.manage');
  const canListUsers = can('access.roles.manage');

  const [tab, setTab] = useState<Tab>('queue');
  const [status, setStatus] = useState('');
  const [priority, setPriority] = useState('');
  const [mine, setMine] = useState(false);
  const [overdue, setOverdue] = useState(false);
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState<DialogState>(null);
  const [formError, setFormError] = useState('');

  const categories = useQuery({
    queryKey: ['concern-categories', schoolId],
    queryFn: () => listConcernCategories(schoolId),
    enabled: canView,
  });
  const concerns = useQuery({
    queryKey: ['concerns', schoolId, status, priority, mine, overdue, search],
    queryFn: () =>
      listConcerns(schoolId, {
        status: status || undefined,
        priority: priority || undefined,
        mine: mine || undefined,
        overdue: overdue || undefined,
        search: search || undefined,
      }),
    enabled: canView && tab === 'queue',
  });
  const students = useQuery({
    queryKey: ['students', schoolId, 'concern-picker'],
    queryFn: () => listStudents(schoolId, { pageSize: 200 }),
    enabled: canView && dialog?.kind === 'new',
  });
  const users = useQuery({
    queryKey: ['users', schoolId],
    queryFn: () => listUsers(schoolId),
    enabled: canManage && canListUsers && dialog?.kind === 'detail',
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['concerns', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['concern-categories', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['concern', schoolId] });
  };

  const create = useMutation({
    mutationFn: (input: Parameters<typeof createConcern>[1]) => createConcern(schoolId, input),
    onSuccess: () => {
      toast.notify('success', 'Concern created.');
      setDialog(null);
      invalidate();
    },
    onError: (error) => setFormError(errorMessage(error)),
  });
  const saveCategory = useMutation({
    mutationFn: (input: { id?: string; body: Record<string, unknown> }) =>
      input.id
        ? updateConcernCategory(schoolId, input.id, input.body)
        : createConcernCategory(
            schoolId,
            input.body as Parameters<typeof createConcernCategory>[1],
          ),
    onSuccess: () => {
      toast.notify('success', 'Category saved.');
      setDialog(null);
      invalidate();
    },
    onError: (error) => setFormError(errorMessage(error)),
  });

  const categoryOptions = categories.data?.items ?? [];
  const categoryFilterOptions = categoryOptions.filter((category) => category.active);
  const studentOptions = (students.data?.items ?? []).map((student) => ({
    id: student.id,
    name: `${student.firstName} ${student.lastName ?? ''}`.trim(),
    admissionNumber: student.admissionNumber,
  }));
  const userOptions = (users.data?.items ?? [])
    .filter((user) => user.status === 'active')
    .map((user) => ({ id: user.id, name: user.displayName }));

  const tabs: Array<{ value: Tab; label: string }> = [
    { value: 'queue', label: 'Concern queue' },
    ...(canCategories ? [{ value: 'categories' as Tab, label: 'Categories & SLA' }] : []),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Concerns & tasks"
        description="A shared queue for complaints, requests and follow-ups. SLA due times come from the category; overdue is always derived from that stored due time."
        actions={
          <Button onClick={() => setDialog({ kind: 'new' })}>
            <Icon name="plus" className="h-4 w-4" />
            New concern
          </Button>
        }
      />

      <Tabs value={tab} onChange={setTab} tabs={tabs} label="Concern views" />

      {tab === 'queue' && canView && (
        <Card>
          <CardHeader
            title="Concern queue"
            description="Requesters only see their own concerns. Staff with manage or assign permission see the whole queue and internal notes."
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  aria-label="Search concerns"
                  placeholder="Search reference or subject"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  className="w-56"
                />
                <Select
                  aria-label="Filter by status"
                  value={status}
                  onChange={(event) => setStatus(event.target.value)}
                  className="w-36"
                >
                  <option value="">All statuses</option>
                  {STATUSES.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </Select>
                <Select
                  aria-label="Filter by priority"
                  value={priority}
                  onChange={(event) => setPriority(event.target.value)}
                  className="w-32"
                >
                  <option value="">All priorities</option>
                  {PRIORITIES.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </Select>
                <label className="flex items-center gap-2 text-sm text-slate-600">
                  <input
                    type="checkbox"
                    checked={mine}
                    onChange={(event) => setMine(event.target.checked)}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                  Assigned to me
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-600">
                  <input
                    type="checkbox"
                    checked={overdue}
                    onChange={(event) => setOverdue(event.target.checked)}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                  Overdue
                </label>
              </div>
            }
          />
          {concerns.isPending ? (
            <TableSkeleton rows={6} columns={7} />
          ) : concerns.isError ? (
            <ErrorState
              message={errorMessage(concerns.error)}
              onRetry={() => void concerns.refetch()}
            />
          ) : (concerns.data?.items.length ?? 0) === 0 ? (
            <EmptyState
              title="No concerns"
              description="Create a concern to start tracking a request or complaint."
              icon="clipboard"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Reference</th>
                    <th>Subject</th>
                    <th>Category</th>
                    <th>Requester</th>
                    <th>Priority</th>
                    <th>SLA due</th>
                    <th>Status</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {concerns.data!.items.map((row) => (
                    <tr key={row.id}>
                      <td className="font-mono text-xs">{row.reference}</td>
                      <td>
                        <p className="font-medium text-slate-900">{row.subject}</p>
                        {row.assigneeName && (
                          <p className="text-xs text-slate-500">Assigned to {row.assigneeName}</p>
                        )}
                      </td>
                      <td className="text-sm text-slate-600">{row.categoryName ?? '—'}</td>
                      <td className="text-sm text-slate-600">{row.requesterName}</td>
                      <td>
                        <Badge
                          tone={
                            row.priority === 'urgent'
                              ? 'danger'
                              : row.priority === 'high'
                                ? 'warning'
                                : 'neutral'
                          }
                        >
                          {row.priority}
                        </Badge>
                      </td>
                      <td className="text-sm">
                        <span className={row.overdue ? 'font-medium text-rose-600' : 'text-slate-600'}>
                          {formatDateTime(row.slaDueAt)}
                        </span>
                        {row.overdue && <span className="ml-1 text-xs">overdue</span>}
                      </td>
                      <td>
                        <Badge
                          tone={
                            row.status === 'resolved' || row.status === 'closed'
                              ? 'success'
                              : row.status === 'cancelled'
                                ? 'neutral'
                                : row.status === 'waiting'
                                  ? 'warning'
                                  : 'info'
                          }
                        >
                          {row.status}
                        </Badge>
                      </td>
                      <td className="text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDialog({ kind: 'detail', id: row.id })}
                        >
                          Open
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

      {tab === 'categories' && canCategories && (
        <Card>
          <CardHeader
            title="Categories & SLA"
            description="SLA hours are school configuration. They are applied when a concern is created and changing a category does not alter existing concerns."
            actions={
              <Button size="sm" onClick={() => setDialog({ kind: 'category' })}>
                New category
              </Button>
            }
          />
          {categories.isPending ? (
            <TableSkeleton rows={5} columns={5} />
          ) : categories.isError ? (
            <ErrorState
              message={errorMessage(categories.error)}
              onRetry={() => void categories.refetch()}
            />
          ) : categoryOptions.length === 0 ? (
            <EmptyState
              title="No categories"
              description="Create a category to set a default priority and SLA."
              icon="clipboard"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Name</th>
                    <th>Default priority</th>
                    <th className="text-right">SLA hours</th>
                    <th>Status</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {categoryOptions.map((row) => (
                    <tr key={row.id}>
                      <td className="font-mono text-xs">{row.code}</td>
                      <td className="font-medium text-slate-900">{row.name}</td>
                      <td>
                        <Badge tone={row.defaultPriority === 'urgent' ? 'danger' : 'neutral'}>
                          {row.defaultPriority}
                        </Badge>
                      </td>
                      <td className="text-right tabular-nums">{row.slaHours}</td>
                      <td>
                        <Badge tone={row.active ? 'success' : 'neutral'}>
                          {row.active ? 'active' : 'inactive'}
                        </Badge>
                      </td>
                      <td className="text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDialog({ kind: 'category', category: row })}
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

      {dialog?.kind === 'new' && (
        <NewConcernDialog
          categories={categoryFilterOptions}
          students={studentOptions}
          error={formError}
          saving={create.isPending}
          onClose={() => {
            setDialog(null);
            setFormError('');
          }}
          onSave={(body) => create.mutate(body)}
        />
      )}

      {dialog?.kind === 'detail' && (
        <ConcernDetailDialog
          schoolId={schoolId}
          concernId={dialog.id}
          canManage={canManage}
          canAssign={canAssign}
          assignees={userOptions}
          canListUsers={canListUsers}
          onClose={() => setDialog(null)}
        />
      )}

      {dialog?.kind === 'category' && (
        <CategoryDialog
          key={dialog.category?.id ?? 'new-category'}
          category={dialog.category}
          error={formError}
          saving={saveCategory.isPending}
          onClose={() => {
            setDialog(null);
            setFormError('');
          }}
          onSave={(body) => saveCategory.mutate({ id: dialog.category?.id, body })}
        />
      )}
    </div>
  );
}

function NewConcernDialog({
  categories,
  students,
  error,
  saving,
  onClose,
  onSave,
}: {
  categories: ConcernCategory[];
  students: Array<{ id: string; name: string; admissionNumber: string }>;
  error: string;
  saving: boolean;
  onClose: () => void;
  onSave: (body: Parameters<typeof createConcern>[1]) => void;
}): ReactNode {
  const [categoryId, setCategoryId] = useState('');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [studentId, setStudentId] = useState('');
  const [priority, setPriority] = useState('');
  const [visibility, setVisibility] = useState<'internal' | 'requester'>('requester');

  return (
    <Dialog
      open
      onClose={onClose}
      title="New concern"
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="concern-form" loading={saving}>
            Create concern
          </Button>
        </>
      }
    >
      <form
        id="concern-form"
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({
            categoryId: categoryId || null,
            subject,
            description,
            studentId: studentId || null,
            priority: priority || undefined,
            visibility,
          });
        }}
      >
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Subject" htmlFor="con-subject" required>
          <Input
            id="con-subject"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            required
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Category" htmlFor="con-category" hint="Sets the default priority and SLA.">
            <Select
              id="con-category"
              value={categoryId}
              onChange={(event) => setCategoryId(event.target.value)}
            >
              <option value="">No category</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name} · {category.slaHours}h
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Priority" htmlFor="con-priority">
            <Select
              id="con-priority"
              value={priority}
              onChange={(event) => setPriority(event.target.value)}
            >
              <option value="">Use category default</option>
              {PRIORITIES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Linked student" htmlFor="con-student">
            <Select
              id="con-student"
              value={studentId}
              onChange={(event) => setStudentId(event.target.value)}
            >
              <option value="">Not about a specific student</option>
              {students.map((student) => (
                <option key={student.id} value={student.id}>
                  {student.name} · {student.admissionNumber}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Visibility" htmlFor="con-visibility">
            <Select
              id="con-visibility"
              value={visibility}
              onChange={(event) => setVisibility(event.target.value as typeof visibility)}
            >
              {VISIBILITIES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Description" htmlFor="con-description" required>
          <Textarea
            id="con-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={10000}
            required
          />
        </Field>
      </form>
    </Dialog>
  );
}

function ConcernDetailDialog({
  schoolId,
  concernId,
  canManage,
  canAssign,
  assignees,
  canListUsers,
  onClose,
}: {
  schoolId: string;
  concernId: string;
  canManage: boolean;
  canAssign: boolean;
  assignees: Array<{ id: string; name: string }>;
  canListUsers: boolean;
  onClose: () => void;
}): ReactNode {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const [internal, setInternal] = useState(true);
  const [escalationNote, setEscalationNote] = useState('');
  const [status, setStatus] = useState('');
  const [priority, setPriority] = useState('');
  const [assignee, setAssignee] = useState('');
  const [resolution, setResolution] = useState('');
  const [busy, setBusy] = useState(false);

  const detail = useQuery({
    queryKey: ['concern', schoolId, concernId],
    queryFn: () => getConcern(schoolId, concernId),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['concern', schoolId, concernId] });
    void queryClient.invalidateQueries({ queryKey: ['concerns', schoolId] });
  };

  const run = async (action: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try {
      await action();
      toast.notify('success', message);
      refresh();
    } catch (error) {
      toast.notify('error', errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const concern = detail.data;
  const currentStatus = status || concern?.status || '';
  const currentPriority = priority || concern?.priority || '';
  const currentAssignee = assignee || concern?.assignedTo || '';

  return (
    <Dialog
      open
      onClose={onClose}
      title={concern ? `${concern.reference} · ${concern.subject}` : 'Concern'}
      description={
        concern
          ? `${concern.categoryName ?? 'No category'} · requested by ${concern.requesterName}`
          : undefined
      }
      size="lg"
    >
      {detail.isPending ? (
        <TableSkeleton rows={6} columns={3} />
      ) : detail.isError ? (
        <ErrorState message={errorMessage(detail.error)} onRetry={() => void detail.refetch()} />
      ) : concern ? (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={concern.priority === 'urgent' ? 'danger' : 'warning'}>
              {concern.priority}
            </Badge>
            <Badge tone={concern.status === 'resolved' ? 'success' : 'info'}>{concern.status}</Badge>
            <Badge tone={concern.visibility === 'internal' ? 'neutral' : 'brand'}>
              {concern.visibility}
            </Badge>
            <span className={concern.overdue ? 'text-sm font-medium text-rose-600' : 'text-sm text-slate-500'}>
              SLA due {formatDateTime(concern.slaDueAt)}
              {concern.overdue ? ' · overdue' : ''}
            </span>
          </div>

          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <p className="whitespace-pre-wrap text-sm text-slate-800">{concern.description}</p>
            {concern.studentName && (
              <p className="mt-2 text-xs text-slate-500">Student: {concern.studentName}</p>
            )}
            {concern.resolutionSummary && (
              <p className="mt-2 text-xs text-slate-600">
                Resolution: {concern.resolutionSummary}
              </p>
            )}
          </div>

          {canManage && (
            <div className="space-y-3 rounded-lg border border-slate-200 p-3">
              <p className="text-sm font-semibold text-slate-800">Manage</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Status" htmlFor="detail-status">
                  <Select
                    id="detail-status"
                    value={currentStatus}
                    onChange={(event) => setStatus(event.target.value)}
                  >
                    {STATUSES.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Priority" htmlFor="detail-priority">
                  <Select
                    id="detail-priority"
                    value={currentPriority}
                    onChange={(event) => setPriority(event.target.value)}
                  >
                    {PRIORITIES.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field
                  label="Assignee"
                  htmlFor="detail-assignee"
                  hint={
                    canListUsers
                      ? 'Only active staff in this school can be assigned.'
                      : 'Listing staff requires the roles management permission.'
                  }
                >
                  {canListUsers ? (
                    <Select
                      id="detail-assignee"
                      value={currentAssignee}
                      onChange={(event) => setAssignee(event.target.value)}
                    >
                      <option value="">Unassigned</option>
                      {assignees.map((user) => (
                        <option key={user.id} value={user.id}>
                          {user.name}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Input
                      id="detail-assignee"
                      value={currentAssignee}
                      disabled
                      placeholder="Assignee unavailable"
                    />
                  )}
                </Field>
                <Field label="Resolution summary" htmlFor="detail-resolution">
                  <Input
                    id="detail-resolution"
                    value={resolution || concern.resolutionSummary || ''}
                    onChange={(event) => setResolution(event.target.value)}
                    maxLength={4000}
                  />
                </Field>
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  size="sm"
                  loading={busy}
                  onClick={() =>
                    void run(
                      () =>
                        updateConcern(schoolId, concern.id, {
                          status: currentStatus,
                          priority: currentPriority,
                          assignedTo: currentAssignee || null,
                          resolutionSummary: resolution || undefined,
                        }),
                      'Concern updated.',
                    )
                  }
                >
                  Save changes
                </Button>
                {canAssign && !['resolved', 'closed', 'cancelled'].includes(concern.status) && (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busy}
                    onClick={() =>
                      void run(
                        () => escalateConcern(schoolId, concern.id, escalationNote || undefined),
                        'Concern escalated.',
                      )
                    }
                  >
                    Escalate priority
                  </Button>
                )}
              </div>
              {canAssign && (
                <Field label="Escalation note" htmlFor="detail-escalation">
                  <Input
                    id="detail-escalation"
                    value={escalationNote}
                    onChange={(event) => setEscalationNote(event.target.value)}
                    maxLength={4000}
                  />
                </Field>
              )}
            </div>
          )}

          <div className="space-y-2">
            <p className="text-sm font-semibold text-slate-800">Timeline</p>
            <ol className="space-y-2">
              {(concern.events ?? []).map((event) => (
                <li key={event.id} className="rounded-lg border border-slate-100 p-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span className="font-medium text-slate-700">{event.eventType.replace('_', ' ')}</span>
                    <span>{event.actorName ?? 'System'}</span>
                    <span>{formatDateTime(event.createdAt)}</span>
                    {event.isInternal && <Badge tone="neutral">internal</Badge>}
                    {event.fromStatus && event.toStatus && (
                      <span>
                        {event.fromStatus} → {event.toStatus}
                      </span>
                    )}
                  </div>
                  {event.note && (
                    <p className="mt-1 whitespace-pre-wrap text-slate-700">{event.note}</p>
                  )}
                </li>
              ))}
            </ol>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-semibold text-slate-800">Attachments</p>
            {(detail.data?.attachments.length ?? 0) === 0 ? (
              <p className="text-sm text-slate-500">No attachments.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {detail.data!.attachments.map((attachment) => (
                  <li key={attachment.id} className="flex flex-wrap items-center gap-2">
                    <a
                      href={concernAttachmentUrl(schoolId, concern.id, attachment.id)}
                      className="inline-flex items-center gap-1 text-brand-700 hover:underline"
                      download
                    >
                      <Icon name="paperclip" className="h-3.5 w-3.5" />
                      {attachment.filename}
                    </a>
                    <span className="text-xs text-slate-400">
                      {formatBytes(attachment.byteSize)}
                    </span>
                    {attachment.isInternal && <Badge tone="neutral">internal</Badge>}
                  </li>
                ))}
              </ul>
            )}
            <label className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
              <Icon name="paperclip" className="h-3.5 w-3.5" />
              {busy ? 'Working…' : 'Attach file'}
              <input
                type="file"
                className="sr-only"
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (!file) return;
                  await run(
                    async () => {
                      const dataBase64 = await fileToBase64(file);
                      await uploadConcernAttachment(schoolId, concern.id, {
                        filename: file.name,
                        contentType: file.type || 'application/octet-stream',
                        dataBase64,
                        isInternal: true,
                      });
                    },
                    'Attachment uploaded.',
                  );
                }}
              />
            </label>
          </div>

          <div className="space-y-2 rounded-lg border border-slate-200 p-3">
            <p className="text-sm font-semibold text-slate-800">Add a note</p>
            <Textarea
              aria-label="Concern note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={4000}
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-sm text-slate-600">
                <input
                  type="checkbox"
                  checked={internal}
                  onChange={(event) => setInternal(event.target.checked)}
                  className="h-4 w-4 rounded border-slate-300"
                />
                Internal note
              </label>
              <Button
                size="sm"
                loading={busy}
                disabled={note.trim().length === 0}
                onClick={() =>
                  void run(async () => {
                    await addConcernNote(schoolId, concern.id, {
                      note,
                      isInternal: internal,
                    });
                    setNote('');
                  }, 'Note added.')
                }
              >
                Add note
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}

function CategoryDialog({
  category,
  error,
  saving,
  onClose,
  onSave,
}: {
  category?: ConcernCategory;
  error: string;
  saving: boolean;
  onClose: () => void;
  onSave: (body: Record<string, unknown>) => void;
}): ReactNode {
  const [code, setCode] = useState(category?.code ?? '');
  const [name, setName] = useState(category?.name ?? '');
  const [defaultPriority, setDefaultPriority] = useState<(typeof PRIORITIES)[number]>(
    category?.defaultPriority ?? 'medium',
  );
  const [slaHours, setSlaHours] = useState(String(category?.slaHours ?? 24));
  const [active, setActive] = useState(category?.active ?? true);

  return (
    <Dialog
      open
      onClose={onClose}
      title={category ? 'Edit category' : 'New category'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="category-form" loading={saving}>
            Save category
          </Button>
        </>
      }
    >
      <form
        id="category-form"
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({
            code,
            name,
            defaultPriority,
            slaHours: Number(slaHours),
            active,
          });
        }}
      >
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Code" htmlFor="cat-code" required>
            <Input
              id="cat-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              pattern="[a-z0-9_-]+"
              required
            />
          </Field>
          <Field label="Name" htmlFor="cat-name" required>
            <Input
              id="cat-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </Field>
          <Field label="Default priority" htmlFor="cat-priority">
            <Select
              id="cat-priority"
              value={defaultPriority}
              onChange={(event) =>
                setDefaultPriority(event.target.value as typeof defaultPriority)
              }
            >
              {PRIORITIES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="SLA hours" htmlFor="cat-sla" required>
            <Input
              id="cat-sla"
              type="number"
              min={1}
              max={8760}
              value={slaHours}
              onChange={(event) => setSlaHours(event.target.value)}
              required
            />
          </Field>
        </div>
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

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Error('The file could not be read'));
    reader.readAsDataURL(file);
  });
}
