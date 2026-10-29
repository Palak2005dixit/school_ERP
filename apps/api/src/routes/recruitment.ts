import {
  candidateInput,
  candidateInterviewInput,
  candidateStageInput,
  employeeChangeInput,
  interviewOutcomeInput,
  jobOfferDecisionInput,
  jobOfferInput,
  onboardingCompleteInput,
  onboardingTaskInput,
  separationDecisionInput,
  separationInput,
  uuid,
  vacancyInput,
  vacancyUpdate,
  type Candidate,
  type CandidateInterview,
  type EmployeeChange,
  type ExitTask,
  type JobOffer,
  type OnboardingTask,
  type StaffSeparation,
  type Vacancy,
} from '@erp/shared';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { getActor, requirePermission, requestMeta } from '../auth/guards';
import { getPool, withTransaction } from '../db';
import { recordAudit } from '../lib/audit';
import { badRequest, conflict, notFound, parseInput } from '../lib/errors';
import { toIsoDate, toIsoDateTime, toNumber } from '../lib/format';
import { idempotentRoute } from '../lib/idempotency';

const schoolParams = z.object({ schoolId: uuid });
const idParams = z.object({ schoolId: uuid, id: uuid });
const candidateQuery = z.object({
  vacancyId: uuid.optional(),
  stage: z
    .enum(['applied', 'screening', 'interview', 'offer', 'hired', 'rejected', 'withdrawn'])
    .optional(),
});
const hireInput = z.object({
  employeeNumber: z.string().trim().min(1).max(40).optional(),
  joinedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/**
 * Recruitment to separation. Candidate contact details and salary are personal
 * data: reads use the recruitment permissions and audit entries never copy
 * email, phone or salary values. An accepted offer is converted to a staff
 * record through an explicit hire action so a duplicate employee cannot be
 * created by re-saving the offer.
 */
export async function registerRecruitmentRoutes(app: FastifyInstance): Promise<void> {
  /* -------------------------------- vacancies ------------------------------ */

  app.get(
    '/api/schools/:schoolId/vacancies',
    { preHandler: requirePermission('hr.recruitment.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const { rows } = await getPool().query<{
        id: string;
        reference: string;
        title: string;
        department: string | null;
        designation: string;
        employment_type: Vacancy['employmentType'];
        openings: number;
        description: string | null;
        status: Vacancy['status'];
        posted_on: string | null;
        closes_on: string | null;
        candidate_count: string;
      }>(
        `SELECT v.id, v.reference, v.title, v.department, v.designation,
                v.employment_type, v.openings, v.description, v.status,
                v.posted_on, v.closes_on,
                (SELECT count(*) FROM candidates c
                 WHERE c.school_id = v.school_id AND c.vacancy_id = v.id)::text
                  AS candidate_count
         FROM vacancies v WHERE v.school_id = $1
         ORDER BY v.created_at DESC`,
        [schoolId],
      );
      const items: Vacancy[] = rows.map((row) => ({
        id: row.id,
        reference: row.reference,
        title: row.title,
        department: row.department,
        designation: row.designation,
        employmentType: row.employment_type,
        openings: row.openings,
        description: row.description,
        status: row.status,
        postedOn: row.posted_on ? toIsoDate(row.posted_on) : null,
        closesOn: row.closes_on ? toIsoDate(row.closes_on) : null,
        candidateCount: toNumber(row.candidate_count),
      }));
      return { items };
    },
  );

  app.post(
    '/api/schools/:schoolId/vacancies',
    { preHandler: requirePermission('hr.recruitment.manage') },
    async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const input = parseInput(vacancyInput, request.body);
      const actor = getActor(request);
      const reference = input.reference ?? (await nextVacancyReference(schoolId));
      const { rows } = await getPool().query<{ id: string }>(
        `INSERT INTO vacancies
           (school_id, reference, title, department, designation, employment_type,
            openings, description, status, posted_on, closes_on, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id`,
        [
          schoolId,
          reference,
          input.title,
          input.department ?? null,
          input.designation,
          input.employmentType,
          input.openings,
          input.description ?? null,
          input.status,
          input.postedOn ?? null,
          input.closesOn ?? null,
          actor.userId,
        ],
      );
      await recordAudit(getPool(), {
        schoolId,
        actorUserId: actor.userId,
        action: 'hr.vacancy_created',
        entityType: 'vacancy',
        entityId: rows[0]!.id,
        outcome: 'success',
        after: { reference, title: input.title, status: input.status },
        ...requestMeta(request),
      });
      return reply.status(201).send({ id: rows[0]!.id, reference });
    },
  );

  app.patch(
    '/api/schools/:schoolId/vacancies/:id',
    { preHandler: requirePermission('hr.recruitment.manage') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const input = parseInput(vacancyUpdate, request.body);
      const existing = await getPool().query(
        'SELECT 1 FROM vacancies WHERE school_id = $1 AND id = $2',
        [schoolId, id],
      );
      if (existing.rowCount === 0) throw notFound('Vacancy not found');
      await getPool().query(
        `UPDATE vacancies SET
           title = COALESCE($3, title), department = COALESCE($4, department),
           designation = COALESCE($5, designation),
           employment_type = COALESCE($6, employment_type),
           openings = COALESCE($7, openings),
           description = COALESCE($8, description), status = COALESCE($9, status),
           posted_on = COALESCE($10, posted_on), closes_on = COALESCE($11, closes_on)
         WHERE school_id = $1 AND id = $2`,
        [
          schoolId,
          id,
          input.title ?? null,
          input.department ?? null,
          input.designation ?? null,
          input.employmentType ?? null,
          input.openings ?? null,
          input.description ?? null,
          input.status ?? null,
          input.postedOn ?? null,
          input.closesOn ?? null,
        ],
      );
      const actor = getActor(request);
      await recordAudit(getPool(), {
        schoolId,
        actorUserId: actor.userId,
        action: 'hr.vacancy_updated',
        entityType: 'vacancy',
        entityId: id,
        outcome: 'success',
        after: input,
        ...requestMeta(request),
      });
      return { id };
    },
  );

  /* -------------------------------- candidates ----------------------------- */

  app.get(
    '/api/schools/:schoolId/candidates',
    { preHandler: requirePermission('hr.recruitment.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const query = parseInput(candidateQuery, request.query);
      const params: unknown[] = [schoolId];
      const filters = ['c.school_id = $1'];
      if (query.vacancyId) {
        params.push(query.vacancyId);
        filters.push(`c.vacancy_id = $${params.length}`);
      }
      if (query.stage) {
        params.push(query.stage);
        filters.push(`c.stage = $${params.length}`);
      }
      const { rows } = await getPool().query<{
        id: string;
        vacancy_id: string;
        vacancy_title: string;
        first_name: string;
        last_name: string | null;
        email: string;
        phone: string | null;
        stage: Candidate['stage'];
        source: string | null;
        applied_on: string;
        converted_staff_id: string | null;
        interview_count: string;
      }>(
        `SELECT c.id, c.vacancy_id, v.title AS vacancy_title, c.first_name, c.last_name,
                c.email, c.phone, c.stage, c.source, c.applied_on,
                c.converted_staff_id,
                (SELECT count(*) FROM candidate_interviews i
                 WHERE i.school_id = c.school_id AND i.candidate_id = c.id)::text
                  AS interview_count
         FROM candidates c
         JOIN vacancies v ON v.id = c.vacancy_id AND v.school_id = c.school_id
         WHERE ${filters.join(' AND ')}
         ORDER BY c.applied_on DESC, c.created_at DESC
         LIMIT 500`,
        params,
      );
      const items: Candidate[] = rows.map((row) => ({
        id: row.id,
        vacancyId: row.vacancy_id,
        vacancyTitle: row.vacancy_title,
        firstName: row.first_name,
        lastName: row.last_name,
        fullName: [row.first_name, row.last_name].filter(Boolean).join(' '),
        email: row.email,
        phone: row.phone,
        stage: row.stage,
        source: row.source,
        appliedOn: toIsoDate(row.applied_on),
        convertedStaffId: row.converted_staff_id,
        interviewCount: toNumber(row.interview_count),
      }));
      return { items };
    },
  );

  app.post(
    '/api/schools/:schoolId/candidates',
    { preHandler: requirePermission('hr.recruitment.manage') },
    async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const input = parseInput(candidateInput, request.body);
      const actor = getActor(request);
      const vacancy = await getPool().query<{ status: string }>(
        'SELECT status FROM vacancies WHERE school_id = $1 AND id = $2',
        [schoolId, input.vacancyId],
      );
      if (!vacancy.rows[0]) throw notFound('Vacancy not found');
      const { rows } = await getPool().query<{ id: string }>(
        `INSERT INTO candidates
           (school_id, vacancy_id, first_name, last_name, email, phone, source,
            notes, applied_on, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::date, current_date), $10)
         RETURNING id`,
        [
          schoolId,
          input.vacancyId,
          input.firstName,
          input.lastName ?? null,
          input.email,
          input.phone ?? null,
          input.source ?? null,
          input.notes ?? null,
          input.appliedOn ?? null,
          actor.userId,
        ],
      );
      await recordAudit(getPool(), {
        schoolId,
        actorUserId: actor.userId,
        action: 'hr.candidate_created',
        entityType: 'candidate',
        entityId: rows[0]!.id,
        outcome: 'success',
        after: { vacancyId: input.vacancyId, stage: 'applied' },
        ...requestMeta(request),
      });
      return reply.status(201).send({ id: rows[0]!.id });
    },
  );

  app.patch(
    '/api/schools/:schoolId/candidates/:id/stage',
    { preHandler: requirePermission('hr.recruitment.manage') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const input = parseInput(candidateStageInput, request.body);
      const actor = getActor(request);
      const current = await getPool().query<{ stage: string; converted_staff_id: string | null }>(
        'SELECT stage, converted_staff_id FROM candidates WHERE school_id = $1 AND id = $2',
        [schoolId, id],
      );
      const row = current.rows[0];
      if (!row) throw notFound('Candidate not found');
      if (row.stage === 'hired' && input.stage !== 'hired') {
        throw conflict('A hired candidate cannot be moved back');
      }
      if (input.stage === 'hired') {
        throw badRequest('Use the hire action on an accepted offer to create the staff record');
      }
      await getPool().query(
        `UPDATE candidates SET stage = $3 WHERE school_id = $1 AND id = $2`,
        [schoolId, id, input.stage],
      );
      await recordAudit(getPool(), {
        schoolId,
        actorUserId: actor.userId,
        action: 'hr.candidate_stage_changed',
        entityType: 'candidate',
        entityId: id,
        outcome: 'success',
        before: { stage: row.stage },
        after: { stage: input.stage },
        ...requestMeta(request),
      });
      return { id, stage: input.stage };
    },
  );

  /* -------------------------------- interviews ----------------------------- */

  app.get(
    '/api/schools/:schoolId/candidates/:id/interviews',
    { preHandler: requirePermission('hr.recruitment.view') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const { rows } = await getPool().query<{
        id: string;
        candidate_id: string;
        scheduled_at: Date;
        mode: CandidateInterview['mode'];
        interviewer_user_id: string;
        interviewer_name: string | null;
        status: CandidateInterview['status'];
        score: number | null;
        recommendation: CandidateInterview['recommendation'];
        feedback: string | null;
      }>(
        `SELECT i.id, i.candidate_id, i.scheduled_at, i.mode, i.interviewer_user_id,
                u.display_name AS interviewer_name, i.status, i.score,
                i.recommendation, i.feedback
         FROM candidate_interviews i
         LEFT JOIN users u ON u.id = i.interviewer_user_id
         WHERE i.school_id = $1 AND i.candidate_id = $2
         ORDER BY i.scheduled_at DESC`,
        [schoolId, id],
      );
      const items: CandidateInterview[] = rows.map((row) => ({
        id: row.id,
        candidateId: row.candidate_id,
        scheduledAt: toIsoDateTime(row.scheduled_at),
        mode: row.mode,
        interviewerUserId: row.interviewer_user_id,
        interviewerName: row.interviewer_name,
        status: row.status,
        score: row.score,
        recommendation: row.recommendation,
        feedback: row.feedback,
      }));
      return { items };
    },
  );

  app.post(
    '/api/schools/:schoolId/candidates/:id/interviews',
    { preHandler: requirePermission('hr.recruitment.manage') },
    async (request, reply) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const input = parseInput(candidateInterviewInput, request.body);
      const actor = getActor(request);
      const candidate = await getPool().query(
        'SELECT 1 FROM candidates WHERE school_id = $1 AND id = $2',
        [schoolId, id],
      );
      if (candidate.rowCount === 0) throw notFound('Candidate not found');
      const interviewer = await getPool().query(
        `SELECT 1 FROM user_role_assignments
         WHERE school_id = $1 AND user_id = $2 AND revoked_at IS NULL
           AND (valid_to IS NULL OR valid_to > now())`,
        [schoolId, input.interviewerUserId],
      );
      if (interviewer.rowCount === 0) {
        throw badRequest('Choose an active staff member of this school as the interviewer');
      }
      const { rows } = await getPool().query<{ id: string }>(
        `INSERT INTO candidate_interviews
           (school_id, candidate_id, scheduled_at, mode, interviewer_user_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [schoolId, id, input.scheduledAt, input.mode, input.interviewerUserId, actor.userId],
      );
      await getPool().query(
        `UPDATE candidates SET stage = 'interview'
         WHERE school_id = $1 AND id = $2 AND stage IN ('applied', 'screening')`,
        [schoolId, id],
      );
      await recordAudit(getPool(), {
        schoolId,
        actorUserId: actor.userId,
        action: 'hr.interview_scheduled',
        entityType: 'candidate_interview',
        entityId: rows[0]!.id,
        outcome: 'success',
        after: { candidateId: id, scheduledAt: input.scheduledAt, mode: input.mode },
        ...requestMeta(request),
      });
      return reply.status(201).send({ id: rows[0]!.id });
    },
  );

  app.patch(
    '/api/schools/:schoolId/interviews/:id',
    { preHandler: requirePermission('hr.recruitment.manage') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const input = parseInput(interviewOutcomeInput, request.body);
      if (input.status === 'cancelled' && (input.score || input.recommendation)) {
        throw badRequest('A cancelled interview cannot carry a score or recommendation');
      }
      const actor = getActor(request);
      const { rows } = await getPool().query<{ candidate_id: string }>(
        `UPDATE candidate_interviews SET
           status = $3, score = $4, recommendation = $5, feedback = $6
         WHERE school_id = $1 AND id = $2
         RETURNING candidate_id`,
        [
          schoolId,
          id,
          input.status,
          input.score ?? null,
          input.recommendation ?? null,
          input.feedback ?? null,
        ],
      );
      if (!rows[0]) throw notFound('Interview not found');
      await recordAudit(getPool(), {
        schoolId,
        actorUserId: actor.userId,
        action: 'hr.interview_recorded',
        entityType: 'candidate_interview',
        entityId: id,
        outcome: 'success',
        after: { status: input.status, score: input.score ?? null },
        ...requestMeta(request),
      });
      return { id, status: input.status };
    },
  );

  /* ---------------------------------- offers -------------------------------- */

  app.get(
    '/api/schools/:schoolId/job-offers',
    { preHandler: requirePermission('hr.recruitment.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const { rows } = await getPool().query<{
        id: string;
        candidate_id: string;
        candidate_name: string;
        designation: string;
        department: string | null;
        gross_salary: string;
        currency: string;
        starts_on: string;
        status: JobOffer['status'];
        notes: string | null;
      }>(
        `SELECT o.id, o.candidate_id,
                concat_ws(' ', c.first_name, c.last_name) AS candidate_name,
                o.designation, o.department, o.gross_salary, o.currency, o.starts_on,
                o.status, o.notes
         FROM job_offers o
         JOIN candidates c ON c.id = o.candidate_id AND c.school_id = o.school_id
         WHERE o.school_id = $1 ORDER BY o.created_at DESC`,
        [schoolId],
      );
      const items: JobOffer[] = rows.map((row) => ({
        id: row.id,
        candidateId: row.candidate_id,
        candidateName: row.candidate_name,
        designation: row.designation,
        department: row.department,
        grossSalary: toNumber(row.gross_salary),
        currency: row.currency,
        startsOn: toIsoDate(row.starts_on),
        status: row.status,
        notes: row.notes,
      }));
      return { items };
    },
  );

  app.post(
    '/api/schools/:schoolId/job-offers',
    { preHandler: requirePermission('hr.recruitment.manage') },
    async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const input = parseInput(jobOfferInput, request.body);
      const candidate = await getPool().query(
        'SELECT 1 FROM candidates WHERE school_id = $1 AND id = $2',
        [schoolId, input.candidateId],
      );
      if (candidate.rowCount === 0) throw notFound('Candidate not found');
      const actor = getActor(request);
      const { rows } = await getPool().query<{ id: string }>(
        `INSERT INTO job_offers
           (school_id, candidate_id, designation, department, gross_salary, currency,
            starts_on, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [
          schoolId,
          input.candidateId,
          input.designation,
          input.department ?? null,
          input.grossSalary,
          input.currency,
          input.startsOn,
          input.notes ?? null,
          actor.userId,
        ],
      );
      await getPool().query(
        `UPDATE candidates SET stage = 'offer'
         WHERE school_id = $1 AND id = $2 AND stage <> 'hired'`,
        [schoolId, input.candidateId],
      );
      await recordAudit(getPool(), {
        schoolId,
        actorUserId: actor.userId,
        action: 'hr.job_offer_created',
        entityType: 'job_offer',
        entityId: rows[0]!.id,
        outcome: 'success',
        after: { candidateId: input.candidateId, designation: input.designation },
        ...requestMeta(request),
      });
      return reply.status(201).send({ id: rows[0]!.id });
    },
  );

  const transitions: Record<
    string,
    { from: JobOffer['status'][]; to: JobOffer['status']; approval: boolean }
  > = {
    submit: { from: ['draft'], to: 'pending_approval', approval: false },
    approve: { from: ['pending_approval'], to: 'approved', approval: true },
    reject: { from: ['pending_approval'], to: 'rejected', approval: true },
    accept: { from: ['approved'], to: 'accepted', approval: false },
    decline: { from: ['approved'], to: 'declined', approval: false },
    cancel: { from: ['draft', 'pending_approval'], to: 'cancelled', approval: false },
  };

  app.post(
    '/api/schools/:schoolId/job-offers/:id/decision',
    { preHandler: requirePermission('hr.recruitment.manage') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const input = parseInput(jobOfferDecisionInput, request.body);
      const actor = getActor(request);
      const offer = await getPool().query<{ status: JobOffer['status']; created_by: string }>(
        'SELECT status, created_by FROM job_offers WHERE school_id = $1 AND id = $2 FOR UPDATE',
        [schoolId, id],
      );
      const row = offer.rows[0];
      if (!row) throw notFound('Offer not found');
      const transition = transitions[input.decision];
      if (!transition) throw badRequest('Unknown decision');
      if (!transition.from.includes(row.status)) {
        throw conflict(`An offer in ${row.status} cannot be ${input.decision}d`);
      }
      if (transition.approval && row.created_by === actor.userId) {
        throw conflict('A job offer cannot be approved by the person who created it');
      }
      if (transition.approval && !getActor(request).permissions.has('hr.recruitment.approve')) {
        throw conflict('You do not have permission to approve job offers');
      }
      await getPool().query(
        `UPDATE job_offers SET
           status = $3,
           approved_by = CASE WHEN $4 THEN $5 ELSE approved_by END,
           approved_at = CASE WHEN $4 THEN now() ELSE approved_at END
         WHERE school_id = $1 AND id = $2`,
        [schoolId, id, transition.to, transition.approval, actor.userId],
      );
      await recordAudit(getPool(), {
        schoolId,
        actorUserId: actor.userId,
        action: 'hr.job_offer_decision',
        entityType: 'job_offer',
        entityId: id,
        outcome: 'success',
        before: { status: row.status },
        after: { status: transition.to, decision: input.decision },
        ...requestMeta(request),
      });
      return { id, status: transition.to };
    },
  );

  app.post(
    '/api/schools/:schoolId/job-offers/:id/hire',
    { preHandler: requirePermission('hr.recruitment.manage') },
    idempotentRoute('POST /job-offers/hire', async (request, reply) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const input = parseInput(hireInput, request.body ?? {});
      const actor = getActor(request);
      const staffId = await withTransaction(async (client) => {
        const found = await client.query<{
          status: JobOffer['status'];
          candidate_id: string;
          designation: string;
          department: string | null;
          starts_on: string;
          first_name: string;
          last_name: string | null;
          email: string;
          phone: string | null;
          converted_staff_id: string | null;
        }>(
          `SELECT o.status, o.candidate_id, o.designation, o.department, o.starts_on,
                  c.first_name, c.last_name, c.email, c.phone, c.converted_staff_id
           FROM job_offers o
           JOIN candidates c ON c.id = o.candidate_id AND c.school_id = o.school_id
           WHERE o.school_id = $1 AND o.id = $2 FOR UPDATE`,
          [schoolId, id],
        );
        const offer = found.rows[0];
        if (!offer) throw notFound('Offer not found');
        if (offer.status !== 'accepted') {
          throw conflict('Only an accepted offer can be converted to a staff record');
        }
        if (offer.converted_staff_id) throw conflict('This candidate is already an employee');

        const employeeNumber =
          input.employeeNumber ?? (await nextEmployeeNumber(client, schoolId));
        const staff = await client.query<{ id: string }>(
          `INSERT INTO staff
             (school_id, employee_number, first_name, last_name, email, phone,
              designation, department, joined_on, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active')
           RETURNING id`,
          [
            schoolId,
            employeeNumber,
            offer.first_name,
            offer.last_name,
            offer.email,
            offer.phone,
            offer.designation,
            offer.department,
            input.joinedOn ?? toIsoDate(offer.starts_on),
          ],
        );
        const newStaffId = staff.rows[0]!.id;
        await client.query(
          `UPDATE candidates SET stage = 'hired', converted_staff_id = $3
           WHERE school_id = $1 AND id = $2`,
          [schoolId, offer.candidate_id, newStaffId],
        );
        for (const title of [
          'Collect signed employment contract',
          'Create school email and user account',
          'Complete payroll and bank details',
          'Assign induction mentor',
        ]) {
          await client.query(
            `INSERT INTO onboarding_tasks (school_id, staff_id, title, owner_user_id)
             VALUES ($1, $2, $3, $4)`,
            [schoolId, newStaffId, title, actor.userId],
          );
        }
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'hr.candidate_hired',
          entityType: 'staff',
          entityId: newStaffId,
          outcome: 'success',
          after: { candidateId: offer.candidate_id, offerId: id, employeeNumber },
          ...requestMeta(request),
        });
        return newStaffId;
      });
      return reply.status(201).send({ staffId });
    }),
  );

  /* ------------------------------- onboarding ------------------------------ */

  app.get(
    '/api/schools/:schoolId/onboarding-tasks',
    { preHandler: requirePermission('hr.onboarding.manage') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const { rows } = await getPool().query<{
        id: string;
        staff_id: string;
        staff_name: string;
        title: string;
        owner_user_id: string | null;
        owner_name: string | null;
        due_on: string | null;
        status: OnboardingTask['status'];
        completed_at: Date | null;
      }>(
        `SELECT t.id, t.staff_id, concat_ws(' ', s.first_name, s.last_name) AS staff_name,
                t.title, t.owner_user_id, u.display_name AS owner_name, t.due_on,
                t.status, t.completed_at
         FROM onboarding_tasks t
         JOIN staff s ON s.id = t.staff_id AND s.school_id = t.school_id
         LEFT JOIN users u ON u.id = t.owner_user_id
         WHERE t.school_id = $1 ORDER BY t.status, t.due_on NULLS LAST, t.created_at`,
        [schoolId],
      );
      const items: OnboardingTask[] = rows.map((row) => ({
        id: row.id,
        staffId: row.staff_id,
        staffName: row.staff_name,
        title: row.title,
        ownerUserId: row.owner_user_id,
        ownerName: row.owner_name,
        dueOn: row.due_on ? toIsoDate(row.due_on) : null,
        status: row.status,
        completedAt: row.completed_at ? toIsoDateTime(row.completed_at) : null,
      }));
      return { items };
    },
  );

  app.post(
    '/api/schools/:schoolId/onboarding-tasks',
    { preHandler: requirePermission('hr.onboarding.manage') },
    async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const input = parseInput(onboardingTaskInput, request.body);
      const staff = await getPool().query(
        'SELECT 1 FROM staff WHERE school_id = $1 AND id = $2',
        [schoolId, input.staffId],
      );
      if (staff.rowCount === 0) throw notFound('Staff member not found');
      const { rows } = await getPool().query<{ id: string }>(
        `INSERT INTO onboarding_tasks (school_id, staff_id, title, owner_user_id, due_on)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [schoolId, input.staffId, input.title, input.ownerUserId ?? null, input.dueOn ?? null],
      );
      return reply.status(201).send({ id: rows[0]!.id });
    },
  );

  app.patch(
    '/api/schools/:schoolId/onboarding-tasks/:id',
    { preHandler: requirePermission('hr.onboarding.manage') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const input = parseInput(onboardingCompleteInput, request.body);
      const actor = getActor(request);
      const { rows } = await getPool().query<{ id: string }>(
        `UPDATE onboarding_tasks SET
           status = $3,
           completed_at = CASE WHEN $3 = 'done' THEN now() ELSE NULL END,
           completed_by = CASE WHEN $3 = 'done' THEN $4 ELSE NULL END
         WHERE school_id = $1 AND id = $2 RETURNING id`,
        [schoolId, id, input.status, actor.userId],
      );
      if (!rows[0]) throw notFound('Task not found');
      return { id, status: input.status };
    },
  );

  /* ----------------------------- employee changes -------------------------- */

  app.get(
    '/api/schools/:schoolId/employee-changes',
    { preHandler: requirePermission('hr.employee.view') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const { rows } = await getPool().query<{
        id: string;
        staff_id: string;
        staff_name: string;
        change_type: EmployeeChange['changeType'];
        effective_on: string;
        from_value: string | null;
        to_value: string;
        notes: string | null;
      }>(
        `SELECT ch.id, ch.staff_id, concat_ws(' ', s.first_name, s.last_name) AS staff_name,
                ch.change_type, ch.effective_on, ch.from_value, ch.to_value, ch.notes
         FROM employee_changes ch
         JOIN staff s ON s.id = ch.staff_id AND s.school_id = ch.school_id
         WHERE ch.school_id = $1 ORDER BY ch.effective_on DESC, ch.created_at DESC`,
        [schoolId],
      );
      const items: EmployeeChange[] = rows.map((row) => ({
        id: row.id,
        staffId: row.staff_id,
        staffName: row.staff_name,
        changeType: row.change_type,
        effectiveOn: toIsoDate(row.effective_on),
        fromValue: row.from_value,
        toValue: row.to_value,
        notes: row.notes,
      }));
      return { items };
    },
  );

  app.post(
    '/api/schools/:schoolId/employee-changes',
    { preHandler: requirePermission('hr.onboarding.manage') },
    async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const input = parseInput(employeeChangeInput, request.body);
      const actor = getActor(request);
      const id = await withTransaction(async (client) => {
        const staff = await client.query<{
          department: string | null;
          designation: string;
          status: string;
        }>(
          'SELECT department, designation, status FROM staff WHERE school_id = $1 AND id = $2 FOR UPDATE',
          [schoolId, input.staffId],
        );
        const row = staff.rows[0];
        if (!row) throw notFound('Staff member not found');
        const fromValue =
          input.changeType === 'department'
            ? row.department
            : input.changeType === 'designation'
              ? row.designation
              : input.changeType === 'status'
                ? row.status
                : null;

        const column =
          input.changeType === 'department'
            ? 'department'
            : input.changeType === 'designation'
              ? 'designation'
              : input.changeType === 'status'
                ? 'status'
                : null;
        if (column) {
          await client.query(
            `UPDATE staff SET ${column} = $3 WHERE school_id = $1 AND id = $2`,
            [schoolId, input.staffId, input.toValue],
          );
        }
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO employee_changes
             (school_id, staff_id, change_type, effective_on, from_value, to_value,
              notes, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [
            schoolId,
            input.staffId,
            input.changeType,
            input.effectiveOn,
            fromValue,
            input.toValue,
            input.notes ?? null,
            actor.userId,
          ],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'hr.employee_change_recorded',
          entityType: 'employee_change',
          entityId: rows[0]!.id,
          outcome: 'success',
          before: { value: fromValue },
          after: { value: input.toValue, type: input.changeType },
          ...requestMeta(request),
        });
        return rows[0]!.id;
      });
      return reply.status(201).send({ id });
    },
  );

  /* ------------------------------- separations ----------------------------- */

  app.get(
    '/api/schools/:schoolId/separations',
    { preHandler: requirePermission('hr.separation.manage') },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const { rows } = await getPool().query<{
        id: string;
        staff_id: string;
        staff_name: string;
        last_working_day: string;
        reason: StaffSeparation['reason'];
        notes: string | null;
        status: StaffSeparation['status'];
        access_revoked_at: Date | null;
      }>(
        `SELECT sp.id, sp.staff_id, concat_ws(' ', s.first_name, s.last_name) AS staff_name,
                sp.last_working_day, sp.reason, sp.notes, sp.status, sp.access_revoked_at
         FROM staff_separations sp
         JOIN staff s ON s.id = sp.staff_id AND s.school_id = sp.school_id
         WHERE sp.school_id = $1 ORDER BY sp.created_at DESC`,
        [schoolId],
      );
      const tasks = await getPool().query<{
        id: string;
        separation_id: string;
        title: string;
        owner_user_id: string | null;
        status: ExitTask['status'];
        completed_at: Date | null;
      }>(
        `SELECT id, separation_id, title, owner_user_id, status, completed_at
         FROM exit_tasks WHERE school_id = $1 ORDER BY created_at`,
        [schoolId],
      );
      const bySeparation = new Map<string, ExitTask[]>();
      for (const task of tasks.rows) {
        const list = bySeparation.get(task.separation_id) ?? [];
        list.push({
          id: task.id,
          separationId: task.separation_id,
          title: task.title,
          ownerUserId: task.owner_user_id,
          status: task.status,
          completedAt: task.completed_at ? toIsoDateTime(task.completed_at) : null,
        });
        bySeparation.set(task.separation_id, list);
      }
      const items: StaffSeparation[] = rows.map((row) => ({
        id: row.id,
        staffId: row.staff_id,
        staffName: row.staff_name,
        lastWorkingDay: toIsoDate(row.last_working_day),
        reason: row.reason,
        notes: row.notes,
        status: row.status,
        accessRevokedAt: row.access_revoked_at
          ? toIsoDateTime(row.access_revoked_at)
          : null,
        tasks: bySeparation.get(row.id) ?? [],
      }));
      return { items };
    },
  );

  app.post(
    '/api/schools/:schoolId/separations',
    { preHandler: requirePermission('hr.separation.manage') },
    async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const input = parseInput(separationInput, request.body);
      const actor = getActor(request);
      const id = await withTransaction(async (client) => {
        const staff = await client.query(
          'SELECT 1 FROM staff WHERE school_id = $1 AND id = $2',
          [schoolId, input.staffId],
        );
        if (staff.rowCount === 0) throw notFound('Staff member not found');
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO staff_separations
             (school_id, staff_id, last_working_day, reason, notes, created_by)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [
            schoolId,
            input.staffId,
            input.lastWorkingDay,
            input.reason,
            input.notes ?? null,
            actor.userId,
          ],
        );
        const separationId = rows[0]!.id;
        for (const title of [
          ...input.exitTasks,
          'Return keys, devices and library items',
          'Complete handover document',
        ]) {
          await client.query(
            `INSERT INTO exit_tasks (school_id, separation_id, title, owner_user_id)
             VALUES ($1, $2, $3, $4)`,
            [schoolId, separationId, title, actor.userId],
          );
        }
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'hr.separation_initiated',
          entityType: 'staff_separation',
          entityId: separationId,
          outcome: 'success',
          after: { staffId: input.staffId, lastWorkingDay: input.lastWorkingDay },
          ...requestMeta(request),
        });
        return separationId;
      });
      return reply.status(201).send({ id });
    },
  );

  app.post(
    '/api/schools/:schoolId/separations/:id/decision',
    { preHandler: requirePermission('hr.separation.manage') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const input = parseInput(separationDecisionInput, request.body);
      const actor = getActor(request);
      await withTransaction(async (client) => {
        const found = await client.query<{
          status: StaffSeparation['status'];
          staff_id: string;
          approved_by: string | null;
          last_working_day: string;
        }>(
          `SELECT status, staff_id, approved_by, last_working_day
           FROM staff_separations WHERE school_id = $1 AND id = $2 FOR UPDATE`,
          [schoolId, id],
        );
        const separation = found.rows[0];
        if (!separation) throw notFound('Separation not found');
        if (input.decision === 'approve') {
          if (separation.status !== 'initiated') throw conflict('Only an initiated separation can be approved');
          if (!actor.permissions.has('hr.recruitment.approve')) {
            throw conflict('You do not have permission to approve separations');
          }
          await client.query(
            `UPDATE staff_separations SET status = 'approved', approved_by = $3,
               approved_at = now() WHERE school_id = $1 AND id = $2`,
            [schoolId, id, actor.userId],
          );
        } else if (input.decision === 'complete') {
          if (separation.status !== 'approved') {
            throw conflict('Approve the separation before completing it');
          }
          const pending = await client.query(
            `SELECT 1 FROM exit_tasks
             WHERE school_id = $1 AND separation_id = $2 AND status = 'pending'`,
            [schoolId, id],
          );
          if (pending.rowCount) {
            throw conflict('Complete or cancel every exit task before closing the separation');
          }
          await client.query(
            `UPDATE staff SET status = 'left' WHERE school_id = $1 AND id = $2`,
            [schoolId, separation.staff_id],
          );
          await client.query(
            `UPDATE staff_separations SET status = 'completed', completed_by = $3,
               completed_at = now(), access_revoked_at = now()
             WHERE school_id = $1 AND id = $2`,
            [schoolId, id, actor.userId],
          );
          await client.query(
            `UPDATE users SET status = 'disabled'
             WHERE id IN (SELECT user_id FROM staff WHERE school_id = $1 AND id = $2)`,
            [schoolId, separation.staff_id],
          );
        } else if (input.decision === 'cancel') {
          if (separation.status === 'completed') throw conflict('A completed separation cannot be cancelled');
          await client.query(
            `UPDATE staff_separations SET status = 'cancelled'
             WHERE school_id = $1 AND id = $2`,
            [schoolId, id],
          );
        } else {
          if (separation.status !== 'initiated') throw conflict('Only an initiated separation can be rejected');
          await client.query(
            `UPDATE staff_separations SET status = 'cancelled'
             WHERE school_id = $1 AND id = $2`,
            [schoolId, id],
          );
        }
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: 'hr.separation_decision',
          entityType: 'staff_separation',
          entityId: id,
          outcome: 'success',
          before: { status: separation.status },
          after: { decision: input.decision },
          ...requestMeta(request),
        });
      });
      return { id, decision: input.decision };
    },
  );

  app.patch(
    '/api/schools/:schoolId/exit-tasks/:id',
    { preHandler: requirePermission('hr.separation.manage') },
    async (request) => {
      const { schoolId, id } = parseInput(idParams, request.params);
      const input = parseInput(onboardingCompleteInput, request.body);
      const actor = getActor(request);
      const { rows } = await getPool().query<{ id: string }>(
        `UPDATE exit_tasks SET
           status = $3,
           completed_at = CASE WHEN $3 = 'done' THEN now() ELSE NULL END,
           completed_by = CASE WHEN $3 = 'done' THEN $4 ELSE NULL END
         WHERE school_id = $1 AND id = $2 RETURNING id`,
        [schoolId, id, input.status, actor.userId],
      );
      if (!rows[0]) throw notFound('Exit task not found');
      return { id, status: input.status };
    },
  );
}

async function nextVacancyReference(schoolId: string): Promise<string> {
  const { rows } = await getPool().query<{ count: string }>(
    'SELECT count(*)::text AS count FROM vacancies WHERE school_id = $1',
    [schoolId],
  );
  const next = Number(rows[0]?.count ?? 0) + 1;
  return `VAC-${String(next).padStart(4, '0')}`;
}

async function nextEmployeeNumber(
  client: Pick<pg.Pool, 'query'>,
  schoolId: string,
): Promise<string> {
  const { rows } = await client.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM staff WHERE school_id = $1',
    [schoolId],
  );
  return `EMP-${String(Number(rows[0]?.count ?? 0) + 1).padStart(4, '0')}`;
}
