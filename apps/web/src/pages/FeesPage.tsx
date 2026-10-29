import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type {
  FeeHead,
  FeeStructure,
  PaymentRecord,
  RefundRecord,
  StudentCharge,
} from '@erp/shared';
import { useAuth, useSchoolId, useSchoolTimezone } from '../auth/AuthContext';
import {
  createCharge,
  createFeeHead,
  createFeeStructure,
  generateCharges,
  getFeeLedger,
  getFeeOverview,
  listAcademicYears,
  listCharges,
  listClasses,
  listFeeHeads,
  listFeeStructures,
  listPayments,
  listRefunds,
  listSections,
  listStudents,
  paymentReceiptUrl,
  recordPayment,
  requestRefund,
  reviewRefund,
  studentInvoiceUrl,
  updateCharge,
  updateFeeHead,
  updateFeeStructure,
} from '../lib/endpoints';
import { errorMessage, fieldErrors } from '../lib/api';
import { formatDate, formatMoney, formatDateTime, todayIso } from '../lib/format';
import { Dialog, ConfirmDialog } from '../components/Dialog';
import { FeeExtrasPanel } from '../components/fees/FeeExtrasPanel';
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
  cn,
} from '../components/ui';

type Tab = 'charges' | 'payments' | 'refunds' | 'structures' | 'extras';
type DialogState =
  | { kind: 'generate' }
  | { kind: 'charge'; charge?: StudentCharge }
  | { kind: 'payment' }
  | { kind: 'refund'; payment: PaymentRecord }
  | { kind: 'ledger'; studentId: string }
  | { kind: 'structure'; structure?: FeeStructure }
  | { kind: 'head'; head?: FeeHead }
  | null;

const PAYMENT_METHODS = ['cash', 'bank_transfer', 'card', 'upi', 'cheque', 'other'] as const;

