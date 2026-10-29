import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import type { SectionRecord } from '@erp/shared';
import { useAuth, useSchoolId } from '../auth/AuthContext';
import {
  createSection,
  listAcademicYears,
  listClasses,
  listSections,
  updateSection,
} from '../lib/endpoints';
import { errorMessage, fieldErrors } from '../lib/api';
import { Dialog } from '../components/Dialog';
import { useToast } from '../components/ToastProvider';
import {
  Alert,
  Badge,
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

export function SectionsPage(): ReactNode {
  const schoolId = useSchoolId();
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [yearFilter, setYearFilter] = useState('');
  const [classFilter, setClassFilter] = useState('');
  const [dialog, setDialog] = useState<
    { mode: 'create' } | { mode: 'edit'; record: SectionRecord } | null
  >(null);

  const years = useQuery({
    queryKey: ['academic-years', schoolId],
    queryFn: () => listAcademicYears(schoolId),
  });
  const classes = useQuery({
    queryKey: ['classes', schoolId],
    queryFn: () => listClasses(schoolId),
  });
  const sections = useQuery({
    queryKey: ['sections', schoolId, yearFilter, classFilter],
    queryFn: () =>
      listSections(schoolId, {
        academicYearId: yearFilter || undefined,
        classId: classFilter || undefined,
      }),
  });

  const activeYear = useMemo(
    () => years.data?.items.find((year) => year.status === 'active'),
    [years.data],
  );

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['sections', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['overview', schoolId] });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sections"
        description="A section is a class within a specific academic year. Enrollment capacity is enforced as a warning, not a hard block."
        actions={
          can('academic.section.manage') ? (
            <Button
              onClick={() => setDialog({ mode: 'create' })}
              disabled={!years.data?.items.length || !classes.data?.items.length}
            >
              <Icon name="plus" className="h-4 w-4" />
              New section
            </Button>
          ) : undefined
        }
      />

      {activeYear && (
        <div className="rounded-lg border border-brand-100 bg-brand-50 px-4 py-3 text-sm text-brand-800">
          <strong>{activeYear.name}</strong> is the active academic year. New admissions default to
          sections in that year.
        </div>
      )}

      <Card>
        <div className="flex flex-wrap items-end gap-3 border-b border-slate-100 px-4 py-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">Academic year</span>
            <Select
              className="!w-56"
              value={yearFilter}
              onChange={(event) => setYearFilter(event.target.value)}
            >
              <option value="">All years</option>
              {years.data?.items.map((year) => (
                <option key={year.id} value={year.id}>
                  {year.name}
                  {year.status === 'active' ? ' (active)' : ''}
                </option>
              ))}
            </Select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">Class</span>
            <Select
              className="!w-48"
              value={classFilter}
              onChange={(event) => setClassFilter(event.target.value)}
            >
              <option value="">All classes</option>
              {classes.data?.items.map((record) => (
                <option key={record.id} value={record.id}>
                  {record.name}
                </option>
              ))}
            </Select>
          </label>
          {(yearFilter || classFilter) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setYearFilter('');
                setClassFilter('');
              }}
            >
              Clear filters
            </Button>
          )}
        </div>

        {sections.isPending ? (
          <TableSkeleton rows={6} columns={6} />
        ) : sections.isError ? (
          <ErrorState
            message={errorMessage(sections.error)}
            onRetry={() => void sections.refetch()}
          />
        ) : sections.data.items.length === 0 ? (
          <EmptyState
            title="No sections match"
            description="Adjust the filters, or create a section for a class in the selected academic year."
            icon="users"
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Section</th>
                  <th>Class</th>
                  <th>Academic year</th>
                  <th>Capacity</th>
                  <th>Enrolled</th>
                  <th>Status</th>
                  {can('academic.section.manage') && <th className="text-right">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {sections.data.items.map((record) => {
                  const nearCapacity =
                    record.capacity !== null && record.enrolled >= record.capacity;
                  return (
                    <tr key={record.id}>
                      <td className="font-medium text-slate-900">
                        {record.name}
                        <span className="ml-2 font-mono text-xs text-slate-400">{record.code}</span>
                      </td>
                      <td>{record.className}</td>
                      <td className="text-slate-500">{record.academicYearName}</td>
                      <td className="tabular-nums">{record.capacity ?? '—'}</td>
                      <td>
                        <span
                          className={
                            nearCapacity ? 'font-semibold text-amber-700 tabular-nums' : 'tabular-nums'
                          }
                        >
                          {record.enrolled}
                        </span>
                      </td>
                      <td>
                        <Badge tone={record.status === 'active' ? 'success' : 'neutral'}>
                          {record.status}
                        </Badge>
                      </td>
                      {can('academic.section.manage') && (
                        <td className="text-right">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setDialog({ mode: 'edit', record })}
                          >
                            Edit
                          </Button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {dialog && years.data && classes.data && (
        <SectionDialog
          mode={dialog.mode}
          record={dialog.mode === 'edit' ? dialog.record : undefined}
          years={years.data.items}
          classes={classes.data.items}
          onClose={() => setDialog(null)}
          onSaved={(message) => {
            toast.notify('success', message);
            setDialog(null);
            invalidate();
          }}
        />
      )}
    </div>
  );
}

function SectionDialog({
  mode,
  record,
  years,
  classes,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit';
  record?: SectionRecord;
  years: Array<{ id: string; name: string; status: string }>;
  classes: Array<{ id: string; name: string }>;
  onClose: () => void;
  onSaved: (message: string) => void;
}): ReactNode {
  const schoolId = useSchoolId();
  const defaultYearId =
    years.find((year) => year.status === 'active')?.id ?? record?.academicYearId ?? years[0]?.id ?? '';
  const [academicYearId, setAcademicYearId] = useState(record?.academicYearId ?? defaultYearId);
  const [classId, setClassId] = useState(record?.classId ?? classes[0]?.id ?? '');
  const [code, setCode] = useState(record?.code ?? '');
  const [name, setName] = useState(record?.name ?? '');
  const [capacity, setCapacity] = useState(
    record?.capacity === null || record?.capacity === undefined ? '' : String(record.capacity),
  );
  const [status, setStatus] = useState<SectionRecord['status']>(record?.status ?? 'active');
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});

  const mutation = useMutation({
    mutationFn: () => {
      const capacityValue = capacity === '' ? null : Number(capacity);
      if (mode === 'create') {
        return createSection(schoolId, {
          academicYearId,
          classId,
          code,
          name,
          capacity: capacityValue,
          status,
        });
      }
      return updateSection(schoolId, record!.id, { code, name, capacity: capacityValue, status });
    },
    onSuccess: (saved) =>
      onSaved(mode === 'create' ? `${saved.className} ${saved.name} created` : `${saved.name} updated`),
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
      title={mode === 'create' ? 'New section' : `Edit ${record?.className} ${record?.name}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button form="section-form" type="submit" loading={mutation.isPending}>
            {mode === 'create' ? 'Create section' : 'Save changes'}
          </Button>
        </>
      }
    >
      <form id="section-form" className="space-y-4" onSubmit={submit} noValidate>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Academic year" htmlFor="section-year" required error={errors.academicYearId?.[0]}>
            <Select
              id="section-year"
              value={academicYearId}
              onChange={(event) => setAcademicYearId(event.target.value)}
              disabled={mode === 'edit'}
            >
              {years.map((year) => (
                <option key={year.id} value={year.id}>
                  {year.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Class" htmlFor="section-class" required error={errors.classId?.[0]}>
            <Select
              id="section-class"
              value={classId}
              onChange={(event) => setClassId(event.target.value)}
              disabled={mode === 'edit'}
            >
              {classes.map((record) => (
                <option key={record.id} value={record.id}>
                  {record.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Section code"
            htmlFor="section-code"
            required
            hint="Short label, e.g. A or G1-A."
            error={errors.code?.[0]}
          >
            <Input
              id="section-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="A"
              required
            />
          </Field>
          <Field label="Display name" htmlFor="section-name" required error={errors.name?.[0]}>
            <Input
              id="section-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Section A"
              required
            />
          </Field>
          <Field label="Capacity" htmlFor="section-capacity" error={errors.capacity?.[0]}>
            <Input
              id="section-capacity"
              type="number"
              min={0}
              value={capacity}
              onChange={(event) => setCapacity(event.target.value)}
              placeholder="Optional"
            />
          </Field>
          <Field label="Status" htmlFor="section-status">
            <Select
              id="section-status"
              value={status}
              onChange={(event) => setStatus(event.target.value as SectionRecord['status'])}
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </Select>
          </Field>
        </div>
        {mode === 'edit' && (
          <p className="text-xs text-slate-500">
            A section cannot be moved to another class or academic year after creation. Create a new
            section instead and enroll students there.
          </p>
        )}
      </form>
    </Dialog>
  );
}
