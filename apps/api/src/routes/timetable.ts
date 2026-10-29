import { canAccessSection, visibleSectionIds } from '@erp/core';
import {
  roomInput,
  roomUpdate,
  timetablePeriodInput,
  timetablePeriodUpdate,
  timetableSlotInput,
  uuid,
  type RoomRecord,
  type TimetableData,
  type TimetablePeriod,
} from '@erp/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getActor, requirePermission, requestMeta } from '../auth/guards';
import { getPool, withTransaction } from '../db';
import { recordActivity, recordAudit } from '../lib/audit';
import { badRequest, notFound, parseInput } from '../lib/errors';

const schoolParams = z.object({ schoolId: uuid });
const idParams = z.object({ schoolId: uuid, id: uuid });
const listQuery = z.object({
  academicYearId: uuid.optional(),
  sectionId: uuid.optional(),
});

/**
 * Timetable periods, rooms and section slots.
 *
 * Double booking is prevented by database indexes on (section, day, period),
 * (year, day, period, teacher) and (year, day, period, room). The API checks
 * ownership and teaching dates first, then lets the unique indexes settle races.
 */
export async function registerTimetableRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/schools/:schoolId/timetable',
    { preHandler: requirePermission('academic.structure.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const query = parseInput(listQuery, request.query);
      const actor = getActor(request);

      const yearId =
        query.academicYearId ??
        (
          await getPool().query<{ id: string }>(
            `SELECT id FROM academic_years
             WHERE school_id = $1 AND status = 'active' LIMIT 1`,
            [schoolId],
          )
        ).rows[0]?.id ??
        null;

      if (!yearId) {
        return {
          academicYearId: null,
          periods: [],
          rooms: [],
          slots: [],
          teachers: [],
        } satisfies TimetableData;
      }

      if (query.sectionId && !canAccessSection(actor, query.sectionId)) {
        throw notFound('Section not found');
      }

      const periodsResult = await getPool().query<{
        id: string;
        academic_year_id: string;
        name: string;
        sequence_no: number;
        starts_at: string;
        ends_at: string;
        is_break: boolean;
      }>(
        `SELECT id, academic_year_id, name, sequence_no, starts_at, ends_at, is_break
         FROM timetable_periods
         WHERE school_id = $1 AND academic_year_id = $2
         ORDER BY sequence_no`,
        [schoolId, yearId],
      );

      const roomsResult = await getPool().query<RoomRecord>(
        `SELECT id, code, name, capacity, status
         FROM rooms WHERE school_id = $1 ORDER BY code`,
        [schoolId],
      );

      const teachersResult = await getPool().query<{ id: string; display_name: string }>(
        `SELECT DISTINCT u.id, u.display_name
         FROM users u
         JOIN user_role_assignments ura ON ura.user_id = u.id
         WHERE ura.school_id = $1 AND ura.revoked_at IS NULL
           AND ura.valid_from <= now()
           AND (ura.valid_to IS NULL OR ura.valid_to > now())
           AND u.status = 'active'
         ORDER BY u.display_name`,
        [schoolId],
      );

      const params: unknown[] = [schoolId, yearId];
      const conditions = ['ts.school_id = $1', 'ts.academic_year_id = $2'];
      if (query.sectionId) {
        params.push(query.sectionId);
        conditions.push(`ts.section_id = $${params.length}`);
      } else {
        const restricted = visibleSectionIds(actor);
        if (restricted) {
          params.push(restricted);
          conditions.push(`ts.section_id = ANY($${params.length}::uuid[])`);
        }
      }

      const slotsResult = await getPool().query<{
        id: string;
        academic_year_id: string;
        section_id: string;
        class_name: string;
        section_name: string;
        period_id: string;
        day_of_week: number;
        subject_id: string;
        subject_name: string;
        teacher_user_id: string;
        teacher_name: string;
        room_id: string | null;
        room_name: string | null;
      }>(
        `SELECT ts.id, ts.academic_year_id, ts.section_id,
                c.name AS class_name, sec.name AS section_name,
                ts.period_id, ts.day_of_week, ts.subject_id, sub.name AS subject_name,
                ts.teacher_user_id, u.display_name AS teacher_name,
                ts.room_id, r.name AS room_name
         FROM timetable_slots ts
         JOIN sections sec ON sec.id = ts.section_id AND sec.school_id = ts.school_id
         JOIN classes c ON c.id = sec.class_id AND c.school_id = sec.school_id
         JOIN subjects sub ON sub.id = ts.subject_id AND sub.school_id = ts.school_id
         JOIN users u ON u.id = ts.teacher_user_id
         LEFT JOIN rooms r ON r.id = ts.room_id AND r.school_id = ts.school_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY ts.day_of_week, ts.period_id`,
        params,
      );

      const periods: TimetablePeriod[] = periodsResult.rows.map((row) => ({
        id: row.id,
        academicYearId: row.academic_year_id,
        name: row.name,
        sequenceNo: row.sequence_no,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        isBreak: row.is_break,
      }));

      return {
        academicYearId: yearId,
        periods,
        rooms: roomsResult.rows,
        slots: slotsResult.rows.map((row) => ({
          id: row.id,
          academicYearId: row.academic_year_id,
          sectionId: row.section_id,
          className: row.class_name,
          sectionName: row.section_name,
          periodId: row.period_id,
          dayOfWeek: row.day_of_week,
          subjectId: row.subject_id,
          subjectName: row.subject_name,
          teacherUserId: row.teacher_user_id,
          teacherName: row.teacher_name,
          roomId: row.room_id,
          roomName: row.room_name,
        })),
        teachers: teachersResult.rows.map((row) => ({
          id: row.id,
          displayName: row.display_name,
        })),
      } satisfies TimetableData;
    },
  );

  /* --------------------------------- periods -------------------------------- */

  app.post(
    '/api/schools/:schoolId/timetable/periods',
    { preHandler: requirePermission('academic.timetable.manage') },
    async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const actor = getActor(request);
      const input = parseInput(timetablePeriodInput, request.body);
      assertClockRange(input.startsAt, input.endsAt);

      const period = await withTransaction(async (client) => {
        const year = await client.query<{ id: string }>(
          'SELECT id FROM academic_years WHERE school_id = $1 AND id = $2',
          [schoolId, input.academicYearId],
        );
        if (!year.rows[0]) throw notFound('Academic year not found');

        const { rows } = await client.query<{
          id: string;
          academic_year_id: string;
          name: string;
          sequence_no: number;
          starts_at: string;
          ends_at: string;
          is_break: boolean;
        }>(
          `INSERT INTO timetable_periods
             (school_id, academic_year_id, name, sequence_no, starts_at, ends_at, is_break)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, academic_year_id, name, sequence_no, starts_at, ends_at, is_break`,
          [
            schoolId,
            input.academicYearId,
            input.name,
            input.sequenceNo,
            input.startsAt,
            input.endsAt,
            input.isBreak,
          ],
        );

        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'timetable.period_created',
          entityType: 'timetable_period',
          entityId: rows[0]!.id,
          outcome: 'success',
          after: input,
          ...requestMeta(request),
        });
        return mapPeriod(rows[0]!);
      });

      return reply.status(201).send(period);
    },
  );

  app.patch(
    '/api/schools/:schoolId/timetable/periods/:id',
    { preHandler: requirePermission('academic.timetable.manage') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const actor = getActor(request);
      const input = parseInput(timetablePeriodUpdate, request.body);

      return withTransaction(async (client) => {
        const existing = await client.query<{
          id: string;
          academic_year_id: string;
          name: string;
          sequence_no: number;
          starts_at: string;
          ends_at: string;
          is_break: boolean;
        }>(
          `SELECT id, academic_year_id, name, sequence_no, starts_at, ends_at, is_break
           FROM timetable_periods WHERE school_id = $1 AND id = $2 FOR UPDATE`,
          [schoolId, id],
        );
        const row = existing.rows[0];
        if (!row) throw notFound('Period not found');

        const startsAt = input.startsAt ?? row.starts_at;
        const endsAt = input.endsAt ?? row.ends_at;
        assertClockRange(startsAt, endsAt);

        const { rows } = await client.query<{
          id: string;
          academic_year_id: string;
          name: string;
          sequence_no: number;
          starts_at: string;
          ends_at: string;
          is_break: boolean;
        }>(
          `UPDATE timetable_periods
           SET name = $3, sequence_no = $4, starts_at = $5, ends_at = $6, is_break = $7
           WHERE school_id = $1 AND id = $2
           RETURNING id, academic_year_id, name, sequence_no, starts_at, ends_at, is_break`,
          [
            schoolId,
            id,
            input.name ?? row.name,
            input.sequenceNo ?? row.sequence_no,
            startsAt,
            endsAt,
            input.isBreak ?? row.is_break,
          ],
        );

        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'timetable.period_updated',
          entityType: 'timetable_period',
          entityId: id,
          outcome: 'success',
          before: row,
          after: input,
          ...requestMeta(request),
        });
        return mapPeriod(rows[0]!);
      });
    },
  );

  app.delete(
    '/api/schools/:schoolId/timetable/periods/:id',
    { preHandler: requirePermission('academic.timetable.manage') },
    async (request, reply) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const actor = getActor(request);

      await withTransaction(async (client) => {
        const used = await client.query<{ id: string }>(
          'SELECT id FROM timetable_slots WHERE school_id = $1 AND period_id = $2 LIMIT 1',
          [schoolId, id],
        );
        if (used.rows[0]) {
          throw badRequest('Remove the timetable slots that use this period first', {
            periodId: ['This period still has scheduled lessons'],
          });
        }
        const { rowCount } = await client.query(
          'DELETE FROM timetable_periods WHERE school_id = $1 AND id = $2',
          [schoolId, id],
        );
        if (rowCount === 0) throw notFound('Period not found');
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'timetable.period_deleted',
          entityType: 'timetable_period',
          entityId: id,
          outcome: 'success',
          ...requestMeta(request),
        });
      });

      return reply.status(204).send();
    },
  );

  /* ---------------------------------- rooms --------------------------------- */

  app.post(
    '/api/schools/:schoolId/rooms',
    { preHandler: requirePermission('academic.timetable.manage') },
    async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const actor = getActor(request);
      const input = parseInput(roomInput, request.body);

      const room = await withTransaction(async (client) => {
        const { rows } = await client.query<{
          id: string;
          code: string;
          name: string;
          capacity: number | null;
          status: 'active' | 'inactive';
        }>(
          `INSERT INTO rooms (school_id, code, name, capacity, status)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, code, name, capacity, status`,
          [schoolId, input.code, input.name, input.capacity ?? null, input.status],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'timetable.room_created',
          entityType: 'room',
          entityId: rows[0]!.id,
          outcome: 'success',
          after: input,
          ...requestMeta(request),
        });
        return rows[0]!;
      });

      return reply.status(201).send(room);
    },
  );

  app.patch(
    '/api/schools/:schoolId/rooms/:id',
    { preHandler: requirePermission('academic.timetable.manage') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const actor = getActor(request);
      const input = parseInput(roomUpdate, request.body);

      return withTransaction(async (client) => {
        const existing = await client.query<{
          id: string;
          code: string;
          name: string;
          capacity: number | null;
          status: 'active' | 'inactive';
        }>(
          'SELECT id, code, name, capacity, status FROM rooms WHERE school_id = $1 AND id = $2 FOR UPDATE',
          [schoolId, id],
        );
        const row = existing.rows[0];
        if (!row) throw notFound('Room not found');

        const { rows } = await client.query<{
          id: string;
          code: string;
          name: string;
          capacity: number | null;
          status: 'active' | 'inactive';
        }>(
          `UPDATE rooms SET code = $3, name = $4, capacity = $5, status = $6
           WHERE school_id = $1 AND id = $2
           RETURNING id, code, name, capacity, status`,
          [
            schoolId,
            id,
            input.code ?? row.code,
            input.name ?? row.name,
            input.capacity === undefined ? row.capacity : input.capacity,
            input.status ?? row.status,
          ],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'timetable.room_updated',
          entityType: 'room',
          entityId: id,
          outcome: 'success',
          before: row,
          after: input,
          ...requestMeta(request),
        });
        return rows[0]!;
      });
    },
  );

  app.delete(
    '/api/schools/:schoolId/rooms/:id',
    { preHandler: requirePermission('academic.timetable.manage') },
    async (request, reply) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const actor = getActor(request);

      await withTransaction(async (client) => {
        const used = await client.query<{ id: string }>(
          'SELECT id FROM timetable_slots WHERE school_id = $1 AND room_id = $2 LIMIT 1',
          [schoolId, id],
        );
        if (used.rows[0]) {
          throw badRequest('Remove the timetable slots that use this room first', {
            roomId: ['This room still has scheduled lessons'],
          });
        }
        const { rowCount } = await client.query(
          'DELETE FROM rooms WHERE school_id = $1 AND id = $2',
          [schoolId, id],
        );
        if (rowCount === 0) throw notFound('Room not found');
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'timetable.room_deleted',
          entityType: 'room',
          entityId: id,
          outcome: 'success',
          ...requestMeta(request),
        });
      });

      return reply.status(204).send();
    },
  );

  /* ---------------------------------- slots --------------------------------- */

  app.post(
    '/api/schools/:schoolId/timetable/slots',
    { preHandler: requirePermission('academic.timetable.manage') },
    async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const actor = getActor(request);
      const input = parseInput(timetableSlotInput, request.body);

      const slot = await withTransaction(async (client) => {
        const section = await client.query<{ id: string }>(
          `SELECT id FROM sections
           WHERE school_id = $1 AND id = $2 AND academic_year_id = $3`,
          [schoolId, input.sectionId, input.academicYearId],
        );
        if (!section.rows[0]) throw notFound('Section not found');

        const period = await client.query<{ id: string; is_break: boolean }>(
          `SELECT id, is_break FROM timetable_periods
           WHERE school_id = $1 AND id = $2 AND academic_year_id = $3`,
          [schoolId, input.periodId, input.academicYearId],
        );
        const periodRow = period.rows[0];
        if (!periodRow) throw notFound('Period not found');
        if (periodRow.is_break) {
          throw badRequest('A break period cannot take a lesson', {
            periodId: ['Choose a teaching period'],
          });
        }

        const subject = await client.query<{ id: string }>(
          'SELECT id FROM subjects WHERE school_id = $1 AND id = $2',
          [schoolId, input.subjectId],
        );
        if (!subject.rows[0]) throw notFound('Subject not found');

        const teacher = await client.query<{ id: string }>(
          `SELECT DISTINCT u.id
           FROM users u
           JOIN user_role_assignments ura ON ura.user_id = u.id
           WHERE u.id = $1 AND ura.school_id = $2 AND ura.revoked_at IS NULL
             AND ura.valid_from <= now()
             AND (ura.valid_to IS NULL OR ura.valid_to > now())`,
          [input.teacherUserId, schoolId],
        );
        if (!teacher.rows[0]) {
          throw badRequest('Choose a staff member with access to this school', {
            teacherUserId: ['That user has no active role in this school'],
          });
        }

        if (input.roomId) {
          const room = await client.query<{ id: string }>(
            'SELECT id FROM rooms WHERE school_id = $1 AND id = $2',
            [schoolId, input.roomId],
          );
          if (!room.rows[0]) throw notFound('Room not found');
        }

        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO timetable_slots
             (school_id, academic_year_id, section_id, period_id, day_of_week,
              subject_id, teacher_user_id, room_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id`,
          [
            schoolId,
            input.academicYearId,
            input.sectionId,
            input.periodId,
            input.dayOfWeek,
            input.subjectId,
            input.teacherUserId,
            input.roomId ?? null,
          ],
        );

        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'timetable.slot_created',
          entityType: 'timetable_slot',
          entityId: rows[0]!.id,
          outcome: 'success',
          after: input,
          ...requestMeta(request),
        });
        await recordActivity(client, {
          schoolId,
          entityType: 'section',
          entityId: input.sectionId,
          eventType: 'timetable.slot_created',
          actorUserId: actor.userId,
          summary: 'Timetable lesson scheduled',
        });

        return rows[0]!.id;
      });

      return reply.status(201).send({ id: slot });
    },
  );

  app.delete(
    '/api/schools/:schoolId/timetable/slots/:id',
    { preHandler: requirePermission('academic.timetable.manage') },
    async (request, reply) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const actor = getActor(request);

      await withTransaction(async (client) => {
        const { rowCount } = await client.query(
          'DELETE FROM timetable_slots WHERE school_id = $1 AND id = $2',
          [schoolId, id],
        );
        if (rowCount === 0) throw notFound('Lesson not found');
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'timetable.slot_deleted',
          entityType: 'timetable_slot',
          entityId: id,
          outcome: 'success',
          ...requestMeta(request),
        });
      });

      return reply.status(204).send();
    },
  );
}

function mapPeriod(row: {
  id: string;
  academic_year_id: string;
  name: string;
  sequence_no: number;
  starts_at: string;
  ends_at: string;
  is_break: boolean;
}): TimetablePeriod {
  return {
    id: row.id,
    academicYearId: row.academic_year_id,
    name: row.name,
    sequenceNo: row.sequence_no,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    isBreak: row.is_break,
  };
}

function assertClockRange(startsAt: string, endsAt: string): void {
  if (endsAt <= startsAt) {
    throw badRequest('The period must end after it starts', {
      endsAt: ['End time must be later than the start time'],
    });
  }
}
