import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { useSchoolId, useSchoolTimezone } from '../auth/AuthContext';
import {
  getAttendanceReport,
  getFeeReport,
  listAcademicYears,
  reportExportUrl,
} from '../lib/endpoints';
import { errorMessage } from '../lib/api';
import { formatDate, formatMoney, todayIso } from '../lib/format';
import {
  Alert,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LinkButton,
  PageHeader,
  Select,
  TableSkeleton,
} from '../components/ui';

export function ReportsPage(): ReactNode {
  const schoolId = useSchoolId();
  const timeZone = useSchoolTimezone();

  const [yearId, setYearId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const years = useQuery({
    queryKey: ['academic-years', schoolId],
    queryFn: () => listAcademicYears(schoolId),
  });

  useEffect(() => {
    if (yearId || !years.data) return;
    const preferred =
      years.data.items.find((year) => year.status === 'active') ?? years.data.items[0];
    if (preferred) {
      setYearId(preferred.id);
      setFrom(preferred.startsOn);
      setTo(preferred.endsOn);
    }
  }, [years.data, yearId]);

  const attendance = useQuery({
    queryKey: ['report-attendance', schoolId, yearId, from, to],
    queryFn: () =>
      getAttendanceReport(schoolId, {
        academicYearId: yearId || undefined,
        from: from || undefined,
        to: to || undefined,
      }),
    enabled: Boolean(yearId),
  });

  const fees = useQuery({
    queryKey: ['report-fees', schoolId, yearId],
    queryFn: () => getFeeReport(schoolId, { academicYearId: yearId || undefined }),
    enabled: Boolean(yearId),
  });

  const exportHref = (type: 'students' | 'attendance' | 'fees', extra: Record<string, string | undefined> = {}) =>
    reportExportUrl(schoolId, type, {
      academicYearId: yearId || undefined,
      ...extra,
    });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports & exports"
        description="Every figure is calculated from the underlying rows at request time. CSV exports contain the same data you see here, scoped to your permissions."
      />

      <div className="flex flex-wrap items-end gap-4">
        <Field label="Academic year" htmlFor="report-year">
          <Select
            id="report-year"
            value={yearId}
            onChange={(event) => {
              const year = years.data?.items.find((entry) => entry.id === event.target.value);
              setYearId(event.target.value);
              if (year) {
                setFrom(year.startsOn);
                setTo(year.endsOn);
              }
            }}
            className="min-w-48"
          >
            {years.data?.items.map((year) => (
              <option key={year.id} value={year.id}>
                {year.name}
                {year.status === 'active' ? ' (active)' : ''}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Attendance from" htmlFor="report-from">
          <Input
            id="report-from"
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
        </Field>
        <Field label="Attendance to" htmlFor="report-to">
          <Input
            id="report-to"
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
        </Field>
      </div>

      <Card>
        <CardHeader
          title="Attendance summary"
          description="Attendance rate counts present and late as full days and half days as half: (present + late + 0.5 × half_day) ÷ marked days. Excused days count as marked but not attended."
          actions={
            <LinkButton
              variant="secondary"
              href={exportHref('attendance', { from: from || undefined, to: to || undefined })}
              download
            >
              Export attendance CSV
            </LinkButton>
          }
        />
        {attendance.isPending ? (
          <TableSkeleton rows={5} columns={8} />
        ) : attendance.isError ? (
          <ErrorState message={errorMessage(attendance.error)} onRetry={() => void attendance.refetch()} />
        ) : attendance.data.sections.length === 0 ? (
          <EmptyState
            title="No attendance recorded"
            description={`No register has been marked between ${formatDate(attendance.data.from)} and ${formatDate(attendance.data.to)} for the sections you can see.`}
            icon="calendar"
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Class</th>
                  <th>Section</th>
                  <th className="text-right">Marked</th>
                  <th className="text-right">Present</th>
                  <th className="text-right">Absent</th>
                  <th className="text-right">Late</th>
                  <th className="text-right">Half day</th>
                  <th className="text-right">Excused</th>
                  <th className="text-right">Rate</th>
                </tr>
              </thead>
              <tbody>
                {attendance.data.sections.map((section) => (
                  <tr key={section.sectionId}>
                    <td className="font-medium text-slate-900">{section.className}</td>
                    <td>{section.sectionName}</td>
                    <td className="text-right tabular-nums">{section.totalMarked}</td>
                    <td className="text-right tabular-nums">{section.present}</td>
                    <td className="text-right tabular-nums">{section.absent}</td>
                    <td className="text-right tabular-nums">{section.late}</td>
                    <td className="text-right tabular-nums">{section.halfDay}</td>
                    <td className="text-right tabular-nums">{section.excused}</td>
                    <td className="text-right tabular-nums font-medium">
                      {section.attendanceRate.toFixed(1)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Fees by head"
          description="Charged uses each charge's gross amount; collected is all recorded payment allocations; outstanding equals charged minus concession minus collected plus approved refunds."
          actions={
            <LinkButton variant="secondary" href={exportHref('fees')} download>
              Export fee ledger CSV
            </LinkButton>
          }
        />
        {fees.isPending ? (
          <TableSkeleton rows={4} columns={4} />
        ) : fees.isError ? (
          <ErrorState message={errorMessage(fees.error)} onRetry={() => void fees.refetch()} />
        ) : fees.data.byHead.length === 0 ? (
          <EmptyState title="No fee charges" description="Generate charges to populate this report." icon="clipboard" />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Fee head</th>
                  <th className="text-right">Charged</th>
                  <th className="text-right">Collected</th>
                  <th className="text-right">Outstanding</th>
                </tr>
              </thead>
              <tbody>
                {fees.data.byHead.map((head) => (
                  <tr key={head.feeHeadId}>
                    <td className="font-medium text-slate-900">{head.feeHeadName}</td>
                    <td className="text-right tabular-nums">{formatMoney(head.charged)}</td>
                    <td className="text-right tabular-nums">{formatMoney(head.collected)}</td>
                    <td className="text-right tabular-nums">{formatMoney(head.outstanding)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Fees by class" description="The same ledger totals grouped by class." />
          {fees.isPending ? (
            <TableSkeleton rows={4} columns={4} />
          ) : fees.isError ? (
            <ErrorState message={errorMessage(fees.error)} onRetry={() => void fees.refetch()} />
          ) : fees.data.byClass.length === 0 ? (
            <EmptyState title="No class data" description="Charges grouped by class appear here." icon="layers" />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Class</th>
                    <th className="text-right">Charged</th>
                    <th className="text-right">Collected</th>
                    <th className="text-right">Outstanding</th>
                  </tr>
                </thead>
                <tbody>
                  {fees.data.byClass.map((klass) => (
                    <tr key={klass.classId}>
                      <td className="font-medium text-slate-900">{klass.className}</td>
                      <td className="text-right tabular-nums">{formatMoney(klass.charged)}</td>
                      <td className="text-right tabular-nums">{formatMoney(klass.collected)}</td>
                      <td className="text-right tabular-nums">{formatMoney(klass.outstanding)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="Collections by method" description="Receipts counted at face value, grouped by payment method." />
          {fees.isPending ? (
            <TableSkeleton rows={4} columns={3} />
          ) : fees.isError ? (
            <ErrorState message={errorMessage(fees.error)} onRetry={() => void fees.refetch()} />
          ) : fees.data.byMethod.length === 0 ? (
            <EmptyState title="No payments" description="Record a receipt to populate this breakdown." icon="chart" />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Method</th>
                    <th className="text-right">Receipts</th>
                    <th className="text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {fees.data.byMethod.map((method) => (
                    <tr key={method.method}>
                      <td className="font-medium capitalize text-slate-900">
                        {method.method.replace(/_/g, ' ')}
                      </td>
                      <td className="text-right tabular-nums">{method.count}</td>
                      <td className="text-right tabular-nums">{formatMoney(method.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Student roster export"
          description="A flat roster of enrolled students for the selected academic year."
        />
        <div className="space-y-3 px-5 pb-5">
          <LinkButton variant="secondary" href={exportHref('students')} download>
            Export students CSV
          </LinkButton>
          <Alert tone="info">
            Exports use your current scope: a teacher receives only the sections they can see, and
            the file is generated on the server so it always matches the database.
          </Alert>
          <p className="text-xs text-slate-400">
            Generated {formatDate(todayIso(timeZone))} · times use the school timezone.
          </p>
        </div>
      </Card>
    </div>
  );
}
