import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { StudentImportResult } from '@erp/shared';
import { STUDENT_STATUSES } from '../lib/statuses';
import { useAuth, useSchoolId } from '../auth/AuthContext';
import {
  importStudents,
  listAcademicYears,
  listClasses,
  listStudents,
} from '../lib/endpoints';
import { errorMessage } from '../lib/api';
import { useDebouncedValue } from '../lib/hooks';
import { fullName } from '../lib/format';
import { Dialog } from '../components/Dialog';
import { useToast } from '../components/ToastProvider';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  Input,
  PageHeader,
  Select,
  TableSkeleton,
} from '../components/ui';
import { StudentStatusBadge } from '../components/StatusBadges';

export function StudentsPage(): ReactNode {
  const schoolId = useSchoolId();
  const { can } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState(searchParams.get('search') ?? '');
  const debouncedSearch = useDebouncedValue(search, 350);
  const [status, setStatus] = useState(searchParams.get('status') ?? '');
  const [classId, setClassId] = useState(searchParams.get('classId') ?? '');
  const [page, setPage] = useState(1);
  const [importOpen, setImportOpen] = useState(false);
  const queryClient = useQueryClient();

  // Reset pagination whenever the filters change, otherwise a stale page can
  // point past the end of the filtered result set.
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, status, classId]);

  useEffect(() => {
    const next = new URLSearchParams();
    if (debouncedSearch) next.set('search', debouncedSearch);
    if (status) next.set('status', status);
    if (classId) next.set('classId', classId);
    setSearchParams(next, { replace: true });
  }, [debouncedSearch, status, classId, setSearchParams]);

  const classes = useQuery({
    queryKey: ['classes', schoolId],
    queryFn: () => listClasses(schoolId),
    staleTime: 60_000,
  });

  const students = useQuery({
    queryKey: ['students', schoolId, { debouncedSearch, status, classId, page }],
    queryFn: () =>
      listStudents(schoolId, {
        search: debouncedSearch || undefined,
        status: status || undefined,
        classId: classId || undefined,
        page,
        pageSize: 20,
      }),
  });

  const totalPages = students.data ? Math.max(1, Math.ceil(students.data.total / students.data.pageSize)) : 1;
  const hasFilters = Boolean(debouncedSearch || status || classId);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Students"
        description="Admissions and current enrollment. Teachers see only students in their assigned sections."
        actions={
          can('students.admission.create') ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => setImportOpen(true)}>
                <Icon name="download" className="h-4 w-4" />
                Import CSV
              </Button>
              <Link to="/students/new">
                <Button>
                  <Icon name="plus" className="h-4 w-4" />
                  New admission
                </Button>
              </Link>
            </div>
          ) : undefined
        }
      />

      <Card>
        <div className="flex flex-wrap items-end gap-3 border-b border-slate-100 px-4 py-3">
          <div className="block min-w-56 flex-1">
            <span className="mb-1 block text-xs font-medium text-slate-500">Search</span>
            <div className="relative">
              <Icon
                name="search"
                className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400"
              />
              <Input
                className="!pl-9"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Name or admission number"
                aria-label="Search students"
              />
            </div>
          </div>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">Status</span>
            <Select className="!w-40" value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">All statuses</option>
              {STUDENT_STATUSES.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </Select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">Class</span>
            <Select className="!w-44" value={classId} onChange={(event) => setClassId(event.target.value)}>
              <option value="">All classes</option>
              {classes.data?.items.map((record) => (
                <option key={record.id} value={record.id}>
                  {record.name}
                </option>
              ))}
            </Select>
          </label>
          {hasFilters && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSearch('');
                setStatus('');
                setClassId('');
              }}
            >
              Clear
            </Button>
          )}
        </div>

        {students.isPending ? (
          <TableSkeleton rows={8} columns={5} />
        ) : students.isError ? (
          <ErrorState
            message={errorMessage(students.error)}
            onRetry={() => void students.refetch()}
          />
        ) : students.data.items.length === 0 ? (
          <EmptyState
            title={hasFilters ? 'No students match these filters' : 'No students yet'}
            description={
              hasFilters
                ? 'Try a different name, status or class. Search matches names and admission numbers.'
                : 'Admit the first student to start building the register.'
            }
            icon="users"
            action={
              can('students.admission.create') ? (
                <Link to="/students/new">
                  <Button size="sm">Start an admission</Button>
                </Link>
              ) : undefined
            }
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Student</th>
                    <th>Admission no.</th>
                    <th>Class / section</th>
                    <th>Academic year</th>
                    <th>Guardians</th>
                    <th>Status</th>
                    <th aria-label="Open" />
                  </tr>
                </thead>
                <tbody>
                  {students.data.items.map((student) => (
                    <tr key={student.id}>
                      <td>
                        <Link
                          to={`/students/${student.id}`}
                          className="font-medium text-slate-900 hover:text-brand-700 hover:underline"
                        >
                          {fullName(student.firstName, null, student.lastName)}
                        </Link>
                      </td>
                      <td className="font-mono text-xs text-slate-500">{student.admissionNumber}</td>
                      <td>
                        {student.className ? (
                          <>
                            {student.className}
                            <span className="text-slate-400"> · </span>
                            {student.sectionName}
                          </>
                        ) : (
                          <span className="text-slate-400">Not enrolled</span>
                        )}
                      </td>
                      <td className="text-slate-500">{student.academicYearName ?? '—'}</td>
                      <td className="tabular-nums">{student.guardianCount}</td>
                      <td>
                        <StudentStatusBadge status={student.status} />
                      </td>
                      <td className="text-right">
                        <Link
                          to={`/students/${student.id}`}
                          className="text-xs font-medium text-brand-700 hover:underline"
                        >
                          Open
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-4 py-3 text-sm text-slate-600">
              <p>
                Showing{' '}
                <strong>
                  {(students.data.page - 1) * students.data.pageSize + 1}–
                  {Math.min(students.data.page * students.data.pageSize, students.data.total)}
                </strong>{' '}
                of <strong>{students.data.total}</strong>
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                >
                  <Icon name="chevronLeft" className="h-3.5 w-3.5" />
                  Previous
                </Button>
                <span className="px-1 text-xs tabular-nums">
                  Page {students.data.page} of {totalPages}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage((current) => current + 1)}
                >
                  Next
                  <Icon name="chevronRight" className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>

      <p className="text-xs text-slate-500">
        Student names shown here are synthetic test records created by the seed script.
      </p>

      {importOpen && (
        <StudentImportDialog
          onClose={() => setImportOpen(false)}
          onImported={(result) => {
            if (result.created > 0) {
              void queryClient.invalidateQueries({ queryKey: ['students', schoolId] });
            }
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------ CSV import -------------------------------- */

function StudentImportDialog({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: (result: StudentImportResult) => void;
}): ReactNode {
  const schoolId = useSchoolId();
  const toast = useToast();
  const [academicYearId, setAcademicYearId] = useState('');
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<StudentImportResult | null>(null);

  const years = useQuery({
    queryKey: ['academic-years', schoolId],
    queryFn: () => listAcademicYears(schoolId),
  });

  useEffect(() => {
    if (!academicYearId && years.data?.items.length) {
      const active = years.data.items.find((year) => year.status === 'active');
      setAcademicYearId(active?.id ?? years.data.items[0]!.id);
    }
  }, [years.data, academicYearId]);

  const mutation = useMutation({
    mutationFn: () => importStudents(schoolId, { academicYearId, csv }),
    onSuccess: (imported) => {
      setResult(imported);
      setError(null);
      onImported(imported);
      toast.notify(
        imported.failed > 0 ? 'info' : 'success',
        `Imported ${imported.created} student${imported.created === 1 ? '' : 's'}${
          imported.failed > 0 ? `; ${imported.failed} row(s) failed.` : '.'
        }`,
      );
    },
    onError: (caught) => {
      setResult(null);
      setError(errorMessage(caught));
    },
  });

  async function handleFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setError('Choose a CSV file smaller than 2 MiB.');
      event.target.value = '';
      return;
    }
    try {
      const text = await file.text();
      setCsv(text);
      setFileName(file.name);
      setResult(null);
      setError(null);
    } catch {
      setError('The selected file could not be read.');
    }
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setError(null);
    if (!academicYearId) {
      setError('Choose the academic year the imported students join.');
      return;
    }
    if (!csv.trim()) {
      setError('Choose a CSV file or paste its contents.');
      return;
    }
    mutation.mutate();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="Import students from CSV"
      description="Up to 500 rows per import. Each row is admitted separately; failures are reported without stopping the rest."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Close
          </Button>
          <Button form="student-import-form" type="submit" loading={mutation.isPending}>
            Import students
          </Button>
        </>
      }
    >
      <form id="student-import-form" className="space-y-4" onSubmit={submit} noValidate>
        {error && <Alert tone="danger">{error}</Alert>}

        <Field label="Academic year" htmlFor="import-year" required>
          <Select
            id="import-year"
            value={academicYearId}
            onChange={(event) => setAcademicYearId(event.target.value)}
          >
            <option value="">Select an academic year</option>
            {(years.data?.items ?? []).map((year) => (
              <option key={year.id} value={year.id}>
                {year.name} ({year.code})
              </option>
            ))}
          </Select>
        </Field>

        <div>
          <span className="field-label">CSV file</span>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => void handleFile(event)}
            className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200"
            aria-label="Student CSV file"
          />
          {fileName && <p className="mt-1 text-xs text-slate-500">Loaded {fileName}</p>}
        </div>

        <Field
          label="CSV contents"
          htmlFor="import-csv"
          hint="Required columns: first_name, class_name, section_name. Optional: admission_number, middle_name, last_name, date_of_birth."
        >
          <textarea
            id="import-csv"
            className="field-input font-mono text-xs"
            rows={8}
            value={csv}
            onChange={(event) => setCsv(event.target.value)}
            placeholder={'first_name,last_name,class_name,section_name\nAisha,Khan,Grade 1,A'}
          />
        </Field>

        {result && (
          <Alert tone={result.failed > 0 ? 'warning' : 'success'}>
            <p className="font-medium">
              Created {result.created} student{result.created === 1 ? '' : 's'}; {result.failed}{' '}
              row{result.failed === 1 ? '' : 's'} failed.
            </p>
            {result.errors.length > 0 && (
              <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto text-xs">
                {result.errors.map((entry) => (
                  <li key={entry.row}>
                    Row {entry.row}: {entry.message}
                  </li>
                ))}
              </ul>
            )}
          </Alert>
        )}
      </form>
    </Dialog>
  );
}
