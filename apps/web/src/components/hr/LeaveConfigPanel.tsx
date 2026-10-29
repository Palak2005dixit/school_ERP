import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import type { HolidayRecord, LeaveTypeRecord } from '@erp/shared';
import { useSchoolId, useSchoolTimezone } from '../../auth/AuthContext';
import {
  createHoliday,
  createLeaveType,
  deleteHoliday,
  listHolidays,
  listLeaveBalances,
  listLeaveTypes,
  updateLeaveType,
} from '../../lib/endpoints';
import { errorMessage, fieldErrors } from '../../lib/api';
import { formatDate, todayIso } from '../../lib/format';
import { ConfirmDialog, Dialog } from '../Dialog';
import { useToast } from '../ToastProvider';
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
  TableSkeleton,
  Textarea,
} from '../ui';

/**
 * Leave configuration and balances. Quotas are provisional because the school
 * has not confirmed a statutory leave policy; they are stored per school and
 * can be edited here.
 */
export function LeaveConfigPanel({
  schoolId,
  canConfigure,
}: {
  schoolId: string;
  canConfigure: boolean;
}): ReactNode {
  const timeZone = useSchoolTimezone();
  const toast = useToast();
  const queryClient = useQueryClient();
  const currentYear = Number(todayIso(timeZone).slice(0, 4));

  const [year, setYear] = useState(currentYear);
  const [typeDialog, setTypeDialog] = useState<LeaveTypeRecord | 'new' | null>(null);
  const [holidayDialog, setHolidayDialog] = useState(false);
  const [holidayToDelete, setHolidayToDelete] = useState<HolidayRecord | null>(null);

  const types = useQuery({
    queryKey: ['leave-types', schoolId],
    queryFn: () => listLeaveTypes(schoolId),
  });
  const holidays = useQuery({
    queryKey: ['holidays', schoolId, year],
    queryFn: () => listHolidays(schoolId, year),
  });
  const balances = useQuery({
    queryKey: ['leave-balances', schoolId, year],
    queryFn: () => listLeaveBalances(schoolId, { year }),
  });

  const removeHoliday = useMutation({
    mutationFn: (id: string) => deleteHoliday(schoolId, id),
    onSuccess: () => {
      toast.notify('success', 'Holiday removed.');
      setHolidayToDelete(null);
      void queryClient.invalidateQueries({ queryKey: ['holidays', schoolId] });
    },
    onError: (error) => {
      setHolidayToDelete(null);
      toast.notify('error', errorMessage(error));
    },
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Leave types"
          description="Codes are used on leave requests. Once any type exists, only active codes can be requested."
          actions={
            canConfigure ? (
              <Button size="sm" onClick={() => setTypeDialog('new')}>
                <Icon name="plus" className="h-4 w-4" />
                New type
              </Button>
            ) : undefined
          }
        />
        {types.isPending ? (
          <TableSkeleton rows={4} columns={5} />
        ) : types.isError ? (
          <ErrorState message={errorMessage(types.error)} onRetry={() => void types.refetch()} />
        ) : types.data.items.length === 0 ? (
          <EmptyState
            title="No leave types configured"
            description="Until types are configured, leave requests accept a free-text code."
            icon="calendar"
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th className="text-right">Annual quota</th>
                  <th>Paid</th>
                  <th>Status</th>
                  {canConfigure && <th className="text-right">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {types.data.items.map((type) => (
                  <tr key={type.id}>
                    <td className="font-mono text-xs text-slate-700">{type.code}</td>
                    <td>{type.name}</td>
                    <td className="text-right tabular-nums">{type.annualQuotaDays}</td>
                    <td>
                      <Badge tone={type.paid ? 'success' : 'neutral'}>
                        {type.paid ? 'paid' : 'unpaid'}
                      </Badge>
                    </td>
                    <td>
                      <Badge tone={type.active ? 'success' : 'neutral'}>
                        {type.active ? 'active' : 'inactive'}
                      </Badge>
                    </td>
                    {canConfigure && (
                      <td className="text-right">
                        <Button size="sm" variant="ghost" onClick={() => setTypeDialog(type)}>
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

      <Card>
        <CardHeader
          title={`Holidays · ${year}`}
          description="Holidays are recorded per school and shown alongside leave balances. They do not automatically shorten a leave request."
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-2 text-xs text-slate-500">
                Year
                <Input
                  type="number"
                  value={year}
                  min={2000}
                  max={2100}
                  onChange={(event) => setYear(Number(event.target.value) || currentYear)}
                  className="w-24"
                  aria-label="Holiday year"
                />
              </div>
              {canConfigure && (
                <Button size="sm" onClick={() => setHolidayDialog(true)}>
                  <Icon name="plus" className="h-4 w-4" />
                  Add holiday
                </Button>
              )}
            </div>
          }
        />
        {holidays.isPending ? (
          <TableSkeleton rows={4} columns={3} />
        ) : holidays.isError ? (
          <ErrorState message={errorMessage(holidays.error)} onRetry={() => void holidays.refetch()} />
        ) : holidays.data.items.length === 0 ? (
          <EmptyState
            title="No holidays recorded"
            description={`Nothing has been added for ${year}.`}
            icon="calendar"
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Name</th>
                  <th>Notes</th>
                  {canConfigure && <th className="text-right">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {holidays.data.items.map((holiday) => (
                  <tr key={holiday.id}>
                    <td>{formatDate(holiday.holidayOn)}</td>
                    <td className="font-medium text-slate-900">{holiday.name}</td>
                    <td className="text-sm text-slate-600">{holiday.notes ?? '—'}</td>
                    {canConfigure && (
                      <td className="text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setHolidayToDelete(holiday)}
                        >
                          Remove
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

      <Card>
        <CardHeader
          title={`Leave balances · ${year}`}
          description="Derived from approved and pending requests that start in the selected calendar year. There is no carry-forward; quotas are provisional."
        />
        {balances.isPending ? (
          <TableSkeleton rows={5} columns={6} />
        ) : balances.isError ? (
          <ErrorState message={errorMessage(balances.error)} onRetry={() => void balances.refetch()} />
        ) : balances.data.items.length === 0 ? (
          <EmptyState
            title="No balances to show"
            description="Balances appear once active staff and leave types exist."
            icon="users"
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Staff</th>
                  <th>Type</th>
                  <th className="text-right">Quota</th>
                  <th className="text-right">Approved</th>
                  <th className="text-right">Pending</th>
                  <th className="text-right">Remaining</th>
                </tr>
              </thead>
              <tbody>
                {balances.data.items.map((row) => (
                  <tr key={`${row.staffId}-${row.leaveType}`}>
                    <td className="font-medium text-slate-900">{row.staffName}</td>
                    <td className="capitalize">{row.leaveType}</td>
                    <td className="text-right tabular-nums">{row.quotaDays}</td>
                    <td className="text-right tabular-nums">{row.approvedDays}</td>
                    <td className="text-right tabular-nums">{row.pendingDays}</td>
                    <td className="text-right tabular-nums">
                      {row.remainingDays === null ? 'Unlimited' : row.remainingDays}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {typeDialog && (
        <LeaveTypeDialog
          type={typeDialog === 'new' ? undefined : typeDialog}
          onClose={() => setTypeDialog(null)}
          onSaved={() => {
            toast.notify('success', 'Leave type saved.');
            setTypeDialog(null);
            void queryClient.invalidateQueries({ queryKey: ['leave-types', schoolId] });
            void queryClient.invalidateQueries({ queryKey: ['leave-balances', schoolId] });
          }}
        />
      )}

      {holidayDialog && (
        <HolidayDialog
          schoolId={schoolId}
          onClose={() => setHolidayDialog(false)}
          onSaved={() => {
            toast.notify('success', 'Holiday added.');
            setHolidayDialog(false);
            void queryClient.invalidateQueries({ queryKey: ['holidays', schoolId] });
          }}
        />
      )}

      <ConfirmDialog
        open={holidayToDelete !== null}
        title="Remove holiday"
        message={
          holidayToDelete ? (
            <p>
              Remove <strong>{holidayToDelete.name}</strong> on{' '}
              {formatDate(holidayToDelete.holidayOn)}?
            </p>
          ) : null
        }
        confirmLabel="Remove"
        destructive
        busy={removeHoliday.isPending}
        onConfirm={() => holidayToDelete && removeHoliday.mutate(holidayToDelete.id)}
        onClose={() => setHolidayToDelete(null)}
      />
    </div>
  );
}

/* ------------------------------ leave type form --------------------------- */

function LeaveTypeDialog({
  type,
  onClose,
  onSaved,
}: {
  type?: LeaveTypeRecord;
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  const schoolId = useSchoolId();
  const [code, setCode] = useState(type?.code ?? '');
  const [name, setName] = useState(type?.name ?? '');
  const [annualQuotaDays, setAnnualQuotaDays] = useState(String(type?.annualQuotaDays ?? 0));
  const [paid, setPaid] = useState(type?.paid ?? true);
  const [active, setActive] = useState(type?.active ?? true);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});

  const mutation = useMutation({
    mutationFn: () => {
      const payload = {
        code: code.trim().toLowerCase(),
        name: name.trim(),
        annualQuotaDays: Number(annualQuotaDays || 0),
        paid,
        active,
      };
      return type
        ? updateLeaveType(schoolId, type.id, payload)
        : createLeaveType(schoolId, payload);
    },
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
      title={type ? `Edit ${type.name}` : 'New leave type'}
      description="Quotas are provisional and configurable; they are not a statutory entitlement."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button form="leave-type-form" type="submit" loading={mutation.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form id="leave-type-form" className="space-y-4" onSubmit={submit} noValidate>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Code" htmlFor="leave-type-code" required error={errors.code?.[0]}>
            <Input
              id="leave-type-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="casual"
              required
            />
          </Field>
          <Field label="Name" htmlFor="leave-type-name" required error={errors.name?.[0]}>
            <Input
              id="leave-type-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Casual leave"
              required
            />
          </Field>
          <Field
            label="Annual quota (days)"
            htmlFor="leave-type-quota"
            error={errors.annualQuotaDays?.[0]}
            hint="Use 0 for no fixed quota."
          >
            <Input
              id="leave-type-quota"
              type="number"
              min={0}
              step="0.5"
              value={annualQuotaDays}
              onChange={(event) => setAnnualQuotaDays(event.target.value)}
            />
          </Field>
          <div className="space-y-3">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={paid} onChange={(event) => setPaid(event.target.checked)} />
              Paid leave
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={active}
                onChange={(event) => setActive(event.target.checked)}
              />
              Active (available for new requests)
            </label>
          </div>
        </div>
      </form>
    </Dialog>
  );
}

/* ------------------------------- holiday form ----------------------------- */

function HolidayDialog({
  schoolId,
  onClose,
  onSaved,
}: {
  schoolId: string;
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  const timeZone = useSchoolTimezone();
  const [name, setName] = useState('');
  const [holidayOn, setHolidayOn] = useState(todayIso(timeZone));
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});

  const mutation = useMutation({
    mutationFn: () =>
      createHoliday(schoolId, {
        name: name.trim(),
        holidayOn,
        notes: notes.trim() || undefined,
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
      title="Add holiday"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button form="holiday-form" type="submit" loading={mutation.isPending}>
            Add holiday
          </Button>
        </>
      }
    >
      <form id="holiday-form" className="space-y-4" onSubmit={submit} noValidate>
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Name" htmlFor="holiday-name" required error={errors.name?.[0]}>
          <Input
            id="holiday-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </Field>
        <Field label="Date" htmlFor="holiday-date" required error={errors.holidayOn?.[0]}>
          <Input
            id="holiday-date"
            type="date"
            value={holidayOn}
            onChange={(event) => setHolidayOn(event.target.value)}
            required
          />
        </Field>
        <Field label="Notes" htmlFor="holiday-notes" error={errors.notes?.[0]}>
          <Textarea
            id="holiday-notes"
            rows={3}
            maxLength={500}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </Field>
      </form>
    </Dialog>
  );
}