export function FeesPage(): ReactNode {
  const schoolId = useSchoolId();
  const timeZone = useSchoolTimezone();
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [yearId, setYearId] = useState('');
  const [tab, setTab] = useState<Tab>('charges');
  const [chargeStatus, setChargeStatus] = useState('');
  const [refundStatus, setRefundStatus] = useState('');
  const [dialog, setDialog] = useState<DialogState>(null);
  const [reviewing, setReviewing] = useState<{
    refund: RefundRecord;
    decision: 'approve' | 'reject';
  } | null>(null);

  const canCharge = can('fees.charge.create');
  const canVerify = can('fees.payment.verify');
  const canRefund = can('fees.refund.approve');

  const years = useQuery({
    queryKey: ['academic-years', schoolId],
    queryFn: () => listAcademicYears(schoolId),
  });
  const students = useQuery({
    queryKey: ['students', schoolId, 'fees'],
    queryFn: () => listStudents(schoolId, { pageSize: 100, status: 'active' }),
  });
  const classes = useQuery({ queryKey: ['classes', schoolId], queryFn: () => listClasses(schoolId) });
  const sections = useQuery({
    queryKey: ['sections', schoolId, yearId],
    queryFn: () => listSections(schoolId, { academicYearId: yearId }),
    enabled: Boolean(yearId),
  });
  const heads = useQuery({
    queryKey: ['fee-heads', schoolId],
    queryFn: () => listFeeHeads(schoolId),
  });
  const overview = useQuery({
    queryKey: ['fee-overview', schoolId, yearId],
    queryFn: () => getFeeOverview(schoolId, yearId || undefined),
    enabled: Boolean(yearId),
  });
  const charges = useQuery({
    queryKey: ['fee-charges', schoolId, yearId, chargeStatus],
    queryFn: () => listCharges(schoolId, { academicYearId: yearId, status: chargeStatus || undefined }),
    enabled: Boolean(yearId),
  });
  const payments = useQuery({
    queryKey: ['fee-payments', schoolId, yearId],
    queryFn: () => listPayments(schoolId, { academicYearId: yearId }),
    enabled: Boolean(yearId),
  });
  const refunds = useQuery({
    queryKey: ['fee-refunds', schoolId, refundStatus],
    queryFn: () => listRefunds(schoolId, refundStatus || undefined),
  });
  const structures = useQuery({
    queryKey: ['fee-structures', schoolId, yearId],
    queryFn: () => listFeeStructures(schoolId, { academicYearId: yearId }),
    enabled: Boolean(yearId),
  });

  useEffect(() => {
    if (yearId || !years.data) return;
    const preferred =
      years.data.items.find((year) => year.status === 'active') ?? years.data.items[0];
    if (preferred) setYearId(preferred.id);
  }, [years.data, yearId]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['fee-charges', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['fee-payments', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['fee-refunds', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['fee-overview', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['fee-structures', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['fee-heads', schoolId] });
  };

  const review = useMutation({
    mutationFn: (input: { refund: RefundRecord; decision: 'approve' | 'reject' }) =>
      reviewRefund(schoolId, input.refund.id, { decision: input.decision }),
    onSuccess: (saved) => {
      toast.notify('success', `Refund ${saved.status}.`);
      setReviewing(null);
      invalidate();
    },
    onError: (error) => {
      setReviewing(null);
      toast.notify('error', errorMessage(error));
    },
  });

  const activeHeads = heads.data?.items.filter((head) => head.status === 'active') ?? [];
  const studentOptions = students.data?.items ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Fees"
        description="Charges, receipts, refunds and class fee structures. Every balance is derived from the ledger; nothing is stored twice."
        actions={
          <>
            {canCharge && (
              <Button variant="secondary" onClick={() => setDialog({ kind: 'generate' })} disabled={!yearId}>
                Generate charges
              </Button>
            )}
            {canCharge && (
              <Button variant="secondary" onClick={() => setDialog({ kind: 'charge' })} disabled={!yearId}>
                <Icon name="plus" className="h-4 w-4" />
                Add charge
              </Button>
            )}
            {canVerify && (
              <Button onClick={() => setDialog({ kind: 'payment' })} disabled={!yearId}>
                <Icon name="plus" className="h-4 w-4" />
                Record payment
              </Button>
            )}
          </>
        }
      />

      <div className="flex flex-wrap items-end gap-4">
        <Field label="Academic year" htmlFor="fees-year">
          <Select
            id="fees-year"
            value={yearId}
            onChange={(event) => setYearId(event.target.value)}
            className="min-w-48"
          >
            {years.data?.items.map((year) => (
              <option key={year.id} value={year.id}>
                {year.name}
                {year.status === 'active' ? ' (active)' : ''}
              </option>
            ))}
          </Select>
        </Field>
        <p className="pb-2 text-sm text-slate-500">
          All amounts are in the currency of the school's fee ledger.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {overview.isPending ? (
          <>
            <Card className="p-5"><TableSkeleton rows={2} columns={2} /></Card>
            <Card className="p-5"><TableSkeleton rows={2} columns={2} /></Card>
            <Card className="p-5"><TableSkeleton rows={2} columns={2} /></Card>
            <Card className="p-5"><TableSkeleton rows={2} columns={2} /></Card>
          </>
        ) : overview.isError ? (
          <div className="sm:col-span-2 xl:col-span-4">
            <ErrorState message={errorMessage(overview.error)} onRetry={() => void overview.refetch()} />
          </div>
        ) : overview.data ? (
          <>
            <StatCard label="Charged (gross)" value={formatMoney(overview.data.totalCharged)} hint={`${overview.data.chargeCount} charges`} icon="clipboard" />
            <StatCard label="Collected" value={formatMoney(overview.data.totalCollected)} hint={`${overview.data.paidCount} paid · ${overview.data.partialCount} partial`} icon="chart" />
            <StatCard label="Outstanding" value={formatMoney(overview.data.totalOutstanding)} hint={`${overview.data.unpaidCount} unpaid`} icon="alert" />
            <StatCard label="Concessions / refunds" value={formatMoney(overview.data.totalConcession + overview.data.totalRefunded)} hint={`${formatMoney(overview.data.totalConcession)} concession · ${formatMoney(overview.data.totalRefunded)} refunded`} icon="shield" />
          </>
        ) : null}
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-slate-200" role="tablist" aria-label="Fee views">
        {(
          [
            ['charges', 'Charges'],
            ['payments', 'Payments'],
            ['refunds', 'Refunds'],
            ['structures', 'Fee heads & structures'],
            ['extras', 'Late fees & instalments'],
          ] as Array<[Tab, string]>
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={cn(
              'border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition',
              tab === value
                ? 'border-brand-600 text-brand-700'
                : 'border-transparent text-slate-500 hover:text-slate-800',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'charges' && (
        <Card>
          <CardHeader
            title="Student charges"
            description="Net is the charge minus concession. Paid is the sum of recorded payment allocations; refunds are handled against receipts."
            actions={
              <Select
                aria-label="Filter charges by status"
                value={chargeStatus}
                onChange={(event) => setChargeStatus(event.target.value)}
                className="w-40"
              >
                <option value="">All statuses</option>
                <option value="paid">Paid</option>
                <option value="partial">Partial</option>
                <option value="unpaid">Unpaid</option>
              </Select>
            }
          />
          {charges.isPending ? (
            <TableSkeleton rows={6} columns={7} />
          ) : charges.isError ? (
            <ErrorState message={errorMessage(charges.error)} onRetry={() => void charges.refetch()} />
          ) : charges.data.items.length === 0 ? (
            <EmptyState
              title="No charges for this year"
              description="Generate charges from the class fee structure or add one for a single student."
              icon="clipboard"
              action={
                canCharge ? (
                  <Button size="sm" onClick={() => setDialog({ kind: 'generate' })}>
                    Generate charges
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Student</th>
                    <th>Fee head</th>
                    <th className="text-right">Net</th>
                    <th className="text-right">Paid</th>
                    <th className="text-right">Balance</th>
                    <th>Due</th>
                    <th>Status</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {charges.data.items.map((charge) => (
                    <tr key={charge.id}>
                      <td>
                        <p className="font-medium text-slate-900">{charge.studentName}</p>
                        <p className="font-mono text-xs text-slate-500">{charge.admissionNumber}</p>
                      </td>
                      <td>
                        <p>{charge.feeHeadName}</p>
                        <p className="text-xs text-slate-500">{charge.description}</p>
                      </td>
                      <td className="text-right tabular-nums">
                        {formatMoney(charge.netAmount)}
                        {charge.concessionAmount > 0 && (
                          <p className="text-xs text-emerald-600">−{formatMoney(charge.concessionAmount)}</p>
                        )}
                      </td>
                      <td className="text-right tabular-nums">{formatMoney(charge.paidAmount)}</td>
                      <td className="text-right tabular-nums font-medium">{formatMoney(charge.balance)}</td>
                      <td>{formatDate(charge.dueOn)}</td>
                      <td>
                        <Badge
                          tone={
                            charge.status === 'paid' ? 'success' : charge.status === 'partial' ? 'warning' : 'danger'
                          }
                        >
                          {charge.status}
                        </Badge>
                      </td>
                      <td>
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setDialog({ kind: 'ledger', studentId: charge.studentId })}
                          >
                            Ledger
                          </Button>
                          {canCharge && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setDialog({ kind: 'charge', charge })}
                            >
                              Edit
                            </Button>
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
      )}

      {tab === 'payments' && (
        <Card>
          <CardHeader
            title="Receipts"
            description="Payments are allocated oldest charge first unless the API receives explicit allocations."
          />
          {payments.isPending ? (
            <TableSkeleton rows={6} columns={7} />
          ) : payments.isError ? (
            <ErrorState message={errorMessage(payments.error)} onRetry={() => void payments.refetch()} />
          ) : payments.data.items.length === 0 ? (
            <EmptyState title="No payments recorded" description="Record a receipt against a student's charges." icon="clipboard" />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Receipt</th>
                    <th>Student</th>
                    <th className="text-right">Amount</th>
                    <th className="text-right">Refunded</th>
                    <th>Method</th>
                    <th>Paid on</th>
                    <th>Status</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.data.items.map((payment) => (
                    <tr key={payment.id}>
                      <td className="font-mono text-xs">{payment.receiptNumber}</td>
                      <td>
                        <p className="font-medium text-slate-900">{payment.studentName}</p>
                        <p className="font-mono text-xs text-slate-500">{payment.admissionNumber}</p>
                      </td>
                      <td className="text-right tabular-nums">{formatMoney(payment.amount)}</td>
                      <td className="text-right tabular-nums">{formatMoney(payment.refundedAmount)}</td>
                      <td className="capitalize">{payment.method.replace(/_/g, ' ')}</td>
                      <td>{formatDate(payment.paidOn)}</td>
                      <td>
                        <Badge tone={payment.status === 'recorded' ? 'success' : 'danger'}>{payment.status}</Badge>
                      </td>
                      <td>
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              window.open(
                                paymentReceiptUrl(schoolId, payment.id),
                                '_blank',
                                'noopener',
                              )
                            }
                          >
                            Receipt
                          </Button>
                          {canVerify && payment.status === 'recorded' && payment.refundedAmount < payment.amount && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setDialog({ kind: 'refund', payment })}
                            >
                              Refund
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setDialog({ kind: 'ledger', studentId: payment.studentId })}
                          >
                            Ledger
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'refunds' && (
        <Card>
          <CardHeader
            title="Refunds"
            description="A refund is requested against a receipt and needs approval by someone with the refund permission."
            actions={
              <Select
                aria-label="Filter refunds by status"
                value={refundStatus}
                onChange={(event) => setRefundStatus(event.target.value)}
                className="w-40"
              >
                <option value="">All statuses</option>
                <option value="pending">Pending</option>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
              </Select>
            }
          />
          {refunds.isPending ? (
            <TableSkeleton rows={4} columns={7} />
          ) : refunds.isError ? (
            <ErrorState message={errorMessage(refunds.error)} onRetry={() => void refunds.refetch()} />
          ) : refunds.data.items.length === 0 ? (
            <EmptyState title="No refunds" description="Refunds requested against a receipt appear here." icon="shield" />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Receipt</th>
                    <th>Student</th>
                    <th className="text-right">Amount</th>
                    <th>Reason</th>
                    <th>Requested</th>
                    <th>Status</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {refunds.data.items.map((refund) => (
                    <tr key={refund.id}>
                      <td className="font-mono text-xs">{refund.receiptNumber}</td>
                      <td className="font-medium text-slate-900">{refund.studentName}</td>
                      <td className="text-right tabular-nums">{formatMoney(refund.amount)}</td>
                      <td className="max-w-64 text-sm text-slate-600">{refund.reason}</td>
                      <td>
                        <p className="text-sm">{refund.requestedByName ?? '—'}</p>
                        <p className="text-xs text-slate-500">{formatDateTime(refund.requestedAt, timeZone)}</p>
                      </td>
                      <td>
                        <Badge
                          tone={
                            refund.status === 'approved' ? 'success' : refund.status === 'rejected' ? 'danger' : 'warning'
                          }
                        >
                          {refund.status}
                        </Badge>
                        {refund.reviewNote && <p className="mt-1 text-xs text-slate-500">{refund.reviewNote}</p>}
                      </td>
                      <td>
                        {canRefund && refund.status === 'pending' ? (
                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => setReviewing({ refund, decision: 'reject' })}
                            >
                              Reject
                            </Button>
                            <Button
                              size="sm"
                              onClick={() => setReviewing({ refund, decision: 'approve' })}
                            >
                              Approve
                            </Button>
                          </div>
                        ) : (
                          <p className="text-right text-xs text-slate-400">
                            {refund.reviewedByName ? `by ${refund.reviewedByName}` : '—'}
                          </p>
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

      {tab === 'structures' && (
        <div className="space-y-6">
          <Card>
            <CardHeader
              title="Fee heads"
              description="Categories that can be charged, such as tuition, transport or examination fees."
              actions={
                canCharge ? (
                  <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: 'head' })}>
                    <Icon name="plus" className="h-4 w-4" />
                    New fee head
                  </Button>
                ) : undefined
              }
            />
            {heads.isPending ? (
              <TableSkeleton rows={3} columns={4} />
            ) : heads.isError ? (
              <ErrorState message={errorMessage(heads.error)} onRetry={() => void heads.refetch()} />
            ) : (
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Code</th>
                      <th>Name</th>
                      <th>Description</th>
                      <th>Status</th>
                      {canCharge && <th className="text-right">Actions</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {heads.data.items.map((head) => (
                      <tr key={head.id}>
                        <td className="font-mono text-xs">{head.code}</td>
                        <td className="font-medium text-slate-900">{head.name}</td>
                        <td className="text-sm text-slate-500">{head.description ?? '—'}</td>
                        <td>
                          <Badge tone={head.status === 'active' ? 'success' : 'neutral'}>{head.status}</Badge>
                        </td>
                        {canCharge && (
                          <td>
                            <div className="flex justify-end">
                              <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'head', head })}>
                                Edit
                              </Button>
                            </div>
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
              title="Class fee structures"
              description="The amount a class is charged per fee head. Generating charges copies these amounts into student charges."
              actions={
                canCharge ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setDialog({ kind: 'structure' })}
                    disabled={activeHeads.length === 0}
                  >
                    <Icon name="plus" className="h-4 w-4" />
                    New structure
                  </Button>
                ) : undefined
              }
            />
            {structures.isPending ? (
              <TableSkeleton rows={4} columns={5} />
            ) : structures.isError ? (
              <ErrorState message={errorMessage(structures.error)} onRetry={() => void structures.refetch()} />
            ) : structures.data.items.length === 0 ? (
              <EmptyState
                title="No fee structures for this year"
                description="Add a fee head amount per class before generating student charges."
                icon="layers"
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Class</th>
                      <th>Fee head</th>
                      <th className="text-right">Amount</th>
                      <th>Due</th>
                      {canCharge && <th className="text-right">Actions</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {structures.data.items.map((structure) => (
                      <tr key={structure.id}>
                        <td className="font-medium text-slate-900">{structure.className}</td>
                        <td>{structure.feeHeadName}</td>
                        <td className="text-right tabular-nums">{formatMoney(structure.amount)}</td>
                        <td>{formatDate(structure.dueOn)}</td>
                        {canCharge && (
                          <td>
                            <div className="flex justify-end">
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setDialog({ kind: 'structure', structure })}
                              >
                                Edit
                              </Button>
                            </div>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}

      {tab === 'extras' && (
        <FeeExtrasPanel
          schoolId={schoolId}
          yearId={yearId}
          canManage={canCharge}
          studentOptions={studentOptions}
        />
      )}

      {dialog?.kind === 'generate' && yearId && (
        <GenerateDialog
          academicYearId={yearId}
          sections={sections.data?.items ?? []}
          heads={activeHeads}
          onClose={() => setDialog(null)}
          onSaved={(created, skipped) => {
            toast.notify(
              created > 0 ? 'success' : 'info',
              created > 0
                ? `${created} charges generated${skipped ? `, ${skipped} already existed` : ''}.`
                : 'All matching charges already exist.',
            );
            setDialog(null);
            invalidate();
          }}
        />
      )}

      {dialog?.kind === 'charge' && yearId && (
        <ChargeDialog
          academicYearId={yearId}
          charge={dialog.charge}
          students={studentOptions}
          heads={activeHeads}
          defaultDueOn={todayIso(timeZone)}
          onClose={() => setDialog(null)}
          onSaved={() => {
            toast.notify('success', dialog.charge ? 'Charge updated.' : 'Charge created.');
            setDialog(null);
            invalidate();
          }}
        />
      )}

      {dialog?.kind === 'payment' && yearId && (
        <PaymentDialog
          academicYearId={yearId}
          students={studentOptions}
          onClose={() => setDialog(null)}
          onSaved={(payment) => {
            toast.notify('success', `Receipt ${payment.receiptNumber} recorded.`);
            setDialog(null);
            invalidate();
          }}
        />
      )}

      {dialog?.kind === 'refund' && (
        <RefundDialog
          payment={dialog.payment}
          onClose={() => setDialog(null)}
          onSaved={() => {
            toast.notify('success', 'Refund requested and awaiting approval.');
            setDialog(null);
            invalidate();
          }}
        />
      )}

      {dialog?.kind === 'ledger' && (
        <LedgerDialog studentId={dialog.studentId} onClose={() => setDialog(null)} />
      )}

      {dialog?.kind === 'head' && (
        <FeeHeadDialog
          head={dialog.head}
          onClose={() => setDialog(null)}
          onSaved={() => {
            toast.notify('success', dialog.head ? 'Fee head updated.' : 'Fee head created.');
            setDialog(null);
            invalidate();
          }}
        />
      )}

      {dialog?.kind === 'structure' && yearId && (
        <StructureDialog
          academicYearId={yearId}
          structure={dialog.structure}
          classes={classes.data?.items.filter((klass) => klass.status === 'active') ?? []}
          heads={activeHeads}
          onClose={() => setDialog(null)}
          onSaved={() => {
            toast.notify('success', dialog.structure ? 'Fee structure updated.' : 'Fee structure created.');
            setDialog(null);
            invalidate();
          }}
        />
      )}

      <ConfirmDialog
        open={reviewing !== null}
        title={reviewing?.decision === 'approve' ? 'Approve refund' : 'Reject refund'}
        message={
          reviewing ? (
            <p>
              {reviewing.decision === 'approve' ? 'Approve' : 'Reject'} {formatMoney(reviewing.refund.amount)} for{' '}
              <strong>{reviewing.refund.studentName}</strong> on receipt{' '}
              <span className="font-mono text-xs">{reviewing.refund.receiptNumber}</span>?
            </p>
          ) : null
        }
        confirmLabel={reviewing?.decision === 'approve' ? 'Approve refund' : 'Reject refund'}
        destructive={reviewing?.decision === 'reject'}
        busy={review.isPending}
        onConfirm={() => reviewing && review.mutate(reviewing)}
        onClose={() => setReviewing(null)}
      />
    </div>
  );
}

/* --------------------------------- dialogs -------------------------------- */

function GenerateDialog({
  academicYearId,
  sections,
  heads,
  onClose,
  onSaved,
}: {
  academicYearId: string;
  sections: Array<{ id: string; className: string; name: string }>;
  heads: FeeHead[];
  onClose: () => void;
  onSaved: (created: number, skipped: number) => void;
}): ReactNode {
  const schoolId = useSchoolId();
  const timeZone = useSchoolTimezone();
  const [sectionId, setSectionId] = useState(sections[0]?.id ?? '');
  const [dueOn, setDueOn] = useState(todayIso(timeZone));
  const [selectedHeads, setSelectedHeads] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      generateCharges(schoolId, {
        academicYearId,
        sectionId,
        dueOn,
        feeHeadIds: selectedHeads.length > 0 ? selectedHeads : undefined,
      }),
    onSuccess: (result) => onSaved(result.created, result.skipped),
    onError: (caught) => setError(errorMessage(caught)),
  });

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setError(null);
    mutation.mutate();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Generate class charges"
      description="Creates one charge per enrolled student and fee head. Existing charges for the same student, year and head are skipped."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button form="generate-form" type="submit" loading={mutation.isPending} disabled={!sectionId}>
            Generate
          </Button>
        </>
      }
    >
      <form id="generate-form" className="space-y-4" onSubmit={submit} noValidate>
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Section" htmlFor="generate-section" required>
          <Select
            id="generate-section"
            value={sectionId}
            onChange={(event) => setSectionId(event.target.value)}
            required
          >
            {sections.length === 0 && <option value="">No sections in this year</option>}
            {sections.map((section) => (
              <option key={section.id} value={section.id}>
                {section.className} · {section.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Due on" htmlFor="generate-due" required>
          <Input
            id="generate-due"
            type="date"
            value={dueOn}
            onChange={(event) => setDueOn(event.target.value)}
            required
          />
        </Field>
        <fieldset>
          <legend className="field-label">Fee heads</legend>
          <p className="field-hint">Leave every box clear to generate all active fee heads.</p>
          <div className="mt-2 space-y-2">
            {heads.map((head) => (
              <label key={head.id} className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded text-brand-600"
                  checked={selectedHeads.includes(head.id)}
                  onChange={(event) =>
                    setSelectedHeads((current) =>
                      event.target.checked
                        ? [...current, head.id]
                        : current.filter((id) => id !== head.id),
                    )
                  }
                />
                {head.name}
              </label>
            ))}
          </div>
        </fieldset>
      </form>
    </Dialog>
  );
}

function ChargeDialog({
  academicYearId,
  charge,
  students,
  heads,
  defaultDueOn,
  onClose,
  onSaved,
}: {
  academicYearId: string;
  charge?: StudentCharge;
  students: Array<{ id: string; firstName: string; lastName: string | null; admissionNumber: string }>;
  heads: FeeHead[];
  defaultDueOn: string;
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  const schoolId = useSchoolId();
  const [studentId, setStudentId] = useState(charge?.studentId ?? students[0]?.id ?? '');
  const [feeHeadId, setFeeHeadId] = useState(charge?.feeHeadId ?? heads[0]?.id ?? '');
  const [description, setDescription] = useState(charge?.description ?? '');
  const [amount, setAmount] = useState(charge?.amount.toString() ?? '');
  const [concessionAmount, setConcessionAmount] = useState(charge?.concessionAmount.toString() ?? '0');
  const [dueOn, setDueOn] = useState(charge?.dueOn ?? defaultDueOn);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});

  const mutation = useMutation({
    mutationFn: () =>
      charge
        ? updateCharge(schoolId, charge.id, {
            description,
            concessionAmount: Number(concessionAmount || 0),
            dueOn,
          })
        : createCharge(schoolId, {
            studentId,
            academicYearId,
            feeHeadId,
            description,
            amount: Number(amount || 0),
            concessionAmount: Number(concessionAmount || 0),
            dueOn,
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
      title={charge ? 'Edit charge' : 'Add a charge'}
      description={
        charge
          ? 'Only the description, concession and due date can change. The original amount is retained.'
          : 'Creates a single charge for one student.'
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button form="charge-form" type="submit" loading={mutation.isPending}>
            {charge ? 'Save changes' : 'Create charge'}
          </Button>
        </>
      }
    >
      <form id="charge-form" className="space-y-4" onSubmit={submit} noValidate>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Student" htmlFor="charge-student" required error={errors.studentId?.[0]}>
            <Select
              id="charge-student"
              value={studentId}
              onChange={(event) => setStudentId(event.target.value)}
              disabled={Boolean(charge)}
              required
            >
              {students.map((student) => (
                <option key={student.id} value={student.id}>
                  {student.firstName} {student.lastName ?? ''} ({student.admissionNumber})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Fee head" htmlFor="charge-head" required error={errors.feeHeadId?.[0]}>
            <Select
              id="charge-head"
              value={feeHeadId}
              onChange={(event) => setFeeHeadId(event.target.value)}
              disabled={Boolean(charge)}
              required
            >
              {heads.map((head) => (
                <option key={head.id} value={head.id}>
                  {head.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Amount" htmlFor="charge-amount" required error={errors.amount?.[0]}>
            <Input
              id="charge-amount"
              type="number"
              min={0}
              step="0.01"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              disabled={Boolean(charge)}
              required
            />
          </Field>
          <Field label="Concession" htmlFor="charge-concession" error={errors.concessionAmount?.[0]}>
            <Input
              id="charge-concession"
              type="number"
              min={0}
              step="0.01"
              value={concessionAmount}
              onChange={(event) => setConcessionAmount(event.target.value)}
            />
          </Field>
          <Field label="Due on" htmlFor="charge-due" required error={errors.dueOn?.[0]}>
            <Input
              id="charge-due"
              type="date"
              value={dueOn}
              onChange={(event) => setDueOn(event.target.value)}
              required
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Description" htmlFor="charge-description" required error={errors.description?.[0]}>
              <Input
                id="charge-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Term 1 tuition"
                required
              />
            </Field>
          </div>
        </div>
      </form>
    </Dialog>
  );
}

function PaymentDialog({
  academicYearId,
  students,
  onClose,
  onSaved,
}: {
  academicYearId: string;
  students: Array<{ id: string; firstName: string; lastName: string | null; admissionNumber: string }>;
  onClose: () => void;
  onSaved: (payment: PaymentRecord) => void;
}): ReactNode {
  const schoolId = useSchoolId();
  const timeZone = useSchoolTimezone();
  const [studentId, setStudentId] = useState(students[0]?.id ?? '');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<string>('cash');
  const [reference, setReference] = useState('');
  const [paidOn, setPaidOn] = useState(todayIso(timeZone));
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});

  const mutation = useMutation({
    mutationFn: () =>
      recordPayment(schoolId, {
        studentId,
        academicYearId,
        amount: Number(amount || 0),
        method,
        reference: reference.trim() || undefined,
        paidOn,
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
      title="Record a payment"
      description="Allocates automatically to the oldest unpaid charges. Any excess remains an unallocated credit on the student's ledger."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button form="payment-form" type="submit" loading={mutation.isPending} disabled={!studentId}>
            Record receipt
          </Button>
        </>
      }
    >
      <form id="payment-form" className="space-y-4" onSubmit={submit} noValidate>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Student" htmlFor="payment-student" required error={errors.studentId?.[0]}>
            <Select
              id="payment-student"
              value={studentId}
              onChange={(event) => setStudentId(event.target.value)}
              required
            >
              <option value="">Choose a student</option>
              {students.map((student) => (
                <option key={student.id} value={student.id}>
                  {student.firstName} {student.lastName ?? ''} ({student.admissionNumber})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Amount" htmlFor="payment-amount" required error={errors.amount?.[0]}>
            <Input
              id="payment-amount"
              type="number"
              min={0.01}
              step="0.01"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              required
            />
          </Field>
          <Field label="Method" htmlFor="payment-method" required error={errors.method?.[0]}>
            <Select id="payment-method" value={method} onChange={(event) => setMethod(event.target.value)}>
              {PAYMENT_METHODS.map((entry) => (
                <option key={entry} value={entry}>
                  {entry.replace(/_/g, ' ')}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Paid on" htmlFor="payment-date" required error={errors.paidOn?.[0]}>
            <Input
              id="payment-date"
              type="date"
              value={paidOn}
              onChange={(event) => setPaidOn(event.target.value)}
              required
            />
          </Field>
          <Field label="Reference" htmlFor="payment-reference" error={errors.reference?.[0]}>
            <Input
              id="payment-reference"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              placeholder="UPI / cheque number"
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Notes" htmlFor="payment-notes" error={errors.notes?.[0]}>
              <Textarea
                id="payment-notes"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="Optional internal note"
              />
            </Field>
          </div>
        </div>
      </form>
    </Dialog>
  );
}

function RefundDialog({
  payment,
  onClose,
  onSaved,
}: {
  payment: PaymentRecord;
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  const schoolId = useSchoolId();
  const refundable = Math.round((payment.amount - payment.refundedAmount) * 100) / 100;
  const [amount, setAmount] = useState(refundable.toFixed(2));
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});

  const mutation = useMutation({
    mutationFn: () =>
      requestRefund(schoolId, { paymentId: payment.id, amount: Number(amount || 0), reason }),
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
      title="Request a refund"
      description={`Receipt ${payment.receiptNumber} · refundable ${formatMoney(refundable)}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button form="refund-form" type="submit" loading={mutation.isPending}>
            Request refund
          </Button>
        </>
      }
    >
      <form id="refund-form" className="space-y-4" onSubmit={submit} noValidate>
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Amount" htmlFor="refund-amount" required error={errors.amount?.[0]}>
          <Input
            id="refund-amount"
            type="number"
            min={0.01}
            max={refundable}
            step="0.01"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            required
          />
        </Field>
        <Field label="Reason" htmlFor="refund-reason" required error={errors.reason?.[0]}>
          <Textarea
            id="refund-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why is this amount being refunded?"
            required
          />
        </Field>
      </form>
    </Dialog>
  );
}

function LedgerDialog({ studentId, onClose }: { studentId: string; onClose: () => void }): ReactNode {
  const schoolId = useSchoolId();
  const timeZone = useSchoolTimezone();
  const ledger = useQuery({
    queryKey: ['fee-ledger', schoolId, studentId],
    queryFn: () => getFeeLedger(schoolId, studentId),
  });

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={ledger.data ? `${ledger.data.studentName} · fee ledger` : 'Fee ledger'}
      description={
        ledger.data
          ? `${ledger.data.admissionNumber} · ${[ledger.data.className, ledger.data.sectionName].filter(Boolean).join(' · ') || 'Not enrolled'}`
          : undefined
      }
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="secondary"
            onClick={() =>
              window.open(studentInvoiceUrl(schoolId, studentId), '_blank', 'noopener')
            }
          >
            Open invoice
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      }
    >
      {ledger.isPending ? (
        <TableSkeleton rows={5} columns={4} />
      ) : ledger.isError ? (
        <ErrorState message={errorMessage(ledger.error)} onRetry={() => void ledger.refetch()} />
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <LedgerStat label="Charged" value={formatMoney(ledger.data.totalCharged)} />
            <LedgerStat label="Concession" value={formatMoney(ledger.data.totalConcession)} />
            <LedgerStat label="Paid" value={formatMoney(ledger.data.totalPaid)} />
            <LedgerStat label="Balance" value={formatMoney(ledger.data.balance)} />
          </div>

          <section>
            <h3 className="mb-2 text-sm font-semibold text-slate-900">Charges</h3>
            {ledger.data.charges.length === 0 ? (
              <p className="text-sm text-slate-500">No charges.</p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Fee head</th>
                    <th className="text-right">Net</th>
                    <th className="text-right">Paid</th>
                    <th className="text-right">Balance</th>
                    <th>Due</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.data.charges.map((charge) => (
                    <tr key={charge.id}>
                      <td>{charge.feeHeadName}</td>
                      <td className="text-right tabular-nums">{formatMoney(charge.netAmount)}</td>
                      <td className="text-right tabular-nums">{formatMoney(charge.paidAmount)}</td>
                      <td className="text-right tabular-nums">{formatMoney(charge.balance)}</td>
                      <td>{formatDate(charge.dueOn)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section>
            <h3 className="mb-2 text-sm font-semibold text-slate-900">Receipts</h3>
            {ledger.data.payments.length === 0 ? (
              <p className="text-sm text-slate-500">No payments.</p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Receipt</th>
                    <th className="text-right">Amount</th>
                    <th className="text-right">Refunded</th>
                    <th>Method</th>
                    <th>Paid on</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {ledger.data.payments.map((payment) => (
                    <tr key={payment.id}>
                      <td className="font-mono text-xs">{payment.receiptNumber}</td>
                      <td className="text-right tabular-nums">{formatMoney(payment.amount)}</td>
                      <td className="text-right tabular-nums">{formatMoney(payment.refundedAmount)}</td>
                      <td className="capitalize">{payment.method.replace(/_/g, ' ')}</td>
                      <td>{formatDate(payment.paidOn)}</td>
                      <td className="text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            window.open(
                              paymentReceiptUrl(schoolId, payment.id),
                              '_blank',
                              'noopener',
                            )
                          }
                        >
                          Receipt
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          <p className="text-xs text-slate-400">
            Ledger generated {formatDateTime(new Date().toISOString(), timeZone)}.
          </p>
        </div>
      )}
    </Dialog>
  );
}

function LedgerStat({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2">
      <p className="text-[11px] font-medium tracking-wide text-slate-500 uppercase">{label}</p>
      <p className="mt-1 text-sm font-semibold tabular-nums text-slate-900">{value}</p>
    </div>
  );
}

function FeeHeadDialog({
  head,
  onClose,
  onSaved,
}: {
  head?: FeeHead;
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  const schoolId = useSchoolId();
  const [code, setCode] = useState(head?.code ?? '');
  const [name, setName] = useState(head?.name ?? '');
  const [description, setDescription] = useState(head?.description ?? '');
  const [status, setStatus] = useState<FeeHead['status']>(head?.status ?? 'active');
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});

  const mutation = useMutation({
    mutationFn: () =>
      head
        ? updateFeeHead(schoolId, head.id, {
            name,
            description: description.trim() || undefined,
            status,
          })
        : createFeeHead(schoolId, {
            code,
            name,
            description: description.trim() || null,
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
      title={head ? `Edit ${head.name}` : 'New fee head'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button form="fee-head-form" type="submit" loading={mutation.isPending}>
            {head ? 'Save changes' : 'Create fee head'}
          </Button>
        </>
      }
    >
      <form id="fee-head-form" className="space-y-4" onSubmit={submit} noValidate>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Code" htmlFor="head-code" required error={errors.code?.[0]}>
            <Input
              id="head-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="TUITION"
              disabled={Boolean(head)}
              required
            />
          </Field>
          <Field label="Name" htmlFor="head-name" required error={errors.name?.[0]}>
            <Input
              id="head-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Tuition fee"
              required
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Description" htmlFor="head-description" error={errors.description?.[0]}>
              <Input
                id="head-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>
          </div>
          <Field label="Status" htmlFor="head-status">
            <Select
              id="head-status"
              value={status}
              onChange={(event) => setStatus(event.target.value as FeeHead['status'])}
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

function StructureDialog({
  academicYearId,
  structure,
  classes,
  heads,
  onClose,
  onSaved,
}: {
  academicYearId: string;
  structure?: FeeStructure;
  classes: Array<{ id: string; name: string }>;
  heads: FeeHead[];
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  const schoolId = useSchoolId();
  const [classId, setClassId] = useState(structure?.classId ?? classes[0]?.id ?? '');
  const [feeHeadId, setFeeHeadId] = useState(structure?.feeHeadId ?? heads[0]?.id ?? '');
  const [amount, setAmount] = useState(structure?.amount.toString() ?? '');
  const [dueOn, setDueOn] = useState(structure?.dueOn ?? '');
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});

  const mutation = useMutation({
    mutationFn: () =>
      structure
        ? updateFeeStructure(schoolId, structure.id, {
            amount: Number(amount || 0),
            dueOn: dueOn || null,
          })
        : createFeeStructure(schoolId, {
            academicYearId,
            classId,
            feeHeadId,
            amount: Number(amount || 0),
            dueOn: dueOn || undefined,
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
      title={structure ? 'Edit fee structure' : 'New fee structure'}
      description="A class can have one structure per fee head and academic year."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button form="structure-form" type="submit" loading={mutation.isPending}>
            {structure ? 'Save changes' : 'Create structure'}
          </Button>
        </>
      }
    >
      <form id="structure-form" className="space-y-4" onSubmit={submit} noValidate>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Class" htmlFor="structure-class" required error={errors.classId?.[0]}>
            <Select
              id="structure-class"
              value={classId}
              onChange={(event) => setClassId(event.target.value)}
              disabled={Boolean(structure)}
              required
            >
              {classes.map((klass) => (
                <option key={klass.id} value={klass.id}>
                  {klass.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Fee head" htmlFor="structure-head" required error={errors.feeHeadId?.[0]}>
            <Select
              id="structure-head"
              value={feeHeadId}
              onChange={(event) => setFeeHeadId(event.target.value)}
              disabled={Boolean(structure)}
              required
            >
              {heads.map((head) => (
                <option key={head.id} value={head.id}>
                  {head.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Amount" htmlFor="structure-amount" required error={errors.amount?.[0]}>
            <Input
              id="structure-amount"
              type="number"
              min={0}
              step="0.01"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              required
            />
          </Field>
          <Field label="Due on" htmlFor="structure-due" error={errors.dueOn?.[0]}>
            <Input
              id="structure-due"
              type="date"
              value={dueOn}
              onChange={(event) => setDueOn(event.target.value)}
            />
          </Field>
        </div>
      </form>
    </Dialog>
  );
}
