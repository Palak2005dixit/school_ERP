import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import type { ImportRow, SavedReport } from '@erp/shared';
import { useAuth, useSchoolId } from '../auth/AuthContext';
import {
  cancelImport,
  commitImport,
  createSavedReport,
  deleteSavedReport,
  getImport,
  listAcademicYears,
  listImports,
  listSavedReports,
  listSections,
  previewImport,
  reportExportUrl,
  updateSavedReport,
} from '../lib/endpoints';
import { errorMessage } from '../lib/api';
import { formatDateTime } from '../lib/format';
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
  LinkButton,
  PageHeader,
  Select,
  TableSkeleton,
  Textarea,
} from '../components/ui';

type Tab = 'saved' | 'imports';

const REPORT_TYPES = ['students', 'attendance', 'fees'] as const;
const ENTITY_TYPES = ['students', 'library_books', 'vendors'] as const;
const IMPORT_STATUSES = ['previewed', 'committed', 'cancelled'] as const;

type SavedDialog =
  | { kind: 'saved'; report?: SavedReport }
  | { kind: 'import' }
  | { kind: 'batch'; id: string }
  | null;

export function DataToolsPage(): ReactNode {
  const schoolId = useSchoolId();
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();

  const canSaved = can('reports.saved.manage');
  const canImport = can('imports.manage');

  const [tab, setTab] = useState<Tab>('saved');
  const [importStatus, setImportStatus] = useState('');
  const [importEntity, setImportEntity] = useState('');
  const [dialog, setDialog] = useState<SavedDialog>(null);
  const [formError, setFormError] = useState('');

  const saved = useQuery({
    queryKey: ['saved-reports', schoolId],
    queryFn: () => listSavedReports(schoolId),
    enabled: canSaved && tab === 'saved',
  });
  const imports = useQuery({
    queryKey: ['imports', schoolId, importStatus, importEntity],
    queryFn: () =>
      listImports(schoolId, {
        status: importStatus || undefined,
        entityType: importEntity || undefined,
      }),
    enabled: canImport && tab === 'imports',
  });
  const years = useQuery({
    queryKey: ['academic-years', schoolId],
    queryFn: () => listAcademicYears(schoolId),
    enabled: canSaved && tab === 'saved',
  });
  const sections = useQuery({
    queryKey: ['sections', schoolId],
    queryFn: () => listSections(schoolId),
    enabled: canSaved && tab === 'saved',
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['saved-reports', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['imports', schoolId] });
    void queryClient.invalidateQueries({ queryKey: ['import', schoolId] });
  };

  const saveSaved = useMutation({
    mutationFn: (input: {
      id?: string;
      body: Parameters<typeof createSavedReport>[1];
    }) =>
      input.id
        ? updateSavedReport(schoolId, input.id, input.body)
        : createSavedReport(schoolId, input.body),
    onSuccess: () => {
      toast.notify('success', 'Saved view saved.');
      setDialog(null);
      invalidate();
    },
    onError: (error) => setFormError(errorMessage(error)),
  });
  const removeSaved = useMutation({
    mutationFn: (id: string) => deleteSavedReport(schoolId, id),
    onSuccess: () => {
      toast.notify('success', 'Saved view deleted.');
      invalidate();
    },
    onError: (error) => toast.notify('error', errorMessage(error)),
  });
  const preview = useMutation({
    mutationFn: (input: Parameters<typeof previewImport>[1]) => previewImport(schoolId, input),
    onSuccess: (result) => {
      toast.notify(
        'success',
        `Preview ready: ${result.validRows} valid, ${result.invalidRows} invalid.`,
      );
      setDialog({ kind: 'batch', id: result.id });
      invalidate();
    },
    onError: (error) => setFormError(errorMessage(error)),
  });
  const commit = useMutation({
    mutationFn: (id: string) => commitImport(schoolId, id),
    onSuccess: (result) => {
      toast.notify('success', `Import committed: ${result.created} records created.`);
      invalidate();
    },
    onError: (error) => toast.notify('error', errorMessage(error)),
  });
  const cancel = useMutation({
    mutationFn: (id: string) => cancelImport(schoolId, id),
    onSuccess: () => {
      toast.notify('success', 'Import cancelled.');
      invalidate();
    },
    onError: (error) => toast.notify('error', errorMessage(error)),
  });

  const yearOptions = years.data?.items ?? [];
  const sectionOptions = sections.data?.items ?? [];
  const tabs: Array<{ value: Tab; label: string }> = [
    ...(canSaved ? [{ value: 'saved' as Tab, label: 'Saved report views' }] : []),
    ...(canImport ? [{ value: 'imports' as Tab, label: 'CSV imports' }] : []),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Saved views & data tools"
        description="Saved views store a name and filters; results and exports are recomputed by the report endpoints. CSV imports are previewed first so every row is validated before anything is written."
        actions={
          <div className="flex flex-wrap gap-2">
            {canSaved && (
              <Button variant="secondary" onClick={() => setDialog({ kind: 'saved' })}>
                <Icon name="plus" className="h-4 w-4" />
                New saved view
              </Button>
            )}
            {canImport && (
              <Button onClick={() => setDialog({ kind: 'import' })}>
                <Icon name="paperclip" className="h-4 w-4" />
                Import CSV
              </Button>
            )}
          </div>
        }
      />

      <Tabs value={tab} onChange={setTab} tabs={tabs} label="Data tools views" />

      {tab === 'saved' && canSaved && (
        <Card>
          <CardHeader
            title="Saved report views"
            description="Shared views are visible to other staff with the saved-reports permission. Downloading runs the current report with the saved filters."
          />
          {saved.isPending ? (
            <TableSkeleton rows={5} columns={5} />
          ) : saved.isError ? (
            <ErrorState message={errorMessage(saved.error)} onRetry={() => void saved.refetch()} />
          ) : (saved.data?.items.length ?? 0) === 0 ? (
            <EmptyState
              title="No saved views"
              description="Save a set of report filters to reuse them later."
              icon="clipboard"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Report</th>
                    <th>Filters</th>
                    <th>Sharing</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {saved.data!.items.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <p className="font-medium text-slate-900">{row.name}</p>
                        <p className="text-xs text-slate-500">
                          {row.createdByName ?? 'Unknown'} · {formatDateTime(row.createdAt)}
                        </p>
                      </td>
                      <td>
                        <Badge tone="info">{row.reportType}</Badge>
                      </td>
                      <td className="text-xs text-slate-600">
                        {describeFilters(row, yearOptions, sectionOptions)}
                      </td>
                      <td>
                        <Badge tone={row.shared ? 'success' : 'neutral'}>
                          {row.shared ? 'shared' : 'private'}
                        </Badge>
                      </td>
                      <td>
                        <div className="flex flex-wrap justify-end gap-2">
                          <LinkButton
                            size="sm"
                            variant="ghost"
                            href={reportExportUrl(schoolId, row.reportType, {
                              from: row.filters.from,
                              to: row.filters.to,
                              academicYearId: row.filters.academicYearId,
                              sectionId: row.filters.sectionId,
                            })}
                          >
                            Download CSV
                          </LinkButton>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setDialog({ kind: 'saved', report: row })}
                          >
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            loading={removeSaved.isPending}
                            onClick={() => removeSaved.mutate(row.id)}
                          >
                            Delete
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

      {tab === 'imports' && canImport && (
        <Card>
          <CardHeader
            title="Import batches"
            description="Batches stay previewed until they are committed. Commit is all or nothing for the valid rows, and a committed or cancelled batch can never be re-applied."
            actions={
              <div className="flex flex-wrap gap-2">
                <Select
                  aria-label="Filter imports by status"
                  value={importStatus}
                  onChange={(event) => setImportStatus(event.target.value)}
                  className="w-36"
                >
                  <option value="">All statuses</option>
                  {IMPORT_STATUSES.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </Select>
                <Select
                  aria-label="Filter imports by entity"
                  value={importEntity}
                  onChange={(event) => setImportEntity(event.target.value)}
                  className="w-40"
                >
                  <option value="">All entities</option>
                  {ENTITY_TYPES.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </Select>
              </div>
            }
          />
          {imports.isPending ? (
            <TableSkeleton rows={5} columns={6} />
          ) : imports.isError ? (
            <ErrorState
              message={errorMessage(imports.error)}
              onRetry={() => void imports.refetch()}
            />
          ) : (imports.data?.items.length ?? 0) === 0 ? (
            <EmptyState
              title="No imports"
              description="Upload a CSV to preview and validate it."
              icon="paperclip"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Entity</th>
                    <th className="text-right">Rows</th>
                    <th className="text-right">Valid</th>
                    <th className="text-right">Invalid</th>
                    <th>Status</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {imports.data!.items.map((row) => (
                    <tr key={row.id}>
                      <td className="max-w-xs truncate text-sm text-slate-700">{row.filename}</td>
                      <td>
                        <Badge tone="info">{row.entityType}</Badge>
                      </td>
                      <td className="text-right tabular-nums">{row.totalRows}</td>
                      <td className="text-right tabular-nums">{row.validRows}</td>
                      <td className="text-right tabular-nums">{row.invalidRows}</td>
                      <td>
                        <Badge
                          tone={
                            row.status === 'committed'
                              ? 'success'
                              : row.status === 'cancelled'
                                ? 'neutral'
                                : 'warning'
                          }
                        >
                          {row.status}
                        </Badge>
                        {row.status === 'committed' && (
                          <p className="mt-1 text-xs text-slate-500">
                            {row.createdRows} created
                          </p>
                        )}
                      </td>
                      <td>
                        <div className="flex flex-wrap justify-end gap-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setDialog({ kind: 'batch', id: row.id })}
                          >
                            Preview
                          </Button>
                          {row.status === 'previewed' && (
                            <>
                              <Button
                                size="sm"
                                loading={commit.isPending}
                                disabled={row.validRows === 0}
                                onClick={() => commit.mutate(row.id)}
                              >
                                Commit
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                loading={cancel.isPending}
                                onClick={() => cancel.mutate(row.id)}
                              >
                                Cancel
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
      )}

      {dialog?.kind === 'saved' && (
        <SavedViewDialog
          key={dialog.report?.id ?? 'new-saved-view'}
          report={dialog.report}
          years={yearOptions.map((year) => ({ id: year.id, name: year.name }))}
          sections={sectionOptions.map((section) => ({
            id: section.id,
            name: `${section.className} · ${section.name}`,
          }))}
          error={formError}
          saving={saveSaved.isPending}
          onClose={() => {
            setDialog(null);
            setFormError('');
          }}
          onSave={(body) => saveSaved.mutate({ id: dialog.report?.id, body })}
        />
      )}

      {dialog?.kind === 'import' && (
        <ImportDialog
          error={formError}
          saving={preview.isPending}
          onClose={() => {
            setDialog(null);
            setFormError('');
          }}
          onSave={(body) => preview.mutate(body)}
        />
      )}

      {dialog?.kind === 'batch' && (
        <BatchDialog
          schoolId={schoolId}
          batchId={dialog.id}
          canCommit={canImport}
          committing={commit.isPending}
          cancelling={cancel.isPending}
          onCommit={(id) => commit.mutate(id)}
          onCancel={(id) => cancel.mutate(id)}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

function describeFilters(
  report: SavedReport,
  years: Array<{ id: string; name: string }>,
  sections: Array<{ id: string; className: string; name: string }>,
): string {
  const parts: string[] = [];
  if (report.filters.academicYearId) {
    const year = years.find((entry) => entry.id === report.filters.academicYearId);
    parts.push(year ? year.name : 'year');
  }
  if (report.filters.sectionId) {
    const section = sections.find((entry) => entry.id === report.filters.sectionId);
    parts.push(section ? `${section.className} · ${section.name}` : 'section');
  }
  if (report.filters.from) parts.push(`from ${report.filters.from}`);
  if (report.filters.to) parts.push(`to ${report.filters.to}`);
  return parts.length === 0 ? 'No filters' : parts.join(' · ');
}

function SavedViewDialog({
  report,
  years,
  sections,
  error,
  saving,
  onClose,
  onSave,
}: {
  report?: SavedReport;
  years: Array<{ id: string; name: string }>;
  sections: Array<{ id: string; name: string }>;
  error: string;
  saving: boolean;
  onClose: () => void;
  onSave: (body: Parameters<typeof createSavedReport>[1]) => void;
}): ReactNode {
  const [name, setName] = useState(report?.name ?? '');
  const [reportType, setReportType] = useState<(typeof REPORT_TYPES)[number]>(
    report?.reportType ?? 'students',
  );
  const [academicYearId, setAcademicYearId] = useState(report?.filters.academicYearId ?? '');
  const [sectionId, setSectionId] = useState(report?.filters.sectionId ?? '');
  const [from, setFrom] = useState(report?.filters.from ?? '');
  const [to, setTo] = useState(report?.filters.to ?? '');
  const [shared, setShared] = useState(report?.shared ?? false);

  return (
    <Dialog
      open
      onClose={onClose}
      title={report ? 'Edit saved view' : 'New saved view'}
      description="Only filters supported by the chosen report can be saved; the server rejects anything else."
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="saved-view-form" loading={saving}>
            Save view
          </Button>
        </>
      }
    >
      <form
        id="saved-view-form"
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          const filters: Record<string, string> = {};
          if (academicYearId) filters.academicYearId = academicYearId;
          if (sectionId) filters.sectionId = sectionId;
          if (reportType === 'attendance') {
            if (from) filters.from = from;
            if (to) filters.to = to;
          }
          onSave({ name, reportType, filters, shared });
        }}
      >
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="saved-name" required>
            <Input
              id="saved-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </Field>
          <Field label="Report" htmlFor="saved-type" required>
            <Select
              id="saved-type"
              value={reportType}
              onChange={(event) => setReportType(event.target.value as typeof reportType)}
            >
              {REPORT_TYPES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Academic year" htmlFor="saved-year">
            <Select
              id="saved-year"
              value={academicYearId}
              onChange={(event) => setAcademicYearId(event.target.value)}
            >
              <option value="">All years</option>
              {years.map((year) => (
                <option key={year.id} value={year.id}>
                  {year.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Section" htmlFor="saved-section">
            <Select
              id="saved-section"
              value={sectionId}
              onChange={(event) => setSectionId(event.target.value)}
            >
              <option value="">All sections</option>
              {sections.map((section) => (
                <option key={section.id} value={section.id}>
                  {section.name}
                </option>
              ))}
            </Select>
          </Field>
          {reportType === 'attendance' && (
            <>
              <Field label="From" htmlFor="saved-from">
                <Input
                  id="saved-from"
                  type="date"
                  value={from}
                  onChange={(event) => setFrom(event.target.value)}
                />
              </Field>
              <Field label="To" htmlFor="saved-to">
                <Input
                  id="saved-to"
                  type="date"
                  value={to}
                  onChange={(event) => setTo(event.target.value)}
                />
              </Field>
            </>
          )}
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={shared}
            onChange={(event) => setShared(event.target.checked)}
            className="h-4 w-4 rounded border-slate-300"
          />
          Share with other staff who can manage saved views
        </label>
      </form>
    </Dialog>
  );
}

function ImportDialog({
  error,
  saving,
  onClose,
  onSave,
}: {
  error: string;
  saving: boolean;
  onClose: () => void;
  onSave: (body: Parameters<typeof previewImport>[1]) => void;
}): ReactNode {
  const [entityType, setEntityType] = useState<(typeof ENTITY_TYPES)[number]>('students');
  const [csv, setCsv] = useState('');

  return (
    <Dialog
      open
      onClose={onClose}
      title="Preview CSV import"
      description="Nothing is written until you commit the preview. Choose a file or paste CSV text."
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="import-form" loading={saving} disabled={!csv.trim()}>
            Preview rows
          </Button>
        </>
      }
    >
      <form
        id="import-form"
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({ entityType, filename: `${entityType}-import.csv`, csv });
        }}
      >
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Entity" htmlFor="import-entity" required>
          <Select
            id="import-entity"
            value={entityType}
            onChange={(event) => setEntityType(event.target.value as typeof entityType)}
          >
            {ENTITY_TYPES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
        </Field>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
          {entityType === 'students' && (
            <p>
              Required columns: <code>first_name</code>, <code>class_name</code>,{' '}
              <code>section_name</code>. Students are enrolled into the active academic year.
            </p>
          )}
          {entityType === 'library_books' && (
            <p>
              Required column: <code>title</code>. Optional columns include author, isbn,
              category and copies.
            </p>
          )}
          {entityType === 'vendors' && <p>Required column: name.</p>}
        </div>
        <Field label="CSV file" htmlFor="import-file" hint="The file is read locally and sent as text.">
          <input
            id="import-file"
            type="file"
            accept=".csv,text/csv"
            className="block w-full text-sm text-slate-600"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              setCsv(await file.text());
            }}
          />
        </Field>
        <Field label="CSV content" htmlFor="import-csv" required>
          <Textarea
            id="import-csv"
            value={csv}
            onChange={(event) => setCsv(event.target.value)}
            rows={8}
            className="font-mono text-xs"
            required
          />
        </Field>
      </form>
    </Dialog>
  );
}

function BatchDialog({
  schoolId,
  batchId,
  canCommit,
  committing,
  cancelling,
  onCommit,
  onCancel,
  onClose,
}: {
  schoolId: string;
  batchId: string;
  canCommit: boolean;
  committing: boolean;
  cancelling: boolean;
  onCommit: (id: string) => void;
  onCancel: (id: string) => void;
  onClose: () => void;
}): ReactNode {
  const detail = useQuery({
    queryKey: ['import', schoolId, batchId],
    queryFn: () => getImport(schoolId, batchId),
  });

  const batch = detail.data;

  return (
    <Dialog
      open
      onClose={onClose}
      title={batch ? `Import · ${batch.filename}` : 'Import batch'}
      description={batch ? `${batch.entityType} · ${batch.status}` : undefined}
      size="lg"
      footer={
        batch && batch.status === 'previewed' && canCommit ? (
          <>
            <Button
              variant="secondary"
              loading={cancelling}
              onClick={() => onCancel(batch.id)}
            >
              Cancel batch
            </Button>
            <Button
              loading={committing}
              disabled={batch.validRows === 0}
              onClick={() => onCommit(batch.id)}
            >
              Commit {batch.validRows} valid rows
            </Button>
          </>
        ) : undefined
      }
    >
      {detail.isPending ? (
        <TableSkeleton rows={6} columns={4} />
      ) : detail.isError ? (
        <ErrorState message={errorMessage(detail.error)} onRetry={() => void detail.refetch()} />
      ) : batch ? (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-3 text-sm text-slate-600">
            <span>{batch.totalRows} rows</span>
            <span>{batch.validRows} valid</span>
            <span>{batch.invalidRows} invalid</span>
            {batch.status === 'committed' && <span>{batch.createdRows} created</span>}
          </div>
          {batch.status === 'committed' && (
            <Alert tone="success">
              This batch is committed and cannot be applied again.
            </Alert>
          )}
          {batch.status === 'cancelled' && (
            <Alert tone="warning">This batch was cancelled and cannot be committed.</Alert>
          )}
          {batch.invalidRows > 0 && batch.status === 'previewed' && (
            <Alert tone="warning">
              Invalid rows are skipped on commit. Fix the file and preview again if you need every
              row imported.
            </Alert>
          )}
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="text-right">#</th>
                  <th>Action</th>
                  <th>Data</th>
                  <th>Errors</th>
                </tr>
              </thead>
              <tbody>
                {(batch.rows ?? []).map((row) => (
                  <ImportRowView key={row.id} row={row} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}

function ImportRowView({ row }: { row: ImportRow }): ReactNode {
  return (
    <tr>
      <td className="text-right tabular-nums">{row.rowNumber}</td>
      <td>
        <Badge
          tone={
            row.errors.length > 0
              ? 'danger'
              : row.action === 'skip'
                ? 'neutral'
                : row.action === 'update'
                  ? 'warning'
                  : 'success'
          }
        >
          {row.errors.length > 0 ? 'invalid' : row.action}
        </Badge>
      </td>
      <td className="max-w-md text-xs text-slate-600">
        <code className="break-all">
          {Object.entries(row.payload)
            .map(([key, value]) => `${key}=${value}`)
            .join(' · ')}
        </code>
      </td>
      <td className="text-xs text-rose-600">
        {row.errors.length === 0 ? '—' : row.errors.join('; ')}
      </td>
    </tr>
  );
}
