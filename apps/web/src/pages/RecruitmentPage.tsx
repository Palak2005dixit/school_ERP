import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import type { Candidate, CandidateInterview, Vacancy } from '@erp/shared';
import { useAuth, useSchoolId } from '../auth/AuthContext';
import {
  createCandidate,
  createCandidateInterview,
  createEmployeeChange,
  createJobOffer,
  createOnboardingTask,
  createSeparation,
  createVacancy,
  decideJobOffer,
  decideSeparation,
  hireCandidate,
  listCandidateInterviews,
  listCandidates,
  listEmployeeChanges,
  listJobOffers,
  listOnboardingTasks,
  listSeparations,
  listStaff,
  listUsers,
  listVacancies,
  recordInterviewOutcome,
  setCandidateStage,
  setExitTaskStatus,
  setOnboardingTaskStatus,
  updateVacancy,
} from '../lib/endpoints';
import { errorMessage } from '../lib/api';
import { formatDate, formatDateTime, formatMoney } from '../lib/format';
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
  TableSkeleton,
  Textarea,
} from '../components/ui';

type Tab = 'vacancies' | 'candidates' | 'offers' | 'onboarding' | 'changes' | 'separations';

const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'visiting'] as const;
const VACANCY_STATUSES = ['draft', 'open', 'closed', 'cancelled'] as const;
const STAGES = [
  'applied',
  'screening',
  'interview',
  'offer',
  'hired',
  'rejected',
  'withdrawn',
] as const;
const INTERVIEW_MODES = ['in_person', 'phone', 'video'] as const;
const CHANGE_TYPES = ['transfer', 'department', 'designation', 'status'] as const;
const SEPARATION_REASONS = [
  'resignation',
  'retirement',
  'termination',
  'contract_end',
  'other',
] as const;

type DialogState =
  | { kind: 'vacancy'; vacancy?: Vacancy }
  | { kind: 'candidate' }
  | { kind: 'interview'; candidate: Candidate }
  | { kind: 'outcome'; interview: CandidateInterview }
  | { kind: 'offer'; candidate?: Candidate }
  | { kind: 'onboarding' }
  | { kind: 'change' }
  | { kind: 'separation' }
  | null;

