import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import type { PayrollRunSummary, PayslipRecord } from '@erp/shared';
import { useAuth, useSchoolTimezone } from '../../auth/AuthContext';
import {
  approvePayrollRun,
  createPayrollRun,
  deletePayrollRun,
  getPayrollRun,
  listPayrollRuns,
  payPayrollRun,
  updatePayslip,
} from '../../lib/endpoints';
import { errorMessage, fieldErrors } from '../../lib/api';
import { formatDate, formatDateTime, formatMoney, todayIso } from '../../lib/format';
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

const STATUS_TONES: Record<PayrollRunSummary['status'], 'neutral' | 'warning' | 'success'> = {
  draft: 'warning',
  approved: 'neutral',
  paid: 'success',
};

/**
 * Payroll runs are generated from the salary register. Amounts stay out of the
 * audit trail, and approval must come from a different user than the creator.
 */
export function PayrollPanel({ schoolId }: { schoolId: string }): ReactNode {
  const { user } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<
    { kind: 'delete'; run: PayrollRunSummary } | { kind: 'pay'; run: PayrollRunSummary } | null
  >(null);
  const [paidOn, setPaidOn] = useState(todayIso());

  const runs = useQuery({
    queryKey: ['payroll', schoolId],
    queryFn: () => listPayrollRuns(schoolId),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['payroll', schoolId] });
  };

  const approve = useMutation({
    mutationFn: (runId: string) => approvePayrollRun(schoolId, runId),
    onSuccess: () => {
      toast.notify('success', 'Payroll run approved.');
      invalidate();
    },
    onError: (error) => toast.notify('error', errorMessage(error)),
  });

  const pay = useMutation({
    mutationFn: (run: PayrollRunSummary) => payPayrollRun(schoolId, run.id, { paidOn }),
    onSuccess: () => {
      toast.notify('success', 'Payroll run marked paid.');
      setConfirming(null);
      invalidate();
    },
    onError: (error) => {
      setConfirming(null);
      toast.notify('error', errorMessage(error));
    },
  });

  const remove = useMutation({
    mutationFn: (runId: string) => deletePayrollRun(schoolId, runId),
    onSuccess: () => {
      toast.notify('success', 'Draft payroll run deleted.');
      setConfirming(null);
      invalidate();
    },
    onError: (error) => {
      setConfirming(null);
      toast.notify('error', errorMessage(error));
    },
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Payroll runs"
          description="Each run captures the current salary of every active staff member. Only a different user may approve a run, and a run must be approved before it can be marked paid."
          actions={
            <Button size="sm" onClick={() => setCreating(true)}>
              <Icon name="plus" className="h-4 w-4" />
              New run
            </Button>
          }
        />
        {runs.isPending ? (
          <TableSkeleton rows={4} columns={7} />
        ) : runs.isError ? (
          <ErrorState message={errorMessage(runs.error)} onRetry={() => void runs.refetch()} />
        ) : runs.data.items.length === 0 ? (
          <EmptyState
            title="No payroll runs"
            description="Create a run once salaries have been set on the salary register."
            icon="clipboard"
            action={
              <Button size="sm" onClick={() => setCreating(true)}>
                New run
              </Button>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Period</th>
                  <th>Status</th>
                  <th className="text-right">Payslips</th>
                  <th className="text-right">Gross</th>
                  <th className="text-right">Deductions</th>
                  <th className="text-right">Net</th>
                  <th>Approved / paid</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {runs.data.items.map((run) => {
                  const isCreator = Boolean(user && run.createdByName === user.displayName);
                  return (
                    <tr key={run.id}>
                      <td className="text-sm text-slate-700">
                        {formatDate(run.periodStart)} – {formatDate(run.periodEnd)}
                      </td>
                      <td>
                        <Badge tone={STATUS_TONES[run.status]}>{run.status}</Badge>
                      </td>
                      <td className="text-right tabular-nums">{run.payslipCount}</td>
                      <td className="text-right tabular-nums">
                        {formatMoney(run.grossTotal, 'INR')}
                      </td>
                      <td className="text-right tabular-nums">
                        {formatMoney(run.deductionTotal, 'INR')}
                      </td>
                      <td className="text-right tabular-nums font-medium">
                        {formatMoney(run.netTotal, 'INR')}
                      </td>
                      <td className="text-xs text-slate-500">
                        {run.approvedByName ? (
                          <p>
                            {run.approvedByName}
                            {run.approvedAt ? ` · ${formatDateTime(run.approvedAt)}` : ''}
                          </p>
                        ) : (
                          <p>Not approved</p>
                        )}
                        {run.paidOn && <p>Paid {formatDate(run.paidOn)}</p>}
                      </td>
                      <td>
                        <div className="flex flex-wrap justify-end gap-2">
                          <Button size="sm" variant="ghost" onClick={() => setOpenRunId(run.id)}>
                            Open
                          </Button>
                          {run.status === 'draft' && (
                            <Button
                              size="sm"
                              onClick={() => approve.mutate(run.id)}
                              loading={approve.isPending}
                              disabled={isCreator}
                              title={
                                isCreator
                                  ? 'A different user must approve this run'
                                  : 'Approve this payroll run'
                              }
                            >
                              Approve
                            </Button>
                          )}
                          {run.status === 'approved' && (
                            <Button size="sm" onClick={() => setConfirming({ kind: 'pay', run })}>
                              Mark paid
                            </Button>
                          )}
                          {run.status === 'draft' && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setConfirming({ kind: 'delete', run })}
                            >
                              Delete
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {creating && (
        <CreatePayrollDialog
          schoolId={schoolId}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            invalidate();
            setOpenRunId(id);
            toast.notify('success', 'Payroll run created from current salaries.');
          }}
        />
      )}

      {openRunId && (
        <PayrollRunDialog
          schoolId={schoolId}
          runId={openRunId}
          onClose={() => setOpenRunId(null)}
          onChanged={invalidate}
        />
      )}

      <ConfirmDialog
        open={confirming !== null}
        title={confirming?.kind === 'pay' ? 'Mark payroll paid' : 'Delete payroll run'}
        message={
          confirming?.kind === 'pay' ? (
            <div className="space-y-3">
              <p>
                Mark the run for {formatDate(confirming.run.periodStart)} –{' '}
                {formatDate(confirming.run.periodEnd)} as paid on the selected date?
              </p>
              <Field label="Paid on" htmlFor="payroll-paid-on">
                <Input
                  id="payroll-paid-on"
                  type="date"
                  value={paidOn}
                  onChange={(event) => setPaidOn(event.target.value)}
                />
              </Field>
            </div>
          ) : confirming?.kind === 'delete' ? (
            <p>
              Delete the draft payroll run for {formatDate(confirming.run.periodStart)} –{' '}
              {formatDate(confirming.run.periodEnd)}? Payslips in the run are removed with it.
            </p>
          ) : null
        }
        confirmLabel={confirming?.kind === 'pay' ? 'Mark paid' : 'Delete run'}
        destructive={confirming?.kind === 'delete'}
        busy={pay.isPending || remove.isPending}
        onConfirm={() => {
          if (!confirming) return;
          if (confirming.kind === 'pay') pay.mutate(confirming.run);
          else remove.mutate(confirming.run.id);
        }}
        onClose={() => setConfirming(null)}
      />
    </div>
  );
}

/* ------------------------------ create dialog ----------------------------- */

function CreatePayrollDialog({
  schoolId,
  onClose,
  onCreated,
}: {
  schoolId: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}): ReactNode {
  const timeZone = useSchoolTimezone();
  const [periodStart, setPeriodStart] = useState(todayIso(timeZone));
  const [periodEnd, setPeriodEnd] = useState(todayIso(timeZone));
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});

  const mutation = useMutation({
    mutationFn: () =>
      createPayrollRun(schoolId, {
        periodStart,
        periodEnd,
        notes: notes.trim() || undefined,
      }),
    onSuccess: (created) => onCreated(created.id),
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
      title="New payroll run"
      description="Payslips are generated from the salary register for every active staff member. Deductions can be edited while the run is a draft."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button form="payroll-create-form" type="submit" loading={mutation.isPending}>
            Create run
          </Button>
        </>
      }
    >
      <form id="payroll-create-form" className="space-y-4" onSubmit={submit} noValidate>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Period start" htmlFor="payroll-start" required error={errors.periodStart?.[0]}>
            <Input
              id="payroll-start"
              type="date"
              value={periodStart}
              onChange={(event) => setPeriodStart(event.target.value)}
              required
            />
          </Field>
          <Field label="Period end" htmlFor="payroll-end" required error={errors.periodEnd?.[0]}>
            <Input
              id="payroll-end"
              type="date"
              value={periodEnd}
              onChange={(event) => setPeriodEnd(event.target.value)}
              required
            />
          </Field>
        </div>
        <Field label="Notes" htmlFor="payroll-notes" error={errors.notes?.[0]}>
          <Textarea
            id="payroll-notes"
            rows={2}
            maxLength={500}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </Field>
        <Alert tone="info">
          Statutory deductions and contribution rates are not configured. This run records gross salary and any
          manual deduction you enter; confirm payroll rules with the school before treating figures as final.
        </Alert>
      </form>
    </Dialog>
  );
}

/* ------------------------------- run detail ------------------------------- */

function PayrollRunDialog({
  schoolId,
  runId,
  onClose,
  onChanged,
}: {
  schoolId: string;
  runId: string;
  onClose: () => void;
  onChanged: () => void;
}): ReactNode {
  const timeZone = useSchoolTimezone();
  const toast = useToast();
  const queryClient = useQueryClient();
  const detailKey = ['payroll-run', schoolId, runId];
  const [editing, setEditing] = useState<PayslipRecord | null>(null);

  const detail = useQuery({
    queryKey: detailKey,
    queryFn: () => getPayrollRun(schoolId, runId),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: detailKey });
    onChanged();
  };

  const record = detail.data;

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={
        record
          ? `Payroll ${formatDate(record.periodStart)} – ${formatDate(record.periodEnd)}`
          : 'Payroll run'
      }
      description={record ? `${record.payslipCount} payslips · ${record.status}` : undefined}
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      {detail.isPending ? (
        <TableSkeleton rows={5} columns={6} />
      ) : detail.isError ? (
        <ErrorState message={errorMessage(detail.error)} onRetry={() => void detail.refetch()} />
      ) : !record ? null : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <SummaryTile label="Gross" value={formatMoney(record.grossTotal, 'INR')} />
            <SummaryTile label="Deductions" value={formatMoney(record.deductionTotal, 'INR')} />
            <SummaryTile label="Net payable" value={formatMoney(record.netTotal, 'INR')} />
          </div>

          <div className="text-xs text-slate-500">
            Created by {record.createdByName ?? '—'} · {formatDateTime(record.createdAt, timeZone)}
            {record.approvedByName && (
              <p>
                Approved by {record.approvedByName}
                {record.approvedAt ? ` · ${formatDateTime(record.approvedAt, timeZone)}` : ''}
              </p>
            )}
            {record.paidOn && <p>Paid on {formatDate(record.paidOn)}</p>}
            {record.notes && <p className="mt-1 text-slate-600">{record.notes}</p>}
          </div>

          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Staff</th>
                  <th className="text-right">Gross</th>
                  <th className="text-right">Deductions</th>
                  <th className="text-right">Net</th>
                  <th>Notes</th>
                  {record.status === 'draft' && <th className="text-right">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {record.payslips.map((slip) => (
                  <tr key={slip.id}>
                    <td>
                      <p className="font-medium text-slate-900">{slip.staffName}</p>
                      <p className="font-mono text-xs text-slate-500">{slip.employeeNumber}</p>
                    </td>
                    <td className="text-right tabular-nums">{formatMoney(slip.grossAmount, 'INR')}</td>
                    <td className="text-right tabular-nums">{formatMoney(slip.deductions, 'INR')}</td>
                    <td className="text-right tabular-nums font-medium">
                      {formatMoney(slip.netAmount, 'INR')}
                    </td>
                    <td className="max-w-48 text-sm text-slate-600">{slip.notes ?? '—'}</td>
                    {record.status === 'draft' && (
                      <td className="text-right">
                        <Button size="sm" variant="ghost" onClick={() => setEditing(slip)}>
                          Edit
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {record.status !== 'draft' && (
            <Alert tone="info">
              This run is {record.status}; payslip amounts are locked. Corrections need a new run.
            </Alert>
          )}
        </div>
      )}

      {editing && (
        <PayslipDialog
          schoolId={schoolId}
          runId={runId}
          slip={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            toast.notify('success', 'Payslip updated.');
            refresh();
          }}
        />
      )}
    </Dialog>
  );
}

function SummaryTile({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
      <p className="text-[11px] font-semibold tracking-wider text-slate-500 uppercase">{label}</p>
      <p className="mt-0.5 text-lg font-semibold text-slate-900">{value}</p>
    </div>
  );
}

function PayslipDialog({
  schoolId,
  runId,
  slip,
  onClose,
  onSaved,
}: {
  schoolId: string;
  runId: string;
  slip: PayslipRecord;
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  const [deductions, setDeductions] = useState(String(slip.deductions));
  const [notes, setNotes] = useState(slip.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});

  const mutation = useMutation({
    mutationFn: () =>
      updatePayslip(schoolId, runId, slip.id, {
        deductions: Number(deductions || 0),
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
      size="sm"
      title={`Payslip · ${slip.staffName}`}
      description={`Gross ${formatMoney(slip.grossAmount, 'INR')}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button form="payslip-form" type="submit" loading={mutation.isPending}>
            Save payslip
          </Button>
        </>
      }
    >
      <form id="payslip-form" className="space-y-4" onSubmit={submit} noValidate>
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Deductions" htmlFor="payslip-deductions" error={errors.deductions?.[0]}>
          <Input
            id="payslip-deductions"
            type="number"
            min={0}
            step="0.01"
            max={slip.grossAmount}
            value={deductions}
            onChange={(event) => setDeductions(event.target.value)}
          />
        </Field>
        <Field label="Notes" htmlFor="payslip-notes">
          <Textarea
            id="payslip-notes"
            rows={2}
            maxLength={500}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </Field>
        <p className="text-xs text-slate-500">
          Net pay will be {formatMoney(Math.max(0, slip.grossAmount - Number(deductions || 0)), 'INR')}.
        </p>
      </form>
    </Dialog>
  );
}
