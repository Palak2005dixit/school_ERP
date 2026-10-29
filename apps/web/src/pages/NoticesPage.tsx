import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { NoticeRecord } from '@erp/shared';
import { useAuth, useSchoolId, useSchoolTimezone } from '../auth/AuthContext';
import {
  createNotice,
  deleteNotice,
  deleteNoticeAttachment,
  listNotices,
  markNoticeRead,
  noticeAttachmentUrl,
  updateNotice,
  uploadNoticeAttachment,
} from '../lib/endpoints';
import { errorMessage, fieldErrors } from '../lib/api';
import { formatBytes, formatDate, formatDateTime } from '../lib/format';
import { ConfirmDialog, Dialog } from '../components/Dialog';
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
  Textarea,
  cn,
} from '../components/ui';

const AUDIENCES = ['all', 'staff', 'parents', 'students'] as const;
const STATUSES = ['draft', 'published', 'archived'] as const;

type Tab = 'published' | 'draft' | 'archived' | 'all';
type DialogState = { kind: 'notice'; notice?: NoticeRecord } | null;
type ConfirmTarget =
  | { kind: 'delete'; notice: NoticeRecord }
  | { kind: 'publish'; notice: NoticeRecord }
  | { kind: 'archive'; notice: NoticeRecord }
  | { kind: 'unpublish'; notice: NoticeRecord }
  | null;

export function NoticesPage(): ReactNode {
  const schoolId = useSchoolId();
  const timeZone = useSchoolTimezone();
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const canManage = can('notices.manage');

  const [tab, setTab] = useState<Tab>(canManage ? 'published' : 'all');
  const [dialog, setDialog] = useState<DialogState>(null);
  const [confirming, setConfirming] = useState<ConfirmTarget>(null);

  const status = tab === 'all' ? undefined : tab;
  const notices = useQuery({
    queryKey: ['notices', schoolId, status ?? 'all'],
    queryFn: () => listNotices(schoolId, status),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['notices', schoolId] });
  };

  const markRead = useMutation({
    mutationFn: (noticeId: string) => markNoticeRead(schoolId, noticeId),
    onSuccess: invalidate,
    onError: (error) => toast.notify('error', errorMessage(error)),
  });

  const lifecycle = useMutation({
    mutationFn: async (target: NonNullable<ConfirmTarget>) => {
      if (target.kind === 'delete') await deleteNotice(schoolId, target.notice.id);
      else if (target.kind === 'publish') {
        await updateNotice(schoolId, target.notice.id, { status: 'published' });
      } else if (target.kind === 'archive') {
        await updateNotice(schoolId, target.notice.id, { status: 'archived' });
      } else {
        await updateNotice(schoolId, target.notice.id, { status: 'draft' });
      }
    },
    onSuccess: (_result, target) => {
      toast.notify('success', lifecycleMessage(target.kind));
      setConfirming(null);
      invalidate();
    },
    onError: (error) => {
      setConfirming(null);
      toast.notify('error', errorMessage(error));
    },
  });

  const tabs: Array<[Tab, string]> = canManage
    ? [
        ['published', 'Published'],
        ['draft', 'Drafts'],
        ['archived', 'Archived'],
        ['all', 'All'],
      ]
    : [['all', 'Notices']];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Notice board"
        description="Audience-scoped announcements. Drafts are only visible to people who manage notices; parents and students only ever see published, unexpired notices addressed to them."
        actions={
          canManage ? (
            <Button onClick={() => setDialog({ kind: 'notice' })}>
              <Icon name="plus" className="h-4 w-4" />
              New notice
            </Button>
          ) : undefined
        }
      />

      {canManage && (
        <div className="flex gap-1 border-b border-slate-200" role="tablist" aria-label="Notice status">
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
      )}

      {notices.isPending ? (
        <Card>
          <TableSkeleton rows={5} columns={4} />
        </Card>
      ) : notices.isError ? (
        <Card>
          <ErrorState message={errorMessage(notices.error)} onRetry={() => void notices.refetch()} />
        </Card>
      ) : notices.data.items.length === 0 ? (
        <Card>
          <EmptyState
            title={tab === 'all' ? 'No notices published' : `No ${tab} notices`}
            description={
              canManage
                ? 'Write a notice and publish it to the selected audience.'
                : 'Nothing has been posted for you yet.'
            }
            icon="clipboard"
            action={
              canManage ? (
                <Button size="sm" onClick={() => setDialog({ kind: 'notice' })}>
                  New notice
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <div className="space-y-4">
          {notices.data.items.map((notice) => (
            <Card key={notice.id} className="p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    {notice.pinned && <Badge tone="brand">Pinned</Badge>}
                    <h2 className="text-base font-semibold text-slate-900">{notice.title}</h2>
                    <Badge tone={notice.audience === 'all' ? 'info' : 'neutral'}>
                      {notice.audience}
                    </Badge>
                    {canManage && (
                      <Badge
                        tone={
                          notice.status === 'published'
                            ? 'success'
                            : notice.status === 'archived'
                              ? 'neutral'
                              : 'warning'
                        }
                      >
                        {notice.status}
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {notice.publishedAt
                      ? `Published ${formatDateTime(notice.publishedAt, timeZone)}`
                      : `Created ${formatDateTime(notice.createdAt, timeZone)}`}
                    {notice.createdByName && ` · ${notice.createdByName}`}
                    {notice.expiresOn && ` · Expires ${formatDate(notice.expiresOn)}`}
                  </p>
                </div>
                {canManage && (
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'notice', notice })}>
                      Edit
                    </Button>
                    {notice.status !== 'published' && (
                      <Button size="sm" onClick={() => setConfirming({ kind: 'publish', notice })}>
                        Publish
                      </Button>
                    )}
                    {notice.status === 'published' && (
                      <>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setConfirming({ kind: 'unpublish', notice })}
                        >
                          Unpublish
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setConfirming({ kind: 'archive', notice })}
                        >
                          Archive
                        </Button>
                      </>
                    )}
                    {notice.status !== 'published' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirming({ kind: 'delete', notice })}
                      >
                        Delete
                      </Button>
                    )}
                  </div>
                )}
              </div>
              <p className="mt-3 whitespace-pre-line text-sm text-slate-700">{notice.body}</p>
              {notice.attachments.length > 0 && (
                <ul className="mt-3 flex flex-wrap gap-2" aria-label="Attachments">
                  {notice.attachments.map((attachment) => (
                    <li key={attachment.id}>
                      <a
                        href={noticeAttachmentUrl(schoolId, notice.id, attachment.id)}
                        className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-brand-700 hover:border-brand-300"
                        download={attachment.filename}
                      >
                        <Icon name="download" className="h-3.5 w-3.5" />
                        {attachment.filename}
                        <span className="text-slate-400">{formatBytes(attachment.byteSize)}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-slate-500">
                {canManage && notice.readCount !== null && (
                  <span>
                    Read by {notice.readCount} {notice.readCount === 1 ? 'person' : 'people'}
                  </span>
                )}
                {!canManage &&
                  (notice.readByMe ? (
                    <Badge tone="success">Read</Badge>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={markRead.isPending && markRead.variables === notice.id}
                      onClick={() => markRead.mutate(notice.id)}
                    >
                      Mark as read
                    </Button>
                  ))}
              </div>
            </Card>
          ))}
        </div>
      )}

      {dialog?.kind === 'notice' && (
        <NoticeDialog
          notice={dialog.notice}
          onClose={() => setDialog(null)}
          onSaved={() => {
            toast.notify(
              'success',
              dialog.notice ? 'Notice updated.' : 'Draft created. Publish it when ready.',
            );
            setDialog(null);
            invalidate();
          }}
        />
      )}

      <ConfirmDialog
        open={confirming !== null}
        title={
          confirming?.kind === 'delete'
            ? 'Delete notice'
            : confirming?.kind === 'publish'
              ? 'Publish notice'
              : confirming?.kind === 'archive'
                ? 'Archive notice'
                : 'Unpublish notice'
        }
        message={confirming ? confirmMessage(confirming) : null}
        confirmLabel={confirming ? lifecycleLabel(confirming.kind) : 'Confirm'}
        destructive={confirming?.kind === 'delete' || confirming?.kind === 'unpublish'}
        busy={lifecycle.isPending}
        onConfirm={() => confirming && lifecycle.mutate(confirming)}
        onClose={() => setConfirming(null)}
      />
    </div>
  );
}

