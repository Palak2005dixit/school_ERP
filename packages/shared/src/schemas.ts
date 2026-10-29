import { z } from 'zod';

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date in YYYY-MM-DD format')
  .refine(isRealCalendarDate, 'Enter a real calendar date')
  .describe('ISO calendar date');

function isRealCalendarDate(value: string): boolean {
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day || month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1]!;
}

export const uuid = z.string().uuid('Expected a UUID');

export const nonEmptyText = (max: number) => z.string().trim().min(1, 'Required').max(max);

export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value === '' ? undefined : value));

export const email = z.string().trim().email('Enter a valid email address').max(320);

export const phone = z
  .string()
  .trim()
  .min(6, 'Enter a valid phone number')
  .max(40)
  .regex(/^[0-9+()\-\s]+$/, 'Phone may contain digits, spaces, +, -, ( and ) only');

/* ---------------------------------- auth --------------------------------- */

export const loginSchema = z.object({
  email: email,
  password: z.string().min(1, 'Password is required').max(200),
  totpCode: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit code')
    .optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z
    .string()
    .min(12, 'Use at least 12 characters')
    .max(200)
    .regex(/[a-zA-Z]/, 'Include at least one letter')
    .regex(/[0-9]/, 'Include at least one number'),
});

/* -------------------------------- academic ------------------------------- */

export const academicYearStatus = z.enum(['planned', 'active', 'closed', 'archived']);

export const academicYearInput = z.object({
  code: nonEmptyText(40),
  name: nonEmptyText(100),
  startsOn: isoDate,
  endsOn: isoDate,
  status: academicYearStatus.default('planned'),
});

export const academicYearUpdate = z.object({
  name: nonEmptyText(100).optional(),
  startsOn: isoDate.optional(),
  endsOn: isoDate.optional(),
  status: academicYearStatus.optional(),
});

export const classInput = z.object({
  code: nonEmptyText(40),
  name: nonEmptyText(100),
  gradeOrder: z.coerce.number().int().min(0).max(100).nullable().optional(),
  status: z.enum(['active', 'inactive']).default('active'),
});

