export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

/**
 * Formats an instant in the school's configured timezone (falling back to the
 * viewer's timezone when the school is not loaded yet).
 */
export function formatDateTime(value: string | null | undefined, timeZone?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
}

export function fullName(
  first: string | null | undefined,
  middle: string | null | undefined,
  last: string | null | undefined,
): string {
  return [first, middle, last]
    .map((part) => (part ?? '').trim())
    .filter(Boolean)
    .join(' ');
}

export function todayIso(timeZone?: string): string {
  if (timeZone) {
    // en-CA renders as YYYY-MM-DD; avoids a UTC date shifting a day for schools
    // east or west of UTC.
    return new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone,
    }).format(new Date());
  }
  return new Date().toISOString().slice(0, 10);
}

export function titleCase(value: string): string {
  return value
    .replace(/[._]/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function roleLabel(code: string): string {
  const labels: Record<string, string> = {
    main_admin: 'Main Administrator',
    academic_coordinator: 'Academic Coordinator',
    teacher: 'Teacher',
    finance: 'Finance',
    parent: 'Parent',
    student: 'Student',
    auditor: 'Auditor',
  };
  return labels[code] ?? titleCase(code);
}

export function formatClock(value: string | null | undefined): string {
  if (!value) return '—';
  return value.slice(0, 5);
}

/** Human-readable file size for attachment lists. */
export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Renders an exact numeric amount for display. Values are stored as NUMERIC in
 * the database; this helper only formats them for the viewer.
 */
export function formatMoney(value: number | null | undefined, currency = 'INR'): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}
