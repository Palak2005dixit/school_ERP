import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useSchoolId, useSchoolTimezone } from '../auth/AuthContext';
import { listAuditEvents } from '../lib/endpoints';
import { errorMessage } from '../lib/api';
import { formatDateTime, titleCase } from '../lib/format';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Icon,
  PageHeader,
  TableSkeleton,
} from '../components/ui';

const OUTCOME_TONES = {
  success: 'success',
  denied: 'danger',
  failure: 'warning',
  system: 'info',
} as const;

export function AuditPage(): ReactNode {
  const schoolId = useSchoolId();
  const timeZone = useSchoolTimezone();
  const [page, setPage] = useState(1);

  const events = useQuery({
    queryKey: ['audit-events', schoolId, page],
    queryFn: () => listAuditEvents(schoolId, page, 25),
    placeholderData: keepPreviousData,
  });

  const totalPages = events.data
    ? Math.max(1, Math.ceil(events.data.total / events.data.pageSize))
    : 1;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit log"
        description="Append-only record of security and domain events. Denied authorization attempts are logged with the missing permission."
      />

      <Card>
        {events.isPending ? (
          <TableSkeleton rows={10} columns={5} />
        ) : events.isError ? (
          <ErrorState message={errorMessage(events.error)} onRetry={() => void events.refetch()} />
        ) : events.data.items.length === 0 ? (
          <EmptyState
            title="No audit events yet"
            description="Sign-in attempts and record changes will appear here."
            icon="shield"
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Action</th>
                    <th>Entity</th>
                    <th>Outcome</th>
                    <th>Actor</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {events.data.items.map((event) => (
                    <tr key={event.id}>
                      <td className="whitespace-nowrap text-xs text-slate-500">
                        {formatDateTime(event.occurredAt, timeZone)}
                      </td>
                      <td className="font-mono text-xs text-slate-700">{event.action}</td>
                      <td className="text-xs">
                        <span className="text-slate-700">{titleCase(event.entityType)}</span>
                        {event.entityId && (
                          <span className="block font-mono text-[10px] text-slate-400">
                            {event.entityId.slice(0, 8)}…
                          </span>
                        )}
                      </td>
                      <td>
                        <Badge tone={OUTCOME_TONES[event.outcome]}>{event.outcome}</Badge>
                      </td>
                      <td className="text-xs text-slate-600">{event.actorName ?? 'System'}</td>
                      <td className="max-w-64 text-xs text-slate-500">
                        {event.reason ?? event.summary ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-4 py-3 text-sm text-slate-600">
              <p>
                Page {events.data.page} of {totalPages} · {events.data.total} events
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page <= 1 || events.isFetching}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                >
                  <Icon name="chevronLeft" className="h-3.5 w-3.5" />
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page >= totalPages || events.isFetching}
                  onClick={() => setPage((current) => current + 1)}
                >
                  Next
                  <Icon name="chevronRight" className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
