import type { ReactNode } from 'react';
import { Badge } from './ui';

export function StudentStatusBadge({ status }: { status: string }): ReactNode {
  const tone =
    status === 'active'
      ? 'success'
      : status === 'applicant'
        ? 'info'
        : status === 'withdrawn' || status === 'inactive'
          ? 'danger'
          : 'neutral';
  return <Badge tone={tone}>{status}</Badge>;
}

export function GuardianStatusBadge({ status }: { status: string }): ReactNode {
  const tone = status === 'verified' ? 'success' : status === 'pending' ? 'warning' : 'danger';
  return <Badge tone={tone}>{status}</Badge>;
}

export function AttendanceStatusBadge({ status }: { status: string | null }): ReactNode {
  if (!status) return <Badge tone="neutral">Not marked</Badge>;
  const tone =
    status === 'present'
      ? 'success'
      : status === 'absent'
        ? 'danger'
        : status === 'late' || status === 'half_day'
          ? 'warning'
          : status === 'excused'
            ? 'info'
            : 'neutral';
  const label: Record<string, string> = {
    present: 'Present',
    absent: 'Absent',
    late: 'Late',
    half_day: 'Half day',
    excused: 'Excused',
  };
  return <Badge tone={tone}>{label[status] ?? status}</Badge>;
}

export function CorrectionStatusBadge({ status }: { status: string }): ReactNode {
  const tone = status === 'approved' ? 'success' : status === 'rejected' ? 'danger' : 'warning';
  return <Badge tone={tone}>{status === 'pending' ? 'Awaiting review' : status}</Badge>;
}
