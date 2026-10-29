/**
 * Contracts for the extended operational modules.
 *
 * Every request schema is validated by the API with `parseInput`, and every
 * response type here is what the web client receives. Keeping both next to each
 * other makes a field rename a compile error instead of a runtime surprise.
 */
import { z } from 'zod';
import {
  email,
  isoDate,
  money,
  nonEmptyText,
  optionalText,
  phone,
  positiveMoney,
  paginationQuery,
  uuid,
} from './schemas';

/* ------------------------------- primitives ------------------------------- */

export const listQuery = paginationQuery.extend({
  search: z.string().trim().max(120).optional(),
});

export const timeOfDay = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time such as 08:30');

export type StaffAttendanceStatus =
  | 'present'
  | 'late'
  | 'absent'
  | 'half_day'
  | 'leave'
  | 'excused'
  | 'missing_punch';

/* ----------------------------- staff attendance --------------------------- */

export interface StaffShift {
  id: string;
  code: string;
  name: string;
  startsAt: string;
  endsAt: string;
  graceMinutes: number;
  breakMinutes: number;
  active: boolean;
}

export interface StaffAttendanceRecord {
  id: string;
  staffId: string;
  staffName: string;
  employeeNumber: string;
  shiftId: string | null;
  shiftName: string | null;
  workDate: string;
  punchIn: string | null;
  punchOut: string | null;
  status: StaffAttendanceStatus;
  lateMinutes: number;
  earlyDepartureMinutes: number;
  overtimeMinutes: number;
  note: string | null;
  pendingCorrection: boolean;
}

export interface StaffAttendanceSummary {
  from: string;
  to: string;
  present: number;
  absent: number;
  late: number;
  leave: number;
  missingPunch: number;
  averageMinutes: number;
  staff: Array<{
    staffId: string;
    staffName: string;
    daysMarked: number;
    present: number;
    absent: number;
    late: number;
    leave: number;
    overtimeMinutes: number;
  }>;
}

export interface StaffAttendanceCorrection {
  id: string;
  attendanceId: string;
  staffName: string;
  workDate: string;
  currentStatus: StaffAttendanceStatus;
  requestedStatus: StaffAttendanceStatus | null;
  requestedPunchIn: string | null;
  requestedPunchOut: string | null;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  requestedByName: string | null;
  requestedAt: string;
  reviewedByName: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
}

export interface StaffAttendanceSettings {
  fullDayMinutes: number;
  halfDayMinutes: number;
  overtimeAfterMinutes: number;
  active: boolean;
}

export const staffShiftInput = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9_-]+$/, 'Use lowercase letters, numbers, _ or -'),
  name: nonEmptyText(120),
  startsAt: timeOfDay,
  endsAt: timeOfDay,
  graceMinutes: z.coerce.number().int().min(0).max(240).default(10),
  breakMinutes: z.coerce.number().int().min(0).max(240).default(0),
  active: z.boolean().default(true),
});

export const staffShiftUpdate = staffShiftInput.partial();

export const staffAttendanceInput = z.object({
  staffId: uuid,
  workDate: isoDate,
  shiftId: uuid.nullable().optional(),
  punchIn: z.string().datetime({ offset: true }).nullable().optional(),
  punchOut: z.string().datetime({ offset: true }).nullable().optional(),
  status: z
    .enum(['present', 'late', 'absent', 'half_day', 'leave', 'excused', 'missing_punch'])
    .optional(),
  note: optionalText(500),
});

export const staffAttendanceCorrectionInput = z.object({
  requestedStatus: z
    .enum(['present', 'late', 'absent', 'half_day', 'leave', 'excused', 'missing_punch'])
    .optional(),
  requestedPunchIn: z.string().datetime({ offset: true }).nullable().optional(),
  requestedPunchOut: z.string().datetime({ offset: true }).nullable().optional(),
  reason: z.string().trim().min(5, 'Give a short reason').max(500),
});

export const staffAttendanceReviewInput = z.object({
  decision: z.enum(['approve', 'reject']),
  note: optionalText(500),
});

export const staffAttendanceSettingsInput = z.object({
  fullDayMinutes: z.coerce.number().int().min(60).max(1440),
  halfDayMinutes: z.coerce.number().int().min(0).max(1440),
  overtimeAfterMinutes: z.coerce.number().int().min(0).max(600),
  active: z.boolean().default(true),
});

/* -------------------------------- recruitment ----------------------------- */

