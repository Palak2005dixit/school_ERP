import { fullName, visibleSectionIds } from '@erp/core';
import { isoDate, uuid, type AttendanceReport, type FeeReport } from '@erp/shared';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { getActor, requirePermission, requestMeta } from '../auth/guards';
import { getPool } from '../db';
import { recordAudit } from '../lib/audit';
import { badRequest, parseInput } from '../lib/errors';
import { toIsoDate, toNumber } from '../lib/format';

const schoolParams = z.object({ schoolId: uuid });
const rangeQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  academicYearId: uuid.optional(),
});
const exportQuery = z.object({
  type: z.enum(['students', 'attendance', 'fees']),
  from: isoDate.optional(),
  to: isoDate.optional(),
  academicYearId: uuid.optional(),
  sectionId: uuid.optional(),
});

/**
 * Reports are computed from operational tables every time they are requested.
 * Nothing is cached or pre-aggregated, so a report always matches the ledger.
 * Every query is narrowed to the actor's visible sections when role scope
 * restricts them.
 */
export async function registerReportRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/schools/:schoolId/reports/attendance',
    { preHandler: requirePermission('reports.export') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const query = parseInput(rangeQuery, request.query);
      const actor = getActor(request);
      const range = await resolveRange(getPool(), schoolId, query);
      return attendanceReport(getPool(), schoolId, range.from, range.to, visibleSectionIds(actor));
    },
  );

  app.get(
    '/api/schools/:schoolId/reports/fees',
    { preHandler: requirePermission('reports.export') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const query = parseInput(rangeQuery, request.query);
      const actor = getActor(request);
      const yearId = await resolveYear(getPool(), schoolId, query.academicYearId);
      return feeReport(getPool(), schoolId, yearId, visibleSectionIds(actor));
    },
  );

  /**
   * CSV download. The response contains the same rows as the on-screen report,
   * with a UTF-8 BOM so spreadsheet software on Windows opens it correctly.
   */
  app.get(
    '/api/schools/:schoolId/reports/export',
    { preHandler: requirePermission('reports.export') },
    async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const query = parseInput(exportQuery, request.query);
      const actor = getActor(request);
      const restricted = visibleSectionIds(actor);

      let csv: string;
      let filename: string;

      if (query.type === 'students') {
        const yearId = await resolveYear(getPool(), schoolId, query.academicYearId);
        csv = await studentCsv(getPool(), schoolId, yearId, restricted, query.sectionId);
        filename = 'students.csv';
      } else if (query.type === 'attendance') {
        const range = await resolveRange(getPool(), schoolId, query);
        const report = await attendanceReport(
          getPool(),
          schoolId,
          range.from,
          range.to,
          restricted,
        );
        const rows = [
          ['Class', 'Section', 'Marked', 'Present', 'Absent', 'Late', 'Half day', 'Excused', 'Rate %'],
          ...report.sections.map((section) => [
            section.className,
            section.sectionName,
            String(section.totalMarked),
            String(section.present),
            String(section.absent),
            String(section.late),
            String(section.halfDay),
            String(section.excused),
            section.attendanceRate.toFixed(1),
          ]),
        ];
        csv = toCsv(rows);
        filename = `attendance-${range.from}-to-${range.to}.csv`;
      } else {
        const yearId = await resolveYear(getPool(), schoolId, query.academicYearId);
        csv = await feeCsv(getPool(), schoolId, yearId, restricted, query.sectionId);
        filename = 'fees.csv';
      }

      // Exports contain student contact and financial data, so record who
      // exported what and when. The CSV itself is never stored in the log.
      await recordAudit(getPool(), {
        schoolId,
        actorUserId: actor.userId,
        action: 'reports.exported',
        entityType: 'report',
        outcome: 'success',
        after: {
          type: query.type,
          academicYearId: query.academicYearId ?? null,
          sectionId: query.sectionId ?? null,
          from: query.from ?? null,
          to: query.to ?? null,
          filename,
          bytes: Buffer.byteLength(csv, 'utf8'),
        },
        ...requestMeta(request),
      });

      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${filename}"`)
        .send(`\uFEFF${csv}`);
    },
  );
}

/* --------------------------------- queries -------------------------------- */

