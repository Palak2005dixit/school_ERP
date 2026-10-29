import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import type {
  HomeworkAssignment,
  HomeworkSubmission,
  LearningResource,
} from '@erp/shared';
import { useAuth, useSchoolId } from '../auth/AuthContext';
import {
  createHomework,
  createLearningResource,
  createQuestion,
  deleteLearningAttachment,
  deleteQuestion,
  learningAttachmentUrl,
  listAcademicYears,
  listChildren,
  listClasses,
  listHomework,
  listHomeworkSubmissions,
  listLearningResources,
  listQuestionBank,
  listSections,
  listSubjects,
  reviewHomeworkSubmission,
  setHomeworkStatus,
  submitHomework,
  updateLearningResource,
  uploadLearningAttachment,
} from '../lib/endpoints';
import { errorMessage } from '../lib/api';
import { formatBytes, formatDateTime, todayIso } from '../lib/format';
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

type Tab = 'resources' | 'homework' | 'questions';

const RESOURCE_TYPES = ['document', 'link', 'video', 'audio', 'image', 'other'] as const;
const RESOURCE_STATUSES = ['draft', 'published', 'archived'] as const;
const VISIBILITIES = ['all', 'staff', 'students', 'parents'] as const;
const HOMEWORK_STATUSES = ['draft', 'published', 'closed'] as const;
const QUESTION_TYPES = [
  'short_answer',
  'long_answer',
  'multiple_choice',
  'true_false',
  'practical',
] as const;
const DIFFICULTIES = ['easy', 'medium', 'hard'] as const;

type DialogState =
  | { kind: 'resource'; resource?: LearningResource }
  | { kind: 'homework' }
  | { kind: 'submissions'; homework: HomeworkAssignment }
  | { kind: 'review'; submission: HomeworkSubmission }
  | { kind: 'submit'; homework: HomeworkAssignment }
  | { kind: 'question' }
  | null;