export interface Vacancy {
  id: string;
  reference: string;
  title: string;
  department: string | null;
  designation: string;
  employmentType: 'full_time' | 'part_time' | 'contract' | 'visiting';
  openings: number;
  description: string | null;
  status: 'draft' | 'open' | 'closed' | 'cancelled';
  postedOn: string | null;
  closesOn: string | null;
  candidateCount: number;
}

export interface Candidate {
  id: string;
  vacancyId: string;
  vacancyTitle: string;
  firstName: string;
  lastName: string | null;
  fullName: string;
  email: string;
  phone: string | null;
  stage: 'applied' | 'screening' | 'interview' | 'offer' | 'hired' | 'rejected' | 'withdrawn';
  source: string | null;
  appliedOn: string;
  convertedStaffId: string | null;
  interviewCount: number;
}

export interface CandidateInterview {
  id: string;
  candidateId: string;
  scheduledAt: string;
  mode: 'in_person' | 'phone' | 'video';
  interviewerUserId: string;
  interviewerName: string | null;
  status: 'scheduled' | 'completed' | 'cancelled';
  score: number | null;
  recommendation: 'strong_hire' | 'hire' | 'hold' | 'reject' | null;
  feedback: string | null;
}

export interface JobOffer {
  id: string;
  candidateId: string;
  candidateName: string;
  designation: string;
  department: string | null;
  grossSalary: number;
  currency: string;
  startsOn: string;
  status:
    | 'draft'
    | 'pending_approval'
    | 'approved'
    | 'rejected'
    | 'accepted'
    | 'declined'
    | 'cancelled';
  notes: string | null;
}

export interface OnboardingTask {
  id: string;
  staffId: string;
  staffName: string;
  title: string;
  ownerUserId: string | null;
  ownerName: string | null;
  dueOn: string | null;
  status: 'pending' | 'done' | 'cancelled';
  completedAt: string | null;
}

export interface EmployeeChange {
  id: string;
  staffId: string;
  staffName: string;
  changeType: 'transfer' | 'department' | 'designation' | 'status';
  effectiveOn: string;
  fromValue: string | null;
  toValue: string;
  notes: string | null;
}

export interface StaffSeparation {
  id: string;
  staffId: string;
  staffName: string;
  lastWorkingDay: string;
  reason: 'resignation' | 'retirement' | 'termination' | 'contract_end' | 'other';
  notes: string | null;
  status: 'initiated' | 'approved' | 'completed' | 'cancelled';
  accessRevokedAt: string | null;
  tasks: ExitTask[];
}

export interface ExitTask {
  id: string;
  separationId: string;
  title: string;
  ownerUserId: string | null;
  status: 'pending' | 'done' | 'cancelled';
  completedAt: string | null;
}

export const vacancyInput = z.object({
  reference: optionalText(40),
  title: nonEmptyText(160),
  department: optionalText(120),
  designation: nonEmptyText(120),
  employmentType: z.enum(['full_time', 'part_time', 'contract', 'visiting']).default('full_time'),
  openings: z.coerce.number().int().min(1).max(100).default(1),
  description: optionalText(4000),
  status: z.enum(['draft', 'open', 'closed', 'cancelled']).default('draft'),
  postedOn: isoDate.nullable().optional(),
  closesOn: isoDate.nullable().optional(),
});

export const vacancyUpdate = vacancyInput.partial();

export const candidateInput = z.object({
  vacancyId: uuid,
  firstName: nonEmptyText(100),
  lastName: optionalText(100),
  email,
  phone: phone.optional(),
  source: optionalText(80),
  notes: optionalText(2000),
  appliedOn: isoDate.optional(),
});

export const candidateStageInput = z.object({
  stage: z.enum(['applied', 'screening', 'interview', 'offer', 'hired', 'rejected', 'withdrawn']),
});

export const candidateInterviewInput = z.object({
  scheduledAt: z.string().datetime({ offset: true }),
  mode: z.enum(['in_person', 'phone', 'video']).default('in_person'),
  interviewerUserId: uuid,
});

export const interviewOutcomeInput = z.object({
  status: z.enum(['completed', 'cancelled']),
  score: z.coerce.number().int().min(1).max(10).optional(),
  recommendation: z.enum(['strong_hire', 'hire', 'hold', 'reject']).optional(),
  feedback: optionalText(2000),
});

export const jobOfferInput = z.object({
  candidateId: uuid,
  designation: nonEmptyText(120),
  department: optionalText(120),
  grossSalary: positiveMoney,
  currency: z.string().trim().length(3).toUpperCase().default('INR'),
  startsOn: isoDate,
  notes: optionalText(2000),
});

