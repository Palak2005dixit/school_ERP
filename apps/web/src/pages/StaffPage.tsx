import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { LeaveRecord, SalaryRecord, StaffRecord } from '@erp/shared';
import { useAuth, useSchoolId, useSchoolTimezone } from '../auth/AuthContext';
import {
  cancelLeave,
  createStaff,
  listLeave,
  listLeaveTypes,
  listSalaries,
  listStaff,
  requestLeave,
  reviewLeave,
  setSalary,
  updateStaff,
} from '../lib/endpoints';
import { errorMessage, fieldErrors } from '../lib/api';
import { formatDate, formatDateTime, formatMoney, todayIso } from '../lib/format';
import { ConfirmDialog, Dialog } from '../components/Dialog';
import { LeaveConfigPanel } from '../components/hr/LeaveConfigPanel';
import { PayrollPanel } from '../components/hr/PayrollPanel';
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
  TableSkeleton,
  Textarea,
  cn,
} from '../components/ui';

const STAFF_STATUSES = ['active', 'on_leave', 'inactive', 'left'] as const;
const LEAVE_TYPES = ['casual', 'sick', 'earned', 'maternity', 'unpaid', 'other'] as const;
const LEAVE_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;

type Tab = 'staff' | 'salaries' | 'leave' | 'leave-setup' | 'payroll';
type DialogState =
  | { kind: 'staff'; staff?: StaffRecord }
  | { kind: 'salary'; staff: StaffRecord; salary?: SalaryRecord }
  | { kind: 'leave' }
  | null;
type ConfirmTarget = { kind: 'leave-review'; leave: LeaveRecord; decision: 'approve' | 'reject' } | { kind: 'cancel-leave'; leave: LeaveRecord } | null;

