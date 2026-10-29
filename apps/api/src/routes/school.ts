import { visibleSectionIds } from '@erp/core';
import {
  isoDate,
  paginationQuery,
  uuid,
  type AttendanceStatus,
  type AuditEvent,
  type PortalAttendance,
  type PortalAttendanceDay,
  type SchoolOverview,
  type SchoolSummary,
} from '@erp/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getActor, requirePermission } from '../auth/guards';
import { getPool } from '../db';
import { parseInput } from '../lib/errors';
import { assertGuardianLinked } from '../lib/portal';
import { pageMeta, toIsoDate, toNumber } from '../lib/format';

const schoolParams = z.object({ schoolId: uuid });
const portalChildParams = z.object({ schoolId: uuid, studentId: uuid });
const portalRangeQuery = z.object({ from: isoDate.optional(), to: isoDate.optional() });

export async function registerSchoolRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/schools/:schoolId',
    { preHandler: requirePermission('school.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const actor = getActor(request);
      const { rows } = await getPool().query<{
        id: string;
        code: string;
        name: string;
        timezone: string;
        status: SchoolSummary['status'];
      }>('SELECT id, code, name, timezone, status FROM schools WHERE id = $1', [schoolId]);

      const school = rows[0]!;
      return {
        school: {
          id: school.id,
          code: school.code,
          name: school.name,
          timezone: school.timezone,
          status: school.status,
        } satisfies SchoolSummary,
        roles: actor.roleCodes,
        permissions: [...actor.permissions].sort(),
      };
    },
  );

  /**
   * Dashboard aggregates are computed from real rows. Every count is scoped to
   * the sections the actor may see; there are no hard-coded metrics.
   */
  app.get(
    '/api/schools/:schoolId/overview',
    { preHandler: requirePermission('school.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const actor = getActor(request);
      const restricted = visibleSectionIds(actor);

      const activeYear = await getPool().query<{
        id: string;
        name: string;
        starts_on: string;
        ends_on: string;
      }>(
        `SELECT id, name, starts_on, ends_on FROM academic_years
         WHERE school_id = $1 AND status = 'active'`,
        [schoolId],
      );
      const year = activeYear.rows[0] ?? null;

      const sectionFilter = restricted ? `AND en.section_id = ANY($3::uuid[])` : '';
      const scopeParams: unknown[] = year ? [schoolId, year.id] : [schoolId, null];
      if (restricted) scopeParams.push(restricted);

      const counts = await getPool().query<{
        students_active: string;
        classes: string;
        sections: string;
        subjects: string;
        pending_guardian_links: string;
      }>(
        `SELECT
           (SELECT count(*) FROM students st
             WHERE st.school_id = $1 AND st.status = 'active'
               ${restricted ? 'AND EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id = st.id AND e.enrollment_status = \'active\' AND e.section_id = ANY($3::uuid[]))' : ''}
           )::text AS students_active,
           (SELECT count(*) FROM classes WHERE school_id = $1 AND status = 'active')::text AS classes,
           (SELECT count(*) FROM sections
             WHERE school_id = $1 AND status = 'active'
               AND ($2::uuid IS NULL OR academic_year_id = $2::uuid)
               ${restricted ? 'AND id = ANY($3::uuid[])' : ''}
           )::text AS sections,
           (SELECT count(*) FROM subjects WHERE school_id = $1 AND status = 'active')::text AS subjects,
           (SELECT count(*) FROM student_guardians sg
             JOIN students st2 ON st2.id = sg.student_id AND st2.school_id = sg.school_id
             WHERE sg.school_id = $1 AND sg.portal_access_status = 'pending' AND sg.valid_to IS NULL
               ${restricted ? 'AND EXISTS (SELECT 1 FROM enrollments e2 WHERE e2.student_id = st2.id AND e2.enrollment_status = \'active\' AND e2.section_id = ANY($3::uuid[]))' : ''}
           )::text AS pending_guardian_links`,
        scopeParams,
      );

      const byClass = await getPool().query<{
        class_id: string;
        class_name: string;
        count: string;
      }>(
        `SELECT c.id AS class_id, c.name AS class_name, count(*)::text AS count
         FROM enrollments en
         JOIN classes c ON c.id = en.class_id
         WHERE en.school_id = $1 AND en.enrollment_status = 'active'
           AND ($2::uuid IS NULL OR en.academic_year_id = $2::uuid)
           ${sectionFilter}
         GROUP BY c.id, c.name, c.grade_order
         ORDER BY c.grade_order NULLS LAST, c.name`,
        scopeParams,
      );

      const activity = await getPool().query<{
        id: string;
        summary: string;
        event_type: string;
        occurred_at: Date;
        actor_name: string | null;
      }>(
        `SELECT a.id, a.summary, a.event_type, a.occurred_at, u.display_name AS actor_name
         FROM activity_events a
         LEFT JOIN users u ON u.id = a.actor_user_id
         WHERE a.school_id = $1
         ORDER BY a.occurred_at DESC
         LIMIT 8`,
        [schoolId],
      );

      const overview: SchoolOverview = {
        studentsActive: toNumber(counts.rows[0]?.students_active),
        studentsByClass: byClass.rows.map((row) => ({
          classId: row.class_id,
          className: row.class_name,
          count: toNumber(row.count),
        })),
        classes: toNumber(counts.rows[0]?.classes),
        sections: toNumber(counts.rows[0]?.sections),
        subjects: toNumber(counts.rows[0]?.subjects),
        activeAcademicYear: year
          ? {
              id: year.id,
              name: year.name,
              startsOn: toIsoDate(year.starts_on),
              endsOn: toIsoDate(year.ends_on),
            }
          : null,
        pendingGuardianLinks: toNumber(counts.rows[0]?.pending_guardian_links),
        recentActivity: activity.rows.map((row) => ({
          id: row.id,
          summary: row.summary,
          eventType: row.event_type,
          occurredAt: row.occurred_at.toISOString(),
          actorName: row.actor_name,
        })),
      };

      return overview;
    },
  );

  app.get(
    '/api/schools/:schoolId/audit-events',
    { preHandler: requirePermission('audit.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const query = parseInput(paginationQuery, request.query);

      const count = await getPool().query<{ total: string }>(
        'SELECT count(*)::text AS total FROM audit_events WHERE school_id = $1',
        [schoolId],
      );
      const total = toNumber(count.rows[0]?.total);

      const { rows } = await getPool().query<{
        id: string;
        action: string;
        entity_type: string;
        entity_id: string | null;
        outcome: AuditEvent['outcome'];
        reason: string | null;
        occurred_at: Date;
        actor_name: string | null;
        after_state: unknown;
      }>(
        `SELECT a.id, a.action, a.entity_type, a.entity_id, a.outcome, a.reason,
                a.occurred_at, u.display_name AS actor_name, a.after_state
         FROM audit_events a
         LEFT JOIN users u ON u.id = a.actor_user_id
         WHERE a.school_id = $1
         ORDER BY a.occurred_at DESC
         LIMIT $2 OFFSET $3`,
        [schoolId, query.pageSize, (query.page - 1) * query.pageSize],
      );

      const items: AuditEvent[] = rows.map((row) => ({
        id: row.id,
        action: row.action,
        entityType: row.entity_type,
        entityId: row.entity_id,
        outcome: row.outcome,
        reason: row.reason,
        occurredAt: row.occurred_at.toISOString(),
        actorName: row.actor_name,
        summary: summarize(row.after_state),
      }));

      return { items, ...pageMeta(total, query.page, query.pageSize) };
    },
  );

  /* ------------------------------ guardian portal --------------------------- */

  app.get(
    '/api/schools/:schoolId/portal/children/:studentId/attendance',
    { preHandler: requirePermission('guardian.student.view') },
    async (request) => {
      const { schoolId, studentId } = parseInput(portalChildParams, request.params);
      const query = parseInput(portalRangeQuery, request.query);
      const actor = getActor(request);
      await assertGuardianLinked(getPool(), schoolId, actor.userId, studentId);

      const to = query.to ?? new Date().toISOString().slice(0, 10);
      const from =
        query.from ??
        new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);

      const { rows } = await getPool().query<{
        attendance_date: string;
        status: AttendanceStatus;
        note: string | null;
      }>(
        `SELECT attendance_date, status, note
         FROM student_attendance
         WHERE school_id = $1 AND student_id = $2
           AND attendance_date BETWEEN $3::date AND $4::date
         ORDER BY attendance_date`,
        [schoolId, studentId, from, to],
      );

      const days: PortalAttendanceDay[] = rows.map((row) => ({
        date: toIsoDate(row.attendance_date),
        status: row.status,
        note: row.note,
      }));
      const count = (status: AttendanceStatus) =>
        days.filter((day) => day.status === status).length;
      const present = count('present');
      const late = count('late');
      const halfDay = count('half_day');
      const responses: PortalAttendance = {
        studentId,
        from,
        to,
        totalMarked: days.length,
        present,
        absent: count('absent'),
        late,
        halfDay,
        excused: count('excused'),
        attendanceRate:
          days.length === 0
            ? 0
            : Math.round(((present + late + halfDay * 0.5) / days.length) * 1000) / 10,
        days,
      };
      return responses;
    },
  );
}

function summarize(state: unknown): string | null {
  if (!state || typeof state !== 'object') return null;
  const record = state as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof record.name === 'string') parts.push(record.name);
  if (typeof record.admissionNumber === 'string') parts.push(record.admissionNumber);
  if (typeof record.status === 'string') parts.push(String(record.status));
  return parts.length > 0 ? parts.join(' · ') : null;
}