export const jobOfferDecisionInput = z.object({
  decision: z.enum(['submit', 'approve', 'reject', 'accept', 'decline', 'cancel']),
  note: optionalText(1000),
});

export const onboardingTaskInput = z.object({
  staffId: uuid,
  title: nonEmptyText(200),
  ownerUserId: uuid.nullable().optional(),
  dueOn: isoDate.nullable().optional(),
});

export const onboardingCompleteInput = z.object({
  status: z.enum(['done', 'cancelled', 'pending']),
});

export const employeeChangeInput = z.object({
  staffId: uuid,
  changeType: z.enum(['transfer', 'department', 'designation', 'status']),
  effectiveOn: isoDate,
  toValue: nonEmptyText(200),
  notes: optionalText(1000),
});

export const separationInput = z.object({
  staffId: uuid,
  lastWorkingDay: isoDate,
  reason: z.enum(['resignation', 'retirement', 'termination', 'contract_end', 'other']),
  notes: optionalText(2000),
  exitTasks: z.array(nonEmptyText(200)).max(30).default([]),
});

export const separationDecisionInput = z.object({
  decision: z.enum(['approve', 'reject', 'complete', 'cancel']),
  note: optionalText(1000),
});

/* -------------------------------- procurement ----------------------------- */

export interface Vendor {
  id: string;
  code: string;
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  status: 'active' | 'inactive' | 'blocked';
  openBillTotal: number;
}

export interface ProcurementBudget {
  id: string;
  academicYearId: string;
  academicYearName: string;
  code: string;
  name: string;
  department: string | null;
  allocatedAmount: number;
  spentAmount: number;
  committedAmount: number;
  availableAmount: number;
  active: boolean;
}

export interface PurchaseRequestItem {
  id: string;
  description: string;
  quantity: number;
  estimatedUnitPrice: number;
  lineTotal: number;
}

export interface PurchaseRequest {
  id: string;
  requestNumber: string;
  title: string;
  department: string | null;
  justification: string | null;
  neededBy: string | null;
  status: 'draft' | 'submitted' | 'approved' | 'rejected' | 'cancelled' | 'converted';
  requestedByName: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  items: PurchaseRequestItem[];
  total: number;
}

export interface PurchaseOrderItem {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number;
  receivedQuantity: number;
  lineTotal: number;
}

export interface PurchaseOrder {
  id: string;
  poNumber: string;
  vendorId: string;
  vendorName: string;
  requestId: string | null;
  status: 'draft' | 'issued' | 'partially_received' | 'received' | 'cancelled' | 'closed';
  orderDate: string;
  expectedOn: string | null;
  totalAmount: number;
  notes: string | null;
  approvedByName: string | null;
  items: PurchaseOrderItem[];
}

export interface VendorBill {
  id: string;
  vendorId: string;
  vendorName: string;
  poId: string | null;
  billNumber: string;
  billDate: string;
  dueOn: string | null;
  amount: number;
  status: 'recorded' | 'approved' | 'paid' | 'void';
  paidOn: string | null;
  approvedByName: string | null;
}

export interface ProcurementExpense {
  id: string;
  budgetId: string;
  budgetName: string;
  vendorName: string | null;
  description: string;
  amount: number;
  spentOn: string;
  status: 'recorded' | 'approved' | 'void';
}

export const vendorInput = z.object({
  code: optionalText(40),
  name: nonEmptyText(200),
  contactName: optionalText(160),
  email: email.optional(),
  phone: phone.optional(),
  address: optionalText(2000),
  status: z.enum(['active', 'inactive', 'blocked']).default('active'),
  notes: optionalText(1000),
});

export const vendorUpdate = vendorInput.partial();

export const budgetInput = z.object({
  academicYearId: uuid,
  code: optionalText(40),
  name: nonEmptyText(160),
  department: optionalText(120),
  allocatedAmount: money,
  active: z.boolean().default(true),
});

export const budgetUpdate = budgetInput.partial();

export const purchaseRequestInput = z.object({
  title: nonEmptyText(200),
  department: optionalText(120),
  justification: optionalText(2000),
  neededBy: isoDate.nullable().optional(),
  items: z
    .array(
      z.object({
        description: nonEmptyText(300),
        quantity: z.coerce.number().positive().max(1_000_000),
        estimatedUnitPrice: money,
      }),
    )
    .min(1)
    .max(100),
});

export const approvalDecisionInput = z.object({
  decision: z.enum(['approve', 'reject']),
  note: optionalText(1000),
});

