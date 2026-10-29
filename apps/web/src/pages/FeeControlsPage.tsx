import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import type { ReconciliationBatch, ReconciliationLine } from '@erp/shared';
import { useAuth, useSchoolId } from '../auth/AuthContext';
import {
  addReconciliationLine,
  closeReconciliationBatch,
  createReconciliationBatch,
  createWriteOff,
  decideConcession,
  deleteReconciliationLine,
  getReconciliationBatch,
  listAcademicYears,
  listCharges,
  listConcessions,
  listReconciliationBatches,
  listReconciliationPayments,
  listStudents,
  listWriteOffs,
  matchReconciliationLine,
  requestConcession,
} from '../lib/endpoints';
import { errorMessage } from '../lib/api';
import { formatDate, formatDateTime, formatMoney, todayIso } from '../lib/format';
import { Dialog } from '../components/Dialog';
import { Tabs } from '../components/Tabs';
import { useToast } from '../components/ToastProvider';
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
  StatCard,
  TableSkeleton,
  Textarea,
} from '../components/ui';

type Tab = 'concessions' | 'write-offs' | 'reconciliation';

const CONCESSION_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
const BATCH_STATUSES = ['draft', 'balanced', 'closed'] as const;
const PAYMENT_METHODS = ['cash', 'bank_transfer', 'card', 'upi', 'cheque', 'other'] as const;

type DialogState =
  | { kind: 'concession' }
  | { kind: 'write-off' }
  | { kind: 'batch' }
  | { kind: 'batch-detail'; id: string }
  | null;

