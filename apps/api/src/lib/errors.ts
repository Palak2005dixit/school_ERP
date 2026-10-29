import type { ZodType } from 'zod';
import { ZodError } from 'zod';

/**
 * Application error with an HTTP status and a stable machine-readable code.
 * Messages are safe for end users; internal details never reach the client.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, string[]>;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function badRequest(message: string, details?: Record<string, string[]>): AppError {
  return new AppError(400, 'invalid_request', message, details);
}

export function unauthorized(message = 'Sign in to continue'): AppError {
  return new AppError(401, 'unauthenticated', message);
}

export function forbidden(message = 'You do not have permission to do that'): AppError {
  return new AppError(403, 'forbidden', message);
}

export function notFound(message = 'Record not found'): AppError {
  return new AppError(404, 'not_found', message);
}

export function conflict(message: string, code = 'conflict'): AppError {
  return new AppError(409, code, message);
}

export function unprocessable(message: string, details?: Record<string, string[]>): AppError {
  return new AppError(422, 'unprocessable', message, details);
}

export function parseInput<T>(schema: ZodType<T>, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      const details: Record<string, string[]> = {};
      for (const issue of error.issues) {
        const key = issue.path.length > 0 ? issue.path.join('.') : '_';
        (details[key] ??= []).push(issue.message);
      }
      throw new AppError(400, 'validation_error', 'Some fields need attention', details);
    }
    throw error;
  }
}

/** Maps PostgreSQL constraint errors to safe, actionable API errors. */
export function mapDatabaseError(error: unknown): AppError | null {
  const pgError = error as { code?: string; constraint?: string; message?: string };
  switch (pgError.code) {
    case '23505':
      return conflict(duplicateMessage(pgError.constraint), 'duplicate');
    case '23503':
      return badRequest('A referenced record does not exist or belongs to another school');
    case '23514':
      return badRequest('That change violates a data rule');
    case '23P01':
      return conflict('This overlaps with an existing record');
    case '22P02':
      return badRequest('One of the identifiers is not valid');
    default:
      return null;
  }
}

function duplicateMessage(constraint: string | undefined): string {
  switch (constraint) {
    case 'uq_academic_years_school_code':
      return 'An academic year with that code already exists';
    case 'uq_academic_years_one_active':
      return 'Another academic year is already active';
    case 'uq_classes_school_code':
      return 'A class with that code already exists';
    case 'uq_sections_year_class_code':
      return 'That class already has a section with this code';
    case 'uq_subjects_school_code':
      return 'A subject with that code already exists';
    case 'uq_students_school_admission':
      return 'That admission number is already in use';
    case 'uq_student_guardians_pair':
      return 'That guardian is already linked to this student';
    case 'uq_enrollments_one_active_student_year':
      return 'The student already has an active enrollment for this academic year';
    case 'uq_role_assignments_active':
      return 'That role assignment already exists';
    case 'uq_attendance_corrections_pending':
      return 'A correction is already awaiting review for this attendance record';
    case 'uq_rooms_school_code':
      return 'A room with that code already exists';
    case 'uq_timetable_periods_year_sequence':
      return 'A period with that sequence already exists for this academic year';
    case 'uq_timetable_slots_section_cell':
      return 'This section already has a lesson in that period';
    case 'uq_timetable_slots_teacher':
      return 'That teacher is already teaching in this period';
    case 'uq_timetable_slots_room':
      return 'That room is already in use in this period';
    case 'uq_fee_heads_school_code':
      return 'A fee head with that code already exists';
    case 'uq_fee_structures_year_class_head':
      return 'That class already has a fee structure for this head and year';
    case 'uq_student_charges_student_year_head':
      return 'This student already has a charge for that fee head and year';
    case 'uq_payments_school_receipt':
      return 'That receipt number is already in use';
    case 'uq_refunds_pending_payment':
      return 'A refund is already pending for this payment';
    case 'uq_grading_schemes_school_code':
      return 'A grading scheme with that code already exists';
    case 'uq_grading_schemes_one_default':
      return 'Another grading scheme is already the default';
    case 'uq_grading_bands_scheme_grade':
      return 'That grade already exists in this scheme';
    case 'uq_exams_year_name':
      return 'An exam with that name already exists for this academic year';
    case 'uq_exam_subjects_pair':
      return 'That subject is already part of this exam';
    case 'uq_staff_school_employee':
      return 'That employee number is already in use';
    case 'uq_staff_school_user':
      return 'That user account is already linked to a staff record';
    case 'uq_users_email_ci':
      return 'An account with that email already exists';
    default:
      return 'That record already exists';
  }
}