export const purchaseOrderInput = z.object({
  vendorId: uuid,
  requestId: uuid.nullable().optional(),
  orderDate: isoDate.optional(),
  expectedOn: isoDate.nullable().optional(),
  notes: optionalText(1000),
  items: z
    .array(
      z.object({
        description: nonEmptyText(300),
        quantity: z.coerce.number().positive().max(1_000_000),
        unitPrice: money,
      }),
    )
    .min(1)
    .max(100),
});

export const goodsReceiptInput = z.object({
  poId: uuid,
  receivedOn: isoDate.optional(),
  notes: optionalText(1000),
  items: z
    .array(
      z.object({
        poItemId: uuid,
        quantity: z.coerce.number().positive().max(1_000_000),
        discrepancyNote: optionalText(1000),
      }),
    )
    .min(1)
    .max(100),
});

export const vendorBillInput = z.object({
  vendorId: uuid,
  poId: uuid.nullable().optional(),
  billNumber: nonEmptyText(80),
  billDate: isoDate,
  dueOn: isoDate.nullable().optional(),
  amount: positiveMoney,
  notes: optionalText(1000),
});

export const vendorBillPayInput = z.object({
  paidOn: isoDate,
});

export const procurementExpenseInput = z.object({
  budgetId: uuid,
  vendorId: uuid.nullable().optional(),
  poId: uuid.nullable().optional(),
  billId: uuid.nullable().optional(),
  description: nonEmptyText(300),
  amount: positiveMoney,
  spentOn: isoDate,
});

/* --------------------------------- transport ------------------------------ */

export interface TransportVehicle {
  id: string;
  registrationNumber: string;
  model: string | null;
  capacity: number;
  status: 'active' | 'maintenance' | 'retired';
  insuranceExpiresOn: string | null;
  notes: string | null;
  assignedRouteCount: number;
}

export interface TransportDriver {
  id: string;
  staffId: string | null;
  fullName: string;
  phone: string | null;
  licenceNumber: string | null;
  licenceExpiresOn: string | null;
  status: 'active' | 'inactive';
}

export interface TransportStop {
  id: string;
  routeId: string;
  name: string;
  sequenceNo: number;
  scheduledPickup: string | null;
  scheduledDrop: string | null;
  landmark: string | null;
}

export interface TransportRoute {
  id: string;
  code: string;
  name: string;
  vehicleId: string | null;
  vehicleRegistration: string | null;
  driverId: string | null;
  driverName: string | null;
  attendantName: string | null;
  feeHeadId: string | null;
  feeAmount: number | null;
  status: 'active' | 'inactive';
  notes: string | null;
  stops: TransportStop[];
  allocatedStudents: number;
  capacity: number | null;
}

export interface StudentTransportAllocation {
  id: string;
  studentId: string;
  studentName: string;
  admissionNumber: string;
  routeId: string;
  routeName: string;
  stopId: string;
  stopName: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: 'active' | 'ended';
}

export interface TransportMaintenance {
  id: string;
  vehicleId: string;
  vehicleRegistration: string;
  performedOn: string;
  description: string;
  cost: number;
  status: 'scheduled' | 'completed' | 'cancelled';
  vendorName: string | null;
}

export const vehicleInput = z.object({
  registrationNumber: nonEmptyText(40),
  model: optionalText(120),
  capacity: z.coerce.number().int().min(1).max(200),
  status: z.enum(['active', 'maintenance', 'retired']).default('active'),
  insuranceExpiresOn: isoDate.nullable().optional(),
  notes: optionalText(1000),
});

export const vehicleUpdate = vehicleInput.partial();

export const driverInput = z.object({
  staffId: uuid.nullable().optional(),
  fullName: nonEmptyText(160),
  phone: phone.optional(),
  licenceNumber: optionalText(80),
  licenceExpiresOn: isoDate.nullable().optional(),
  status: z.enum(['active', 'inactive']).default('active'),
});

export const driverUpdate = driverInput.partial();

export const transportRouteInput = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9_-]+$/, 'Use lowercase letters, numbers, _ or -'),
  name: nonEmptyText(160),
  vehicleId: uuid.nullable().optional(),
  driverId: uuid.nullable().optional(),
  attendantName: optionalText(160),
  feeHeadId: uuid.nullable().optional(),
  feeAmount: money.nullable().optional(),
  status: z.enum(['active', 'inactive']).default('active'),
  notes: optionalText(1000),
  stops: z
    .array(
      z.object({
        name: nonEmptyText(160),
        sequenceNo: z.coerce.number().int().min(1).max(100),
        scheduledPickup: timeOfDay.nullable().optional(),
        scheduledDrop: timeOfDay.nullable().optional(),
        landmark: optionalText(200),
      }),
    )
    .max(100)
    .default([]),
});

