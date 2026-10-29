import type { Paginated } from '@erp/shared';
import { AppError } from './errors';

export function toNumber(value: unknown): number {
  return Number(value ?? 0);
}

export function toIsoDate(value: unknown): string {
  if (value instanceof Date) {
    // node-postgres parses a DATE as local midnight. Formatting from UTC would
    // move the calendar day backwards in positive-offset timezones, so read the
    // local components the database value was parsed into.
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  return String(value);
}

export function toIsoDateTime(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function pageMeta(
  total: number,
  page: number,
  pageSize: number,
): Omit<Paginated<never>, 'items'> {
  return { total, page, pageSize };
}

export function assertDateRange(startsOn: string, endsOn: string): void {
  if (endsOn < startsOn) {
    throw new AppError(400, 'validation_error', 'Some fields need attention', {
      endsOn: ['End date must be on or after the start date'],
    });
  }
}

/**
 * Calendar date in the school's timezone. Used to reject future attendance in
 * the school's own day, not the server's UTC day.
 */
export function todayInTimeZone(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone,
  }).format(new Date());
}