async function resolveYear(
  client: Pick<pg.Pool, 'query'>,
  schoolId: string,
  requested: string | undefined,
): Promise<string | null> {
  if (requested) return requested;
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM academic_years WHERE school_id = $1 AND status = 'active' LIMIT 1`,
    [schoolId],
  );
  return rows[0]?.id ?? null;
}

async function resolveRange(
  client: Pick<pg.Pool, 'query'>,
  schoolId: string,
  query: { from?: string; to?: string; academicYearId?: string },
): Promise<{ from: string; to: string }> {
  const yearId = await resolveYear(client, schoolId, query.academicYearId);
  let from = query.from;
  let to = query.to;

  if ((!from || !to) && yearId) {
    const { rows } = await client.query<{ starts_on: string; ends_on: string }>(
      'SELECT starts_on, ends_on FROM academic_years WHERE school_id = $1 AND id = $2',
      [schoolId, yearId],
    );
    if (rows[0]) {
      from ??= toIsoDate(rows[0].starts_on);
      const today = new Date().toISOString().slice(0, 10);
      const yearEnd = toIsoDate(rows[0].ends_on);
      to ??= yearEnd < today ? yearEnd : today;
    }
  }

  from ??= new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  to ??= new Date().toISOString().slice(0, 10);
  if (to < from) {
    throw badRequest('The end date must be on or after the start date', {
      to: ['Choose an end date after the start date'],
    });
  }
  return { from, to };
}

async function attendanceReport(
  client: Pick<pg.Pool, 'query'>,
  schoolId: string,
  from: string,
  to: string,
  restricted: string[] | null,
): Promise<AttendanceReport> {
  const params: unknown[] = [schoolId, from, to];
  let filter = '';
  if (restricted) {
    params.push(restricted);
    filter = `AND sec.id = ANY($${params.length}::uuid[])`;
  }

  const { rows } = await client.query<{
    section_id: string;
    class_name: string;
    section_name: string;
    total_marked: string;
    present: string;
    absent: string;
    late: string;
    half_day: string;
    excused: string;
  }>(
    `SELECT sec.id AS section_id, c.name AS class_name, sec.name AS section_name,
            count(sa.id)::text AS total_marked,
            count(sa.id) FILTER (WHERE sa.status = 'present')::text AS present,
            count(sa.id) FILTER (WHERE sa.status = 'absent')::text AS absent,
            count(sa.id) FILTER (WHERE sa.status = 'late')::text AS late,
            count(sa.id) FILTER (WHERE sa.status = 'half_day')::text AS half_day,
            count(sa.id) FILTER (WHERE sa.status = 'excused')::text AS excused
     FROM sections sec
     JOIN classes c ON c.id = sec.class_id AND c.school_id = sec.school_id
     LEFT JOIN enrollments e
       ON e.section_id = sec.id AND e.school_id = sec.school_id
      AND e.enrollment_status = 'active'
     LEFT JOIN student_attendance sa
       ON sa.enrollment_id = e.id AND sa.school_id = sec.school_id
      AND sa.attendance_date BETWEEN $2::date AND $3::date
     WHERE sec.school_id = $1 ${filter}
     GROUP BY sec.id, c.name, sec.name, c.grade_order
     ORDER BY c.grade_order NULLS LAST, sec.name`,
    params,
  );

  return {
    from,
    to,
    sections: rows.map((row) => {
      const totalMarked = toNumber(row.total_marked);
      const present = toNumber(row.present);
      const late = toNumber(row.late);
      const halfDay = toNumber(row.half_day);
      const rate =
        totalMarked === 0 ? 0 : ((present + late + halfDay * 0.5) / totalMarked) * 100;
      return {
        sectionId: row.section_id,
        className: row.class_name,
        sectionName: row.section_name,
        totalMarked,
        present,
        absent: toNumber(row.absent),
        late,
        halfDay,
        excused: toNumber(row.excused),
        attendanceRate: Math.round(rate * 10) / 10,
      };
    }),
  };
}

async function feeReport(
  client: Pick<pg.Pool, 'query'>,
  schoolId: string,
  yearId: string | null,
  restricted: string[] | null,
): Promise<FeeReport> {
  const params: unknown[] = [schoolId];
  let yearFilter = '';
  if (yearId) {
    params.push(yearId);
    yearFilter = `AND ch.academic_year_id = $${params.length}`;
  }
  let scopeFilter = '';
  if (restricted) {
    params.push(restricted);
    scopeFilter = `AND EXISTS (
      SELECT 1 FROM enrollments e WHERE e.student_id = ch.student_id
      AND e.enrollment_status = 'active' AND e.section_id = ANY($${params.length}::uuid[]))`;
  }
  const collected = `COALESCE((
    SELECT sum(pa.amount) FROM payment_allocations pa
    JOIN payments p ON p.id = pa.payment_id AND p.status = 'recorded'
    WHERE pa.charge_id = ch.id
  ), 0)`;

  const byHead = await client.query<{
    fee_head_id: string;
    fee_head_name: string;
    charged: string;
    collected: string;
  }>(
    `SELECT ch.fee_head_id, fh.name AS fee_head_name,
            COALESCE(sum(ch.amount - ch.concession_amount - ch.write_off_amount), 0)::text AS charged,
            COALESCE(sum(${collected}), 0)::text AS collected
     FROM student_charges ch
     JOIN fee_heads fh ON fh.id = ch.fee_head_id AND fh.school_id = ch.school_id
     WHERE ch.school_id = $1 ${yearFilter} ${scopeFilter}
     GROUP BY ch.fee_head_id, fh.name
     ORDER BY fh.name`,
    params,
  );

  const byClass = await client.query<{
    class_id: string;
    class_name: string;
    charged: string;
    collected: string;
  }>(
    `SELECT c.id AS class_id, c.name AS class_name,
            COALESCE(sum(ch.amount - ch.concession_amount - ch.write_off_amount), 0)::text AS charged,
            COALESCE(sum(${collected}), 0)::text AS collected
     FROM student_charges ch
     JOIN LATERAL (
       SELECT e.class_id FROM enrollments e
       WHERE e.student_id = ch.student_id AND e.enrollment_status = 'active'
       ORDER BY e.starts_on DESC LIMIT 1
     ) e ON true
     JOIN classes c ON c.id = e.class_id AND c.school_id = ch.school_id
     WHERE ch.school_id = $1 ${yearFilter} ${scopeFilter}
     GROUP BY c.id, c.name, c.grade_order
     ORDER BY c.grade_order NULLS LAST, c.name`,
    params,
  );

  const methodParams: unknown[] = [schoolId];
  let methodYear = '';
  if (yearId) {
    methodParams.push(yearId);
    methodYear = 'AND p.academic_year_id = $2';
  }
  const byMethod = await client.query<{ method: string; amount: string; count: string }>(
    `SELECT p.method, COALESCE(sum(p.amount), 0)::text AS amount, count(*)::text AS count
     FROM payments p
     WHERE p.school_id = $1 AND p.status = 'recorded' ${methodYear}
     GROUP BY p.method
     ORDER BY p.method`,
    methodParams,
  );

  return {
    byHead: byHead.rows.map((row) => {
      const charged = toNumber(row.charged);
      const collectedAmount = toNumber(row.collected);
      return {
        feeHeadId: row.fee_head_id,
        feeHeadName: row.fee_head_name,
        charged,
        collected: collectedAmount,
        outstanding: Math.round((charged - collectedAmount) * 100) / 100,
      };
    }),
    byClass: byClass.rows.map((row) => {
      const charged = toNumber(row.charged);
      const collectedAmount = toNumber(row.collected);
      return {
        classId: row.class_id,
        className: row.class_name,
        charged,
        collected: collectedAmount,
        outstanding: Math.round((charged - collectedAmount) * 100) / 100,
      };
    }),
    byMethod: byMethod.rows.map((row) => ({
      method: row.method,
      amount: toNumber(row.amount),
      count: toNumber(row.count),
    })),
  };
}

async function studentCsv(
  client: Pick<pg.Pool, 'query'>,
  schoolId: string,
  yearId: string | null,
  restricted: string[] | null,
  sectionId: string | undefined,
): Promise<string> {
  const params: unknown[] = [schoolId];
  const conditions = ['st.school_id = $1'];
  if (yearId) {
    params.push(yearId);
    conditions.push(`en.academic_year_id = $${params.length}`);
  }
  if (sectionId) {
    params.push(sectionId);
    conditions.push(`en.section_id = $${params.length}`);
  }
  if (restricted) {
    params.push(restricted);
    conditions.push(`en.section_id = ANY($${params.length}::uuid[])`);
  }

  const { rows } = await client.query<{
    admission_number: string;
    first_name: string;
    middle_name: string | null;
    last_name: string;
    class_name: string | null;
    section_name: string | null;
    status: string;
    date_of_birth: string | null;
  }>(
    `SELECT st.admission_number, st.first_name, st.middle_name, st.last_name,
            c.name AS class_name, sec.name AS section_name, st.status, st.date_of_birth
     FROM students st
     LEFT JOIN LATERAL (
       SELECT e.class_id, e.section_id, e.academic_year_id, e.id
       FROM enrollments e
       WHERE e.student_id = st.id AND e.enrollment_status = 'active'
       ORDER BY e.starts_on DESC LIMIT 1
     ) en ON true
     LEFT JOIN classes c ON c.id = en.class_id
     LEFT JOIN sections sec ON sec.id = en.section_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY c.grade_order NULLS LAST, sec.name, st.first_name, st.last_name`,
    params,
  );

  return toCsv([
    ['Admission no', 'Student', 'Class', 'Section', 'Date of birth', 'Status'],
    ...rows.map((row) => [
      row.admission_number,
      fullName(row.first_name, row.middle_name, row.last_name),
      row.class_name ?? '',
      row.section_name ?? '',
      row.date_of_birth ? toIsoDate(row.date_of_birth) : '',
      row.status,
    ]),
  ]);
}

async function feeCsv(
  client: Pick<pg.Pool, 'query'>,
  schoolId: string,
  yearId: string | null,
  restricted: string[] | null,
  sectionId: string | undefined,
): Promise<string> {
  const params: unknown[] = [schoolId];
  const conditions = ['ch.school_id = $1'];
  if (yearId) {
    params.push(yearId);
    conditions.push(`ch.academic_year_id = $${params.length}`);
  }
  if (sectionId) {
    params.push(sectionId);
    conditions.push(
      `EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id = ch.student_id
       AND e.enrollment_status = 'active' AND e.section_id = $${params.length})`,
    );
  }
  if (restricted) {
    params.push(restricted);
    conditions.push(
      `EXISTS (SELECT 1 FROM enrollments e2 WHERE e2.student_id = ch.student_id
       AND e2.enrollment_status = 'active' AND e2.section_id = ANY($${params.length}::uuid[]))`,
    );
  }

  const { rows } = await client.query<{
    admission_number: string;
    first_name: string;
    middle_name: string | null;
    last_name: string;
    fee_head_name: string;
    description: string;
    amount: string;
    concession_amount: string;
    due_on: string;
    paid: string;
  }>(
    `SELECT st.admission_number, st.first_name, st.middle_name, st.last_name,
            fh.name AS fee_head_name, ch.description, ch.amount, ch.concession_amount,
            ch.due_on,
            COALESCE((
              SELECT sum(pa.amount) FROM payment_allocations pa
              JOIN payments p ON p.id = pa.payment_id AND p.status = 'recorded'
              WHERE pa.charge_id = ch.id
            ), 0)::text AS paid
     FROM student_charges ch
     JOIN students st ON st.id = ch.student_id AND st.school_id = ch.school_id
     JOIN fee_heads fh ON fh.id = ch.fee_head_id AND fh.school_id = ch.school_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY st.first_name, st.last_name, ch.due_on`,
    params,
  );

  return toCsv([
    [
      'Admission no',
      'Student',
      'Fee head',
      'Description',
      'Amount',
      'Concession',
      'Net',
      'Paid',
      'Balance',
      'Due on',
    ],
    ...rows.map((row) => {
      const amount = toNumber(row.amount);
      const concession = toNumber(row.concession_amount);
      const paid = toNumber(row.paid);
      return [
        row.admission_number,
        fullName(row.first_name, row.middle_name, row.last_name),
        row.fee_head_name,
        row.description,
        amount.toFixed(2),
        concession.toFixed(2),
        (amount - concession).toFixed(2),
        paid.toFixed(2),
        (amount - concession - paid).toFixed(2),
        toIsoDate(row.due_on),
      ];
    }),
  ]);
}

/* ---------------------------------- csv ----------------------------------- */

function toCsv(rows: string[][]): string {
  return rows
    .map((row) =>
      row
        .map((value) => {
          const text = String(value ?? '');
          return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
        })
        .join(','),
    )
    .join('\r\n');
}