export const transportRouteUpdate = transportRouteInput.partial();

export const transportAllocationInput = z.object({
  studentId: uuid,
  routeId: uuid,
  stopId: uuid,
  effectiveFrom: isoDate.optional(),
});

export const transportAllocationEndInput = z.object({
  effectiveTo: isoDate.optional(),
});

export const transportMaintenanceInput = z.object({
  vehicleId: uuid,
  performedOn: isoDate,
  description: nonEmptyText(300),
  cost: money.default(0),
  status: z.enum(['scheduled', 'completed', 'cancelled']).default('completed'),
  vendorName: optionalText(160),
});

/* ---------------------------------- library ------------------------------- */

export interface LibraryCategory {
  id: string;
  code: string;
  name: string;
  bookCount: number;
}

export interface LibraryBook {
  id: string;
  categoryId: string | null;
  categoryName: string | null;
  title: string;
  author: string | null;
  publisher: string | null;
  isbn: string | null;
  language: string | null;
  description: string | null;
  status: 'active' | 'inactive';
  totalCopies: number;
  availableCopies: number;
}

export interface LibraryCopy {
  id: string;
  bookId: string;
  accessionNumber: string;
  status: 'available' | 'issued' | 'lost' | 'damaged' | 'retired';
  acquiredOn: string | null;
  notes: string | null;
}

export interface LibraryMember {
  id: string;
  memberCode: string;
  studentId: string | null;
  staffId: string | null;
  memberName: string;
  borrowingLimit: number;
  status: 'active' | 'suspended' | 'inactive';
  joinedOn: string;
  openLoans: number;
}

export interface LibraryLoan {
  id: string;
  copyId: string;
  accessionNumber: string;
  bookTitle: string;
  memberId: string;
  memberName: string;
  issuedOn: string;
  dueOn: string;
  returnedOn: string | null;
  renewedCount: number;
  status: 'issued' | 'returned' | 'lost';
  overdueDays: number;
}

export interface LibraryFine {
  id: string;
  loanId: string;
  memberName: string;
  bookTitle: string;
  amount: number;
  reason: 'overdue' | 'lost' | 'damaged';
  status: 'pending' | 'paid' | 'waived';
  assessedOn: string;
  paidOn: string | null;
}

export interface LibraryReservation {
  id: string;
  bookId: string;
  bookTitle: string;
  memberId: string;
  memberName: string;
  reservedOn: string;
  expiresOn: string | null;
  status: 'pending' | 'ready' | 'fulfilled' | 'cancelled' | 'expired';
}

export interface LibrarySettings {
  loanDays: number;
  finePerDay: number;
  maxRenewals: number;
  defaultBorrowingLimit: number;
}

export const libraryCategoryInput = z.object({
  code: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9_-]+$/, 'Use lowercase letters, numbers, _ or -'),
  name: nonEmptyText(120),
});

export const libraryBookInput = z.object({
  categoryId: uuid.nullable().optional(),
  title: nonEmptyText(300),
  author: optionalText(200),
  publisher: optionalText(200),
  isbn: optionalText(40),
  language: optionalText(60),
  description: optionalText(4000),
  copies: z.coerce.number().int().min(0).max(500).default(0),
  status: z.enum(['active', 'inactive']).default('active'),
});

export const libraryBookUpdate = libraryBookInput.partial();

export const libraryCopyInput = z.object({
  accessionNumber: nonEmptyText(60),
  acquiredOn: isoDate.optional(),
  notes: optionalText(500),
});

export const libraryMemberInput = z.object({
  memberCode: optionalText(60),
  studentId: uuid.nullable().optional(),
  staffId: uuid.nullable().optional(),
  borrowingLimit: z.coerce.number().int().min(1).max(50).optional(),
  status: z.enum(['active', 'suspended', 'inactive']).default('active'),
});

export const libraryLoanInput = z.object({
  copyId: uuid,
  memberId: uuid,
  dueOn: isoDate.optional(),
});

export const libraryReturnInput = z.object({
  returnedOn: isoDate.optional(),
  condition: z.enum(['ok', 'damaged', 'lost']).default('ok'),
  notes: optionalText(500),
});

export const libraryFineInput = z.object({
  loanId: uuid,
  amount: positiveMoney,
  reason: z.enum(['overdue', 'lost', 'damaged']),
  notes: optionalText(500),
});

export const libraryReservationInput = z.object({
  bookId: uuid,
  memberId: uuid,
  expiresOn: isoDate.nullable().optional(),
});

