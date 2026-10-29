import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import type {
  StaffAttendanceRecord,
  StaffAttendanceSettings,
  StaffShift,
} from '@erp/shared';
import { useAuth, useSchoolId, useSchoolTimezone } from '../auth/AuthContext';
import {
  createStaffShift,
  getStaffAttendanceSettings,
  getStaffAttendanceSummary,
  listStaff,
  listStaffAttendance,
  listStaffAttendanceCorrections,
  listStaffShifts,
  recordStaffAttendance,
  requestStaffAttendanceCorrection,
  reviewStaffAttendanceCorrection,
  saveStaffAttendanceSettings,
  updateStaffShift,
} from '../lib/endpoints';
import { errorMessage } from '../lib/api';
import { formatClock, formatDate, formatDateTime, todayIso } from '../lib/format';
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

type Tab = 'register' | 'summary' | 'corrections' | 'shifts' | 'settings';

const STATUSES = [
  'present',
  'late',
  'absent',
  'half_day',
  'leave',
  'excused',
  'missing_punch',
] as const;

type DialogState =
  | { kind: 'record'; attendance?: StaffAttendanceRecord }
  | { kind: 'correction'; attendance: StaffAttendanceRecord }
  | { kind: 'shift'; shift?: StaffShift }
  | null;

function toInstant(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function toLocalInput(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

export function StaffAttendancePage(): ReactNode {
  const schoolId = useSchoolId();
  const timeZone = useSchoolTimezone();
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();

  const canView = can('hr.attendance.view');
  const canRecord = can('hr.attendance.record');
  const canApprove = can('hr.attendance.approve');
  const canConfigure = can('hr.attendance.configure');

  const [tab, setTab] = useState<Tab>('register');
  const [from, setFrom] = useState(() => todayIso(timeZone));
  const [to, setTo] = useState(() => todayIso(timeZone));
  const [staffFilter, setStaffFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [correctionStatus, setCorrectionStatus] = useState('pending');
  const [dialog, setDialog] = useState<DialogState>(null);
  const [formError, setFormError] = useState('');

  const staff = useQuery({
    queryKey: ['staff', schoolId, 'attendance-picker'],
    queryFn: () => listStaff(schoolId),
    enabled: canView,
  });
  const attendance = useQuery({
    queryKey: ['staff-attendance', schoolId, from, to, staffFilter, statusFilter],
    queryFn: () =>
      listStaffAttendance(schoolId, {
        from: from || undefined,
        to: to || undefined,
        staffId: staffFilter || undefined,
        status: statusFilter || undefined,
      }),
    enabled: canView,
  });
  const summary = useQuery({
    queryKey: ['staff-attendance-summary', schoolId, from, to],
    queryFn: () => getStaffAttendanceSummary(schoolId, { from, to }),
    enabled: canView && tab === 'summary',
  });
  const corrections = useQuery({
    queryKey: ['staff-attendance-corrections', schoolId, correctionStatus],
    queryFn: () => listStaffAttendanceCorrections(schoolId, correctionStatus || undefined),
    enabled: canView && tab === 'corrections',
  });
  const shifts = useQuery({
    queryKey: ['staff-shifts', schoolId],
    queryFn: () => listStaffShifts(schoolId),
    enabled: canView && (tab === 'shifts' || dialog?.kind === 'record'),
  });
  const settings = useQuery({
    queryKey: ['staff-attendance-settings', schoolId],
    queryFn: () => getStaffAttendanceSettings(schoolId),
    enabled: canView && tab === 'settings',
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['staff-attendance', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['staff-attendance-summary', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['staff-attendance-corrections', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['staff-shifts', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['staff-attendance-settings', schoolId] });
  };

  const saveRecord = useMutation({
    mutationFn: (input: Parameters<typeof recordStaffAttendance>[1]) =>
      recordStaffAttendance(schoolId, input),
    onSuccess: () => {
      toast.notify('success', 'Attendance recorded.');
      setDialog(null);
      invalidate();
    },
    onError: (error) => setFormError(errorMessage(error)),
  });

  const saveShift = useMutation({
    mutationFn: (input: { id?: string; body: Omit<StaffShift, 'id'> }) =>
      input.id
        ? updateStaffShift(schoolId, input.id, input.body)
        : createStaffShift(schoolId, input.body),
    onSuccess: () => {
      toast.notify('success', 'Shift saved.');
      setDialog(null);
      invalidate();
    },
    onError: (error) => setFormError(errorMessage(error)),
  });

  const saveCorrection = useMutation({
    mutationFn: (input: {
      attendanceId: string;
      body: Parameters<typeof requestStaffAttendanceCorrection>[2];
    }) => requestStaffAttendanceCorrection(schoolId, input.attendanceId, input.body),
    onSuccess: () => {
      toast.notify('success', 'Correction requested.');
      setDialog(null);
      invalidate();
    },
    onError: (error) => setFormError(errorMessage(error)),
  });

  const review = useMutation({
    mutationFn: (input: { id: string; decision: 'approve' | 'reject' }) =>
      reviewStaffAttendanceCorrection(schoolId, input.id, { decision: input.decision }),
    onSuccess: (saved) => {
      toast.notify('success', `Correction ${saved.status}.`);
      invalidate();
    },
    onError: (error) => toast.notify('error', errorMessage(error)),
  });

  const saveSettings = useMutation({
    mutationFn: (input: StaffAttendanceSettings) => saveStaffAttendanceSettings(schoolId, input),
    onSuccess: () => {
      toast.notify('success', 'Attendance settings saved.');
      invalidate();
    },
    onError: (error) => toast.notify('error', errorMessage(error)),
  });

  const staffOptions = staff.data?.items ?? [];
  const shiftOptions = shifts.data?.items ?? [];

  const tabs: Array<{ value: Tab; label: string }> = [
    { value: 'register', label: 'Register' },
    { value: 'summary', label: 'Summary' },
    { value: 'corrections', label: 'Corrections' },
    { value: 'shifts', label: 'Shifts' },
    ...(canConfigure ? [{ value: 'settings' as Tab, label: 'Settings' }] : []),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Staff attendance & timekeeping"
        description="Punches are recorded as supplied by the school; late, early-departure and overtime minutes are derived from the assigned shift and the configured thresholds. Internal policy defaults are provisional until the client confirms them."
        actions={
          <div className="flex flex-wrap gap-2">
            {canRecord && (
              <Button onClick={() => setDialog({ kind: 'record' })}>
                <Icon name="plus" className="h-4 w-4" />
                Record attendance
              </Button>
            )}
            {canConfigure && (
              <Button variant="secondary" onClick={() => setDialog({ kind: 'shift' })}>
                <Icon name="calendar" className="h-4 w-4" />
                New shift
              </Button>
            )}
          </div>
        }
      />

      <Tabs value={tab} onChange={setTab} tabs={tabs} label="Staff attendance views" />

      {tab === 'register' && canView && (
        <Card>
          <CardHeader
            title="Attendance register"
            description="One row per employee per work date. A single punch is stored as missing_punch and must be corrected before payroll."
            actions={
              <div className="flex flex-wrap gap-2">
                <Input
                  type="date"
                  aria-label="From date"
                  value={from}
                  onChange={(event) => setFrom(event.target.value)}
                  className="w-40"
                />
                <Input
                  type="date"
                  aria-label="To date"
                  value={to}
                  onChange={(event) => setTo(event.target.value)}
                  className="w-40"
                />
                <Select
                  aria-label="Filter by staff"
                  value={staffFilter}
                  onChange={(event) => setStaffFilter(event.target.value)}
                  className="w-44"
                >
                  <option value="">All staff</option>
                  {staffOptions.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.fullName}
                    </option>
                  ))}
                </Select>
                <Select
                  aria-label="Filter by status"
                  value={statusFilter}
                  onChange={(event) => setStatusFilter(event.target.value)}
                  className="w-40"
                >
                  <option value="">All statuses</option>
                  {STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {status.replace(/_/g, ' ')}
                    </option>
                  ))}
                </Select>
              </div>
            }
          />
          {attendance.isPending ? (
            <TableSkeleton rows={6} columns={7} />
          ) : attendance.isError ? (
            <ErrorState
              message={errorMessage(attendance.error)}
              onRetry={() => void attendance.refetch()}
            />
          ) : attendance.data.items.length === 0 ? (
            <EmptyState
              title="No attendance in this range"
              description="Record a punch or adjust the date filters."
              icon="calendar"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Date</th>
                    <th>Shift</th>
                    <th>In</th>
                    <th>Out</th>
                    <th>Status</th>
                    <th className="text-right">Minutes</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {attendance.data.items.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <p className="font-medium text-slate-900">{row.staffName}</p>
                        <p className="font-mono text-xs text-slate-500">{row.employeeNumber}</p>
                      </td>
                      <td>{formatDate(row.workDate)}</td>
                      <td className="text-sm text-slate-600">{row.shiftName ?? '—'}</td>
                      <td>{formatClock(row.punchIn)}</td>
                      <td>{formatClock(row.punchOut)}</td>
                      <td>
                        <div className="flex flex-wrap items-center gap-1">
                          <Badge
                            tone={
                              row.status === 'present'
                                ? 'success'
                                : row.status === 'absent'
                                  ? 'danger'
                                  : 'warning'
                            }
                          >
                            {row.status.replace(/_/g, ' ')}
                          </Badge>
                          {row.pendingCorrection && <Badge tone="info">correction</Badge>}
                        </div>
                      </td>
                      <td className="text-right text-xs text-slate-500 tabular-nums">
                        late {row.lateMinutes} · early {row.earlyDepartureMinutes} · OT{' '}
                        {row.overtimeMinutes}
                      </td>
                      <td>
                        <div className="flex flex-wrap justify-end gap-2">
                          {canRecord && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setDialog({ kind: 'record', attendance: row })}
                            >
                              Edit
                            </Button>
                          )}
                          {canRecord && !row.pendingCorrection && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setDialog({ kind: 'correction', attendance: row })}
                            >
                              Correct
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
      )}

      {tab === 'summary' && canView && (
        <div className="space-y-4">
          <Card>
            <CardHeader
              title="Period summary"
              description="Derived from recorded punches for the selected range."
              actions={
                <div className="flex gap-2">
                  <Input
                    type="date"
                    aria-label="Summary from date"
                    value={from}
                    onChange={(event) => setFrom(event.target.value)}
                    className="w-40"
                  />
                  <Input
                    type="date"
                    aria-label="Summary to date"
                    value={to}
                    onChange={(event) => setTo(event.target.value)}
                    className="w-40"
                  />
                </div>
              }
            />
            {summary.isPending ? (
              <TableSkeleton rows={3} columns={5} />
            ) : summary.isError ? (
              <ErrorState
                message={errorMessage(summary.error)}
                onRetry={() => void summary.refetch()}
              />
            ) : (
              <div className="grid gap-3 p-4 sm:grid-cols-3 lg:grid-cols-6">
                <StatCard label="Present" value={String(summary.data.present)} />
                <StatCard label="Absent" value={String(summary.data.absent)} />
                <StatCard label="Late" value={String(summary.data.late)} />
                <StatCard label="Leave" value={String(summary.data.leave)} />
                <StatCard label="Missing punch" value={String(summary.data.missingPunch)} />
                <StatCard label="Avg minutes" value={String(summary.data.averageMinutes)} />
              </div>
            )}
          </Card>
          <Card>
            <CardHeader title="By employee" />
            {summary.isPending ? (
              <TableSkeleton rows={5} columns={6} />
            ) : summary.isError ? (
              <ErrorState
                message={errorMessage(summary.error)}
                onRetry={() => void summary.refetch()}
              />
            ) : summary.data.staff.length === 0 ? (
              <EmptyState
                title="No records"
                description="Nothing was recorded in this range."
                icon="users"
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Employee</th>
                      <th className="text-right">Days marked</th>
                      <th className="text-right">Present</th>
                      <th className="text-right">Absent</th>
                      <th className="text-right">Late</th>
                      <th className="text-right">Leave</th>
                      <th className="text-right">Overtime</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.data.staff.map((row) => (
                      <tr key={row.staffId}>
                        <td className="font-medium text-slate-900">{row.staffName}</td>
                        <td className="text-right tabular-nums">{row.daysMarked}</td>
                        <td className="text-right tabular-nums">{row.present}</td>
                        <td className="text-right tabular-nums">{row.absent}</td>
                        <td className="text-right tabular-nums">{row.late}</td>
                        <td className="text-right tabular-nums">{row.leave}</td>
                        <td className="text-right tabular-nums">{row.overtimeMinutes}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}

      {tab === 'corrections' && canView && (
        <Card>
          <CardHeader
            title="Correction requests"
            description="Approved corrections update the punch/status and are written to the audit trail."
            actions={
              <Select
                aria-label="Filter corrections by status"
                value={correctionStatus}
                onChange={(event) => setCorrectionStatus(event.target.value)}
                className="w-40"
              >
                <option value="">All statuses</option>
                <option value="pending">Pending</option>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
              </Select>
            }
          />
          {corrections.isPending ? (
            <TableSkeleton rows={5} columns={6} />
          ) : corrections.isError ? (
            <ErrorState
              message={errorMessage(corrections.error)}
              onRetry={() => void corrections.refetch()}
            />
          ) : corrections.data.items.length === 0 ? (
            <EmptyState
              title="No correction requests"
              description="Corrections requested from the register appear here."
              icon="check"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Date</th>
                    <th>Requested</th>
                    <th>Reason</th>
                    <th>Status</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {corrections.data.items.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <p className="font-medium text-slate-900">{row.staffName}</p>
                        <p className="text-xs text-slate-500">
                          {row.requestedByName ?? 'Unknown'} ·{' '}
                          {formatDateTime(row.requestedAt, timeZone)}
                        </p>
                      </td>
                      <td>{formatDate(row.workDate)}</td>
                      <td className="text-sm text-slate-600">
                        {row.requestedStatus?.replace(/_/g, ' ') ?? 'punch only'}
                        {row.requestedPunchIn && (
                          <p className="text-xs">in {formatClock(row.requestedPunchIn)}</p>
                        )}
                        {row.requestedPunchOut && (
                          <p className="text-xs">out {formatClock(row.requestedPunchOut)}</p>
                        )}
                      </td>
                      <td className="max-w-xs text-sm text-slate-600">{row.reason}</td>
                      <td>
                        <Badge
                          tone={
                            row.status === 'approved'
                              ? 'success'
                              : row.status === 'rejected'
                                ? 'danger'
                                : 'warning'
                          }
                        >
                          {row.status}
                        </Badge>
                        {row.reviewNote && (
                          <p className="mt-1 text-xs text-slate-500">{row.reviewNote}</p>
                        )}
                      </td>
                      <td>
                        <div className="flex flex-wrap justify-end gap-2">
                          {canApprove && row.status === 'pending' && (
                            <>
                              <Button
                                size="sm"
                                loading={review.isPending}
                                onClick={() => review.mutate({ id: row.id, decision: 'approve' })}
                              >
                                Approve
                              </Button>
                              <Button
                                size="sm"
                                variant="danger"
                                loading={review.isPending}
                                onClick={() => review.mutate({ id: row.id, decision: 'reject' })}
                              >
                                Reject
                              </Button>
                            </>
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
      )}

      {tab === 'shifts' && canView && (
        <Card>
          <CardHeader
            title="Shifts"
            description="Shift times are local school time. Grace and break minutes feed the late/early calculations."
            actions={
              canConfigure ? (
                <Button size="sm" onClick={() => setDialog({ kind: 'shift' })}>
                  New shift
                </Button>
              ) : undefined
            }
          />
          {shifts.isPending ? (
            <TableSkeleton rows={4} columns={6} />
          ) : shifts.isError ? (
            <ErrorState
              message={errorMessage(shifts.error)}
              onRetry={() => void shifts.refetch()}
            />
          ) : shiftOptions.length === 0 ? (
            <EmptyState
              title="No shifts configured"
              description="Create a shift before recording punches so late minutes can be derived."
              icon="calendar"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Name</th>
                    <th>Starts</th>
                    <th>Ends</th>
                    <th className="text-right">Grace</th>
                    <th className="text-right">Break</th>
                    <th>Status</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {shiftOptions.map((row) => (
                    <tr key={row.id}>
                      <td className="font-mono text-xs">{row.code}</td>
                      <td className="font-medium text-slate-900">{row.name}</td>
                      <td>{row.startsAt}</td>
                      <td>{row.endsAt}</td>
                      <td className="text-right tabular-nums">{row.graceMinutes}m</td>
                      <td className="text-right tabular-nums">{row.breakMinutes}m</td>
                      <td>
                        <Badge tone={row.active ? 'success' : 'neutral'}>
                          {row.active ? 'active' : 'inactive'}
                        </Badge>
                      </td>
                      <td className="text-right">
                        {canConfigure && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setDialog({ kind: 'shift', shift: row })}
                          >
                            Edit
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'settings' && canConfigure && (
        <SettingsPanel
          key={settings.dataUpdatedAt}
          settings={settings.data}
          loading={settings.isPending}
          error={settings.isError ? errorMessage(settings.error) : ''}
          saving={saveSettings.isPending}
          onRetry={() => void settings.refetch()}
          onSave={(input) => saveSettings.mutate(input)}
        />
      )}

      {dialog?.kind === 'record' && (
        <RecordDialog
          key={dialog.attendance?.id ?? 'new'}
          attendance={dialog.attendance}
          staffOptions={staffOptions}
          shifts={shiftOptions}
          timeZone={timeZone}
          error={formError}
          saving={saveRecord.isPending}
          onClose={() => {
            setDialog(null);
            setFormError('');
          }}
          onSave={(input) => saveRecord.mutate(input)}
        />
      )}

      {dialog?.kind === 'correction' && (
        <CorrectionDialog
          key={dialog.attendance.id}
          attendance={dialog.attendance}
          error={formError}
          saving={saveCorrection.isPending}
          onClose={() => {
            setDialog(null);
            setFormError('');
          }}
          onSave={(body) => saveCorrection.mutate({ attendanceId: dialog.attendance.id, body })}
        />
      )}

      {dialog?.kind === 'shift' && (
        <ShiftDialog
          key={dialog.shift?.id ?? 'new-shift'}
          shift={dialog.shift}
          error={formError}
          saving={saveShift.isPending}
          onClose={() => {
            setDialog(null);
            setFormError('');
          }}
          onSave={(body) => saveShift.mutate({ id: dialog.shift?.id, body })}
        />
      )}
    </div>
  );
}

function RecordDialog({
  attendance: record,
  staffOptions,
  shifts,
  timeZone,
  error,
  saving,
  onClose,
  onSave,
}: {
  attendance?: StaffAttendanceRecord;
  staffOptions: Array<{ id: string; fullName: string }>;
  shifts: StaffShift[];
  timeZone?: string;
  error: string;
  saving: boolean;
  onClose: () => void;
  onSave: (input: Parameters<typeof recordStaffAttendance>[1]) => void;
}): ReactNode {
  const [staffId, setStaffId] = useState(record?.staffId ?? '');
  const [workDate, setWorkDate] = useState(record?.workDate ?? todayIso(timeZone));
  const [shiftId, setShiftId] = useState(record?.shiftId ?? '');
  const [punchIn, setPunchIn] = useState(toLocalInput(record?.punchIn));
  const [punchOut, setPunchOut] = useState(toLocalInput(record?.punchOut));
  const [status, setStatus] = useState(record?.status ?? '');
  const [note, setNote] = useState(record?.note ?? '');

  function submit(event: FormEvent) {
    event.preventDefault();
    onSave({
      staffId,
      workDate,
      shiftId: shiftId || null,
      punchIn: toInstant(punchIn) ?? null,
      punchOut: toInstant(punchOut) ?? null,
      status: status || undefined,
      note: note.trim() || undefined,
    });
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={record ? 'Edit attendance' : 'Record attendance'}
      description="Punches are optional; supplying both derives worked minutes. Choose a status explicitly when there is no punch."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="attendance-form" loading={saving}>
            Save
          </Button>
        </>
      }
    >
      <form id="attendance-form" className="space-y-4" onSubmit={submit}>
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Employee" htmlFor="att-staff" required>
          <Select
            id="att-staff"
            value={staffId}
            onChange={(event) => setStaffId(event.target.value)}
            required
          >
            <option value="">Select employee</option>
            {staffOptions.map((member) => (
              <option key={member.id} value={member.id}>
                {member.fullName}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Work date" htmlFor="att-date" required>
            <Input
              id="att-date"
              type="date"
              value={workDate}
              onChange={(event) => setWorkDate(event.target.value)}
              required
            />
          </Field>
          <Field
            label="Shift"
            htmlFor="att-shift"
            hint="Blank uses the employee's assigned shift."
          >
            <Select
              id="att-shift"
              value={shiftId}
              onChange={(event) => setShiftId(event.target.value)}
            >
              <option value="">Assigned shift</option>
              {shifts.map((shift) => (
                <option key={shift.id} value={shift.id}>
                  {shift.name} ({shift.startsAt}–{shift.endsAt})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Punch in" htmlFor="att-in">
            <Input
              id="att-in"
              type="datetime-local"
              value={punchIn}
              onChange={(event) => setPunchIn(event.target.value)}
            />
          </Field>
          <Field label="Punch out" htmlFor="att-out">
            <Input
              id="att-out"
              type="datetime-local"
              value={punchOut}
              onChange={(event) => setPunchOut(event.target.value)}
            />
          </Field>
        </div>
        <Field
          label="Status"
          htmlFor="att-status"
          hint="Leave blank to derive present/late/missing punch from the punches."
        >
          <Select id="att-status" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">Derive from punches</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {value.replace(/_/g, ' ')}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Note" htmlFor="att-note">
          <Textarea
            id="att-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={500}
          />
        </Field>
      </form>
    </Dialog>
  );
}

function CorrectionDialog({
  attendance: record,
  error,
  saving,
  onClose,
  onSave,
}: {
  attendance: StaffAttendanceRecord;
  error: string;
  saving: boolean;
  onClose: () => void;
  onSave: (body: Parameters<typeof requestStaffAttendanceCorrection>[2]) => void;
}): ReactNode {
  const [requestedStatus, setRequestedStatus] = useState('');
  const [punchIn, setPunchIn] = useState(toLocalInput(record.punchIn));
  const [punchOut, setPunchOut] = useState(toLocalInput(record.punchOut));
  const [reason, setReason] = useState('');

  function submit(event: FormEvent) {
    event.preventDefault();
    onSave({
      requestedStatus: requestedStatus || undefined,
      requestedPunchIn: toInstant(punchIn) ?? null,
      requestedPunchOut: toInstant(punchOut) ?? null,
      reason,
    });
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Request a correction"
      description={`${record.staffName} · ${formatDate(record.workDate)}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="correction-form" loading={saving}>
            Submit request
          </Button>
        </>
      }
    >
      <form id="correction-form" className="space-y-4" onSubmit={submit}>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Requested punch in" htmlFor="corr-in">
            <Input
              id="corr-in"
              type="datetime-local"
              value={punchIn}
              onChange={(event) => setPunchIn(event.target.value)}
            />
          </Field>
          <Field label="Requested punch out" htmlFor="corr-out">
            <Input
              id="corr-out"
              type="datetime-local"
              value={punchOut}
              onChange={(event) => setPunchOut(event.target.value)}
            />
          </Field>
        </div>
        <Field label="Requested status" htmlFor="corr-status" hint="Leave blank to keep the current status.">
          <Select
            id="corr-status"
            value={requestedStatus}
            onChange={(event) => setRequestedStatus(event.target.value)}
          >
            <option value="">Keep current status</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {value.replace(/_/g, ' ')}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Reason" htmlFor="corr-reason" required>
          <Textarea
            id="corr-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            minLength={5}
            maxLength={500}
            required
          />
        </Field>
      </form>
    </Dialog>
  );
}

function ShiftDialog({
  shift,
  error,
  saving,
  onClose,
  onSave,
}: {
  shift?: StaffShift;
  error: string;
  saving: boolean;
  onClose: () => void;
  onSave: (body: Omit<StaffShift, 'id'>) => void;
}): ReactNode {
  const [code, setCode] = useState(shift?.code ?? '');
  const [name, setName] = useState(shift?.name ?? '');
  const [startsAt, setStartsAt] = useState(shift?.startsAt ?? '08:00');
  const [endsAt, setEndsAt] = useState(shift?.endsAt ?? '16:00');
  const [graceMinutes, setGraceMinutes] = useState(String(shift?.graceMinutes ?? 10));
  const [breakMinutes, setBreakMinutes] = useState(String(shift?.breakMinutes ?? 0));
  const [active, setActive] = useState(shift?.active ?? true);

  function submit(event: FormEvent) {
    event.preventDefault();
    onSave({
      code,
      name,
      startsAt,
      endsAt,
      graceMinutes: Number(graceMinutes),
      breakMinutes: Number(breakMinutes),
      active,
    });
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={shift ? 'Edit shift' : 'New shift'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="shift-form" loading={saving}>
            Save shift
          </Button>
        </>
      }
    >
      <form id="shift-form" className="space-y-4" onSubmit={submit}>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Code" htmlFor="shift-code" required hint="Lowercase letters, numbers, _ or -.">
            <Input
              id="shift-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              pattern="[a-z0-9_-]+"
              required
            />
          </Field>
          <Field label="Name" htmlFor="shift-name" required>
            <Input id="shift-name" value={name} onChange={(event) => setName(event.target.value)} required />
          </Field>
          <Field label="Starts at" htmlFor="shift-start" required>
            <Input
              id="shift-start"
              type="time"
              value={startsAt}
              onChange={(event) => setStartsAt(event.target.value)}
              required
            />
          </Field>
          <Field label="Ends at" htmlFor="shift-end" required>
            <Input
              id="shift-end"
              type="time"
              value={endsAt}
              onChange={(event) => setEndsAt(event.target.value)}
              required
            />
          </Field>
          <Field label="Grace minutes" htmlFor="shift-grace">
            <Input
              id="shift-grace"
              type="number"
              min={0}
              max={240}
              value={graceMinutes}
              onChange={(event) => setGraceMinutes(event.target.value)}
            />
          </Field>
          <Field label="Break minutes" htmlFor="shift-break">
            <Input
              id="shift-break"
              type="number"
              min={0}
              max={240}
              value={breakMinutes}
              onChange={(event) => setBreakMinutes(event.target.value)}
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

function SettingsPanel({
  settings,
  loading,
  error,
  saving,
  onRetry,
  onSave,
}: {
  settings: StaffAttendanceSettings | undefined;
  loading: boolean;
  error: string;
  saving: boolean;
  onRetry: () => void;
  onSave: (input: StaffAttendanceSettings) => void;
}): ReactNode {
  const [fullDayMinutes, setFullDayMinutes] = useState(String(settings?.fullDayMinutes ?? 480));
  const [halfDayMinutes, setHalfDayMinutes] = useState(String(settings?.halfDayMinutes ?? 240));
  const [overtimeAfterMinutes, setOvertimeAfterMinutes] = useState(
    String(settings?.overtimeAfterMinutes ?? 60),
  );
  const [active, setActive] = useState(settings?.active ?? true);

  return (
    <Card>
      <CardHeader
        title="Attendance thresholds"
        description="Provisional internal defaults (D-037). Confirm full-day, half-day and overtime thresholds with the client before payroll relies on them."
      />
      {loading ? (
        <TableSkeleton rows={4} columns={2} />
      ) : error ? (
        <ErrorState message={error} onRetry={onRetry} />
      ) : (
        <form
          className="space-y-4 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            onSave({
              fullDayMinutes: Number(fullDayMinutes),
              halfDayMinutes: Number(halfDayMinutes),
              overtimeAfterMinutes: Number(overtimeAfterMinutes),
              active,
            });
          }}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Full day (minutes)" htmlFor="set-full" required>
              <Input
                id="set-full"
                type="number"
                min={60}
                max={1440}
                value={fullDayMinutes}
                onChange={(event) => setFullDayMinutes(event.target.value)}
                required
              />
            </Field>
            <Field label="Half day (minutes)" htmlFor="set-half" required>
              <Input
                id="set-half"
                type="number"
                min={0}
                max={1440}
                value={halfDayMinutes}
                onChange={(event) => setHalfDayMinutes(event.target.value)}
                required
              />
            </Field>
            <Field label="Overtime after (minutes)" htmlFor="set-ot" required>
              <Input
                id="set-ot"
                type="number"
                min={0}
                max={600}
                value={overtimeAfterMinutes}
                onChange={(event) => setOvertimeAfterMinutes(event.target.value)}
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
            Thresholds active
          </label>
          <div className="flex justify-end">
            <Button type="submit" loading={saving}>
              Save settings
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
