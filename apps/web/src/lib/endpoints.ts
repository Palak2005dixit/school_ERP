import type {
  AcademicYear,
  AttendanceCorrection,
  Candidate,
  CandidateInterview,
  Concern,
  ConcernCategory,
  AttendanceRegister,
  AttendanceReport,
  AttendanceSaveResult,
  AttendanceStatus,
  AuditEvent,
  ChargeInstallments,
  ChildSummary,
  ClassRecord,
  ExamRecord,
  EmployeeChange,
  FeeConcessionRequest,
  FeeHead,
  FeeLedger,
  FeeOverview,
  FeeReport,
  FeeStructure,
  FeeWriteOff,
  GradingScheme,
  HolidayRecord,
  HomeworkAssignment,
  HomeworkSubmission,
  ImportBatch,
  ImportRow,
  InAppNotification,
  JobOffer,
  LateFeeRuleRecord,
  LateFeeRunResult,
  LearningResource,
  LeaveBalanceRecord,
  LeaveRecord,
  LeaveTypeRecord,
  LibraryBook,
  LibraryCategory,
  LibraryCopy,
  LibraryFine,
  LibraryLoan,
  LibraryMember,
  LibraryReservation,
  LibrarySettings,
  MarkSheet,
  NoticeRecord,
  NoticeAttachmentSummary,
  NotificationOutboxRecord,
  NotificationPreference,
  NotificationProviderStatus,
  NotificationTemplate,
  OnboardingTask,
  Paginated,
  PaymentRecord,
  PayrollRunDetail,
  PayrollRunSummary,
  PayslipRecord,
  PortalAttendance,
  ProcurementBudget,
  ProcurementExpense,
  PurchaseOrder,
  PurchaseRequest,
  QuestionBankItem,
  ReconciliationBatch,
  ReconciliationLine,
  RefundRecord,
  ReportCard,
  RoleSummary,
  RoomRecord,
  SafeguardingCaseDetail,
  SafeguardingCaseSummary,
  SafeguardingNoteRecord,
  SalaryRecord,
  SavedReport,
  SchoolOverview,
  SectionRecord,
  StaffAttendanceCorrection,
  StaffAttendanceRecord,
  StaffAttendanceSettings,
  StaffAttendanceSummary,
  StaffRecord,
  StaffSeparation,
  StaffShift,
  StudentCharge,
  StudentDetail,
  StudentImportResult,
  StudentSummary,
  StudentTransportAllocation,
  SubjectRecord,
  TimetableData,
  TimetablePeriod,
  TranscriptRecord,
  TransportDriver,
  TransportMaintenance,
  TransportRoute,
  TransportVehicle,
  UserRecord,
  Vacancy,
  Vendor,
  VendorBill,
} from '@erp/shared';
import { api } from './api';

const school = (schoolId: string) => `/api/schools/${schoolId}`;

function queryString(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const serialized = params.toString();
  return serialized ? `?${serialized}` : '';
}

/* -------------------------------- academic -------------------------------- */

export function listAcademicYears(schoolId: string): Promise<{ items: AcademicYear[] }> {
  return api(`${school(schoolId)}/academic-years`);
}

export function createAcademicYear(
  schoolId: string,
  input: { code: string; name: string; startsOn: string; endsOn: string; status: string },
): Promise<AcademicYear> {
  return api(`${school(schoolId)}/academic-years`, { method: 'POST', body: JSON.stringify(input) });
}

