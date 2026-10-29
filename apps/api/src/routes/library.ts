import {
  libraryBookInput,
  libraryBookUpdate,
  libraryCategoryInput,
  libraryCopyInput,
  libraryFineInput,
  libraryLoanInput,
  libraryMemberInput,
  libraryReservationInput,
  libraryReturnInput,
  librarySettingsInput,
  uuid,
  type LibraryBook,
  type LibraryCategory,
  type LibraryCopy,
  type LibraryFine,
  type LibraryLoan,
  type LibraryMember,
  type LibraryReservation,
  type LibrarySettings,
} from '@erp/shared';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { getActor, requirePermission, requestMeta } from '../auth/guards';
import { getPool, withTransaction } from '../db';
import { recordAudit } from '../lib/audit';
import { badRequest, conflict, notFound, parseInput } from '../lib/errors';
import { toIsoDate, toNumber } from '../lib/format';
import { idempotentRoute } from '../lib/idempotency';

const schoolParams = z.object({ schoolId: uuid });
const idParams = z.object({ schoolId: uuid, id: uuid });
const bookQuery = z.object({
  categoryId: uuid.optional(),
  search: z.string().trim().max(120).optional(),
  status: z.enum(['active', 'inactive']).optional(),
});
const loanQuery = z.object({
  status: z.enum(['issued', 'returned', 'lost']).optional(),
  memberId: uuid.optional(),
  openOnly: z.enum(['true', 'false']).optional(),
});
const fineQuery = z.object({ status: z.enum(['pending', 'paid', 'waived']).optional() });
const fineDecisionInput = z.object({ decision: z.enum(['pay', 'waive']) });

/**
 * Library catalogue and circulation.
 *
 * A copy can only be on one open loan (enforced by a partial unique index). The
 * borrowing limit, loan period and fine rate come from library_settings, so they
 * are explicit school configuration rather than invented policy. Overdue fines
 * are only assessed when a loan is returned, and only if no fine exists yet.
 */
