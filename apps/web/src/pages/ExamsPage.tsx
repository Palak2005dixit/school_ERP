import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type {
  ExamRecord,
  ExamSubject,
  GradingScheme,
  MarkSheet,
  ReportCard,
} from '@erp/shared';
import { useAuth, useSchoolId, useSchoolTimezone } from '../auth/AuthContext';
import {
  addExamSubject,
  createExam,
  createGradingScheme,
  deleteExam,
  getMarkSheet,
  getReportCard,
  getStudentTranscript,
  listAcademicYears,
  listExams,
  listGradingSchemes,
  listSections,
  listStudents,
  listSubjects,
  publishExam,
  removeExamSubject,
  saveMarks,
  transcriptPrintUrl,
  unpublishExam,
  updateExam,
} from '../lib/endpoints';
import { errorMessage, fieldErrors } from '../lib/api';
import { formatDate, formatDateTime, todayIso } from '../lib/format';
import { ConfirmDialog, Dialog } from '../components/Dialog';
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
  cn,
} from '../components/ui';

type Tab = 'exams' | 'schemes';
type DialogState =
  | { kind: 'exam'; exam?: ExamRecord }
  | { kind: 'scheme' }
  | null;
type ConfirmTarget =
  | { kind: 'publish'; exam: ExamRecord }
  | { kind: 'unpublish'; exam: ExamRecord }
  | { kind: 'delete'; exam: ExamRecord }
  | { kind: 'remove-subject'; exam: ExamRecord; subject: ExamSubject }
  | null;

