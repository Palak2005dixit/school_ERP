import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { StudentDetail } from '@erp/shared';
import { useAuth, useSchoolId, useSchoolTimezone } from '../auth/AuthContext';
import {
  enrollStudent,
  getStudent,
  linkGuardian,
  listAcademicYears,
  listClasses,
  listSections,
  updateStudent,
} from '../lib/endpoints';
import { errorMessage, fieldErrors } from '../lib/api';
import { formatDate, formatDateTime, fullName, todayIso } from '../lib/format';
import { GUARDIAN_PORTAL_STATUSES, RELATIONSHIP_TYPES, STUDENT_STATUSES } from '../lib/statuses';
import { Dialog } from '../components/Dialog';
import { useToast } from '../components/ToastProvider';
import { GuardianStatusBadge, StudentStatusBadge } from '../components/StatusBadges';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  Input,
  PageHeader,
  Select,
  TableSkeleton,
} from '../components/ui';

export function StudentDetailPage(): ReactNode {
  const schoolId = useSchoolId();
  const timeZone = useSchoolTimezone();
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<'edit' | 'guardian' | 'enroll' | null>(null);

  const student = useQuery({
    queryKey: ['student', schoolId, id],
    queryFn: () => getStudent(schoolId, id!),
    enabled: Boolean(id),
  });

  if (!id) return <ErrorState message="Missing student identifier." />;

  if (student.isPending) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-56 animate-pulse rounded bg-slate-200" />
        <Card>
          <TableSkeleton rows={5} columns={3} />
        </Card>
      </div>
    );
  }

  if (student.isError) {
    return (
      <div className="space-y-4">
        <Link to="/students" className="text-sm text-brand-700 hover:underline">
          ← Back to students
        </Link>
        <ErrorState message={errorMessage(student.error)} onRetry={() => void student.refetch()} />
      </div>
    );
  }

  const record = student.data;
  const name = fullName(record.firstName, record.middleName, record.lastName);
  const activeEnrollment = record.enrollments.find((entry) => entry.enrollmentStatus === 'active');

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['student', schoolId, id] });
    void queryClient.invalidateQueries({ queryKey: ['students', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['overview', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['sections', schoolId] });
  };

  return (
    <div className="space-y-6">
      <div>
        <Link to="/students" className="text-sm text-brand-700 hover:underline">
          ← Back to students
        </Link>
      </div>

      <PageHeader
        title={name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-slate-500">{record.admissionNumber}</span>
            <StudentStatusBadge status={record.status} />
            {activeEnrollment ? (
              <span className="text-sm text-slate-500">
                {activeEnrollment.className} · {activeEnrollment.sectionName} ·{' '}
                {activeEnrollment.academicYearName}
              </span>
            ) : (
              <Badge tone="warning">Not enrolled</Badge>
            )}
          </span>
        }
        actions={
          <>
            {can('students.profile.edit') && (
              <Button variant="secondary" onClick={() => setDialog('edit')}>
                Edit profile
              </Button>
            )}
            {can('students.admission.create') && (
              <Button variant="secondary" onClick={() => setDialog('enroll')}>
                Enroll
              </Button>
            )}
            {can('students.guardian.manage') && (
              <Button onClick={() => setDialog('guardian')}>
                <Icon name="plus" className="h-4 w-4" />
                Link guardian
              </Button>
            )}
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_1.25fr]">
        <Card>
          <CardHeader title="Profile" description="Core identity fields" />
          <dl className="divide-y divide-slate-100">
            <Row label="Legal name" value={name} />
            <Row label="Date of birth" value={formatDate(record.dateOfBirth)} />
            <Row label="Admission number" value={<span className="font-mono text-xs">{record.admissionNumber}</span>} />
            <Row label="Status" value={<StudentStatusBadge status={record.status} />} />
            <Row label="Created" value={formatDateTime(record.createdAt, timeZone)} />
          </dl>
        </Card>

        <Card>
          <CardHeader
            title={`Guardians (${record.guardians.length})`}
            description="Portal access is granted per guardian link, only when verified."
          />
          {record.guardians.length === 0 ? (
            <EmptyState
              title="No guardians linked"
              description="Link at least one guardian so the student record has a contact."
              icon="users"
            />
          ) : (
            <ul className="divide-y divide-slate-100">
              {record.guardians.map((guardian) => (
                <li key={guardian.id} className="px-5 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium text-slate-900">
                      {fullName(guardian.firstName, null, guardian.lastName)}
                    </p>
                    {guardian.isPrimary && <Badge tone="brand">Primary</Badge>}
                    <GuardianStatusBadge status={guardian.portalAccessStatus} />
                    <span className="text-xs text-slate-500 capitalize">{guardian.relationshipType}</span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {[guardian.email, guardian.phone].filter(Boolean).join(' · ') || 'No contact details'}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Enrollment history"
          description="Every enrollment record is retained; the most recent active record drives the student's current class."
        />
        {record.enrollments.length === 0 ? (
          <EmptyState
            title="No enrollment records"
            description="Enroll this student in a section for the current academic year."
            icon="calendar"
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Academic year</th>
                  <th>Class</th>
                  <th>Section</th>
                  <th>Starts</th>
                  <th>Ends</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {record.enrollments.map((enrollment) => (
                  <tr key={enrollment.id}>
                    <td>{enrollment.academicYearName}</td>
                    <td>{enrollment.className}</td>
                    <td>{enrollment.sectionName}</td>
                    <td>{formatDate(enrollment.startsOn)}</td>
                    <td>{formatDate(enrollment.endsOn)}</td>
                    <td>
                      <Badge tone={enrollment.enrollmentStatus === 'active' ? 'success' : 'neutral'}>
                        {enrollment.enrollmentStatus}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {dialog === 'edit' && (
        <EditStudentDialog
          student={record}
          onClose={() => setDialog(null)}
          onSaved={() => {
            toast.notify('success', 'Student profile updated.');
            setDialog(null);
            invalidate();
          }}
        />
      )}

      {dialog === 'guardian' && (
        <LinkGuardianDialog
          hasPrimary={record.guardians.some((guardian) => guardian.isPrimary)}
          onClose={() => setDialog(null)}
          onSaved={() => {
            toast.notify('success', 'Guardian linked to the student.');
            setDialog(null);
            invalidate();
          }}
        />
      )}

      {dialog === 'enroll' && (
        <EnrollDialog
          studentId={record.id}
          onClose={() => setDialog(null)}
          onSaved={() => {
            toast.notify('success', 'Enrollment recorded.');
            setDialog(null);
            invalidate();
          }}
        />
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }): ReactNode {
  return (
    <div className="flex items-start justify-between gap-4 px-5 py-3">
      <dt className="text-sm text-slate-500">{label}</dt>
      <dd className="text-right text-sm text-slate-900">{value}</dd>
    </div>
  );
}

function EditStudentDialog({
  student,
  onClose,
  onSaved,
}: {
  student: StudentDetail;
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  const schoolId = useSchoolId();
  const timeZone = useSchoolTimezone();
  const [firstName, setFirstName] = useState(student.firstName);
  const [middleName, setMiddleName] = useState(student.middleName ?? '');
  const [lastName, setLastName] = useState(student.lastName ?? '');
  const [dateOfBirth, setDateOfBirth] = useState(student.dateOfBirth ?? '');
  const [status, setStatus] = useState(student.status);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});

  const mutation = useMutation({
    mutationFn: () =>
      updateStudent(schoolId, student.id, {
        firstName,
        middleName: middleName.trim() || null,
        lastName: lastName.trim() || null,
        dateOfBirth: dateOfBirth || null,
        status,
      }),
    onSuccess: onSaved,
    onError: (caught) => {
      setError(errorMessage(caught));
      setErrors(fieldErrors(caught));
    },
  });

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setError(null);
    setErrors({});
    mutation.mutate();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Edit student profile"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button form="edit-student-form" type="submit" loading={mutation.isPending}>
            Save changes
          </Button>
        </>
      }
    >
      <form id="edit-student-form" className="space-y-4" onSubmit={submit} noValidate>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name" htmlFor="edit-first" required error={errors.firstName?.[0]}>
            <Input
              id="edit-first"
              value={firstName}
              onChange={(event) => setFirstName(event.target.value)}
              required
            />
          </Field>
          <Field label="Middle name" htmlFor="edit-middle" error={errors.middleName?.[0]}>
            <Input
              id="edit-middle"
              value={middleName}
              onChange={(event) => setMiddleName(event.target.value)}
            />
          </Field>
          <Field label="Last name" htmlFor="edit-last" error={errors.lastName?.[0]}>
            <Input
              id="edit-last"
              value={lastName}
              onChange={(event) => setLastName(event.target.value)}
            />
          </Field>
          <Field label="Date of birth" htmlFor="edit-dob" error={errors.dateOfBirth?.[0]}>
            <Input
              id="edit-dob"
              type="date"
              max={todayIso(timeZone)}
              value={dateOfBirth}
              onChange={(event) => setDateOfBirth(event.target.value)}
            />
          </Field>
          <Field
            label="Status"
            htmlFor="edit-status"
            hint="Withdrawing a student does not remove their enrollment history."
            error={errors.status?.[0]}
          >
            <Select id="edit-status" value={status} onChange={(event) => setStatus(event.target.value)}>
              {STUDENT_STATUSES.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </form>
    </Dialog>
  );
}

function LinkGuardianDialog({
  hasPrimary,
  onClose,
  onSaved,
}: {
  hasPrimary: boolean;
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  const schoolId = useSchoolId();
  const { id } = useParams<{ id: string }>();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [relationshipType, setRelationshipType] = useState('mother');
  const [isPrimary, setIsPrimary] = useState(!hasPrimary);
  const [portalAccessStatus, setPortalAccessStatus] = useState('pending');
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});

  const mutation = useMutation({
    mutationFn: () =>
      linkGuardian(schoolId, id!, {
        firstName,
        lastName: lastName.trim() || undefined,
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        relationshipType,
        isPrimary,
        portalAccessStatus,
      }),
    onSuccess: onSaved,
    onError: (caught) => {
      setError(errorMessage(caught));
      setErrors(fieldErrors(caught));
    },
  });

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setError(null);
    setErrors({});
    mutation.mutate();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Link a guardian"
      description="If the email or phone already exists in this school, the existing guardian record is reused."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button form="guardian-form" type="submit" loading={mutation.isPending}>
            Link guardian
          </Button>
        </>
      }
    >
      <form id="guardian-form" className="space-y-4" onSubmit={submit} noValidate>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name" htmlFor="guardian-first" required error={errors.firstName?.[0]}>
            <Input
              id="guardian-first"
              value={firstName}
              onChange={(event) => setFirstName(event.target.value)}
              required
            />
          </Field>
          <Field label="Last name" htmlFor="guardian-last" error={errors.lastName?.[0]}>
            <Input
              id="guardian-last"
              value={lastName}
              onChange={(event) => setLastName(event.target.value)}
            />
          </Field>
          <Field label="Email" htmlFor="guardian-email" error={errors.email?.[0]}>
            <Input
              id="guardian-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
          <Field label="Phone" htmlFor="guardian-phone" error={errors.phone?.[0]}>
            <Input
              id="guardian-phone"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
            />
          </Field>
          <Field label="Relationship" htmlFor="guardian-relationship" required>
            <Select
              id="guardian-relationship"
              value={relationshipType}
              onChange={(event) => setRelationshipType(event.target.value)}
            >
              {RELATIONSHIP_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type.charAt(0).toUpperCase() + type.slice(1)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Portal access" htmlFor="guardian-portal">
            <Select
              id="guardian-portal"
              value={portalAccessStatus}
              onChange={(event) => setPortalAccessStatus(event.target.value)}
            >
              {GUARDIAN_PORTAL_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            className="h-4 w-4 rounded text-brand-600"
            checked={isPrimary}
            onChange={(event) => setIsPrimary(event.target.checked)}
          />
          Primary contact{hasPrimary ? ' (already assigned — choose another guardian to change it)' : ''}
        </label>
      </form>
    </Dialog>
  );
}

function EnrollDialog({
  studentId,
  onClose,
  onSaved,
}: {
  studentId: string;
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  const schoolId = useSchoolId();
  const timeZone = useSchoolTimezone();
  const [academicYearId, setAcademicYearId] = useState('');
  const [sectionId, setSectionId] = useState('');
  const [startsOn, setStartsOn] = useState(todayIso(timeZone));
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});

  const years = useQuery({
    queryKey: ['academic-years', schoolId],
    queryFn: () => listAcademicYears(schoolId),
  });
  const sections = useQuery({
    queryKey: ['sections', schoolId, academicYearId],
    queryFn: () => listSections(schoolId, { academicYearId }),
    enabled: Boolean(academicYearId),
  });
  const classes = useQuery({
    queryKey: ['classes', schoolId],
    queryFn: () => listClasses(schoolId),
    staleTime: 60_000,
  });

  useEffect(() => {
    if (academicYearId || !years.data) return;
    const preferred =
      years.data.items.find((year) => year.status === 'active') ?? years.data.items[0];
    if (preferred) setAcademicYearId(preferred.id);
  }, [years.data, academicYearId]);

  useEffect(() => {
    if (!sections.data) return;
    if (!sections.data.items.some((section) => section.id === sectionId)) {
      setSectionId(sections.data.items[0]?.id ?? '');
    }
  }, [sections.data, sectionId]);

  const mutation = useMutation({
    mutationFn: () => enrollStudent(schoolId, studentId, { academicYearId, sectionId, startsOn }),
    onSuccess: onSaved,
    onError: (caught) => {
      setError(errorMessage(caught));
      setErrors(fieldErrors(caught));
    },
  });

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setError(null);
    setErrors({});
    mutation.mutate();
  }

  const selectedSection = sections.data?.items.find((section) => section.id === sectionId);
  const selectedClass = classes.data?.items.find((record) => record.id === selectedSection?.classId);

  return (
    <Dialog
      open
      onClose={onClose}
      title="Record an enrollment"
      description="Adds a new active enrollment record. Existing records remain in the history."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            form="enroll-form"
            type="submit"
            loading={mutation.isPending}
            disabled={!sectionId}
          >
            Save enrollment
          </Button>
        </>
      }
    >
      <form id="enroll-form" className="space-y-4" onSubmit={submit} noValidate>
        {error && <Alert tone="danger">{error}</Alert>}
        {years.isError && <Alert tone="danger">{errorMessage(years.error)}</Alert>}
        <Field label="Academic year" htmlFor="enroll-year" required error={errors.academicYearId?.[0]}>
          <Select
            id="enroll-year"
            value={academicYearId}
            onChange={(event) => setAcademicYearId(event.target.value)}
            required
          >
            {years.data?.items.map((year) => (
              <option key={year.id} value={year.id}>
                {year.name}
                {year.status === 'active' ? ' (active)' : ''}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Section"
          htmlFor="enroll-section"
          required
          hint={selectedClass ? `${selectedClass.name} · ${selectedSection?.enrolled ?? 0} enrolled` : undefined}
          error={errors.sectionId?.[0]}
        >
          <Select
            id="enroll-section"
            value={sectionId}
            onChange={(event) => setSectionId(event.target.value)}
            required
            disabled={sections.isPending || !sections.data?.items.length}
          >
            {sections.isPending && <option value="">Loading sections…</option>}
            {sections.data?.items.map((section) => (
              <option key={section.id} value={section.id}>
                {section.className} · {section.name}
              </option>
            ))}
            {sections.data && sections.data.items.length === 0 && (
              <option value="">No sections in this year</option>
            )}
          </Select>
        </Field>
        <Field label="Starts on" htmlFor="enroll-starts" required error={errors.startsOn?.[0]}>
          <Input
            id="enroll-starts"
            type="date"
            value={startsOn}
            onChange={(event) => setStartsOn(event.target.value)}
            required
          />
        </Field>
        {!sections.isPending && sections.data?.items.length === 0 && (
          <Alert tone="warning">
            This academic year has no sections. Create a section before enrolling the student.
          </Alert>
        )}
      </form>
    </Dialog>
  );
}