export function updateAcademicYear(
  schoolId: string,
  id: string,
  input: Partial<Pick<AcademicYear, 'name' | 'startsOn' | 'endsOn' | 'status'>>,
): Promise<AcademicYear> {
  return api(`${school(schoolId)}/academic-years/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function activateAcademicYear(schoolId: string, id: string): Promise<AcademicYear> {
  return api(`${school(schoolId)}/academic-years/${id}/activate`, { method: 'POST' });
}

export function listClasses(schoolId: string): Promise<{ items: ClassRecord[] }> {
  return api(`${school(schoolId)}/classes`);
}

export function createClass(
  schoolId: string,
  input: { code: string; name: string; gradeOrder: number | null; status: string },
): Promise<ClassRecord> {
  return api(`${school(schoolId)}/classes`, { method: 'POST', body: JSON.stringify(input) });
}

export function updateClass(
  schoolId: string,
  id: string,
  input: Partial<Pick<ClassRecord, 'code' | 'name' | 'gradeOrder' | 'status'>>,
): Promise<ClassRecord> {
  return api(`${school(schoolId)}/classes/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
}

export function listSections(
  schoolId: string,
  filters: { academicYearId?: string; classId?: string; status?: string } = {},
): Promise<{ items: SectionRecord[] }> {
  return api(`${school(schoolId)}/sections${queryString(filters)}`);
}

export function createSection(
  schoolId: string,
  input: {
    academicYearId: string;
    classId: string;
    code: string;
    name: string;
    capacity: number | null;
    status: string;
  },
): Promise<SectionRecord> {
  return api(`${school(schoolId)}/sections`, { method: 'POST', body: JSON.stringify(input) });
}

export function updateSection(
  schoolId: string,
  id: string,
  input: Partial<Pick<SectionRecord, 'code' | 'name' | 'capacity' | 'status'>>,
): Promise<SectionRecord> {
  return api(`${school(schoolId)}/sections/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function listSubjects(schoolId: string): Promise<{ items: SubjectRecord[] }> {
  return api(`${school(schoolId)}/subjects`);
}

export function createSubject(
  schoolId: string,
  input: { code: string; name: string; subjectType: string; status: string },
): Promise<SubjectRecord> {
  return api(`${school(schoolId)}/subjects`, { method: 'POST', body: JSON.stringify(input) });
}

export function updateSubject(
  schoolId: string,
  id: string,
  input: Partial<Pick<SubjectRecord, 'code' | 'name' | 'subjectType' | 'status'>>,
): Promise<SubjectRecord> {
  return api(`${school(schoolId)}/subjects/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

/* -------------------------------- students -------------------------------- */

export function listStudents(
  schoolId: string,
  filters: {
    page?: number;
    pageSize?: number;
    search?: string;
    status?: string;
    classId?: string;
    sectionId?: string;
  },
): Promise<Paginated<StudentSummary>> {
  return api(`${school(schoolId)}/students${queryString(filters)}`);
}

export interface AdmissionInput {
  admissionNumber?: string;
  firstName: string;
  middleName?: string;
  lastName?: string;
  dateOfBirth?: string;
  academicYearId: string;
  sectionId: string;
  startsOn: string;
  guardians: Array<{
    firstName: string;
    lastName?: string;
    email?: string;
    phone?: string;
    relationshipType: string;
    isPrimary: boolean;
    portalAccessStatus: string;
  }>;
}

export function admitStudent(schoolId: string, input: AdmissionInput): Promise<StudentDetail> {
  return api(`${school(schoolId)}/students`, { method: 'POST', body: JSON.stringify(input) });
}

export function getStudent(schoolId: string, id: string): Promise<StudentDetail> {
  return api(`${school(schoolId)}/students/${id}`);
}

export function updateStudent(
  schoolId: string,
  id: string,
  input: {
    firstName?: string;
    middleName?: string | null;
    lastName?: string | null;
    dateOfBirth?: string | null;
    status?: string;
  },
): Promise<StudentDetail> {
  return api(`${school(schoolId)}/students/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function linkGuardian(
  schoolId: string,
  studentId: string,
  input: {
    firstName: string;
    lastName?: string;
    email?: string;
    phone?: string;
    relationshipType: string;
    isPrimary: boolean;
    portalAccessStatus: string;
  },
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/students/${studentId}/guardians`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function enrollStudent(
  schoolId: string,
  studentId: string,
  input: { academicYearId: string; sectionId: string; startsOn: string },
): Promise<StudentDetail> {
  return api(`${school(schoolId)}/students/${studentId}/enrollments`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/* ---------------------------------- portal -------------------------------- */

export function listChildren(schoolId: string): Promise<{ items: ChildSummary[] }> {
  return api(`${school(schoolId)}/portal/children`);
}

/* -------------------------------- attendance ------------------------------ */

export function getAttendanceRegister(
  schoolId: string,
  sectionId: string,
  date: string,
): Promise<AttendanceRegister> {
  return api(
    `${school(schoolId)}/attendance/register${queryString({ sectionId, date })}`,
  );
}

export function saveAttendanceRegister(
  schoolId: string,
  input: {
    sectionId: string;
    date: string;
    entries: Array<{ studentId: string; status: AttendanceStatus; note?: string }>;
  },
): Promise<AttendanceSaveResult> {
  return api(`${school(schoolId)}/attendance/register`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function requestAttendanceCorrection(
  schoolId: string,
  input: { attendanceId: string; requestedStatus: AttendanceStatus; reason: string },
): Promise<AttendanceCorrection> {
  return api(`${school(schoolId)}/attendance/corrections`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function listPendingCorrections(
  schoolId: string,
): Promise<{ items: AttendanceCorrection[] }> {
  return api(`${school(schoolId)}/attendance/corrections`);
}

export function reviewAttendanceCorrection(
  schoolId: string,
  id: string,
  input: { decision: 'approve' | 'reject'; note?: string },
): Promise<AttendanceCorrection> {
  return api(`${school(schoolId)}/attendance/corrections/${id}/review`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/* -------------------------------- timetable ------------------------------- */

export function getTimetable(
  schoolId: string,
  filters: { academicYearId?: string; sectionId?: string } = {},
): Promise<TimetableData> {
  return api(`${school(schoolId)}/timetable${queryString(filters)}`);
}

export function createTimetablePeriod(
  schoolId: string,
  input: Omit<TimetablePeriod, 'id'>,
): Promise<TimetablePeriod> {
  return api(`${school(schoolId)}/timetable/periods`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateTimetablePeriod(
  schoolId: string,
  id: string,
  input: Partial<Omit<TimetablePeriod, 'id' | 'academicYearId'>>,
): Promise<TimetablePeriod> {
  return api(`${school(schoolId)}/timetable/periods/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function deleteTimetablePeriod(schoolId: string, id: string): Promise<void> {
  return api(`${school(schoolId)}/timetable/periods/${id}`, { method: 'DELETE' });
}

export function createRoom(schoolId: string, input: Omit<RoomRecord, 'id'>): Promise<RoomRecord> {
  return api(`${school(schoolId)}/rooms`, { method: 'POST', body: JSON.stringify(input) });
}

export function updateRoom(
  schoolId: string,
  id: string,
  input: Partial<Omit<RoomRecord, 'id'>>,
): Promise<RoomRecord> {
  return api(`${school(schoolId)}/rooms/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
}

export function deleteRoom(schoolId: string, id: string): Promise<void> {
  return api(`${school(schoolId)}/rooms/${id}`, { method: 'DELETE' });
}

export interface TimetableSlotInput {
  academicYearId: string;
  sectionId: string;
  periodId: string;
  dayOfWeek: number;
  subjectId: string;
  teacherUserId: string;
  roomId?: string | null;
}

export function createTimetableSlot(
  schoolId: string,
  input: TimetableSlotInput,
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/timetable/slots`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function deleteTimetableSlot(schoolId: string, id: string): Promise<void> {
  return api(`${school(schoolId)}/timetable/slots/${id}`, { method: 'DELETE' });
}

/* ----------------------------------- fees --------------------------------- */

export function listFeeHeads(schoolId: string): Promise<{ items: FeeHead[] }> {
  return api(`${school(schoolId)}/fee-heads`);
}

export function createFeeHead(schoolId: string, input: Omit<FeeHead, 'id'>): Promise<FeeHead> {
  return api(`${school(schoolId)}/fee-heads`, { method: 'POST', body: JSON.stringify(input) });
}

export function updateFeeHead(
  schoolId: string,
  id: string,
  input: Partial<Omit<FeeHead, 'id'>>,
): Promise<FeeHead> {
  return api(`${school(schoolId)}/fee-heads/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function listFeeStructures(
  schoolId: string,
  filters: { academicYearId?: string; classId?: string } = {},
): Promise<{ items: FeeStructure[] }> {
  return api(`${school(schoolId)}/fee-structures${queryString(filters)}`);
}

export function createFeeStructure(
  schoolId: string,
  input: {
    academicYearId: string;
    classId: string;
    feeHeadId: string;
    amount: number;
    dueOn?: string;
  },
): Promise<FeeStructure> {
  return api(`${school(schoolId)}/fee-structures`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateFeeStructure(
  schoolId: string,
  id: string,
  input: { amount?: number; dueOn?: string | null },
): Promise<FeeStructure> {
  return api(`${school(schoolId)}/fee-structures/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function listCharges(
  schoolId: string,
  filters: {
    academicYearId?: string;
    studentId?: string;
    sectionId?: string;
    status?: string;
  } = {},
): Promise<{ items: StudentCharge[] }> {
  return api(`${school(schoolId)}/fees/charges${queryString(filters)}`);
}

export function createCharge(
  schoolId: string,
  input: {
    studentId: string;
    academicYearId: string;
    feeHeadId: string;
    description: string;
    amount: number;
    concessionAmount?: number;
    concessionReason?: string;
    dueOn: string;
  },
): Promise<StudentCharge> {
  return api(`${school(schoolId)}/fees/charges`, { method: 'POST', body: JSON.stringify(input) });
}

export function updateCharge(
  schoolId: string,
  id: string,
  input: {
    description?: string;
    concessionAmount?: number;
    concessionReason?: string;
    dueOn?: string;
  },
): Promise<StudentCharge> {
  return api(`${school(schoolId)}/fees/charges/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function generateCharges(
  schoolId: string,
  input: {
    academicYearId: string;
    sectionId: string;
    dueOn: string;
    feeHeadIds?: string[];
  },
): Promise<{ created: number; skipped: number }> {
  return api(`${school(schoolId)}/fees/charges/generate`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function listPayments(
  schoolId: string,
  filters: { academicYearId?: string; studentId?: string } = {},
): Promise<{ items: PaymentRecord[] }> {
  return api(`${school(schoolId)}/fees/payments${queryString(filters)}`);
}

export function recordPayment(
  schoolId: string,
  input: {
    studentId: string;
    academicYearId: string;
    amount: number;
    method: string;
    reference?: string;
    paidOn: string;
    notes?: string;
    allocations?: Array<{ chargeId: string; amount: number }>;
  },
): Promise<PaymentRecord> {
  return api(`${school(schoolId)}/fees/payments`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function listRefunds(
  schoolId: string,
  status?: string,
): Promise<{ items: RefundRecord[] }> {
  return api(`${school(schoolId)}/fees/refunds${queryString({ status })}`);
}

export function requestRefund(
  schoolId: string,
  input: { paymentId: string; amount: number; reason: string },
): Promise<RefundRecord> {
  return api(`${school(schoolId)}/fees/refunds`, { method: 'POST', body: JSON.stringify(input) });
}

export function reviewRefund(
  schoolId: string,
  id: string,
  input: { decision: 'approve' | 'reject'; note?: string },
): Promise<RefundRecord> {
  return api(`${school(schoolId)}/fees/refunds/${id}/review`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function getFeeOverview(
  schoolId: string,
  academicYearId?: string,
): Promise<FeeOverview> {
  return api(`${school(schoolId)}/fees/overview${queryString({ academicYearId })}`);
}

export function getFeeLedger(schoolId: string, studentId: string): Promise<FeeLedger> {
  return api(`${school(schoolId)}/fees/students/${studentId}/ledger`);
}

/* ---------------------------------- exams --------------------------------- */

export function listGradingSchemes(schoolId: string): Promise<{ items: GradingScheme[] }> {
  return api(`${school(schoolId)}/grading-schemes`);
}

export function createGradingScheme(
  schoolId: string,
  input: {
    code: string;
    name: string;
    isDefault: boolean;
    bands: Array<{ minPercent: number; maxPercent: number; grade: string; remark?: string }>;
  },
): Promise<GradingScheme> {
  return api(`${school(schoolId)}/grading-schemes`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function listExams(
  schoolId: string,
  academicYearId?: string,
): Promise<{ items: ExamRecord[] }> {
  return api(`${school(schoolId)}/exams${queryString({ academicYearId })}`);
}

export function createExam(
  schoolId: string,
  input: {
    academicYearId: string;
    name: string;
    examType: string;
    startsOn: string;
    endsOn: string;
    gradingSchemeId: string;
    passPercent: number;
  },
): Promise<ExamRecord> {
  return api(`${school(schoolId)}/exams`, { method: 'POST', body: JSON.stringify(input) });
}

export function updateExam(
  schoolId: string,
  id: string,
  input: Partial<{
    name: string;
    examType: string;
    startsOn: string;
    endsOn: string;
    gradingSchemeId: string;
    passPercent: number;
  }>,
): Promise<ExamRecord> {
  return api(`${school(schoolId)}/exams/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
}

export function deleteExam(schoolId: string, id: string): Promise<void> {
  return api(`${school(schoolId)}/exams/${id}`, { method: 'DELETE' });
}

export function addExamSubject(
  schoolId: string,
  examId: string,
  input: { subjectId: string; maxMarks: number; passMarks: number },
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/exams/${examId}/subjects`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function removeExamSubject(
  schoolId: string,
  examId: string,
  subjectId: string,
): Promise<void> {
  return api(`${school(schoolId)}/exams/${examId}/subjects/${subjectId}`, { method: 'DELETE' });
}

export function getMarkSheet(
  schoolId: string,
  examId: string,
  sectionId: string,
  subjectId: string,
): Promise<MarkSheet> {
  return api(
    `${school(schoolId)}/exams/${examId}/marks${queryString({ sectionId, subjectId })}`,
  );
}

export function saveMarks(
  schoolId: string,
  examId: string,
  input: {
    examSubjectId: string;
    sectionId: string;
    entries: Array<{ studentId: string; marksObtained: number | null; isAbsent: boolean }>;
  },
): Promise<MarkSheet> {
  return api(`${school(schoolId)}/exams/${examId}/marks`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function publishExam(schoolId: string, examId: string): Promise<ExamRecord> {
  return api(`${school(schoolId)}/exams/${examId}/publish`, { method: 'POST' });
}

export function unpublishExam(schoolId: string, examId: string): Promise<ExamRecord> {
  return api(`${school(schoolId)}/exams/${examId}/unpublish`, { method: 'POST' });
}

export function getReportCard(
  schoolId: string,
  examId: string,
  studentId: string,
): Promise<ReportCard> {
  return api(`${school(schoolId)}/exams/${examId}/report-cards/${studentId}`);
}

/* ---------------------------------- staff --------------------------------- */

export function listStaff(
  schoolId: string,
  status?: string,
): Promise<{ items: StaffRecord[] }> {
  return api(`${school(schoolId)}/staff${queryString({ status })}`);
}

export function createStaff(
  schoolId: string,
  input: {
    userId?: string | null;
    employeeNumber?: string;
    firstName: string;
    lastName?: string;
    email?: string;
    phone?: string;
    designation: string;
    department?: string;
    joinedOn?: string;
    status: string;
  },
): Promise<StaffRecord> {
  return api(`${school(schoolId)}/staff`, { method: 'POST', body: JSON.stringify(input) });
}

export function updateStaff(
  schoolId: string,
  id: string,
  input: Partial<{
    userId: string | null;
    employeeNumber: string;
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    designation: string;
    department: string;
    joinedOn: string;
    status: string;
  }>,
): Promise<StaffRecord> {
  return api(`${school(schoolId)}/staff/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
}

export function listSalaries(schoolId: string): Promise<{ items: SalaryRecord[] }> {
  return api(`${school(schoolId)}/staff/salaries`);
}

export function setSalary(
  schoolId: string,
  staffId: string,
  input: { amount: number; currency?: string; effectiveFrom: string; notes?: string },
): Promise<SalaryRecord> {
  return api(`${school(schoolId)}/staff/${staffId}/salary`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export function listLeave(
  schoolId: string,
  status?: string,
): Promise<{ items: LeaveRecord[] }> {
  return api(`${school(schoolId)}/leave${queryString({ status })}`);
}

export function requestLeave(
  schoolId: string,
  input: { staffId?: string; leaveType: string; startsOn: string; endsOn: string; reason: string },
): Promise<LeaveRecord> {
  return api(`${school(schoolId)}/leave`, { method: 'POST', body: JSON.stringify(input) });
}

export function reviewLeave(
  schoolId: string,
  id: string,
  input: { decision: 'approve' | 'reject'; note?: string },
): Promise<LeaveRecord> {
  return api(`${school(schoolId)}/leave/${id}/review`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function cancelLeave(schoolId: string, id: string): Promise<void> {
  return api(`${school(schoolId)}/leave/${id}/cancel`, { method: 'POST' });
}

/* --------------------------------- notices -------------------------------- */

export function listNotices(
  schoolId: string,
  status?: string,
): Promise<{ items: NoticeRecord[] }> {
  return api(`${school(schoolId)}/notices${queryString({ status })}`);
}

export function createNotice(
  schoolId: string,
  input: {
    title: string;
    body: string;
    audience: string;
    pinned: boolean;
    expiresOn?: string | null;
  },
): Promise<NoticeRecord> {
  return api(`${school(schoolId)}/notices`, { method: 'POST', body: JSON.stringify(input) });
}

export function updateNotice(
  schoolId: string,
  id: string,
  input: Partial<{
    title: string;
    body: string;
    audience: string;
    pinned: boolean;
    expiresOn: string | null;
    status: 'draft' | 'published' | 'archived';
  }>,
): Promise<NoticeRecord> {
  return api(`${school(schoolId)}/notices/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function deleteNotice(schoolId: string, id: string): Promise<void> {
  return api(`${school(schoolId)}/notices/${id}`, { method: 'DELETE' });
}

export function uploadNoticeAttachment(
  schoolId: string,
  noticeId: string,
  input: { filename: string; contentType: string; dataBase64: string },
): Promise<NoticeAttachmentSummary> {
  return api(`${school(schoolId)}/notices/${noticeId}/attachments`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function deleteNoticeAttachment(
  schoolId: string,
  noticeId: string,
  attachmentId: string,
): Promise<void> {
  return api(`${school(schoolId)}/notices/${noticeId}/attachments/${attachmentId}`, {
    method: 'DELETE',
  });
}

/** Direct download URL; the session cookie authenticates the request. */
export function noticeAttachmentUrl(
  schoolId: string,
  noticeId: string,
  attachmentId: string,
): string {
  return `/api/schools/${schoolId}/notices/${noticeId}/attachments/${attachmentId}`;
}

export function markNoticeRead(
  schoolId: string,
  noticeId: string,
): Promise<{ readAt: string }> {
  return api(`${school(schoolId)}/notices/${noticeId}/read`, { method: 'POST' });
}

/* --------------------------------- reports -------------------------------- */

export function getAttendanceReport(
  schoolId: string,
  filters: { from?: string; to?: string; academicYearId?: string } = {},
): Promise<AttendanceReport> {
  return api(`${school(schoolId)}/reports/attendance${queryString(filters)}`);
}

export function getFeeReport(
  schoolId: string,
  filters: { academicYearId?: string } = {},
): Promise<FeeReport> {
  return api(`${school(schoolId)}/reports/fees${queryString(filters)}`);
}

export function reportExportUrl(
  schoolId: string,
  type: 'students' | 'attendance' | 'fees',
  filters: { from?: string; to?: string; academicYearId?: string; sectionId?: string } = {},
): string {
  return `${school(schoolId)}/reports/export${queryString({ type, ...filters })}`;
}

/* ---------------------------------- access -------------------------------- */

export function listRoles(schoolId: string): Promise<{ items: RoleSummary[] }> {
  return api(`${school(schoolId)}/roles`);
}

export function listUsers(schoolId: string): Promise<{ items: UserRecord[] }> {
  return api(`${school(schoolId)}/users`);
}

export function createUser(
  schoolId: string,
  input: {
    email: string;
    displayName: string;
    password: string;
    roleCode: string;
    scopeType?: string;
    scopeId?: string | null;
  },
): Promise<UserRecord> {
  return api(`${school(schoolId)}/users`, { method: 'POST', body: JSON.stringify(input) });
}

export function setUserStatus(
  schoolId: string,
  id: string,
  status: 'active' | 'locked' | 'disabled',
): Promise<UserRecord> {
  return api(`${school(schoolId)}/users/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

export function grantRole(
  schoolId: string,
  userId: string,
  input: { roleCode: string; scopeType?: string; scopeId?: string | null },
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/users/${userId}/roles`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function revokeRole(
  schoolId: string,
  userId: string,
  assignmentId: string,
): Promise<void> {
  return api(`${school(schoolId)}/users/${userId}/roles/${assignmentId}`, {
    method: 'DELETE',
  });
}

/* ------------------------------ guardian portal --------------------------- */

export function getChildAttendance(
  schoolId: string,
  studentId: string,
  filters: { from?: string; to?: string } = {},
): Promise<PortalAttendance> {
  return api(
    `${school(schoolId)}/portal/children/${studentId}/attendance${queryString(filters)}`,
  );
}

export function getChildFees(schoolId: string, studentId: string): Promise<FeeLedger> {
  return api(`${school(schoolId)}/portal/children/${studentId}/fees`);
}

export function getChildResults(
  schoolId: string,
  studentId: string,
): Promise<{ items: ReportCard[] }> {
  return api(`${school(schoolId)}/portal/children/${studentId}/results`);
}

/* ------------------------------- safeguarding ----------------------------- */

export function listSafeguardingCases(
  schoolId: string,
  filters: { status?: string; studentId?: string; severity?: string } = {},
): Promise<{ items: SafeguardingCaseSummary[] }> {
  return api(`${school(schoolId)}/safeguarding${queryString(filters)}`);
}

export function getSafeguardingCase(
  schoolId: string,
  id: string,
): Promise<SafeguardingCaseDetail> {
  return api(`${school(schoolId)}/safeguarding/${id}`);
}

export function createSafeguardingCase(
  schoolId: string,
  input: {
    studentId: string;
    category: string;
    severity: string;
    summary: string;
    openedOn?: string;
  },
): Promise<SafeguardingCaseDetail> {
  return api(`${school(schoolId)}/safeguarding`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateSafeguardingCase(
  schoolId: string,
  id: string,
  input: Partial<{
    category: string;
    severity: string;
    summary: string;
    status: string;
    closedOn: string | null;
  }>,
): Promise<SafeguardingCaseDetail> {
  return api(`${school(schoolId)}/safeguarding/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function addSafeguardingNote(
  schoolId: string,
  caseId: string,
  note: string,
): Promise<SafeguardingNoteRecord> {
  return api(`${school(schoolId)}/safeguarding/${caseId}/notes`, {
    method: 'POST',
    body: JSON.stringify({ note }),
  });
}

/* ------------------------------ leave configuration ----------------------- */

export function listLeaveTypes(schoolId: string): Promise<{ items: LeaveTypeRecord[] }> {
  return api(`${school(schoolId)}/leave/types`);
}

export function createLeaveType(
  schoolId: string,
  input: {
    code: string;
    name: string;
    annualQuotaDays: number;
    paid: boolean;
    active: boolean;
  },
): Promise<LeaveTypeRecord> {
  return api(`${school(schoolId)}/leave/types`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateLeaveType(
  schoolId: string,
  id: string,
  input: Partial<{
    code: string;
    name: string;
    annualQuotaDays: number;
    paid: boolean;
    active: boolean;
  }>,
): Promise<LeaveTypeRecord> {
  return api(`${school(schoolId)}/leave/types/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function listHolidays(
  schoolId: string,
  year?: number,
): Promise<{ items: HolidayRecord[] }> {
  return api(`${school(schoolId)}/holidays${queryString({ year })}`);
}

export function createHoliday(
  schoolId: string,
  input: {
    name: string;
    holidayOn: string;
    academicYearId?: string;
    notes?: string;
  },
): Promise<HolidayRecord> {
  return api(`${school(schoolId)}/holidays`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function deleteHoliday(schoolId: string, id: string): Promise<void> {
  return api(`${school(schoolId)}/holidays/${id}`, { method: 'DELETE' });
}

export function listLeaveBalances(
  schoolId: string,
  filters: { year?: number; staffId?: string } = {},
): Promise<{ year: number; items: LeaveBalanceRecord[] }> {
  return api(`${school(schoolId)}/leave/balances${queryString(filters)}`);
}

/* --------------------------------- payroll -------------------------------- */

export function listPayrollRuns(schoolId: string): Promise<{ items: PayrollRunSummary[] }> {
  return api(`${school(schoolId)}/payroll`);
}

export function getPayrollRun(schoolId: string, id: string): Promise<PayrollRunDetail> {
  return api(`${school(schoolId)}/payroll/${id}`);
}

export function createPayrollRun(
  schoolId: string,
  input: {
    periodStart: string;
    periodEnd: string;
    notes?: string;
    deductions?: Array<{ staffId: string; amount: number }>;
  },
): Promise<PayrollRunDetail> {
  return api(`${school(schoolId)}/payroll`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updatePayslip(
  schoolId: string,
  runId: string,
  payslipId: string,
  input: { deductions: number; notes?: string },
): Promise<PayslipRecord> {
  return api(`${school(schoolId)}/payroll/${runId}/payslips/${payslipId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function approvePayrollRun(
  schoolId: string,
  id: string,
): Promise<PayrollRunDetail> {
  return api(`${school(schoolId)}/payroll/${id}/approve`, { method: 'POST' });
}

export function payPayrollRun(
  schoolId: string,
  id: string,
  input: { paidOn: string },
): Promise<PayrollRunDetail> {
  return api(`${school(schoolId)}/payroll/${id}/pay`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function deletePayrollRun(schoolId: string, id: string): Promise<void> {
  return api(`${school(schoolId)}/payroll/${id}`, { method: 'DELETE' });
}

/* ------------------------------ fee extensions ---------------------------- */

export function listLateFeeRules(schoolId: string): Promise<{ items: LateFeeRuleRecord[] }> {
  return api(`${school(schoolId)}/fee-late-rules`);
}

export function createLateFeeRule(
  schoolId: string,
  input: {
    name: string;
    graceDays: number;
    percentPerMonth: number;
    maxAmount: number;
    active: boolean;
  },
): Promise<LateFeeRuleRecord> {
  return api(`${school(schoolId)}/fee-late-rules`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateLateFeeRule(
  schoolId: string,
  id: string,
  input: Partial<{
    name: string;
    graceDays: number;
    percentPerMonth: number;
    maxAmount: number;
    active: boolean;
  }>,
): Promise<LateFeeRuleRecord> {
  return api(`${school(schoolId)}/fee-late-rules/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function runLateFees(
  schoolId: string,
  input: { ruleId: string; asOf?: string; academicYearId?: string },
): Promise<LateFeeRunResult> {
  return api(`${school(schoolId)}/fees/late-fees/run`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export interface InstallmentPlanItem {
  sequence: number;
  label: string;
  percent: number;
  dueOn: string;
}

export function listInstallmentPlan(
  schoolId: string,
  structureId: string,
): Promise<{ items: InstallmentPlanItem[] }> {
  return api(`${school(schoolId)}/fee-structures/${structureId}/installments`);
}

export function saveInstallmentPlan(
  schoolId: string,
  structureId: string,
  items: InstallmentPlanItem[],
): Promise<{ items: InstallmentPlanItem[] }> {
  return api(`${school(schoolId)}/fee-structures/${structureId}/installments`, {
    method: 'PUT',
    body: JSON.stringify({ items }),
  });
}

export function listStudentInstallments(
  schoolId: string,
  studentId: string,
  academicYearId?: string,
): Promise<{ items: ChargeInstallments[] }> {
  return api(
    `${school(schoolId)}/fees/students/${studentId}/installments${queryString({ academicYearId })}`,
  );
}

/** Printable server-rendered pages; the session cookie authenticates the request. */
export function studentInvoiceUrl(
  schoolId: string,
  studentId: string,
  academicYearId?: string,
): string {
  return `${school(schoolId)}/fees/students/${studentId}/invoice${queryString({ academicYearId })}`;
}

export function paymentReceiptUrl(schoolId: string, paymentId: string): string {
  return `${school(schoolId)}/fees/payments/${paymentId}/receipt`;
}

export function childInvoiceUrl(
  schoolId: string,
  studentId: string,
  academicYearId?: string,
): string {
  return `${school(schoolId)}/portal/children/${studentId}/invoice${queryString({ academicYearId })}`;
}

export function childReceiptUrl(
  schoolId: string,
  studentId: string,
  paymentId: string,
): string {
  return `${school(schoolId)}/portal/children/${studentId}/receipts/${paymentId}`;
}

/* -------------------------------- transcripts ----------------------------- */

export function getStudentTranscript(
  schoolId: string,
  studentId: string,
  academicYearId?: string,
): Promise<TranscriptRecord> {
  return api(
    `${school(schoolId)}/students/${studentId}/transcript${queryString({ academicYearId })}`,
  );
}

export function transcriptPrintUrl(
  schoolId: string,
  studentId: string,
  academicYearId?: string,
): string {
  return `${school(schoolId)}/students/${studentId}/transcript/print${queryString({ academicYearId })}`;
}

export function getChildTranscript(
  schoolId: string,
  studentId: string,
  academicYearId?: string,
): Promise<TranscriptRecord> {
  return api(
    `${school(schoolId)}/portal/children/${studentId}/transcript${queryString({ academicYearId })}`,
  );
}

export function childTranscriptPrintUrl(
  schoolId: string,
  studentId: string,
  academicYearId?: string,
): string {
  return `${school(schoolId)}/portal/children/${studentId}/transcript/print${queryString({ academicYearId })}`;
}

/* --------------------------------- import --------------------------------- */

export function importStudents(
  schoolId: string,
  input: { academicYearId: string; csv: string },
): Promise<StudentImportResult> {
  return api(`${school(schoolId)}/students/import`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/* ----------------------------- account security --------------------------- */

export function requestPasswordReset(
  email: string,
): Promise<{ delivered: boolean; message: string; devToken?: string }> {
  return api('/api/auth/password/forgot', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

export function resetPassword(token: string, newPassword: string): Promise<void> {
  return api('/api/auth/password/reset', {
    method: 'POST',
    body: JSON.stringify({ token, newPassword }),
  });
}

export function getMfaStatus(): Promise<{
  enabled: boolean;
  configured: boolean;
  confirmedAt: string | null;
}> {
  return api('/api/auth/mfa');
}

export function setupMfa(): Promise<{ secret: string; otpauthUrl: string }> {
  return api('/api/auth/mfa/setup', { method: 'POST' });
}

export function enableMfa(code: string): Promise<void> {
  return api('/api/auth/mfa/enable', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
}

export function disableMfa(password: string, code: string): Promise<void> {
  return api('/api/auth/mfa/disable', {
    method: 'POST',
    body: JSON.stringify({ password, code }),
  });
}

/* ---------------------------------- school -------------------------------- */

export function getOverview(schoolId: string): Promise<SchoolOverview> {
  return api(`${school(schoolId)}/overview`);
}

export function listAuditEvents(
  schoolId: string,
  page: number,
  pageSize = 25,
): Promise<Paginated<AuditEvent>> {
  return api(`${school(schoolId)}/audit-events${queryString({ page, pageSize })}`);
}

/* ----------------------------- staff attendance --------------------------- */

export function listStaffShifts(schoolId: string): Promise<{ items: StaffShift[] }> {
  return api(`${school(schoolId)}/staff/shifts`);
}

export function createStaffShift(
  schoolId: string,
  input: Omit<StaffShift, 'id'>,
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/staff/shifts`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateStaffShift(
  schoolId: string,
  id: string,
  input: Partial<Omit<StaffShift, 'id'>>,
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/staff/shifts/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function listStaffAttendance(
  schoolId: string,
  filters: {
    from?: string;
    to?: string;
    staffId?: string;
    status?: string;
  } = {},
): Promise<{ items: StaffAttendanceRecord[] }> {
  return api(`${school(schoolId)}/staff/attendance${queryString(filters)}`);
}

export function recordStaffAttendance(
  schoolId: string,
  input: {
    staffId: string;
    workDate: string;
    shiftId?: string | null;
    punchIn?: string | null;
    punchOut?: string | null;
    status?: string;
    note?: string;
  },
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/staff/attendance`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function getStaffAttendanceSummary(
  schoolId: string,
  filters: { from?: string; to?: string } = {},
): Promise<StaffAttendanceSummary> {
  return api(`${school(schoolId)}/staff/attendance/summary${queryString(filters)}`);
}

export function listStaffAttendanceCorrections(
  schoolId: string,
  status?: string,
): Promise<{ items: StaffAttendanceCorrection[] }> {
  return api(`${school(schoolId)}/staff/attendance/corrections${queryString({ status })}`);
}

export function requestStaffAttendanceCorrection(
  schoolId: string,
  attendanceId: string,
  input: {
    requestedStatus?: string;
    requestedPunchIn?: string | null;
    requestedPunchOut?: string | null;
    reason: string;
  },
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/staff/attendance/${attendanceId}/corrections`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function reviewStaffAttendanceCorrection(
  schoolId: string,
  id: string,
  input: { decision: 'approve' | 'reject'; note?: string },
): Promise<{ id: string; status: string }> {
  return api(`${school(schoolId)}/staff/attendance/corrections/${id}/review`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function getStaffAttendanceSettings(
  schoolId: string,
): Promise<StaffAttendanceSettings> {
  return api(`${school(schoolId)}/staff/attendance/settings`);
}

export function saveStaffAttendanceSettings(
  schoolId: string,
  input: StaffAttendanceSettings,
): Promise<StaffAttendanceSettings> {
  return api(`${school(schoolId)}/staff/attendance/settings`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

/* -------------------------------- recruitment ----------------------------- */

export function listVacancies(
  schoolId: string,
  status?: string,
): Promise<{ items: Vacancy[] }> {
  return api(`${school(schoolId)}/vacancies${queryString({ status })}`);
}

export function createVacancy(
  schoolId: string,
  input: {
    reference?: string;
    title: string;
    department?: string;
    designation: string;
    employmentType?: string;
    openings?: number;
    description?: string;
    status?: string;
    postedOn?: string | null;
    closesOn?: string | null;
  },
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/vacancies`, { method: 'POST', body: JSON.stringify(input) });
}

export function updateVacancy(
  schoolId: string,
  id: string,
  input: Record<string, unknown>,
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/vacancies/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function listCandidates(
  schoolId: string,
  filters: { vacancyId?: string; stage?: string } = {},
): Promise<{ items: Candidate[] }> {
  return api(`${school(schoolId)}/candidates${queryString(filters)}`);
}

export function createCandidate(
  schoolId: string,
  input: {
    vacancyId: string;
    firstName: string;
    lastName?: string;
    email: string;
    phone?: string;
    source?: string;
    notes?: string;
    appliedOn?: string;
  },
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/candidates`, { method: 'POST', body: JSON.stringify(input) });
}

export function setCandidateStage(
  schoolId: string,
  id: string,
  stage: string,
): Promise<{ id: string; stage: string }> {
  return api(`${school(schoolId)}/candidates/${id}/stage`, {
    method: 'PATCH',
    body: JSON.stringify({ stage }),
  });
}

export function listCandidateInterviews(
  schoolId: string,
  candidateId: string,
): Promise<{ items: CandidateInterview[] }> {
  return api(`${school(schoolId)}/candidates/${candidateId}/interviews`);
}

export function createCandidateInterview(
  schoolId: string,
  candidateId: string,
  input: { scheduledAt: string; mode: string; interviewerUserId: string },
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/candidates/${candidateId}/interviews`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function recordInterviewOutcome(
  schoolId: string,
  id: string,
  input: {
    status: 'completed' | 'cancelled';
    score?: number;
    recommendation?: string;
    feedback?: string;
  },
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/interviews/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function listJobOffers(schoolId: string): Promise<{ items: JobOffer[] }> {
  return api(`${school(schoolId)}/job-offers`);
}

export function createJobOffer(
  schoolId: string,
  input: {
    candidateId: string;
    designation: string;
    department?: string;
    grossSalary: number;
    currency?: string;
    startsOn: string;
    notes?: string;
  },
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/job-offers`, { method: 'POST', body: JSON.stringify(input) });
}

export function decideJobOffer(
  schoolId: string,
  id: string,
  input: { decision: string; note?: string },
): Promise<{ id: string; status: string }> {
  return api(`${school(schoolId)}/job-offers/${id}/decision`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function hireCandidate(
  schoolId: string,
  offerId: string,
  input: { employeeNumber?: string; joinedOn?: string } = {},
): Promise<{ id: string; staffId: string }> {
  return api(`${school(schoolId)}/job-offers/${offerId}/hire`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function listOnboardingTasks(
  schoolId: string,
  staffId?: string,
): Promise<{ items: OnboardingTask[] }> {
  return api(`${school(schoolId)}/onboarding-tasks${queryString({ staffId })}`);
}

export function createOnboardingTask(
  schoolId: string,
  input: { staffId: string; title: string; ownerUserId?: string | null; dueOn?: string | null },
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/onboarding-tasks`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function setOnboardingTaskStatus(
  schoolId: string,
  id: string,
  status: 'pending' | 'done' | 'cancelled',
): Promise<{ id: string; status: string }> {
  return api(`${school(schoolId)}/onboarding-tasks/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

export function listEmployeeChanges(
  schoolId: string,
  staffId?: string,
): Promise<{ items: EmployeeChange[] }> {
  return api(`${school(schoolId)}/employee-changes${queryString({ staffId })}`);
}

export function createEmployeeChange(
  schoolId: string,
  input: {
    staffId: string;
    changeType: string;
    effectiveOn: string;
    toValue: string;
    notes?: string;
  },
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/employee-changes`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function listSeparations(schoolId: string): Promise<{ items: StaffSeparation[] }> {
  return api(`${school(schoolId)}/separations`);
}

export function createSeparation(
  schoolId: string,
  input: {
    staffId: string;
    lastWorkingDay: string;
    reason: string;
    notes?: string;
    exitTasks?: string[];
  },
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/separations`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function decideSeparation(
  schoolId: string,
  id: string,
  input: { decision: string; note?: string },
): Promise<{ id: string; status: string }> {
  return api(`${school(schoolId)}/separations/${id}/decision`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function setExitTaskStatus(
  schoolId: string,
  id: string,
  status: 'pending' | 'done' | 'cancelled',
): Promise<{ id: string; status: string }> {
  return api(`${school(schoolId)}/exit-tasks/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

/* -------------------------------- procurement ----------------------------- */

export function listVendors(
  schoolId: string,
  status?: string,
): Promise<{ items: Vendor[] }> {
  return api(`${school(schoolId)}/vendors${queryString({ status })}`);
}

export function createVendor(
  schoolId: string,
  input: {
    code?: string;
    name: string;
    contactName?: string;
    email?: string;
    phone?: string;
    address?: string;
    status?: string;
    notes?: string;
  },
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/vendors`, { method: 'POST', body: JSON.stringify(input) });
}

export function updateVendor(
  schoolId: string,
  id: string,
  input: Record<string, unknown>,
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/vendors/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function listBudgets(
  schoolId: string,
  academicYearId?: string,
): Promise<{ items: ProcurementBudget[] }> {
  return api(`${school(schoolId)}/procurement-budgets${queryString({ academicYearId })}`);
}

export function createBudget(
  schoolId: string,
  input: {
    academicYearId: string;
    code?: string;
    name: string;
    department?: string;
    allocatedAmount: number;
    active?: boolean;
  },
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/procurement-budgets`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateBudget(
  schoolId: string,
  id: string,
  input: Record<string, unknown>,
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/procurement-budgets/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function listPurchaseRequests(
  schoolId: string,
  status?: string,
): Promise<{ items: PurchaseRequest[] }> {
  return api(`${school(schoolId)}/purchase-requests${queryString({ status })}`);
}

export function createPurchaseRequest(
  schoolId: string,
  input: {
    title: string;
    department?: string;
    justification?: string;
    neededBy?: string | null;
    items: Array<{ description: string; quantity: number; estimatedUnitPrice: number }>;
  },
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/purchase-requests`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function decidePurchaseRequest(
  schoolId: string,
  id: string,
  input: { decision: 'submit' | 'approve' | 'reject' | 'cancel'; note?: string },
): Promise<{ id: string; status: string }> {
  return api(`${school(schoolId)}/purchase-requests/${id}/decision`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function listPurchaseOrders(
  schoolId: string,
  status?: string,
): Promise<{ items: PurchaseOrder[] }> {
  return api(`${school(schoolId)}/purchase-orders${queryString({ status })}`);
}

export function createPurchaseOrder(
  schoolId: string,
  input: {
    vendorId: string;
    requestId?: string | null;
    orderDate?: string;
    expectedOn?: string | null;
    notes?: string;
    items: Array<{ description: string; quantity: number; unitPrice: number }>;
  },
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/purchase-orders`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function decidePurchaseOrder(
  schoolId: string,
  id: string,
  input: { decision: 'approve' | 'cancel'; note?: string },
): Promise<{ id: string; status: string }> {
  return api(`${school(schoolId)}/purchase-orders/${id}/decision`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function createGoodsReceipt(
  schoolId: string,
  input: {
    poId: string;
    receivedOn?: string;
    notes?: string;
    items: Array<{ poItemId: string; quantity: number; discrepancyNote?: string }>;
  },
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/goods-receipts`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function listVendorBills(
  schoolId: string,
  status?: string,
): Promise<{ items: VendorBill[] }> {
  return api(`${school(schoolId)}/vendor-bills${queryString({ status })}`);
}

export function createVendorBill(
  schoolId: string,
  input: {
    vendorId: string;
    poId?: string | null;
    billNumber: string;
    billDate: string;
    dueOn?: string | null;
    amount: number;
    notes?: string;
  },
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/vendor-bills`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function decideVendorBill(
  schoolId: string,
  id: string,
  input: { decision: 'approve' | 'reject'; note?: string },
): Promise<{ id: string; status: string }> {
  return api(`${school(schoolId)}/vendor-bills/${id}/decision`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function payVendorBill(
  schoolId: string,
  id: string,
  paidOn: string,
): Promise<{ id: string; status: string }> {
  return api(`${school(schoolId)}/vendor-bills/${id}/pay`, {
    method: 'POST',
    body: JSON.stringify({ paidOn }),
  });
}

export function listProcurementExpenses(
  schoolId: string,
): Promise<{ items: ProcurementExpense[] }> {
  return api(`${school(schoolId)}/procurement-expenses`);
}

export function createProcurementExpense(
  schoolId: string,
  input: {
    budgetId: string;
    vendorId?: string | null;
    poId?: string | null;
    billId?: string | null;
    description: string;
    amount: number;
    spentOn: string;
  },
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/procurement-expenses`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function decideProcurementExpense(
  schoolId: string,
  id: string,
  input: { decision: 'approve' | 'reject'; note?: string },
): Promise<{ id: string; status: string }> {
  return api(`${school(schoolId)}/procurement-expenses/${id}/decision`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/* --------------------------------- transport ------------------------------ */

export function listVehicles(schoolId: string): Promise<{ items: TransportVehicle[] }> {
  return api(`${school(schoolId)}/transport/vehicles`);
}

export function createVehicle(
  schoolId: string,
  input: {
    registrationNumber: string;
    model?: string;
    capacity: number;
    status?: string;
    insuranceExpiresOn?: string | null;
    notes?: string;
  },
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/transport/vehicles`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateVehicle(
  schoolId: string,
  id: string,
  input: Record<string, unknown>,
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/transport/vehicles/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function listDrivers(schoolId: string): Promise<{ items: TransportDriver[] }> {
  return api(`${school(schoolId)}/transport/drivers`);
}

export function createDriver(
  schoolId: string,
  input: {
    staffId?: string | null;
    fullName: string;
    phone?: string;
    licenceNumber?: string;
    licenceExpiresOn?: string | null;
    status?: string;
  },
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/transport/drivers`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateDriver(
  schoolId: string,
  id: string,
  input: Record<string, unknown>,
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/transport/drivers/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function listTransportRoutes(
  schoolId: string,
): Promise<{ items: TransportRoute[] }> {
  return api(`${school(schoolId)}/transport/routes`);
}

export function createTransportRoute(
  schoolId: string,
  input: Record<string, unknown>,
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/transport/routes`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateTransportRoute(
  schoolId: string,
  id: string,
  input: Record<string, unknown>,
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/transport/routes/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function listTransportAllocations(
  schoolId: string,
  filters: { routeId?: string; studentId?: string; activeOnly?: boolean } = {},
): Promise<{ items: StudentTransportAllocation[] }> {
  return api(
    `${school(schoolId)}/transport/allocations${queryString({
      routeId: filters.routeId,
      studentId: filters.studentId,
      activeOnly:
        filters.activeOnly === undefined ? undefined : filters.activeOnly ? 'true' : 'false',
    })}`,
  );
}

export function allocateTransport(
  schoolId: string,
  input: { studentId: string; routeId: string; stopId: string; effectiveFrom?: string },
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/transport/allocations`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function endTransportAllocation(
  schoolId: string,
  id: string,
  input: { effectiveTo?: string } = {},
): Promise<{ id: string; status: string }> {
  return api(`${school(schoolId)}/transport/allocations/${id}/end`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function listTransportMaintenance(
  schoolId: string,
): Promise<{ items: TransportMaintenance[] }> {
  return api(`${school(schoolId)}/transport/maintenance`);
}

export function createTransportMaintenance(
  schoolId: string,
  input: {
    vehicleId: string;
    performedOn: string;
    description: string;
    cost?: number;
    status?: string;
    vendorName?: string;
  },
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/transport/maintenance`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/* ---------------------------------- library ------------------------------- */

export function listLibraryCategories(
  schoolId: string,
): Promise<{ items: LibraryCategory[] }> {
  return api(`${school(schoolId)}/library/categories`);
}

export function createLibraryCategory(
  schoolId: string,
  input: { code: string; name: string },
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/library/categories`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function listLibraryBooks(
  schoolId: string,
  filters: { categoryId?: string; search?: string; status?: string } = {},
): Promise<{ items: LibraryBook[] }> {
  return api(`${school(schoolId)}/library/books${queryString(filters)}`);
}

export function createLibraryBook(
  schoolId: string,
  input: Record<string, unknown>,
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/library/books`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateLibraryBook(
  schoolId: string,
  id: string,
  input: Record<string, unknown>,
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/library/books/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function listLibraryCopies(
  schoolId: string,
  bookId: string,
): Promise<{ items: LibraryCopy[] }> {
  return api(`${school(schoolId)}/library/books/${bookId}/copies`);
}

export function createLibraryCopy(
  schoolId: string,
  bookId: string,
  input: { accessionNumber: string; acquiredOn?: string; notes?: string },
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/library/books/${bookId}/copies`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function listLibraryMembers(
  schoolId: string,
  search?: string,
): Promise<{ items: LibraryMember[] }> {
  return api(`${school(schoolId)}/library/members${queryString({ search })}`);
}

export function createLibraryMember(
  schoolId: string,
  input: {
    memberCode?: string;
    studentId?: string | null;
    staffId?: string | null;
    borrowingLimit?: number;
    status?: string;
  },
): Promise<{ id: string; memberCode: string }> {
  return api(`${school(schoolId)}/library/members`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateLibraryMember(
  schoolId: string,
  id: string,
  input: Record<string, unknown>,
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/library/members/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function listLibraryLoans(
  schoolId: string,
  filters: { status?: string; memberId?: string; openOnly?: boolean } = {},
): Promise<{ items: LibraryLoan[] }> {
  return api(
    `${school(schoolId)}/library/loans${queryString({
      status: filters.status,
      memberId: filters.memberId,
      openOnly:
        filters.openOnly === undefined ? undefined : filters.openOnly ? 'true' : 'false',
    })}`,
  );
}

export function issueLibraryLoan(
  schoolId: string,
  input: { copyId: string; memberId: string; dueOn?: string },
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/library/loans`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function returnLibraryLoan(
  schoolId: string,
  id: string,
  input: { returnedOn?: string; condition?: string; notes?: string } = {},
): Promise<{ id: string; status: string }> {
  return api(`${school(schoolId)}/library/loans/${id}/return`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function renewLibraryLoan(
  schoolId: string,
  id: string,
): Promise<{ id: string; dueOn: string }> {
  return api(`${school(schoolId)}/library/loans/${id}/renew`, { method: 'POST' });
}

export function listLibraryFines(
  schoolId: string,
  status?: string,
): Promise<{ items: LibraryFine[] }> {
  return api(`${school(schoolId)}/library/fines${queryString({ status })}`);
}

export function createLibraryFine(
  schoolId: string,
  input: { loanId: string; amount: number; reason: string; notes?: string },
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/library/fines`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function decideLibraryFine(
  schoolId: string,
  id: string,
  decision: 'pay' | 'waive',
): Promise<{ id: string; status: string }> {
  return api(`${school(schoolId)}/library/fines/${id}/decision`, {
    method: 'POST',
    body: JSON.stringify({ decision }),
  });
}

export function listLibraryReservations(
  schoolId: string,
): Promise<{ items: LibraryReservation[] }> {
  return api(`${school(schoolId)}/library/reservations`);
}

export function createLibraryReservation(
  schoolId: string,
  input: { bookId: string; memberId: string; expiresOn?: string | null },
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/library/reservations`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateLibraryReservation(
  schoolId: string,
  id: string,
  status: string,
): Promise<{ id: string; status: string }> {
  return api(`${school(schoolId)}/library/reservations/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

export function getLibrarySettings(schoolId: string): Promise<LibrarySettings> {
  return api(`${school(schoolId)}/library/settings`);
}

export function saveLibrarySettings(
  schoolId: string,
  input: LibrarySettings,
): Promise<LibrarySettings> {
  return api(`${school(schoolId)}/library/settings`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

/* --------------------------------- learning ------------------------------- */

export function listLearningResources(
  schoolId: string,
  filters: { status?: string; classId?: string; subjectId?: string; resourceType?: string } = {},
): Promise<{ items: LearningResource[] }> {
  return api(`${school(schoolId)}/learning/resources${queryString(filters)}`);
}

export function createLearningResource(
  schoolId: string,
  input: Record<string, unknown>,
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/learning/resources`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateLearningResource(
  schoolId: string,
  id: string,
  input: Record<string, unknown>,
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/learning/resources/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function uploadLearningAttachment(
  schoolId: string,
  resourceId: string,
  input: { filename: string; contentType: string; dataBase64: string },
): Promise<{ id: string; byteSize: number }> {
  return api(`${school(schoolId)}/learning/resources/${resourceId}/attachments`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function learningAttachmentUrl(schoolId: string, attachmentId: string): string {
  return `${school(schoolId)}/learning/attachments/${attachmentId}/download`;
}

export function deleteLearningAttachment(
  schoolId: string,
  attachmentId: string,
): Promise<void> {
  return api(`${school(schoolId)}/learning/attachments/${attachmentId}`, {
    method: 'DELETE',
  });
}

export function listHomework(
  schoolId: string,
  filters: { status?: string; sectionId?: string; subjectId?: string } = {},
): Promise<{ items: HomeworkAssignment[] }> {
  return api(`${school(schoolId)}/learning/homework${queryString(filters)}`);
}

export function createHomework(
  schoolId: string,
  input: {
    academicYearId: string;
    sectionId: string;
    subjectId: string;
    title: string;
    instructions: string;
    availableFrom?: string | null;
    dueAt: string;
    maxMarks?: number | null;
    allowResubmission?: boolean;
  },
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/learning/homework`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function setHomeworkStatus(
  schoolId: string,
  id: string,
  status: 'draft' | 'published' | 'closed',
): Promise<{ id: string; status: string }> {
  return api(`${school(schoolId)}/learning/homework/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

export function listHomeworkSubmissions(
  schoolId: string,
  assignmentId: string,
  studentId?: string,
): Promise<{ items: HomeworkSubmission[] }> {
  return api(
    `${school(schoolId)}/learning/homework/${assignmentId}/submissions${queryString({
      studentId,
    })}`,
  );
}

export function submitHomework(
  schoolId: string,
  assignmentId: string,
  input: {
    studentId: string;
    content?: string;
    attachmentName?: string;
    attachmentType?: string;
    attachmentBase64?: string;
  },
): Promise<{ id: string; attempt: number; status: string }> {
  return api(`${school(schoolId)}/learning/homework/${assignmentId}/submissions`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function reviewHomeworkSubmission(
  schoolId: string,
  id: string,
  input: { status: 'reviewed' | 'returned'; marks?: number | null; feedback?: string },
): Promise<{ id: string; status: string }> {
  return api(`${school(schoolId)}/learning/submissions/${id}/review`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function listQuestionBank(
  schoolId: string,
  filters: { subjectId?: string; difficulty?: string } = {},
): Promise<{ items: QuestionBankItem[] }> {
  return api(`${school(schoolId)}/learning/questions${queryString(filters)}`);
}

export function createQuestion(
  schoolId: string,
  input: {
    subjectId: string;
    topic?: string;
    questionType?: string;
    difficulty?: string;
    questionText: string;
    answerText?: string;
    marks?: number | null;
  },
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/learning/questions`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function deleteQuestion(schoolId: string, id: string): Promise<void> {
  return api(`${school(schoolId)}/learning/questions/${id}`, { method: 'DELETE' });
}

/* --------------------------------- concerns ------------------------------- */

export function listConcernCategories(
  schoolId: string,
): Promise<{ items: ConcernCategory[] }> {
  return api(`${school(schoolId)}/concerns/categories`);
}

export function createConcernCategory(
  schoolId: string,
  input: { code: string; name: string; defaultPriority?: string; slaHours?: number; active?: boolean },
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/concerns/categories`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateConcernCategory(
  schoolId: string,
  id: string,
  input: Record<string, unknown>,
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/concerns/categories/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function listConcerns(
  schoolId: string,
  filters: {
    status?: string;
    priority?: string;
    assignedTo?: string;
    categoryId?: string;
    mine?: boolean;
    overdue?: boolean;
    search?: string;
  } = {},
): Promise<{ items: Concern[] }> {
  return api(
    `${school(schoolId)}/concerns${queryString({
      status: filters.status,
      priority: filters.priority,
      assignedTo: filters.assignedTo,
      categoryId: filters.categoryId,
      mine: filters.mine === undefined ? undefined : filters.mine ? 'true' : 'false',
      overdue: filters.overdue === undefined ? undefined : filters.overdue ? 'true' : 'false',
      search: filters.search,
    })}`,
  );
}

export function getConcern(
  schoolId: string,
  id: string,
): Promise<Concern & { attachments: Array<{ id: string; filename: string; contentType: string; byteSize: number; isInternal: boolean; createdAt: string }> }> {
  return api(`${school(schoolId)}/concerns/${id}`);
}

export function createConcern(
  schoolId: string,
  input: {
    categoryId?: string | null;
    subject: string;
    description: string;
    studentId?: string | null;
    priority?: string;
    visibility?: string;
    requesterName?: string;
    requesterEmail?: string;
  },
): Promise<{ id: string; reference: string; priority: string; slaDueAt: string }> {
  return api(`${school(schoolId)}/concerns`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateConcern(
  schoolId: string,
  id: string,
  input: Record<string, unknown>,
): Promise<{ id: string; status: string; priority: string }> {
  return api(`${school(schoolId)}/concerns/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function escalateConcern(
  schoolId: string,
  id: string,
  note?: string,
): Promise<{ id: string; priority: string }> {
  return api(`${school(schoolId)}/concerns/${id}/escalate`, {
    method: 'POST',
    body: JSON.stringify({ note }),
  });
}

export function addConcernNote(
  schoolId: string,
  id: string,
  input: { note: string; isInternal?: boolean },
): Promise<{ id: string; isInternal: boolean }> {
  return api(`${school(schoolId)}/concerns/${id}/notes`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function uploadConcernAttachment(
  schoolId: string,
  id: string,
  input: { filename: string; contentType: string; dataBase64: string; isInternal?: boolean },
): Promise<{ id: string; byteSize: number }> {
  return api(`${school(schoolId)}/concerns/${id}/attachments`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function concernAttachmentUrl(
  schoolId: string,
  concernId: string,
  attachmentId: string,
): string {
  return `${school(schoolId)}/concerns/${concernId}/attachments/${attachmentId}/download`;
}

/* ------------------------------- notifications ---------------------------- */

export function listInbox(
  schoolId: string,
  unreadOnly?: boolean,
): Promise<{ items: InAppNotification[]; unread: number }> {
  return api(
    `${school(schoolId)}/notifications${queryString({
      unreadOnly: unreadOnly === undefined ? undefined : unreadOnly ? 'true' : 'false',
    })}`,
  );
}

export function markNotificationRead(
  schoolId: string,
  id: string,
): Promise<{ id: string; readAt: string | null }> {
  return api(`${school(schoolId)}/notifications/${id}/read`, { method: 'POST' });
}

export function markAllNotificationsRead(schoolId: string): Promise<{ marked: number }> {
  return api(`${school(schoolId)}/notifications/read-all`, { method: 'POST' });
}

export function sendInAppNotification(
  schoolId: string,
  input: {
    userId: string;
    title: string;
    body: string;
    link?: string;
    category?: string;
    dedupeKey?: string;
  },
): Promise<{ id: string; deduplicated: boolean }> {
  return api(`${school(schoolId)}/notifications/in-app`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function listNotificationTemplates(
  schoolId: string,
): Promise<{ items: NotificationTemplate[] }> {
  return api(`${school(schoolId)}/notifications/templates`);
}

export function createNotificationTemplate(
  schoolId: string,
  input: { code: string; channel: string; subject?: string; body: string; active?: boolean },
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/notifications/templates`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateNotificationTemplate(
  schoolId: string,
  id: string,
  input: Record<string, unknown>,
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/notifications/templates/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function listNotificationPreferences(
  schoolId: string,
): Promise<{ items: NotificationPreference[] }> {
  return api(`${school(schoolId)}/notifications/preferences`);
}

export function saveNotificationPreference(
  schoolId: string,
  input: { channel: string; enabled: boolean; consent?: boolean },
): Promise<{ channel: string; enabled: boolean; consentGivenAt: string | null }> {
  return api(`${school(schoolId)}/notifications/preferences`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export function getNotificationProviderStatus(
  schoolId: string,
): Promise<NotificationProviderStatus> {
  return api(`${school(schoolId)}/notifications/provider-status`);
}

export function listNotificationOutbox(
  schoolId: string,
  filters: { status?: string; channel?: string } = {},
): Promise<{ items: NotificationOutboxRecord[] }> {
  return api(`${school(schoolId)}/notifications/outbox${queryString(filters)}`);
}

export function getNotificationOutboxRecord(
  schoolId: string,
  id: string,
): Promise<
  NotificationOutboxRecord & {
    attemptsLog: Array<{
      attemptNo: number;
      outcome: string;
      provider: string | null;
      error: string | null;
      occurredAt: string;
    }>;
  }
> {
  return api(`${school(schoolId)}/notifications/outbox/${id}`);
}

export function queueNotification(
  schoolId: string,
  input: {
    channel: string;
    recipientUserId?: string;
    recipientAddress: string;
    templateCode?: string;
    subject?: string;
    body: string;
    dedupeKey?: string;
  },
): Promise<{ id: string; status: string; deduplicated: boolean }> {
  return api(`${school(schoolId)}/notifications/outbox`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function sendNotification(schoolId: string, id: string): Promise<{ id: string; status: string }> {
  return api(`${school(schoolId)}/notifications/outbox/${id}/send`, { method: 'POST' });
}

export function dispatchNotifications(
  schoolId: string,
): Promise<{ attempted: number; sent: number; failed: number; blocked: number }> {
  return api(`${school(schoolId)}/notifications/outbox/dispatch`, { method: 'POST' });
}

/* ------------------------------- reconciliation --------------------------- */

export function listConcessions(
  schoolId: string,
  status?: string,
): Promise<{ items: FeeConcessionRequest[] }> {
  return api(`${school(schoolId)}/fees/concessions${queryString({ status })}`);
}

export function requestConcession(
  schoolId: string,
  input: { studentId: string; academicYearId: string; chargeId: string; amount: number; reason: string },
): Promise<{ id: string; status: string }> {
  return api(`${school(schoolId)}/fees/concessions`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function decideConcession(
  schoolId: string,
  id: string,
  input: { decision: 'approve' | 'reject'; note?: string },
): Promise<{ id: string; status: string }> {
  return api(`${school(schoolId)}/fees/concessions/${id}/decision`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function listWriteOffs(schoolId: string): Promise<{ items: FeeWriteOff[] }> {
  return api(`${school(schoolId)}/fees/write-offs`);
}

export function createWriteOff(
  schoolId: string,
  input: { chargeId: string; amount: number; reason: string },
): Promise<{ id: string; amount: number }> {
  return api(`${school(schoolId)}/fees/write-offs`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function listReconciliationBatches(
  schoolId: string,
  status?: string,
): Promise<{ items: ReconciliationBatch[] }> {
  return api(`${school(schoolId)}/fees/reconciliation/batches${queryString({ status })}`);
}

export function getReconciliationBatch(
  schoolId: string,
  id: string,
): Promise<ReconciliationBatch & { lines: ReconciliationLine[] }> {
  return api(`${school(schoolId)}/fees/reconciliation/batches/${id}`);
}

export function createReconciliationBatch(
  schoolId: string,
  input: {
    reference: string;
    source?: string;
    statementFrom?: string | null;
    statementTo?: string | null;
    openingBalance?: number | null;
    closingBalance?: number | null;
    notes?: string;
  },
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/fees/reconciliation/batches`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function addReconciliationLine(
  schoolId: string,
  batchId: string,
  input: { paidOn: string; amount: number; reference?: string; method?: string },
): Promise<{ id: string; lineNo: number }> {
  return api(`${school(schoolId)}/fees/reconciliation/batches/${batchId}/lines`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function matchReconciliationLine(
  schoolId: string,
  batchId: string,
  lineId: string,
  input: { paymentId?: string | null; exceptionReason?: string },
): Promise<{ id: string; status: string }> {
  return api(`${school(schoolId)}/fees/reconciliation/batches/${batchId}/lines/${lineId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function deleteReconciliationLine(
  schoolId: string,
  batchId: string,
  lineId: string,
): Promise<void> {
  return api(`${school(schoolId)}/fees/reconciliation/batches/${batchId}/lines/${lineId}`, {
    method: 'DELETE',
  });
}

export function closeReconciliationBatch(
  schoolId: string,
  id: string,
  note?: string,
): Promise<{ id: string; status: string }> {
  return api(`${school(schoolId)}/fees/reconciliation/batches/${id}/close`, {
    method: 'POST',
    body: JSON.stringify({ note }),
  });
}

export function listReconciliationPayments(
  schoolId: string,
  filters: { search?: string; from?: string; to?: string } = {},
): Promise<{
  items: Array<{
    id: string;
    receiptNumber: string;
    studentName: string;
    admissionNumber: string;
    amount: number;
    method: string;
    reference: string | null;
    paidOn: string;
    matched: boolean;
  }>;
}> {
  return api(`${school(schoolId)}/fees/reconciliation/payments${queryString(filters)}`);
}

/* -------------------------- saved reports and imports --------------------- */

export function listSavedReports(
  schoolId: string,
  reportType?: string,
): Promise<{ items: SavedReport[] }> {
  return api(`${school(schoolId)}/saved-reports${queryString({ reportType })}`);
}

export function createSavedReport(
  schoolId: string,
  input: {
    name: string;
    reportType: 'students' | 'attendance' | 'fees';
    filters: Record<string, string>;
    shared?: boolean;
  },
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/saved-reports`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateSavedReport(
  schoolId: string,
  id: string,
  input: Record<string, unknown>,
): Promise<{ id: string }> {
  return api(`${school(schoolId)}/saved-reports/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function deleteSavedReport(schoolId: string, id: string): Promise<void> {
  return api(`${school(schoolId)}/saved-reports/${id}`, { method: 'DELETE' });
}

export function listImports(
  schoolId: string,
  filters: { entityType?: string; status?: string } = {},
): Promise<{ items: ImportBatch[] }> {
  return api(`${school(schoolId)}/imports${queryString(filters)}`);
}

export function getImport(
  schoolId: string,
  id: string,
): Promise<ImportBatch & { rows: ImportRow[] }> {
  return api(`${school(schoolId)}/imports/${id}`);
}

export function previewImport(
  schoolId: string,
  input: { entityType: 'students' | 'library_books' | 'vendors'; filename: string; csv: string },
): Promise<{ id: string; totalRows: number; validRows: number; invalidRows: number }> {
  return api(`${school(schoolId)}/imports/preview`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function commitImport(
  schoolId: string,
  id: string,
): Promise<{ id: string; created: number; status: string }> {
  return api(`${school(schoolId)}/imports/${id}/commit`, { method: 'POST' });
}

export function cancelImport(
  schoolId: string,
  id: string,
): Promise<{ id: string; status: string }> {
  return api(`${school(schoolId)}/imports/${id}/cancel`, { method: 'POST' });
}