function lifecycleMessage(kind: NonNullable<ConfirmTarget>['kind']): string {
  if (kind === 'publish') return 'Notice published.';
  if (kind === 'archive') return 'Notice archived.';
  if (kind === 'unpublish') return 'Notice returned to draft.';
  return 'Notice deleted.';
}

function lifecycleLabel(kind: NonNullable<ConfirmTarget>['kind']): string {
  if (kind === 'publish') return 'Publish';
  if (kind === 'archive') return 'Archive';
  if (kind === 'unpublish') return 'Unpublish';
  return 'Delete';
}

function confirmMessage(target: NonNullable<ConfirmTarget>): ReactNode {
  if (target.kind === 'delete') {
    return (
      <p>
        Delete <strong>{target.notice.title}</strong>? Drafts and archived notices can be deleted;
        published notices must be archived first.
      </p>
    );
  }
  if (target.kind === 'publish') {
    return (
      <p>
        Publish <strong>{target.notice.title}</strong> to <strong>{target.notice.audience}</strong>?
        It becomes visible immediately.
      </p>
    );
  }
  if (target.kind === 'archive') {
    return (
      <p>
        Archive <strong>{target.notice.title}</strong>? It disappears from audience feeds but stays
        available to managers.
      </p>
    );
  }
  return (
    <p>
      Move <strong>{target.notice.title}</strong> back to draft? It will no longer be visible to its
      audience.
    </p>
  );
}

