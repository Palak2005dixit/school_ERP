export const STUDENT_STATUSES = [
  'applicant',
  'active',
  'withdrawn',
  'graduated',
  'transferred',
  'inactive',
] as const;

export const GUARDIAN_PORTAL_STATUSES = ['pending', 'verified', 'revoked'] as const;

export const ATTENDANCE_STATUSES = [
  { value: 'present', label: 'Present' },
  { value: 'absent', label: 'Absent' },
  { value: 'late', label: 'Late' },
  { value: 'half_day', label: 'Half day' },
  { value: 'excused', label: 'Excused' },
] as const;

export function attendanceLabel(value: string | null | undefined): string {
  if (!value) return 'Not marked';
  return ATTENDANCE_STATUSES.find((entry) => entry.value === value)?.label ?? value;
}

export const RELATIONSHIP_TYPES = [
  'mother',
  'father',
  'guardian',
  'grandparent',
  'sibling',
  'other',
] as const;