export const librarySettingsInput = z.object({
  loanDays: z.coerce.number().int().min(1).max(365),
  finePerDay: money,
  maxRenewals: z.coerce.number().int().min(0).max(10),
  defaultBorrowingLimit: z.coerce.number().int().min(1).max(50),
});

/* --------------------------------- learning ------------------------------- */

export interface LearningResource {
  id: string;
  title: string;
  description: string | null;
  resourceType: 'document' | 'link' | 'video' | 'audio' | 'image' | 'other';
  subjectId: string | null;
  subjectName: string | null;
  classId: string | null;
  className: string | null;
  url: string | null;
  visibility: 'all' | 'staff' | 'students' | 'parents';
  status: 'draft' | 'published' | 'archived';
  createdByName: string | null;
  attachments: Array<{ id: string; filename: string; contentType: string; byteSize: number }>;
}

export interface HomeworkAssignment {
  id: string;
  academicYearId: string;
  sectionId: string;
  sectionName: string;
  className: string;
  subjectId: string;
  subjectName: string;
  title: string;
  instructions: string;
  availableFrom: string | null;
  dueAt: string;
  maxMarks: number | null;
  allowResubmission: boolean;
  status: 'draft' | 'published' | 'closed';
  publishedAt: string | null;
  submissionCount: number;
  gradedCount: number;
}

export interface HomeworkSubmission {
  id: string;
  assignmentId: string;
  studentId: string;
  studentName: string;
  attempt: number;
  submittedAt: string;
  status: 'submitted' | 'late' | 'reviewed' | 'returned';
  content: string | null;
  attachmentName: string | null;
  attachmentType: string | null;
  attachmentSize: number | null;
  marks: number | null;
  feedback: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
}

export interface QuestionBankItem {
  id: string;
  subjectId: string;
  subjectName: string;
  topic: string | null;
  questionType: 'short_answer' | 'long_answer' | 'multiple_choice' | 'true_false' | 'practical';
  difficulty: 'easy' | 'medium' | 'hard';
  questionText: string;
  answerText: string | null;
  marks: number | null;
}

export const learningResourceInput = z.object({
  title: nonEmptyText(200),
  description: optionalText(4000),
  resourceType: z.enum(['document', 'link', 'video', 'audio', 'image', 'other']).default('document'),
  subjectId: uuid.nullable().optional(),
  classId: uuid.nullable().optional(),
  url: z.string().trim().url('Enter a valid URL').max(1000).optional(),
  visibility: z.enum(['all', 'staff', 'students', 'parents']).default('all'),
  status: z.enum(['draft', 'published', 'archived']).default('draft'),
});

export const learningResourceUpdate = learningResourceInput.partial();

export const learningAttachmentInput = z.object({
  filename: nonEmptyText(255),
  contentType: nonEmptyText(120),
  dataBase64: z.string().min(1).max(1_500_000),
});

export const homeworkInput = z.object({
  academicYearId: uuid,
  sectionId: uuid,
  subjectId: uuid,
  title: nonEmptyText(200),
  instructions: z.string().trim().min(5, 'Write the homework instructions').max(10_000),
  availableFrom: isoDate.nullable().optional(),
  dueAt: z.string().datetime({ offset: true }),
  maxMarks: z.coerce.number().positive().max(1000).nullable().optional(),
  allowResubmission: z.boolean().default(false),
});

export const homeworkStatusInput = z.object({
  status: z.enum(['draft', 'published', 'closed']),
});

export const homeworkSubmissionInput = z.object({
  studentId: uuid,
  content: z.string().trim().max(10_000).optional(),
  attachmentName: optionalText(255),
  attachmentType: optionalText(120),
  attachmentBase64: z.string().min(1).max(1_500_000).optional(),
});

export const homeworkReviewInput = z.object({
  status: z.enum(['reviewed', 'returned']),
  marks: z.coerce.number().min(0).max(1000).nullable().optional(),
  feedback: optionalText(4000),
});

export const questionBankInput = z.object({
  subjectId: uuid,
  topic: optionalText(160),
  questionType: z
    .enum(['short_answer', 'long_answer', 'multiple_choice', 'true_false', 'practical'])
    .default('short_answer'),
  difficulty: z.enum(['easy', 'medium', 'hard']).default('medium'),
  questionText: z.string().trim().min(5, 'Write the question').max(10_000),
  answerText: optionalText(10_000),
  marks: z.coerce.number().positive().max(1000).nullable().optional(),
});

/* --------------------------------- concerns ------------------------------- */

