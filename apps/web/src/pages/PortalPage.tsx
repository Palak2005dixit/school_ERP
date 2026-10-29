import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import type { ChildSummary, ReportCard } from '@erp/shared';
import { useAuth, useSchoolId, useSchoolTimezone } from '../auth/AuthContext';
import {
  childInvoiceUrl,
  childReceiptUrl,
  childTranscriptPrintUrl,
  getChildAttendance,
  getChildFees,
  getChildResults,
  listChildren,
  listNotices,
  markNoticeRead,
  noticeAttachmentUrl,
} from '../lib/endpoints';
import { errorMessage } from '../lib/api';
import { formatBytes, formatDate, formatDateTime, formatMoney, todayIso } from '../lib/format';
import { AttendanceStatusBadge } from '../components/StatusBadges';
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
  TableSkeleton,
  cn,
} from '../components/ui';

type DetailTab = 'attendance' | 'fees' | 'results';

export function PortalPage(): ReactNode {
  const schoolId = useSchoolId();
  const timeZone = useSchoolTimezone();
  const { user } = useAuth();

  const children = useQuery({
    queryKey: ['portal-children', schoolId],
    queryFn: () => listChildren(schoolId),
  });

  const [selectedId, setSelectedId] = useState('');

  useEffect(() => {
    if (!children.data) return;
    if (!children.data.items.some((child) => child.studentId === selectedId)) {
      setSelectedId(children.data.items[0]?.studentId ?? '');
    }
  }, [children.data, selectedId]);

  const selectedChild = children.data?.items.find((child) => child.studentId === selectedId);

  const notices = useQuery({
    queryKey: ['portal-notices', schoolId],
    queryFn: () => listNotices(schoolId),
  });

  const queryClient = useQueryClient();
  const markRead = useMutation({
    mutationFn: (noticeId: string) => markNoticeRead(schoolId, noticeId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['portal-notices', schoolId] });
    },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="My children"
        description={`Signed in as ${user?.displayName ?? 'guardian'}. Only children with a verified guardian link are shown, and all data is read-only.`}
      />

      {children.isPending ? (
        <Card>
          <TableSkeleton rows={3} columns={3} />
        </Card>
      ) : children.isError ? (
        <ErrorState message={errorMessage(children.error)} onRetry={() => void children.refetch()} />
      ) : children.data.items.length === 0 ? (
        <Card>
          <EmptyState
            title="No verified children linked"
            description="The school needs to verify your guardian link before records appear here. Contact the school office if this looks wrong."
            icon="child"
          />
        </Card>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {children.data.items.map((child) => (
              <ChildCard
                key={child.studentId}
                child={child}
                selected={child.studentId === selectedId}
                onSelect={() => setSelectedId(child.studentId)}
              />
            ))}
          </div>

          {selectedChild && (
            <ChildDetail
              key={selectedChild.studentId}
              child={selectedChild}
              timeZone={timeZone}
            />
          )}
        </>
      )}

      <Card>
        <CardHeader
          title="School notices"
          description="Published notices addressed to parents. Drafts and expired notices are never shown here."
        />
        {notices.isPending ? (
          <TableSkeleton rows={3} columns={2} />
        ) : notices.isError ? (
          <ErrorState message={errorMessage(notices.error)} onRetry={() => void notices.refetch()} />
        ) : notices.data.items.length === 0 ? (
          <EmptyState title="No notices" description="There are no current notices for you." icon="clipboard" />
        ) : (
          <div className="divide-y divide-slate-100">
            {notices.data.items.map((notice) => (
              <article key={notice.id} className="px-5 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  {notice.pinned && <Badge tone="brand">Pinned</Badge>}
                  <h3 className="text-sm font-semibold text-slate-900">{notice.title}</h3>
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  {notice.publishedAt ? formatDateTime(notice.publishedAt, timeZone) : ''}
                  {notice.expiresOn ? ` · Expires ${formatDate(notice.expiresOn)}` : ''}
                </p>
                <p className="mt-2 whitespace-pre-line text-sm text-slate-700">{notice.body}</p>
                {notice.attachments.length > 0 && (
                  <ul className="mt-2 flex flex-wrap gap-2" aria-label="Attachments">
                    {notice.attachments.map((attachment) => (
                      <li key={attachment.id}>
                        <a
                          href={noticeAttachmentUrl(schoolId, notice.id, attachment.id)}
                          download={attachment.filename}
                          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-brand-700 hover:border-brand-300"
                        >
                          <Icon name="download" className="h-3.5 w-3.5" />
                          {attachment.filename}
                          <span className="text-slate-400">{formatBytes(attachment.byteSize)}</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="mt-2 flex items-center gap-2">
                  {notice.readByMe ? (
                    <Badge tone="success">Read</Badge>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={markRead.isPending && markRead.variables === notice.id}
                      onClick={() => markRead.mutate(notice.id)}
                    >
                      Mark as read
                    </Button>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </Card>

      <Alert tone="info">
        This portal is read-only. To correct a child's details, contact the school office; changes are
        recorded in the school's audit log.
      </Alert>
    </div>
  );
}

function ChildCard({
  child,
  selected,
  onSelect,
}: {
  child: ChildSummary;
  selected: boolean;
  onSelect: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'rounded-xl border bg-white p-5 text-left transition',
        selected
          ? 'border-brand-400 ring-2 ring-brand-100'
          : 'border-slate-200 hover:border-slate-300',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-brand-50 text-brand-700">
            <Icon name="child" />
          </span>
          <div>
            <p className="text-sm font-semibold text-slate-900">{child.fullName}</p>
            <p className="font-mono text-xs text-slate-500">{child.admissionNumber}</p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Badge tone="success">Verified</Badge>
          {child.isPrimary && <Badge tone="brand">Primary contact</Badge>}
        </div>
      </div>
      <dl className="mt-4 space-y-2 border-t border-slate-100 pt-4 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-slate-500">Class</dt>
          <dd className="text-right font-medium text-slate-800">
            {child.className ? `${child.className} · ${child.sectionName}` : 'Not enrolled'}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-slate-500">Academic year</dt>
          <dd className="text-right font-medium text-slate-800">{child.academicYearName ?? '—'}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-slate-500">Your relationship</dt>
          <dd className="text-right font-medium text-slate-800 capitalize">{child.relationshipType}</dd>
        </div>
      </dl>
    </button>
  );
}

function ChildDetail({
  child,
  timeZone,
}: {
  child: ChildSummary;
  timeZone: string | undefined;
}): ReactNode {
  const [tab, setTab] = useState<DetailTab>('attendance');

  return (
    <Card>
      <CardHeader
        title={`${child.fullName} · records`}
        description="Attendance, fees and published results for this child."
      />
      <div className="flex gap-1 border-b border-slate-200 px-5" role="tablist" aria-label="Child records">
        {(
          [
            ['attendance', 'Attendance'],
            ['fees', 'Fees & receipts'],
            ['results', 'Report cards'],
          ] as Array<[DetailTab, string]>
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
      <div className="p-5">
        {tab === 'attendance' && <ChildAttendance studentId={child.studentId} />}
        {tab === 'fees' && <ChildFees studentId={child.studentId} />}
        {tab === 'results' && <ChildResults studentId={child.studentId} timeZone={timeZone} />}
      </div>
    </Card>
  );
}

function ChildAttendance({ studentId }: { studentId: string }): ReactNode {
  const schoolId = useSchoolId();
  const timeZone = useSchoolTimezone();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState(todayIso(timeZone));

  const attendance = useQuery({
    queryKey: ['portal-attendance', schoolId, studentId, from, to],
    queryFn: () =>
      getChildAttendance(schoolId, studentId, {
        from: from || undefined,
        to: to || undefined,
      }),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="From" htmlFor="portal-from">
          <Input
            id="portal-from"
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
        </Field>
        <Field label="To" htmlFor="portal-to">
          <Input
            id="portal-to"
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
        </Field>
        <Button
          variant="secondary"
          onClick={() => {
            setFrom('');
            setTo(todayIso(timeZone));
          }}
        >
          Last 30 days
        </Button>
      </div>

      {attendance.isPending ? (
        <TableSkeleton rows={5} columns={3} />
      ) : attendance.isError ? (
        <ErrorState message={errorMessage(attendance.error)} onRetry={() => void attendance.refetch()} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <MiniStat label="Marked" value={String(attendance.data.totalMarked)} />
            <MiniStat label="Present" value={String(attendance.data.present)} />
            <MiniStat label="Absent" value={String(attendance.data.absent)} />
            <MiniStat label="Rate" value={`${attendance.data.attendanceRate.toFixed(1)}%`} />
          </div>
          <p className="text-xs text-slate-500">
            {formatDate(attendance.data.from)} – {formatDate(attendance.data.to)} · half days count
            as 0.5 when the rate is calculated.
          </p>
          {attendance.data.days.length === 0 ? (
            <EmptyState
              title="No attendance in this period"
              description="The teacher has not marked a register for these dates."
              icon="calendar"
            />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Status</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {attendance.data.days.map((day) => (
                    <tr key={day.date}>
                      <td>{formatDate(day.date)}</td>
                      <td>
                        <AttendanceStatusBadge status={day.status} />
                      </td>
                      <td className="text-sm text-slate-600">
                        {day.note ?? <span className="text-slate-400">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ChildFees({ studentId }: { studentId: string }): ReactNode {
  const schoolId = useSchoolId();
  const fees = useQuery({
    queryKey: ['portal-fees', schoolId, studentId],
    queryFn: () => getChildFees(schoolId, studentId),
  });

  if (fees.isPending) return <TableSkeleton rows={5} columns={4} />;
  if (fees.isError) {
    return <ErrorState message={errorMessage(fees.error)} onRetry={() => void fees.refetch()} />;
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900">Account summary</h3>
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            window.open(childInvoiceUrl(schoolId, studentId), '_blank', 'noopener')
          }
        >
          <Icon name="download" className="h-3.5 w-3.5" />
          Printable invoice
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MiniStat label="Charged" value={formatMoney(fees.data.totalCharged)} />
        <MiniStat label="Concession" value={formatMoney(fees.data.totalConcession)} />
        <MiniStat label="Paid" value={formatMoney(fees.data.totalPaid)} />
        <MiniStat label="Balance" value={formatMoney(fees.data.balance)} />
      </div>

      <section>
        <h3 className="mb-2 text-sm font-semibold text-slate-900">Charges</h3>
        {fees.data.charges.length === 0 ? (
          <p className="text-sm text-slate-500">No charges have been raised.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Fee head</th>
                  <th className="text-right">Net</th>
                  <th className="text-right">Paid</th>
                  <th className="text-right">Balance</th>
                  <th>Due</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {fees.data.charges.map((charge) => (
                  <tr key={charge.id}>
                    <td>
                      <p className="font-medium text-slate-900">{charge.feeHeadName}</p>
                      <p className="text-xs text-slate-500">{charge.description}</p>
                    </td>
                    <td className="text-right tabular-nums">{formatMoney(charge.netAmount)}</td>
                    <td className="text-right tabular-nums">{formatMoney(charge.paidAmount)}</td>
                    <td className="text-right tabular-nums">{formatMoney(charge.balance)}</td>
                    <td>{formatDate(charge.dueOn)}</td>
                    <td>
                      <Badge
                        tone={
                          charge.status === 'paid'
                            ? 'success'
                            : charge.status === 'partial'
                              ? 'warning'
                              : 'danger'
                        }
                      >
                        {charge.status}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold text-slate-900">Receipts</h3>
        {fees.data.payments.length === 0 ? (
          <p className="text-sm text-slate-500">No payments have been recorded.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Receipt</th>
                  <th className="text-right">Amount</th>
                  <th className="text-right">Refunded</th>
                  <th>Method</th>
                  <th>Paid on</th>
                  <th aria-label="Receipt" />
                </tr>
              </thead>
              <tbody>
                {fees.data.payments.map((payment) => (
                  <tr key={payment.id}>
                    <td className="font-mono text-xs">{payment.receiptNumber}</td>
                    <td className="text-right tabular-nums">{formatMoney(payment.amount)}</td>
                    <td className="text-right tabular-nums">{formatMoney(payment.refundedAmount)}</td>
                    <td className="capitalize">{payment.method.replace(/_/g, ' ')}</td>
                    <td>{formatDate(payment.paidOn)}</td>
                    <td className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          window.open(
                            childReceiptUrl(schoolId, studentId, payment.id),
                            '_blank',
                            'noopener',
                          )
                        }
                      >
                        Receipt
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function ChildResults({ studentId, timeZone }: { studentId: string; timeZone: string | undefined }): ReactNode {
  const schoolId = useSchoolId();
  const results = useQuery({
    queryKey: ['portal-results', schoolId, studentId],
    queryFn: () => getChildResults(schoolId, studentId),
  });
  const [selectedExamId, setSelectedExamId] = useState('');

  useEffect(() => {
    if (!results.data) return;
    if (!results.data.items.some((card) => card.examId === selectedExamId)) {
      setSelectedExamId(results.data.items[0]?.examId ?? '');
    }
  }, [results.data, selectedExamId]);

  if (results.isPending) return <TableSkeleton rows={5} columns={4} />;
  if (results.isError) {
    return <ErrorState message={errorMessage(results.error)} onRetry={() => void results.refetch()} />;
  }
  if (results.data.items.length === 0) {
    return (
      <EmptyState
        title="No published results"
        description="Report cards appear after the school publishes the exam."
        icon="chart"
      />
    );
  }

  const selected = results.data.items.find((card) => card.examId === selectedExamId);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Exam" htmlFor="portal-exam">
          <select
            id="portal-exam"
            className="field-input max-w-sm"
            value={selectedExamId}
            onChange={(event) => setSelectedExamId(event.target.value)}
          >
            {results.data.items.map((card) => (
              <option key={card.examId} value={card.examId}>
                {card.examName}
              </option>
            ))}
          </select>
        </Field>
        <Button
          variant="secondary"
          onClick={() =>
            window.open(
              childTranscriptPrintUrl(schoolId, studentId),
              '_blank',
              'noopener',
            )
          }
        >
          <Icon name="download" className="h-4 w-4" />
          Printable transcript
        </Button>
      </div>
      {selected && <ReportCardBlock card={selected} timeZone={timeZone} />}
    </div>
  );
}

function ReportCardBlock({ card, timeZone }: { card: ReportCard; timeZone: string | undefined }): ReactNode {
  const tone = card.result === 'pass' ? 'success' : card.result === 'fail' ? 'danger' : 'warning';
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-4 py-3">
        <div>
          <p className="text-sm font-semibold text-slate-900">{card.examName}</p>
          <p className="text-xs text-slate-500">
            Published {formatDateTime(card.publishedAt, timeZone)}
          </p>
        </div>
        <div className="text-right">
          <Badge tone={tone}>{card.result}</Badge>
          <p className="mt-1 text-xs text-slate-500">
            {card.totalObtained} / {card.totalMax}
            {card.percentage !== null ? ` · ${card.percentage.toFixed(2)}%` : ''}
          </p>
        </div>
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="data-table">
          <thead>
            <tr>
              <th>Subject</th>
              <th className="text-right">Marks</th>
              <th className="text-right">Max</th>
              <th>Grade</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {card.subjects.map((subject) => (
              <tr key={subject.subjectId}>
                <td className="font-medium text-slate-900">{subject.subjectName}</td>
                <td className="text-right tabular-nums">
                  {subject.isAbsent ? 'Absent' : (subject.marksObtained ?? '—')}
                </td>
                <td className="text-right tabular-nums">{subject.maxMarks}</td>
                <td>{subject.grade ?? '—'}</td>
                <td>
                  {subject.passed === null ? (
                    <Badge tone="neutral">Not recorded</Badge>
                  ) : (
                    <Badge tone={subject.passed ? 'success' : 'danger'}>
                      {subject.passed ? 'Pass' : 'Fail'}
                    </Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-sm">
        <span className="text-slate-500">Overall grade: </span>
        <span className="font-medium">{card.overallGrade ?? '—'}</span>
      </p>
      {card.result === 'incomplete' && (
        <Alert tone="warning">Some subjects do not have recorded marks; the result is incomplete.</Alert>
      )}
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2">
      <p className="text-[11px] font-medium tracking-wide text-slate-500 uppercase">{label}</p>
      <p className="mt-1 text-sm font-semibold tabular-nums text-slate-900">{value}</p>
    </div>
  );
}
