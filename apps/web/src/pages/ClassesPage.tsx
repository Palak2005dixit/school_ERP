import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import type { ClassRecord } from '@erp/shared';
import { useAuth, useSchoolId } from '../auth/AuthContext';
import { createClass, listClasses, updateClass } from '../lib/endpoints';
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

export function ClassesPage(): ReactNode {
  const schoolId = useSchoolId();
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<{ mode: 'create' } | { mode: 'edit'; record: ClassRecord } | null>(
    null,
  );

  const classes = useQuery({
    queryKey: ['classes', schoolId],
    queryFn: () => listClasses(schoolId),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['classes', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['overview', schoolId] });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Classes"
        description="Grade levels offered by the school. Sections and enrollments reference these records."
        actions={
          can('academic.class.manage') ? (
            <Button onClick={() => setDialog({ mode: 'create' })}>
              <Icon name="plus" className="h-4 w-4" />
              New class
            </Button>
          ) : undefined
        }
      />

      <Card>
        {classes.isPending ? (
          <TableSkeleton rows={5} columns={4} />
        ) : classes.isError ? (
          <ErrorState message={errorMessage(classes.error)} onRetry={() => void classes.refetch()} />
        ) : classes.data.items.length === 0 ? (
          <EmptyState
            title="No classes defined"
            description="Add one class per grade level, then create sections for each academic year."
            icon="layers"
            action={
              can('academic.class.manage') ? (
                <Button size="sm" onClick={() => setDialog({ mode: 'create' })}>
                  Create class
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Class</th>
                  <th>Code</th>
                  <th>Grade order</th>
                  <th>Status</th>
                  {can('academic.class.manage') && <th className="text-right">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {classes.data.items.map((record) => (
                  <tr key={record.id}>
                    <td className="font-medium text-slate-900">{record.name}</td>
                    <td className="font-mono text-xs">{record.code}</td>
                    <td>{record.gradeOrder ?? '—'}</td>
                    <td>
                      <Badge tone={record.status === 'active' ? 'success' : 'neutral'}>
                        {record.status}
                      </Badge>
                    </td>
                    {can('academic.class.manage') && (
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
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {dialog && (
        <ClassDialog
          mode={dialog.mode}
          record={dialog.mode === 'edit' ? dialog.record : undefined}
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

function ClassDialog({
  mode,
  record,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit';
  record?: ClassRecord;
  onClose: () => void;
  onSaved: (message: string) => void;
}): ReactNode {
  const schoolId = useSchoolId();
  const [code, setCode] = useState(record?.code ?? '');
  const [name, setName] = useState(record?.name ?? '');
  const [gradeOrder, setGradeOrder] = useState(
    record?.gradeOrder === null || record?.gradeOrder === undefined ? '' : String(record.gradeOrder),
  );
  const [status, setStatus] = useState<ClassRecord['status']>(record?.status ?? 'active');
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});

  const mutation = useMutation({
    mutationFn: () => {
      const payload = {
        code,
        name,
        gradeOrder: gradeOrder === '' ? null : Number(gradeOrder),
        status,
      };
      return mode === 'create'
        ? createClass(schoolId, payload)
        : updateClass(schoolId, record!.id, payload);
    },
    onSuccess: (saved) => onSaved(mode === 'create' ? `${saved.name} created` : `${saved.name} updated`),
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
      title={mode === 'create' ? 'New class' : `Edit ${record?.name}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button form="class-form" type="submit" loading={mutation.isPending}>
            {mode === 'create' ? 'Create class' : 'Save changes'}
          </Button>
        </>
      }
    >
      <form id="class-form" className="space-y-4" onSubmit={submit} noValidate>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Code" htmlFor="class-code" required error={errors.code?.[0]}>
            <Input
              id="class-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="G1"
              required
            />
          </Field>
          <Field label="Name" htmlFor="class-name" required error={errors.name?.[0]}>
            <Input
              id="class-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Grade 1"
              required
            />
          </Field>
          <Field
            label="Grade order"
            htmlFor="class-grade"
            hint="Used to sort classes from youngest to oldest."
            error={errors.gradeOrder?.[0]}
          >
            <Input
              id="class-grade"
              type="number"
              min={0}
              max={100}
              value={gradeOrder}
              onChange={(event) => setGradeOrder(event.target.value)}
            />
          </Field>
          <Field label="Status" htmlFor="class-status">
            <Select
              id="class-status"
              value={status}
              onChange={(event) => setStatus(event.target.value as ClassRecord['status'])}
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </Select>
          </Field>
        </div>
      </form>
    </Dialog>
  );
}