export function LearningPage(): ReactNode {
  const schoolId = useSchoolId();
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();

  const canView = can('learning.view');
  const canManage = can('learning.manage');
  const canGrade = can('learning.grade');
  const canSubmit = can('learning.submit');

  const [tab, setTab] = useState<Tab>('resources');
  const [resourceStatus, setResourceStatus] = useState('');
  const [resourceType, setResourceType] = useState('');
  const [resourceClass, setResourceClass] = useState('');
  const [homeworkStatus, setHomeworkStatusFilter] = useState('');
  const [homeworkSection, setHomeworkSection] = useState('');
  const [questionSubject, setQuestionSubject] = useState('');
  const [questionDifficulty, setQuestionDifficulty] = useState('');
  const [dialog, setDialog] = useState<DialogState>(null);
  const [formError, setFormError] = useState('');

  const subjects = useQuery({
    queryKey: ['subjects', schoolId],
    queryFn: () => listSubjects(schoolId),
    enabled: canView,
  });
  const classes = useQuery({
    queryKey: ['classes', schoolId],
    queryFn: () => listClasses(schoolId),
    enabled: canView,
  });
  const academicYears = useQuery({
    queryKey: ['academic-years', schoolId],
    queryFn: () => listAcademicYears(schoolId),
    enabled: canView && canManage,
  });
  const sections = useQuery({
    queryKey: ['sections', schoolId],
    queryFn: () => listSections(schoolId),
    enabled: canView && canManage,
  });
  const children = useQuery({
    queryKey: ['portal-children', schoolId],
    queryFn: () => listChildren(schoolId),
    enabled: canView && canSubmit && !canManage && !canGrade,
  });

  const resources = useQuery({
    queryKey: ['learning-resources', schoolId, resourceStatus, resourceType, resourceClass],
    queryFn: () =>
      listLearningResources(schoolId, {
        status: resourceStatus || undefined,
        resourceType: resourceType || undefined,
        classId: resourceClass || undefined,
      }),
    enabled: canView && tab === 'resources',
  });
  const homework = useQuery({
    queryKey: ['learning-homework', schoolId, homeworkStatus, homeworkSection],
    queryFn: () =>
      listHomework(schoolId, {
        status: homeworkStatus || undefined,
        sectionId: homeworkSection || undefined,
      }),
    enabled: canView && tab === 'homework',
  });
  const questions = useQuery({
    queryKey: ['learning-questions', schoolId, questionSubject, questionDifficulty],
    queryFn: () =>
      listQuestionBank(schoolId, {
        subjectId: questionSubject || undefined,
        difficulty: questionDifficulty || undefined,
      }),
    enabled: canView && tab === 'questions',
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['learning-resources', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['learning-homework', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['learning-questions', schoolId] });
  };

  const saveResource = useMutation({
    mutationFn: (input: { id?: string; body: Record<string, unknown> }) =>
      input.id
        ? updateLearningResource(schoolId, input.id, input.body)
        : createLearningResource(schoolId, input.body),
    onSuccess: () => {
      toast.notify('success', 'Resource saved.');
      setDialog(null);
      invalidate();
    },
    onError: (error) => setFormError(errorMessage(error)),
  });
  const saveHomework = useMutation({
    mutationFn: (input: Parameters<typeof createHomework>[1]) => createHomework(schoolId, input),
    onSuccess: () => {
      toast.notify('success', 'Homework created. Publish it when you are ready.');
      setDialog(null);
      invalidate();
    },
    onError: (error) => setFormError(errorMessage(error)),
  });
  const changeHomeworkStatus = useMutation({
    mutationFn: (input: { id: string; status: (typeof HOMEWORK_STATUSES)[number] }) =>
      setHomeworkStatus(schoolId, input.id, input.status),
    onSuccess: () => {
      toast.notify('success', 'Homework updated.');
      invalidate();
    },
    onError: (error) => toast.notify('error', errorMessage(error)),
  });
  const review = useMutation({
    mutationFn: (input: {
      id: string;
      body: { status: 'reviewed' | 'returned'; marks?: number | null; feedback?: string };
    }) => reviewHomeworkSubmission(schoolId, input.id, input.body),
    onSuccess: () => {
      toast.notify('success', 'Submission reviewed.');
      setDialog(null);
      invalidate();
    },
    onError: (error) => setFormError(errorMessage(error)),
  });
  const submit = useMutation({
    mutationFn: (input: { assignmentId: string; body: Parameters<typeof submitHomework>[2] }) =>
      submitHomework(schoolId, input.assignmentId, input.body),
    onSuccess: () => {
      toast.notify('success', 'Homework submitted.');
      setDialog(null);
      invalidate();
    },
    onError: (error) => setFormError(errorMessage(error)),
  });
  const saveQuestion = useMutation({
    mutationFn: (input: Parameters<typeof createQuestion>[1]) => createQuestion(schoolId, input),
    onSuccess: () => {
      toast.notify('success', 'Question added.');
      setDialog(null);
      invalidate();
    },
    onError: (error) => setFormError(errorMessage(error)),
  });
  const removeQuestion = useMutation({
    mutationFn: (id: string) => deleteQuestion(schoolId, id),
    onSuccess: () => {
      toast.notify('success', 'Question removed.');
      invalidate();
    },
    onError: (error) => toast.notify('error', errorMessage(error)),
  });

  const subjectOptions = subjects.data?.items ?? [];
  const classOptions = classes.data?.items ?? [];
  const sectionOptions = sections.data?.items ?? [];
  const yearOptions = academicYears.data?.items ?? [];
  const activeYear = yearOptions.find((year) => year.status === 'active') ?? yearOptions[0];
  const childOptions = (children.data?.items ?? []).map((child) => ({
    id: child.studentId,
    name: child.fullName,
    section: [child.className, child.sectionName].filter(Boolean).join(' · '),
  }));

  const tabs: Array<{ value: Tab; label: string }> = [
    { value: 'resources', label: 'Resources' },
    { value: 'homework', label: 'Homework' },
    ...(canManage ? [{ value: 'questions' as Tab, label: 'Question bank' }] : []),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Learning"
        description="Published learning resources, homework and the question bank. Families only see resources and homework for their linked sections."
        actions={
          canManage ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => setDialog({ kind: 'resource' })}>
                <Icon name="book" className="h-4 w-4" />
                New resource
              </Button>
              <Button onClick={() => setDialog({ kind: 'homework' })}>
                <Icon name="clipboard" className="h-4 w-4" />
                New homework
              </Button>
            </div>
          ) : undefined
        }
      />

      <Tabs value={tab} onChange={setTab} tabs={tabs} label="Learning views" />

      {tab === 'resources' && canView && (
        <Card>
          <CardHeader
            title="Learning resources"
            description="Draft and archived resources are only visible to staff. Links open in a new tab; files are downloaded through the API with an audit record."
            actions={
              <div className="flex flex-wrap gap-2">
                <Select
                  aria-label="Filter resources by status"
                  value={resourceStatus}
                  onChange={(event) => setResourceStatus(event.target.value)}
                  className="w-36"
                >
                  <option value="">All statuses</option>
                  {RESOURCE_STATUSES.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </Select>
                <Select
                  aria-label="Filter resources by type"
                  value={resourceType}
                  onChange={(event) => setResourceType(event.target.value)}
                  className="w-32"
                >
                  <option value="">All types</option>
                  {RESOURCE_TYPES.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </Select>
                <Select
                  aria-label="Filter resources by class"
                  value={resourceClass}
                  onChange={(event) => setResourceClass(event.target.value)}
                  className="w-40"
                >
                  <option value="">All classes</option>
                  {classOptions.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name}
                    </option>
                  ))}
                </Select>
              </div>
            }
          />
          {resources.isPending ? (
            <TableSkeleton rows={6} columns={5} />
          ) : resources.isError ? (
            <ErrorState
              message={errorMessage(resources.error)}
              onRetry={() => void resources.refetch()}
            />
          ) : (resources.data?.items.length ?? 0) === 0 ? (
            <EmptyState
              title="No resources"
              description="Add a document, link or media resource for a class or subject."
              icon="book"
            />
          ) : (
            <div className="divide-y divide-slate-100">
              {resources.data!.items.map((resource) => (
                <div key={resource.id} className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium text-slate-900">{resource.title}</p>
                        <Badge tone={resource.status === 'published' ? 'success' : 'neutral'}>
                          {resource.status}
                        </Badge>
                        <Badge tone="info">{resource.resourceType}</Badge>
                        <Badge tone="neutral">
                          {resource.visibility === 'all' ? 'everyone' : resource.visibility}
                        </Badge>
                      </div>
                      <p className="mt-1 text-xs text-slate-500">
                        {[resource.className, resource.subjectName].filter(Boolean).join(' · ') ||
                          'Whole school'}
                        {resource.createdByName ? ` · ${resource.createdByName}` : ''}
                      </p>
                      {resource.description && (
                        <p className="mt-2 line-clamp-3 text-sm text-slate-600">
                          {resource.description}
                        </p>
                      )}
                      <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
                        {resource.url && (
                          <a
                            href={resource.url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-brand-700 hover:underline"
                          >
                            Open link
                          </a>
                        )}
                        {resource.attachments.map((attachment) => (
                          <span key={attachment.id} className="inline-flex items-center gap-2">
                            <a
                              href={learningAttachmentUrl(schoolId, attachment.id)}
                              className="inline-flex items-center gap-1 text-brand-700 hover:underline"
                              download
                            >
                              <Icon name="paperclip" className="h-3.5 w-3.5" />
                              {attachment.filename}
                            </a>
                            <span className="text-xs text-slate-400">
                              {formatBytes(attachment.byteSize)}
                            </span>
                            {canManage && (
                              <button
                                type="button"
                                className="text-xs text-rose-600 hover:underline"
                                onClick={() =>
                                  deleteLearningAttachment(schoolId, attachment.id)
                                    .then(() => {
                                      toast.notify('success', 'Attachment removed.');
                                      invalidate();
                                    })
                                    .catch((error: unknown) =>
                                      toast.notify('error', errorMessage(error)),
                                    )
                                }
                              >
                                Remove
                              </button>
                            )}
                          </span>
                        ))}
                      </div>
                    </div>
                    {canManage && (
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDialog({ kind: 'resource', resource })}
                        >
                          Edit
                        </Button>
                        <AttachmentButton
                          onUpload={async (input) => {
                            await uploadLearningAttachment(schoolId, resource.id, input);
                            toast.notify('success', 'Attachment uploaded.');
                            invalidate();
                          }}
                          onError={(message) => toast.notify('error', message)}
                        />
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {tab === 'homework' && canView && (
        <Card>
          <CardHeader
            title="Homework"
            description="Homework must be published before families can submit. Late submissions are recorded as late; resubmission follows the assignment setting."
            actions={
              <div className="flex flex-wrap gap-2">
                <Select
                  aria-label="Filter homework by status"
                  value={homeworkStatus}
                  onChange={(event) => setHomeworkStatusFilter(event.target.value)}
                  className="w-36"
                >
                  <option value="">All statuses</option>
                  {HOMEWORK_STATUSES.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </Select>
                {canManage && (
                  <Select
                    aria-label="Filter homework by section"
                    value={homeworkSection}
                    onChange={(event) => setHomeworkSection(event.target.value)}
                    className="w-44"
                  >
                    <option value="">All sections</option>
                    {sectionOptions.map((section) => (
                      <option key={section.id} value={section.id}>
                        {section.className} · {section.name}
                      </option>
                    ))}
                  </Select>
                )}
              </div>
            }
          />
          {homework.isPending ? (
            <TableSkeleton rows={6} columns={6} />
          ) : homework.isError ? (
            <ErrorState
              message={errorMessage(homework.error)}
              onRetry={() => void homework.refetch()}
            />
          ) : (homework.data?.items.length ?? 0) === 0 ? (
            <EmptyState
              title="No homework"
              description="Create homework, then publish it for families and students."
              icon="clipboard"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Homework</th>
                    <th>Class</th>
                    <th>Subject</th>
                    <th>Due</th>
                    <th className="text-right">Submissions</th>
                    <th>Status</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {homework.data!.items.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <p className="font-medium text-slate-900">{row.title}</p>
                        <p className="text-xs text-slate-500">
                          {row.allowResubmission ? 'Resubmission allowed' : 'One submission'}
                          {row.maxMarks !== null ? ` · ${row.maxMarks} marks` : ''}
                        </p>
                      </td>
                      <td className="text-sm text-slate-600">
                        {row.className} · {row.sectionName}
                      </td>
                      <td className="text-sm text-slate-600">{row.subjectName}</td>
                      <td className="text-sm text-slate-600">{formatDateTime(row.dueAt)}</td>
                      <td className="text-right tabular-nums">
                        {row.submissionCount}
                        {row.gradedCount > 0 ? ` (${row.gradedCount} graded)` : ''}
                      </td>
                      <td>
                        <Badge
                          tone={
                            row.status === 'published'
                              ? 'success'
                              : row.status === 'closed'
                                ? 'neutral'
                                : 'warning'
                          }
                        >
                          {row.status}
                        </Badge>
                      </td>
                      <td>
                        <div className="flex flex-wrap justify-end gap-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setDialog({ kind: 'submissions', homework: row })}
                          >
                            Submissions
                          </Button>
                          {canManage && row.status === 'draft' && (
                            <Button
                              size="sm"
                              onClick={() =>
                                changeHomeworkStatus.mutate({ id: row.id, status: 'published' })
                              }
                            >
                              Publish
                            </Button>
                          )}
                          {canManage && row.status === 'published' && (
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() =>
                                changeHomeworkStatus.mutate({ id: row.id, status: 'closed' })
                              }
                            >
                              Close
                            </Button>
                          )}
                          {canManage && row.status === 'closed' && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                changeHomeworkStatus.mutate({ id: row.id, status: 'published' })
                              }
                            >
                              Reopen
                            </Button>
                          )}
                          {canSubmit && !canManage && !canGrade && row.status === 'published' && (
                            <Button size="sm" onClick={() => setDialog({ kind: 'submit', homework: row })}>
                              Submit
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

      {tab === 'questions' && canView && canManage && (
        <Card>
          <CardHeader
            title="Question bank"
            description="Reusable questions by subject, type and difficulty. Questions are internal staff material."
            actions={
              <div className="flex flex-wrap gap-2">
                <Select
                  aria-label="Filter questions by subject"
                  value={questionSubject}
                  onChange={(event) => setQuestionSubject(event.target.value)}
                  className="w-44"
                >
                  <option value="">All subjects</option>
                  {subjectOptions.map((subject) => (
                    <option key={subject.id} value={subject.id}>
                      {subject.name}
                    </option>
                  ))}
                </Select>
                <Select
                  aria-label="Filter questions by difficulty"
                  value={questionDifficulty}
                  onChange={(event) => setQuestionDifficulty(event.target.value)}
                  className="w-36"
                >
                  <option value="">All difficulties</option>
                  {DIFFICULTIES.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </Select>
                <Button size="sm" onClick={() => setDialog({ kind: 'question' })}>
                  New question
                </Button>
              </div>
            }
          />
          {questions.isPending ? (
            <TableSkeleton rows={6} columns={5} />
          ) : questions.isError ? (
            <ErrorState
              message={errorMessage(questions.error)}
              onRetry={() => void questions.refetch()}
            />
          ) : (questions.data?.items.length ?? 0) === 0 ? (
            <EmptyState
              title="No questions"
              description="Add questions for reuse in papers and revision."
              icon="clipboard"
            />
          ) : (
            <div className="divide-y divide-slate-100">
              {questions.data!.items.map((question) => (
                <div key={question.id} className="flex flex-wrap items-start justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="info">{question.subjectName}</Badge>
                      <Badge tone="neutral">{question.questionType}</Badge>
                      <Badge
                        tone={
                          question.difficulty === 'easy'
                            ? 'success'
                            : question.difficulty === 'hard'
                              ? 'danger'
                              : 'warning'
                        }
                      >
                        {question.difficulty}
                      </Badge>
                      {question.marks !== null && (
                        <span className="text-xs text-slate-500">{question.marks} marks</span>
                      )}
                    </div>
                    <p className="mt-2 whitespace-pre-wrap text-sm text-slate-800">
                      {question.questionText}
                    </p>
                    {question.answerText && (
                      <p className="mt-1 whitespace-pre-wrap text-xs text-slate-500">
                        Answer: {question.answerText}
                      </p>
                    )}
                    {question.topic && (
                      <p className="mt-1 text-xs text-slate-400">Topic: {question.topic}</p>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={removeQuestion.isPending}
                    onClick={() => removeQuestion.mutate(question.id)}
                  >
                    Delete
                  </Button>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {dialog?.kind === 'resource' && (
        <ResourceDialog
          key={dialog.resource?.id ?? 'new-resource'}
          resource={dialog.resource}
          subjects={subjectOptions}
          classes={classOptions}
          error={formError}
          saving={saveResource.isPending}
          onClose={() => {
            setDialog(null);
            setFormError('');
          }}
          onSave={(body) => saveResource.mutate({ id: dialog.resource?.id, body })}
        />
      )}

      {dialog?.kind === 'homework' && (
        <HomeworkDialog
          years={yearOptions.map((year) => ({ id: year.id, name: year.name }))}
          defaultYearId={activeYear?.id ?? ''}
          sections={sectionOptions.map((section) => ({
            id: section.id,
            name: `${section.className} · ${section.name}`,
          }))}
          subjects={subjectOptions.map((subject) => ({ id: subject.id, name: subject.name }))}
          error={formError}
          saving={saveHomework.isPending}
          onClose={() => {
            setDialog(null);
            setFormError('');
          }}
          onSave={(body) => saveHomework.mutate(body)}
        />
      )}

      {dialog?.kind === 'submissions' && (
        <SubmissionsDialog
          schoolId={schoolId}
          homework={dialog.homework}
          canGrade={canGrade}
          canSubmit={canSubmit && !canManage && !canGrade}
          children={childOptions}
          onReview={(submission) => {
            setFormError('');
            setDialog({ kind: 'review', submission });
          }}
          onOpenSubmit={() => setDialog({ kind: 'submit', homework: dialog.homework })}
          onClose={() => setDialog(null)}
        />
      )}

      {dialog?.kind === 'review' && (
        <ReviewDialog
          submission={dialog.submission}
          error={formError}
          saving={review.isPending}
          onClose={() => {
            setDialog(null);
            setFormError('');
          }}
          onSave={(body) => review.mutate({ id: dialog.submission.id, body })}
        />
      )}

      {dialog?.kind === 'submit' && (
        <SubmitDialog
          homework={dialog.homework}
          children={childOptions}
          error={formError}
          saving={submit.isPending}
          onClose={() => {
            setDialog(null);
            setFormError('');
          }}
          onSave={(body) => submit.mutate({ assignmentId: dialog.homework.id, body })}
        />
      )}

      {dialog?.kind === 'question' && (
        <QuestionDialog
          subjects={subjectOptions.map((subject) => ({ id: subject.id, name: subject.name }))}
          error={formError}
          saving={saveQuestion.isPending}
          onClose={() => {
            setDialog(null);
            setFormError('');
          }}
          onSave={(body) => saveQuestion.mutate(body)}
        />
      )}
    </div>
  );
}

function AttachmentButton({
  onUpload,
  onError,
}: {
  onUpload: (input: { filename: string; contentType: string; dataBase64: string }) => Promise<void>;
  onError: (message: string) => void;
}): ReactNode {
  const [busy, setBusy] = useState(false);
  return (
    <label className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
      <Icon name="paperclip" className="h-3.5 w-3.5" />
      {busy ? 'Uploading…' : 'Attach file'}
      <input
        type="file"
        className="sr-only"
        disabled={busy}
        onChange={async (event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (!file) return;
          setBusy(true);
          try {
            await onUpload({
              filename: file.name,
              contentType: file.type || 'application/octet-stream',
              dataBase64: await fileToBase64(file),
            });
          } catch (error) {
            onError(errorMessage(error));
          } finally {
            setBusy(false);
          }
        }}
      />
    </label>
  );
}

function ResourceDialog({
  resource,
  subjects,
  classes,
  error,
  saving,
  onClose,
  onSave,
}: {
  resource?: LearningResource;
  subjects: Array<{ id: string; name: string }>;
  classes: Array<{ id: string; name: string }>;
  error: string;
  saving: boolean;
  onClose: () => void;
  onSave: (body: Record<string, unknown>) => void;
}): ReactNode {
  const [title, setTitle] = useState(resource?.title ?? '');
  const [description, setDescription] = useState(resource?.description ?? '');
  const [resourceType, setResourceType] = useState<(typeof RESOURCE_TYPES)[number]>(
    resource?.resourceType ?? 'document',
  );
  const [subjectId, setSubjectId] = useState(resource?.subjectId ?? '');
  const [classId, setClassId] = useState(resource?.classId ?? '');
  const [url, setUrl] = useState(resource?.url ?? '');
  const [visibility, setVisibility] = useState<(typeof VISIBILITIES)[number]>(
    resource?.visibility ?? 'all',
  );
  const [status, setStatus] = useState<(typeof RESOURCE_STATUSES)[number]>(
    resource?.status ?? 'draft',
  );

  return (
    <Dialog
      open
      onClose={onClose}
      title={resource ? 'Edit resource' : 'New resource'}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="resource-form" loading={saving}>
            Save resource
          </Button>
        </>
      }
    >
      <form
        id="resource-form"
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({
            title,
            description: description || undefined,
            resourceType,
            subjectId: subjectId || null,
            classId: classId || null,
            url: url || undefined,
            visibility,
            status,
          });
        }}
      >
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Title" htmlFor="res-title" required>
          <Input id="res-title" value={title} onChange={(event) => setTitle(event.target.value)} required />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Type" htmlFor="res-type">
            <Select
              id="res-type"
              value={resourceType}
              onChange={(event) => setResourceType(event.target.value as typeof resourceType)}
            >
              {RESOURCE_TYPES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Visibility" htmlFor="res-visibility">
            <Select
              id="res-visibility"
              value={visibility}
              onChange={(event) => setVisibility(event.target.value as typeof visibility)}
            >
              {VISIBILITIES.map((value) => (
                <option key={value} value={value}>
                  {value === 'all' ? 'Everyone' : value}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Class" htmlFor="res-class">
            <Select id="res-class" value={classId} onChange={(event) => setClassId(event.target.value)}>
              <option value="">Whole school</option>
              {classes.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Subject" htmlFor="res-subject">
            <Select
              id="res-subject"
              value={subjectId}
              onChange={(event) => setSubjectId(event.target.value)}
            >
              <option value="">No subject</option>
              {subjects.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Status" htmlFor="res-status">
            <Select
              id="res-status"
              value={status}
              onChange={(event) => setStatus(event.target.value as typeof status)}
            >
              {RESOURCE_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Link" htmlFor="res-url" hint="Optional. Use a full https:// address.">
          <Input
            id="res-url"
            type="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://"
          />
        </Field>
        <Field label="Description" htmlFor="res-description">
          <Textarea
            id="res-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={4000}
          />
        </Field>
        {resource && (
          <p className="text-xs text-slate-500">
            Upload files from the resource list after saving. Attachments are limited to 1 MB each.
          </p>
        )}
      </form>
    </Dialog>
  );
}

function HomeworkDialog({
  years,
  defaultYearId,
  sections,
  subjects,
  error,
  saving,
  onClose,
  onSave,
}: {
  years: Array<{ id: string; name: string }>;
  defaultYearId: string;
  sections: Array<{ id: string; name: string }>;
  subjects: Array<{ id: string; name: string }>;
  error: string;
  saving: boolean;
  onClose: () => void;
  onSave: (body: {
    academicYearId: string;
    sectionId: string;
    subjectId: string;
    title: string;
    instructions: string;
    availableFrom?: string | null;
    dueAt: string;
    maxMarks?: number | null;
    allowResubmission?: boolean;
  }) => void;
}): ReactNode {
  const [academicYearId, setAcademicYearId] = useState(defaultYearId);
  const [sectionId, setSectionId] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [title, setTitle] = useState('');
  const [instructions, setInstructions] = useState('');
  const [availableFrom, setAvailableFrom] = useState(todayIso());
  const [dueAt, setDueAt] = useState('');
  const [maxMarks, setMaxMarks] = useState('');
  const [allowResubmission, setAllowResubmission] = useState(false);

  return (
    <Dialog
      open
      onClose={onClose}
      title="New homework"
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="homework-form" loading={saving}>
            Create homework
          </Button>
        </>
      }
    >
      <form
        id="homework-form"
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({
            academicYearId,
            sectionId,
            subjectId,
            title,
            instructions,
            availableFrom: availableFrom || null,
            dueAt: new Date(dueAt).toISOString(),
            maxMarks: maxMarks ? Number(maxMarks) : null,
            allowResubmission,
          });
        }}
      >
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Academic year" htmlFor="hw-year" required>
            <Select
              id="hw-year"
              value={academicYearId}
              onChange={(event) => setAcademicYearId(event.target.value)}
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
          <Field label="Section" htmlFor="hw-section" required>
            <Select
              id="hw-section"
              value={sectionId}
              onChange={(event) => setSectionId(event.target.value)}
              required
            >
              <option value="">Select section</option>
              {sections.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Subject" htmlFor="hw-subject" required>
            <Select
              id="hw-subject"
              value={subjectId}
              onChange={(event) => setSubjectId(event.target.value)}
              required
            >
              <option value="">Select subject</option>
              {subjects.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Available from" htmlFor="hw-available">
            <Input
              id="hw-available"
              type="date"
              value={availableFrom}
              onChange={(event) => setAvailableFrom(event.target.value)}
            />
          </Field>
        </div>
        <Field label="Title" htmlFor="hw-title" required>
          <Input id="hw-title" value={title} onChange={(event) => setTitle(event.target.value)} required />
        </Field>
        <Field label="Instructions" htmlFor="hw-instructions" required>
          <Textarea
            id="hw-instructions"
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            maxLength={10000}
            required
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Due at" htmlFor="hw-due" required>
            <Input
              id="hw-due"
              type="datetime-local"
              value={dueAt}
              onChange={(event) => setDueAt(event.target.value)}
              required
            />
          </Field>
          <Field label="Maximum marks" htmlFor="hw-marks" hint="Leave blank for ungraded homework.">
            <Input
              id="hw-marks"
              type="number"
              min={1}
              max={1000}
              value={maxMarks}
              onChange={(event) => setMaxMarks(event.target.value)}
            />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={allowResubmission}
            onChange={(event) => setAllowResubmission(event.target.checked)}
            className="h-4 w-4 rounded border-slate-300"
          />
          Allow resubmission
        </label>
      </form>
    </Dialog>
  );
}

function SubmissionsDialog({
  schoolId,
  homework,
  canGrade,
  canSubmit,
  children,
  onReview,
  onOpenSubmit,
  onClose,
}: {
  schoolId: string;
  homework: HomeworkAssignment;
  canGrade: boolean;
  canSubmit: boolean;
  children: Array<{ id: string; name: string; section: string }>;
  onReview: (submission: HomeworkSubmission) => void;
  onOpenSubmit: () => void;
  onClose: () => void;
}): ReactNode {
  const [studentId, setStudentId] = useState('');
  const submissions = useQuery({
    queryKey: ['homework-submissions', schoolId, homework.id, studentId],
    queryFn: () => listHomeworkSubmissions(schoolId, homework.id, studentId || undefined),
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Submissions · ${homework.title}`}
      description={`${homework.className} · ${homework.sectionName} · ${homework.subjectName}`}
      size="lg"
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <Field label="Filter by student" htmlFor="sub-student">
            <Select
              id="sub-student"
              value={studentId}
              onChange={(event) => setStudentId(event.target.value)}
              className="w-64"
            >
              <option value="">All submissions</option>
              {children.map((child) => (
                <option key={child.id} value={child.id}>
                  {child.name}
                </option>
              ))}
            </Select>
          </Field>
          {canSubmit && children.length > 0 && homework.status === 'published' && (
            <Button size="sm" onClick={onOpenSubmit}>
              Submit homework
            </Button>
          )}
        </div>
        {submissions.isPending ? (
          <TableSkeleton rows={5} columns={5} />
        ) : submissions.isError ? (
          <ErrorState
            message={errorMessage(submissions.error)}
            onRetry={() => void submissions.refetch()}
          />
        ) : (submissions.data?.items.length ?? 0) === 0 ? (
          <p className="text-sm text-slate-500">
            No submissions yet. Students submit after the homework is published.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Student</th>
                  <th className="text-right">Attempt</th>
                  <th>Submitted</th>
                  <th>Status</th>
                  <th className="text-right">Marks</th>
                  <th>Feedback</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {submissions.data!.items.map((row) => (
                  <tr key={row.id}>
                    <td className="font-medium text-slate-900">{row.studentName}</td>
                    <td className="text-right tabular-nums">{row.attempt}</td>
                    <td className="text-sm text-slate-600">{formatDateTime(row.submittedAt)}</td>
                    <td>
                      <Badge
                        tone={
                          row.status === 'reviewed'
                            ? 'success'
                            : row.status === 'returned'
                              ? 'warning'
                              : row.status === 'late'
                                ? 'danger'
                                : 'info'
                        }
                      >
                        {row.status}
                      </Badge>
                    </td>
                    <td className="text-right tabular-nums">
                      {row.marks ?? '—'}
                      {homework.maxMarks !== null ? ` / ${homework.maxMarks}` : ''}
                    </td>
                    <td className="max-w-xs text-sm text-slate-600">
                      {row.feedback ?? '—'}
                      {row.attachmentName && (
                        <p className="mt-1 text-xs text-slate-500">
                          Attachment: {row.attachmentName}
                        </p>
                      )}
                      {row.content && (
                        <p className="mt-1 line-clamp-2 text-xs text-slate-500">{row.content}</p>
                      )}
                    </td>
                    <td className="text-right">
                      {canGrade && (
                        <Button size="sm" variant="ghost" onClick={() => onReview(row)}>
                          Review
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function ReviewDialog({
  submission,
  error,
  saving,
  onClose,
  onSave,
}: {
  submission: HomeworkSubmission;
  error: string;
  saving: boolean;
  onClose: () => void;
  onSave: (body: { status: 'reviewed' | 'returned'; marks?: number | null; feedback?: string }) => void;
}): ReactNode {
  const [status, setStatus] = useState<'reviewed' | 'returned'>(
    submission.status === 'returned' ? 'returned' : 'reviewed',
  );
  const [marks, setMarks] = useState(submission.marks === null ? '' : String(submission.marks));
  const [feedback, setFeedback] = useState(submission.feedback ?? '');

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Review · ${submission.studentName}`}
      description={`Attempt ${submission.attempt} · submitted ${formatDateTime(submission.submittedAt)}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="review-form" loading={saving}>
            Save review
          </Button>
        </>
      }
    >
      <form
        id="review-form"
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({
            status,
            marks: marks === '' ? null : Number(marks),
            feedback: feedback || undefined,
          });
        }}
      >
        {error && <Alert tone="danger">{error}</Alert>}
        {submission.content && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm whitespace-pre-wrap text-slate-700">
            {submission.content}
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Decision" htmlFor="review-status">
            <Select
              id="review-status"
              value={status}
              onChange={(event) => setStatus(event.target.value as typeof status)}
            >
              <option value="reviewed">Reviewed</option>
              <option value="returned">Returned for revision</option>
            </Select>
          </Field>
          <Field label="Marks" htmlFor="review-marks">
            <Input
              id="review-marks"
              type="number"
              min={0}
              step="0.01"
              value={marks}
              onChange={(event) => setMarks(event.target.value)}
            />
          </Field>
        </div>
        <Field label="Feedback" htmlFor="review-feedback">
          <Textarea
            id="review-feedback"
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            maxLength={4000}
          />
        </Field>
      </form>
    </Dialog>
  );
}

function SubmitDialog({
  homework,
  children,
  error,
  saving,
  onClose,
  onSave,
}: {
  homework: HomeworkAssignment;
  children: Array<{ id: string; name: string; section: string }>;
  error: string;
  saving: boolean;
  onClose: () => void;
  onSave: (body: {
    studentId: string;
    content?: string;
    attachmentName?: string;
    attachmentType?: string;
    attachmentBase64?: string;
  }) => void;
}): ReactNode {
  const [studentId, setStudentId] = useState(children[0]?.id ?? '');
  const [content, setContent] = useState('');
  const [file, setFile] = useState<File | null>(null);

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Submit · ${homework.title}`}
      description={`Due ${formatDateTime(homework.dueAt)}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="submit-form" loading={saving} disabled={!studentId}>
            Submit
          </Button>
        </>
      }
    >
      <form
        id="submit-form"
        className="space-y-4"
        onSubmit={async (event) => {
          event.preventDefault();
          const attachment = file
            ? {
                attachmentName: file.name,
                attachmentType: file.type || 'application/octet-stream',
                attachmentBase64: await fileToBase64(file),
              }
            : {};
          onSave({ studentId, content: content || undefined, ...attachment });
        }}
      >
        {error && <Alert tone="danger">{error}</Alert>}
        {children.length === 0 ? (
          <Alert tone="warning">
            No linked student was found for your account, so this homework cannot be submitted here.
          </Alert>
        ) : (
          <Field label="Student" htmlFor="submit-student" required>
            <Select
              id="submit-student"
              value={studentId}
              onChange={(event) => setStudentId(event.target.value)}
              required
            >
              {children.map((child) => (
                <option key={child.id} value={child.id}>
                  {child.name}
                  {child.section ? ` · ${child.section}` : ''}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Answer" htmlFor="submit-content">
          <Textarea
            id="submit-content"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            maxLength={10000}
          />
        </Field>
        <Field label="Attachment" htmlFor="submit-file" hint="Optional. Maximum 1 MB.">
          <input
            id="submit-file"
            type="file"
            className="block w-full text-sm text-slate-600"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
        </Field>
      </form>
    </Dialog>
  );
}

function QuestionDialog({
  subjects,
  error,
  saving,
  onClose,
  onSave,
}: {
  subjects: Array<{ id: string; name: string }>;
  error: string;
  saving: boolean;
  onClose: () => void;
  onSave: (body: {
    subjectId: string;
    topic?: string;
    questionType?: string;
    difficulty?: string;
    questionText: string;
    answerText?: string;
    marks?: number | null;
  }) => void;
}): ReactNode {
  const [subjectId, setSubjectId] = useState('');
  const [topic, setTopic] = useState('');
  const [questionType, setQuestionType] = useState<(typeof QUESTION_TYPES)[number]>('short_answer');
  const [difficulty, setDifficulty] = useState<(typeof DIFFICULTIES)[number]>('medium');
  const [questionText, setQuestionText] = useState('');
  const [answerText, setAnswerText] = useState('');
  const [marks, setMarks] = useState('');

  return (
    <Dialog
      open
      onClose={onClose}
      title="New question"
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="question-form" loading={saving}>
            Add question
          </Button>
        </>
      }
    >
      <form
        id="question-form"
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({
            subjectId,
            topic: topic || undefined,
            questionType,
            difficulty,
            questionText,
            answerText: answerText || undefined,
            marks: marks ? Number(marks) : null,
          });
        }}
      >
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Subject" htmlFor="q-subject" required>
            <Select
              id="q-subject"
              value={subjectId}
              onChange={(event) => setSubjectId(event.target.value)}
              required
            >
              <option value="">Select subject</option>
              {subjects.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Topic" htmlFor="q-topic">
            <Input id="q-topic" value={topic} onChange={(event) => setTopic(event.target.value)} />
          </Field>
          <Field label="Question type" htmlFor="q-type">
            <Select
              id="q-type"
              value={questionType}
              onChange={(event) => setQuestionType(event.target.value as typeof questionType)}
            >
              {QUESTION_TYPES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Difficulty" htmlFor="q-difficulty">
            <Select
              id="q-difficulty"
              value={difficulty}
              onChange={(event) => setDifficulty(event.target.value as typeof difficulty)}
            >
              {DIFFICULTIES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Question" htmlFor="q-text" required>
          <Textarea
            id="q-text"
            value={questionText}
            onChange={(event) => setQuestionText(event.target.value)}
            maxLength={10000}
            required
          />
        </Field>
        <Field label="Answer" htmlFor="q-answer">
          <Textarea
            id="q-answer"
            value={answerText}
            onChange={(event) => setAnswerText(event.target.value)}
            maxLength={10000}
          />
        </Field>
        <Field label="Marks" htmlFor="q-marks">
          <Input
            id="q-marks"
            type="number"
            min={0.01}
            step="0.01"
            value={marks}
            onChange={(event) => setMarks(event.target.value)}
            className="w-32"
          />
        </Field>
      </form>
    </Dialog>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Error('The file could not be read'));
    reader.readAsDataURL(file);
  });
}