export function ExamsPage(): ReactNode {
  const schoolId = useSchoolId();
  const timeZone = useSchoolTimezone();
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();

  const canManage = can('exams.manage');
  const canRecord = can('exams.marks.record');
  const canPublish = can('exams.results.publish');

  const [yearId, setYearId] = useState('');
  const [tab, setTab] = useState<Tab>('exams');
  const [selectedExamId, setSelectedExamId] = useState('');
  const [dialog, setDialog] = useState<DialogState>(null);
  const [confirming, setConfirming] = useState<ConfirmTarget>(null);

  const years = useQuery({
    queryKey: ['academic-years', schoolId],
    queryFn: () => listAcademicYears(schoolId),
  });
  const exams = useQuery({
    queryKey: ['exams', schoolId, yearId],
    queryFn: () => listExams(schoolId, yearId),
    enabled: Boolean(yearId),
  });
  const schemes = useQuery({
    queryKey: ['grading-schemes', schoolId],
    queryFn: () => listGradingSchemes(schoolId),
  });
  const subjects = useQuery({
    queryKey: ['subjects', schoolId],
    queryFn: () => listSubjects(schoolId),
  });
  const sections = useQuery({
    queryKey: ['sections', schoolId, yearId],
    queryFn: () => listSections(schoolId, { academicYearId: yearId }),
    enabled: Boolean(yearId),
  });

  useEffect(() => {
    if (yearId || !years.data) return;
    const preferred =
      years.data.items.find((year) => year.status === 'active') ?? years.data.items[0];
    if (preferred) setYearId(preferred.id);
  }, [years.data, yearId]);

  useEffect(() => {
    if (!exams.data) return;
    if (!exams.data.items.some((exam) => exam.id === selectedExamId)) {
      setSelectedExamId('');
    }
  }, [exams.data, selectedExamId]);

  const selectedExam = exams.data?.items.find((exam) => exam.id === selectedExamId);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['exams', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['grading-schemes', schoolId] });
  };

  const lifecycle = useMutation({
    mutationFn: async (target: NonNullable<ConfirmTarget>) => {
      if (target.kind === 'publish') await publishExam(schoolId, target.exam.id);
      else if (target.kind === 'unpublish') await unpublishExam(schoolId, target.exam.id);
      else if (target.kind === 'delete') await deleteExam(schoolId, target.exam.id);
      else await removeExamSubject(schoolId, target.exam.id, target.subject.id);
    },
    onSuccess: (_result, target) => {
      const message =
        target.kind === 'publish'
          ? 'Results published.'
          : target.kind === 'unpublish'
            ? 'Exam unpublished; mark entry reopened.'
            : target.kind === 'delete'
              ? 'Exam deleted.'
              : 'Subject removed.';
      toast.notify('success', message);
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
      <PageHeader
        title="Exams & results"
        description="Grading schemes, exam subjects, marks and report cards. Results become visible to guardians only after publication."
        actions={
          canManage ? (
            <>
              <Button variant="secondary" onClick={() => setDialog({ kind: 'scheme' })}>
                <Icon name="plus" className="h-4 w-4" />
                New grading scheme
              </Button>
              <Button
                onClick={() => setDialog({ kind: 'exam' })}
                disabled={!yearId || (schemes.data?.items.length ?? 0) === 0}
                title={
                  schemes.data?.items.length === 0
                    ? 'Create a grading scheme before adding an exam'
                    : undefined
                }
              >
                <Icon name="plus" className="h-4 w-4" />
                New exam
              </Button>
            </>
          ) : undefined
        }
      />

      <div className="flex flex-wrap items-end gap-4">
        <Field label="Academic year" htmlFor="exam-year">
          <Select
            id="exam-year"
            value={yearId}
            onChange={(event) => {
              setYearId(event.target.value);
              setSelectedExamId('');
            }}
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
      </div>

      <div className="flex gap-1 border-b border-slate-200" role="tablist" aria-label="Exam views">
        {(
          [
            ['exams', 'Exams'],
            ['schemes', 'Grading schemes'],
          ] as Array<[Tab, string]>
        ).map(([value, label]) => (
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

      {tab === 'schemes' ? (
        <SchemesPanel schemes={schemes.data?.items ?? []} loading={schemes.isPending} error={schemes.error} onRetry={() => void schemes.refetch()} />
      ) : (
        <>
          <Card>
            <CardHeader
              title="Exams"
              description="Create an exam, add its subjects, then record marks per section. Publishing locks marks."
            />
            {!yearId ? (
              <EmptyState title="No academic year selected" description="Choose an academic year." icon="calendar" />
            ) : exams.isPending ? (
              <TableSkeleton rows={4} columns={6} />
            ) : exams.isError ? (
              <ErrorState message={errorMessage(exams.error)} onRetry={() => void exams.refetch()} />
            ) : exams.data.items.length === 0 ? (
              <EmptyState
                title="No exams yet"
                description="Create an exam term to start recording marks."
                icon="clipboard"
                action={
                  canManage ? (
                    <Button size="sm" onClick={() => setDialog({ kind: 'exam' })}>
                      New exam
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Exam</th>
                      <th>Type</th>
                      <th>Dates</th>
                      <th>Scheme</th>
                      <th>Subjects</th>
                      <th>Status</th>
                      <th className="text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {exams.data.items.map((exam) => {
                      const entered = exam.subjects.filter((subject) => subject.marksEntered > 0).length;
                      return (
                        <tr key={exam.id} className={selectedExamId === exam.id ? 'bg-brand-50/40' : undefined}>
                          <td>
                            <button
                              type="button"
                              className="text-left font-medium text-brand-700 hover:underline"
                              onClick={() =>
                                setSelectedExamId((current) => (current === exam.id ? '' : exam.id))
                              }
                            >
                              {exam.name}
                            </button>
                            <p className="text-xs text-slate-500">{exam.academicYearName}</p>
                          </td>
                          <td className="capitalize">{exam.examType}</td>
                          <td className="text-sm">
                            {formatDate(exam.startsOn)} – {formatDate(exam.endsOn)}
                          </td>
                          <td className="text-sm">{exam.gradingSchemeName}</td>
                          <td className="text-sm">
                            {exam.subjects.length}
                            <span className="text-xs text-slate-500"> · {entered} with marks</span>
                          </td>
                          <td>
                            <Badge tone={exam.status === 'published' ? 'success' : 'neutral'}>
                              {exam.status}
                            </Badge>
                            {exam.publishedAt && (
                              <p className="mt-1 text-xs text-slate-500">
                                {formatDateTime(exam.publishedAt, timeZone)}
                              </p>
                            )}
                          </td>
                          <td>
                            <div className="flex flex-wrap justify-end gap-2">
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                  setSelectedExamId((current) => (current === exam.id ? '' : exam.id))
                                }
                              >
                                {selectedExamId === exam.id ? 'Close' : 'Open'}
                              </Button>
                              {canManage && exam.status === 'draft' && (
                                <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'exam', exam })}>
                                  Edit
                                </Button>
                              )}
                              {canPublish && exam.status === 'draft' ? (
                                <Button size="sm" onClick={() => setConfirming({ kind: 'publish', exam })}>
                                  Publish
                                </Button>
                              ) : canPublish ? (
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  onClick={() => setConfirming({ kind: 'unpublish', exam })}
                                >
                                  Unpublish
                                </Button>
                              ) : null}
                              {canManage && exam.status === 'draft' && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => setConfirming({ kind: 'delete', exam })}
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

          {selectedExam && (
            <ExamWorkspace
              exam={selectedExam}
              sections={sections.data?.items ?? []}
              subjects={subjects.data?.items ?? []}
              canManage={canManage}
              canRecord={canRecord}
              onRemoveSubject={(subject) =>
                setConfirming({ kind: 'remove-subject', exam: selectedExam, subject })
              }
              onChanged={invalidate}
            />
          )}
        </>
      )}

      {dialog?.kind === 'exam' && yearId && (
        <ExamDialog
          academicYearId={yearId}
          exam={dialog.exam}
          schemes={schemes.data?.items ?? []}
          onClose={() => setDialog(null)}
          onSaved={() => {
            toast.notify('success', dialog.exam ? 'Exam updated.' : 'Exam created.');
            setDialog(null);
            invalidate();
          }}
        />
      )}

      {dialog?.kind === 'scheme' && (
        <SchemeDialog
          onClose={() => setDialog(null)}
          onSaved={() => {
            toast.notify('success', 'Grading scheme created.');
            setDialog(null);
            invalidate();
          }}
        />
      )}

      <ConfirmDialog
        open={confirming !== null}
        title={confirmTitle(confirming)}
        message={confirmMessage(confirming)}
        confirmLabel={confirmLabel(confirming)}
        destructive={confirming?.kind === 'delete' || confirming?.kind === 'unpublish' || confirming?.kind === 'remove-subject'}
        busy={lifecycle.isPending}
        onConfirm={() => confirming && lifecycle.mutate(confirming)}
        onClose={() => setConfirming(null)}
      />
    </div>
  );
}

function confirmTitle(target: ConfirmTarget): string {
  if (!target) return '';
  if (target.kind === 'publish') return 'Publish results';
  if (target.kind === 'unpublish') return 'Unpublish exam';
  if (target.kind === 'delete') return 'Delete exam';
  return 'Remove subject';
}

function confirmLabel(target: ConfirmTarget): string {
  if (!target) return 'Confirm';
  if (target.kind === 'publish') return 'Publish';
  if (target.kind === 'unpublish') return 'Unpublish';
  if (target.kind === 'delete') return 'Delete exam';
  return 'Remove subject';
}

function confirmMessage(target: ConfirmTarget): ReactNode {
  if (!target) return null;
  if (target.kind === 'publish') {
    return (
      <p>
        Publish <strong>{target.exam.name}</strong>? Every exam subject needs at least one mark
        before publishing. Guardians will see the report cards immediately and marks become locked.
      </p>
    );
  }
  if (target.kind === 'unpublish') {
    return (
      <p>
        Unpublish <strong>{target.exam.name}</strong>? Guardians lose access to the results and mark
        entry reopens. This action is audited.
      </p>
    );
  }
  if (target.kind === 'delete') {
    return (
      <p>
        Delete <strong>{target.exam.name}</strong> and all of its subjects and marks? This cannot be
        undone.
      </p>
    );
  }
  return (
    <p>
      Remove <strong>{target.subject.subjectName}</strong> from{' '}
      <strong>{target.exam.name}</strong>? Subjects with recorded marks cannot be removed.
    </p>
  );
}

function SchemesPanel({
  schemes,
  loading,
  error,
  onRetry,
}: {
  schemes: GradingScheme[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}): ReactNode {
  return (
    <Card>
      <CardHeader
        title="Grading schemes"
        description="Each scheme maps percentage bands to grades. The default scheme is preselected for new exams."
      />
      {loading ? (
        <TableSkeleton rows={3} columns={4} />
      ) : error ? (
        <ErrorState message={errorMessage(error)} onRetry={onRetry} />
      ) : schemes.length === 0 ? (
        <EmptyState
          title="No grading schemes"
          description="Create a grading scheme before adding an exam."
          icon="chart"
        />
      ) : (
        <div className="space-y-4 p-5">
          {schemes.map((scheme) => (
            <div key={scheme.id} className="rounded-lg border border-slate-200 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-medium text-slate-900">
                    {scheme.name} <span className="font-mono text-xs text-slate-500">({scheme.code})</span>
                  </p>
                  <p className="text-xs text-slate-500">{scheme.bands.length} bands</p>
                </div>
                {scheme.isDefault && <Badge tone="brand">Default</Badge>}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {scheme.bands.map((band) => (
                  <span
                    key={band.id}
                    className="rounded-md bg-slate-50 px-2 py-1 text-xs text-slate-700 ring-1 ring-slate-200"
                    title={band.remark ?? undefined}
                  >
                    <strong>{band.grade}</strong> {band.minPercent}–{band.maxPercent}%
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function ExamWorkspace({
  exam,
  sections,
  subjects,
  canManage,
  canRecord,
  onRemoveSubject,
  onChanged,
}: {
  exam: ExamRecord;
  sections: Array<{ id: string; className: string; name: string }>;
  subjects: Array<{ id: string; name: string; code: string; status: string }>;
  canManage: boolean;
  canRecord: boolean;
  onRemoveSubject: (subject: ExamSubject) => void;
  onChanged: () => void;
}): ReactNode {
  const locked = exam.status === 'published';
  const [sectionId, setSectionId] = useState(sections[0]?.id ?? '');
  const [subjectId, setSubjectId] = useState(exam.subjects[0]?.id ?? '');
  const [reportStudent, setReportStudent] = useState('');
  const [reportOpen, setReportOpen] = useState(false);

  useEffect(() => {
    if (!sections.some((section) => section.id === sectionId)) {
      setSectionId(sections[0]?.id ?? '');
    }
  }, [sections, sectionId]);

  useEffect(() => {
    if (!exam.subjects.some((subject) => subject.id === subjectId)) {
      setSubjectId(exam.subjects[0]?.id ?? '');
    }
  }, [exam.subjects, subjectId]);

  const usedSubjectIds = new Set(exam.subjects.map((subject) => subject.subjectId));
  const availableSubjects = subjects.filter(
    (subject) => subject.status === 'active' && !usedSubjectIds.has(subject.id),
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title={`${exam.name} · subjects`}
          description={
            locked
              ? 'Results are published; subjects and marks are locked until you unpublish.'
              : 'Add the subjects assessed in this exam and their maximum and pass marks.'
          }
        />
        {exam.subjects.length === 0 ? (
          <EmptyState title="No subjects" description="Add at least one subject before recording marks." icon="book" />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Subject</th>
                  <th className="text-right">Max</th>
                  <th className="text-right">Pass</th>
                  <th className="text-right">Marks entered</th>
                  {canManage && !locked && <th className="text-right">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {exam.subjects.map((subject) => (
                  <tr key={subject.id}>
                    <td className="font-medium text-slate-900">
                      {subject.subjectName}{' '}
                      <span className="font-mono text-xs text-slate-500">{subject.subjectCode}</span>
                    </td>
                    <td className="text-right tabular-nums">{subject.maxMarks}</td>
                    <td className="text-right tabular-nums">{subject.passMarks}</td>
                    <td className="text-right tabular-nums">{subject.marksEntered}</td>
                    {canManage && !locked && (
                      <td>
                        <div className="flex justify-end">
                          <Button size="sm" variant="ghost" onClick={() => onRemoveSubject(subject)}>
                            Remove
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
        {canManage && !locked && (
          <AddSubjectForm examId={exam.id} subjects={availableSubjects} onSaved={onChanged} />
        )}
      </Card>

      <Card>
        <CardHeader
          title="Mark entry"
          description={
            locked
              ? 'Marks are locked because results are published. Unpublish the exam to reopen entry.'
              : 'Choose a section and subject, then enter each student result. Blank rows are left unrecorded.'
          }
        />
        {exam.subjects.length === 0 ? (
          <EmptyState title="Add a subject first" description="Marks belong to an exam subject." icon="book" />
        ) : sections.length === 0 ? (
          <EmptyState title="No sections" description="Create a section for this academic year." icon="layers" />
        ) : (
          <div className="space-y-4 p-5">
            <div className="flex flex-wrap items-end gap-4">
              <Field label="Section" htmlFor="marks-section">
                <Select
                  id="marks-section"
                  value={sectionId}
                  onChange={(event) => setSectionId(event.target.value)}
                  className="min-w-52"
                >
                  {sections.map((section) => (
                    <option key={section.id} value={section.id}>
                      {section.className} · {section.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Subject" htmlFor="marks-subject">
                <Select
                  id="marks-subject"
                  value={subjectId}
                  onChange={(event) => setSubjectId(event.target.value)}
                  className="min-w-52"
                >
                  {exam.subjects.map((subject) => (
                    <option key={subject.id} value={subject.id}>
                      {subject.subjectName} (max {subject.maxMarks})
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="flex gap-2 pb-0.5">
                <Button
                  variant="secondary"
                  onClick={() => setReportOpen(true)}
                  disabled={!sectionId}
                >
                  Report cards
                </Button>
              </div>
            </div>

            {sectionId && subjectId && (
              <MarkSheetTable
                key={`${exam.id}-${sectionId}-${subjectId}`}
                exam={exam}
                sectionId={sectionId}
                subjectId={subjectId}
                canRecord={canRecord && !locked}
                onSaved={onChanged}
              />
            )}
          </div>
        )}
      </Card>

      {reportOpen && (
        <ReportCardsDialog
          exam={exam}
          sectionId={sectionId}
          selectedStudentId={reportStudent}
          onSelectStudent={setReportStudent}
          onClose={() => setReportOpen(false)}
        />
      )}
    </div>
  );
}

function AddSubjectForm({
  examId,
  subjects,
  onSaved,
}: {
  examId: string;
  subjects: Array<{ id: string; name: string; code: string }>;
  onSaved: () => void;
}): ReactNode {
  const schoolId = useSchoolId();
  const toast = useToast();
  const [subjectId, setSubjectId] = useState(subjects[0]?.id ?? '');
  const [maxMarks, setMaxMarks] = useState('100');
  const [passMarks, setPassMarks] = useState('35');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      addExamSubject(schoolId, examId, {
        subjectId,
        maxMarks: Number(maxMarks || 0),
        passMarks: Number(passMarks || 0),
      }),
    onSuccess: () => {
      toast.notify('success', 'Subject added to exam.');
      setError(null);
      onSaved();
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setError(null);
    mutation.mutate();
  }

  if (subjects.length === 0) {
    return (
      <p className="border-t border-slate-100 px-5 py-3 text-sm text-slate-500">
        Every active subject is already part of this exam.
      </p>
    );
  }

  return (
    <form
      className="flex flex-wrap items-end gap-3 border-t border-slate-100 px-5 py-4"
      onSubmit={submit}
      noValidate
    >
      {error && (
        <div className="w-full">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
      <Field label="Add subject" htmlFor="add-subject">
        <Select
          id="add-subject"
          value={subjectId}
          onChange={(event) => setSubjectId(event.target.value)}
          className="min-w-48"
        >
          {subjects.map((subject) => (
            <option key={subject.id} value={subject.id}>
              {subject.name} ({subject.code})
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Max marks" htmlFor="add-subject-max">
        <Input
          id="add-subject-max"
          type="number"
          min={0.01}
          step="0.01"
          value={maxMarks}
          onChange={(event) => setMaxMarks(event.target.value)}
          className="w-28"
        />
      </Field>
      <Field label="Pass marks" htmlFor="add-subject-pass">
        <Input
          id="add-subject-pass"
          type="number"
          min={0}
          step="0.01"
          value={passMarks}
          onChange={(event) => setPassMarks(event.target.value)}
          className="w-28"
        />
      </Field>
      <Button type="submit" loading={mutation.isPending} disabled={!subjectId}>
        Add subject
      </Button>
    </form>
  );
}

function MarkSheetTable({
  exam,
  sectionId,
  subjectId,
  canRecord,
  onSaved,
}: {
  exam: ExamRecord;
  sectionId: string;
  subjectId: string;
  canRecord: boolean;
  onSaved: () => void;
}): ReactNode {
  const schoolId = useSchoolId();
  const toast = useToast();
  const sheet = useQuery({
    queryKey: ['mark-sheet', schoolId, exam.id, sectionId, subjectId],
    queryFn: () => getMarkSheet(schoolId, exam.id, sectionId, subjectId),
  });
  const [draft, setDraft] = useState<Record<string, { marks: string; absent: boolean }>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sheet.data) return;
    const next: Record<string, { marks: string; absent: boolean }> = {};
    for (const row of sheet.data.rows) {
      next[row.studentId] = {
        marks: row.marksObtained === null ? '' : String(row.marksObtained),
        absent: row.isAbsent,
      };
    }
    setDraft(next);
  }, [sheet.data]);

  const mutation = useMutation({
    mutationFn: (data: MarkSheet) =>
      saveMarks(schoolId, exam.id, {
        examSubjectId: data.subject.id,
        sectionId,
        entries: data.rows.map((row) => {
          const entry = draft[row.studentId] ?? { marks: '', absent: false };
          return {
            studentId: row.studentId,
            marksObtained: entry.absent || entry.marks.trim() === '' ? null : Number(entry.marks),
            isAbsent: entry.absent,
          };
        }).filter((entry) => entry.isAbsent || entry.marksObtained !== null),
      }),
    onSuccess: () => {
      toast.notify('success', 'Marks saved.');
      setError(null);
      onSaved();
      void sheet.refetch();
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  if (sheet.isPending) return <TableSkeleton rows={5} columns={5} />;
  if (sheet.isError) {
    return <ErrorState message={errorMessage(sheet.error)} onRetry={() => void sheet.refetch()} />;
  }

  const data = sheet.data;
  if (data.rows.length === 0) {
    return (
      <EmptyState
        title="No enrolled students"
        description="This section has no active students to mark."
        icon="users"
      />
    );
  }

  const save = () => mutation.mutate(data);

  return (
    <div className="space-y-3">
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="data-table">
          <thead>
            <tr>
              <th>Student</th>
              <th>Admission no.</th>
              <th className="text-right">Marks / {data.subject.maxMarks}</th>
              <th className="text-center">Absent</th>
              <th>Grade</th>
              <th>Entered by</th>
              <th className="text-right">Updated</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => {
              const entry = draft[row.studentId] ?? { marks: '', absent: false };
              return (
                <tr key={row.studentId}>
                  <td className="font-medium text-slate-900">{row.fullName}</td>
                  <td className="font-mono text-xs">{row.admissionNumber}</td>
                  <td className="text-right">
                    <Input
                      aria-label={`Marks for ${row.fullName}`}
                      type="number"
                      min={0}
                      max={data.subject.maxMarks}
                      step="0.01"
                      value={entry.marks}
                      disabled={!canRecord || entry.absent}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          [row.studentId]: { ...entry, marks: event.target.value },
                        }))
                      }
                      className="w-24 text-right"
                    />
                  </td>
                  <td className="text-center">
                    <input
                      type="checkbox"
                      aria-label={`${row.fullName} absent`}
                      className="h-4 w-4 rounded text-brand-600"
                      checked={entry.absent}
                      disabled={!canRecord}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          [row.studentId]: { ...entry, absent: event.target.checked },
                        }))
                      }
                    />
                  </td>
                  <td>
                    {row.grade ? <Badge tone="brand">{row.grade}</Badge> : <span className="text-slate-400">—</span>}
                  </td>
                  <td className="text-sm text-slate-500">{row.enteredByName ?? '—'}</td>
                  <td className="text-right text-xs text-slate-500">
                    {row.updatedAt ? formatDate(row.updatedAt) : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-slate-500">
          Passing mark for this subject is {data.subject.passMarks} of {data.subject.maxMarks}.
          {exam.status === 'published' && ' Marks are locked until the exam is unpublished.'}
        </p>
        {canRecord && (
          <Button onClick={save} loading={mutation.isPending}>
            Save marks
          </Button>
        )}
      </div>
    </div>
  );
}

function ReportCardsDialog({
  exam,
  sectionId,
  selectedStudentId,
  onSelectStudent,
  onClose,
}: {
  exam: ExamRecord;
  sectionId: string;
  selectedStudentId: string;
  onSelectStudent: (id: string) => void;
  onClose: () => void;
}): ReactNode {
  const schoolId = useSchoolId();
  const toast = useToast();
  const [downloading, setDownloading] = useState(false);
  const students = useQuery({
    queryKey: ['students', schoolId, 'report-cards', sectionId],
    queryFn: () => listStudents(schoolId, { pageSize: 100, sectionId, status: 'active' }),
  });

  const card = useQuery({
    queryKey: ['report-card', schoolId, exam.id, selectedStudentId],
    queryFn: () => getReportCard(schoolId, exam.id, selectedStudentId),
    enabled: Boolean(selectedStudentId),
  });

  async function downloadTranscript(): Promise<void> {
    if (!selectedStudentId) return;
    setDownloading(true);
    try {
      const transcript = await getStudentTranscript(
        schoolId,
        selectedStudentId,
        exam.academicYearId,
      );
      const blob = new Blob([JSON.stringify(transcript, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${transcript.admissionNumber}-transcript.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.notify('error', errorMessage(error));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={`${exam.name} · report cards`}
      description="Report cards are computed from recorded marks and the exam's grading scheme. The transcript covers every published exam in the academic year."
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="secondary"
            disabled={!selectedStudentId}
            onClick={() =>
              window.open(
                transcriptPrintUrl(schoolId, selectedStudentId, exam.academicYearId),
                '_blank',
                'noopener',
              )
            }
          >
            Print transcript
          </Button>
          <Button
            variant="secondary"
            disabled={!selectedStudentId}
            loading={downloading}
            onClick={() => void downloadTranscript()}
          >
            Transcript (JSON)
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Field label="Student" htmlFor="report-student">
          <Select
            id="report-student"
            value={selectedStudentId}
            onChange={(event) => onSelectStudent(event.target.value)}
          >
            <option value="">Choose a student</option>
            {students.data?.items.map((student) => (
              <option key={student.id} value={student.id}>
                {student.firstName} {student.lastName ?? ''} ({student.admissionNumber})
              </option>
            ))}
          </Select>
        </Field>

        {students.isError && <ErrorState message={errorMessage(students.error)} onRetry={() => void students.refetch()} />}

        {!selectedStudentId ? (
          <EmptyState title="Choose a student" description="Select a student to build their report card." icon="child" />
        ) : card.isPending ? (
          <TableSkeleton rows={4} columns={4} />
        ) : card.isError ? (
          <ErrorState message={errorMessage(card.error)} onRetry={() => void card.refetch()} />
        ) : (
          <ReportCardView card={card.data} />
        )}
      </div>
    </Dialog>
  );
}

function ReportCardView({ card }: { card: ReportCard }): ReactNode {
  const tone =
    card.result === 'pass' ? 'success' : card.result === 'fail' ? 'danger' : 'warning';
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-4 py-3">
        <div>
          <p className="font-medium text-slate-900">{card.studentName}</p>
          <p className="text-xs text-slate-500">
            {card.admissionNumber} · {[card.className, card.sectionName].filter(Boolean).join(' · ') || 'Not enrolled'}
          </p>
        </div>
        <div className="text-right">
          <Badge tone={tone}>{card.result}</Badge>
          <p className="mt-1 text-xs text-slate-500">
            {card.totalObtained} / {card.totalMax}
            {card.percentage !== null ? ` · ${card.percentage.toFixed(2)}%` : ''}
          </p>
        </div>
      </div>

      <table className="data-table">
        <thead>
          <tr>
            <th>Subject</th>
            <th className="text-right">Marks</th>
            <th className="text-right">Max</th>
            <th className="text-right">Pass</th>
            <th>Grade</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {card.subjects.map((subject) => (
            <tr key={subject.subjectId}>
              <td className="font-medium text-slate-900">{subject.subjectName}</td>
              <td className="text-right tabular-nums">
                {subject.isAbsent ? 'Absent' : (subject.marksObtained ?? '—')}
              </td>
              <td className="text-right tabular-nums">{subject.maxMarks}</td>
              <td className="text-right tabular-nums">{subject.passMarks}</td>
              <td>{subject.grade ?? '—'}</td>
              <td>
                {subject.passed === null ? (
                  <Badge tone="neutral">Not recorded</Badge>
                ) : (
                  <Badge tone={subject.passed ? 'success' : 'danger'}>
                    {subject.passed ? 'Pass' : 'Fail'}
                  </Badge>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flex flex-wrap gap-4 text-sm">
        <p>
          <span className="text-slate-500">Overall grade: </span>
          <span className="font-medium">{card.overallGrade ?? '—'}</span>
        </p>
        <p>
          <span className="text-slate-500">Percentage: </span>
          <span className="font-medium">
            {card.percentage !== null ? `${card.percentage.toFixed(2)}%` : '—'}
          </span>
        </p>
        <p>
          <span className="text-slate-500">Published: </span>
          <span className="font-medium">{formatDate(card.publishedAt)}</span>
        </p>
      </div>
      {card.result === 'incomplete' && (
        <Alert tone="warning">
          Some subjects have no recorded marks yet. The overall result will remain incomplete until
          every subject is entered.
        </Alert>
      )}
    </div>
  );
}

function ExamDialog({
  academicYearId,
  exam,
  schemes,
  onClose,
  onSaved,
}: {
  academicYearId: string;
  exam?: ExamRecord;
  schemes: GradingScheme[];
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  const schoolId = useSchoolId();
  const timeZone = useSchoolTimezone();
  const defaultScheme = schemes.find((scheme) => scheme.isDefault) ?? schemes[0];
  const [name, setName] = useState(exam?.name ?? '');
  const [examType, setExamType] = useState(exam?.examType ?? 'term');
  const [startsOn, setStartsOn] = useState(exam?.startsOn ?? todayIso(timeZone));
  const [endsOn, setEndsOn] = useState(exam?.endsOn ?? todayIso(timeZone));
  const [gradingSchemeId, setGradingSchemeId] = useState(
    exam?.gradingSchemeId ?? defaultScheme?.id ?? '',
  );
  const [passPercent, setPassPercent] = useState(String(exam?.passPercent ?? 35));
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});

  const mutation = useMutation({
    mutationFn: () => {
      const payload = {
        name,
        examType,
        startsOn,
        endsOn,
        gradingSchemeId,
        passPercent: Number(passPercent || 0),
      };
      return exam
        ? updateExam(schoolId, exam.id, payload)
        : createExam(schoolId, { academicYearId, ...payload });
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
      title={exam ? `Edit ${exam.name}` : 'New exam'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button form="exam-form" type="submit" loading={mutation.isPending} disabled={!gradingSchemeId}>
            {exam ? 'Save changes' : 'Create exam'}
          </Button>
        </>
      }
    >
      <form id="exam-form" className="space-y-4" onSubmit={submit} noValidate>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="exam-name" required error={errors.name?.[0]}>
            <Input
              id="exam-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Term 2 examination"
              required
            />
          </Field>
          <Field label="Type" htmlFor="exam-type" required error={errors.examType?.[0]}>
            <Input
              id="exam-type"
              value={examType}
              onChange={(event) => setExamType(event.target.value)}
              placeholder="term"
              required
            />
          </Field>
          <Field label="Starts on" htmlFor="exam-start" required error={errors.startsOn?.[0]}>
            <Input
              id="exam-start"
              type="date"
              value={startsOn}
              onChange={(event) => setStartsOn(event.target.value)}
              required
            />
          </Field>
          <Field label="Ends on" htmlFor="exam-end" required error={errors.endsOn?.[0]}>
            <Input
              id="exam-end"
              type="date"
              value={endsOn}
              onChange={(event) => setEndsOn(event.target.value)}
              required
            />
          </Field>
          <Field label="Grading scheme" htmlFor="exam-scheme" required error={errors.gradingSchemeId?.[0]}>
            <Select
              id="exam-scheme"
              value={gradingSchemeId}
              onChange={(event) => setGradingSchemeId(event.target.value)}
              required
            >
              {schemes.map((scheme) => (
                <option key={scheme.id} value={scheme.id}>
                  {scheme.name}
                  {scheme.isDefault ? ' (default)' : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Pass percentage" htmlFor="exam-pass" required error={errors.passPercent?.[0]}>
            <Input
              id="exam-pass"
              type="number"
              min={0}
              max={100}
              step="0.01"
              value={passPercent}
              onChange={(event) => setPassPercent(event.target.value)}
              required
            />
          </Field>
        </div>
      </form>
    </Dialog>
  );
}

interface BandDraft {
  minPercent: string;
  maxPercent: string;
  grade: string;
  remark: string;
}

const DEFAULT_BANDS: BandDraft[] = [
  { minPercent: '90', maxPercent: '100', grade: 'A+', remark: 'Outstanding' },
  { minPercent: '80', maxPercent: '89.99', grade: 'A', remark: 'Excellent' },
  { minPercent: '70', maxPercent: '79.99', grade: 'B', remark: 'Very good' },
  { minPercent: '60', maxPercent: '69.99', grade: 'C', remark: 'Good' },
  { minPercent: '50', maxPercent: '59.99', grade: 'D', remark: 'Satisfactory' },
  { minPercent: '35', maxPercent: '49.99', grade: 'E', remark: 'Needs improvement' },
  { minPercent: '0', maxPercent: '34.99', grade: 'F', remark: 'Fail' },
];

function SchemeDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }): ReactNode {
  const schoolId = useSchoolId();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [isDefault, setIsDefault] = useState(true);
  const [bands, setBands] = useState<BandDraft[]>(DEFAULT_BANDS);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});

  const mutation = useMutation({
    mutationFn: () =>
      createGradingScheme(schoolId, {
        code,
        name,
        isDefault,
        bands: bands.map((band) => ({
          minPercent: Number(band.minPercent || 0),
          maxPercent: Number(band.maxPercent || 0),
          grade: band.grade,
          remark: band.remark.trim() || undefined,
        })),
      }),
    onSuccess: onSaved,
    onError: (caught) => {
      setError(errorMessage(caught));
      setErrors(fieldErrors(caught));
    },
  });

  function updateBand(index: number, patch: Partial<BandDraft>): void {
    setBands((current) => current.map((band, i) => (i === index ? { ...band, ...patch } : band)));
  }

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
      title="New grading scheme"
      description="Bands must not overlap. Percentage ranges are inclusive of their minimum."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button form="scheme-form" type="submit" loading={mutation.isPending}>
            Create scheme
          </Button>
        </>
      }
    >
      <form id="scheme-form" className="space-y-4" onSubmit={submit} noValidate>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Code" htmlFor="scheme-code" required error={errors.code?.[0]}>
            <Input
              id="scheme-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="CBSE-2026"
              required
            />
          </Field>
          <Field label="Name" htmlFor="scheme-name" required error={errors.name?.[0]}>
            <Input
              id="scheme-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="CBSE grading 2026"
              required
            />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            className="h-4 w-4 rounded text-brand-600"
            checked={isDefault}
            onChange={(event) => setIsDefault(event.target.checked)}
          />
          Make this the default scheme for new exams
        </label>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-medium text-slate-700">Bands</p>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() =>
                setBands((current) => [...current, { minPercent: '0', maxPercent: '0', grade: '', remark: '' }])
              }
            >
              <Icon name="plus" className="h-4 w-4" />
              Add band
            </Button>
          </div>
          <div className="space-y-2">
            {bands.map((band, index) => (
              <div key={index} className="grid grid-cols-12 items-end gap-2">
                <div className="col-span-3">
                  <Field label="Min %" htmlFor={`band-min-${index}`}>
                    <Input
                      id={`band-min-${index}`}
                      type="number"
                      min={0}
                      max={100}
                      step="0.01"
                      value={band.minPercent}
                      onChange={(event) => updateBand(index, { minPercent: event.target.value })}
                    />
                  </Field>
                </div>
                <div className="col-span-3">
                  <Field label="Max %" htmlFor={`band-max-${index}`}>
                    <Input
                      id={`band-max-${index}`}
                      type="number"
                      min={0}
                      max={100}
                      step="0.01"
                      value={band.maxPercent}
                      onChange={(event) => updateBand(index, { maxPercent: event.target.value })}
                    />
                  </Field>
                </div>
                <div className="col-span-2">
                  <Field label="Grade" htmlFor={`band-grade-${index}`}>
                    <Input
                      id={`band-grade-${index}`}
                      value={band.grade}
                      onChange={(event) => updateBand(index, { grade: event.target.value })}
                    />
                  </Field>
                </div>
                <div className="col-span-3">
                  <Field label="Remark" htmlFor={`band-remark-${index}`}>
                    <Input
                      id={`band-remark-${index}`}
                      value={band.remark}
                      onChange={(event) => updateBand(index, { remark: event.target.value })}
                    />
                  </Field>
                </div>
                <div className="col-span-1 pb-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove band ${index + 1}`}
                    disabled={bands.length === 1}
                    onClick={() => setBands((current) => current.filter((_, i) => i !== index))}
                  >
                    <Icon name="close" className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
        {errors.bands && <Alert tone="danger">{errors.bands[0]}</Alert>}
        <p className="text-xs text-slate-500">
          Amounts are percentages of the total maximum marks for an exam.
        </p>
      </form>
    </Dialog>
  );
}