function toInstant(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function RecruitmentPage(): ReactNode {
  const schoolId = useSchoolId();
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();

  const canView = can('hr.recruitment.view');
  const canManage = can('hr.recruitment.manage');
  const canApprove = can('hr.recruitment.approve');
  const canOnboard = can('hr.onboarding.manage');
  const canSeparate = can('hr.separation.manage');
  const canViewStaff = can('hr.employee.view');
  const canListUsers = can('access.roles.manage');

  const [tab, setTab] = useState<Tab>('vacancies');
  const [stageFilter, setStageFilter] = useState('');
  const [vacancyFilter, setVacancyFilter] = useState('');
  const [dialog, setDialog] = useState<DialogState>(null);
  const [formError, setFormError] = useState('');

  const vacancies = useQuery({
    queryKey: ['vacancies', schoolId],
    queryFn: () => listVacancies(schoolId),
    enabled: canView,
  });
  const candidates = useQuery({
    queryKey: ['candidates', schoolId, stageFilter, vacancyFilter],
    queryFn: () =>
      listCandidates(schoolId, {
        stage: stageFilter || undefined,
        vacancyId: vacancyFilter || undefined,
      }),
    enabled: canView && (tab === 'candidates' || dialog?.kind === 'offer'),
  });
  const interviews = useQuery({
    queryKey: ['candidate-interviews', schoolId, dialog?.kind === 'interview' ? dialog.candidate.id : ''],
    queryFn: () => listCandidateInterviews(schoolId, (dialog as { candidate: Candidate }).candidate.id),
    enabled: canView && dialog?.kind === 'interview',
  });
  const offers = useQuery({
    queryKey: ['job-offers', schoolId],
    queryFn: () => listJobOffers(schoolId),
    enabled: canView && (tab === 'offers' || dialog?.kind === 'offer'),
  });
  const onboarding = useQuery({
    queryKey: ['onboarding-tasks', schoolId],
    queryFn: () => listOnboardingTasks(schoolId),
    enabled: canOnboard && tab === 'onboarding',
  });
  const changes = useQuery({
    queryKey: ['employee-changes', schoolId],
    queryFn: () => listEmployeeChanges(schoolId),
    enabled: canOnboard && tab === 'changes',
  });
  const separations = useQuery({
    queryKey: ['separations', schoolId],
    queryFn: () => listSeparations(schoolId),
    enabled: canSeparate && tab === 'separations',
  });
  const staff = useQuery({
    queryKey: ['staff', schoolId, 'recruitment-picker'],
    queryFn: () => listStaff(schoolId),
    enabled: canViewStaff && (tab === 'onboarding' || tab === 'changes' || tab === 'separations'),
  });
  const users = useQuery({
    queryKey: ['users', schoolId, 'interview-picker'],
    queryFn: () => listUsers(schoolId),
    enabled: canListUsers && dialog?.kind === 'interview',
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['vacancies', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['candidates', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['candidate-interviews', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['job-offers', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['onboarding-tasks', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['employee-changes', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['separations', schoolId] });
  };

  function useAction<TInput, TResult>(
    fn: (input: TInput) => Promise<TResult>,
    message: string,
  ) {
    return useMutation({
      mutationFn: fn,
      onSuccess: () => {
        toast.notify('success', message);
        setDialog(null);
        invalidate();
      },
      onError: (error) => setFormError(errorMessage(error)),
    });
  }

  const saveVacancy = useAction(
    (input: { id?: string; body: Parameters<typeof createVacancy>[1] }) =>
      input.id ? updateVacancy(schoolId, input.id, input.body) : createVacancy(schoolId, input.body),
    'Vacancy saved.',
  );
  const saveCandidate = useAction(
    (body: Parameters<typeof createCandidate>[1]) => createCandidate(schoolId, body),
    'Candidate added.',
  );
  const saveInterview = useAction(
    (body: Parameters<typeof createCandidateInterview>[2] & { candidateId: string }) =>
      createCandidateInterview(schoolId, body.candidateId, {
        scheduledAt: body.scheduledAt,
        mode: body.mode,
        interviewerUserId: body.interviewerUserId,
      }),
    'Interview scheduled.',
  );
  const saveOutcome = useAction(
    (input: {
      id: string;
      body: Parameters<typeof recordInterviewOutcome>[2];
    }) => recordInterviewOutcome(schoolId, input.id, input.body),
    'Interview outcome recorded.',
  );
  const saveOffer = useAction(
    (body: Parameters<typeof createJobOffer>[1]) => createJobOffer(schoolId, body),
    'Job offer created.',
  );
  const decideOffer = useAction(
    (input: { id: string; decision: string }) =>
      decideJobOffer(schoolId, input.id, { decision: input.decision }),
    'Offer updated.',
  );
  const hire = useAction(
    (id: string) => hireCandidate(schoolId, id),
    'Candidate hired and staff record created.',
  );
  const saveTask = useAction(
    (body: Parameters<typeof createOnboardingTask>[1]) => createOnboardingTask(schoolId, body),
    'Onboarding task added.',
  );
  const completeTask = useAction(
    (input: { id: string; status: 'pending' | 'done' | 'cancelled' }) =>
      setOnboardingTaskStatus(schoolId, input.id, input.status),
    'Task updated.',
  );
  const saveChange = useAction(
    (body: Parameters<typeof createEmployeeChange>[1]) => createEmployeeChange(schoolId, body),
    'Employee change recorded.',
  );
  const saveSeparation = useAction(
    (body: Parameters<typeof createSeparation>[1]) => createSeparation(schoolId, body),
    'Separation initiated.',
  );
  const decideSeparationMutation = useAction(
    (input: { id: string; decision: string }) =>
      decideSeparation(schoolId, input.id, { decision: input.decision }),
    'Separation updated.',
  );
  const completeExit = useAction(
    (input: { id: string; status: 'pending' | 'done' | 'cancelled' }) =>
      setExitTaskStatus(schoolId, input.id, input.status),
    'Exit task updated.',
  );

  const vacancyOptions = vacancies.data?.items ?? [];
  const candidateOptions = candidates.data?.items ?? [];
  const staffOptions = staff.data?.items ?? [];

  const tabs: Array<{ value: Tab; label: string }> = [
    { value: 'vacancies', label: 'Vacancies' },
    { value: 'candidates', label: 'Candidates' },
    { value: 'offers', label: 'Offers' },
    ...(canOnboard
      ? ([
          { value: 'onboarding', label: 'Onboarding' },
          { value: 'changes', label: 'Employee changes' },
        ] as Array<{ value: Tab; label: string }>)
      : []),
    ...(canSeparate ? [{ value: 'separations' as Tab, label: 'Separations' }] : []),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Recruitment, onboarding & separation"
        description="Track vacancies, candidates and interviews, approve offers, then hand the new hire to onboarding. Separation revokes portal credentials automatically once approved."
        actions={
          <div className="flex flex-wrap gap-2">
            {canManage && (
              <>
                <Button variant="secondary" onClick={() => setDialog({ kind: 'vacancy' })}>
                  <Icon name="plus" className="h-4 w-4" />
                  New vacancy
                </Button>
                <Button onClick={() => setDialog({ kind: 'candidate' })}>
                  <Icon name="user" className="h-4 w-4" />
                  Add candidate
                </Button>
              </>
            )}
            {canSeparate && (
              <Button variant="secondary" onClick={() => setDialog({ kind: 'separation' })}>
                Initiate separation
              </Button>
            )}
          </div>
        }
      />

      <Tabs value={tab} onChange={setTab} tabs={tabs} label="Recruitment views" />

      {tab === 'vacancies' && canView && (
        <Card>
          <CardHeader
            title="Vacancies"
            description="Open vacancies accept candidates. Closing a vacancy keeps its history."
            actions={
              canManage ? (
                <Button size="sm" onClick={() => setDialog({ kind: 'vacancy' })}>
                  New vacancy
                </Button>
              ) : undefined
            }
          />
          {vacancies.isPending ? (
            <TableSkeleton rows={5} columns={7} />
          ) : vacancies.isError ? (
            <ErrorState message={errorMessage(vacancies.error)} onRetry={() => void vacancies.refetch()} />
          ) : vacancyOptions.length === 0 ? (
            <EmptyState title="No vacancies" description="Create a vacancy to start recruiting." icon="clipboard" />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Reference</th>
                    <th>Title</th>
                    <th>Designation</th>
                    <th>Type</th>
                    <th className="text-right">Openings</th>
                    <th>Posted</th>
                    <th>Status</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {vacancyOptions.map((row) => (
                    <tr key={row.id}>
                      <td className="font-mono text-xs">{row.reference}</td>
                      <td className="font-medium text-slate-900">{row.title}</td>
                      <td>{row.designation}</td>
                      <td className="text-sm text-slate-600">{row.employmentType.replace(/_/g, ' ')}</td>
                      <td className="text-right tabular-nums">{row.openings}</td>
                      <td>{formatDate(row.postedOn)}</td>
                      <td>
                        <Badge tone={row.status === 'open' ? 'success' : row.status === 'closed' ? 'neutral' : 'warning'}>
                          {row.status}
                        </Badge>
                        <p className="mt-1 text-xs text-slate-500">{row.candidateCount} candidates</p>
                      </td>
                      <td className="text-right">
                        {canManage && (
                          <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'vacancy', vacancy: row })}>
                            Edit
                          </Button>
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

      {tab === 'candidates' && canView && (
        <Card>
          <CardHeader
            title="Candidates"
            description="Move candidates through the pipeline. Scheduling an interview requires a user account for the interviewer."
            actions={
              <div className="flex flex-wrap gap-2">
                <Select
                  aria-label="Filter by vacancy"
                  value={vacancyFilter}
                  onChange={(event) => setVacancyFilter(event.target.value)}
                  className="w-48"
                >
                  <option value="">All vacancies</option>
                  {vacancyOptions.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.title}
                    </option>
                  ))}
                </Select>
                <Select
                  aria-label="Filter by stage"
                  value={stageFilter}
                  onChange={(event) => setStageFilter(event.target.value)}
                  className="w-40"
                >
                  <option value="">All stages</option>
                  {STAGES.map((stage) => (
                    <option key={stage} value={stage}>
                      {stage}
                    </option>
                  ))}
                </Select>
              </div>
            }
          />
          {candidates.isPending ? (
            <TableSkeleton rows={6} columns={6} />
          ) : candidates.isError ? (
            <ErrorState message={errorMessage(candidates.error)} onRetry={() => void candidates.refetch()} />
          ) : candidateOptions.length === 0 ? (
            <EmptyState title="No candidates" description="Add a candidate to a vacancy." icon="users" />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Candidate</th>
                    <th>Vacancy</th>
                    <th>Applied</th>
                    <th>Stage</th>
                    <th className="text-right">Interviews</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {candidateOptions.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <p className="font-medium text-slate-900">{row.fullName}</p>
                        <p className="text-xs text-slate-500">{row.email}</p>
                      </td>
                      <td className="text-sm text-slate-600">{row.vacancyTitle}</td>
                      <td>{formatDate(row.appliedOn)}</td>
                      <td>
                        {canManage ? (
                          <Select
                            aria-label={`Stage for ${row.fullName}`}
                            value={row.stage}
                            onChange={(event) =>
                              setCandidateStage(schoolId, row.id, event.target.value).then(
                                () => {
                                  toast.notify('success', 'Stage updated.');
                                  invalidate();
                                },
                                (error) => toast.notify('error', errorMessage(error)),
                              )
                            }
                            className="w-36"
                          >
                            {STAGES.map((stage) => (
                              <option key={stage} value={stage}>
                                {stage}
                              </option>
                            ))}
                          </Select>
                        ) : (
                          <Badge>{row.stage}</Badge>
                        )}
                      </td>
                      <td className="text-right tabular-nums">{row.interviewCount}</td>
                      <td>
                        <div className="flex flex-wrap justify-end gap-2">
                          {canManage && (
                            <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'interview', candidate: row })}>
                              Interviews
                            </Button>
                          )}
                          {canView && (
                            <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'offer', candidate: row })}>
                              Offer
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

      {tab === 'offers' && canView && (
        <Card>
          <CardHeader
            title="Job offers"
            description="Approval is separated from creation. Hiring creates the employee record and can only happen from an accepted offer."
          />
          {offers.isPending ? (
            <TableSkeleton rows={5} columns={6} />
          ) : offers.isError ? (
            <ErrorState message={errorMessage(offers.error)} onRetry={() => void offers.refetch()} />
          ) : (offers.data?.items.length ?? 0) === 0 ? (
            <EmptyState title="No offers" description="Create an offer from a candidate." icon="clipboard" />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Candidate</th>
                    <th>Designation</th>
                    <th className="text-right">Gross salary</th>
                    <th>Starts</th>
                    <th>Status</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {offers.data!.items.map((row) => (
                    <tr key={row.id}>
                      <td className="font-medium text-slate-900">{row.candidateName}</td>
                      <td>
                        {row.designation}
                        {row.department && <p className="text-xs text-slate-500">{row.department}</p>}
                      </td>
                      <td className="text-right tabular-nums">{formatMoney(row.grossSalary, row.currency)}</td>
                      <td>{formatDate(row.startsOn)}</td>
                      <td>
                        <Badge tone={row.status === 'accepted' ? 'success' : row.status === 'rejected' ? 'danger' : 'warning'}>
                          {row.status.replace(/_/g, ' ')}
                        </Badge>
                      </td>
                      <td>
                        <div className="flex flex-wrap justify-end gap-2">
                          {canManage && row.status === 'draft' && (
                            <Button size="sm" variant="ghost" onClick={() => decideOffer.mutate({ id: row.id, decision: 'submit' })}>
                              Submit
                            </Button>
                          )}
                          {canApprove && row.status === 'pending_approval' && (
                            <>
                              <Button size="sm" onClick={() => decideOffer.mutate({ id: row.id, decision: 'approve' })}>
                                Approve
                              </Button>
                              <Button size="sm" variant="danger" onClick={() => decideOffer.mutate({ id: row.id, decision: 'reject' })}>
                                Reject
                              </Button>
                            </>
                          )}
                          {canManage && row.status === 'approved' && (
                            <>
                              <Button size="sm" variant="ghost" onClick={() => decideOffer.mutate({ id: row.id, decision: 'accept' })}>
                                Accept
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => decideOffer.mutate({ id: row.id, decision: 'decline' })}>
                                Decline
                              </Button>
                            </>
                          )}
                          {canOnboard && row.status === 'accepted' && (
                            <Button size="sm" loading={hire.isPending} onClick={() => hire.mutate(row.id)}>
                              Hire
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

      {tab === 'onboarding' && canOnboard && (
        <Card>
          <CardHeader
            title="Onboarding tasks"
            description="Tasks are owned by a user and tracked to completion."
            actions={
              <Button size="sm" onClick={() => setDialog({ kind: 'onboarding' })}>
                Add task
              </Button>
            }
          />
          {onboarding.isPending ? (
            <TableSkeleton rows={5} columns={5} />
          ) : onboarding.isError ? (
            <ErrorState message={errorMessage(onboarding.error)} onRetry={() => void onboarding.refetch()} />
          ) : (onboarding.data?.items.length ?? 0) === 0 ? (
            <EmptyState title="No onboarding tasks" description="Add tasks for a new hire." icon="check" />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Task</th>
                    <th>Owner</th>
                    <th>Due</th>
                    <th>Status</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {onboarding.data!.items.map((row) => (
                    <tr key={row.id}>
                      <td className="font-medium text-slate-900">{row.staffName}</td>
                      <td>{row.title}</td>
                      <td className="text-sm text-slate-600">{row.ownerName ?? '—'}</td>
                      <td>{formatDate(row.dueOn)}</td>
                      <td>
                        <Badge tone={row.status === 'done' ? 'success' : row.status === 'cancelled' ? 'neutral' : 'warning'}>
                          {row.status}
                        </Badge>
                      </td>
                      <td>
                        <div className="flex flex-wrap justify-end gap-2">
                          {row.status !== 'done' && (
                            <Button size="sm" variant="ghost" onClick={() => completeTask.mutate({ id: row.id, status: 'done' })}>
                              Mark done
                            </Button>
                          )}
                          {row.status !== 'cancelled' && (
                            <Button size="sm" variant="ghost" onClick={() => completeTask.mutate({ id: row.id, status: 'cancelled' })}>
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

      {tab === 'changes' && canOnboard && (
        <Card>
          <CardHeader
            title="Employee changes"
            description="Transfers, department and designation changes take effect on the recorded date."
            actions={
              <Button size="sm" onClick={() => setDialog({ kind: 'change' })}>
                Record change
              </Button>
            }
          />
          {changes.isPending ? (
            <TableSkeleton rows={4} columns={5} />
          ) : changes.isError ? (
            <ErrorState message={errorMessage(changes.error)} onRetry={() => void changes.refetch()} />
          ) : (changes.data?.items.length ?? 0) === 0 ? (
            <EmptyState title="No changes" description="Record a transfer or designation change." icon="user" />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Change</th>
                    <th>From</th>
                    <th>To</th>
                    <th>Effective</th>
                  </tr>
                </thead>
                <tbody>
                  {changes.data!.items.map((row) => (
                    <tr key={row.id}>
                      <td className="font-medium text-slate-900">{row.staffName}</td>
                      <td className="text-sm text-slate-600">{row.changeType}</td>
                      <td className="text-sm text-slate-600">{row.fromValue ?? '—'}</td>
                      <td className="text-sm text-slate-600">{row.toValue}</td>
                      <td>{formatDate(row.effectiveOn)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'separations' && canSeparate && (
        <Card>
          <CardHeader
            title="Separations"
            description="Approval revokes portal access; completing the separation requires all exit tasks to be done or cancelled."
            actions={
              <Button size="sm" onClick={() => setDialog({ kind: 'separation' })}>
                Initiate separation
              </Button>
            }
          />
          {separations.isPending ? (
            <TableSkeleton rows={4} columns={5} />
          ) : separations.isError ? (
            <ErrorState message={errorMessage(separations.error)} onRetry={() => void separations.refetch()} />
          ) : (separations.data?.items.length ?? 0) === 0 ? (
            <EmptyState title="No separations" description="Initiate a separation with exit tasks." icon="logout" />
          ) : (
            <div className="space-y-3 p-4">
              {separations.data!.items.map((row) => (
                <div key={row.id} className="rounded-lg border border-slate-200 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-medium text-slate-900">{row.staffName}</p>
                      <p className="text-xs text-slate-500">
                        Last working day {formatDate(row.lastWorkingDay)} · {row.reason.replace(/_/g, ' ')}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={row.status === 'completed' ? 'success' : row.status === 'cancelled' ? 'neutral' : 'warning'}>
                        {row.status}
                      </Badge>
                      {canApprove && row.status === 'initiated' && (
                        <>
                          <Button size="sm" onClick={() => decideSeparationMutation.mutate({ id: row.id, decision: 'approve' })}>
                            Approve
                          </Button>
                          <Button size="sm" variant="danger" onClick={() => decideSeparationMutation.mutate({ id: row.id, decision: 'reject' })}>
                            Reject
                          </Button>
                        </>
                      )}
                      {row.status === 'approved' && (
                        <Button size="sm" onClick={() => decideSeparationMutation.mutate({ id: row.id, decision: 'complete' })}>
                          Complete
                        </Button>
                      )}
                      {row.accessRevokedAt && (
                        <span className="text-xs text-slate-500">
                          Access revoked {formatDateTime(row.accessRevokedAt)}
                        </span>
                      )}
                    </div>
                  </div>
                  <ul className="mt-2 space-y-1">
                    {row.tasks.map((task) => (
                      <li key={task.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                        <span className={task.status === 'done' ? 'text-slate-400 line-through' : 'text-slate-700'}>
                          {task.title}
                        </span>
                        <div className="flex items-center gap-2">
                          <Badge tone={task.status === 'done' ? 'success' : task.status === 'cancelled' ? 'neutral' : 'warning'}>
                            {task.status}
                          </Badge>
                          {task.status === 'pending' && (
                            <>
                              <Button size="sm" variant="ghost" onClick={() => completeExit.mutate({ id: task.id, status: 'done' })}>
                                Done
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => completeExit.mutate({ id: task.id, status: 'cancelled' })}>
                                Cancel
                              </Button>
                            </>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {dialog?.kind === 'vacancy' && (
        <VacancyDialog
          key={dialog.vacancy?.id ?? 'new-vacancy'}
          vacancy={dialog.vacancy}
          error={formError}
          saving={saveVacancy.isPending}
          onClose={() => {
            setDialog(null);
            setFormError('');
          }}
          onSave={(body) => saveVacancy.mutate({ id: dialog.vacancy?.id, body })}
        />
      )}

      {dialog?.kind === 'candidate' && (
        <CandidateDialog
          vacancies={vacancyOptions}
          error={formError}
          saving={saveCandidate.isPending}
          onClose={() => {
            setDialog(null);
            setFormError('');
          }}
          onSave={(body) => saveCandidate.mutate(body)}
        />
      )}

      {dialog?.kind === 'interview' && (
        <InterviewDialog
          candidate={dialog.candidate}
          interviews={interviews.data?.items ?? []}
          users={(users.data?.items ?? []).map((user) => ({
            id: user.id,
            name: user.displayName,
          }))}
          canSchedule={canManage && canListUsers}
          canRecord={canManage}
          error={formError}
          saving={saveInterview.isPending}
          onClose={() => {
            setDialog(null);
            setFormError('');
          }}
          onSchedule={(body) => saveInterview.mutate({ ...body, candidateId: dialog.candidate.id })}
          onOutcome={(interview) => setDialog({ kind: 'outcome', interview })}
        />
      )}

      {dialog?.kind === 'outcome' && (
        <OutcomeDialog
          interview={dialog.interview}
          error={formError}
          saving={saveOutcome.isPending}
          onClose={() => {
            setDialog(null);
            setFormError('');
          }}
          onSave={(body) => saveOutcome.mutate({ id: dialog.interview.id, body })}
        />
      )}

      {dialog?.kind === 'offer' && (
        <OfferDialog
          candidates={candidateOptions}
          initialCandidateId={dialog.candidate?.id}
          error={formError}
          saving={saveOffer.isPending}
          onClose={() => {
            setDialog(null);
            setFormError('');
          }}
          onSave={(body) => saveOffer.mutate(body)}
        />
      )}

      {dialog?.kind === 'onboarding' && (
        <OnboardingDialog
          staff={staffOptions}
          error={formError}
          saving={saveTask.isPending}
          onClose={() => {
            setDialog(null);
            setFormError('');
          }}
          onSave={(body) => saveTask.mutate(body)}
        />
      )}

      {dialog?.kind === 'change' && (
        <ChangeDialog
          staff={staffOptions}
          error={formError}
          saving={saveChange.isPending}
          onClose={() => {
            setDialog(null);
            setFormError('');
          }}
          onSave={(body) => saveChange.mutate(body)}
        />
      )}

      {dialog?.kind === 'separation' && (
        <SeparationDialog
          staff={staffOptions}
          error={formError}
          saving={saveSeparation.isPending}
          onClose={() => {
            setDialog(null);
            setFormError('');
          }}
          onSave={(body) => saveSeparation.mutate(body)}
        />
      )}
    </div>
  );
}

function VacancyDialog({
  vacancy,
  error,
  saving,
  onClose,
  onSave,
}: {
  vacancy?: Vacancy;
  error: string;
  saving: boolean;
  onClose: () => void;
  onSave: (body: Parameters<typeof createVacancy>[1]) => void;
}): ReactNode {
  const [title, setTitle] = useState(vacancy?.title ?? '');
  const [designation, setDesignation] = useState(vacancy?.designation ?? '');
  const [department, setDepartment] = useState(vacancy?.department ?? '');
  const [employmentType, setEmploymentType] = useState(vacancy?.employmentType ?? 'full_time');
  const [openings, setOpenings] = useState(String(vacancy?.openings ?? 1));
  const [status, setStatus] = useState(vacancy?.status ?? 'draft');
  const [description, setDescription] = useState(vacancy?.description ?? '');
  const [postedOn, setPostedOn] = useState(vacancy?.postedOn ?? '');
  const [closesOn, setClosesOn] = useState(vacancy?.closesOn ?? '');

  return (
    <Dialog
      open
      onClose={onClose}
      title={vacancy ? 'Edit vacancy' : 'New vacancy'}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="vacancy-form" loading={saving}>
            Save vacancy
          </Button>
        </>
      }
    >
      <form
        id="vacancy-form"
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({
            title,
            designation,
            department: department || undefined,
            employmentType,
            openings: Number(openings),
            status,
            description: description || undefined,
            postedOn: postedOn || null,
            closesOn: closesOn || null,
          });
        }}
      >
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Title" htmlFor="vac-title" required>
            <Input id="vac-title" value={title} onChange={(event) => setTitle(event.target.value)} required />
          </Field>
          <Field label="Designation" htmlFor="vac-designation" required>
            <Input id="vac-designation" value={designation} onChange={(event) => setDesignation(event.target.value)} required />
          </Field>
          <Field label="Department" htmlFor="vac-department">
            <Input id="vac-department" value={department} onChange={(event) => setDepartment(event.target.value)} />
          </Field>
          <Field label="Employment type" htmlFor="vac-type">
            <Select id="vac-type" value={employmentType} onChange={(event) => setEmploymentType(event.target.value as typeof employmentType)}>
              {EMPLOYMENT_TYPES.map((value) => (
                <option key={value} value={value}>
                  {value.replace(/_/g, ' ')}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Openings" htmlFor="vac-openings">
            <Input id="vac-openings" type="number" min={1} max={100} value={openings} onChange={(event) => setOpenings(event.target.value)} />
          </Field>
          <Field label="Status" htmlFor="vac-status">
            <Select id="vac-status" value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
              {VACANCY_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Posted on" htmlFor="vac-posted">
            <Input id="vac-posted" type="date" value={postedOn} onChange={(event) => setPostedOn(event.target.value)} />
          </Field>
          <Field label="Closes on" htmlFor="vac-closes">
            <Input id="vac-closes" type="date" value={closesOn} onChange={(event) => setClosesOn(event.target.value)} />
          </Field>
        </div>
        <Field label="Description" htmlFor="vac-description">
          <Textarea id="vac-description" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={4000} />
        </Field>
      </form>
    </Dialog>
  );
}

function CandidateDialog({
  vacancies,
  error,
  saving,
  onClose,
  onSave,
}: {
  vacancies: Vacancy[];
  error: string;
  saving: boolean;
  onClose: () => void;
  onSave: (body: Parameters<typeof createCandidate>[1]) => void;
}): ReactNode {
  const [vacancyId, setVacancyId] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [source, setSource] = useState('');
  const [notes, setNotes] = useState('');

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add candidate"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="candidate-form" loading={saving}>
            Add candidate
          </Button>
        </>
      }
    >
      <form
        id="candidate-form"
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({
            vacancyId,
            firstName,
            lastName: lastName || undefined,
            email,
            phone: phone || undefined,
            source: source || undefined,
            notes: notes || undefined,
          });
        }}
      >
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Vacancy" htmlFor="cand-vacancy" required>
          <Select id="cand-vacancy" value={vacancyId} onChange={(event) => setVacancyId(event.target.value)} required>
            <option value="">Select vacancy</option>
            {vacancies.map((row) => (
              <option key={row.id} value={row.id}>
                {row.title} ({row.status})
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name" htmlFor="cand-first" required>
            <Input id="cand-first" value={firstName} onChange={(event) => setFirstName(event.target.value)} required />
          </Field>
          <Field label="Last name" htmlFor="cand-last">
            <Input id="cand-last" value={lastName} onChange={(event) => setLastName(event.target.value)} />
          </Field>
          <Field label="Email" htmlFor="cand-email" required>
            <Input id="cand-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
          </Field>
          <Field label="Phone" htmlFor="cand-phone">
            <Input id="cand-phone" value={phone} onChange={(event) => setPhone(event.target.value)} />
          </Field>
          <Field label="Source" htmlFor="cand-source">
            <Input id="cand-source" value={source} onChange={(event) => setSource(event.target.value)} />
          </Field>
        </div>
        <Field label="Notes" htmlFor="cand-notes">
          <Textarea id="cand-notes" value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={2000} />
        </Field>
      </form>
    </Dialog>
  );
}

function InterviewDialog({
  candidate,
  interviews,
  users,
  canSchedule,
  canRecord,
  error,
  saving,
  onClose,
  onSchedule,
  onOutcome,
}: {
  candidate: Candidate;
  interviews: CandidateInterview[];
  users: Array<{ id: string; name: string }>;
  canSchedule: boolean;
  canRecord: boolean;
  error: string;
  saving: boolean;
  onClose: () => void;
  onSchedule: (body: Parameters<typeof createCandidateInterview>[2]) => void;
  onOutcome: (interview: CandidateInterview) => void;
}): ReactNode {
  const [scheduledAt, setScheduledAt] = useState('');
  const [mode, setMode] = useState<'in_person' | 'phone' | 'video'>('in_person');
  const [interviewerUserId, setInterviewerUserId] = useState('');

  return (
    <Dialog open onClose={onClose} title={`Interviews · ${candidate.fullName}`} size="lg">
      <div className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        {interviews.length === 0 ? (
          <p className="text-sm text-slate-500">No interviews scheduled.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Mode</th>
                  <th>Interviewer</th>
                  <th>Status</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {interviews.map((row) => (
                  <tr key={row.id}>
                    <td>{formatDateTime(row.scheduledAt)}</td>
                    <td className="text-sm text-slate-600">{row.mode.replace(/_/g, ' ')}</td>
                    <td className="text-sm text-slate-600">{row.interviewerName ?? '—'}</td>
                    <td>
                      <Badge tone={row.status === 'completed' ? 'success' : row.status === 'cancelled' ? 'neutral' : 'warning'}>
                        {row.status}
                      </Badge>
                      {row.score !== null && <p className="text-xs text-slate-500">Score {row.score}/10</p>}
                    </td>
                    <td className="text-right">
                      {canRecord && row.status === 'scheduled' && (
                        <Button size="sm" variant="ghost" onClick={() => onOutcome(row)}>
                          Record outcome
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {canSchedule ? (
          <form
            className="space-y-3 rounded-lg border border-slate-200 p-3"
            onSubmit={(event) => {
              event.preventDefault();
              const iso = toInstant(scheduledAt);
              if (!iso) return;
              onSchedule({ scheduledAt: iso, mode, interviewerUserId });
            }}
          >
            <p className="text-sm font-medium text-slate-800">Schedule an interview</p>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Scheduled at" htmlFor="int-when" required>
                <Input id="int-when" type="datetime-local" value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} required />
              </Field>
              <Field label="Mode" htmlFor="int-mode">
                <Select id="int-mode" value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}>
                  {INTERVIEW_MODES.map((value) => (
                    <option key={value} value={value}>
                      {value.replace(/_/g, ' ')}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Interviewer" htmlFor="int-user" required>
                <Select id="int-user" value={interviewerUserId} onChange={(event) => setInterviewerUserId(event.target.value)} required>
                  <option value="">Select user</option>
                  {users.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="flex justify-end">
              <Button type="submit" size="sm" loading={saving}>
                Schedule
              </Button>
            </div>
          </form>
        ) : (
          <Alert tone="info">
            Scheduling interviews needs the recruitment-manage permission and access to the user directory
            (`access.roles.manage`). Ask an administrator to grant both.
          </Alert>
        )}
      </div>
    </Dialog>
  );
}

function OutcomeDialog({
  interview,
  error,
  saving,
  onClose,
  onSave,
}: {
  interview: CandidateInterview;
  error: string;
  saving: boolean;
  onClose: () => void;
  onSave: (body: Parameters<typeof recordInterviewOutcome>[2]) => void;
}): ReactNode {
  const [status, setStatus] = useState<'completed' | 'cancelled'>('completed');
  const [score, setScore] = useState('');
  const [recommendation, setRecommendation] = useState('');
  const [feedback, setFeedback] = useState('');

  return (
    <Dialog
      open
      onClose={onClose}
      title="Interview outcome"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="outcome-form" loading={saving}>
            Save outcome
          </Button>
        </>
      }
    >
      <form
        id="outcome-form"
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({
            status,
            score: score ? Number(score) : undefined,
            recommendation: recommendation
              ? (recommendation as 'strong_hire' | 'hire' | 'hold' | 'reject')
              : undefined,
            feedback: feedback || undefined,
          });
        }}
      >
        {error && <Alert tone="danger">{error}</Alert>}
        <p className="text-sm text-slate-600">
          {formatDateTime(interview.scheduledAt)} · {interview.mode.replace(/_/g, ' ')}
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Status" htmlFor="out-status">
            <Select id="out-status" value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
            </Select>
          </Field>
          <Field label="Score (1–10)" htmlFor="out-score">
            <Input id="out-score" type="number" min={1} max={10} value={score} onChange={(event) => setScore(event.target.value)} />
          </Field>
        </div>
        <Field label="Recommendation" htmlFor="out-rec">
          <Select id="out-rec" value={recommendation} onChange={(event) => setRecommendation(event.target.value)}>
            <option value="">No recommendation</option>
            <option value="strong_hire">Strong hire</option>
            <option value="hire">Hire</option>
            <option value="hold">Hold</option>
            <option value="reject">Reject</option>
          </Select>
        </Field>
        <Field label="Feedback" htmlFor="out-feedback">
          <Textarea id="out-feedback" value={feedback} onChange={(event) => setFeedback(event.target.value)} maxLength={2000} />
        </Field>
      </form>
    </Dialog>
  );
}

function OfferDialog({
  candidates,
  initialCandidateId,
  error,
  saving,
  onClose,
  onSave,
}: {
  candidates: Candidate[];
  initialCandidateId?: string;
  error: string;
  saving: boolean;
  onClose: () => void;
  onSave: (body: Parameters<typeof createJobOffer>[1]) => void;
}): ReactNode {
  const [candidateId, setCandidateId] = useState(initialCandidateId ?? '');
  const [designation, setDesignation] = useState('');
  const [department, setDepartment] = useState('');
  const [grossSalary, setGrossSalary] = useState('');
  const [currency, setCurrency] = useState('INR');
  const [startsOn, setStartsOn] = useState('');
  const [notes, setNotes] = useState('');

  return (
    <Dialog
      open
      onClose={onClose}
      title="Create job offer"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="offer-form" loading={saving}>
            Create offer
          </Button>
        </>
      }
    >
      <form
        id="offer-form"
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({
            candidateId,
            designation,
            department: department || undefined,
            grossSalary: Number(grossSalary),
            currency,
            startsOn,
            notes: notes || undefined,
          });
        }}
      >
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Candidate" htmlFor="offer-candidate" required>
          <Select id="offer-candidate" value={candidateId} onChange={(event) => setCandidateId(event.target.value)} required>
            <option value="">Select candidate</option>
            {candidates.map((row) => (
              <option key={row.id} value={row.id}>
                {row.fullName} · {row.vacancyTitle}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Designation" htmlFor="offer-designation" required>
            <Input id="offer-designation" value={designation} onChange={(event) => setDesignation(event.target.value)} required />
          </Field>
          <Field label="Department" htmlFor="offer-department">
            <Input id="offer-department" value={department} onChange={(event) => setDepartment(event.target.value)} />
          </Field>
          <Field label="Gross salary" htmlFor="offer-salary" required>
            <Input id="offer-salary" type="number" min={1} step="0.01" value={grossSalary} onChange={(event) => setGrossSalary(event.target.value)} required />
          </Field>
          <Field label="Currency" htmlFor="offer-currency">
            <Input id="offer-currency" value={currency} maxLength={3} onChange={(event) => setCurrency(event.target.value.toUpperCase())} />
          </Field>
          <Field label="Starts on" htmlFor="offer-starts" required>
            <Input id="offer-starts" type="date" value={startsOn} onChange={(event) => setStartsOn(event.target.value)} required />
          </Field>
        </div>
        <Field label="Notes" htmlFor="offer-notes">
          <Textarea id="offer-notes" value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={2000} />
        </Field>
      </form>
    </Dialog>
  );
}

function OnboardingDialog({
  staff,
  error,
  saving,
  onClose,
  onSave,
}: {
  staff: Array<{ id: string; fullName: string }>;
  error: string;
  saving: boolean;
  onClose: () => void;
  onSave: (body: Parameters<typeof createOnboardingTask>[1]) => void;
}): ReactNode {
  const [staffId, setStaffId] = useState('');
  const [title, setTitle] = useState('');
  const [dueOn, setDueOn] = useState('');

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add onboarding task"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="onboarding-form" loading={saving}>
            Add task
          </Button>
        </>
      }
    >
      <form
        id="onboarding-form"
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({ staffId, title, dueOn: dueOn || null });
        }}
      >
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Employee" htmlFor="onb-staff" required>
          <Select id="onb-staff" value={staffId} onChange={(event) => setStaffId(event.target.value)} required>
            <option value="">Select employee</option>
            {staff.map((row) => (
              <option key={row.id} value={row.id}>
                {row.fullName}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Task" htmlFor="onb-title" required>
          <Input id="onb-title" value={title} onChange={(event) => setTitle(event.target.value)} required />
        </Field>
        <Field label="Due on" htmlFor="onb-due">
          <Input id="onb-due" type="date" value={dueOn} onChange={(event) => setDueOn(event.target.value)} />
        </Field>
      </form>
    </Dialog>
  );
}

function ChangeDialog({
  staff,
  error,
  saving,
  onClose,
  onSave,
}: {
  staff: Array<{ id: string; fullName: string }>;
  error: string;
  saving: boolean;
  onClose: () => void;
  onSave: (body: Parameters<typeof createEmployeeChange>[1]) => void;
}): ReactNode {
  const [staffId, setStaffId] = useState('');
  const [changeType, setChangeType] = useState<(typeof CHANGE_TYPES)[number]>('department');
  const [effectiveOn, setEffectiveOn] = useState('');
  const [toValue, setToValue] = useState('');
  const [notes, setNotes] = useState('');

  return (
    <Dialog
      open
      onClose={onClose}
      title="Record employee change"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="change-form" loading={saving}>
            Save change
          </Button>
        </>
      }
    >
      <form
        id="change-form"
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({ staffId, changeType, effectiveOn, toValue, notes: notes || undefined });
        }}
      >
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Employee" htmlFor="chg-staff" required>
          <Select id="chg-staff" value={staffId} onChange={(event) => setStaffId(event.target.value)} required>
            <option value="">Select employee</option>
            {staff.map((row) => (
              <option key={row.id} value={row.id}>
                {row.fullName}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Change type" htmlFor="chg-type">
            <Select id="chg-type" value={changeType} onChange={(event) => setChangeType(event.target.value as typeof changeType)}>
              {CHANGE_TYPES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Effective on" htmlFor="chg-date" required>
            <Input id="chg-date" type="date" value={effectiveOn} onChange={(event) => setEffectiveOn(event.target.value)} required />
          </Field>
        </div>
        <Field label="New value" htmlFor="chg-value" required>
          <Input id="chg-value" value={toValue} onChange={(event) => setToValue(event.target.value)} required />
        </Field>
        <Field label="Notes" htmlFor="chg-notes">
          <Textarea id="chg-notes" value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={1000} />
        </Field>
      </form>
    </Dialog>
  );
}

function SeparationDialog({
  staff,
  error,
  saving,
  onClose,
  onSave,
}: {
  staff: Array<{ id: string; fullName: string }>;
  error: string;
  saving: boolean;
  onClose: () => void;
  onSave: (body: Parameters<typeof createSeparation>[1]) => void;
}): ReactNode {
  const [staffId, setStaffId] = useState('');
  const [lastWorkingDay, setLastWorkingDay] = useState('');
  const [reason, setReason] = useState<(typeof SEPARATION_REASONS)[number]>('resignation');
  const [notes, setNotes] = useState('');
  const [exitTasks, setExitTasks] = useState('');

  return (
    <Dialog
      open
      onClose={onClose}
      title="Initiate separation"
      description="One exit task per line. Access is revoked when the separation is approved."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="separation-form" loading={saving}>
            Initiate
          </Button>
        </>
      }
    >
      <form
        id="separation-form"
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({
            staffId,
            lastWorkingDay,
            reason,
            notes: notes || undefined,
            exitTasks: exitTasks
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean),
          });
        }}
      >
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Employee" htmlFor="sep-staff" required>
          <Select id="sep-staff" value={staffId} onChange={(event) => setStaffId(event.target.value)} required>
            <option value="">Select employee</option>
            {staff.map((row) => (
              <option key={row.id} value={row.id}>
                {row.fullName}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Last working day" htmlFor="sep-date" required>
            <Input id="sep-date" type="date" value={lastWorkingDay} onChange={(event) => setLastWorkingDay(event.target.value)} required />
          </Field>
          <Field label="Reason" htmlFor="sep-reason">
            <Select id="sep-reason" value={reason} onChange={(event) => setReason(event.target.value as typeof reason)}>
              {SEPARATION_REASONS.map((value) => (
                <option key={value} value={value}>
                  {value.replace(/_/g, ' ')}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Exit tasks" htmlFor="sep-tasks" hint="One task per line.">
          <Textarea id="sep-tasks" value={exitTasks} onChange={(event) => setExitTasks(event.target.value)} />
        </Field>
        <Field label="Notes" htmlFor="sep-notes">
          <Textarea id="sep-notes" value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={2000} />
        </Field>
      </form>
    </Dialog>
  );
}