// Update schemas are written out explicitly instead of using `.partial()` on an
// input schema. Zod applies a field default even when the key is absent, so a
// `.partial()` clone would silently reset omitted fields (e.g. a status change
// would flip `status` back to 'active').
export const classUpdate = z.object({
  code: nonEmptyText(40).optional(),
  name: nonEmptyText(100).optional(),
  gradeOrder: z.coerce.number().int().min(0).max(100).nullable().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

export const sectionInput = z.object({
  academicYearId: uuid,
  classId: uuid,
  code: nonEmptyText(40),
  name: nonEmptyText(100),
  capacity: z.coerce.number().int().min(0).max(10000).nullable().optional(),
  status: z.enum(['active', 'inactive']).default('active'),
});

export const sectionUpdate = z.object({
  code: nonEmptyText(40).optional(),
  name: nonEmptyText(100).optional(),
  capacity: z.coerce.number().int().min(0).max(10000).nullable().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

export const subjectInput = z.object({
  code: nonEmptyText(40),
  name: nonEmptyText(120),
  subjectType: nonEmptyText(30).default('academic'),
  status: z.enum(['active', 'inactive']).default('active'),
});

export const subjectUpdate = z.object({
  code: nonEmptyText(40).optional(),
  name: nonEmptyText(120).optional(),
  subjectType: nonEmptyText(30).optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

/* -------------------------------- students ------------------------------- */

export const studentStatus = z.enum([
  'applicant',
  'active',
  'withdrawn',
  'graduated',
  'transferred',
  'inactive',
]);

export const guardianInput = z.object({
  firstName: nonEmptyText(100),
  lastName: optionalText(100),
  email: email.optional(),
  phone: phone.optional(),
  relationshipType: nonEmptyText(40),
  isPrimary: z.boolean().default(false),
  portalAccessStatus: z.enum(['pending', 'verified', 'revoked']).default('pending'),
});

export const studentAdmissionInput = z.object({
  admissionNumber: optionalText(60),
  firstName: nonEmptyText(100),
  middleName: optionalText(100),
  lastName: optionalText(100),
  dateOfBirth: isoDate.optional(),
  academicYearId: uuid,
  sectionId: uuid,
  startsOn: isoDate,
  guardians: z.array(guardianInput).min(1, 'At least one guardian is required').max(5),
});

export const studentUpdate = z.object({
  firstName: nonEmptyText(100).optional(),
  middleName: optionalText(100),
  lastName: optionalText(100),
  dateOfBirth: isoDate.nullable().optional(),
  status: studentStatus.optional(),
});

export const enrollmentInput = z.object({
  academicYearId: uuid,
  sectionId: uuid,
  startsOn: isoDate,
});

/* ------------------------------- attendance ------------------------------- */

export const attendanceStatus = z.enum(['present', 'absent', 'late', 'half_day', 'excused']);

export const attendanceRegisterQuery = z.object({
  sectionId: uuid,
  date: isoDate,
});

export const attendanceEntryInput = z.object({
  studentId: uuid,
  status: attendanceStatus,
  note: optionalText(500),
});

export const attendanceRegisterInput = z.object({
  sectionId: uuid,
  date: isoDate,
  entries: z
    .array(attendanceEntryInput)
    .min(1, 'Mark at least one student')
    .max(500, 'A section register cannot exceed 500 entries'),
});

export const attendanceCorrectionInput = z.object({
  attendanceId: uuid,
  requestedStatus: attendanceStatus,
  reason: z.string().trim().min(5, 'Give a short reason (at least 5 characters)').max(500),
});

export const attendanceReviewInput = z.object({
  decision: z.enum(['approve', 'reject']),
  note: optionalText(500),
});

/* -------------------------------- timetable ------------------------------- */

export const clockTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Use a 24-hour time like 09:00');

export const timetablePeriodInput = z.object({
  academicYearId: uuid,
  name: nonEmptyText(60),
  sequenceNo: z.coerce.number().int().min(1).max(30),
  startsAt: clockTime,
  endsAt: clockTime,
  isBreak: z.boolean().default(false),
});

export const timetablePeriodUpdate = z.object({
  name: nonEmptyText(60).optional(),
  sequenceNo: z.coerce.number().int().min(1).max(30).optional(),
  startsAt: clockTime.optional(),
  endsAt: clockTime.optional(),
  isBreak: z.boolean().optional(),
});

export const roomInput = z.object({
  code: nonEmptyText(40),
  name: nonEmptyText(120),
  capacity: z.coerce.number().int().min(0).max(10000).nullable().optional(),
  status: z.enum(['active', 'inactive']).default('active'),
});

export const roomUpdate = z.object({
  code: nonEmptyText(40).optional(),
  name: nonEmptyText(120).optional(),
  capacity: z.coerce.number().int().min(0).max(10000).nullable().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

export const timetableSlotInput = z.object({
  academicYearId: uuid,
  sectionId: uuid,
  periodId: uuid,
  dayOfWeek: z.coerce.number().int().min(1).max(7),
  subjectId: uuid,
  teacherUserId: uuid,
  roomId: uuid.nullable().optional(),
});

/* ---------------------------------- fees ---------------------------------- */

export const feeHeadInput = z.object({
  code: nonEmptyText(40),
  name: nonEmptyText(120),
  description: optionalText(500),
  status: z.enum(['active', 'inactive']).default('active'),
});

export const feeHeadUpdate = z.object({
  code: nonEmptyText(40).optional(),
  name: nonEmptyText(120).optional(),
  description: optionalText(500),
  status: z.enum(['active', 'inactive']).optional(),
});

export const money = z.coerce
  .number()
  .finite('Enter a valid amount')
  .min(0, 'Amount cannot be negative')
  .max(99999999.99, 'Amount is too large');

export const positiveMoney = money.refine((value) => value > 0, 'Amount must be greater than zero');

export const feeStructureInput = z.object({
  academicYearId: uuid,
  classId: uuid,
  feeHeadId: uuid,
  amount: money,
  dueOn: isoDate.optional(),
});

export const feeStructureUpdate = z.object({
  amount: money.optional(),
  dueOn: isoDate.nullable().optional(),
});

export const chargeGenerateInput = z.object({
  academicYearId: uuid,
  sectionId: uuid,
  dueOn: isoDate,
  feeHeadIds: z.array(uuid).max(20).optional(),
});

export const chargeInput = z.object({
  studentId: uuid,
  academicYearId: uuid,
  feeHeadId: uuid,
  description: nonEmptyText(200),
  amount: money,
  concessionAmount: money.default(0),
  concessionReason: optionalText(500),
  dueOn: isoDate,
});

export const chargeUpdate = z.object({
  description: nonEmptyText(200).optional(),
  concessionAmount: money.optional(),
  concessionReason: optionalText(500),
  dueOn: isoDate.optional(),
});

export const paymentMethod = z.enum([
  'cash',
  'bank_transfer',
  'card',
  'upi',
  'cheque',
  'other',
]);

export const paymentInput = z.object({
  studentId: uuid,
  academicYearId: uuid,
  amount: positiveMoney,
  method: paymentMethod,
  reference: optionalText(120),
  paidOn: isoDate,
  notes: optionalText(500),
  allocations: z
    .array(z.object({ chargeId: uuid, amount: positiveMoney }))
    .max(50)
    .optional(),
});

export const refundInput = z.object({
  paymentId: uuid,
  amount: positiveMoney,
  reason: z.string().trim().min(5, 'Give a short reason (at least 5 characters)').max(500),
});

export const refundReviewInput = z.object({
  decision: z.enum(['approve', 'reject']),
  note: optionalText(500),
});

/* ---------------------------------- exams --------------------------------- */

export const examInput = z.object({
  academicYearId: uuid,
  name: nonEmptyText(120),
  examType: nonEmptyText(40).default('term'),
  startsOn: isoDate,
  endsOn: isoDate,
  gradingSchemeId: uuid,
  passPercent: z.coerce.number().min(0).max(100).default(35),
});

export const examUpdate = z.object({
  name: nonEmptyText(120).optional(),
  examType: nonEmptyText(40).optional(),
  startsOn: isoDate.optional(),
  endsOn: isoDate.optional(),
  gradingSchemeId: uuid.optional(),
  passPercent: z.coerce.number().min(0).max(100).optional(),
});

export const examSubjectInput = z.object({
  subjectId: uuid,
  maxMarks: positiveMoney,
  passMarks: money,
});

export const markEntryInput = z.object({
  examSubjectId: uuid,
  sectionId: uuid,
  entries: z
    .array(
      z.object({
        studentId: uuid,
        marksObtained: money.nullable(),
        isAbsent: z.boolean().default(false),
      }),
    )
    .min(1, 'Enter at least one result')
    .max(500),
});

/* ---------------------------------- staff --------------------------------- */

export const staffInput = z.object({
  userId: uuid.nullable().optional(),
  employeeNumber: optionalText(40),
  firstName: nonEmptyText(100),
  lastName: optionalText(100),
  email: email.optional(),
  phone: phone.optional(),
  designation: nonEmptyText(120),
  department: optionalText(120),
  joinedOn: isoDate.optional(),
  status: z.enum(['active', 'on_leave', 'inactive', 'left']).default('active'),
});

export const staffUpdate = z.object({
  userId: uuid.nullable().optional(),
  employeeNumber: optionalText(40),
  firstName: nonEmptyText(100).optional(),
  lastName: optionalText(100),
  email: email.optional(),
  phone: phone.optional(),
  designation: nonEmptyText(120).optional(),
  department: optionalText(120),
  joinedOn: isoDate.optional(),
  status: z.enum(['active', 'on_leave', 'inactive', 'left']).optional(),
});

export const salaryInput = z.object({
  amount: money,
  currency: z.string().trim().length(3).toUpperCase().default('INR'),
  effectiveFrom: isoDate,
  notes: optionalText(500),
});

export const leaveInput = z.object({
  staffId: uuid.optional(),
  leaveType: nonEmptyText(40),
  startsOn: isoDate,
  endsOn: isoDate,
  reason: z.string().trim().min(5, 'Give a short reason (at least 5 characters)').max(500),
});

export const leaveReviewInput = z.object({
  decision: z.enum(['approve', 'reject']),
  note: optionalText(500),
});

/* --------------------------------- notices -------------------------------- */

export const noticeInput = z.object({
  title: nonEmptyText(160),
  body: z.string().trim().min(5, 'Write the notice text').max(5000),
  audience: z.enum(['all', 'staff', 'parents', 'students']).default('all'),
  pinned: z.boolean().default(false),
  expiresOn: isoDate.nullable().optional(),
});

export const noticeUpdate = z.object({
  title: nonEmptyText(160).optional(),
  body: z.string().trim().min(5, 'Write the notice text').max(5000).optional(),
  audience: z.enum(['all', 'staff', 'parents', 'students']).optional(),
  pinned: z.boolean().optional(),
  expiresOn: isoDate.nullable().optional(),
  status: z.enum(['draft', 'published', 'archived']).optional(),
});

export const noticeAttachmentInput = z.object({
  filename: nonEmptyText(255),
  contentType: nonEmptyText(120),
  /** Base64-encoded bytes; the API caps the decoded size at 1 MiB. */
  dataBase64: z.string().min(1).max(1_500_000),
});

/* ---------------------------------- users --------------------------------- */

export const strongPassword = z
  .string()
  .min(12, 'Use at least 12 characters')
  .max(200)
  .regex(/[a-zA-Z]/, 'Include at least one letter')
  .regex(/[0-9]/, 'Include at least one number');

export const userInput = z.object({
  email: email,
  displayName: nonEmptyText(200),
  password: strongPassword,
  roleCode: nonEmptyText(60),
  scopeType: z
    .enum(['school', 'campus', 'department', 'class', 'section', 'self', 'linked_student', 'custom'])
    .optional(),
  scopeId: uuid.nullable().optional(),
});

export const roleAssignmentInput = z.object({
  roleCode: nonEmptyText(60),
  scopeType: z
    .enum(['school', 'campus', 'department', 'class', 'section', 'self', 'linked_student', 'custom'])
    .optional(),
  scopeId: uuid.nullable().optional(),
});

/* --------------------------------- common -------------------------------- */

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const studentListQuery = paginationQuery.extend({
  search: z.string().trim().max(120).optional(),
  status: studentStatus.optional(),
  classId: uuid.optional(),
  sectionId: uuid.optional(),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type AcademicYearInput = z.infer<typeof academicYearInput>;
export type AcademicYearUpdate = z.infer<typeof academicYearUpdate>;
export type ClassInput = z.infer<typeof classInput>;
export type ClassUpdate = z.infer<typeof classUpdate>;
export type SectionInput = z.infer<typeof sectionInput>;
export type SectionUpdate = z.infer<typeof sectionUpdate>;
export type SubjectInput = z.infer<typeof subjectInput>;
export type SubjectUpdate = z.infer<typeof subjectUpdate>;
export type GuardianInput = z.infer<typeof guardianInput>;
export type StudentAdmissionInput = z.infer<typeof studentAdmissionInput>;
export type StudentUpdate = z.infer<typeof studentUpdate>;
export type EnrollmentInput = z.infer<typeof enrollmentInput>;
export type AttendanceStatus = z.infer<typeof attendanceStatus>;
export type AttendanceRegisterInput = z.infer<typeof attendanceRegisterInput>;
export type AttendanceCorrectionInput = z.infer<typeof attendanceCorrectionInput>;
export type AttendanceReviewInput = z.infer<typeof attendanceReviewInput>;
export type StudentListQuery = z.infer<typeof studentListQuery>;

/* ------------------------------ pending features --------------------------- */

export const passwordForgotSchema = z.object({
  email,
});

export const passwordResetSchema = z.object({
  token: z.string().trim().min(20, 'Reset token is invalid').max(200),
  newPassword: z
    .string()
    .min(12, 'Use at least 12 characters')
    .max(200)
    .regex(/[a-zA-Z]/, 'Include at least one letter')
    .regex(/[0-9]/, 'Include at least one number'),
});

export const mfaCodeSchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});

export const mfaDisableSchema = z.object({
  password: z.string().min(1).max(200),
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});

export const safeguardingCaseInput = z.object({
  studentId: uuid,
  category: z.enum(['safeguarding', 'attendance', 'wellbeing', 'medical', 'behaviour', 'other']),
  severity: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  summary: z.string().trim().min(10, 'Describe the concern').max(4000),
  openedOn: isoDate.optional(),
});

export const safeguardingCaseUpdate = z.object({
  category: z
    .enum(['safeguarding', 'attendance', 'wellbeing', 'medical', 'behaviour', 'other'])
    .optional(),
  severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  summary: z.string().trim().min(10, 'Describe the concern').max(4000).optional(),
  status: z.enum(['open', 'monitoring', 'closed']).optional(),
  closedOn: isoDate.nullable().optional(),
});

export const safeguardingNoteInput = z.object({
  note: z.string().trim().min(1, 'Write a note').max(4000),
});

export const leaveTypeInput = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9_]+$/, 'Use lowercase letters, numbers and underscores'),
  name: nonEmptyText(120),
  annualQuotaDays: z.coerce.number().min(0).max(366).default(0),
  paid: z.boolean().default(true),
  active: z.boolean().default(true),
});

export const holidayInput = z.object({
  name: nonEmptyText(120),
  holidayOn: isoDate,
  academicYearId: uuid.optional(),
  notes: optionalText(500),
});

export const payrollRunInput = z.object({
  periodStart: isoDate,
  periodEnd: isoDate,
  notes: optionalText(500),
  deductions: z
    .array(z.object({ staffId: uuid, amount: money }))
    .max(500)
    .optional(),
});

export const payrollPayInput = z.object({
  paidOn: isoDate,
});

export const lateFeeRuleInput = z.object({
  name: nonEmptyText(120),
  graceDays: z.coerce.number().int().min(0).max(365).default(0),
  percentPerMonth: z.coerce.number().min(0).max(100).default(0),
  maxAmount: money.default(0),
  active: z.boolean().default(true),
});

export const lateFeeRunInput = z.object({
  ruleId: uuid,
  asOf: isoDate.optional(),
  academicYearId: uuid.optional(),
});

export const installmentPlanInput = z.object({
  items: z
    .array(
      z.object({
        sequence: z.coerce.number().int().min(1).max(24),
        label: nonEmptyText(80),
        percent: z.coerce.number().gt(0).max(100),
        dueOn: isoDate,
      }),
    )
    .min(1)
    .max(24),
});

export const studentImportInput = z.object({
  academicYearId: uuid,
  csv: z.string().min(1, 'Paste or upload a CSV file').max(1_000_000),
});