export interface ConcernCategory {
  id: string;
  code: string;
  name: string;
  defaultPriority: 'low' | 'medium' | 'high' | 'urgent';
  slaHours: number;
  active: boolean;
}

export interface ConcernEvent {
  id: string;
  eventType:
    | 'created'
    | 'assigned'
    | 'status_changed'
    | 'note_added'
    | 'escalated'
    | 'resolved'
    | 'reopened'
    | 'attachment_added';
  actorName: string | null;
  note: string | null;
  isInternal: boolean;
  fromStatus: string | null;
  toStatus: string | null;
  createdAt: string;
}

export interface Concern {
  id: string;
  reference: string;
  categoryId: string | null;
  categoryName: string | null;
  subject: string;
  description: string;
  requesterUserId: string;
  requesterName: string;
  requesterEmail: string | null;
  studentId: string | null;
  studentName: string | null;
  assignedTo: string | null;
  assigneeName: string | null;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  status: 'open' | 'in_progress' | 'waiting' | 'resolved' | 'closed' | 'cancelled';
  visibility: 'internal' | 'requester';
  slaDueAt: string;
  overdue: boolean;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  resolutionSummary: string | null;
  createdAt: string;
  events?: ConcernEvent[];
}

export const concernCategoryInput = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9_-]+$/, 'Use lowercase letters, numbers, _ or -'),
  name: nonEmptyText(120),
  defaultPriority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
  slaHours: z.coerce.number().int().min(1).max(8760).default(24),
  active: z.boolean().default(true),
});

export const concernInput = z.object({
  categoryId: uuid.nullable().optional(),
  subject: nonEmptyText(200),
  description: z.string().trim().min(10, 'Describe the concern').max(10_000),
  studentId: uuid.nullable().optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  visibility: z.enum(['internal', 'requester']).default('requester'),
  requesterName: optionalText(200),
  requesterEmail: email.optional(),
});

export const concernUpdateInput = z.object({
  assignedTo: uuid.nullable().optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  status: z
    .enum(['open', 'in_progress', 'waiting', 'resolved', 'closed', 'cancelled'])
    .optional(),
  visibility: z.enum(['internal', 'requester']).optional(),
  resolutionSummary: optionalText(4000),
});

export const concernNoteInput = z.object({
  note: z.string().trim().min(1, 'Write a note').max(4000),
  isInternal: z.boolean().default(true),
});

export const concernAttachmentInput = z.object({
  filename: nonEmptyText(255),
  contentType: nonEmptyText(120),
  dataBase64: z.string().min(1).max(1_500_000),
  isInternal: z.boolean().default(true),
});

/* ------------------------------- notifications ---------------------------- */

export interface InAppNotification {
  id: string;
  title: string;
  body: string;
  link: string | null;
  category: string;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationTemplate {
  id: string;
  code: string;
  channel: 'email' | 'sms' | 'inapp' | 'whatsapp';
  subject: string | null;
  body: string;
  active: boolean;
}

export interface NotificationOutboxRecord {
  id: string;
  channel: 'email' | 'sms' | 'whatsapp';
  recipientAddress: string;
  templateCode: string | null;
  subject: string | null;
  body: string;
  status: 'queued' | 'processing' | 'sent' | 'failed' | 'blocked' | 'cancelled';
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  provider: string | null;
  createdAt: string;
  sentAt: string | null;
}

export interface NotificationPreference {
  channel: 'email' | 'sms' | 'inapp' | 'whatsapp';
  enabled: boolean;
  consentGivenAt: string | null;
}

export interface NotificationProviderStatus {
  configured: boolean;
  provider: string | null;
  message: string;
}

export const notificationTemplateInput = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(60)
    .regex(/^[a-z0-9_-]+$/, 'Use lowercase letters, numbers, _ or -'),
  channel: z.enum(['email', 'sms', 'inapp', 'whatsapp']),
  subject: optionalText(200),
  body: z.string().trim().min(1).max(10_000),
  active: z.boolean().default(true),
});

export const notificationTemplateUpdate = notificationTemplateInput.partial();

export const notificationQueueInput = z.object({
  channel: z.enum(['email', 'sms', 'whatsapp']),
  recipientUserId: uuid.optional(),
  recipientAddress: z.string().trim().min(3).max(320),
  templateCode: optionalText(60),
  subject: optionalText(200),
  body: z.string().trim().min(1).max(10_000),
  dedupeKey: optionalText(120),
});

export const notificationPreferenceInput = z.object({
  channel: z.enum(['email', 'sms', 'inapp', 'whatsapp']),
  enabled: z.boolean(),
  consent: z.boolean().default(false),
});

