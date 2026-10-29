import { useQuery } from '@tanstack/react-query';
import { Link, Navigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth, useSchoolId } from '../auth/AuthContext';
import { getOverview } from '../lib/endpoints';
import { errorMessage } from '../lib/api';
import { formatDate, formatDateTime } from '../lib/format';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  Icon,
  PageHeader,
  StatCard,
  TableSkeleton,
} from '../components/ui';

export function DashboardPage(): ReactNode {
  const { can, user, membership } = useAuth();
  const schoolId = useSchoolId();

  const overview = useQuery({
    queryKey: ['overview', schoolId],
    queryFn: () => getOverview(schoolId),
    enabled: can('school.view'),
  });

  if (!can('students.profile.view')) {
    if (can('guardian.student.view')) return <Navigate to="/portal" replace />;
    return (
      <Card className="p-8 text-center">
        <p className="text-sm font-semibold text-slate-900">Welcome, {user?.displayName}</p>
        <p className="mt-1 text-sm text-slate-500">
          Your account is signed in, but no workspace modules are enabled for your role yet.
        </p>
      </Card>
    );
  }

  if (overview.isPending) {
    return (
      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Card key={index} className="h-28 animate-pulse bg-white">
            <span className="sr-only">Loading</span>
          </Card>
          ))}
        </div>
        <Card>
          <TableSkeleton rows={4} columns={2} />
        </Card>
      </div>
    );
  }

  if (overview.isError) {
    return <ErrorState message={errorMessage(overview.error)} onRetry={() => void overview.refetch()} />;
  }

  const data = overview.data;
  const capacityUsed = data.studentsByClass.reduce((sum, entry) => sum + entry.count, 0);
  const largestClass = Math.max(1, ...data.studentsByClass.map((entry) => entry.count));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overview"
        description={
          <>
            Live figures for {membership?.schoolName}. Counts are scoped to the sections your role can
            see and exclude inactive records.
          </>
        }
        actions={
          <>
            {can('students.admission.create') && (
              <Link to="/students/new">
                <Button>
                  <Icon name="plus" className="h-4 w-4" />
                  New admission
                </Button>
              </Link>
            )}
            <Link to="/students">
              <Button variant="secondary">View students</Button>
            </Link>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Active students"
          value={data.studentsActive}
          hint={
            data.activeAcademicYear
              ? `For ${data.activeAcademicYear.name}`
              : 'No active academic year'
          }
          icon="users"
        />
        <StatCard label="Classes" value={data.classes} hint="Active classes" icon="layers" />
        <StatCard
          label="Sections"
          value={data.sections}
          hint={data.activeAcademicYear ? 'In the active year' : 'Across all years'}
          icon="home"
        />
        <StatCard
          label="Pending guardian links"
          value={data.pendingGuardianLinks}
          hint="Waiting for verification"
          icon="shield"
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.15fr_1fr]">
        <Card>
          <CardHeader
            title="Students by class"
            description={
              data.activeAcademicYear
                ? `${data.activeAcademicYear.name} · ${formatDate(data.activeAcademicYear.startsOn)} – ${formatDate(data.activeAcademicYear.endsOn)}`
                : 'No academic year is currently active'
            }
            actions={<Badge tone="brand">{capacityUsed} enrolled</Badge>}
          />
          {data.studentsByClass.length === 0 ? (
            <EmptyState
              title="No active enrollments"
              description="Admit a student or activate an academic year to see class distribution here."
              icon="chart"
              action={
                can('students.admission.create') ? (
                  <Link to="/students/new">
                    <Button size="sm">Start an admission</Button>
                  </Link>
                ) : undefined
              }
            />
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.studentsByClass.map((entry) => (
                <li key={entry.classId} className="flex items-center gap-3 px-5 py-3">
                  <span className="w-24 shrink-0 text-sm font-medium text-slate-700">
                    {entry.className}
                  </span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full bg-brand-500"
                      style={{ width: `${Math.round((entry.count / largestClass) * 100)}%` }}
                    />
                  </div>
                  <span className="w-8 text-right text-sm tabular-nums text-slate-600">
                    {entry.count}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Recent activity"
            description="Derived from audited domain actions"
            actions={
              can('audit.view') ? (
                <Link to="/audit" className="text-xs font-medium text-brand-700 hover:underline">
                  Open audit log
                </Link>
              ) : undefined
            }
          />
          {data.recentActivity.length === 0 ? (
            <EmptyState
              title="Nothing recorded yet"
              description="Admissions, structure changes and logins will appear here as they happen."
              icon="clipboard"
            />
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.recentActivity.map((event) => (
                <li key={event.id} className="flex gap-3 px-5 py-3">
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500">
                    <Icon name="clipboard" className="h-3.5 w-3.5" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm text-slate-800">{event.summary}</p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {event.actorName ?? 'System'} · {formatDateTime(event.occurredAt, membership?.timezone)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <QuickLink
          to="/academic/years"
          title="Academic years"
          description="Open, close or activate a year"
          icon="calendar"
        />
        <QuickLink
          to="/academic/sections"
          title="Sections"
          description="Capacity and enrollment per section"
          icon="home"
        />
        <QuickLink
          to="/students"
          title="Student records"
          description="Search admissions and guardians"
          icon="users"
        />
      </div>
    </div>
  );
}

function QuickLink({
  to,
  title,
  description,
  icon,
}: {
  to: string;
  title: string;
  description: string;
  icon: 'calendar' | 'home' | 'users';
}): ReactNode {
  return (
    <Link
      to={to}
      className="group flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-brand-200 hover:shadow-md"
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
        <Icon name={icon} />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-slate-900 group-hover:text-brand-700">
          {title}
        </span>
        <span className="mt-0.5 block text-xs text-slate-500">{description}</span>
      </span>
    </Link>
  );
}
