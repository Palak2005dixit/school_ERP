import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { LateFeeRuleRecord, StudentSummary } from '@erp/shared';
import { useSchoolTimezone } from '../../auth/AuthContext';
import {
  listFeeStructures,
  listInstallmentPlan,
  listLateFeeRules,
  listStudentInstallments,
  runLateFees,
  saveInstallmentPlan,
  studentInvoiceUrl,
  updateLateFeeRule,
  createLateFeeRule,
  type InstallmentPlanItem,
} from '../../lib/endpoints';
import { errorMessage, fieldErrors } from '../../lib/api';
import { formatDate, formatMoney, fullName, todayIso } from '../../lib/format';
import { Dialog } from '../Dialog';
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
  Select,
  TableSkeleton,
} from '../ui';

const STATUS_TONES: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  paid: 'success',
  partial: 'warning',
  overdue: 'danger',
  pending: 'neutral',
};

/**
 * Late-fee rules/assessment, instalment plans and student invoice access.
 * Late fees post to a dedicated fee head; instalment status is derived from
 * charge-level allocations on the server.
 */
export function FeeExtrasPanel({
  schoolId,
  yearId,
  canManage,
  studentOptions,
}: {
  schoolId: string;
  yearId: string;
  canManage: boolean;
  studentOptions: StudentSummary[];
}): ReactNode {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [ruleDialog, setRuleDialog] = useState<LateFeeRuleRecord | 'new' | null>(null);
  const [runRule, setRunRule] = useState<LateFeeRuleRecord | null>(null);
  const [structureId, setStructureId] = useState('');
  const [studentId, setStudentId] = useState('');

  const rules = useQuery({
    queryKey: ['late-fee-rules', schoolId],
    queryFn: () => listLateFeeRules(schoolId),
  });
  const structures = useQuery({
    queryKey: ['fee-structures', schoolId, yearId],
    queryFn: () => listFeeStructures(schoolId, { academicYearId: yearId }),
    enabled: Boolean(yearId),
  });

  useEffect(() => {
    if (!structureId && structures.data?.items[0]) {
      setStructureId(structures.data.items[0].id);
    }
  }, [structures.data, structureId]);

  const plan = useQuery({
    queryKey: ['installment-plan', schoolId, structureId],
    queryFn: () => listInstallmentPlan(schoolId, structureId),
    enabled: Boolean(structureId),
  });

  const installments = useQuery({
    queryKey: ['student-installments', schoolId, studentId, yearId],
    queryFn: () => listStudentInstallments(schoolId, studentId, yearId || undefined),
    enabled: Boolean(studentId),
  });

  const toggleRule = useMutation({
    mutationFn: (rule: LateFeeRuleRecord) =>
      updateLateFeeRule(schoolId, rule.id, { active: !rule.active }),
    onSuccess: () => {
      toast.notify('success', 'Late-fee rule updated.');
      void queryClient.invalidateQueries({ queryKey: ['late-fee-rules', schoolId] });
    },
    onError: (error) => toast.notify('error', errorMessage(error)),
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Late-fee rules"
          description="A run posts the computed fee to the LATE-FEE head for every overdue charge, once per charge per day. Percentages and caps are provisional."
          actions={
            canManage ? (
              <Button size="sm" onClick={() => setRuleDialog('new')}>
                <Icon name="plus" className="h-4 w-4" />
                New rule
              </Button>
            ) : undefined
          }
        />
        {rules.isPending ? (
          <TableSkeleton rows={3} columns={6} />
        ) : rules.isError ? (
          <ErrorState message={errorMessage(rules.error)} onRetry={() => void rules.refetch()} />
        ) : rules.data.items.length === 0 ? (
          <EmptyState
            title="No late-fee rules"
            description="Create a rule before running an assessment."
            icon="clipboard"
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="text-right">Grace days</th>
                  <th className="text-right">% / month</th>
                  <th className="text-right">Cap</th>
                  <th>Status</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rules.data.items.map((rule) => (
                  <tr key={rule.id}>
                    <td className="font-medium text-slate-900">{rule.name}</td>
                    <td className="text-right tabular-nums">{rule.graceDays}</td>
                    <td className="text-right tabular-nums">{rule.percentPerMonth}</td>
                    <td className="text-right tabular-nums">
                      {rule.maxAmount > 0 ? formatMoney(rule.maxAmount) : 'No cap'}
                    </td>
                    <td>
                      <Badge tone={rule.active ? 'success' : 'neutral'}>
                        {rule.active ? 'active' : 'inactive'}
                      </Badge>
                    </td>
                    <td>
                      <div className="flex flex-wrap justify-end gap-2">
                        {canManage && (
                          <>
                            <Button size="sm" variant="ghost" onClick={() => setRuleDialog(rule)}>
                              Edit
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => toggleRule.mutate(rule)}
                              disabled={toggleRule.isPending}
                            >
                              {rule.active ? 'Disable' : 'Enable'}
                            </Button>
                            <Button
                              size="sm"
                              onClick={() => setRunRule(rule)}
                              disabled={!rule.active || !yearId}
                            >
                              Run
                            </Button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Instalment plans"
          description="Plan percentages are stored per fee structure and must total 100. Derived instalment amounts and status come from each student's charges and payments."
          actions={
            <label className="flex items-center gap-2 text-xs text-slate-500">
              Structure
              <Select
                value={structureId}
                onChange={(event) => setStructureId(event.target.value)}
                className="min-w-48"
                aria-label="Fee structure"
              >
                <option value="">Select a structure</option>
                {(structures.data?.items ?? []).map((structure) => (
                  <option key={structure.id} value={structure.id}>
                    {structure.className} · {structure.feeHeadName}
                  </option>
                ))}
              </Select>
            </label>
          }
        />
        {!structureId ? (
          <EmptyState
            title="Choose a fee structure"
            description="Instalment plans attach to a fee structure for the selected academic year."
            icon="layers"
          />
        ) : plan.isPending ? (
          <TableSkeleton rows={3} columns={4} />
        ) : plan.isError ? (
          <ErrorState message={errorMessage(plan.error)} onRetry={() => void plan.refetch()} />
        ) : (
          <PlanEditor
            key={structureId}
            schoolId={schoolId}
            structureId={structureId}
            initial={plan.data.items}
            canManage={canManage}
            onSaved={() => {
              toast.notify('success', 'Instalment plan saved.');
              void queryClient.invalidateQueries({
                queryKey: ['installment-plan', schoolId, structureId],
              });
              void queryClient.invalidateQueries({ queryKey: ['student-installments', schoolId] });
            }}
          />
        )}
      </Card>

      <Card>
        <CardHeader
          title="Student instalments & invoice"
          description="Derived schedule for one student's charges in the selected year, plus a printable invoice."
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={studentId}
                onChange={(event) => setStudentId(event.target.value)}
                className="min-w-56"
                aria-label="Student"
              >
                <option value="">Select a student</option>
                {studentOptions.map((student) => (
                  <option key={student.id} value={student.id}>
                    {fullName(student.firstName, null, student.lastName)} · {student.admissionNumber}
                  </option>
                ))}
              </Select>
              {studentId && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    window.open(
                      studentInvoiceUrl(schoolId, studentId, yearId || undefined),
                      '_blank',
                      'noopener',
                    )
                  }
                >
                  Open invoice
                </Button>
              )}
            </div>
          }
        />
        {!studentId ? (
          <EmptyState
            title="Select a student"
            description="Choose a student to view their derived instalment schedule."
            icon="users"
          />
        ) : installments.isPending ? (
          <TableSkeleton rows={4} columns={4} />
        ) : installments.isError ? (
          <ErrorState
            message={errorMessage(installments.error)}
            onRetry={() => void installments.refetch()}
          />
        ) : installments.data.items.length === 0 ? (
          <EmptyState
            title="No charges"
            description="This student has no charges in the selected academic year."
            icon="clipboard"
          />
        ) : (
          <div className="space-y-5 p-5">
            {installments.data.items.map((charge) => (
              <section key={charge.chargeId} className="rounded-lg border border-slate-200">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{charge.description}</p>
                    <p className="text-xs text-slate-500">
                      Net {formatMoney(charge.amount)} · paid {formatMoney(charge.paidAmount)}
                    </p>
                  </div>
                  <Badge tone={charge.installments.length > 0 ? 'info' : 'neutral'}>
                    {charge.installments.length > 0
                      ? `${charge.installments.length} instalments`
                      : 'No plan'}
                  </Badge>
                </div>
                {charge.installments.length > 0 && (
                  <div className="overflow-x-auto">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>Label</th>
                          <th className="text-right">%</th>
                          <th className="text-right">Amount</th>
                          <th className="text-right">Paid</th>
                          <th>Due</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {charge.installments.map((item) => (
                          <tr key={`${charge.chargeId}-${item.sequence}`}>
                            <td>{item.sequence}</td>
                            <td>{item.label}</td>
                            <td className="text-right tabular-nums">{item.percent}</td>
                            <td className="text-right tabular-nums">{formatMoney(item.amount)}</td>
                            <td className="text-right tabular-nums">
                              {formatMoney(item.paidAmount)}
                            </td>
                            <td>{formatDate(item.dueOn)}</td>
                            <td>
                              <Badge tone={STATUS_TONES[item.status] ?? 'neutral'}>
                                {item.status}
                              </Badge>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            ))}
          </div>
        )}
      </Card>

      {ruleDialog && (
        <LateRuleDialog
          schoolId={schoolId}
          rule={ruleDialog === 'new' ? undefined : ruleDialog}
          onClose={() => setRuleDialog(null)}
          onSaved={() => {
            toast.notify('success', 'Late-fee rule saved.');
            setRuleDialog(null);
            void queryClient.invalidateQueries({ queryKey: ['late-fee-rules', schoolId] });
          }}
        />
      )}

      {runRule && (
        <LateFeeRunDialog
          schoolId={schoolId}
          rule={runRule}
          yearId={yearId}
          onClose={() => setRunRule(null)}
          onRan={() => {
            void queryClient.invalidateQueries({ queryKey: ['fee-charges', schoolId] });
            void queryClient.invalidateQueries({ queryKey: ['fee-overview', schoolId] });
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------- plan editor ------------------------------ */

function PlanEditor({
  schoolId,
  structureId,
  initial,
  canManage,
  onSaved,
}: {
  schoolId: string;
  structureId: string;
  initial: InstallmentPlanItem[];
  canManage: boolean;
  onSaved: () => void;
}): ReactNode {
  const timeZone = useSchoolTimezone();
  const [items, setItems] = useState<InstallmentPlanItem[]>(
    initial.length > 0
      ? initial
      : [{ sequence: 1, label: 'First instalment', percent: 50, dueOn: todayIso(timeZone) }],
  );
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => saveInstallmentPlan(schoolId, structureId, items),
    onSuccess: onSaved,
    onError: (caught) => setError(errorMessage(caught)),
  });

  const total = Math.round(items.reduce((sum, item) => sum + item.percent, 0) * 100) / 100;

  function update(index: number, patch: Partial<InstallmentPlanItem>): void {
    setItems((current) =>
      current.map((item, position) => (position === index ? { ...item, ...patch } : item)),
    );
  }

  return (
    <div className="space-y-4 p-5">
      {items.length === 0 ? (
        <p className="text-sm text-slate-500">No instalments defined for this structure.</p>
      ) : (
        <div className="space-y-3">
          {items.map((item, index) => (
            <div key={index} className="grid gap-3 sm:grid-cols-[4rem_1fr_6rem_10rem_auto]">
              <Field label="Seq" htmlFor={`plan-seq-${index}`}>
                <Input
                  id={`plan-seq-${index}`}
                  type="number"
                  min={1}
                  max={24}
                  value={item.sequence}
                  onChange={(event) => update(index, { sequence: Number(event.target.value) || 1 })}
                  disabled={!canManage}
                />
              </Field>
              <Field label="Label" htmlFor={`plan-label-${index}`}>
                <Input
                  id={`plan-label-${index}`}
                  value={item.label}
                  onChange={(event) => update(index, { label: event.target.value })}
                  disabled={!canManage}
                />
              </Field>
              <Field label="Percent" htmlFor={`plan-percent-${index}`}>
                <Input
                  id={`plan-percent-${index}`}
                  type="number"
                  min={0.01}
                  max={100}
                  step="0.01"
                  value={item.percent}
                  onChange={(event) => update(index, { percent: Number(event.target.value) || 0 })}
                  disabled={!canManage}
                />
              </Field>
              <Field label="Due on" htmlFor={`plan-due-${index}`}>
                <Input
                  id={`plan-due-${index}`}
                  type="date"
                  value={item.dueOn}
                  onChange={(event) => update(index, { dueOn: event.target.value })}
                  disabled={!canManage}
                />
              </Field>
              {canManage && (
                <div className="flex items-end pb-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setItems((current) => current.filter((_, position) => position !== index))
                    }
                    disabled={items.length === 1}
                  >
                    Remove
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={total === 100 ? 'text-xs text-slate-500' : 'text-xs font-medium text-amber-700'}>
          Percent total: {total}% {total === 100 ? '' : '(must equal 100)'}
        </p>
        {canManage && (
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                setItems((current) => [
                  ...current,
                  {
                    sequence: current.length + 1,
                    label: `Instalment ${current.length + 1}`,
                    percent: 0,
                    dueOn: todayIso(timeZone),
                  },
                ])
              }
            >
              Add row
            </Button>
            <Button
              size="sm"
              onClick={() => save.mutate()}
              loading={save.isPending}
              disabled={total !== 100 || items.length === 0}
            >
              Save plan
            </Button>
          </div>
        )}
      </div>

      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  );
}

/* ------------------------------- late rule form --------------------------- */

function LateRuleDialog({
  schoolId,
  rule,
  onClose,
  onSaved,
}: {
  schoolId: string;
  rule?: LateFeeRuleRecord;
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  const [name, setName] = useState(rule?.name ?? '');
  const [graceDays, setGraceDays] = useState(String(rule?.graceDays ?? 5));
  const [percentPerMonth, setPercentPerMonth] = useState(String(rule?.percentPerMonth ?? 1));
  const [maxAmount, setMaxAmount] = useState(String(rule?.maxAmount ?? 0));
  const [active, setActive] = useState(rule?.active ?? true);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});

  const mutation = useMutation({
    mutationFn: () => {
      const payload = {
        name: name.trim(),
        graceDays: Number(graceDays || 0),
        percentPerMonth: Number(percentPerMonth || 0),
        maxAmount: Number(maxAmount || 0),
        active,
      };
      return rule
        ? updateLateFeeRule(schoolId, rule.id, payload)
        : createLateFeeRule(schoolId, payload);
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
      title={rule ? `Edit ${rule.name}` : 'New late-fee rule'}
      description="Grace days delay assessment after the due date. A cap of 0 means no cap."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button form="late-rule-form" type="submit" loading={mutation.isPending}>
            Save rule
          </Button>
        </>
      }
    >
      <form id="late-rule-form" className="space-y-4" onSubmit={submit} noValidate>
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Name" htmlFor="late-rule-name" required error={errors.name?.[0]}>
          <Input
            id="late-rule-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Standard late fee"
            required
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Grace days" htmlFor="late-rule-grace" error={errors.graceDays?.[0]}>
            <Input
              id="late-rule-grace"
              type="number"
              min={0}
              max={365}
              value={graceDays}
              onChange={(event) => setGraceDays(event.target.value)}
            />
          </Field>
          <Field label="% per month" htmlFor="late-rule-percent" error={errors.percentPerMonth?.[0]}>
            <Input
              id="late-rule-percent"
              type="number"
              min={0}
              max={100}
              step="0.01"
              value={percentPerMonth}
              onChange={(event) => setPercentPerMonth(event.target.value)}
            />
          </Field>
          <Field label="Maximum fee" htmlFor="late-rule-max" error={errors.maxAmount?.[0]}>
            <Input
              id="late-rule-max"
              type="number"
              min={0}
              step="0.01"
              value={maxAmount}
              onChange={(event) => setMaxAmount(event.target.value)}
            />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={active}
            onChange={(event) => setActive(event.target.checked)}
          />
          Active
        </label>
      </form>
    </Dialog>
  );
}

/* ------------------------------- run dialog ------------------------------- */

function LateFeeRunDialog({
  schoolId,
  rule,
  yearId,
  onClose,
  onRan,
}: {
  schoolId: string;
  rule: LateFeeRuleRecord;
  yearId: string;
  onClose: () => void;
  onRan: () => void;
}): ReactNode {
  const timeZone = useSchoolTimezone();
  const [asOf, setAsOf] = useState(todayIso(timeZone));
  const [error, setError] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: () =>
      runLateFees(schoolId, {
        ruleId: rule.id,
        asOf,
        academicYearId: yearId || undefined,
      }),
    onSuccess: onRan,
    onError: (caught) => setError(errorMessage(caught)),
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Run late fees · ${rule.name}`}
      description="Overdue charges with an outstanding balance are assessed once per charge per day."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={run.isPending}>
            Close
          </Button>
          <Button onClick={() => run.mutate()} loading={run.isPending}>
            Run assessment
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Assess as of" htmlFor="late-run-date">
          <Input
            id="late-run-date"
            type="date"
            value={asOf}
            onChange={(event) => setAsOf(event.target.value)}
          />
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
        {run.data && (
          <Alert tone={run.data.assessed > 0 ? 'success' : 'info'}>
            Assessed {run.data.assessed} charge{run.data.assessed === 1 ? '' : 's'}; skipped{' '}
            {run.data.skipped}. Total late fee posted: {formatMoney(run.data.totalFee)}.
          </Alert>
        )}
      </div>
    </Dialog>
  );
}