function NoticeDialog({
  notice,
  onClose,
  onSaved,
}: {
  notice?: NoticeRecord;
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  const schoolId = useSchoolId();
  const [title, setTitle] = useState(notice?.title ?? '');
  const [body, setBody] = useState(notice?.body ?? '');
  const [audience, setAudience] = useState<NoticeRecord['audience']>(notice?.audience ?? 'all');
  const [pinned, setPinned] = useState(notice?.pinned ?? false);
  const [expiresOn, setExpiresOn] = useState(notice?.expiresOn ?? '');
  const [status, setStatus] = useState<NoticeRecord['status']>(notice?.status ?? 'draft');
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});

  const mutation = useMutation({
    mutationFn: () => {
      const payload = {
        title,
        body,
        audience,
        pinned,
        expiresOn: expiresOn || null,
      };
      if (!notice) return createNotice(schoolId, payload);
      return updateNotice(schoolId, notice.id, {
        ...payload,
        status,
      });
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
      title={notice ? 'Edit notice' : 'New notice'}
      description="New notices start as drafts. Publishing is a separate, audited action."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button form="notice-form" type="submit" loading={mutation.isPending}>
            {notice ? 'Save changes' : 'Save draft'}
          </Button>
        </>
      }
    >
      <form id="notice-form" className="space-y-4" onSubmit={submit} noValidate>
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Title" htmlFor="notice-title" required error={errors.title?.[0]}>
          <Input
            id="notice-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Parent-teacher meeting"
            required
          />
        </Field>
        <Field label="Notice text" htmlFor="notice-body" required error={errors.body?.[0]}>
          <Textarea
            id="notice-body"
            rows={7}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Write the announcement…"
            required
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Audience" htmlFor="notice-audience" required error={errors.audience?.[0]}>
            <Select
              id="notice-audience"
              value={audience}
              onChange={(event) => setAudience(event.target.value as NoticeRecord['audience'])}
            >
              {AUDIENCES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Expires on" htmlFor="notice-expires" error={errors.expiresOn?.[0]}>
            <Input
              id="notice-expires"
              type="date"
              value={expiresOn}
              onChange={(event) => setExpiresOn(event.target.value)}
            />
          </Field>
          {notice && (
            <Field label="Status" htmlFor="notice-status">
              <Select
                id="notice-status"
                value={status}
                onChange={(event) => setStatus(event.target.value as NoticeRecord['status'])}
              >
                {STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            className="h-4 w-4 rounded text-brand-600"
            checked={pinned}
            onChange={(event) => setPinned(event.target.checked)}
          />
          Pin to the top of the notice board
        </label>
        {notice ? (
          <NoticeAttachments notice={notice} />
        ) : (
          <p className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-500">
            Save the draft first to attach files.
          </p>
        )}
      </form>
    </Dialog>
  );
}

function NoticeAttachments({ notice }: { notice: NoticeRecord }): ReactNode {
  const schoolId = useSchoolId();
  const queryClient = useQueryClient();
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['notices', schoolId] });
  };

  const remove = useMutation({
    mutationFn: (attachmentId: string) => deleteNoticeAttachment(schoolId, notice.id, attachmentId),
    onSuccess: () => {
      toast.notify('success', 'Attachment removed.');
      invalidate();
    },
    onError: (error) => toast.notify('error', errorMessage(error)),
  });

  async function upload(file: File): Promise<void> {
    if (file.size > 1024 * 1024) {
      toast.notify('error', 'Attachments must be 1 MiB or smaller.');
      return;
    }
    setBusy(true);
    try {
      const dataBase64 = await fileToBase64(file);
      await uploadNoticeAttachment(schoolId, notice.id, {
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
        dataBase64,
      });
      toast.notify('success', 'Attachment uploaded.');
      invalidate();
    } catch (caught) {
      toast.notify('error', errorMessage(caught));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <div className="space-y-2 rounded-md border border-slate-200 p-3">
      <p className="text-sm font-medium text-slate-700">Attachments</p>
      {notice.attachments.length === 0 ? (
        <p className="text-xs text-slate-500">No files attached yet.</p>
      ) : (
        <ul className="space-y-2">
          {notice.attachments.map((attachment) => (
            <li key={attachment.id} className="flex items-center justify-between gap-2 text-sm">
              <a
                href={noticeAttachmentUrl(schoolId, notice.id, attachment.id)}
                download={attachment.filename}
                className="inline-flex min-w-0 items-center gap-2 text-brand-700 hover:underline"
              >
                <Icon name="paperclip" className="h-4 w-4 shrink-0" />
                <span className="truncate">{attachment.filename}</span>
                <span className="shrink-0 text-xs text-slate-400">
                  {formatBytes(attachment.byteSize)}
                </span>
              </a>
              <Button
                size="sm"
                variant="ghost"
                loading={remove.isPending && remove.variables === attachment.id}
                onClick={() => remove.mutate(attachment.id)}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          className="block w-full text-xs text-slate-600 file:mr-2 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-slate-700"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file);
          }}
          disabled={busy}
        />
        {busy && <span className="text-xs text-slate-500">Uploading�</span>}
      </div>
      <p className="text-xs text-slate-400">Up to 1 MiB per file. Uploads are audited.</p>
    </div>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
    reader.readAsDataURL(file);
  });
}