export function StaffPage(): ReactNode {
  const schoolId = useSchoolId();
  const timeZone = useSchoolTimezone();
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();

  const canViewStaff = can('hr.employee.view');
  const canManage = can('hr.employee.manage');
  const canViewSalary = can('hr.employee.salary.view_sensitive');
  const canRequestLeave = can('hr.leave.request');
  const canApproveLeave = can('hr.leave.approve');
  const canConfigureLeave = can('hr.leave.configure');
  const canRunPayroll = can('hr.employee.salary.view_sensitive');

  const [tab, setTab] = useState<Tab>(() => {
    if (canViewStaff) return 'staff';
    if (canRequestLeave || canApproveLeave) return 'leave';
    if (canConfigureLeave) return 'leave-setup';
    if (canRunPayroll) return 'payroll';
    return 'salaries';
  });
  const [staffStatus, setStaffStatus] = useState('');
  const [leaveStatus, setLeaveStatus] = useState('');
  const [dialog, setDialog] = useState<DialogState>(null);
  const [confirming, setConfirming] = useState<ConfirmTarget>(null);

  const staff = useQuery({
    queryKey: ['staff', schoolId, staffStatus],
    queryFn: () => listStaff(schoolId, staffStatus || undefined),
    enabled: canViewStaff,
  });
  const salaries = useQuery({
    queryKey: ['salaries', schoolId],
    queryFn: () => listSalaries(schoolId),
    enabled: canViewSalary && tab === 'salaries',
  });
  const leave = useQuery({
    queryKey: ['leave', schoolId, leaveStatus],
    queryFn: () => listLeave(schoolId, leaveStatus || undefined),
    enabled: canRequestLeave || canApproveLeave,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['staff', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['salaries', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['leave', schoolId] });
  };

  const review = useMutation({
    mutationFn: (target: Extract<NonNullable<ConfirmTarget>, { kind: 'leave-review' }>) =>
      reviewLeave(schoolId, target.leave.id, { decision: target.decision }),
    onSuccess: (saved) => {
      toast.notify('success', `Leave ${saved.status}.`);
      setConfirming(null);
      invalidate();
    },
    onError: (error) => {
      setConfirming(null);
      toast.notify('error', errorMessage(error));
    },
  });

  const cancel = useMutation({
    mutationFn: (leaveId: string) => cancelLeave(schoolId, leaveId),
    onSuccess: () => {
      toast.notify('success', 'Leave request cancelled.');
      setConfirming(null);
      invalidate();
    },
    onError: (error) => {
      setConfirming(null);
      toast.notify('error', errorMessage(error));
    },
  });

  const staffOptions = staff.data?.items ?? [];
  const salaryByStaff = new Map((salaries.data?.items ?? []).map((row) => [row.staffId, row]));

  const tabs: Array<[Tab, string]> = [
    ...(canViewStaff ? ([['staff', 'Staff directory']] as Array<[Tab, string]>) : []),
    ...(canViewSalary ? ([['salaries', 'Salaries']] as Array<[Tab, string]>) : []),
    ...(canRequestLeave || canApproveLeave ? ([['leave', 'Leave']] as Array<[Tab, string]>) : []),
    ...(canConfigureLeave ? ([['leave-setup', 'Leave setup']] as Array<[Tab, string]>) : []),
    ...(canRunPayroll ? ([['payroll', 'Payroll']] as Array<[Tab, string]>) : []),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Staff & HR"
        description="Employee records, salary (restricted) and the leave approval workflow. Leave is separate from staff status."
        actions={
          <div className="flex flex-wrap gap-2">
            {canRequestLeave && (
              <Button variant="secondary" onClick={() => setDialog({ kind: 'leave' })}>
                <Icon name="calendar" className="h-4 w-4" />
                Request leave
              </Button>
            )}
            {canManage && (
              <Button onClick={() => setDialog({ kind: 'staff' })}>
                <Icon name="plus" className="h-4 w-4" />
                New staff member
              </Button>
            )}
          </div>
        }
      />

      <div className="flex gap-1 border-b border-slate-200" role="tablist" aria-label="HR views">
        {tabs.map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={cn(
              'border-b-2 px-3 py-2 text-sm font-medium transition',
              tab === value
                ? 'border-brand-600 text-brand-700'
                : 'border-transparent text-slate-500 hover:text-slate-800',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'staff' && canViewStaff && (
        <Card>
          <CardHeader
            title="Staff directory"
            description="Employee numbers are generated automatically when left blank."
            actions={
              <Select
                aria-label="Filter staff by status"
                value={staffStatus}
                onChange={(event) => setStaffStatus(event.target.value)}
                className="w-40"
              >
                <option value="">All statuses</option>
                {STAFF_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {status.replace(/_/g, ' ')}
                  </option>
                ))}
              </Select>
            }
          />
          {staff.isPending ? (
            <TableSkeleton rows={6} columns={6} />
          ) : staff.isError ? (
            <ErrorState message={errorMessage(staff.error)} onRetry={() => void staff.refetch()} />
          ) : staff.data.items.length === 0 ? (
            <EmptyState
              title="No staff records"
              description="Add employees to manage departments, salaries and leave."
              icon="users"
              action={
                canManage ? (
                  <Button size="sm" onClick={() => setDialog({ kind: 'staff' })}>
                    New staff member
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Designation</th>
                    <th>Department</th>
                    <th>Contact</th>
                    <th>Joined</th>
                    <th>Status</th>
                    <th>Leave</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {staff.data.items.map((member) => (
                    <tr key={member.id}>
                      <td>
                        <p className="font-medium text-slate-900">{member.fullName}</p>
                        <p className="font-mono text-xs text-slate-500">{member.employeeNumber}</p>
                      </td>
                      <td>{member.designation}</td>
                      <td className="text-sm text-slate-600">{member.department ?? '—'}</td>
                      <td className="text-sm text-slate-600">
                        {member.email ?? '—'}
                        {member.phone && <p className="text-xs text-slate-500">{member.phone}</p>}
                      </td>
                      <td>{formatDate(member.joinedOn)}</td>
                      <td>
                        <Badge tone={member.status === 'active' ? 'success' : member.status === 'on_leave' ? 'warning' : 'neutral'}>
                          {member.status.replace(/_/g, ' ')}
                        </Badge>
                      </td>
                      <td>
                        {member.pendingLeave > 0 ? (
                          <Badge tone="warning">{member.pendingLeave} pending</Badge>
                        ) : (
                          <span className="text-xs text-slate-400">None</span>
                        )}
                      </td>
                      <td>
                        <div className="flex flex-wrap justify-end gap-2">
                          {canViewSalary && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                setDialog({
                                  kind: 'salary',
                                  staff: member,
                                  salary: salaryByStaff.get(member.id),
                                })
                              }
                            >
                              {member.hasSalary ? 'Salary' : 'Set salary'}
                            </Button>
                          )}
                          {canManage && (
                            <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'staff', staff: member })}>
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

      {tab === 'salaries' && canViewSalary && (
        <Card>
          <CardHeader
            title="Salary register"
            description="Salary is sensitive: only roles holding the salary permission can read these amounts. Amounts never enter the audit trail."
          />
          {salaries.isPending ? (
            <TableSkeleton rows={5} columns={5} />
          ) : salaries.isError ? (
            <ErrorState message={errorMessage(salaries.error)} onRetry={() => void salaries.refetch()} />
          ) : salaries.data.items.length === 0 ? (
            <EmptyState
              title="No salary records"
              description="Set a salary from the staff directory."
              icon="shield"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Staff</th>
                    <th className="text-right">Amount</th>
                    <th>Effective from</th>
                    <th>Notes</th>
                    <th>Updated</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {salaries.data.items.map((salary) => {
                    const member = staffOptions.find((entry) => entry.id === salary.staffId);
                    return (
                      <tr key={salary.staffId}>
                        <td className="font-medium text-slate-900">{salary.staffName}</td>
                        <td className="text-right tabular-nums">
                          {formatMoney(salary.amount, salary.currency)}
                        </td>
                        <td>{formatDate(salary.effectiveFrom)}</td>
                        <td className="max-w-64 text-sm text-slate-600">{salary.notes ?? '—'}</td>
                        <td className="text-xs text-slate-500">
                          {salary.updatedByName ?? '—'}
                          <p>{formatDateTime(salary.updatedAt, timeZone)}</p>
                        </td>
                        <td>
                          <div className="flex justify-end">
                            {member && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setDialog({ kind: 'salary', staff: member, salary })}
                              >
                                Update
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
      )}

      {tab === 'leave' && (
        <Card>
          <CardHeader
            title="Leave requests"
            description={
              canApproveLeave
                ? 'Approvers see every request. Nobody may approve their own leave.'
                : 'You see your own leave requests only.'
            }
            actions={
              <Select
                aria-label="Filter leave by status"
                value={leaveStatus}
                onChange={(event) => setLeaveStatus(event.target.value)}
                className="w-40"
              >
                <option value="">All statuses</option>
                {LEAVE_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </Select>
            }
          />
          {leave.isPending ? (
            <TableSkeleton rows={5} columns={7} />
          ) : leave.isError ? (
            <ErrorState message={errorMessage(leave.error)} onRetry={() => void leave.refetch()} />
          ) : leave.data.items.length === 0 ? (
            <EmptyState
              title="No leave requests"
              description="Requests appear here after they are submitted."
              icon="calendar"
              action={
                canRequestLeave ? (
                  <Button size="sm" onClick={() => setDialog({ kind: 'leave' })}>
                    Request leave
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Staff</th>
                    <th>Type</th>
                    <th>Period</th>
                    <th className="text-right">Days</th>
                    <th>Reason</th>
                    <th>Requested</th>
                    <th>Status</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {leave.data.items.map((entry) => (
                    <tr key={entry.id}>
                      <td className="font-medium text-slate-900">{entry.staffName}</td>
                      <td className="capitalize">{entry.leaveType}</td>
                      <td className="text-sm">
                        {formatDate(entry.startsOn)} – {formatDate(entry.endsOn)}
                      </td>
                      <td className="text-right tabular-nums">{entry.days}</td>
                      <td className="max-w-56 text-sm text-slate-600">{entry.reason}</td>
                      <td className="text-xs text-slate-500">
                        {entry.requestedByName ?? '—'}
                        <p>{formatDateTime(entry.requestedAt, timeZone)}</p>
                      </td>
                      <td>
                        <Badge
                          tone={
                            entry.status === 'approved'
                              ? 'success'
                              : entry.status === 'rejected'
                                ? 'danger'
                                : entry.status === 'pending'
                                  ? 'warning'
                                  : 'neutral'
                          }
                        >
                          {entry.status}
                        </Badge>
                        {entry.reviewNote && (
                          <p className="mt-1 max-w-48 text-xs text-slate-500">{entry.reviewNote}</p>
                        )}
                      </td>
                      <td>
                        <div className="flex flex-wrap justify-end gap-2">
                          {canApproveLeave && entry.status === 'pending' && (
                            <>
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() =>
                                  setConfirming({ kind: 'leave-review', leave: entry, decision: 'reject' })
                                }
                              >
                                Reject
                              </Button>
                              <Button
                                size="sm"
                                onClick={() =>
                                  setConfirming({ kind: 'leave-review', leave: entry, decision: 'approve' })
                                }
                              >
                                Approve
                              </Button>
                            </>
                          )}
                          {entry.status === 'pending' && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setConfirming({ kind: 'cancel-leave', leave: entry })}
                            >
                              Cancel
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

      {tab === 'leave-setup' && canConfigureLeave && (
        <LeaveConfigPanel schoolId={schoolId} canConfigure={canConfigureLeave} />
      )}

      {tab === 'payroll' && canRunPayroll && <PayrollPanel schoolId={schoolId} />}

      {dialog?.kind === 'staff' && (
        <StaffDialog
          staff={dialog.staff}
          onClose={() => setDialog(null)}
          onSaved={() => {
            toast.notify('success', dialog.staff ? 'Staff record updated.' : 'Staff member added.');
            setDialog(null);
            invalidate();
          }}
        />
      )}

      {dialog?.kind === 'salary' && (
        <SalaryDialog
          staff={dialog.staff}
          salary={dialog.salary}
          onClose={() => setDialog(null)}
          onSaved={() => {
            toast.notify('success', 'Salary saved.');
            setDialog(null);
            invalidate();
          }}
        />
      )}

      {dialog?.kind === 'leave' && (
        <LeaveDialog
          staff={staffOptions}
          canApprove={canApproveLeave}
          onClose={() => setDialog(null)}
          onSaved={() => {
            toast.notify('success', 'Leave request submitted.');
            setDialog(null);
            invalidate();
          }}
        />
      )}

      <ConfirmDialog
        open={confirming !== null}
        title={
          confirming?.kind === 'leave-review'
            ? confirming.decision === 'approve'
              ? 'Approve leave'
              : 'Reject leave'
            : 'Cancel leave request'
        }
        message={
          confirming?.kind === 'leave-review' ? (
            <p>
              {confirming.decision === 'approve' ? 'Approve' : 'Reject'} {confirming.leave.days} day
              {confirming.leave.days === 1 ? '' : 's'} of {confirming.leave.leaveType} leave for{' '}
              <strong>{confirming.leave.staffName}</strong>?
            </p>
          ) : confirming?.kind === 'cancel-leave' ? (
            <p>
              Cancel the pending leave request for <strong>{confirming.leave.staffName}</strong>?
            </p>
          ) : null
        }
        confirmLabel={
          confirming?.kind === 'leave-review'
            ? confirming.decision === 'approve'
              ? 'Approve'
              : 'Reject'
            : 'Cancel request'
        }
        destructive={confirming?.kind === 'cancel-leave' || (confirming?.kind === 'leave-review' && confirming.decision === 'reject')}
        busy={review.isPending || cancel.isPending}
        onConfirm={() => {
          if (!confirming) return;
          if (confirming.kind === 'leave-review') review.mutate(confirming);
          else cancel.mutate(confirming.leave.id);
        }}
        onClose={() => setConfirming(null)}
      />
    </div>
  );
}

function StaffDialog({
  staff,
  onClose,
  onSaved,
}: {
  staff?: StaffRecord;
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  const schoolId = useSchoolId();
  const [firstName, setFirstName] = useState(staff?.firstName ?? '');
  const [lastName, setLastName] = useState(staff?.lastName ?? '');
  const [employeeNumber, setEmployeeNumber] = useState(staff?.employeeNumber ?? '');
  const [email, setEmail] = useState(staff?.email ?? '');
  const [phone, setPhone] = useState(staff?.phone ?? '');
  const [designation, setDesignation] = useState(staff?.designation ?? '');
  const [department, setDepartment] = useState(staff?.department ?? '');
  const [joinedOn, setJoinedOn] = useState(staff?.joinedOn ?? '');
  const [status, setStatus] = useState<StaffRecord['status']>(staff?.status ?? 'active');
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});

  const mutation = useMutation({
    mutationFn: () => {
      const payload = {
        firstName,
        lastName: lastName.trim() || undefined,
        employeeNumber: employeeNumber.trim() || undefined,
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        designation,
        department: department.trim() || undefined,
        joinedOn: joinedOn || undefined,
        status,
      };
      return staff ? updateStaff(schoolId, staff.id, payload) : createStaff(schoolId, payload);
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
      size="lg"
      title={staff ? `Edit ${staff.fullName}` : 'New staff member'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button form="staff-form" type="submit" loading={mutation.isPending}>
            {staff ? 'Save changes' : 'Add staff member'}
          </Button>
        </>
      }
    >
      <form id="staff-form" className="space-y-4" onSubmit={submit} noValidate>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name" htmlFor="staff-first" required error={errors.firstName?.[0]}>
            <Input
              id="staff-first"
              value={firstName}
              onChange={(event) => setFirstName(event.target.value)}
              required
            />
          </Field>
          <Field label="Last name" htmlFor="staff-last" error={errors.lastName?.[0]}>
            <Input id="staff-last" value={lastName} onChange={(event) => setLastName(event.target.value)} />
          </Field>
          <Field label="Employee number" htmlFor="staff-number" error={errors.employeeNumber?.[0]}>
            <Input
              id="staff-number"
              value={employeeNumber}
              onChange={(event) => setEmployeeNumber(event.target.value)}
              placeholder="Generated if blank"
              disabled={Boolean(staff)}
            />
          </Field>
          <Field label="Designation" htmlFor="staff-designation" required error={errors.designation?.[0]}>
            <Input
              id="staff-designation"
              value={designation}
              onChange={(event) => setDesignation(event.target.value)}
              placeholder="Teacher"
              required
            />
          </Field>
          <Field label="Email" htmlFor="staff-email" error={errors.email?.[0]}>
            <Input
              id="staff-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
          <Field label="Phone" htmlFor="staff-phone" error={errors.phone?.[0]}>
            <Input id="staff-phone" value={phone} onChange={(event) => setPhone(event.target.value)} />
          </Field>
          <Field label="Department" htmlFor="staff-department" error={errors.department?.[0]}>
            <Input
              id="staff-department"
              value={department}
              onChange={(event) => setDepartment(event.target.value)}
            />
          </Field>
          <Field label="Joined on" htmlFor="staff-joined" error={errors.joinedOn?.[0]}>
            <Input
              id="staff-joined"
              type="date"
              value={joinedOn}
              onChange={(event) => setJoinedOn(event.target.value)}
            />
          </Field>
          <Field label="Status" htmlFor="staff-status">
            <Select
              id="staff-status"
              value={status}
              onChange={(event) => setStatus(event.target.value as StaffRecord['status'])}
            >
              {STAFF_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {value.replace(/_/g, ' ')}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </form>
    </Dialog>
  );
}

function SalaryDialog({
  staff,
  salary,
  onClose,
  onSaved,
}: {
  staff: StaffRecord;
  salary?: SalaryRecord;
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  const schoolId = useSchoolId();
  const timeZone = useSchoolTimezone();
  const [amount, setAmount] = useState(salary?.amount.toString() ?? '');
  const [currency, setCurrency] = useState(salary?.currency ?? 'INR');
  const [effectiveFrom, setEffectiveFrom] = useState(salary?.effectiveFrom ?? todayIso(timeZone));
  const [notes, setNotes] = useState(salary?.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});

  const mutation = useMutation({
    mutationFn: () =>
      setSalary(schoolId, staff.id, {
        amount: Number(amount || 0),
        currency: currency.toUpperCase(),
        effectiveFrom,
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
      title={`Salary · ${staff.fullName}`}
      description="Salary changes are audited without recording the amount."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button form="salary-form" type="submit" loading={mutation.isPending}>
            Save salary
          </Button>
        </>
      }
    >
      <form id="salary-form" className="space-y-4" onSubmit={submit} noValidate>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Amount" htmlFor="salary-amount" required error={errors.amount?.[0]}>
            <Input
              id="salary-amount"
              type="number"
              min={0}
              step="0.01"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              required
            />
          </Field>
          <Field label="Currency" htmlFor="salary-currency" required error={errors.currency?.[0]}>
            <Input
              id="salary-currency"
              value={currency}
              maxLength={3}
              onChange={(event) => setCurrency(event.target.value.toUpperCase())}
              required
            />
          </Field>
          <Field label="Effective from" htmlFor="salary-from" required error={errors.effectiveFrom?.[0]}>
            <Input
              id="salary-from"
              type="date"
              value={effectiveFrom}
              onChange={(event) => setEffectiveFrom(event.target.value)}
              required
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Notes" htmlFor="salary-notes" error={errors.notes?.[0]}>
              <Textarea
                id="salary-notes"
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

function LeaveDialog({
  staff,
  canApprove,
  onClose,
  onSaved,
}: {
  staff: StaffRecord[];
  canApprove: boolean;
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  const schoolId = useSchoolId();
  const timeZone = useSchoolTimezone();
  const [staffId, setStaffId] = useState('');
  const [leaveType, setLeaveType] = useState<string>('casual');
  const [startsOn, setStartsOn] = useState(todayIso(timeZone));
  const [endsOn, setEndsOn] = useState(todayIso(timeZone));
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});

  const types = useQuery({
    queryKey: ['leave-types', schoolId],
    queryFn: () => listLeaveTypes(schoolId),
  });
  const configuredTypes = (types.data?.items ?? []).filter((type) => type.active);

  useEffect(() => {
    if (configuredTypes.length > 0 && !configuredTypes.some((type) => type.code === leaveType)) {
      setLeaveType(configuredTypes[0]!.code);
    }
  }, [configuredTypes, leaveType]);

  const mutation = useMutation({
    mutationFn: () =>
      requestLeave(schoolId, {
        staffId: canApprove && staffId ? staffId : undefined,
        leaveType,
        startsOn,
        endsOn,
        reason,
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
      title="Request leave"
      description={
        canApprove
          ? 'Choose a staff member or leave the selection empty to request for yourself.'
          : 'Requests are recorded against your own staff record.'
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button form="leave-form" type="submit" loading={mutation.isPending}>
            Submit request
          </Button>
        </>
      }
    >
      <form id="leave-form" className="space-y-4" onSubmit={submit} noValidate>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          {canApprove && (
            <Field label="Staff member" htmlFor="leave-staff">
              <Select id="leave-staff" value={staffId} onChange={(event) => setStaffId(event.target.value)}>
                <option value="">Myself</option>
                {staff.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.fullName} ({member.employeeNumber})
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Leave type" htmlFor="leave-type" required error={errors.leaveType?.[0]}>
            <Select id="leave-type" value={leaveType} onChange={(event) => setLeaveType(event.target.value)}>
              {configuredTypes.length > 0
                ? configuredTypes.map((type) => (
                    <option key={type.id} value={type.code}>
                      {type.name} ({type.code})
                    </option>
                  ))
                : LEAVE_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
            </Select>
          </Field>
          <Field label="Starts on" htmlFor="leave-start" required error={errors.startsOn?.[0]}>
            <Input
              id="leave-start"
              type="date"
              value={startsOn}
              onChange={(event) => setStartsOn(event.target.value)}
              required
            />
          </Field>
          <Field label="Ends on" htmlFor="leave-end" required error={errors.endsOn?.[0]}>
            <Input
              id="leave-end"
              type="date"
              value={endsOn}
              onChange={(event) => setEndsOn(event.target.value)}
              required
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Reason" htmlFor="leave-reason" required error={errors.reason?.[0]}>
              <Textarea
                id="leave-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Why is this leave needed?"
                required
              />
            </Field>
          </div>
        </div>
      </form>
    </Dialog>
  );
}
