import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { SafeguardingNoteRecord } from '@erp/shared';
import { useAuth, useSchoolId, useSchoolTimezone } from '../auth/AuthContext';
import {
  addSafeguardingNote,
  createSafeguardingCase,
  getSafeguardingCase,
  listSafeguardingCases,
  listStudents,
  updateSafeguardingCase,
} from '../lib/endpoints';
import { errorMessage, fieldErrors } from '../lib/api';
import { formatDate, formatDateTime, fullName, todayIso } from '../lib/format';
import { useDebouncedValue } from '../lib/hooks';
import { Dialog } from '../components/Dialog';
import { useToast } from '../components/ToastProvider';
import {
  Alert,
  Badge,
  Button,
  Card,
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

const CATEGORIES = ['safeguarding', 'attendance', 'wellbeing', 'medical', 'behaviour', 'other'] as const;
const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
const STATUSES = ['open', 'monitoring', 'closed'] as const;

type Category = (typeof CATEGORIES)[number];
type Severity = (typeof SEVERITIES)[number];
type CaseStatus = (typeof STATUSES)[number];

const SEVERITY_TONES: Record<Severity, 'neutral' | 'info' | 'warning' | 'danger'> = {
  low: 'neutral',
  medium: 'info',
  high: 'warning',
  critical: 'danger',
};

const STATUS_TONES: Record<CaseStatus, 'danger' | 'warning' | 'neutral'> = {
  open: 'danger',
  monitoring: 'warning',
  closed: 'neutral',
};

export function SafeguardingPage(): ReactNode {
  const schoolId = useSchoolId();
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const canManage = can('safeguarding.case.manage');

  const [statusFilter, setStatusFilter] = useState('');
  const [severityFilter, setSeverityFilter] = useState('');
  const [openCaseId, setOpenCaseId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const cases = useQuery({
    queryKey: ['safeguarding', schoolId, statusFilter, severityFilter],
    queryFn: () =>
      listSafeguardingCases(schoolId, {
        status: statusFilter || undefined,
        severity: severityFilter || undefined,
      }),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['safeguarding', schoolId] });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Safeguarding"
        description="Restricted case records for student welfare concerns. Reads and every change are audited, and note text is never copied into the audit trail."
        actions={
          canManage ? (
            <Button onClick={() => setCreating(true)}>
              <Icon name="plus" className="h-4 w-4" />
              Open case
            </Button>
          ) : undefined
        }
      />

      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="field-label">Status</span>
            <Select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              aria-label="Filter cases by status"
            >
              <option value="">All statuses</option>
              {STATUSES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </label>
          <label className="block">
            <span className="field-label">Severity</span>
            <Select
              value={severityFilter}
              onChange={(event) => setSeverityFilter(event.target.value)}
              aria-label="Filter cases by severity"
            >
              <option value="">All severities</option>
              {SEVERITIES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </label>
        </div>
      </Card>

      {cases.isPending ? (
        <Card>
          <TableSkeleton rows={4} columns={5} />
        </Card>
      ) : cases.isError ? (
        <Card>
          <ErrorState message={errorMessage(cases.error)} onRetry={() => void cases.refetch()} />
        </Card>
      ) : cases.data.items.length === 0 ? (
        <Card>
          <EmptyState
            title="No safeguarding cases"
            description={
              canManage
                ? 'Open a case when a welfare concern needs a recorded, restricted trail.'
                : 'No cases match the selected filters.'
            }
            icon="shield"
            action={
              canManage ? (
                <Button size="sm" onClick={() => setCreating(true)}>
                  Open case
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-100 text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold tracking-wide text-slate-500 uppercase">
                <tr>
                  <th className="px-4 py-2.5">Reference</th>
                  <th className="px-4 py-2.5">Student</th>
                  <th className="px-4 py-2.5">Category</th>
                  <th className="px-4 py-2.5">Severity</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5">Opened</th>
                  <th className="px-4 py-2.5 text-right">Notes</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {cases.data.items.map((item) => (
                  <tr key={item.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 font-mono text-xs text-slate-700">{item.reference}</td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-900">{item.studentName}</p>
                      <p className="text-xs text-slate-500">{item.admissionNumber}</p>
                    </td>
                    <td className="px-4 py-3 capitalize text-slate-600">{item.category}</td>
                    <td className="px-4 py-3">
                      <Badge tone={SEVERITY_TONES[item.severity]}>{item.severity}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={STATUS_TONES[item.status]}>{item.status}</Badge>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{formatDate(item.openedOn)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-600">
                      {item.noteCount}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button size="sm" variant="ghost" onClick={() => setOpenCaseId(item.id)}>
                        Open
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {creating && (
        <CreateCaseDialog
          schoolId={schoolId}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            invalidate();
            setOpenCaseId(id);
            toast.notify('success', 'Safeguarding case opened.');
          }}
        />
      )}

      {openCaseId && (
        <CaseDetailDialog
          schoolId={schoolId}
          caseId={openCaseId}
          canManage={canManage}
          onClose={() => setOpenCaseId(null)}
          onChanged={invalidate}
        />
      )}
    </div>
  );
}

/* ------------------------------ create dialog ----------------------------- */

function CreateCaseDialog({
  schoolId,
  onClose,
  onCreated,
}: {
  schoolId: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}): ReactNode {
  const toast = useToast();
  const [studentSearch, setStudentSearch] = useState('');
  const debouncedSearch = useDebouncedValue(studentSearch, 300);
  const [studentId, setStudentId] = useState('');
  const [category, setCategory] = useState<Category>('safeguarding');
  const [severity, setSeverity] = useState<Severity>('medium');
  const [summary, setSummary] = useState('');
  const [openedOn, setOpenedOn] = useState(todayIso());
  const [errors, setErrors] = useState<Record<string, string[]>>({});

  const students = useQuery({
    queryKey: ['students', schoolId, 'safeguarding-picker', debouncedSearch],
    queryFn: () =>
      listStudents(schoolId, {
        search: debouncedSearch || undefined,
        pageSize: 20,
        page: 1,
      }),
  });

  const create = useMutation({
    mutationFn: () =>
      createSafeguardingCase(schoolId, {
        studentId,
        category,
        severity,
        summary: summary.trim(),
        openedOn: openedOn || undefined,
      }),
    onSuccess: (created) => onCreated(created.id),
    onError: (error) => {
      setErrors(fieldErrors(error));
      toast.notify('error', errorMessage(error));
    },
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (create.isPending) return;
    setErrors({});
    if (!studentId) {
      setErrors({ studentId: ['Choose a student'] });
      return;
    }
    create.mutate();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Open a safeguarding case"
      description="Only people with the safeguarding permission can read this record."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="safeguarding-create" loading={create.isPending}>
            Open case
          </Button>
        </>
      }
    >
      <form id="safeguarding-create" className="space-y-4" onSubmit={handleSubmit} noValidate>
        <Field label="Find student" htmlFor="case-student-search" hint="Search by name or admission number.">
          <Input
            id="case-student-search"
            value={studentSearch}
            onChange={(event) => setStudentSearch(event.target.value)}
            placeholder="e.g. Aisha or STU-0001"
          />
        </Field>

        <Field label="Student" htmlFor="case-student" error={errors.studentId?.[0]} required>
          <Select
            id="case-student"
            value={studentId}
            onChange={(event) => setStudentId(event.target.value)}
          >
            <option value="">Select a student</option>
            {(students.data?.items ?? []).map((student) => (
              <option key={student.id} value={student.id}>
                {fullName(student.firstName, null, student.lastName)} · {student.admissionNumber}
                {student.className ? ` · ${student.className}` : ''}
                {student.sectionName ? `-${student.sectionName}` : ''}
              </option>
            ))}
          </Select>
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Category" htmlFor="case-category" required>
            <Select
              id="case-category"
              value={category}
              onChange={(event) => setCategory(event.target.value as Category)}
            >
              {CATEGORIES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Severity" htmlFor="case-severity" required>
            <Select
              id="case-severity"
              value={severity}
              onChange={(event) => setSeverity(event.target.value as Severity)}
            >
              {SEVERITIES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="Opened on" htmlFor="case-opened-on">
          <Input
            id="case-opened-on"
            type="date"
            value={openedOn}
            onChange={(event) => setOpenedOn(event.target.value)}
          />
        </Field>

        <Field
          label="Summary"
          htmlFor="case-summary"
          error={errors.summary?.[0]}
          hint="Keep it factual and minimal. Full notes are added on the case record."
          required
        >
          <Textarea
            id="case-summary"
            rows={3}
            maxLength={2000}
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
          />
        </Field>
      </form>
    </Dialog>
  );
}

/* ------------------------------- detail dialog ---------------------------- */

function CaseDetailDialog({
  schoolId,
  caseId,
  canManage,
  onClose,
  onChanged,
}: {
  schoolId: string;
  caseId: string;
  canManage: boolean;
  onClose: () => void;
  onChanged: () => void;
}): ReactNode {
  const timeZone = useSchoolTimezone();
  const toast = useToast();
  const queryClient = useQueryClient();
  const detailKey = ['safeguarding-case', schoolId, caseId];

  const detail = useQuery({
    queryKey: detailKey,
    queryFn: () => getSafeguardingCase(schoolId, caseId),
  });

  const [category, setCategory] = useState<Category>('safeguarding');
  const [severity, setSeverity] = useState<Severity>('medium');
  const [status, setStatus] = useState<CaseStatus>('open');
  const [summary, setSummary] = useState('');
  const [note, setNote] = useState('');

  const record = detail.data;
  useEffect(() => {
    if (!record) return;
    setCategory(record.category);
    setSeverity(record.severity);
    setStatus(record.status);
    setSummary(record.summary);
  }, [record]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: detailKey });
    onChanged();
  };

  const save = useMutation({
    mutationFn: () =>
      updateSafeguardingCase(schoolId, caseId, {
        category,
        severity,
        status,
        summary: summary.trim(),
      }),
    onSuccess: () => {
      toast.notify('success', 'Case updated.');
      refresh();
    },
    onError: (error) => toast.notify('error', errorMessage(error)),
  });

  const addNote = useMutation({
    mutationFn: () => addSafeguardingNote(schoolId, caseId, note.trim()),
    onSuccess: (created: SafeguardingNoteRecord) => {
      setNote('');
      toast.notify('success', 'Note added.');
      if (created) refresh();
    },
    onError: (error) => toast.notify('error', errorMessage(error)),
  });

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={record ? `${record.reference} · ${record.studentName}` : 'Safeguarding case'}
      description={record ? `${record.admissionNumber} · opened ${formatDate(record.openedOn)}` : undefined}
      footer={
        canManage && record ? (
          <>
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
            <Button onClick={() => save.mutate()} loading={save.isPending}>
              Save changes
            </Button>
          </>
        ) : (
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        )
      }
    >
      {detail.isPending ? (
        <TableSkeleton rows={4} columns={2} />
      ) : detail.isError ? (
        <ErrorState message={errorMessage(detail.error)} onRetry={() => void detail.refetch()} />
      ) : !record ? null : (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={SEVERITY_TONES[record.severity]}>{record.severity}</Badge>
            <Badge tone={STATUS_TONES[record.status]}>{record.status}</Badge>
            <span className="text-xs text-slate-500 capitalize">{record.category}</span>
            {record.openedByName && (
              <span className="text-xs text-slate-500">Opened by {record.openedByName}</span>
            )}
            {record.closedOn && (
              <span className="text-xs text-slate-500">Closed {formatDate(record.closedOn)}</span>
            )}
          </div>

          {canManage ? (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Category" htmlFor="detail-category">
                  <Select
                    id="detail-category"
                    value={category}
                    onChange={(event) => setCategory(event.target.value as Category)}
                  >
                    {CATEGORIES.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Severity" htmlFor="detail-severity">
                  <Select
                    id="detail-severity"
                    value={severity}
                    onChange={(event) => setSeverity(event.target.value as Severity)}
                  >
                    {SEVERITIES.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Status" htmlFor="detail-status">
                  <Select
                    id="detail-status"
                    value={status}
                    onChange={(event) => setStatus(event.target.value as CaseStatus)}
                  >
                    {STATUSES.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Field label="Summary" htmlFor="detail-summary">
                <Textarea
                  id="detail-summary"
                  rows={3}
                  maxLength={2000}
                  value={summary}
                  onChange={(event) => setSummary(event.target.value)}
                />
              </Field>
            </div>
          ) : (
            <div className="rounded-lg bg-slate-50 px-4 py-3 text-sm text-slate-700">
              {record.summary}
            </div>
          )}

          <section>
            <h3 className="text-sm font-semibold text-slate-900">
              Case notes <span className="text-slate-400">({record.notes.length})</span>
            </h3>
            {record.notes.length === 0 ? (
              <p className="mt-2 text-sm text-slate-500">No notes recorded yet.</p>
            ) : (
              <ul className="mt-2 space-y-3">
                {record.notes.map((entry) => (
                  <li key={entry.id} className="rounded-lg border border-slate-200 px-3 py-2">
                    <p className="text-xs text-slate-500">
                      {entry.authorName ?? 'Unknown author'} ·{' '}
                      {formatDateTime(entry.createdAt, timeZone)}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{entry.note}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {canManage && (
            <section className="border-t border-slate-100 pt-4">
              <Field label="Add a note" htmlFor="case-note">
                <Textarea
                  id="case-note"
                  rows={3}
                  maxLength={4000}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder={
                    record.status === 'closed'
                      ? 'Reopen the case before adding notes.'
                      : 'Record what happened and what was agreed.'
                  }
                  disabled={record.status === 'closed'}
                />
              </Field>
              <div className="mt-2 flex items-center justify-between gap-3">
                {record.status === 'closed' ? (
                  <Alert tone="warning">
                    Closed cases are read-only. Set the status back to open or monitoring to add notes.
                  </Alert>
                ) : (
                  <span className="text-xs text-slate-500">
                    Notes are append-only and attributed to your account.
                  </span>
                )}
                <Button
                  size="sm"
                  onClick={() => addNote.mutate()}
                  loading={addNote.isPending}
                  disabled={record.status === 'closed' || note.trim().length === 0}
                >
                  Add note
                </Button>
              </div>
            </section>
          )}
        </div>
      )}
    </Dialog>
  );
}
