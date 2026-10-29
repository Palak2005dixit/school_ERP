import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import type {
  AttendanceCorrection,
  AttendanceRegisterRow,
  AttendanceStatus,
} from '@erp/shared';
import { useAuth, useSchoolId, useSchoolTimezone } from '../auth/AuthContext';
import {
  getAttendanceRegister,
  listAcademicYears,
  listPendingCorrections,
  listSections,
  requestAttendanceCorrection,
  reviewAttendanceCorrection,
  saveAttendanceRegister,
} from '../lib/endpoints';
import { errorMessage } from '../lib/api';
import { formatDate, formatDateTime, todayIso } from '../lib/format';
import { ATTENDANCE_STATUSES, attendanceLabel } from '../lib/statuses';
import { Dialog } from '../components/Dialog';
import { useToast } from '../components/ToastProvider';
import {
  AttendanceStatusBadge,
} from '../components/StatusBadges';
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

/**
 * Daily register plus the correction approval queue. A saved row is immutable
 * from the register view; teachers request a correction and an approver with a
 * separate permission decides it.
 */
export function AttendancePage(): ReactNode {
  const schoolId = useSchoolId();
  const timeZone = useSchoolTimezone();
  const { can, user } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();

  const today = todayIso(timeZone);
  const canRecord = can('attendance.student.record');
  const canApprove = can('attendance.correction.approve');

  const [yearId, setYearId] = useState('');
  const [sectionId, setSectionId] = useState('');
  const [date, setDate] = useState(today);
  const [draft, setDraft] = useState<Record<string, AttendanceStatus | ''>>({});
  const [correctionRow, setCorrectionRow] = useState<AttendanceRegisterRow | null>(null);
  const [reviewTarget, setReviewTarget] = useState<{
    correction: AttendanceCorrection;
    decision: 'approve' | 'reject';
  } | null>(null);

  const years = useQuery({
    queryKey: ['academic-years', schoolId],
    queryFn: () => listAcademicYears(schoolId),
    staleTime: 60_000,
  });

  const sections = useQuery({
    queryKey: ['sections', schoolId, { academicYearId: yearId, status: 'active' }],
    queryFn: () => listSections(schoolId, { academicYearId: yearId, status: 'active' }),
    enabled: Boolean(yearId),
    staleTime: 60_000,
  });

  useEffect(() => {
    if (yearId || !years.data?.items.length) return;
    const active = years.data.items.find((year) => year.status === 'active');
    setYearId(active?.id ?? years.data.items[0]!.id);
  }, [yearId, years.data]);

  useEffect(() => {
    const items = sections.data?.items;
    if (!items) return;
    if (items.length === 0) {
      if (sectionId) setSectionId('');
      return;
    }
    if (!items.some((section) => section.id === sectionId)) setSectionId(items[0]!.id);
  }, [sections.data, sectionId]);

  const selectedYear = years.data?.items.find((year) => year.id === yearId);

  // Keep the default date inside the selected academic year so switching to a
  // closed year does not immediately produce an out-of-range error.
  useEffect(() => {
    if (!selectedYear) return;
    const next =
      today < selectedYear.startsOn
        ? selectedYear.startsOn
        : today > selectedYear.endsOn
          ? selectedYear.endsOn
          : today;
    setDate(next);
    // Reset drafts only when the year changes, not when the user picks a date.
  }, [selectedYear?.id, today]);

  useEffect(() => {
    setDraft({});
  }, [sectionId, date]);

  const register = useQuery({
    queryKey: ['attendance-register', schoolId, sectionId, date],
    queryFn: () => getAttendanceRegister(schoolId, sectionId, date),
    enabled: Boolean(sectionId && date),
  });

  const corrections = useQuery({
    queryKey: ['attendance-corrections', schoolId],
    queryFn: () => listPendingCorrections(schoolId),
    enabled: canApprove,
  });

  const save = useMutation({
    mutationFn: (entries: Array<{ studentId: string; status: AttendanceStatus }>) =>
      saveAttendanceRegister(schoolId, { sectionId, date, entries }),
    onSuccess: (result) => {
      setDraft({});
      if (result.inserted > 0) {
        toast.notify(
          'success',
          `Saved attendance for ${result.inserted} ${
            result.inserted === 1 ? 'student' : 'students'
          }.`,
        );
      } else {
        toast.notify(
          'info',
          'No new records were saved. Existing marks must be changed through a correction request.',
        );
      }
      invalidateRegister();
    },
    onError: (error) => toast.notify('error', errorMessage(error)),
  });

  const draftEntries = useMemo(() => {
    const rows = register.data?.rows ?? [];
    return rows
      .filter((row) => !row.attendanceId && draft[row.studentId])
      .map((row) => ({
        studentId: row.studentId,
        status: draft[row.studentId] as AttendanceStatus,
      }));
  }, [register.data, draft]);

  function invalidateRegister(): void {
    void queryClient.invalidateQueries({ queryKey: ['attendance-register', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['attendance-corrections', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['overview', schoolId] });
  }

  function markAllPresent(): void {
    const rows = register.data?.rows ?? [];
    setDraft((current) => {
      const next = { ...current };
      for (const row of rows) {
        if (!row.attendanceId) next[row.studentId] = 'present';
      }
      return next;
    });
  }

  const hasUnmarked = (register.data?.summary.unmarked ?? 0) > 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Attendance"
        description="One daily register per section. Saved marks are changed only through a correction request that another user approves."
      />

      <Card>
        <div className="grid gap-3 border-b border-slate-100 px-4 py-4 sm:grid-cols-3">
          <Field label="Academic year" htmlFor="attendance-year">
            <Select
              id="attendance-year"
              value={yearId}
              onChange={(event) => setYearId(event.target.value)}
              disabled={years.isPending}
            >
              <option value="">Select a year</option>
              {years.data?.items.map((year) => (
                <option key={year.id} value={year.id}>
                  {year.name}
                  {year.status === 'active' ? ' (active)' : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Section" htmlFor="attendance-section">
            <Select
              id="attendance-section"
              value={sectionId}
              onChange={(event) => setSectionId(event.target.value)}
              disabled={sections.isPending || !sections.data?.items.length}
            >
              <option value="">Select a section</option>
              {sections.data?.items.map((section) => (
                <option key={section.id} value={section.id}>
                  {section.className} · {section.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Date" htmlFor="attendance-date" hint="Future dates are not allowed.">
            <Input
              id="attendance-date"
              type="date"
              value={date}
              max={today}
              onChange={(event) => setDate(event.target.value)}
            />
          </Field>
        </div>

        {years.isError ? (
          <ErrorState message={errorMessage(years.error)} onRetry={() => void years.refetch()} />
        ) : sections.isError ? (
          <ErrorState
            message={errorMessage(sections.error)}
            onRetry={() => void sections.refetch()}
          />
        ) : !yearId ? (
          <EmptyState
            title="Select an academic year"
            description="Registers are tied to the sections of one academic year."
            icon="calendar"
          />
        ) : sections.isPending ? (
          <TableSkeleton rows={3} columns={3} />
        ) : sections.data.items.length === 0 ? (
          <EmptyState
            title="No sections available"
            description="There are no active sections you can see in this academic year."
            icon="users"
          />
        ) : !sectionId ? (
          <EmptyState
            title="Select a section"
            description="Choose a section to open its daily register."
            icon="clipboard"
          />
        ) : register.isPending ? (
          <TableSkeleton rows={6} columns={5} />
        ) : register.isError ? (
          <ErrorState
            message={errorMessage(register.error)}
            onRetry={() => void register.refetch()}
          />
        ) : (
          <RegisterBody
            registerData={register.data}
            canRecord={canRecord}
            draft={draft}
            onDraftChange={(studentId, status) =>
              setDraft((current) => ({ ...current, [studentId]: status }))
            }
            onMarkAllPresent={markAllPresent}
            onClear={() => setDraft({})}
            onSave={() => save.mutate(draftEntries)}
            saving={save.isPending}
            entryCount={draftEntries.length}
            hasUnmarked={hasUnmarked}
            onRequestCorrection={setCorrectionRow}
          />
        )}
      </Card>

      {canApprove && (
        <Card>
          <CardHeader
            title="Correction requests"
            description="Pending requests from teachers. You cannot approve a request you raised yourself."
            actions={
              <Badge tone={corrections.data?.items.length ? 'warning' : 'neutral'}>
                {corrections.data?.items.length ?? 0} pending
              </Badge>
            }
          />
          {corrections.isPending ? (
            <TableSkeleton rows={3} columns={5} />
          ) : corrections.isError ? (
            <ErrorState
              message={errorMessage(corrections.error)}
              onRetry={() => void corrections.refetch()}
            />
          ) : corrections.data.items.length === 0 ? (
            <EmptyState
              title="No corrections waiting"
              description="Requests appear here after a teacher asks to change a saved attendance status."
              icon="check"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Student</th>
                    <th>Class / section</th>
                    <th>Date</th>
                    <th>Change</th>
                    <th>Reason</th>
                    <th>Requested by</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {corrections.data.items.map((correction) => {
                    const ownRequest = correction.requestedById === user?.id;
                    return (
                      <tr key={correction.id}>
                        <td>
                          <p className="font-medium text-slate-900">{correction.studentName}</p>
                          <p className="font-mono text-xs text-slate-500">
                            {correction.admissionNumber}
                          </p>
                        </td>
                        <td className="text-slate-600">
                          {correction.className} · {correction.sectionName}
                        </td>
                        <td className="whitespace-nowrap text-slate-600">
                          {formatDate(correction.attendanceDate)}
                        </td>
                        <td>
                          <span className="flex flex-wrap items-center gap-1.5">
                            <AttendanceStatusBadge status={correction.currentStatus} />
                            <Icon name="chevronRight" className="h-3.5 w-3.5 text-slate-400" />
                            <AttendanceStatusBadge status={correction.requestedStatus} />
                          </span>
                        </td>
                        <td className="max-w-56 text-sm text-slate-600">{correction.reason}</td>
                        <td className="text-xs text-slate-500">
                          <p>{correction.requestedByName ?? 'Unknown user'}</p>
                          <p>{formatDateTime(correction.requestedAt, timeZone)}</p>
                        </td>
                        <td>
                          <div className="flex justify-end gap-2">
                            {ownRequest ? (
                              <Badge tone="info">Your request</Badge>
                            ) : (
                              <>
                                <Button
                                  size="sm"
                                  onClick={() =>
                                    setReviewTarget({ correction, decision: 'approve' })
                                  }
                                >
                                  Approve
                                </Button>
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  onClick={() =>
                                    setReviewTarget({ correction, decision: 'reject' })
                                  }
                                >
                                  Reject
                                </Button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {correctionRow && (
        <CorrectionDialog
          schoolId={schoolId}
          row={correctionRow}
          onClose={() => setCorrectionRow(null)}
          onSaved={invalidateRegister}
        />
      )}

      {reviewTarget && (
        <ReviewDialog
          schoolId={schoolId}
          correction={reviewTarget.correction}
          decision={reviewTarget.decision}
          onClose={() => setReviewTarget(null)}
          onReviewed={invalidateRegister}
        />
      )}
    </div>
  );
}

/* -------------------------------- register -------------------------------- */

function RegisterBody({
  registerData,
  canRecord,
  draft,
  onDraftChange,
  onMarkAllPresent,
  onClear,
  onSave,
  saving,
  entryCount,
  hasUnmarked,
  onRequestCorrection,
}: {
  registerData: Awaited<ReturnType<typeof getAttendanceRegister>>;
  canRecord: boolean;
  draft: Record<string, AttendanceStatus | ''>;
  onDraftChange: (studentId: string, status: AttendanceStatus | '') => void;
  onMarkAllPresent: () => void;
  onClear: () => void;
  onSave: () => void;
  saving: boolean;
  entryCount: number;
  hasUnmarked: boolean;
  onRequestCorrection: (row: AttendanceRegisterRow) => void;
}): ReactNode {
  const { section, summary } = registerData;
  const editable = canRecord && registerData.canRecord;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            {section.className} · {section.name}
          </h2>
          <p className="text-xs text-slate-500">
            {formatDate(registerData.date)} · {section.academicYearName} · {summary.marked} of{' '}
            {summary.total} marked
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <AttendanceStatusBadge status="present" />
          <span className="text-xs text-slate-500">{summary.present}</span>
          <AttendanceStatusBadge status="absent" />
          <span className="text-xs text-slate-500">{summary.absent}</span>
          <AttendanceStatusBadge status="late" />
          <span className="text-xs text-slate-500">{summary.late}</span>
          <AttendanceStatusBadge status="half_day" />
          <span className="text-xs text-slate-500">{summary.halfDay}</span>
          <AttendanceStatusBadge status="excused" />
          <span className="text-xs text-slate-500">{summary.excused}</span>
        </div>
      </div>

      {registerData.isFuture && (
        <div className="px-4 pt-4">
          <Alert tone="warning" title="Future date">
            Attendance cannot be recorded ahead of the school's current date.
          </Alert>
        </div>
      )}
      {!registerData.isWithinYear && (
        <div className="px-4 pt-4">
          <Alert tone="warning" title="Outside the academic year">
            This date is outside {section.academicYearName} ({formatDate(section.startsOn)} –{' '}
            {formatDate(section.endsOn)}).
          </Alert>
        </div>
      )}
      {section.status === 'inactive' && (
        <div className="px-4 pt-4">
          <Alert tone="warning" title="Inactive section">
            This section is inactive, so its register is read-only.
          </Alert>
        </div>
      )}
      {!canRecord && (
        <div className="px-4 pt-4">
          <Alert tone="info" title="Read-only access">
            You can view this register but do not hold permission to record attendance.
          </Alert>
        </div>
      )}

      {registerData.rows.length === 0 ? (
        <EmptyState
          title="No students enrolled on this date"
          description="Students appear here when they have an active enrollment in this section covering the selected date."
          icon="users"
        />
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Student</th>
                  <th>Admission no.</th>
                  <th>Status</th>
                  <th>Recorded</th>
                  <th>Pending correction</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {registerData.rows.map((row) => {
                  const pending = row.pendingCorrection;
                  return (
                    <tr key={row.studentId}>
                      <td className="font-medium text-slate-900">{row.fullName}</td>
                      <td className="font-mono text-xs text-slate-500">{row.admissionNumber}</td>
                      <td>
                        {row.attendanceId ? (
                          <AttendanceStatusBadge status={row.status} />
                        ) : editable ? (
                          <Select
                            aria-label={`Attendance for ${row.fullName}`}
                            className="!w-36"
                            value={draft[row.studentId] ?? ''}
                            onChange={(event) =>
                              onDraftChange(
                                row.studentId,
                                event.target.value as AttendanceStatus | '',
                              )
                            }
                          >
                            <option value="">Not marked</option>
                            {ATTENDANCE_STATUSES.map((status) => (
                              <option key={status.value} value={status.value}>
                                {status.label}
                              </option>
                            ))}
                          </Select>
                        ) : (
                          <span className="text-sm text-slate-400">Not marked</span>
                        )}
                      </td>
                      <td className="text-xs text-slate-500">
                        {row.attendanceId ? (
                          <>
                            <p>{row.recordedByName ?? 'Unknown user'}</p>
                            {row.note && <p className="max-w-48 truncate">{row.note}</p>}
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        {pending ? (
                          <div className="space-y-1">
                            <span className="flex flex-wrap items-center gap-1.5 text-xs text-slate-600">
                              <Badge tone="warning">Awaiting review</Badge>
                              <Icon name="chevronRight" className="h-3 w-3 text-slate-400" />
                              <AttendanceStatusBadge status={pending.requestedStatus} />
                            </span>
                            <p className="max-w-56 text-xs text-slate-500">{pending.reason}</p>
                          </div>
                        ) : (
                          <span className="text-xs text-slate-400">—</span>
                        )}
                      </td>
                      <td>
                        <div className="flex justify-end">
                          {row.attendanceId && editable && !pending && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => onRequestCorrection(row)}
                            >
                              Request correction
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {editable && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={onMarkAllPresent}
                  disabled={!hasUnmarked}
                >
                  <Icon name="check" className="h-3.5 w-3.5" />
                  Mark remaining present
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onClear}
                  disabled={entryCount === 0}
                >
                  Clear draft
                </Button>
                <p className="text-xs text-slate-500">
                  Already saved rows are locked. Use a correction request to change them.
                </p>
              </div>
              <Button onClick={onSave} loading={saving} disabled={entryCount === 0}>
                Save attendance{entryCount > 0 ? ` (${entryCount})` : ''}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* -------------------------------- dialogs --------------------------------- */

function CorrectionDialog({
  schoolId,
  row,
  onClose,
  onSaved,
}: {
  schoolId: string;
  row: AttendanceRegisterRow;
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  const toast = useToast();
  const current = row.status ?? 'present';
  const [requestedStatus, setRequestedStatus] = useState<AttendanceStatus>(
    current === 'absent' ? 'present' : 'absent',
  );
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      requestAttendanceCorrection(schoolId, {
        attendanceId: row.attendanceId!,
        requestedStatus,
        reason: reason.trim(),
      }),
    onSuccess: () => {
      toast.notify('success', 'Correction request sent for review.');
      onSaved();
      onClose();
    },
    onError: (mutationError) => setError(errorMessage(mutationError)),
  });

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (requestedStatus === current) {
      setError('Choose a status different from the current one.');
      return;
    }
    if (reason.trim().length < 5) {
      setError('Give a short reason (at least 5 characters).');
      return;
    }
    setError(null);
    mutation.mutate();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Request correction · ${row.fullName}`}
      description="The saved status stays unchanged until an approver accepts the request."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={mutation.isPending}>
            Send request
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="flex items-center gap-2 text-sm text-slate-600">
          <span>Current</span>
          <AttendanceStatusBadge status={current} />
          <Icon name="chevronRight" className="h-4 w-4 text-slate-400" />
          <AttendanceStatusBadge status={requestedStatus} />
        </div>
        <Field label="Requested status" htmlFor="correction-status" required>
          <Select
            id="correction-status"
            value={requestedStatus}
            onChange={(event) => setRequestedStatus(event.target.value as AttendanceStatus)}
          >
            {ATTENDANCE_STATUSES.map((status) => (
              <option key={status.value} value={status.value} disabled={status.value === current}>
                {status.label}
                {status.value === current ? ' (current)' : ''}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Reason"
          htmlFor="correction-reason"
          required
          hint="Visible to the approver and kept in the audit trail."
        >
          <Textarea
            id="correction-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={500}
            placeholder="For example: the student arrived after the register was saved."
          />
        </Field>
        <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
      </form>
    </Dialog>
  );
}

function ReviewDialog({
  schoolId,
  correction,
  decision,
  onClose,
  onReviewed,
}: {
  schoolId: string;
  correction: AttendanceCorrection;
  decision: 'approve' | 'reject';
  onClose: () => void;
  onReviewed: () => void;
}): ReactNode {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      reviewAttendanceCorrection(schoolId, correction.id, {
        decision,
        note: note.trim() || undefined,
      }),
    onSuccess: () => {
      toast.notify(
        'success',
        decision === 'approve' ? 'Correction approved.' : 'Correction rejected.',
      );
      onReviewed();
      onClose();
    },
    onError: (mutationError) => setError(errorMessage(mutationError)),
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title={`${decision === 'approve' ? 'Approve' : 'Reject'} correction · ${correction.studentName}`}
      description={`${correction.className} · ${correction.sectionName} · ${formatDate(
        correction.attendanceDate,
      )}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            variant={decision === 'approve' ? 'primary' : 'danger'}
            onClick={() => mutation.mutate()}
            loading={mutation.isPending}
          >
            {decision === 'approve' ? 'Approve correction' : 'Reject request'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
          <span>Current</span>
          <AttendanceStatusBadge status={correction.currentStatus} />
          <Icon name="chevronRight" className="h-4 w-4 text-slate-400" />
          <span>Requested</span>
          <AttendanceStatusBadge status={correction.requestedStatus} />
        </div>
        <div className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
          <p className="font-medium text-slate-800">Reason from {correction.requestedByName}</p>
          <p className="mt-1">{correction.reason}</p>
        </div>
        <p className="text-sm text-slate-600">
          {decision === 'approve'
            ? `Approving changes the saved status from ${attendanceLabel(
                correction.currentStatus,
              )} to ${attendanceLabel(correction.requestedStatus)}.`
            : 'Rejecting leaves the saved status unchanged. The request stays in the record.'}
        </p>
        <Field label="Review note" htmlFor="review-note" hint="Optional. Shown in the audit trail.">
          <Textarea
            id="review-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={500}
            placeholder={
              decision === 'approve' ? 'Optional confirmation note' : 'Why is this rejected?'
            }
          />
        </Field>
      </div>
    </Dialog>
  );
}