export const inAppNotificationInput = z.object({
  userId: uuid,
  title: nonEmptyText(200),
  body: z.string().trim().min(1).max(4000),
  link: optionalText(500),
  category: optionalText(40),
  dedupeKey: optionalText(120),
});

/* ------------------------- reconciliation and write-offs ------------------ */

export interface FeeConcessionRequest {
  id: string;
  studentId: string;
  studentName: string;
  academicYearId: string;
  chargeId: string;
  chargeDescription: string;
  amount: number;
  reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  requestedByName: string | null;
  requestedAt: string;
  reviewedByName: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
}

export interface FeeWriteOff {
  id: string;
  chargeId: string;
  studentName: string;
  chargeDescription: string;
  amount: number;
  reason: string;
  approvedByName: string | null;
  approvedAt: string;
}

export interface ReconciliationLine {
  id: string;
  lineNo: number;
  paidOn: string;
  amount: number;
  reference: string | null;
  method: 'cash' | 'bank_transfer' | 'card' | 'upi' | 'cheque' | 'other';
  status: 'unmatched' | 'matched' | 'exception';
  matchedPaymentId: string | null;
  matchedReceiptNumber: string | null;
  exceptionReason: string | null;
}

export interface ReconciliationBatch {
  id: string;
  reference: string;
  source: string;
  statementFrom: string | null;
  statementTo: string | null;
  status: 'draft' | 'balanced' | 'closed';
  openingBalance: number | null;
  closingBalance: number | null;
  notes: string | null;
  lineCount: number;
  matchedCount: number;
  unmatchedCount: number;
  exceptionCount: number;
  matchedTotal: number;
  createdAt: string;
  lines?: ReconciliationLine[];
}

export const concessionRequestInput = z.object({
  studentId: uuid,
  academicYearId: uuid,
  chargeId: uuid,
  amount: positiveMoney,
  reason: z.string().trim().min(5, 'Give a short reason').max(2000),
});

export const concessionDecisionInput = z.object({
  decision: z.enum(['approve', 'reject']),
  note: optionalText(1000),
});

export const writeOffInput = z.object({
  chargeId: uuid,
  amount: positiveMoney,
  reason: z.string().trim().min(5, 'Give a short reason').max(2000),
});

export const reconciliationBatchInput = z.object({
  reference: nonEmptyText(80),
  source: optionalText(60),
  statementFrom: isoDate.nullable().optional(),
  statementTo: isoDate.nullable().optional(),
  openingBalance: money.nullable().optional(),
  closingBalance: money.nullable().optional(),
  notes: optionalText(1000),
});

export const reconciliationLineInput = z.object({
  paidOn: isoDate,
  amount: z.coerce.number().finite().refine((value) => value !== 0, 'Amount cannot be zero').min(-99_999_999).max(99_999_999),
  reference: optionalText(160),
  method: z.enum(['cash', 'bank_transfer', 'card', 'upi', 'cheque', 'other']).default('other'),
});

export const reconciliationMatchInput = z.object({
  paymentId: uuid.nullable().optional(),
  exceptionReason: optionalText(1000),
});

/* -------------------------- saved reports and imports --------------------- */

export interface SavedReport {
  id: string;
  name: string;
  reportType: 'students' | 'attendance' | 'fees';
  filters: Record<string, string | undefined>;
  shared: boolean;
  createdByName: string | null;
  createdAt: string;
}

export interface ImportBatch {
  id: string;
  entityType: 'students' | 'library_books' | 'vendors';
  filename: string;
  status: 'previewed' | 'committed' | 'cancelled';
  totalRows: number;
  validRows: number;
  invalidRows: number;
  createdRows: number;
  createdAt: string;
  committedAt: string | null;
  rows?: ImportRow[];
}

export interface ImportRow {
  id: string;
  rowNumber: number;
  payload: Record<string, string>;
  errors: string[];
  action: 'create' | 'update' | 'skip';
  createdEntityId: string | null;
}

export const savedReportInput = z.object({
  name: nonEmptyText(120),
  reportType: z.enum(['students', 'attendance', 'fees']),
  filters: z.record(z.string(), z.string()).default({}),
  shared: z.boolean().default(false),
});

export const savedReportUpdate = savedReportInput.partial();

export const importPreviewInput = z.object({
  entityType: z.enum(['students', 'library_books', 'vendors']),
  filename: nonEmptyText(255),
  csv: z.string().min(1, 'Paste or upload a CSV file').max(1_000_000),
});