export async function registerLibraryRoutes(app: FastifyInstance): Promise<void> {
  /* -------------------------------- categories ----------------------------- */

  app.get(
    '/api/schools/:schoolId/library/categories',
    { preHandler: requirePermission('library.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const { rows } = await getPool().query<{
        id: string;
        code: string;
        name: string;
        book_count: string;
      }>(
        `SELECT c.id, c.code, c.name,
                (SELECT count(*) FROM library_books b
                 WHERE b.school_id = c.school_id AND b.category_id = c.id)::text AS book_count
         FROM library_categories c WHERE c.school_id = $1 ORDER BY c.name`,
        [schoolId],
      );
      const items: LibraryCategory[] = rows.map((row) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        bookCount: toNumber(row.book_count),
      }));
      return { items };
    },
  );

  app.post(
    '/api/schools/:schoolId/library/categories',
    { preHandler: requirePermission('library.manage') },
    async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const input = parseInput(libraryCategoryInput, request.body);
      const { rows } = await getPool().query<{ id: string }>(
        `INSERT INTO library_categories (school_id, code, name)
         VALUES ($1, $2, $3) RETURNING id`,
        [schoolId, input.code, input.name],
      );
      return reply.status(201).send({ id: rows[0]!.id });
    },
  );

  /* ---------------------------------- books -------------------------------- */

  app.get(
    '/api/schools/:schoolId/library/books',
    { preHandler: requirePermission('library.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const query = parseInput(bookQuery, request.query);
      const params: unknown[] = [schoolId];
      const filters = ['b.school_id = $1'];
      if (query.categoryId) {
        params.push(query.categoryId);
        filters.push(`b.category_id = $${params.length}`);
      }
      if (query.status) {
        params.push(query.status);
        filters.push(`b.status = $${params.length}`);
      }
      if (query.search) {
        params.push(`%${query.search}%`);
        filters.push(
          `(b.title ILIKE $${params.length} OR b.author ILIKE $${params.length} OR b.isbn ILIKE $${params.length})`,
        );
      }
      const { rows } = await getPool().query<{
        id: string;
        category_id: string | null;
        category_name: string | null;
        title: string;
        author: string | null;
        publisher: string | null;
        isbn: string | null;
        language: string | null;
        description: string | null;
        status: LibraryBook['status'];
        total_copies: string;
        available_copies: string;
      }>(
        `SELECT b.id, b.category_id, c.name AS category_name, b.title, b.author,
                b.publisher, b.isbn, b.language, b.description, b.status,
                (SELECT count(*) FROM library_copies cp
                 WHERE cp.school_id = b.school_id AND cp.book_id = b.id)::text AS total_copies,
                (SELECT count(*) FROM library_copies cp
                 WHERE cp.school_id = b.school_id AND cp.book_id = b.id
                   AND cp.status = 'available')::text AS available_copies
         FROM library_books b
         LEFT JOIN library_categories c ON c.id = b.category_id AND c.school_id = b.school_id
         WHERE ${filters.join(' AND ')}
         ORDER BY b.title`,
        params,
      );
      const items: LibraryBook[] = rows.map((row) => ({
        id: row.id,
        categoryId: row.category_id,
        categoryName: row.category_name,
        title: row.title,
        author: row.author,
        publisher: row.publisher,
        isbn: row.isbn,
        language: row.language,
        description: row.description,
        status: row.status,
        totalCopies: toNumber(row.total_copies),
        availableCopies: toNumber(row.available_copies),
      }));
      return { items };
    },
  );

  app.post(
    '/api/schools/:schoolId/library/books',
    { preHandler: requirePermission('library.manage') },
    idempotentRoute('POST /library/books', async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const input = parseInput(libraryBookInput, request.body);
      const actor = getActor(request);
      const created = await withTransaction(async (client) => {
        if (input.categoryId) {
          const category = await client.query(
            'SELECT 1 FROM library_categories WHERE school_id = $1 AND id = $2',
            [schoolId, input.categoryId],
          );
          if (category.rowCount === 0) throw notFound('Category not found');
        }
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO library_books
             (school_id, category_id, title, author, publisher, isbn, language, description, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
          [
            schoolId,
            input.categoryId ?? null,
            input.title,
            input.author ?? null,
            input.publisher ?? null,
            input.isbn ?? null,
            input.language ?? null,
            input.description ?? null,
            input.status,
          ],
        );
        const bookId = rows[0]!.id;
        for (let index = 0; index < input.copies; index += 1) {
          const accession = await nextAccession(client, schoolId);
          await client.query(
            `INSERT INTO library_copies (school_id, book_id, accession_number)
             VALUES ($1, $2, $3)`,
            [schoolId, bookId, accession],
          );
        }
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'library.book_created',
          entityType: 'library_book',
          entityId: bookId,
          outcome: 'success',
          after: { title: input.title, copies: input.copies },
          ...requestMeta(request),
        });
        return bookId;
      });
      return reply.status(201).send({ id: created });
    }),
  );

  app.patch(
    '/api/schools/:schoolId/library/books/:id',
    { preHandler: requirePermission('library.manage') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const input = parseInput(libraryBookUpdate, request.body);
      const existing = await getPool().query<{
        category_id: string | null;
        title: string;
        author: string | null;
        publisher: string | null;
        isbn: string | null;
        language: string | null;
        description: string | null;
        status: LibraryBook['status'];
      }>(
        `SELECT category_id, title, author, publisher, isbn, language, description, status
         FROM library_books WHERE school_id = $1 AND id = $2`,
        [schoolId, id],
      );
      const row = existing.rows[0];
      if (!row) throw notFound('Book not found');
      await getPool().query(
        `UPDATE library_books SET
           category_id = $3, title = $4, author = $5, publisher = $6, isbn = $7,
           language = $8, description = $9, status = $10
         WHERE school_id = $1 AND id = $2`,
        [
          schoolId,
          id,
          input.categoryId === undefined ? row.category_id : input.categoryId,
          input.title ?? row.title,
          input.author === undefined ? row.author : input.author,
          input.publisher === undefined ? row.publisher : input.publisher,
          input.isbn === undefined ? row.isbn : input.isbn,
          input.language === undefined ? row.language : input.language,
          input.description === undefined ? row.description : input.description,
          input.status ?? row.status,
        ],
      );
      return { id };
    },
  );

  /* ---------------------------------- copies ------------------------------- */

  app.get(
    '/api/schools/:schoolId/library/books/:id/copies',
    { preHandler: requirePermission('library.view') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const { rows } = await getPool().query<{
        id: string;
        book_id: string;
        accession_number: string;
        status: LibraryCopy['status'];
        acquired_on: Date | null;
        notes: string | null;
      }>(
        `SELECT id, book_id, accession_number, status, acquired_on, notes
         FROM library_copies WHERE school_id = $1 AND book_id = $2
         ORDER BY accession_number`,
        [schoolId, id],
      );
      const items: LibraryCopy[] = rows.map((row) => ({
        id: row.id,
        bookId: row.book_id,
        accessionNumber: row.accession_number,
        status: row.status,
        acquiredOn: row.acquired_on ? toIsoDate(row.acquired_on) : null,
        notes: row.notes,
      }));
      return { items };
    },
  );

  app.post(
    '/api/schools/:schoolId/library/books/:id/copies',
    { preHandler: requirePermission('library.manage') },
    async (request, reply) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const input = parseInput(libraryCopyInput, request.body);
      const book = await getPool().query(
        'SELECT 1 FROM library_books WHERE school_id = $1 AND id = $2',
        [schoolId, id],
      );
      if (book.rowCount === 0) throw notFound('Book not found');
      const { rows } = await getPool().query<{ id: string }>(
        `INSERT INTO library_copies
           (school_id, book_id, accession_number, acquired_on, notes)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [schoolId, id, input.accessionNumber, input.acquiredOn ?? null, input.notes ?? null],
      );
      return reply.status(201).send({ id: rows[0]!.id });
    },
  );

  /* ---------------------------------- members ------------------------------ */

  app.get(
    '/api/schools/:schoolId/library/members',
    { preHandler: requirePermission('library.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const { rows } = await getPool().query<{
        id: string;
        member_code: string;
        student_id: string | null;
        staff_id: string | null;
        member_name: string;
        borrowing_limit: number;
        status: LibraryMember['status'];
        joined_on: Date;
        open_loans: string;
      }>(
        `SELECT m.id, m.member_code, m.student_id, m.staff_id,
                COALESCE(
                  concat_ws(' ', st.first_name, st.last_name),
                  concat_ws(' ', sf.first_name, sf.last_name),
                  m.member_code
                ) AS member_name,
                m.borrowing_limit, m.status, m.joined_on,
                (SELECT count(*) FROM library_loans l
                 WHERE l.school_id = m.school_id AND l.member_id = m.id
                   AND l.returned_on IS NULL)::text AS open_loans
         FROM library_members m
         LEFT JOIN students st ON st.id = m.student_id AND st.school_id = m.school_id
         LEFT JOIN staff sf ON sf.id = m.staff_id AND sf.school_id = m.school_id
         WHERE m.school_id = $1 ORDER BY member_name`,
        [schoolId],
      );
      const items: LibraryMember[] = rows.map((row) => ({
        id: row.id,
        memberCode: row.member_code,
        studentId: row.student_id,
        staffId: row.staff_id,
        memberName: row.member_name,
        borrowingLimit: row.borrowing_limit,
        status: row.status,
        joinedOn: toIsoDate(row.joined_on),
        openLoans: toNumber(row.open_loans),
      }));
      return { items };
    },
  );

  app.post(
    '/api/schools/:schoolId/library/members',
    { preHandler: requirePermission('library.manage') },
    async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const input = parseInput(libraryMemberInput, request.body);
      if ((input.studentId ? 1 : 0) + (input.staffId ? 1 : 0) !== 1) {
        throw badRequest('Choose either a student or a staff member, not both', {
          studentId: ['Choose exactly one member type'],
        });
      }
      const settings = await loadSettings(schoolId);
      const code =
        input.memberCode ?? (await nextMemberCode(schoolId, input.studentId ? 'STU' : 'STF'));
      const { rows } = await getPool().query<{ id: string }>(
        `INSERT INTO library_members
           (school_id, member_code, student_id, staff_id, borrowing_limit, status)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          schoolId,
          code,
          input.studentId ?? null,
          input.staffId ?? null,
          input.borrowingLimit ?? settings.defaultBorrowingLimit,
          input.status,
        ],
      );
      return reply.status(201).send({ id: rows[0]!.id, memberCode: code });
    },
  );

  app.patch(
    '/api/schools/:schoolId/library/members/:id',
    { preHandler: requirePermission('library.manage') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const input = parseInput(libraryMemberInput.partial(), request.body);
      const existing = await getPool().query<{
        borrowing_limit: number;
        status: LibraryMember['status'];
      }>(
        'SELECT borrowing_limit, status FROM library_members WHERE school_id = $1 AND id = $2',
        [schoolId, id],
      );
      const row = existing.rows[0];
      if (!row) throw notFound('Member not found');
      await getPool().query(
        `UPDATE library_members SET borrowing_limit = $3, status = $4
         WHERE school_id = $1 AND id = $2`,
        [schoolId, id, input.borrowingLimit ?? row.borrowing_limit, input.status ?? row.status],
      );
      return { id };
    },
  );

  /* ---------------------------------- loans -------------------------------- */

  app.get(
    '/api/schools/:schoolId/library/loans',
    { preHandler: requirePermission('library.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const query = parseInput(loanQuery, request.query);
      const params: unknown[] = [schoolId];
      const filters = ['l.school_id = $1'];
      if (query.status) {
        params.push(query.status);
        filters.push(`l.status = $${params.length}`);
      }
      if (query.memberId) {
        params.push(query.memberId);
        filters.push(`l.member_id = $${params.length}`);
      }
      if (query.openOnly !== 'false') filters.push('l.returned_on IS NULL');
      const { rows } = await getPool().query<{
        id: string;
        copy_id: string;
        accession_number: string;
        book_title: string;
        member_id: string;
        member_name: string;
        issued_on: Date;
        due_on: Date;
        returned_on: Date | null;
        renewed_count: number;
        status: LibraryLoan['status'];
        overdue_days: string;
      }>(
        `SELECT l.id, l.copy_id, cp.accession_number, b.title AS book_title,
                l.member_id,
                COALESCE(
                  concat_ws(' ', st.first_name, st.last_name),
                  concat_ws(' ', sf.first_name, sf.last_name),
                  m.member_code
                ) AS member_name,
                l.issued_on, l.due_on, l.returned_on, l.renewed_count, l.status,
                GREATEST(0, (COALESCE(l.returned_on, current_date) - l.due_on))::text
                  AS overdue_days
         FROM library_loans l
         JOIN library_copies cp ON cp.id = l.copy_id AND cp.school_id = l.school_id
         JOIN library_books b ON b.id = cp.book_id AND b.school_id = l.school_id
         JOIN library_members m ON m.id = l.member_id AND m.school_id = l.school_id
         LEFT JOIN students st ON st.id = m.student_id AND st.school_id = m.school_id
         LEFT JOIN staff sf ON sf.id = m.staff_id AND sf.school_id = m.school_id
         WHERE ${filters.join(' AND ')}
         ORDER BY l.issued_on DESC`,
        params,
      );
      const items: LibraryLoan[] = rows.map((row) => ({
        id: row.id,
        copyId: row.copy_id,
        accessionNumber: row.accession_number,
        bookTitle: row.book_title,
        memberId: row.member_id,
        memberName: row.member_name,
        issuedOn: toIsoDate(row.issued_on),
        dueOn: toIsoDate(row.due_on),
        returnedOn: row.returned_on ? toIsoDate(row.returned_on) : null,
        renewedCount: row.renewed_count,
        status: row.status,
        overdueDays: toNumber(row.overdue_days),
      }));
      return { items };
    },
  );

  app.post(
    '/api/schools/:schoolId/library/loans',
    { preHandler: requirePermission('library.circulation.manage') },
    idempotentRoute('POST /library/loans', async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const input = parseInput(libraryLoanInput, request.body);
      const actor = getActor(request);
      const created = await withTransaction(async (client) => {
        const settings = await loadSettings(schoolId, client);
        const copy = await client.query<{ status: LibraryCopy['status']; book_id: string }>(
          `SELECT status, book_id FROM library_copies
           WHERE school_id = $1 AND id = $2 FOR UPDATE`,
          [schoolId, input.copyId],
        );
        const copyRow = copy.rows[0];
        if (!copyRow) throw notFound('Copy not found');
        if (copyRow.status !== 'available') throw conflict('This copy is not available');

        const member = await client.query<{
          status: LibraryMember['status'];
          borrowing_limit: number;
          open_loans: string;
        }>(
          `SELECT m.status, m.borrowing_limit,
                  (SELECT count(*) FROM library_loans l
                   WHERE l.school_id = m.school_id AND l.member_id = m.id
                     AND l.returned_on IS NULL)::text AS open_loans
           FROM library_members m
           WHERE m.school_id = $1 AND m.id = $2 FOR UPDATE`,
          [schoolId, input.memberId],
        );
        const memberRow = member.rows[0];
        if (!memberRow) throw notFound('Member not found');
        if (memberRow.status !== 'active') throw conflict('This library member is not active');
        if (toNumber(memberRow.open_loans) >= memberRow.borrowing_limit) {
          throw conflict('The member has reached their borrowing limit');
        }

        const { rows } = await client.query<{ id: string; issued_on: Date; due_on: Date }>(
          `INSERT INTO library_loans
             (school_id, copy_id, member_id, issued_on, due_on, issued_by)
           VALUES ($1, $2, $3, current_date, COALESCE($4::date, current_date + $5::int), $6)
           RETURNING id, issued_on, due_on`,
          [schoolId, input.copyId, input.memberId, input.dueOn ?? null, settings.loanDays, actor.userId],
        );
        await client.query(
          `UPDATE library_copies SET status = 'issued' WHERE school_id = $1 AND id = $2`,
          [schoolId, input.copyId],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'library.loan_issued',
          entityType: 'library_loan',
          entityId: rows[0]!.id,
          outcome: 'success',
          after: { copyId: input.copyId, memberId: input.memberId },
          ...requestMeta(request),
        });
        return {
          id: rows[0]!.id,
          issuedOn: toIsoDate(rows[0]!.issued_on),
          dueOn: toIsoDate(rows[0]!.due_on),
        };
      });
      return reply.status(201).send(created);
    }),
  );

  app.post(
    '/api/schools/:schoolId/library/loans/:id/return',
    { preHandler: requirePermission('library.circulation.manage') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const input = parseInput(libraryReturnInput, request.body ?? {});
      const actor = getActor(request);
      const result = await withTransaction(async (client) => {
        const found = await client.query<{
          copy_id: string;
          book_id: string;
          due_on: Date;
          issued_on: Date;
          returned_on: Date | null;
          status: LibraryLoan['status'];
          member_id: string;
        }>(
          `SELECT l.copy_id, cp.book_id, l.due_on, l.issued_on, l.returned_on, l.status, l.member_id
           FROM library_loans l
           JOIN library_copies cp ON cp.id = l.copy_id AND cp.school_id = l.school_id
           WHERE l.school_id = $1 AND l.id = $2 FOR UPDATE`,
          [schoolId, id],
        );
        const loan = found.rows[0];
        if (!loan) throw notFound('Loan not found');
        if (loan.returned_on) throw conflict('This loan was already returned');

        const returnedOn = input.returnedOn ?? new Date().toISOString().slice(0, 10);
        if (returnedOn < toIsoDate(loan.issued_on)) {
          throw badRequest('The return date cannot be before the issue date');
        }
        const nextStatus = input.condition === 'lost' ? 'lost' : 'returned';
        await client.query(
          `UPDATE library_loans SET returned_on = $3, returned_by = $4, status = $5, notes = $6
           WHERE school_id = $1 AND id = $2`,
          [schoolId, id, returnedOn, actor.userId, nextStatus, input.notes ?? null],
        );
        const copyStatus =
          input.condition === 'lost' ? 'lost' : input.condition === 'damaged' ? 'damaged' : 'available';
        await client.query(
          `UPDATE library_copies SET status = $3 WHERE school_id = $1 AND id = $2`,
          [schoolId, loan.copy_id, copyStatus],
        );

        const settings = await loadSettings(schoolId, client);
        const overdueDays = Math.max(
          0,
          Math.round(
            (Date.parse(`${returnedOn}T00:00:00Z`) - Date.parse(`${toIsoDate(loan.due_on)}T00:00:00Z`)) /
              86_400_000,
          ),
        );
        let fineId: string | null = null;
        if (overdueDays > 0 && settings.finePerDay > 0) {
          const existingFine = await client.query(
            'SELECT 1 FROM library_fines WHERE school_id = $1 AND loan_id = $2',
            [schoolId, id],
          );
          if (existingFine.rowCount === 0) {
            const amount = Math.round(overdueDays * settings.finePerDay * 100) / 100;
            const fine = await client.query<{ id: string }>(
              `INSERT INTO library_fines
                 (school_id, loan_id, amount, reason, assessed_on, recorded_by)
               VALUES ($1, $2, $3, 'overdue', $4, $5) RETURNING id`,
              [schoolId, id, amount, returnedOn, actor.userId],
            );
            fineId = fine.rows[0]!.id;
          }
        }

        if (input.condition === 'ok') {
          const reservation = await client.query<{ id: string }>(
            `UPDATE library_reservations SET status = 'ready'
             WHERE school_id = $1 AND book_id = $2 AND status = 'pending'
               AND id = (
                 SELECT id FROM library_reservations
                 WHERE school_id = $1 AND book_id = $2 AND status = 'pending'
                 ORDER BY reserved_on, created_at LIMIT 1
               )
             RETURNING id`,
            [schoolId, loan.book_id],
          );
          void reservation;
        }

        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'library.loan_returned',
          entityType: 'library_loan',
          entityId: id,
          outcome: 'success',
          after: {
            condition: input.condition,
            returnedOn,
            fineId,
            overdueDays,
          },
          ...requestMeta(request),
        });
        return { id, fineId, overdueDays };
      });
      return result;
    },
  );

  app.post(
    '/api/schools/:schoolId/library/loans/:id/renew',
    { preHandler: requirePermission('library.circulation.manage') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const actor = getActor(request);
      const result = await withTransaction(async (client) => {
        const settings = await loadSettings(schoolId, client);
        const found = await client.query<{
          due_on: Date;
          renewed_count: number;
          returned_on: Date | null;
        }>(
          `SELECT due_on, renewed_count, returned_on FROM library_loans
           WHERE school_id = $1 AND id = $2 FOR UPDATE`,
          [schoolId, id],
        );
        const loan = found.rows[0];
        if (!loan) throw notFound('Loan not found');
        if (loan.returned_on) throw conflict('A returned loan cannot be renewed');
        if (loan.renewed_count >= settings.maxRenewals) {
          throw conflict('This loan has reached its renewal limit');
        }
        const { rows } = await client.query<{ due_on: Date }>(
          `UPDATE library_loans SET
             renewed_count = renewed_count + 1,
             due_on = due_on + $3::int
           WHERE school_id = $1 AND id = $2 RETURNING due_on`,
          [schoolId, id, settings.loanDays],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'library.loan_renewed',
          entityType: 'library_loan',
          entityId: id,
          outcome: 'success',
          after: { dueOn: toIsoDate(rows[0]!.due_on) },
          ...requestMeta(request),
        });
        return { id, dueOn: toIsoDate(rows[0]!.due_on) };
      });
      return result;
    },
  );

  /* ---------------------------------- fines -------------------------------- */

  app.get(
    '/api/schools/:schoolId/library/fines',
    { preHandler: requirePermission('library.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const query = parseInput(fineQuery, request.query);
      const params: unknown[] = [schoolId];
      let filter = '';
      if (query.status) {
        params.push(query.status);
        filter = `AND f.status = $${params.length}`;
      }
      const { rows } = await getPool().query<{
        id: string;
        loan_id: string;
        member_name: string;
        book_title: string;
        amount: string;
        reason: LibraryFine['reason'];
        status: LibraryFine['status'];
        assessed_on: Date;
        paid_on: Date | null;
      }>(
        `SELECT f.id, f.loan_id,
                COALESCE(
                  concat_ws(' ', st.first_name, st.last_name),
                  concat_ws(' ', sf.first_name, sf.last_name),
                  m.member_code
                ) AS member_name,
                b.title AS book_title, f.amount, f.reason, f.status, f.assessed_on, f.paid_on
         FROM library_fines f
         JOIN library_loans l ON l.id = f.loan_id AND l.school_id = f.school_id
         JOIN library_copies cp ON cp.id = l.copy_id AND cp.school_id = l.school_id
         JOIN library_books b ON b.id = cp.book_id AND b.school_id = l.school_id
         JOIN library_members m ON m.id = l.member_id AND m.school_id = l.school_id
         LEFT JOIN students st ON st.id = m.student_id AND st.school_id = m.school_id
         LEFT JOIN staff sf ON sf.id = m.staff_id AND sf.school_id = m.school_id
         WHERE f.school_id = $1 ${filter}
         ORDER BY f.assessed_on DESC`,
        params,
      );
      const items: LibraryFine[] = rows.map((row) => ({
        id: row.id,
        loanId: row.loan_id,
        memberName: row.member_name,
        bookTitle: row.book_title,
        amount: toNumber(row.amount),
        reason: row.reason,
        status: row.status,
        assessedOn: toIsoDate(row.assessed_on),
        paidOn: row.paid_on ? toIsoDate(row.paid_on) : null,
      }));
      return { items };
    },
  );

  app.post(
    '/api/schools/:schoolId/library/fines',
    { preHandler: requirePermission('library.circulation.manage') },
    async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const input = parseInput(libraryFineInput, request.body);
      const actor = getActor(request);
      const loan = await getPool().query(
        'SELECT 1 FROM library_loans WHERE school_id = $1 AND id = $2',
        [schoolId, input.loanId],
      );
      if (loan.rowCount === 0) throw notFound('Loan not found');
      const existing = await getPool().query(
        'SELECT 1 FROM library_fines WHERE school_id = $1 AND loan_id = $2',
        [schoolId, input.loanId],
      );
      if (existing.rowCount) throw conflict('This loan already has a fine');
      const { rows } = await getPool().query<{ id: string }>(
        `INSERT INTO library_fines
           (school_id, loan_id, amount, reason, recorded_by, notes)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [schoolId, input.loanId, input.amount, input.reason, actor.userId, input.notes ?? null],
      );
      await recordAudit(getPool(), {
        schoolId,
        actorUserId: actor.userId,
        action: 'library.fine_assessed',
        entityType: 'library_fine',
        entityId: rows[0]!.id,
        outcome: 'success',
        after: { loanId: input.loanId, amount: input.amount, reason: input.reason },
        ...requestMeta(request),
      });
      return reply.status(201).send({ id: rows[0]!.id });
    },
  );

  app.post(
    '/api/schools/:schoolId/library/fines/:id/decision',
    { preHandler: requirePermission('library.circulation.manage') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const input = parseInput(fineDecisionInput, request.body);
      const actor = getActor(request);
      const { rows } = await getPool().query<{ id: string }>(
        `UPDATE library_fines SET
           status = $3,
           paid_on = CASE WHEN $3 = 'paid' THEN current_date ELSE NULL END
         WHERE school_id = $1 AND id = $2 AND status = 'pending' RETURNING id`,
        [schoolId, id, input.decision === 'pay' ? 'paid' : 'waived'],
      );
      if (!rows[0]) throw conflict('Only a pending fine can be settled');
      await recordAudit(getPool(), {
        schoolId,
        actorUserId: actor.userId,
        action: 'library.fine_settled',
        entityType: 'library_fine',
        entityId: id,
        outcome: 'success',
        after: { decision: input.decision },
        ...requestMeta(request),
      });
      return { id, status: input.decision === 'pay' ? 'paid' : 'waived' };
    },
  );

  /* ------------------------------- reservations ---------------------------- */

  app.get(
    '/api/schools/:schoolId/library/reservations',
    { preHandler: requirePermission('library.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const { rows } = await getPool().query<{
        id: string;
        book_id: string;
        book_title: string;
        member_id: string;
        member_name: string;
        reserved_on: Date;
        expires_on: Date | null;
        status: LibraryReservation['status'];
      }>(
        `SELECT r.id, r.book_id, b.title AS book_title, r.member_id,
                COALESCE(
                  concat_ws(' ', st.first_name, st.last_name),
                  concat_ws(' ', sf.first_name, sf.last_name),
                  m.member_code
                ) AS member_name,
                r.reserved_on, r.expires_on, r.status
         FROM library_reservations r
         JOIN library_books b ON b.id = r.book_id AND b.school_id = r.school_id
         JOIN library_members m ON m.id = r.member_id AND m.school_id = r.school_id
         LEFT JOIN students st ON st.id = m.student_id AND st.school_id = m.school_id
         LEFT JOIN staff sf ON sf.id = m.staff_id AND sf.school_id = m.school_id
         WHERE r.school_id = $1 ORDER BY r.reserved_on DESC`,
        [schoolId],
      );
      const items: LibraryReservation[] = rows.map((row) => ({
        id: row.id,
        bookId: row.book_id,
        bookTitle: row.book_title,
        memberId: row.member_id,
        memberName: row.member_name,
        reservedOn: toIsoDate(row.reserved_on),
        expiresOn: row.expires_on ? toIsoDate(row.expires_on) : null,
        status: row.status,
      }));
      return { items };
    },
  );

  app.post(
    '/api/schools/:schoolId/library/reservations',
    { preHandler: requirePermission('library.circulation.manage') },
    async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const input = parseInput(libraryReservationInput, request.body);
      const actor = getActor(request);
      const { rows } = await getPool().query<{ id: string }>(
        `INSERT INTO library_reservations
           (school_id, book_id, member_id, expires_on, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [schoolId, input.bookId, input.memberId, input.expiresOn ?? null, actor.userId],
      );
      return reply.status(201).send({ id: rows[0]!.id });
    },
  );

  app.patch(
    '/api/schools/:schoolId/library/reservations/:id',
    { preHandler: requirePermission('library.circulation.manage') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const input = parseInput(
        z.object({ status: z.enum(['pending', 'ready', 'fulfilled', 'cancelled', 'expired']) }),
        request.body,
      );
      const { rows } = await getPool().query<{ id: string }>(
        `UPDATE library_reservations SET status = $3
         WHERE school_id = $1 AND id = $2 RETURNING id`,
        [schoolId, id, input.status],
      );
      if (!rows[0]) throw notFound('Reservation not found');
      return { id, status: input.status };
    },
  );

  /* --------------------------------- settings ------------------------------ */

  app.get(
    '/api/schools/:schoolId/library/settings',
    { preHandler: requirePermission('library.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      return loadSettings(schoolId);
    },
  );

  app.put(
    '/api/schools/:schoolId/library/settings',
    { preHandler: requirePermission('library.settings.manage') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const input = parseInput(librarySettingsInput, request.body);
      const actor = getActor(request);
      await getPool().query(
        `INSERT INTO library_settings
           (school_id, loan_days, fine_per_day, max_renewals, default_borrowing_limit)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (school_id) DO UPDATE SET
           loan_days = EXCLUDED.loan_days,
           fine_per_day = EXCLUDED.fine_per_day,
           max_renewals = EXCLUDED.max_renewals,
           default_borrowing_limit = EXCLUDED.default_borrowing_limit,
           updated_at = now()`,
        [
          schoolId,
          input.loanDays,
          input.finePerDay,
          input.maxRenewals,
          input.defaultBorrowingLimit,
        ],
      );
      await recordAudit(getPool(), {
        schoolId,
        actorUserId: actor.userId,
        action: 'library.settings_updated',
        entityType: 'library_settings',
        entityId: schoolId,
        outcome: 'success',
        after: input,
        ...requestMeta(request),
      });
      return input satisfies LibrarySettings;
    },
  );
}

/* --------------------------------- helpers -------------------------------- */

type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

async function loadSettings(
  schoolId: string,
  client: Queryable = getPool(),
): Promise<LibrarySettings> {
  const { rows } = await client.query<{
    loan_days: number;
    fine_per_day: string;
    max_renewals: number;
    default_borrowing_limit: number;
  }>(
    `SELECT loan_days, fine_per_day, max_renewals, default_borrowing_limit
     FROM library_settings WHERE school_id = $1`,
    [schoolId],
  );
  const row = rows[0];
  if (!row) {
    return { loanDays: 14, finePerDay: 5, maxRenewals: 1, defaultBorrowingLimit: 3 };
  }
  return {
    loanDays: row.loan_days,
    finePerDay: toNumber(row.fine_per_day),
    maxRenewals: row.max_renewals,
    defaultBorrowingLimit: row.default_borrowing_limit,
  };
}

async function nextAccession(client: Queryable, schoolId: string): Promise<string> {
  const { rows } = await client.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM library_copies WHERE school_id = $1',
    [schoolId],
  );
  return `ACC-${String(Number(rows[0]?.count ?? 0) + 1).padStart(6, '0')}`;
}

async function nextMemberCode(schoolId: string, prefix: string): Promise<string> {
  const { rows } = await getPool().query<{ count: string }>(
    'SELECT count(*)::text AS count FROM library_members WHERE school_id = $1',
    [schoolId],
  );
  return `${prefix}-${String(Number(rows[0]?.count ?? 0) + 1).padStart(5, '0')}`;
}