export function FeeControlsPage(): ReactNode {
  const schoolId = useSchoolId();
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();

  const canView = can('fees.view');
  const canApproveConcession = can('fees.concession.approve');
  const canWriteOff = can('fees.writeoff.approve');
  const canReconcile = can('fees.reconciliation.manage');

  const [tab, setTab] = useState<Tab>('concessions');
  const [concessionStatus, setConcessionStatus] = useState('');
  const [batchStatus, setBatchStatus] = useState('');
  const [dialog, setDialog] = useState<DialogState>(null);
  const [formError, setFormError] = useState('');

  const concessions = useQuery({
    queryKey: ['fee-concessions', schoolId, concessionStatus],
    queryFn: () => listConcessions(schoolId, concessionStatus || undefined),
    enabled: canView && tab === 'concessions',
  });
  const writeOffs = useQuery({
    queryKey: ['fee-write-offs', schoolId],
    queryFn: () => listWriteOffs(schoolId),
    enabled: canView && tab === 'write-offs',
  });
  const batches = useQuery({
    queryKey: ['reconciliation-batches', schoolId, batchStatus],
    queryFn: () => listReconciliationBatches(schoolId, batchStatus || undefined),
    enabled: canView && tab === 'reconciliation',
  });
  const students = useQuery({
    queryKey: ['students', schoolId, 'fee-controls'],
    queryFn: () => listStudents(schoolId, { pageSize: 200 }),
    enabled: canView && (dialog?.kind === 'concession' || dialog?.kind === 'write-off'),
  });
  const years = useQuery({
    queryKey: ['academic-years', schoolId],
    queryFn: () => listAcademicYears(schoolId),
    enabled: canView && dialog?.kind === 'concession',
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['fee-concessions', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['fee-write-offs', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['reconciliation-batches', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['reconciliation-batch', schoolId] });
  };

  const createConcession = useMutation({
    mutationFn: (input: Parameters<typeof requestConcession>[1]) =>
      requestConcession(schoolId, input),
    onSuccess: () => {
      toast.notify('success', 'Concession requested.');
      setDialog(null);
      invalidate();
    },
    onError: (error) => setFormError(errorMessage(error)),
  });
  const decide = useMutation({
    mutationFn: (input: { id: string; decision: 'approve' | 'reject'; note?: string }) =>
      decideConcession(schoolId, input.id, {
        decision: input.decision,
        note: input.note,
      }),
    onSuccess: () => {
      toast.notify('success', 'Concession updated.');
      invalidate();
    },
    onError: (error) => toast.notify('error', errorMessage(error)),
  });
  const writeOff = useMutation({
    mutationFn: (input: Parameters<typeof createWriteOff>[1]) => createWriteOff(schoolId, input),
    onSuccess: () => {
      toast.notify('success', 'Write-off recorded.');
      setDialog(null);
      invalidate();
    },
    onError: (error) => setFormError(errorMessage(error)),
  });
  const createBatch = useMutation({
    mutationFn: (input: Parameters<typeof createReconciliationBatch>[1]) =>
      createReconciliationBatch(schoolId, input),
    onSuccess: (result) => {
      toast.notify('success', 'Reconciliation batch created.');
      setDialog({ kind: 'batch-detail', id: result.id });
      invalidate();
    },
    onError: (error) => setFormError(errorMessage(error)),
  });

  const studentOptions = (students.data?.items ?? []).map((student) => ({
    id: student.id,
    name: `${student.firstName} ${student.lastName ?? ''}`.trim(),
    admissionNumber: student.admissionNumber,
  }));
  const yearOptions = (years.data?.items ?? []).map((year) => ({
    id: year.id,
    name: year.name,
    status: year.status,
  }));

  const tabs: Array<{ value: Tab; label: string }> = [
    { value: 'concessions', label: 'Concessions' },
    { value: 'write-offs', label: 'Write-offs' },
    ...(canReconcile ? [{ value: 'reconciliation' as Tab, label: 'Reconciliation' }] : []),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Fee controls"
        description="Concessions, write-offs and bank reconciliation. Approval is separate from requesting, and reconciliation never creates a payment from a statement line."
        actions={
          <div className="flex flex-wrap gap-2">
            {canView && (
              <Button variant="secondary" onClick={() => setDialog({ kind: 'concession' })}>
                Request concession
              </Button>
            )}
            {canWriteOff && (
              <Button variant="secondary" onClick={() => setDialog({ kind: 'write-off' })}>
                Record write-off
              </Button>
            )}
            {canReconcile && (
              <Button onClick={() => setDialog({ kind: 'batch' })}>
                <Icon name="plus" className="h-4 w-4" />
                New batch
              </Button>
            )}
          </div>
        }
      />

      <Tabs value={tab} onChange={setTab} tabs={tabs} label="Fee control views" />

      {tab === 'concessions' && canView && (
        <Card>
          <CardHeader
            title="Concession requests"
            description="A concession request only changes the charge when an authorised reviewer approves it. Reviewers cannot approve their own request."
            actions={
              <Select
                aria-label="Filter concessions by status"
                value={concessionStatus}
                onChange={(event) => setConcessionStatus(event.target.value)}
                className="w-36"
              >
                <option value="">All statuses</option>
                {CONCESSION_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </Select>
            }
          />
          {concessions.isPending ? (
            <TableSkeleton rows={5} columns={6} />
          ) : concessions.isError ? (
            <ErrorState
              message={errorMessage(concessions.error)}
              onRetry={() => void concessions.refetch()}
            />
          ) : (concessions.data?.items.length ?? 0) === 0 ? (
            <EmptyState
              title="No concession requests"
              description="Request a concession against an existing charge."
              icon="clipboard"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Student</th>
                    <th>Charge</th>
                    <th className="text-right">Amount</th>
                    <th>Reason</th>
                    <th>Requested</th>
                    <th>Status</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {concessions.data!.items.map((row) => (
                    <tr key={row.id}>
                      <td className="font-medium text-slate-900">{row.studentName}</td>
                      <td className="text-sm text-slate-600">{row.chargeDescription}</td>
                      <td className="text-right tabular-nums">{formatMoney(row.amount)}</td>
                      <td className="max-w-xs text-sm text-slate-600">{row.reason}</td>
                      <td className="text-sm text-slate-600">
                        {row.requestedByName ?? '—'} · {formatDateTime(row.requestedAt)}
                      </td>
                      <td>
                        <Badge
                          tone={
                            row.status === 'approved'
                              ? 'success'
                              : row.status === 'rejected'
                                ? 'danger'
                                : row.status === 'pending'
                                  ? 'warning'
                                  : 'neutral'
                          }
                        >
                          {row.status}
                        </Badge>
                        {row.reviewedByName && (
                          <p className="mt-1 text-xs text-slate-500">
                            {row.reviewedByName}
                            {row.reviewNote ? ` · ${row.reviewNote}` : ''}
                          </p>
                        )}
                      </td>
                      <td>
                        {canApproveConcession && row.status === 'pending' && (
                          <div className="flex flex-wrap justify-end gap-2">
                            <Button
                              size="sm"
                              loading={decide.isPending}
                              onClick={() =>
                                decide.mutate({ id: row.id, decision: 'approve' })
                              }
                            >
                              Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              loading={decide.isPending}
                              onClick={() => decide.mutate({ id: row.id, decision: 'reject' })}
                            >
                              Reject
                            </Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'write-offs' && canView && (
        <Card>
          <CardHeader
            title="Write-offs"
            description="A write-off reduces the unpaid balance of a charge. It can never exceed the outstanding amount."
            actions={
              canWriteOff ? (
                <Button size="sm" onClick={() => setDialog({ kind: 'write-off' })}>
                  Record write-off
                </Button>
              ) : undefined
            }
          />
          {writeOffs.isPending ? (
            <TableSkeleton rows={5} columns={5} />
          ) : writeOffs.isError ? (
            <ErrorState
              message={errorMessage(writeOffs.error)}
              onRetry={() => void writeOffs.refetch()}
            />
          ) : (writeOffs.data?.items.length ?? 0) === 0 ? (
            <EmptyState
              title="No write-offs"
              description="Approved write-offs appear here with the approver and reason."
              icon="clipboard"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Student</th>
                    <th>Charge</th>
                    <th className="text-right">Amount</th>
                    <th>Reason</th>
                    <th>Approved</th>
                  </tr>
                </thead>
                <tbody>
                  {writeOffs.data!.items.map((row) => (
                    <tr key={row.id}>
                      <td className="font-medium text-slate-900">{row.studentName}</td>
                      <td className="text-sm text-slate-600">{row.chargeDescription}</td>
                      <td className="text-right tabular-nums">{formatMoney(row.amount)}</td>
                      <td className="max-w-xs text-sm text-slate-600">{row.reason}</td>
                      <td className="text-sm text-slate-600">
                        {row.approvedByName ?? '—'} · {formatDateTime(row.approvedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'reconciliation' && canReconcile && (
        <Card>
          <CardHeader
            title="Bank reconciliation"
            description="Import statement lines, then match each line to an existing recorded payment. Amounts must match exactly unless the line is explicitly marked as an exception."
            actions={
              <div className="flex flex-wrap gap-2">
                <Select
                  aria-label="Filter batches by status"
                  value={batchStatus}
                  onChange={(event) => setBatchStatus(event.target.value)}
                  className="w-36"
                >
                  <option value="">All statuses</option>
                  {BATCH_STATUSES.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </Select>
                <Button size="sm" onClick={() => setDialog({ kind: 'batch' })}>
                  New batch
                </Button>
              </div>
            }
          />
          {batches.isPending ? (
            <TableSkeleton rows={5} columns={6} />
          ) : batches.isError ? (
            <ErrorState
              message={errorMessage(batches.error)}
              onRetry={() => void batches.refetch()}
            />
          ) : (batches.data?.items.length ?? 0) === 0 ? (
            <EmptyState
              title="No reconciliation batches"
              description="Create a batch to compare a bank or gateway statement with recorded payments."
              icon="clipboard"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Reference</th>
                    <th>Source</th>
                    <th>Statement period</th>
                    <th className="text-right">Lines</th>
                    <th className="text-right">Matched</th>
                    <th>Status</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {batches.data!.items.map((row) => (
                    <tr key={row.id}>
                      <td className="font-mono text-xs">{row.reference}</td>
                      <td className="text-sm text-slate-600">{row.source}</td>
                      <td className="text-sm text-slate-600">
                        {formatDate(row.statementFrom)} – {formatDate(row.statementTo)}
                      </td>
                      <td className="text-right tabular-nums">{row.lineCount}</td>
                      <td className="text-right tabular-nums">
                        {row.matchedCount}
                        {row.exceptionCount > 0 ? ` (+${row.exceptionCount} exc.)` : ''}
                      </td>
                      <td>
                        <Badge
                          tone={
                            row.status === 'balanced'
                              ? 'success'
                              : row.status === 'closed'
                                ? 'neutral'
                                : 'warning'
                          }
                        >
                          {row.status}
                        </Badge>
                      </td>
                      <td className="text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDialog({ kind: 'batch-detail', id: row.id })}
                        >
                          Open
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {dialog?.kind === 'concession' && (
        <ConcessionDialog
          schoolId={schoolId}
          students={studentOptions}
          years={yearOptions}
          error={formError}
          saving={createConcession.isPending}
          onClose={() => {
            setDialog(null);
            setFormError('');
          }}
          onSave={(body) => createConcession.mutate(body)}
        />
      )}

      {dialog?.kind === 'write-off' && (
        <WriteOffDialog
          schoolId={schoolId}
          students={studentOptions}
          error={formError}
          saving={writeOff.isPending}
          onClose={() => {
            setDialog(null);
            setFormError('');
          }}
          onSave={(body) => writeOff.mutate(body)}
        />
      )}

      {dialog?.kind === 'batch' && (
        <BatchDialog
          error={formError}
          saving={createBatch.isPending}
          onClose={() => {
            setDialog(null);
            setFormError('');
          }}
          onSave={(body) => createBatch.mutate(body)}
        />
      )}

      {dialog?.kind === 'batch-detail' && (
        <BatchDetailDialog
          schoolId={schoolId}
          batchId={dialog.id}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

function ConcessionDialog({
  schoolId,
  students,
  years,
  error,
  saving,
  onClose,
  onSave,
}: {
  schoolId: string;
  students: Array<{ id: string; name: string; admissionNumber: string }>;
  years: Array<{ id: string; name: string; status: string }>;
  error: string;
  saving: boolean;
  onClose: () => void;
  onSave: (body: Parameters<typeof requestConcession>[1]) => void;
}): ReactNode {
  const [studentId, setStudentId] = useState('');
  const [academicYearId, setAcademicYearId] = useState(
    years.find((year) => year.status === 'active')?.id ?? '',
  );
  const [chargeId, setChargeId] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');

  const charges = useQuery({
    queryKey: ['charges', schoolId, studentId, academicYearId],
    queryFn: () =>
      listCharges(schoolId, {
        studentId,
        academicYearId: academicYearId || undefined,
      }),
    enabled: Boolean(studentId),
  });
  const chargeOptions = charges.data?.items ?? [];

  return (
    <Dialog
      open
      onClose={onClose}
      title="Request concession"
      description="A concession is a request only. The charge changes only after approval by another authorised user."
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="concession-form" loading={saving}>
            Submit request
          </Button>
        </>
      }
    >
      <form
        id="concession-form"
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({ studentId, academicYearId, chargeId, amount: Number(amount), reason });
        }}
      >
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Student" htmlFor="conc-student" required>
            <Select
              id="conc-student"
              value={studentId}
              onChange={(event) => {
                setStudentId(event.target.value);
                setChargeId('');
              }}
              required
            >
              <option value="">Select student</option>
              {students.map((student) => (
                <option key={student.id} value={student.id}>
                  {student.name} · {student.admissionNumber}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Academic year" htmlFor="conc-year" required>
            <Select
              id="conc-year"
              value={academicYearId}
              onChange={(event) => {
                setAcademicYearId(event.target.value);
                setChargeId('');
              }}
              required
            >
              <option value="">Select year</option>
              {years.map((year) => (
                <option key={year.id} value={year.id}>
                  {year.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field
          label="Charge"
          htmlFor="conc-charge"
          required
          hint={
            !studentId
              ? 'Select a student first.'
              : chargeOptions.length === 0
                ? 'This student has no charges for the selected year.'
                : 'Only charges for this student and year are shown.'
          }
        >
          <Select
            id="conc-charge"
            value={chargeId}
            onChange={(event) => setChargeId(event.target.value)}
            required
            disabled={!studentId || chargeOptions.length === 0}
          >
            <option value="">{studentId ? 'Select charge' : 'Select student first'}</option>
            {chargeOptions.map((charge) => (
              <option key={charge.id} value={charge.id}>
                {charge.description} · {formatMoney(charge.amount)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Concession amount" htmlFor="conc-amount" required>
          <Input
            id="conc-amount"
            type="number"
            min={0.01}
            step="0.01"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            required
          />
        </Field>
        <Field label="Reason" htmlFor="conc-reason" required>
          <Textarea
            id="conc-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={2000}
            required
          />
        </Field>
      </form>
    </Dialog>
  );
}

function WriteOffDialog({
  schoolId,
  students,
  error,
  saving,
  onClose,
  onSave,
}: {
  schoolId: string;
  students: Array<{ id: string; name: string; admissionNumber: string }>;
  error: string;
  saving: boolean;
  onClose: () => void;
  onSave: (body: Parameters<typeof createWriteOff>[1]) => void;
}): ReactNode {
  const [studentId, setStudentId] = useState('');
  const [chargeId, setChargeId] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const charges = useQuery({
    queryKey: ['charges', schoolId, studentId, 'write-off'],
    queryFn: () => listCharges(schoolId, { studentId }),
    enabled: Boolean(studentId),
  });
  const chargeOptions = charges.data?.items ?? [];
  const selectedCharge = chargeOptions.find((charge) => charge.id === chargeId);

  return (
    <Dialog
      open
      onClose={onClose}
      title="Record write-off"
      description="A write-off reduces the unpaid balance. It cannot exceed what is still outstanding."
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="writeoff-form" loading={saving}>
            Record write-off
          </Button>
        </>
      }
    >
      <form
        id="writeoff-form"
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({ chargeId, amount: Number(amount), reason });
        }}
      >
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Student" htmlFor="wo-student" required>
          <Select
            id="wo-student"
            value={studentId}
            onChange={(event) => {
              setStudentId(event.target.value);
              setChargeId('');
            }}
            required
          >
            <option value="">Select student</option>
            {students.map((student) => (
              <option key={student.id} value={student.id}>
                {student.name} · {student.admissionNumber}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Charge"
          htmlFor="wo-charge"
          required
          hint={
            !studentId
              ? 'Select a student first.'
              : chargeOptions.length === 0
                ? 'This student has no charges.'
                : 'The unpaid balance is checked again when saving.'
          }
        >
          <Select
            id="wo-charge"
            value={chargeId}
            onChange={(event) => setChargeId(event.target.value)}
            required
            disabled={!studentId || chargeOptions.length === 0}
          >
            <option value="">{studentId ? 'Select charge' : 'Select student first'}</option>
            {chargeOptions.map((charge) => (
              <option key={charge.id} value={charge.id}>
                {charge.description} · {formatMoney(charge.amount)}
              </option>
            ))}
          </Select>
        </Field>
        {selectedCharge && (
          <p className="text-xs text-slate-500">
            Charge amount {formatMoney(selectedCharge.amount)}; already conceded{' '}
            {formatMoney(selectedCharge.concessionAmount)}; written off{' '}
            {formatMoney(selectedCharge.writeOffAmount ?? 0)}.
          </p>
        )}
        <Field label="Write-off amount" htmlFor="wo-amount" required>
          <Input
            id="wo-amount"
            type="number"
            min={0.01}
            step="0.01"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            required
          />
        </Field>
        <Field label="Reason" htmlFor="wo-reason" required>
          <Textarea
            id="wo-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={2000}
            required
          />
        </Field>
      </form>
    </Dialog>
  );
}

function BatchDialog({
  error,
  saving,
  onClose,
  onSave,
}: {
  error: string;
  saving: boolean;
  onClose: () => void;
  onSave: (body: Parameters<typeof createReconciliationBatch>[1]) => void;
}): ReactNode {
  const [reference, setReference] = useState('');
  const [source, setSource] = useState('bank');
  const [statementFrom, setStatementFrom] = useState(todayIso());
  const [statementTo, setStatementTo] = useState(todayIso());
  const [openingBalance, setOpeningBalance] = useState('');
  const [closingBalance, setClosingBalance] = useState('');
  const [notes, setNotes] = useState('');

  return (
    <Dialog
      open
      onClose={onClose}
      title="New reconciliation batch"
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="batch-form" loading={saving}>
            Create batch
          </Button>
        </>
      }
    >
      <form
        id="batch-form"
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({
            reference,
            source,
            statementFrom: statementFrom || null,
            statementTo: statementTo || null,
            openingBalance: openingBalance ? Number(openingBalance) : null,
            closingBalance: closingBalance ? Number(closingBalance) : null,
            notes: notes || undefined,
          });
        }}
      >
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Reference" htmlFor="batch-ref" required>
            <Input
              id="batch-ref"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              required
            />
          </Field>
          <Field label="Source" htmlFor="batch-source">
            <Input
              id="batch-source"
              value={source}
              onChange={(event) => setSource(event.target.value)}
            />
          </Field>
          <Field label="Statement from" htmlFor="batch-from">
            <Input
              id="batch-from"
              type="date"
              value={statementFrom}
              onChange={(event) => setStatementFrom(event.target.value)}
            />
          </Field>
          <Field label="Statement to" htmlFor="batch-to">
            <Input
              id="batch-to"
              type="date"
              value={statementTo}
              onChange={(event) => setStatementTo(event.target.value)}
            />
          </Field>
          <Field label="Opening balance" htmlFor="batch-opening">
            <Input
              id="batch-opening"
              type="number"
              step="0.01"
              value={openingBalance}
              onChange={(event) => setOpeningBalance(event.target.value)}
            />
          </Field>
          <Field label="Closing balance" htmlFor="batch-closing">
            <Input
              id="batch-closing"
              type="number"
              step="0.01"
              value={closingBalance}
              onChange={(event) => setClosingBalance(event.target.value)}
            />
          </Field>
        </div>
        <Field label="Notes" htmlFor="batch-notes">
          <Textarea
            id="batch-notes"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            maxLength={1000}
          />
        </Field>
      </form>
    </Dialog>
  );
}

function BatchDetailDialog({
  schoolId,
  batchId,
  onClose,
}: {
  schoolId: string;
  batchId: string;
  onClose: () => void;
}): ReactNode {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [paidOn, setPaidOn] = useState(todayIso());
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [method, setMethod] = useState<(typeof PAYMENT_METHODS)[number]>('bank_transfer');
  const [busy, setBusy] = useState(false);

  const detail = useQuery({
    queryKey: ['reconciliation-batch', schoolId, batchId],
    queryFn: () => getReconciliationBatch(schoolId, batchId),
  });
  const payments = useQuery({
    queryKey: ['reconciliation-payments', schoolId],
    queryFn: () => listReconciliationPayments(schoolId, {}),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['reconciliation-batch', schoolId, batchId] });
    void queryClient.invalidateQueries({ queryKey: ['reconciliation-batches', schoolId] });
  };

  const run = async (action: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try {
      await action();
      toast.notify('success', message);
      refresh();
    } catch (error) {
      toast.notify('error', errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const batch = detail.data;
  const lines = batch?.lines ?? [];
  const paymentOptions = (payments.data?.items ?? []).filter((payment) => !payment.matched);

  return (
    <Dialog
      open
      onClose={onClose}
      title={batch ? `Reconciliation · ${batch.reference}` : 'Reconciliation batch'}
      description={batch ? `${batch.source} · ${batch.status}` : undefined}
      size="lg"
    >
      {detail.isPending ? (
        <TableSkeleton rows={6} columns={4} />
      ) : detail.isError ? (
        <ErrorState message={errorMessage(detail.error)} onRetry={() => void detail.refetch()} />
      ) : batch ? (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-4">
            <StatCard label="Lines" value={String(batch.lineCount)} />
            <StatCard label="Matched" value={String(batch.matchedCount)} />
            <StatCard label="Exceptions" value={String(batch.exceptionCount)} />
            <StatCard label="Matched total" value={formatMoney(batch.matchedTotal)} />
          </div>
          {batch.notes && <p className="text-sm text-slate-600">{batch.notes}</p>}

          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="text-right">#</th>
                  <th>Paid on</th>
                  <th className="text-right">Amount</th>
                  <th>Reference</th>
                  <th>Method</th>
                  <th>Status</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {lines.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="text-sm text-slate-500">
                      No statement lines yet. Add the first line below.
                    </td>
                  </tr>
                ) : (
                  lines.map((line) => (
                    <LineRow
                      key={line.id}
                      line={line}
                      batchStatus={batch.status}
                      payments={paymentOptions}
                      busy={busy}
                      onMatch={(paymentId) =>
                        void run(
                          () =>
                            matchReconciliationLine(schoolId, batchId, line.id, { paymentId }),
                          'Line matched.',
                        )
                      }
                      onException={(reason) =>
                        void run(
                          () =>
                            matchReconciliationLine(schoolId, batchId, line.id, {
                              exceptionReason: reason,
                            }),
                          'Line marked as exception.',
                        )
                      }
                      onDelete={() =>
                        void run(
                          () => deleteReconciliationLine(schoolId, batchId, line.id),
                          'Line removed.',
                        )
                      }
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>

          {batch.status !== 'closed' && (
            <form
              className="space-y-3 rounded-lg border border-slate-200 p-3"
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  await addReconciliationLine(schoolId, batchId, {
                    paidOn,
                    amount: Number(amount),
                    reference: reference || undefined,
                    method,
                  });
                  setAmount('');
                  setReference('');
                }, 'Statement line added.');
              }}
            >
              <p className="text-sm font-semibold text-slate-800">Add statement line</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Paid on" htmlFor="line-date" required>
                  <Input
                    id="line-date"
                    type="date"
                    value={paidOn}
                    onChange={(event) => setPaidOn(event.target.value)}
                    required
                  />
                </Field>
                <Field label="Amount" htmlFor="line-amount" required>
                  <Input
                    id="line-amount"
                    type="number"
                    step="0.01"
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                    required
                  />
                </Field>
                <Field label="Reference" htmlFor="line-ref">
                  <Input
                    id="line-ref"
                    value={reference}
                    onChange={(event) => setReference(event.target.value)}
                  />
                </Field>
                <Field label="Method" htmlFor="line-method">
                  <Select
                    id="line-method"
                    value={method}
                    onChange={(event) => setMethod(event.target.value as typeof method)}
                  >
                    {PAYMENT_METHODS.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <div className="flex justify-end gap-2">
                <Button type="submit" size="sm" loading={busy} disabled={!amount}>
                  Add line
                </Button>
              </div>
            </form>
          )}

          {batch.status !== 'closed' && (
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                size="sm"
                variant="secondary"
                loading={busy}
                onClick={() =>
                  void run(
                    () => closeReconciliationBatch(schoolId, batchId),
                    'Reconciliation batch closed.',
                  )
                }
              >
                Close batch
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </Dialog>
  );
}

function LineRow({
  line,
  batchStatus,
  payments,
  busy,
  onMatch,
  onException,
  onDelete,
}: {
  line: ReconciliationLine;
  batchStatus: ReconciliationBatch['status'];
  payments: Array<{
    id: string;
    receiptNumber: string;
    studentName: string;
    amount: number;
    paidOn: string;
  }>;
  busy: boolean;
  onMatch: (paymentId: string) => void;
  onException: (reason: string) => void;
  onDelete: () => void;
}): ReactNode {
  const [paymentId, setPaymentId] = useState('');
  const [reason, setReason] = useState('');

  return (
    <tr>
      <td className="text-right tabular-nums">{line.lineNo}</td>
      <td>{formatDate(line.paidOn)}</td>
      <td className="text-right tabular-nums">{formatMoney(line.amount)}</td>
      <td className="text-sm text-slate-600">{line.reference ?? '—'}</td>
      <td className="text-sm text-slate-600">{line.method}</td>
      <td>
        <Badge
          tone={
            line.status === 'matched' ? 'success' : line.status === 'exception' ? 'warning' : 'neutral'
          }
        >
          {line.status}
        </Badge>
        {line.matchedReceiptNumber && (
          <p className="text-xs text-slate-500">{line.matchedReceiptNumber}</p>
        )}
        {line.exceptionReason && (
          <p className="text-xs text-slate-500">{line.exceptionReason}</p>
        )}
      </td>
      <td>
        {batchStatus !== 'closed' && line.status === 'unmatched' && (
          <div className="flex flex-col items-end gap-1">
            <Select
              aria-label={`Match payment to line ${line.lineNo}`}
              value={paymentId}
              onChange={(event) => setPaymentId(event.target.value)}
              className="w-56"
            >
              <option value="">Select payment</option>
              {payments
                .filter((payment) => Math.abs(payment.amount - line.amount) < 0.005)
                .map((payment) => (
                  <option key={payment.id} value={payment.id}>
                    {payment.receiptNumber} · {payment.studentName} · {formatMoney(payment.amount)}
                  </option>
                ))}
            </Select>
            <div className="flex flex-wrap justify-end gap-1">
              <Button
                size="sm"
                loading={busy}
                disabled={!paymentId}
                onClick={() => onMatch(paymentId)}
              >
                Match
              </Button>
              <Input
                aria-label={`Exception reason for line ${line.lineNo}`}
                placeholder="Exception reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                className="w-40"
              />
              <Button
                size="sm"
                variant="ghost"
                loading={busy}
                disabled={reason.trim().length === 0}
                onClick={() => onException(reason)}
              >
                Exception
              </Button>
              <Button size="sm" variant="ghost" loading={busy} onClick={onDelete}>
                Delete
              </Button>
            </div>
          </div>
        )}
        {batchStatus !== 'closed' && line.status !== 'unmatched' && (
          <div className="flex justify-end gap-1">
            <Button size="sm" variant="ghost" loading={busy} onClick={onDelete}>
              Delete
            </Button>
          </div>
        )}
      </td>
    </tr>
  );
}
