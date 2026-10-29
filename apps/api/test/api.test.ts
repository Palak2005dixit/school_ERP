import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AcademicYear, SectionRecord } from '@erp/shared';
import { currentTotpCode } from '../src/lib/totp';

/**
 * Integration tests run against a real embedded PostgreSQL cluster seeded with
 * the same demo data the app ships with. Every assertion goes through HTTP so
 * the Fastify pipeline (auth, guards, validation, SQL) is exercised end to end.
 */

let app: FastifyInstance;
let pool: pg.Pool;
let stopDatabase: () => Promise<void>;
let schoolId: string;

const cookies = new Map<string, string>();

interface InjectOptions {
  cookie?: string;
  payload?: unknown;
  origin?: string;
  idempotencyKey?: string;
}

async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  options: InjectOptions = {},
): Promise<{ status: number; body: any; headers: Record<string, unknown> }> {
  const response = await app.inject({
    method,
    url,
    payload: options.payload as never,
    headers: {
      origin: options.origin ?? 'http://localhost:5173',
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : {}),
    },
  });
  let body: unknown = null;
  if (response.body) {
    try {
      body = JSON.parse(response.body);
    } catch {
      body = response.body;
    }
  }
  return { status: response.statusCode, body, headers: response.headers };
}

async function login(email: string, password: string): Promise<string> {
  const cached = cookies.get(email);
  if (cached) return cached;
  const response = await call('POST', '/api/auth/login', {
    payload: { email, password },
  });
  expect(response.status, `login failed for ${email}: ${JSON.stringify(response.body)}`).toBe(200);
  const setCookie = response.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const cookie = String(raw).split(';')[0];
  expect(cookie).toMatch(/^erp_session=/);
  cookies.set(email, cookie!);
  return cookie!;
}

async function q<T extends object>(sql: string, params: unknown[] = []): Promise<T[]> {
  const { rows } = await pool.query<T>(sql, params);
  return rows;
}

beforeAll(async () => {
  const { startTestDatabase } = await import('@erp/db/test-database');
  const database = await startTestDatabase();
  stopDatabase = database.stop;
  process.env.DATABASE_URL = database.url;
  process.env.NODE_ENV = 'test';

  const { buildApp } = await import('../src/app');
  const { getPool } = await import('../src/db');
  pool = getPool();
  app = await buildApp();
  await app.ready();

  const schools = await q<{ id: string }>(
    `SELECT id FROM schools WHERE code = 'GREENFIELD'`,
  );
  schoolId = schools[0]!.id;
});

afterAll(async () => {
  const { closePool } = await import('../src/db');
  await app?.close();
  await closePool();
  await stopDatabase?.();
});

describe('authentication', () => {
  it('signs in with a session cookie and returns memberships', async () => {
    const response = await call('POST', '/api/auth/login', {
      payload: { email: 'admin@demo.test', password: 'Admin@12345' },
    });

    expect(response.status).toBe(200);
    expect(response.body.user.email).toBe('admin@demo.test');
    expect(response.body.memberships).toHaveLength(1);
    expect(response.body.memberships[0].schoolId).toBe(schoolId);

    const setCookie = response.headers['set-cookie'];
    const raw = String(Array.isArray(setCookie) ? setCookie[0] : setCookie);
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Lax/i);
  });

  it('rejects a wrong password without revealing whether the account exists', async () => {
    const wrongPassword = await call('POST', '/api/auth/login', {
      payload: { email: 'admin@demo.test', password: 'not-the-password' },
    });
    const unknownEmail = await call('POST', '/api/auth/login', {
      payload: { email: 'nobody@demo.test', password: 'not-the-password' },
    });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body.error.message).toBe(unknownEmail.body.error.message);
  });

  it('requires a session for /api/auth/me', async () => {
    const response = await call('GET', '/api/auth/me');
    expect(response.status).toBe(401);
  });

  it('blocks cross-origin mutations', async () => {
    const admin = await login('admin@demo.test', 'Admin@12345');
    const response = await call('POST', `/api/schools/${schoolId}/classes`, {
      cookie: admin,
      origin: 'https://evil.example',
      payload: { code: 'HACK', name: 'Hacked class' },
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('forbidden');
  });
});

describe('academic structure', () => {
  it('creates and validates an academic year', async () => {
    const admin = await login('admin@demo.test', 'Admin@12345');

    const created = await call('POST', `/api/schools/${schoolId}/academic-years`, {
      cookie: admin,
      payload: {
        code: '2027-28',
        name: 'Academic Year 2027-28',
        startsOn: '2027-04-01',
        endsOn: '2028-03-31',
        status: 'planned',
      },
    });

    expect(created.status).toBe(201);
    expect(created.body.code).toBe('2027-28');

    const invalidRange = await call('POST', `/api/schools/${schoolId}/academic-years`, {
      cookie: admin,
      payload: {
        code: '2028-29',
        name: 'Broken range',
        startsOn: '2028-04-01',
        endsOn: '2028-03-01',
        status: 'planned',
      },
    });
    expect(invalidRange.status).toBe(400);

    const duplicate = await call('POST', `/api/schools/${schoolId}/academic-years`, {
      cookie: admin,
      payload: {
        code: '2027-28',
        name: 'Duplicate',
        startsOn: '2027-04-01',
        endsOn: '2028-03-31',
        status: 'planned',
      },
    });
    expect(duplicate.status).toBe(409);
  });

  it('keeps exactly one active year when another is activated', async () => {
    const admin = await login('admin@demo.test', 'Admin@12345');

    const years = await call('GET', `/api/schools/${schoolId}/academic-years`, { cookie: admin });
    expect(years.status).toBe(200);
    const next = (years.body.items as AcademicYear[]).find((year) => year.code === '2027-28');
    expect(next).toBeDefined();

    const activated = await call(
      'POST',
      `/api/schools/${schoolId}/academic-years/${next!.id}/activate`,
      { cookie: admin },
    );
    expect(activated.status).toBe(200);
    expect(activated.body.status).toBe('active');

    const active = await q<{ count: string }>(
      `SELECT count(*)::text AS count FROM academic_years WHERE school_id = $1 AND status = 'active'`,
      [schoolId],
    );
    expect(Number(active[0]!.count)).toBe(1);

    // Restore the demo year so later assertions see the seeded structure.
    const demoYear = (years.body.items as AcademicYear[]).find((year) => year.code === '2026-27');
    await call('POST', `/api/schools/${schoolId}/academic-years/${demoYear!.id}/activate`, {
      cookie: admin,
    });
  });

  it('creates a class and section, and rejects a mismatched year/section pair', async () => {
    const admin = await login('admin@demo.test', 'Admin@12345');

    const created = await call('POST', `/api/schools/${schoolId}/classes`, {
      cookie: admin,
      payload: { code: 'G6', name: 'Grade 6', gradeOrder: 6, status: 'active' },
    });
    expect(created.status).toBe(201);

    const years = await call('GET', `/api/schools/${schoolId}/academic-years`, { cookie: admin });
    const next = (years.body.items as AcademicYear[]).find((year) => year.code === '2027-28')!;
    const demo = (years.body.items as AcademicYear[]).find((year) => year.code === '2026-27')!;

    const section = await call('POST', `/api/schools/${schoolId}/sections`, {
      cookie: admin,
      payload: {
        academicYearId: next.id,
        classId: created.body.id,
        code: 'A',
        name: 'Section A',
        capacity: 30,
      },
    });
    expect(section.status).toBe(201);
    expect((section.body as SectionRecord).academicYearName).toBe('Academic Year 2027-28');

    const mismatch = await call('POST', `/api/schools/${schoolId}/sections`, {
      cookie: admin,
      payload: {
        academicYearId: demo.id,
        classId: '00000000-0000-4000-8000-000000000000',
        code: 'B',
        name: 'Section B',
      },
    });
    expect(mismatch.status).toBe(400);
  });

  it('denies structure writes to a teacher and records the denied attempt', async () => {
    const teacher = await login('teacher@demo.test', 'Teacher@12345');

    const denied = await call('POST', `/api/schools/${schoolId}/classes`, {
      cookie: teacher,
      payload: { code: 'G7', name: 'Grade 7' },
    });
    expect(denied.status).toBe(403);

    const audit = await q<{ outcome: string; reason: string | null }>(
      `SELECT outcome, reason FROM audit_events
       WHERE school_id = $1 AND action = 'access.denied' AND reason = 'missing academic.class.manage'
       ORDER BY occurred_at DESC LIMIT 1`,
      [schoolId],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.outcome).toBe('denied');
  });
});

describe('admissions and guardians', () => {
  let newStudentId: string;
  let newSectionId: string;
  let newYearId: string;

  it('admits a student with an auto-generated admission number', async () => {
    const admin = await login('admin@demo.test', 'Admin@12345');
    const years = await call('GET', `/api/schools/${schoolId}/academic-years`, { cookie: admin });
    newYearId = (years.body.items as AcademicYear[]).find((year) => year.code === '2027-28')!.id;
    const sections = await call(
      'GET',
      `/api/schools/${schoolId}/sections?academicYearId=${newYearId}`,
      { cookie: admin },
    );
    newSectionId = sections.body.items[0].id;

    const response = await call('POST', `/api/schools/${schoolId}/students`, {
      cookie: admin,
      payload: {
        firstName: 'Test',
        lastName: 'Admit',
        dateOfBirth: '2019-01-15',
        academicYearId: newYearId,
        sectionId: newSectionId,
        startsOn: '2027-04-05',
        guardians: [
          {
            firstName: 'Guardian',
            lastName: 'One',
            email: 'guardian.one@example.test',
            phone: '+1 555 0101',
            relationshipType: 'mother',
            isPrimary: true,
            portalAccessStatus: 'pending',
          },
        ],
      },
    });

    expect(response.status).toBe(201);
    expect(response.body.admissionNumber).toMatch(/^ADM-2027-\d{5}$/);
    expect(response.body.guardians).toHaveLength(1);
    expect(response.body.enrollments).toHaveLength(1);
    newStudentId = response.body.id;
  });

  it('rejects a duplicate admission number', async () => {
    const admin = await login('admin@demo.test', 'Admin@12345');
    const response = await call('POST', `/api/schools/${schoolId}/students`, {
      cookie: admin,
      payload: {
        admissionNumber: 'ADM-2026-00001',
        firstName: 'Duplicate',
        academicYearId: newYearId,
        sectionId: newSectionId,
        startsOn: '2027-04-05',
        guardians: [{ firstName: 'Someone', relationshipType: 'guardian' }],
      },
    });
    expect(response.status).toBe(409);
  });

  it('rejects more than one primary guardian in a single admission', async () => {
    const admin = await login('admin@demo.test', 'Admin@12345');
    const response = await call('POST', `/api/schools/${schoolId}/students`, {
      cookie: admin,
      payload: {
        firstName: 'Two',
        lastName: 'Primaries',
        academicYearId: newYearId,
        sectionId: newSectionId,
        startsOn: '2027-04-05',
        guardians: [
          { firstName: 'First', relationshipType: 'mother', isPrimary: true },
          { firstName: 'Second', relationshipType: 'father', isPrimary: true },
        ],
      },
    });
    expect(response.status).toBe(400);
  });

  it('rejects a second primary guardian when linking', async () => {
    const admin = await login('admin@demo.test', 'Admin@12345');
    const response = await call(
      'POST',
      `/api/schools/${schoolId}/students/${newStudentId}/guardians`,
      {
        cookie: admin,
        payload: {
          firstName: 'Another',
          relationshipType: 'father',
          isPrimary: true,
        },
      },
    );
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('primary_guardian_exists');
  });

  it('links a verified guardian so the parent portal can see the child', async () => {
    const admin = await login('admin@demo.test', 'Admin@12345');
    const linked = await call(
      'POST',
      `/api/schools/${schoolId}/students/${newStudentId}/guardians`,
      {
        cookie: admin,
        payload: {
          firstName: 'Guardian',
          lastName: 'Two',
          email: 'guardian.two@example.test',
          relationshipType: 'father',
          isPrimary: false,
          portalAccessStatus: 'verified',
        },
      },
    );
    expect(linked.status).toBe(201);

    const detail = await call('GET', `/api/schools/${schoolId}/students/${newStudentId}`, {
      cookie: admin,
    });
    expect(detail.status).toBe(200);
    expect(detail.body.guardians).toHaveLength(2);
    expect(detail.body.guardians.some((guardian: { portalAccessStatus: string }) => guardian.portalAccessStatus === 'verified')).toBe(true);
  });
});

describe('authorization scopes', () => {
  it('limits a teacher to students in assigned sections', async () => {
    const teacher = await login('teacher@demo.test', 'Teacher@12345');

    const list = await call('GET', `/api/schools/${schoolId}/students?pageSize=100`, {
      cookie: teacher,
    });
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(2);
    const names = list.body.items.map((student: { firstName: string }) => student.firstName);
    expect(names).toEqual(expect.arrayContaining(['Aarav', 'Kabir']));

    const hidden = await call(
      'GET',
      `/api/schools/${schoolId}/students?search=Diya`,
      { cookie: teacher },
    );
    expect(hidden.body.total).toBe(0);

    const diya = await q<{ id: string }>(
      `SELECT id FROM students WHERE school_id = $1 AND first_name = 'Diya'`,
      [schoolId],
    );
    const detail = await call(
      'GET',
      `/api/schools/${schoolId}/students/${diya[0]!.id}`,
      { cookie: teacher },
    );
    expect(detail.status).toBe(404);
  });

  it('limits a guardian to verified linked children', async () => {
    const parent = await login('parent@demo.test', 'Parent@12345');

    const children = await call('GET', `/api/schools/${schoolId}/portal/children`, {
      cookie: parent,
    });
    expect(children.status).toBe(200);
    expect(children.body.items).toHaveLength(2);
    expect(children.body.items.map((child: { fullName: string }) => child.fullName).sort()).toEqual([
      'Aarav Sharma',
      'Diya Sharma',
    ]);

    const list = await call('GET', `/api/schools/${schoolId}/students`, { cookie: parent });
    expect(list.status).toBe(403);

    const meera = await q<{ id: string }>(
      `SELECT id FROM students WHERE school_id = $1 AND first_name = 'Meera'`,
      [schoolId],
    );
    const detail = await call(
      'GET',
      `/api/schools/${schoolId}/students/${meera[0]!.id}`,
      { cookie: parent },
    );
    expect(detail.status).toBe(403);
  });

  it('hides other tenants from a legitimate member', async () => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO schools (code, name, timezone) VALUES ('OTHER', 'Other School', 'UTC')
       RETURNING id`,
    );
    const otherId = rows[0]!.id;

    const admin = await login('admin@demo.test', 'Admin@12345');
    const response = await call('GET', `/api/schools/${otherId}/overview`, { cookie: admin });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('not_found');
  });

  it('grants auditors read-only access', async () => {
    const auditor = await login('auditor@demo.test', 'Auditor@12345');

    const audit = await call('GET', `/api/schools/${schoolId}/audit-events`, { cookie: auditor });
    expect(audit.status).toBe(200);
    expect(audit.body.total).toBeGreaterThan(0);

    const write = await call('POST', `/api/schools/${schoolId}/subjects`, {
      cookie: auditor,
      payload: { code: 'NOPE', name: 'Not allowed' },
    });
    expect(write.status).toBe(403);

    const finance = await login('finance@demo.test', 'Finance@12345');
    const forbiddenAudit = await call('GET', `/api/schools/${schoolId}/audit-events`, {
      cookie: finance,
    });
    expect(forbiddenAudit.status).toBe(403);
  });
});

describe('dashboard aggregates', () => {
  it('reports the seeded figures for an administrator', async () => {
    const admin = await login('admin@demo.test', 'Admin@12345');
    const response = await call('GET', `/api/schools/${schoolId}/overview`, { cookie: admin });

    expect(response.status).toBe(200);
    // 6 seeded students + 1 admitted by this test suite.
    expect(response.body.studentsActive).toBe(7);
    expect(response.body.classes).toBe(6);
    expect(response.body.subjects).toBe(6);
    expect(response.body.pendingGuardianLinks).toBeGreaterThanOrEqual(1);
    expect(response.body.activeAcademicYear.code ?? response.body.activeAcademicYear.name).toBeTruthy();
    // Seeded admissions give the dashboard a real, non-placeholder timeline.
    expect(response.body.recentActivity.length).toBeGreaterThan(0);
    expect(
      response.body.recentActivity.some((event: { eventType: string }) => event.eventType === 'student.admitted'),
    ).toBe(true);
  });

  it('scopes dashboard counts for a teacher', async () => {
    const teacher = await login('teacher@demo.test', 'Teacher@12345');
    const response = await call('GET', `/api/schools/${schoolId}/overview`, { cookie: teacher });

    expect(response.status).toBe(200);
    expect(response.body.studentsActive).toBe(2);
    expect(response.body.sections).toBe(1);
    expect(response.body.studentsByClass).toEqual([
      expect.objectContaining({ className: 'Grade 1', count: 2 }),
    ]);
  });
});

describe('attendance and corrections', () => {
  let sectionId: string;
  let otherSectionId: string;
  let date: string;
  let aaravId: string;
  let kabirId: string;
  let aaravAttendanceId: string;
  let kabirAttendanceId: string;
  let teacherCorrectionId: string;

  beforeAll(async () => {
    const sections = await q<{ id: string; class_code: string; section_code: string }>(
      `SELECT sec.id, c.code AS class_code, sec.code AS section_code
       FROM sections sec
       JOIN classes c ON c.id = sec.class_id
       JOIN academic_years ay ON ay.id = sec.academic_year_id
       WHERE sec.school_id = $1 AND ay.status = 'active'`,
      [schoolId],
    );
    sectionId = sections.find(
      (row) => row.class_code === 'G1' && row.section_code === 'A',
    )!.id;
    otherSectionId = sections.find(
      (row) => row.class_code === 'G3' && row.section_code === 'B',
    )!.id;

    // A valid, non-future date inside the active academic year.
    const dates = await q<{ date: string }>(
      `SELECT to_char(
         GREATEST(ay.starts_on, LEAST((now() AT TIME ZONE s.timezone)::date, ay.ends_on)),
         'YYYY-MM-DD'
       ) AS date
       FROM academic_years ay
       JOIN schools s ON s.id = ay.school_id
       WHERE ay.school_id = $1 AND ay.status = 'active'`,
      [schoolId],
    );
    date = dates[0]!.date;

    const students = await q<{ id: string; first_name: string }>(
      `SELECT st.id, st.first_name
       FROM enrollments e
       JOIN students st ON st.id = e.student_id
       WHERE e.school_id = $1 AND e.section_id = $2 AND e.enrollment_status = 'active'
       ORDER BY st.first_name`,
      [schoolId, sectionId],
    );
    aaravId = students.find((student) => student.first_name === 'Aarav')!.id;
    kabirId = students.find((student) => student.first_name === 'Kabir')!.id;
  });

  it('records a daily register for the teacher-assigned section', async () => {
    const teacher = await login('teacher@demo.test', 'Teacher@12345');

    const empty = await call(
      'GET',
      `/api/schools/${schoolId}/attendance/register?sectionId=${sectionId}&date=${date}`,
      { cookie: teacher },
    );
    expect(empty.status).toBe(200);
    expect(empty.body.rows).toHaveLength(2);
    expect(empty.body.canRecord).toBe(true);
    expect(empty.body.rows.every((row: { status: string | null }) => row.status === null)).toBe(true);

    const saved = await call('POST', `/api/schools/${schoolId}/attendance/register`, {
      cookie: teacher,
      payload: {
        sectionId,
        date,
        entries: [
          { studentId: aaravId, status: 'present' },
          { studentId: kabirId, status: 'present' },
        ],
      },
    });
    expect(saved.status).toBe(201);
    expect(saved.body.inserted).toBe(2);
    expect(saved.body.skipped).toBe(0);
    expect(saved.body.register.summary.present).toBe(2);

    aaravAttendanceId = saved.body.register.rows.find(
      (row: { studentId: string }) => row.studentId === aaravId,
    ).attendanceId;
    kabirAttendanceId = saved.body.register.rows.find(
      (row: { studentId: string }) => row.studentId === kabirId,
    ).attendanceId;

    const audit = await q<{ outcome: string }>(
      `SELECT outcome FROM audit_events
       WHERE school_id = $1 AND action = 'attendance.register_saved'
       ORDER BY occurred_at DESC LIMIT 1`,
      [schoolId],
    );
    expect(audit[0]?.outcome).toBe('success');
  });

  it('inserts only missing rows when a register is submitted twice', async () => {
    const teacher = await login('teacher@demo.test', 'Teacher@12345');

    const again = await call('POST', `/api/schools/${schoolId}/attendance/register`, {
      cookie: teacher,
      payload: {
        sectionId,
        date,
        entries: [
          { studentId: aaravId, status: 'absent' },
          { studentId: kabirId, status: 'absent' },
        ],
      },
    });
    expect(again.status).toBe(200);
    expect(again.body.inserted).toBe(0);
    expect(again.body.skipped).toBe(2);
    expect(again.body.register.summary.present).toBe(2);

    const rows = await q<{ status: string }>(
      `SELECT status FROM student_attendance
       WHERE school_id = $1 AND attendance_date = $2::date
       ORDER BY status`,
      [schoolId, date],
    );
    expect(rows.map((row) => row.status)).toEqual(['present', 'present']);
  });

  it('denies registers outside the teacher section scope and to parents', async () => {
    const teacher = await login('teacher@demo.test', 'Teacher@12345');
    const other = await call(
      'GET',
      `/api/schools/${schoolId}/attendance/register?sectionId=${otherSectionId}&date=${date}`,
      { cookie: teacher },
    );
    expect(other.status).toBe(404);

    const parent = await login('parent@demo.test', 'Parent@12345');
    const denied = await call(
      'GET',
      `/api/schools/${schoolId}/attendance/register?sectionId=${sectionId}&date=${date}`,
      { cookie: parent },
    );
    expect(denied.status).toBe(403);
  });

  it('rejects a date outside the academic year', async () => {
    const teacher = await login('teacher@demo.test', 'Teacher@12345');
    const response = await call('POST', `/api/schools/${schoolId}/attendance/register`, {
      cookie: teacher,
      payload: {
        sectionId,
        date: '2000-01-03',
        entries: [{ studentId: aaravId, status: 'present' }],
      },
    });
    expect(response.status).toBe(400);
  });

  it('rejects an impossible calendar date before it reaches the database', async () => {
    const teacher = await login('teacher@demo.test', 'Teacher@12345');
    const response = await call('POST', `/api/schools/${schoolId}/attendance/register`, {
      cookie: teacher,
      payload: {
        sectionId,
        date: '2026-02-30',
        entries: [{ studentId: aaravId, status: 'present' }],
      },
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('validation_error');
  });

  it('requires a teacher correction request and leaves the original status unchanged', async () => {
    const teacher = await login('teacher@demo.test', 'Teacher@12345');

    const requested = await call('POST', `/api/schools/${schoolId}/attendance/corrections`, {
      cookie: teacher,
      payload: {
        attendanceId: aaravAttendanceId,
        requestedStatus: 'absent',
        reason: 'Left early for a medical appointment with a guardian',
      },
    });
    expect(requested.status).toBe(201);
    expect(requested.body.status).toBe('pending');
    expect(requested.body.currentStatus).toBe('present');
    expect(requested.body.requestedStatus).toBe('absent');
    teacherCorrectionId = requested.body.id;

    const original = await q<{ status: string }>(
      'SELECT status FROM student_attendance WHERE school_id = $1 AND id = $2',
      [schoolId, aaravAttendanceId],
    );
    expect(original[0]!.status).toBe('present');

    const duplicate = await call('POST', `/api/schools/${schoolId}/attendance/corrections`, {
      cookie: teacher,
      payload: {
        attendanceId: aaravAttendanceId,
        requestedStatus: 'late',
        reason: 'Trying to add a second request to the same record',
      },
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('correction_pending');
  });

  it('denies teachers the approval queue and review action', async () => {
    const teacher = await login('teacher@demo.test', 'Teacher@12345');

    const queue = await call('GET', `/api/schools/${schoolId}/attendance/corrections`, {
      cookie: teacher,
    });
    expect(queue.status).toBe(403);

    const review = await call(
      'POST',
      `/api/schools/${schoolId}/attendance/corrections/${teacherCorrectionId}/review`,
      { cookie: teacher, payload: { decision: 'approve' } },
    );
    expect(review.status).toBe(403);
  });

  it('lets a different approver decide a request and blocks self-approval', async () => {
    const coordinator = await login('coordinator@demo.test', 'Coord@12345');
    const admin = await login('admin@demo.test', 'Admin@12345');

    const queue = await call('GET', `/api/schools/${schoolId}/attendance/corrections`, {
      cookie: coordinator,
    });
    expect(queue.status).toBe(200);
    expect(
      queue.body.items.some((item: { id: string }) => item.id === teacherCorrectionId),
    ).toBe(true);

    // Direct fixture: a coordinator-raised request for Kabir's attendance.
    const coordinatorRow = await q<{ id: string }>(
      `SELECT id FROM users WHERE lower(email) = 'coordinator@demo.test'`,
    );
    const selfFixture = await q<{ id: string }>(
      `INSERT INTO attendance_corrections
         (school_id, attendance_id, requested_status, reason, requested_by)
       VALUES ($1, $2, 'late', 'Self approval fixture for the authorization test', $3)
       RETURNING id`,
      [schoolId, kabirAttendanceId, coordinatorRow[0]!.id],
    );
    const selfAttempt = await call(
      'POST',
      `/api/schools/${schoolId}/attendance/corrections/${selfFixture[0]!.id}/review`,
      { cookie: coordinator, payload: { decision: 'approve' } },
    );
    expect(selfAttempt.status).toBe(403);

    const selfPending = await q<{ status: string }>(
      'SELECT status FROM attendance_corrections WHERE id = $1',
      [selfFixture[0]!.id],
    );
    expect(selfPending[0]!.status).toBe('pending');

    // Another approver can decide the same request.
    const adminApproves = await call(
      'POST',
      `/api/schools/${schoolId}/attendance/corrections/${selfFixture[0]!.id}/review`,
      { cookie: admin, payload: { decision: 'approve', note: 'Verified with the class teacher' } },
    );
    expect(adminApproves.status).toBe(200);
    expect(adminApproves.body.status).toBe('approved');

    const kabir = await q<{ status: string; source: string }>(
      'SELECT status, source FROM student_attendance WHERE school_id = $1 AND id = $2',
      [schoolId, kabirAttendanceId],
    );
    expect(kabir[0]).toEqual({ status: 'late', source: 'correction' });

    const coordinatorApproves = await call(
      'POST',
      `/api/schools/${schoolId}/attendance/corrections/${teacherCorrectionId}/review`,
      { cookie: coordinator, payload: { decision: 'approve' } },
    );
    expect(coordinatorApproves.status).toBe(200);
    expect(coordinatorApproves.body.status).toBe('approved');

    const aarav = await q<{ status: string; source: string }>(
      'SELECT status, source FROM student_attendance WHERE school_id = $1 AND id = $2',
      [schoolId, aaravAttendanceId],
    );
    expect(aarav[0]).toEqual({ status: 'absent', source: 'correction' });
  });

  it('keeps the saved status when a correction is rejected', async () => {
    const teacher = await login('teacher@demo.test', 'Teacher@12345');
    const coordinator = await login('coordinator@demo.test', 'Coord@12345');

    const requested = await call('POST', `/api/schools/${schoolId}/attendance/corrections`, {
      cookie: teacher,
      payload: {
        attendanceId: kabirAttendanceId,
        requestedStatus: 'absent',
        reason: 'Requesting a change that the approver will reject',
      },
    });
    expect(requested.status).toBe(201);

    const rejected = await call(
      'POST',
      `/api/schools/${schoolId}/attendance/corrections/${requested.body.id}/review`,
      {
        cookie: coordinator,
        payload: { decision: 'reject', note: 'The class teacher confirmed the late arrival' },
      },
    );
    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe('rejected');
    expect(rejected.body.reviewNote).toBe('The class teacher confirmed the late arrival');

    const kabir = await q<{ status: string }>(
      'SELECT status FROM student_attendance WHERE school_id = $1 AND id = $2',
      [schoolId, kabirAttendanceId],
    );
    expect(kabir[0]!.status).toBe('late');

    const audit = await q<{ action: string }>(
      `SELECT action FROM audit_events
       WHERE school_id = $1 AND action IN
         ('attendance.correction_approved', 'attendance.correction_rejected')
       GROUP BY action`,
      [schoolId],
    );
    expect(audit.map((row) => row.action).sort()).toEqual([
      'attendance.correction_approved',
      'attendance.correction_rejected',
    ]);
  });

  it('lets an auditor read the register but not change it', async () => {
    const auditor = await login('auditor@demo.test', 'Auditor@12345');
    const view = await call(
      'GET',
      `/api/schools/${schoolId}/attendance/register?sectionId=${sectionId}&date=${date}`,
      { cookie: auditor },
    );
    expect(view.status).toBe(200);
    expect(view.body.canRecord).toBe(false);

    const write = await call('POST', `/api/schools/${schoolId}/attendance/register`, {
      cookie: auditor,
      payload: {
        sectionId,
        date,
        entries: [{ studentId: aaravId, status: 'present' }],
      },
    });
    expect(write.status).toBe(403);
  });
});

describe('timetable', () => {
  let yearId: string;
  let g1a: string;
  let g2a: string;
  let room101: string;
  let eng: string;
  let teacherUserId: string;
  let periodOne: string;
  let breakPeriod: string;

  beforeAll(async () => {
    const years = await q<{ id: string }>(
      `SELECT id FROM academic_years WHERE school_id = $1 AND status = 'active'`,
      [schoolId],
    );
    yearId = years[0]!.id;

    const sections = await q<{ id: string; class_code: string; section_code: string }>(
      `SELECT sec.id, c.code AS class_code, sec.code AS section_code
       FROM sections sec JOIN classes c ON c.id = sec.class_id
       WHERE sec.school_id = $1 AND sec.academic_year_id = $2`,
      [schoolId, yearId],
    );
    g1a = sections.find((row) => row.class_code === 'G1' && row.section_code === 'A')!.id;
    g2a = sections.find((row) => row.class_code === 'G2' && row.section_code === 'A')!.id;

    const rooms = await q<{ id: string }>(
      `SELECT id FROM rooms WHERE school_id = $1 AND code = 'ROOM-101'`,
      [schoolId],
    );
    room101 = rooms[0]!.id;

    const subjects = await q<{ id: string }>(
      `SELECT id FROM subjects WHERE school_id = $1 AND code = 'ENG'`,
      [schoolId],
    );
    eng = subjects[0]!.id;

    const teacher = await q<{ id: string }>(
      `SELECT id FROM users WHERE lower(email) = 'teacher@demo.test'`,
    );
    teacherUserId = teacher[0]!.id;

    const periods = await q<{ id: string; sequence_no: number; is_break: boolean }>(
      `SELECT id, sequence_no, is_break FROM timetable_periods
       WHERE school_id = $1 AND academic_year_id = $2 ORDER BY sequence_no`,
      [schoolId, yearId],
    );
    periodOne = periods.find((row) => row.sequence_no === 1)!.id;
    breakPeriod = periods.find((row) => row.is_break)!.id;
  });

  it('lists the seeded schedule and scopes a teacher to their own sections', async () => {
    const teacher = await login('teacher@demo.test', 'Teacher@12345');
    const admin = await login('admin@demo.test', 'Admin@12345');

    const teacherView = await call('GET', `/api/schools/${schoolId}/timetable`, {
      cookie: teacher,
    });
    expect(teacherView.status).toBe(200);
    expect(teacherView.body.periods).toHaveLength(6);
    expect(teacherView.body.rooms.length).toBeGreaterThanOrEqual(4);
    expect(teacherView.body.slots).toHaveLength(20);
    expect(
      teacherView.body.slots.every((slot: { sectionId: string }) => slot.sectionId === g1a),
    ).toBe(true);

    const adminView = await call('GET', `/api/schools/${schoolId}/timetable`, {
      cookie: admin,
    });
    expect(adminView.status).toBe(200);
    expect(adminView.body.slots).toHaveLength(20);
  });

  it('rejects a double-booked section, teacher and break period', async () => {
    const admin = await login('admin@demo.test', 'Admin@12345');

    const duplicateSection = await call(
      'POST',
      `/api/schools/${schoolId}/timetable/slots`,
      {
        cookie: admin,
        payload: {
          academicYearId: yearId,
          sectionId: g1a,
          periodId: periodOne,
          dayOfWeek: 1,
          subjectId: eng,
          teacherUserId,
          roomId: room101,
        },
      },
    );
    expect(duplicateSection.status).toBe(409);
    expect(duplicateSection.body.error.code).toBe('duplicate');

    const duplicateTeacher = await call(
      'POST',
      `/api/schools/${schoolId}/timetable/slots`,
      {
        cookie: admin,
        payload: {
          academicYearId: yearId,
          sectionId: g2a,
          periodId: periodOne,
          dayOfWeek: 1,
          subjectId: eng,
          teacherUserId,
        },
      },
    );
    expect(duplicateTeacher.status).toBe(409);
    expect(duplicateTeacher.body.error.message).toMatch(/teacher/i);

    const breakLesson = await call('POST', `/api/schools/${schoolId}/timetable/slots`, {
      cookie: admin,
      payload: {
        academicYearId: yearId,
        sectionId: g2a,
        periodId: breakPeriod,
        dayOfWeek: 2,
        subjectId: eng,
        teacherUserId,
      },
    });
    expect(breakLesson.status).toBe(400);
    expect(breakLesson.body.error.message).toMatch(/break/i);
  });

  it('lets an auditor read but not edit the timetable', async () => {
    const auditor = await login('auditor@demo.test', 'Auditor@12345');
    const read = await call('GET', `/api/schools/${schoolId}/timetable`, { cookie: auditor });
    expect(read.status).toBe(200);
    expect(read.body.slots.length).toBeGreaterThan(0);

    const write = await call('POST', `/api/schools/${schoolId}/timetable/slots`, {
      cookie: auditor,
      payload: {
        academicYearId: yearId,
        sectionId: g2a,
        periodId: periodOne,
        dayOfWeek: 3,
        subjectId: eng,
        teacherUserId,
      },
    });
    expect(write.status).toBe(403);
  });
});

describe('fees', () => {
  let yearId: string;
  let aaravId: string;
  let meeraId: string;
  let diyaId: string;
  let aaravChargeId: string;
  let aaravOutstanding: number;
  let diyaPaymentId: string;
  let vivaanPaymentId: string;
  let adminUserId: string;

  beforeAll(async () => {
    const years = await q<{ id: string }>(
      `SELECT id FROM academic_years WHERE school_id = $1 AND status = 'active'`,
      [schoolId],
    );
    yearId = years[0]!.id;

    const students = await q<{ id: string; first_name: string }>(
      `SELECT id, first_name FROM students WHERE school_id = $1`,
      [schoolId],
    );
    aaravId = students.find((row) => row.first_name === 'Aarav')!.id;
    meeraId = students.find((row) => row.first_name === 'Meera')!.id;
    diyaId = students.find((row) => row.first_name === 'Diya')!.id;

    const charges = await q<{ id: string; net: string; paid: string }>(
      `SELECT ch.id,
              (ch.amount - ch.concession_amount)::text AS net,
              COALESCE((
                SELECT sum(pa.amount) FROM payment_allocations pa
                JOIN payments p ON p.id = pa.payment_id AND p.status = 'recorded'
                WHERE pa.charge_id = ch.id
              ), 0)::text AS paid
       FROM student_charges ch
       WHERE ch.school_id = $1 AND ch.student_id = $2
       ORDER BY ch.due_on, ch.id
       LIMIT 1`,
      [schoolId, aaravId],
    );
    aaravChargeId = charges[0]!.id;
    aaravOutstanding = Number(charges[0]!.net) - Number(charges[0]!.paid);

    const payments = await q<{ id: string; receipt_number: string }>(
      `SELECT id, receipt_number FROM payments
       WHERE school_id = $1 AND receipt_number IN ('RCPT-SEED-0002', 'RCPT-SEED-0005')`,
      [schoolId],
    );
    diyaPaymentId = payments.find((row) => row.receipt_number === 'RCPT-SEED-0002')!.id;
    vivaanPaymentId = payments.find((row) => row.receipt_number === 'RCPT-SEED-0005')!.id;

    const admin = await q<{ id: string }>(
      `SELECT id FROM users WHERE lower(email) = 'admin@demo.test'`,
    );
    adminUserId = admin[0]!.id;
  });

  it('records a payment, allocates it to the ledger and never loses a cent', async () => {
    const finance = await login('finance@demo.test', 'Finance@12345');

    const before = await call('GET', `/api/schools/${schoolId}/fees/overview`, {
      cookie: finance,
    });
    expect(before.status).toBe(200);

    const payment = await call('POST', `/api/schools/${schoolId}/fees/payments`, {
      cookie: finance,
      payload: {
        studentId: meeraId,
        academicYearId: yearId,
        amount: 1000,
        method: 'upi',
        reference: 'UPI-TEST-1000',
        paidOn: '2026-10-20',
      },
    });
    expect(payment.status).toBe(201);
    expect(payment.body.receiptNumber).toMatch(/^RCPT-\d{6}$/);
    expect(payment.body.amount).toBe(1000);

    const allocated = payment.body.allocations.reduce(
      (sum: number, entry: { amount: number }) => sum + entry.amount,
      0,
    );
    expect(allocated).toBe(1000);

    const after = await call('GET', `/api/schools/${schoolId}/fees/overview`, {
      cookie: finance,
    });
    expect(after.body.totalCollected - before.body.totalCollected).toBeCloseTo(1000, 2);
    expect(after.body.totalOutstanding).toBeCloseTo(
      after.body.totalCharged -
        after.body.totalConcession -
        after.body.totalCollected +
        after.body.totalRefunded,
      2,
    );
  });

  it('refuses allocations that exceed the charge or belong to another student', async () => {
    const finance = await login('finance@demo.test', 'Finance@12345');

    const overAllocated = await call('POST', `/api/schools/${schoolId}/fees/payments`, {
      cookie: finance,
      payload: {
        studentId: aaravId,
        academicYearId: yearId,
        amount: Math.round((aaravOutstanding + 100) * 100) / 100,
        method: 'cash',
        paidOn: '2026-10-20',
        allocations: [
          { chargeId: aaravChargeId, amount: Math.round((aaravOutstanding + 100) * 100) / 100 },
        ],
      },
    });
    expect(overAllocated.status).toBe(400);
    expect(overAllocated.body.error.message).toMatch(/outstanding/i);

    const meeraCharge = await q<{ id: string }>(
      `SELECT id FROM student_charges WHERE school_id = $1 AND student_id = $2 LIMIT 1`,
      [schoolId, meeraId],
    );
    const wrongStudent = await call('POST', `/api/schools/${schoolId}/fees/payments`, {
      cookie: finance,
      payload: {
        studentId: aaravId,
        academicYearId: yearId,
        amount: 100,
        method: 'cash',
        paidOn: '2026-10-20',
        allocations: [{ chargeId: meeraCharge[0]!.id, amount: 100 }],
      },
    });
    expect(wrongStudent.status).toBe(400);
    expect(wrongStudent.body.error.details.allocations).toBeTruthy();
  });

  it('routes a refund through a different approver and updates the ledger', async () => {
    const finance = await login('finance@demo.test', 'Finance@12345');
    const admin = await login('admin@demo.test', 'Admin@12345');

    const before = await call('GET', `/api/schools/${schoolId}/fees/overview`, {
      cookie: admin,
    });

    const requested = await call('POST', `/api/schools/${schoolId}/fees/refunds`, {
      cookie: finance,
      payload: {
        paymentId: diyaPaymentId,
        amount: 500,
        reason: 'Duplicate transport charge for the term',
      },
    });
    expect(requested.status).toBe(201);
    expect(requested.body.status).toBe('pending');

    const selfAttempt = await call(
      'POST',
      `/api/schools/${schoolId}/fees/refunds/${requested.body.id}/review`,
      { cookie: finance, payload: { decision: 'approve' } },
    );
    expect(selfAttempt.status).toBe(403);

    const approved = await call(
      'POST',
      `/api/schools/${schoolId}/fees/refunds/${requested.body.id}/review`,
      { cookie: admin, payload: { decision: 'approve', note: 'Verified against the receipt' } },
    );
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('approved');

    const after = await call('GET', `/api/schools/${schoolId}/fees/overview`, {
      cookie: admin,
    });
    expect(after.body.totalRefunded - before.body.totalRefunded).toBeCloseTo(500, 2);

    const payments = await call(
      'GET',
      `/api/schools/${schoolId}/fees/payments?studentId=${diyaId}`,
      { cookie: admin },
    );
    expect(payments.status).toBe(200);
    const diyaPayment = payments.body.items.find(
      (row: { id: string }) => row.id === diyaPaymentId,
    );
    expect(diyaPayment.refundedAmount).toBe(500);
  });

  it('blocks self-approval, over-refunds and a second pending refund', async () => {
    const admin = await login('admin@demo.test', 'Admin@12345');

    const kabirPayment = await q<{ id: string }>(
      `SELECT id FROM payments WHERE school_id = $1 AND receipt_number = 'RCPT-SEED-0003'`,
      [schoolId],
    );
    const fixture = await q<{ id: string }>(
      `INSERT INTO refunds (school_id, payment_id, amount, reason, requested_by)
       VALUES ($1, $2, 100, 'Self-approval fixture for the authorization test', $3)
       RETURNING id`,
      [schoolId, kabirPayment[0]!.id, adminUserId],
    );
    const selfApproval = await call(
      'POST',
      `/api/schools/${schoolId}/fees/refunds/${fixture[0]!.id}/review`,
      { cookie: admin, payload: { decision: 'approve' } },
    );
    expect(selfApproval.status).toBe(409);
    expect(selfApproval.body.error.code).toBe('self_approval');

    const overRefund = await call('POST', `/api/schools/${schoolId}/fees/refunds`, {
      cookie: admin,
      payload: {
        paymentId: vivaanPaymentId,
        amount: 999999,
        reason: 'Requesting far more than the original receipt',
      },
    });
    // Admin lacks fees.payment.verify, so the request is refused before the
    // amount is even considered.
    expect(overRefund.status).toBe(403);

    const finance = await login('finance@demo.test', 'Finance@12345');
    const first = await call('POST', `/api/schools/${schoolId}/fees/refunds`, {
      cookie: finance,
      payload: {
        paymentId: vivaanPaymentId,
        amount: 100,
        reason: 'First pending refund for this receipt',
      },
    });
    expect(first.status).toBe(201);

    const duplicate = await call('POST', `/api/schools/${schoolId}/fees/refunds`, {
      cookie: finance,
      payload: {
        paymentId: vivaanPaymentId,
        amount: 100,
        reason: 'Second pending refund for the same receipt',
      },
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('duplicate');

    const tooLarge = await call('POST', `/api/schools/${schoolId}/fees/refunds`, {
      cookie: finance,
      payload: {
        paymentId: aaravId,
        amount: 100,
        reason: 'Unknown payment identifier should be rejected',
      },
    });
    expect(tooLarge.status).toBe(404);
  });

  it('keeps fee data read-only for an auditor and scoped for a guardian', async () => {
    const auditor = await login('auditor@demo.test', 'Auditor@12345');
    const parent = await login('parent@demo.test', 'Parent@12345');

    const read = await call('GET', `/api/schools/${schoolId}/fees/charges`, { cookie: auditor });
    expect(read.status).toBe(200);
    expect(read.body.items.length).toBeGreaterThan(0);

    const write = await call('POST', `/api/schools/${schoolId}/fees/charges`, {
      cookie: auditor,
      payload: {
        studentId: aaravId,
        academicYearId: yearId,
        feeHeadId: read.body.items[0].feeHeadId,
        description: 'Auditor should not be able to charge',
        amount: 100,
        dueOn: '2026-11-01',
      },
    });
    expect(write.status).toBe(403);

    const ownChild = await call(
      'GET',
      `/api/schools/${schoolId}/portal/children/${aaravId}/fees`,
      { cookie: parent },
    );
    expect(ownChild.status).toBe(200);
    expect(ownChild.body.studentId).toBe(aaravId);

    const unlinked = await call(
      'GET',
      `/api/schools/${schoolId}/portal/children/${meeraId}/fees`,
      { cookie: parent },
    );
    expect(unlinked.status).toBe(404);
  });
});

describe('examinations', () => {
  let yearId: string;
  let g1a: string;
  let eng: string;
  let sci: string;
  let schemeId: string;
  let aaravId: string;
  let kabirId: string;
  let meeraId: string;
  let seededExamId: string;
  let seededEngSubjectId: string;

  beforeAll(async () => {
    const years = await q<{ id: string }>(
      `SELECT id FROM academic_years WHERE school_id = $1 AND status = 'active'`,
      [schoolId],
    );
    yearId = years[0]!.id;

    const sections = await q<{ id: string; class_code: string; section_code: string }>(
      `SELECT sec.id, c.code AS class_code, sec.code AS section_code
       FROM sections sec JOIN classes c ON c.id = sec.class_id
       WHERE sec.school_id = $1 AND sec.academic_year_id = $2`,
      [schoolId, yearId],
    );
    g1a = sections.find((row) => row.class_code === 'G1' && row.section_code === 'A')!.id;

    const subjects = await q<{ id: string; code: string }>(
      `SELECT id, code FROM subjects WHERE school_id = $1 AND code IN ('ENG', 'SCI')`,
      [schoolId],
    );
    eng = subjects.find((row) => row.code === 'ENG')!.id;
    sci = subjects.find((row) => row.code === 'SCI')!.id;

    const schemes = await q<{ id: string }>(
      `SELECT id FROM grading_schemes WHERE school_id = $1 AND is_default`,
      [schoolId],
    );
    schemeId = schemes[0]!.id;

    const students = await q<{ id: string; first_name: string }>(
      `SELECT id, first_name FROM students WHERE school_id = $1`,
      [schoolId],
    );
    aaravId = students.find((row) => row.first_name === 'Aarav')!.id;
    kabirId = students.find((row) => row.first_name === 'Kabir')!.id;
    meeraId = students.find((row) => row.first_name === 'Meera')!.id;

    const seeded = await q<{ id: string }>(
      `SELECT id FROM exams WHERE school_id = $1 AND name = 'Term 1 Examination'`,
      [schoolId],
    );
    seededExamId = seeded[0]!.id;
    const seededSubject = await q<{ id: string }>(
      `SELECT id FROM exam_subjects
       WHERE school_id = $1 AND exam_id = $2 AND subject_id = $3`,
      [schoolId, seededExamId, eng],
    );
    seededEngSubjectId = seededSubject[0]!.id;
  });

  it('turns entered marks into a published report card with a pass result', async () => {
    const coordinator = await login('coordinator@demo.test', 'Coord@12345');
    const teacher = await login('teacher@demo.test', 'Teacher@12345');

    const created = await call('POST', `/api/schools/${schoolId}/exams`, {
      cookie: coordinator,
      payload: {
        academicYearId: yearId,
        name: 'Midterm Assessment 2026',
        examType: 'midterm',
        startsOn: '2026-11-02',
        endsOn: '2026-11-06',
        gradingSchemeId: schemeId,
        passPercent: 35,
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('draft');
    const examId = created.body.id;

    const engSubject = await call(
      'POST',
      `/api/schools/${schoolId}/exams/${examId}/subjects`,
      { cookie: coordinator, payload: { subjectId: eng, maxMarks: 100, passMarks: 35 } },
    );
    expect(engSubject.status).toBe(201);
    const sciSubject = await call(
      'POST',
      `/api/schools/${schoolId}/exams/${examId}/subjects`,
      { cookie: coordinator, payload: { subjectId: sci, maxMarks: 100, passMarks: 35 } },
    );
    expect(sciSubject.status).toBe(201);

    const blockedPublish = await call(
      'POST',
      `/api/schools/${schoolId}/exams/${examId}/publish`,
      { cookie: coordinator },
    );
    expect(blockedPublish.status).toBe(400);
    expect(blockedPublish.body.error.details.subjects).toBeTruthy();

    const tooHigh = await call('POST', `/api/schools/${schoolId}/exams/${examId}/marks`, {
      cookie: teacher,
      payload: {
        examSubjectId: engSubject.body.id,
        sectionId: g1a,
        entries: [{ studentId: aaravId, marksObtained: 120, isAbsent: false }],
      },
    });
    expect(tooHigh.status).toBe(400);
    expect(tooHigh.body.error.message).toMatch(/maximum/i);

    const engMarks = await call('POST', `/api/schools/${schoolId}/exams/${examId}/marks`, {
      cookie: teacher,
      payload: {
        examSubjectId: engSubject.body.id,
        sectionId: g1a,
        entries: [
          { studentId: aaravId, marksObtained: 80, isAbsent: false },
          { studentId: kabirId, marksObtained: 90, isAbsent: false },
        ],
      },
    });
    expect(engMarks.status).toBe(200);

    const stillIncomplete = await call(
      'POST',
      `/api/schools/${schoolId}/exams/${examId}/publish`,
      { cookie: coordinator },
    );
    expect(stillIncomplete.status).toBe(400);

    const sciMarks = await call('POST', `/api/schools/${schoolId}/exams/${examId}/marks`, {
      cookie: teacher,
      payload: {
        examSubjectId: sciSubject.body.id,
        sectionId: g1a,
        entries: [
          { studentId: aaravId, marksObtained: 70, isAbsent: false },
          { studentId: kabirId, marksObtained: 60, isAbsent: false },
        ],
      },
    });
    expect(sciMarks.status).toBe(200);

    const published = await call(
      'POST',
      `/api/schools/${schoolId}/exams/${examId}/publish`,
      { cookie: coordinator },
    );
    expect(published.status).toBe(200);
    expect(published.body.status).toBe('published');

    const locked = await call('POST', `/api/schools/${schoolId}/exams/${examId}/marks`, {
      cookie: teacher,
      payload: {
        examSubjectId: engSubject.body.id,
        sectionId: g1a,
        entries: [{ studentId: aaravId, marksObtained: 99, isAbsent: false }],
      },
    });
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe('exam_published');

    const reportCard = await call(
      'GET',
      `/api/schools/${schoolId}/exams/${examId}/report-cards/${aaravId}`,
      { cookie: coordinator },
    );
    expect(reportCard.status).toBe(200);
    expect(reportCard.body.result).toBe('pass');
    expect(reportCard.body.percentage).toBe(75);
    expect(reportCard.body.overallGrade).toBeTruthy();
    expect(reportCard.body.subjects).toHaveLength(2);

    const teacherPublish = await call(
      'POST',
      `/api/schools/${schoolId}/exams/${examId}/publish`,
      { cookie: teacher },
    );
    expect(teacherPublish.status).toBe(403);

    const reopened = await call(
      'POST',
      `/api/schools/${schoolId}/exams/${examId}/unpublish`,
      { cookie: coordinator },
    );
    expect(reopened.status).toBe(200);
    expect(reopened.body.status).toBe('draft');

    const corrected = await call('POST', `/api/schools/${schoolId}/exams/${examId}/marks`, {
      cookie: teacher,
      payload: {
        examSubjectId: engSubject.body.id,
        sectionId: g1a,
        entries: [{ studentId: aaravId, marksObtained: 85, isAbsent: false }],
      },
    });
    expect(corrected.status).toBe(200);

    const republished = await call(
      'POST',
      `/api/schools/${schoolId}/exams/${examId}/publish`,
      { cookie: coordinator },
    );
    expect(republished.status).toBe(200);

    const outOfScope = await call(
      'GET',
      `/api/schools/${schoolId}/exams/${examId}/report-cards/${meeraId}`,
      { cookie: teacher },
    );
    expect(outOfScope.status).toBe(404);
  });

  it('publishes seeded results to the right guardian only', async () => {
    const coordinator = await login('coordinator@demo.test', 'Coord@12345');
    const teacher = await login('teacher@demo.test', 'Teacher@12345');
    const parent = await login('parent@demo.test', 'Parent@12345');

    const teacherPublish = await call(
      'POST',
      `/api/schools/${schoolId}/exams/${seededExamId}/publish`,
      { cookie: teacher },
    );
    expect(teacherPublish.status).toBe(403);

    const published = await call(
      'POST',
      `/api/schools/${schoolId}/exams/${seededExamId}/publish`,
      { cookie: coordinator },
    );
    expect(published.status).toBe(200);
    expect(published.body.status).toBe('published');

    const locked = await call(
      'POST',
      `/api/schools/${schoolId}/exams/${seededExamId}/marks`,
      {
        cookie: teacher,
        payload: {
          examSubjectId: seededEngSubjectId,
          sectionId: g1a,
          entries: [{ studentId: aaravId, marksObtained: 91, isAbsent: false }],
        },
      },
    );
    expect(locked.status).toBe(409);

    const ownChild = await call(
      'GET',
      `/api/schools/${schoolId}/portal/children/${aaravId}/results`,
      { cookie: parent },
    );
    expect(ownChild.status).toBe(200);
    expect(ownChild.body.items.length).toBeGreaterThanOrEqual(2);
    expect(
      ownChild.body.items.some((card: { examId: string }) => card.examId === seededExamId),
    ).toBe(true);

    const unlinked = await call(
      'GET',
      `/api/schools/${schoolId}/portal/children/${meeraId}/results`,
      { cookie: parent },
    );
    expect(unlinked.status).toBe(404);

    const g3Report = await call(
      'GET',
      `/api/schools/${schoolId}/exams/${seededExamId}/report-cards/${meeraId}`,
      { cookie: coordinator },
    );
    expect(g3Report.status).toBe(200);
  });

  it('rejects an overlapping grading scheme', async () => {
    const coordinator = await login('coordinator@demo.test', 'Coord@12345');
    const response = await call('POST', `/api/schools/${schoolId}/grading-schemes`, {
      cookie: coordinator,
      payload: {
        code: 'OVERLAP',
        name: 'Overlapping scheme',
        isDefault: false,
        bands: [
          { minPercent: 0, maxPercent: 60, grade: 'X' },
          { minPercent: 50, maxPercent: 100, grade: 'Y' },
        ],
      },
    });
    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/overlap/i);
  });
});

describe('staff and leave', () => {
  let teacherStaffId: string;
  let coordinatorStaffId: string;
  let financeStaffId: string;

  beforeAll(async () => {
    const staff = await q<{ id: string; employee_number: string }>(
      `SELECT id, employee_number FROM staff WHERE school_id = $1`,
      [schoolId],
    );
    teacherStaffId = staff.find((row) => row.employee_number === 'EMP-0003')!.id;
    coordinatorStaffId = staff.find((row) => row.employee_number === 'EMP-0002')!.id;
    financeStaffId = staff.find((row) => row.employee_number === 'EMP-0004')!.id;
  });

  it('gates salary data and keeps amounts out of the audit trail', async () => {
    const admin = await login('admin@demo.test', 'Admin@12345');
    const finance = await login('finance@demo.test', 'Finance@12345');
    const auditor = await login('auditor@demo.test', 'Auditor@12345');

    const list = await call('GET', `/api/schools/${schoolId}/staff`, { cookie: auditor });
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBeGreaterThanOrEqual(5);
    expect(list.body.items[0]).not.toHaveProperty('amount');

    const auditorSalaries = await call('GET', `/api/schools/${schoolId}/staff/salaries`, {
      cookie: auditor,
    });
    expect(auditorSalaries.status).toBe(403);

    const financeSalaries = await call('GET', `/api/schools/${schoolId}/staff/salaries`, {
      cookie: finance,
    });
    expect(financeSalaries.status).toBe(403);

    const adminSalaries = await call('GET', `/api/schools/${schoolId}/staff/salaries`, {
      cookie: admin,
    });
    expect(adminSalaries.status).toBe(200);
    expect(adminSalaries.body.items.length).toBeGreaterThanOrEqual(5);
    expect(adminSalaries.body.items.every((row: { amount: number }) => row.amount > 0)).toBe(true);

    const updated = await call(
      'PUT',
      `/api/schools/${schoolId}/staff/${financeStaffId}/salary`,
      {
        cookie: admin,
        payload: {
          amount: 65000,
          currency: 'INR',
          effectiveFrom: '2026-10-01',
          notes: 'Annual revision',
        },
      },
    );
    expect(updated.status).toBe(200);
    expect(updated.body.amount).toBe(65000);

    const audit = await q<{ after_state: Record<string, unknown> }>(
      `SELECT after_state FROM audit_events
       WHERE school_id = $1 AND action = 'hr.salary_updated' AND entity_id = $2`,
      [schoolId, financeStaffId],
    );
    expect(audit.length).toBe(1);
    expect(audit[0]!.after_state).not.toHaveProperty('amount');
    expect(audit[0]!.after_state).toMatchObject({ effectiveFrom: '2026-10-01', currency: 'INR' });
  });

  it('enforces own-record and non-overlap rules for leave', async () => {
    const teacher = await login('teacher@demo.test', 'Teacher@12345');
    const coordinator = await login('coordinator@demo.test', 'Coord@12345');
    const admin = await login('admin@demo.test', 'Admin@12345');

    const request = await call('POST', `/api/schools/${schoolId}/leave`, {
      cookie: teacher,
      payload: {
        leaveType: 'casual',
        startsOn: '2026-12-10',
        endsOn: '2026-12-11',
        reason: 'Family commitment out of town',
      },
    });
    expect(request.status).toBe(201);
    expect(request.body.staffId).toBe(teacherStaffId);
    expect(request.body.days).toBe(2);

    const overlap = await call('POST', `/api/schools/${schoolId}/leave`, {
      cookie: teacher,
      payload: {
        leaveType: 'casual',
        startsOn: '2026-12-11',
        endsOn: '2026-12-12',
        reason: 'Overlapping request should be rejected',
      },
    });
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.code).toBe('leave_overlap');

    const someoneElse = await call('POST', `/api/schools/${schoolId}/leave`, {
      cookie: teacher,
      payload: {
        staffId: coordinatorStaffId,
        leaveType: 'casual',
        startsOn: '2026-12-15',
        endsOn: '2026-12-16',
        reason: 'Teacher cannot request leave for a colleague',
      },
    });
    expect(someoneElse.status).toBe(403);

    const approved = await call(
      'POST',
      `/api/schools/${schoolId}/leave/${request.body.id}/review`,
      { cookie: coordinator, payload: { decision: 'approve', note: 'Cover arranged' } },
    );
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('approved');

    const reviewedAgain = await call(
      'POST',
      `/api/schools/${schoolId}/leave/${request.body.id}/review`,
      { cookie: admin, payload: { decision: 'reject' } },
    );
    expect(reviewedAgain.status).toBe(409);

    const cancelApproved = await call(
      'POST',
      `/api/schools/${schoolId}/leave/${request.body.id}/cancel`,
      { cookie: teacher },
    );
    expect(cancelApproved.status).toBe(409);

    const ownList = await call('GET', `/api/schools/${schoolId}/leave`, { cookie: teacher });
    expect(ownList.status).toBe(200);
    expect(
      ownList.body.items.every((row: { staffId: string }) => row.staffId === teacherStaffId),
    ).toBe(true);
    expect(ownList.body.items.length).toBeGreaterThanOrEqual(2);
  });

  it('blocks self-approval and only lets pending leave be cancelled', async () => {
    const coordinator = await login('coordinator@demo.test', 'Coord@12345');
    const admin = await login('admin@demo.test', 'Admin@12345');
    const finance = await login('finance@demo.test', 'Finance@12345');

    const ownRequest = await call('POST', `/api/schools/${schoolId}/leave`, {
      cookie: coordinator,
      payload: {
        leaveType: 'earned',
        startsOn: '2026-12-20',
        endsOn: '2026-12-21',
        reason: 'Attending a curriculum workshop',
      },
    });
    expect(ownRequest.status).toBe(201);
    expect(ownRequest.body.staffId).toBe(coordinatorStaffId);

    const selfApproval = await call(
      'POST',
      `/api/schools/${schoolId}/leave/${ownRequest.body.id}/review`,
      { cookie: coordinator, payload: { decision: 'approve' } },
    );
    expect(selfApproval.status).toBe(409);
    expect(selfApproval.body.error.code).toBe('self_approval');

    const adminApproves = await call(
      'POST',
      `/api/schools/${schoolId}/leave/${ownRequest.body.id}/review`,
      { cookie: admin, payload: { decision: 'approve' } },
    );
    expect(adminApproves.status).toBe(200);
    expect(adminApproves.body.status).toBe('approved');

    const financeRequest = await call('POST', `/api/schools/${schoolId}/leave`, {
      cookie: finance,
      payload: {
        leaveType: 'casual',
        startsOn: '2026-12-22',
        endsOn: '2026-12-23',
        reason: 'Personal appointment in the afternoon',
      },
    });
    expect(financeRequest.status).toBe(201);
    expect(financeRequest.body.staffId).toBe(financeStaffId);

    const cancelled = await call(
      'POST',
      `/api/schools/${schoolId}/leave/${financeRequest.body.id}/cancel`,
      { cookie: finance },
    );
    expect(cancelled.status).toBe(204);

    const financeList = await call('GET', `/api/schools/${schoolId}/leave`, { cookie: finance });
    const cancelledRow = financeList.body.items.find(
      (row: { id: string }) => row.id === financeRequest.body.id,
    );
    expect(cancelledRow.status).toBe('cancelled');
  });
});

describe('notices', () => {
  it('derives audience visibility from roles and hides drafts from readers', async () => {
    const admin = await login('admin@demo.test', 'Admin@12345');
    const teacher = await login('teacher@demo.test', 'Teacher@12345');
    const parent = await login('parent@demo.test', 'Parent@12345');

    const staffNotice = await call('POST', `/api/schools/${schoolId}/notices`, {
      cookie: admin,
      payload: {
        title: 'Staff-only timetable briefing',
        body: 'A short briefing for all teaching staff about the December timetable.',
        audience: 'staff',
        pinned: false,
      },
    });
    expect(staffNotice.status).toBe(201);
    expect(staffNotice.body.status).toBe('draft');

    const draftTeacher = await call('GET', `/api/schools/${schoolId}/notices`, {
      cookie: teacher,
    });
    expect(
      draftTeacher.body.items.some(
        (row: { id: string }) => row.id === staffNotice.body.id,
      ),
    ).toBe(false);

    const drafts = await call('GET', `/api/schools/${schoolId}/notices?status=draft`, {
      cookie: admin,
    });
    expect(
      drafts.body.items.some((row: { id: string }) => row.id === staffNotice.body.id),
    ).toBe(true);

    const published = await call(
      'PATCH',
      `/api/schools/${schoolId}/notices/${staffNotice.body.id}`,
      { cookie: admin, payload: { status: 'published' } },
    );
    expect(published.status).toBe(200);
    expect(published.body.status).toBe('published');

    const teacherSeesStaff = await call('GET', `/api/schools/${schoolId}/notices`, {
      cookie: teacher,
    });
    expect(
      teacherSeesStaff.body.items.some(
        (row: { id: string }) => row.id === staffNotice.body.id,
      ),
    ).toBe(true);

    const parentDoesNotSeeStaff = await call('GET', `/api/schools/${schoolId}/notices`, {
      cookie: parent,
    });
    expect(
      parentDoesNotSeeStaff.body.items.some(
        (row: { id: string }) => row.id === staffNotice.body.id,
      ),
    ).toBe(false);

    const parentNotice = await call('POST', `/api/schools/${schoolId}/notices`, {
      cookie: admin,
      payload: {
        title: 'Parents evening reminder',
        body: 'Parents evening starts at 5 pm in the assembly hall on Friday.',
        audience: 'parents',
        pinned: true,
        expiresOn: '2027-03-31',
      },
    });
    expect(parentNotice.status).toBe(201);
    await call('PATCH', `/api/schools/${schoolId}/notices/${parentNotice.body.id}`, {
      cookie: admin,
      payload: { status: 'published' },
    });

    const parentSeesOwn = await call('GET', `/api/schools/${schoolId}/notices`, {
      cookie: parent,
    });
    expect(
      parentSeesOwn.body.items.some(
        (row: { id: string }) => row.id === parentNotice.body.id,
      ),
    ).toBe(true);
    expect(
      parentSeesOwn.body.items.every((row: { audience: string }) =>
        ['all', 'parents'].includes(row.audience),
      ),
    ).toBe(true);

    const teacherDoesNotSeeParents = await call('GET', `/api/schools/${schoolId}/notices`, {
      cookie: teacher,
    });
    expect(
      teacherDoesNotSeeParents.body.items.some(
        (row: { id: string }) => row.id === parentNotice.body.id,
      ),
    ).toBe(false);

    const expired = await call('POST', `/api/schools/${schoolId}/notices`, {
      cookie: admin,
      payload: {
        title: 'Expired assembly notice',
        body: 'This notice expired before it could be read by the school.',
        audience: 'all',
        expiresOn: '2020-01-01',
      },
    });
    expect(expired.status).toBe(201);
    await call('PATCH', `/api/schools/${schoolId}/notices/${expired.body.id}`, {
      cookie: admin,
      payload: { status: 'published' },
    });
    const teacherAfterExpiry = await call('GET', `/api/schools/${schoolId}/notices`, {
      cookie: teacher,
    });
    expect(
      teacherAfterExpiry.body.items.some((row: { id: string }) => row.id === expired.body.id),
    ).toBe(false);

    const teacherWrite = await call('POST', `/api/schools/${schoolId}/notices`, {
      cookie: teacher,
      payload: {
        title: 'Teacher should not publish',
        body: 'Only notice managers may create notices in this school.',
        audience: 'all',
      },
    });
    expect(teacherWrite.status).toBe(403);

    const archived = await call(
      'PATCH',
      `/api/schools/${schoolId}/notices/${staffNotice.body.id}`,
      { cookie: admin, payload: { status: 'archived' } },
    );
    expect(archived.status).toBe(200);
    expect(archived.body.status).toBe('archived');

    const removed = await call(
      'DELETE',
      `/api/schools/${schoolId}/notices/${staffNotice.body.id}`,
      { cookie: admin },
    );
    expect(removed.status).toBe(204);
    const removedAgain = await call(
      'DELETE',
      `/api/schools/${schoolId}/notices/${staffNotice.body.id}`,
      { cookie: admin },
    );
    expect(removedAgain.status).toBe(404);
  });
});

describe('notice attachments and read receipts', () => {
  it('enforces audience access, file limits and tracks reads', async () => {
    const admin = await login('admin@demo.test', 'Admin@12345');
    const teacher = await login('teacher@demo.test', 'Teacher@12345');
    const parent = await login('parent@demo.test', 'Parent@12345');

    const notice = await call('POST', `/api/schools/${schoolId}/notices`, {
      cookie: admin,
      payload: {
        title: 'Parents evening with attached map',
        body: 'Please review the attached map before parents evening.',
        audience: 'parents',
        pinned: false,
      },
    });
    expect(notice.status).toBe(201);
    await call('PATCH', `/api/schools/${schoolId}/notices/${notice.body.id}`, {
      cookie: admin,
      payload: { status: 'published' },
    });

    const uploaded = await call(
      'POST',
      `/api/schools/${schoolId}/notices/${notice.body.id}/attachments`,
      {
        cookie: admin,
        payload: {
          filename: 'map.txt',
          contentType: 'text/plain',
          dataBase64: Buffer.from('campus map').toString('base64'),
        },
      },
    );
    expect(uploaded.status).toBe(201);
    expect(uploaded.body.filename).toBe('map.txt');
    expect(uploaded.body.byteSize).toBe(10);

    const tooLarge = await call(
      'POST',
      `/api/schools/${schoolId}/notices/${notice.body.id}/attachments`,
      {
        cookie: admin,
        payload: {
          filename: 'big.bin',
          contentType: 'application/octet-stream',
          dataBase64: Buffer.alloc(1024 * 1024 + 1).toString('base64'),
        },
      },
    );
    expect(tooLarge.status).toBe(400);

    const empty = await call(
      'POST',
      `/api/schools/${schoolId}/notices/${notice.body.id}/attachments`,
      {
        cookie: admin,
        payload: { filename: 'empty.txt', contentType: 'text/plain', dataBase64: '' },
      },
    );
    expect(empty.status).toBe(400);

    const teacherUpload = await call(
      'POST',
      `/api/schools/${schoolId}/notices/${notice.body.id}/attachments`,
      {
        cookie: teacher,
        payload: {
          filename: 'nope.txt',
          contentType: 'text/plain',
          dataBase64: Buffer.from('nope').toString('base64'),
        },
      },
    );
    expect(teacherUpload.status).toBe(403);

    const parentList = await call('GET', `/api/schools/${schoolId}/notices`, { cookie: parent });
    const parentRow = parentList.body.items.find(
      (row: { id: string }) => row.id === notice.body.id,
    );
    expect(parentRow.attachments).toHaveLength(1);
    expect(parentRow.readByMe).toBe(false);
    expect(parentRow.readCount).toBeNull();

    const download = await call(
      'GET',
      `/api/schools/${schoolId}/notices/${notice.body.id}/attachments/${uploaded.body.id}`,
      { cookie: parent },
    );
    expect(download.status).toBe(200);
    expect(String(download.body)).toBe('campus map');

    const teacherDownload = await call(
      'GET',
      `/api/schools/${schoolId}/notices/${notice.body.id}/attachments/${uploaded.body.id}`,
      { cookie: teacher },
    );
    expect(teacherDownload.status).toBe(404);

    const marked = await call('POST', `/api/schools/${schoolId}/notices/${notice.body.id}/read`, {
      cookie: parent,
    });
    expect(marked.status).toBe(200);

    const afterRead = await call('GET', `/api/schools/${schoolId}/notices`, { cookie: parent });
    expect(
      afterRead.body.items.find((row: { id: string }) => row.id === notice.body.id).readByMe,
    ).toBe(true);

    const adminList = await call('GET', `/api/schools/${schoolId}/notices?status=published`, {
      cookie: admin,
    });
    expect(
      adminList.body.items.find((row: { id: string }) => row.id === notice.body.id).readCount,
    ).toBe(1);

    const deleted = await call(
      'DELETE',
      `/api/schools/${schoolId}/notices/${notice.body.id}/attachments/${uploaded.body.id}`,
      { cookie: admin },
    );
    expect(deleted.status).toBe(204);

    const gone = await call(
      'GET',
      `/api/schools/${schoolId}/notices/${notice.body.id}/attachments/${uploaded.body.id}`,
      { cookie: parent },
    );
    expect(gone.status).toBe(404);
  });
});

describe('reports and CSV exports', () => {
  it('computes attendance and fee reports from recorded rows', async () => {
    const coordinator = await login('coordinator@demo.test', 'Coord@12345');
    const teacher = await login('teacher@demo.test', 'Teacher@12345');

    const attendance = await call(
      'GET',
      `/api/schools/${schoolId}/reports/attendance?from=2026-04-01&to=2027-03-31`,
      { cookie: coordinator },
    );
    expect(attendance.status).toBe(200);
    expect(attendance.body.from).toBe('2026-04-01');
    expect(attendance.body.to).toBe('2027-03-31');
    const g1 = attendance.body.sections.find(
      (row: { className: string; sectionName: string }) =>
        row.className === 'Grade 1' && row.sectionName === 'Section A',
    );
    expect(g1).toBeTruthy();
    expect(g1.totalMarked).toBeGreaterThan(0);
    const expectedRate =
      Math.round(
        (((g1.present + g1.late + g1.halfDay * 0.5) / g1.totalMarked) * 100) * 10,
      ) / 10;
    expect(g1.attendanceRate).toBeCloseTo(expectedRate, 1);

    const teacherReport = await call(
      'GET',
      `/api/schools/${schoolId}/reports/attendance`,
      { cookie: teacher },
    );
    expect(teacherReport.status).toBe(403);

    const fees = await call('GET', `/api/schools/${schoolId}/reports/fees`, {
      cookie: coordinator,
    });
    expect(fees.status).toBe(200);
    const headCharged = fees.body.byHead.reduce(
      (sum: number, row: { charged: number }) => sum + row.charged,
      0,
    );
    expect(headCharged).toBeCloseTo(332000, 2);
    for (const row of fees.body.byHead) {
      expect(row.outstanding).toBeCloseTo(row.charged - row.collected, 2);
    }

    const methodRows = await q<{ total: string; count: string }>(
      `SELECT COALESCE(sum(amount), 0)::text AS total, count(*)::text AS count
       FROM payments WHERE school_id = $1 AND status = 'recorded'`,
      [schoolId],
    );
    const methodTotal = fees.body.byMethod.reduce(
      (sum: number, row: { amount: number }) => sum + row.amount,
      0,
    );
    expect(methodTotal).toBeCloseTo(Number(methodRows[0]!.total), 2);
    expect(
      fees.body.byMethod.reduce((sum: number, row: { count: number }) => sum + row.count, 0),
    ).toBe(Number(methodRows[0]!.count));
  });

  it('downloads UTF-8 CSV files with a BOM and honest headers', async () => {
    const auditor = await login('auditor@demo.test', 'Auditor@12345');

    const students = await call(
      'GET',
      `/api/schools/${schoolId}/reports/export?type=students`,
      { cookie: auditor },
    );
    expect(students.status).toBe(200);
    expect(String(students.headers['content-type'])).toContain('text/csv');
    expect(String(students.headers['content-disposition'])).toContain('students.csv');
    expect(students.body.startsWith('\uFEFF')).toBe(true);
    expect(students.body).toContain('Admission no');
    expect(students.body).toContain('Aarav');

    const attendance = await call(
      'GET',
      `/api/schools/${schoolId}/reports/export?type=attendance&from=2026-04-01&to=2027-03-31`,
      { cookie: auditor },
    );
    expect(attendance.status).toBe(200);
    expect(attendance.body.startsWith('\uFEFF')).toBe(true);
    expect(attendance.body).toContain('Rate %');

    const fees = await call(
      'GET',
      `/api/schools/${schoolId}/reports/export?type=fees`,
      { cookie: auditor },
    );
    expect(fees.status).toBe(200);
    expect(fees.body.startsWith('\uFEFF')).toBe(true);
    expect(fees.body).toContain('Balance');

    const teacher = await login('teacher@demo.test', 'Teacher@12345');
    const forbidden = await call(
      'GET',
      `/api/schools/${schoolId}/reports/export?type=students`,
      { cookie: teacher },
    );
    expect(forbidden.status).toBe(403);

    const invalid = await call(
      'GET',
      `/api/schools/${schoolId}/reports/export?type=passwords`,
      { cookie: auditor },
    );
    expect(invalid.status).toBe(400);

    const reversed = await call(
      'GET',
      `/api/schools/${schoolId}/reports/attendance?from=2027-03-31&to=2026-04-01`,
      { cookie: auditor },
    );
    expect(reversed.status).toBe(400);
  });
});

describe('user and role administration', () => {
  let g1a: string;
  let adminUserId: string;

  beforeAll(async () => {
    const years = await q<{ id: string }>(
      `SELECT id FROM academic_years WHERE school_id = $1 AND status = 'active'`,
      [schoolId],
    );
    const sections = await q<{ id: string; class_code: string; section_code: string }>(
      `SELECT sec.id, c.code AS class_code, sec.code AS section_code
       FROM sections sec JOIN classes c ON c.id = sec.class_id
       WHERE sec.school_id = $1 AND sec.academic_year_id = $2`,
      [schoolId, years[0]!.id],
    );
    g1a = sections.find((row) => row.class_code === 'G1' && row.section_code === 'A')!.id;
    const admin = await q<{ id: string }>(
      `SELECT id FROM users WHERE lower(email) = 'admin@demo.test'`,
    );
    adminUserId = admin[0]!.id;
  });

  it('creates an account with a hashed password and a scoped role', async () => {
    const admin = await login('admin@demo.test', 'Admin@12345');

    const weak = await call('POST', `/api/schools/${schoolId}/users`, {
      cookie: admin,
      payload: {
        email: 'new.auditor@demo.test',
        displayName: 'New Auditor',
        password: 'short',
        roleCode: 'auditor',
        scopeType: 'school',
      },
    });
    expect(weak.status).toBe(400);
    expect(weak.body.error.details.password).toBeTruthy();

    const created = await call('POST', `/api/schools/${schoolId}/users`, {
      cookie: admin,
      payload: {
        email: 'new.auditor@demo.test',
        displayName: 'New Auditor',
        password: 'NewAuditor@12345',
        roleCode: 'auditor',
        scopeType: 'school',
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.email).toBe('new.auditor@demo.test');
    expect(created.body.roles).toHaveLength(1);
    expect(created.body.roles[0].roleCode).toBe('auditor');

    const loginAsNew = await login('new.auditor@demo.test', 'NewAuditor@12345');
    const me = await call('GET', '/api/auth/me', { cookie: loginAsNew });
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('new.auditor@demo.test');

    const duplicate = await call('POST', `/api/schools/${schoolId}/users`, {
      cookie: admin,
      payload: {
        email: 'new.auditor@demo.test',
        displayName: 'Duplicate',
        password: 'NewAuditor@12345',
        roleCode: 'auditor',
        scopeType: 'school',
      },
    });
    expect(duplicate.status).toBe(409);

    const badScope = await call('POST', `/api/schools/${schoolId}/users`, {
      cookie: admin,
      payload: {
        email: 'bad.scope@demo.test',
        displayName: 'Bad Scope',
        password: 'BadScope@12345',
        roleCode: 'teacher',
        scopeType: 'section',
        scopeId: '00000000-0000-4000-8000-000000000000',
      },
    });
    expect(badScope.status).toBe(404);

    const grant = await call(
      'POST',
      `/api/schools/${schoolId}/users/${created.body.id}/roles`,
      {
        cookie: admin,
        payload: { roleCode: 'teacher', scopeType: 'section', scopeId: g1a },
      },
    );
    expect(grant.status).toBe(201);

    const users = await call('GET', `/api/schools/${schoolId}/users`, { cookie: admin });
    expect(users.status).toBe(200);
    const newUser = users.body.items.find(
      (row: { id: string }) => row.id === created.body.id,
    );
    expect(newUser.roles).toHaveLength(2);

    const revoke = await call(
      'DELETE',
      `/api/schools/${schoolId}/users/${created.body.id}/roles/${grant.body.id}`,
      { cookie: admin },
    );
    expect(revoke.status).toBe(204);

    const teacher = await login('teacher@demo.test', 'Teacher@12345');
    const forbidden = await call('GET', `/api/schools/${schoolId}/users`, { cookie: teacher });
    expect(forbidden.status).toBe(403);
  });

  it('protects the last administrator and revokes sessions when an account is disabled', async () => {
    const admin = await login('admin@demo.test', 'Admin@12345');

    const disableSelf = await call(
      'PATCH',
      `/api/schools/${schoolId}/users/${adminUserId}/status`,
      { cookie: admin, payload: { status: 'disabled' } },
    );
    expect(disableSelf.status).toBe(403);

    const users = await call('GET', `/api/schools/${schoolId}/users`, { cookie: admin });
    const adminRecord = users.body.items.find(
      (row: { id: string }) => row.id === adminUserId,
    );
    const lastAssignment = adminRecord.roles[0];
    const revokeSelf = await call(
      'DELETE',
      `/api/schools/${schoolId}/users/${adminUserId}/roles/${lastAssignment.assignmentId}`,
      { cookie: admin },
    );
    expect(revokeSelf.status).toBe(403);

    const created = await call('POST', `/api/schools/${schoolId}/users`, {
      cookie: admin,
      payload: {
        email: 'disabled.user@demo.test',
        displayName: 'Disabled User',
        password: 'Disabled@12345',
        roleCode: 'auditor',
        scopeType: 'school',
      },
    });
    expect(created.status).toBe(201);
    const session = await login('disabled.user@demo.test', 'Disabled@12345');

    const disabled = await call(
      'PATCH',
      `/api/schools/${schoolId}/users/${created.body.id}/status`,
      { cookie: admin, payload: { status: 'disabled' } },
    );
    expect(disabled.status, JSON.stringify(disabled.body)).toBe(200);
    expect(disabled.body.status).toBe('disabled');

    cookies.delete('disabled.user@demo.test');
    const afterDisable = await call('GET', '/api/auth/me', { cookie: session });
    expect(afterDisable.status).toBe(401);
  });
});

describe('safeguarding cases', () => {
  let studentId: string;

  beforeAll(async () => {
    const students = await q<{ id: string }>(
      `SELECT id FROM students WHERE school_id = $1 ORDER BY admission_number LIMIT 1`,
      [schoolId],
    );
    studentId = students[0]!.id;
  });

  it('hides cases from roles without the safeguarding permission', async () => {
    const coordinator = await login('coordinator@demo.test', 'Coord@12345');
    const list = await call('GET', `/api/schools/${schoolId}/safeguarding`, { cookie: coordinator });
    expect(list.status).toBe(403);

    const create = await call('POST', `/api/schools/${schoolId}/safeguarding`, {
      cookie: coordinator,
      payload: {
        studentId,
        category: 'wellbeing',
        severity: 'low',
        summary: 'Coordinator should not be able to open this case.',
      },
    });
    expect(create.status).toBe(403);
  });

  it('opens, notes, monitors and closes a case while keeping note text out of the audit trail', async () => {
    const admin = await login('admin@demo.test', 'Admin@12345');
    const summary = 'Synthetic integration concern recorded for safeguarding coverage.';

    const created = await call('POST', `/api/schools/${schoolId}/safeguarding`, {
      cookie: admin,
      payload: {
        studentId,
        category: 'wellbeing',
        severity: 'high',
        summary,
        openedOn: '2026-10-20',
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.reference).toMatch(/^SG-\d{4}$/);
    expect(created.body.status).toBe('open');
    expect(created.body.noteCount).toBe(0);

    const detail = await call('GET', `/api/schools/${schoolId}/safeguarding/${created.body.id}`, {
      cookie: admin,
    });
    expect(detail.status).toBe(200);
    expect(detail.body.notes).toEqual([]);

    const noteText = 'Synthetic follow-up note that must not be copied into audit evidence.';
    const note = await call(
      'POST',
      `/api/schools/${schoolId}/safeguarding/${created.body.id}/notes`,
      { cookie: admin, payload: { note: noteText } },
    );
    expect(note.status).toBe(201);
    expect(note.body.note).toBe(noteText);

    const monitoring = await call(
      'PATCH',
      `/api/schools/${schoolId}/safeguarding/${created.body.id}`,
      { cookie: admin, payload: { status: 'monitoring' } },
    );
    expect(monitoring.status).toBe(200);
    expect(monitoring.body.status).toBe('monitoring');

    const closed = await call(
      'PATCH',
      `/api/schools/${schoolId}/safeguarding/${created.body.id}`,
      { cookie: admin, payload: { status: 'closed' } },
    );
    expect(closed.status).toBe(200);
    expect(closed.body.status).toBe('closed');
    expect(closed.body.closedOn).toBeTruthy();

    const blocked = await call(
      'POST',
      `/api/schools/${schoolId}/safeguarding/${created.body.id}/notes`,
      { cookie: admin, payload: { note: 'This note should be blocked.' } },
    );
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('case_closed');

    const audit = await q<{ after_state: unknown }>(
      `SELECT after_state FROM audit_events
       WHERE school_id = $1 AND entity_id = $2 ORDER BY occurred_at`,
      [schoolId, created.body.id],
    );
    const auditText = JSON.stringify(audit);
    expect(auditText).not.toContain(summary);
    expect(auditText).not.toContain(noteText);
  });
});

describe('leave configuration and balances', () => {
  let teacherStaffId: string;

  beforeAll(async () => {
    const staff = await q<{ id: string }>(
      `SELECT s.id FROM staff s
       JOIN users u ON u.id = s.user_id
       WHERE s.school_id = $1 AND lower(u.email) = 'teacher@demo.test'`,
      [schoolId],
    );
    teacherStaffId = staff[0]!.id;
  });

  it('lets staff read active leave types but only administrators configure them', async () => {
    const teacher = await login('teacher@demo.test', 'Teacher@12345');
    const coordinator = await login('coordinator@demo.test', 'Coord@12345');
    const admin = await login('admin@demo.test', 'Admin@12345');

    const types = await call('GET', `/api/schools/${schoolId}/leave/types`, { cookie: teacher });
    expect(types.status).toBe(200);
    expect(types.body.items.length).toBeGreaterThan(0);
    expect(types.body.items.every((row: { active: boolean }) => row.active)).toBe(true);

    const denied = await call('POST', `/api/schools/${schoolId}/leave/types`, {
      cookie: coordinator,
      payload: { code: 'study', name: 'Study leave', annualQuotaDays: 5, paid: true, active: true },
    });
    expect(denied.status).toBe(403);

    const created = await call('POST', `/api/schools/${schoolId}/leave/types`, {
      cookie: admin,
      payload: { code: 'study', name: 'Study leave', annualQuotaDays: 5, paid: true, active: true },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.code).toBe('study');

    const updated = await call(
      'PATCH',
      `/api/schools/${schoolId}/leave/types/${created.body.id}`,
      { cookie: admin, payload: { annualQuotaDays: 8 } },
    );
    expect(updated.status).toBe(200);
    expect(updated.body.annualQuotaDays).toBe(8);

    const inactive = await call(
      'PATCH',
      `/api/schools/${schoolId}/leave/types/${created.body.id}`,
      { cookie: admin, payload: { active: false } },
    );
    expect(inactive.status).toBe(200);
    expect(inactive.body.active).toBe(false);
  });

  it('rejects unconfigured leave types once the school has configuration', async () => {
    const teacher = await login('teacher@demo.test', 'Teacher@12345');
    const response = await call('POST', `/api/schools/${schoolId}/leave`, {
      cookie: teacher,
      payload: {
        leaveType: 'not_a_real_type',
        startsOn: '2026-12-14',
        endsOn: '2026-12-15',
        reason: 'Testing configured leave type validation',
      },
    });
    expect(response.status).toBe(400);
    expect(response.body.error.details.leaveType).toBeTruthy();
  });

  it('derives per-staff balances and manages the holiday calendar', async () => {
    const teacher = await login('teacher@demo.test', 'Teacher@12345');
    const admin = await login('admin@demo.test', 'Admin@12345');

    const own = await call(
      'GET',
      `/api/schools/${schoolId}/leave/balances?year=2026&staffId=${teacherStaffId}`,
      { cookie: teacher },
    );
    expect(own.status).toBe(200);
    expect(own.body.year).toBe(2026);
    expect(own.body.items.length).toBeGreaterThan(0);
    expect(own.body.items.every((row: { staffId: string }) => row.staffId === teacherStaffId)).toBe(
      true,
    );
    const casual = own.body.items.find((row: { leaveType: string }) => row.leaveType === 'casual');
    expect(casual).toBeTruthy();
    expect(casual.quotaDays).toBeGreaterThan(0);
    expect(casual.approvedDays).toBeGreaterThanOrEqual(0);

    const all = await call('GET', `/api/schools/${schoolId}/leave/balances?year=2026`, {
      cookie: admin,
    });
    expect(all.status).toBe(200);
    expect(all.body.items.length).toBeGreaterThan(own.body.items.length);

    const holiday = await call('POST', `/api/schools/${schoolId}/holidays`, {
      cookie: admin,
      payload: { name: 'Synthetic Founders Day', holidayOn: '2027-02-19', notes: 'Test holiday' },
    });
    expect(holiday.status).toBe(201);

    const holidays = await call('GET', `/api/schools/${schoolId}/holidays?year=2027`, {
      cookie: teacher,
    });
    expect(holidays.status).toBe(200);
    expect(
      holidays.body.items.some(
        (row: { id: string }) => row.id === holiday.body.id,
      ),
    ).toBe(true);

    const removed = await call(
      'DELETE',
      `/api/schools/${schoolId}/holidays/${holiday.body.id}`,
      { cookie: admin },
    );
    expect(removed.status).toBe(204);
  });
});

describe('payroll', () => {
  let secondAdminEmail: string;

  beforeAll(async () => {
    secondAdminEmail = 'payroll.admin@demo.test';
    const admin = await login('admin@demo.test', 'Admin@12345');
    const existing = await q<{ id: string }>(
      `SELECT id FROM users WHERE lower(email) = lower($1)`,
      [secondAdminEmail],
    );
    if (existing.length === 0) {
      const created = await call('POST', `/api/schools/${schoolId}/users`, {
        cookie: admin,
        payload: {
          email: secondAdminEmail,
          displayName: 'Payroll Approver',
          password: 'PayrollAdmin@12345',
          roleCode: 'main_admin',
          scopeType: 'school',
        },
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
    }
  });

  it('gates payroll behind the sensitive salary permission', async () => {
    const finance = await login('finance@demo.test', 'Finance@12345');
    const denied = await call('GET', `/api/schools/${schoolId}/payroll`, { cookie: finance });
    expect(denied.status).toBe(403);
  });

  it('creates a draft run, blocks self-approval and pays it after a second approver signs off', async () => {
    const admin = await login('admin@demo.test', 'Admin@12345');
    const approver = await login(secondAdminEmail, 'PayrollAdmin@12345');

    const created = await call('POST', `/api/schools/${schoolId}/payroll`, {
      cookie: admin,
      payload: {
        periodStart: '2026-12-01',
        periodEnd: '2026-12-31',
        notes: 'Synthetic December integration payroll',
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.status).toBe('draft');
    expect(created.body.payslipCount).toBeGreaterThan(0);
    const runId = created.body.id;

    const detail = await call('GET', `/api/schools/${schoolId}/payroll/${runId}`, { cookie: admin });
    expect(detail.status).toBe(200);
    expect(detail.body.payslips.length).toBe(created.body.payslipCount);
    expect(detail.body.netTotal).toBeGreaterThan(0);

    const selfApproval = await call(
      'POST',
      `/api/schools/${schoolId}/payroll/${runId}/approve`,
      { cookie: admin },
    );
    expect(selfApproval.status).toBe(409);
    expect(selfApproval.body.error.code).toBe('self_approval');

    const approved = await call(
      'POST',
      `/api/schools/${schoolId}/payroll/${runId}/approve`,
      { cookie: approver },
    );
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.status).toBe('approved');
    expect(approved.body.approvedByName).toBe('Payroll Approver');

    const edit = await call(
      'PATCH',
      `/api/schools/${schoolId}/payroll/${runId}/payslips/${detail.body.payslips[0].id}`,
      { cookie: admin, payload: { deductions: 10 } },
    );
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe('not_draft');

    const paid = await call('POST', `/api/schools/${schoolId}/payroll/${runId}/pay`, {
      cookie: admin,
      payload: { paidOn: '2026-12-31' },
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.status).toBe('paid');
    expect(paid.body.paidOn).toBe('2026-12-31');

    const removed = await call('DELETE', `/api/schools/${schoolId}/payroll/${runId}`, {
      cookie: admin,
    });
    expect(removed.status).toBe(409);
    expect(removed.body.error.code).toBe('not_draft');

    const audit = await q<{ after_state: unknown }>(
      `SELECT after_state FROM audit_events
       WHERE school_id = $1 AND entity_id = $2 AND action LIKE 'hr.payroll%'`,
      [schoolId, runId],
    );
    expect(audit.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(audit)).not.toContain('gross');
  });

  it('edits deductions on a draft payslip and deletes the draft run', async () => {
    const admin = await login('admin@demo.test', 'Admin@12345');
    const created = await call('POST', `/api/schools/${schoolId}/payroll`, {
      cookie: admin,
      payload: { periodStart: '2026-10-01', periodEnd: '2026-10-31' },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const detail = await call('GET', `/api/schools/${schoolId}/payroll/${created.body.id}`, {
      cookie: admin,
    });
    const slip = detail.body.payslips[0];
    const edited = await call(
      'PATCH',
      `/api/schools/${schoolId}/payroll/${created.body.id}/payslips/${slip.id}`,
      { cookie: admin, payload: { deductions: 500 } },
    );
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.deductions).toBe(500);
    expect(edited.body.netAmount).toBe(edited.body.grossAmount - 500);

    const removed = await call('DELETE', `/api/schools/${schoolId}/payroll/${created.body.id}`, {
      cookie: admin,
    });
    expect(removed.status).toBe(204);
  });

  it('replays a payroll create request for the same Idempotency-Key', async () => {
    const admin = await login('admin@demo.test', 'Admin@12345');
    const payload = { periodStart: '2026-11-01', periodEnd: '2026-11-30' };
    const key = 'payroll-idem-2026-11';

    const first = await call('POST', `/api/schools/${schoolId}/payroll`, {
      cookie: admin,
      payload,
      idempotencyKey: key,
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    const replay = await call('POST', `/api/schools/${schoolId}/payroll`, {
      cookie: admin,
      payload,
      idempotencyKey: key,
    });
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(first.body.id);

    const mismatch = await call('POST', `/api/schools/${schoolId}/payroll`, {
      cookie: admin,
      payload: { periodStart: '2026-11-02', periodEnd: '2026-11-30' },
      idempotencyKey: key,
    });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.error.code).toBe('idempotency_mismatch');

    const removed = await call('DELETE', `/api/schools/${schoolId}/payroll/${first.body.id}`, {
      cookie: admin,
    });
    expect(removed.status).toBe(204);
  });
});

describe('fee late rules, instalments and printable documents', () => {
  let activeYearId: string;
  let structureId: string;
  let studentId: string;
  let studentName: string;

  beforeAll(async () => {
    const years = await q<{ id: string }>(
      `SELECT id FROM academic_years WHERE school_id = $1 AND status = 'active'`,
      [schoolId],
    );
    activeYearId = years[0]!.id;
    const structures = await q<{ id: string }>(
      `SELECT id FROM fee_structures WHERE school_id = $1 AND academic_year_id = $2 ORDER BY created_at LIMIT 1`,
      [schoolId, activeYearId],
    );
    structureId = structures[0]!.id;
    const students = await q<{ id: string; first_name: string }>(
      `SELECT id, first_name FROM students WHERE school_id = $1 ORDER BY admission_number LIMIT 1`,
      [schoolId],
    );
    studentId = students[0]!.id;
    studentName = students[0]!.first_name;
  });

  it('manages late fee rules with fee permissions only', async () => {
    const finance = await login('finance@demo.test', 'Finance@12345');
    const auditor = await login('auditor@demo.test', 'Auditor@12345');

    const list = await call('GET', `/api/schools/${schoolId}/fee-late-rules`, { cookie: finance });
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBeGreaterThan(0);

    const denied = await call('POST', `/api/schools/${schoolId}/fee-late-rules`, {
      cookie: auditor,
      payload: { name: 'Auditor rule', graceDays: 3, percentPerMonth: 1, maxAmount: 100 },
    });
    expect(denied.status).toBe(403);

    const created = await call('POST', `/api/schools/${schoolId}/fee-late-rules`, {
      cookie: finance,
      payload: {
        name: 'Synthetic integration late rule',
        graceDays: 5,
        percentPerMonth: 2,
        maxAmount: 750,
        active: true,
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const updated = await call(
      'PATCH',
      `/api/schools/${schoolId}/fee-late-rules/${created.body.id}`,
      { cookie: finance, payload: { maxAmount: 800 } },
    );
    expect(updated.status).toBe(200);
    expect(updated.body.maxAmount).toBe(800);
  });

  it('assesses late fees once per charge per day', async () => {
    const finance = await login('finance@demo.test', 'Finance@12345');
    const rules = await call('GET', `/api/schools/${schoolId}/fee-late-rules`, { cookie: finance });
    const rule = rules.body.items.find(
      (row: { name: string }) => row.name === 'Standard monthly late fee',
    );
    expect(rule).toBeTruthy();

    const first = await call('POST', `/api/schools/${schoolId}/fees/late-fees/run`, {
      cookie: finance,
      payload: { ruleId: rule.id, asOf: '2026-12-31', academicYearId: activeYearId },
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.assessed).toBeGreaterThanOrEqual(0);
    expect(first.body.totalFee).toBeGreaterThanOrEqual(0);

    const second = await call('POST', `/api/schools/${schoolId}/fees/late-fees/run`, {
      cookie: finance,
      payload: { ruleId: rule.id, asOf: '2026-12-31', academicYearId: activeYearId },
    });
    expect(second.status).toBe(200);
    expect(second.body.assessed).toBe(0);
  });

  it('validates and stores an instalment plan for a fee structure', async () => {
    const finance = await login('finance@demo.test', 'Finance@12345');

    const invalid = await call(
      'PUT',
      `/api/schools/${schoolId}/fee-structures/${structureId}/installments`,
      {
        cookie: finance,
        payload: {
          items: [{ sequence: 1, label: 'Only term', percent: 90, dueOn: '2026-07-01' }],
        },
      },
    );
    expect(invalid.status).toBe(400);

    const saved = await call(
      'PUT',
      `/api/schools/${schoolId}/fee-structures/${structureId}/installments`,
      {
        cookie: finance,
        payload: {
          items: [
            { sequence: 1, label: 'Term 1', percent: 60, dueOn: '2026-07-01' },
            { sequence: 2, label: 'Term 2', percent: 40, dueOn: '2026-11-01' },
          ],
        },
      },
    );
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);

    const list = await call(
      'GET',
      `/api/schools/${schoolId}/fee-structures/${structureId}/installments`,
      { cookie: finance },
    );
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(2);
    expect(list.body.items[0].percent).toBe(60);

    const derived = await call(
      'GET',
      `/api/schools/${schoolId}/fees/students/${studentId}/installments?academicYearId=${activeYearId}`,
      { cookie: finance },
    );
    expect(derived.status, JSON.stringify(derived.body)).toBe(200);
    expect(Array.isArray(derived.body.items)).toBe(true);
  });

  it('renders an escaped printable invoice and receipt', async () => {
    const finance = await login('finance@demo.test', 'Finance@12345');
    const invoice = await call(
      'GET',
      `/api/schools/${schoolId}/fees/students/${studentId}/invoice?academicYearId=${activeYearId}`,
      { cookie: finance },
    );
    expect(invoice.status, JSON.stringify(invoice.body)).toBe(200);
    expect(String(invoice.headers['content-type'])).toContain('text/html');
    expect(invoice.body).toContain('Fee invoice');
    expect(invoice.body).toContain(studentName);
    expect(invoice.body).toContain('window.print');

    const payments = await q<{ id: string }>(
      `SELECT id FROM payments WHERE school_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [schoolId],
    );
    if (payments[0]) {
      const receipt = await call(
        'GET',
        `/api/schools/${schoolId}/fees/payments/${payments[0].id}/receipt`,
        { cookie: finance },
      );
      expect(receipt.status).toBe(200);
      expect(receipt.body).toContain('Fee receipt');
    }
  });
});

describe('transcripts', () => {
  it('builds a transcript from published report cards and prints it', async () => {
    const admin = await login('admin@demo.test', 'Admin@12345');
    const cards = await q<{ student_id: string }>(
      `SELECT m.student_id
       FROM exam_marks m
       JOIN exam_subjects es ON es.id = m.exam_subject_id AND es.school_id = m.school_id
       JOIN exams e ON e.id = es.exam_id AND e.school_id = es.school_id
       WHERE m.school_id = $1 AND e.status = 'published'
       ORDER BY m.entered_at DESC LIMIT 1`,
      [schoolId],
    );
    expect(cards[0], 'the examinations suite publishes report card marks').toBeTruthy();
    const studentId = cards[0]!.student_id;

    const transcript = await call(
      'GET',
      `/api/schools/${schoolId}/students/${studentId}/transcript`,
      { cookie: admin },
    );
    expect(transcript.status, JSON.stringify(transcript.body)).toBe(200);
    expect(transcript.body.studentId).toBe(studentId);
    expect(transcript.body.exams.length).toBeGreaterThan(0);
    expect(transcript.body.cumulative.totalMarks).toBeGreaterThan(0);
    expect(transcript.body.cumulative.grade).toBeNull();

    const printed = await call(
      'GET',
      `/api/schools/${schoolId}/students/${studentId}/transcript/print`,
      { cookie: admin },
    );
    expect(printed.status).toBe(200);
    expect(String(printed.headers['content-type'])).toContain('text/html');
    expect(printed.body).toContain('Academic transcript');
    expect(printed.body).toContain('window.print');
  });

  it('serves a guardian their own child transcript and blocks unrelated children', async () => {
    const parent = await login('parent@demo.test', 'Parent@12345');
    const linked = await q<{ student_id: string }>(
      `SELECT sg.student_id FROM student_guardians sg
       JOIN guardians g ON g.id = sg.guardian_id
       JOIN users u ON u.id = g.user_id
       WHERE sg.school_id = $1 AND lower(u.email) = 'parent@demo.test'
       ORDER BY sg.student_id LIMIT 1`,
      [schoolId],
    );
    const linkedId = linked[0]!.student_id;
    const allowed = await call(
      'GET',
      `/api/schools/${schoolId}/portal/children/${linkedId}/transcript`,
      { cookie: parent },
    );
    expect(allowed.status).toBe(200);

    const unrelated = await q<{ id: string }>(
      `SELECT id FROM students
       WHERE school_id = $1 AND id NOT IN (
         SELECT sg.student_id FROM student_guardians sg
         JOIN guardians g ON g.id = sg.guardian_id
         JOIN users u ON u.id = g.user_id
         WHERE lower(u.email) = 'parent@demo.test'
       ) ORDER BY admission_number LIMIT 1`,
      [schoolId],
    );
    const denied = await call(
      'GET',
      `/api/schools/${schoolId}/portal/children/${unrelated[0]!.id}/transcript`,
      { cookie: parent },
    );
    expect(denied.status).toBe(404);
  });
});

describe('student CSV import', () => {
  let yearId: string;
  let className: string;
  let sectionName: string;

  beforeAll(async () => {
    const years = await q<{ id: string }>(
      `SELECT id FROM academic_years WHERE school_id = $1 AND status = 'active'`,
      [schoolId],
    );
    yearId = years[0]!.id;
    const sections = await q<{ class_name: string; section_name: string }>(
      `SELECT c.name AS class_name, sec.name AS section_name
       FROM sections sec JOIN classes c ON c.id = sec.class_id
       WHERE sec.school_id = $1 AND sec.academic_year_id = $2
       ORDER BY c.name, sec.name LIMIT 1`,
      [schoolId, yearId],
    );
    className = sections[0]!.class_name;
    sectionName = sections[0]!.section_name;
  });

  it('imports valid rows, reports invalid ones and audits the batch', async () => {
    const admin = await login('admin@demo.test', 'Admin@12345');
    const csv = [
      'first_name,middle_name,last_name,admission_number,date_of_birth,class_name,section_name',
      `Import,Test,Student,IMP-9001,2019-04-01,${className},${sectionName}`,
      `,Missing,First,,2020-01-01,${className},${sectionName}`,
    ].join('\n');

    const response = await call('POST', `/api/schools/${schoolId}/students/import`, {
      cookie: admin,
      payload: { academicYearId: yearId, csv },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.created).toBe(1);
    expect(response.body.failed).toBe(1);
    expect(response.body.errors[0].row).toBe(3);
    expect(response.body.errors[0].message).toContain('first_name');

    const imported = await q<{ id: string }>(
      `SELECT id FROM students WHERE school_id = $1 AND admission_number = 'IMP-9001'`,
      [schoolId],
    );
    expect(imported).toHaveLength(1);

    const audit = await q<{ id: string }>(
      `SELECT id FROM audit_events
       WHERE school_id = $1 AND action = 'students.bulk_imported'
       ORDER BY occurred_at DESC LIMIT 1`,
      [schoolId],
    );
    expect(audit).toHaveLength(1);
  });

  it('rejects the import for roles without admission permission', async () => {
    const teacher = await login('teacher@demo.test', 'Teacher@12345');
    const response = await call('POST', `/api/schools/${schoolId}/students/import`, {
      cookie: teacher,
      payload: { academicYearId: yearId, csv: 'first_name\nTest' },
    });
    expect(response.status).toBe(403);
  });
});

describe('password reset and MFA', () => {
  const resetEmail = 'reset.user@demo.test';
  const mfaEmail = 'mfa.user@demo.test';

  beforeAll(async () => {
    const admin = await login('admin@demo.test', 'Admin@12345');
    for (const [email, displayName, password] of [
      [resetEmail, 'Reset User', 'Initial@12345'],
      [mfaEmail, 'MFA User', 'MfaUser@12345'],
    ] as const) {
      const existing = await q<{ id: string }>(
        `SELECT id FROM users WHERE lower(email) = lower($1)`,
        [email],
      );
      if (existing.length === 0) {
        const created = await call('POST', `/api/schools/${schoolId}/users`, {
          cookie: admin,
          payload: {
            email,
            displayName,
            password,
            roleCode: 'auditor',
            scopeType: 'school',
          },
        });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
      }
    }
  });

  it('issues a single-use reset token and replaces the password', async () => {
    const forgot = await call('POST', '/api/auth/password/forgot', {
      payload: { email: resetEmail },
    });
    expect(forgot.status).toBe(202);
    expect(forgot.body.delivered).toBe(false);
    expect(forgot.body.devToken).toBeTruthy();

    const reset = await call('POST', '/api/auth/password/reset', {
      payload: { token: forgot.body.devToken, newPassword: 'ResetPass@12345' },
    });
    expect(reset.status, JSON.stringify(reset.body)).toBe(204);

    const oldPassword = await call('POST', '/api/auth/login', {
      payload: { email: resetEmail, password: 'Initial@12345' },
    });
    expect(oldPassword.status).toBe(401);

    const newPassword = await call('POST', '/api/auth/login', {
      payload: { email: resetEmail, password: 'ResetPass@12345' },
    });
    expect(newPassword.status).toBe(200);

    const reused = await call('POST', '/api/auth/password/reset', {
      payload: { token: forgot.body.devToken, newPassword: 'AnotherPass@12345' },
    });
    expect(reused.status).toBe(400);
  });

  it('enrols TOTP, challenges the next login and disables it again', async () => {
    const loginResponse = await call('POST', '/api/auth/login', {
      payload: { email: mfaEmail, password: 'MfaUser@12345' },
    });
    expect(loginResponse.status).toBe(200);
    const setCookie = loginResponse.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const cookie = String(raw).split(';')[0]!;

    const status = await call('GET', '/api/auth/mfa', { cookie });
    expect(status.status).toBe(200);
    expect(status.body.enabled).toBe(false);

    const setup = await call('POST', '/api/auth/mfa/setup', { cookie });
    expect(setup.status, JSON.stringify(setup.body)).toBe(200);
    expect(setup.body.secret).toMatch(/^[A-Z2-7]+$/);
    expect(setup.body.otpauthUrl).toContain('otpauth://totp/');

    const wrong = await call('POST', '/api/auth/mfa/enable', {
      cookie,
      payload: { code: '000000' },
    });
    expect(wrong.status).toBe(400);

    const enabled = await call('POST', '/api/auth/mfa/enable', {
      cookie,
      payload: { code: currentTotpCode(setup.body.secret) },
    });
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(204);

    const challenged = await call('POST', '/api/auth/login', {
      payload: { email: mfaEmail, password: 'MfaUser@12345' },
    });
    expect(challenged.status).toBe(401);
    expect(challenged.body.error.code).toBe('mfa_required');

    const invalid = await call('POST', '/api/auth/login', {
      payload: { email: mfaEmail, password: 'MfaUser@12345', totpCode: '000000' },
    });
    expect(invalid.status, JSON.stringify(invalid.body)).toBe(401);
    expect(invalid.body.error.code).toBe('invalid_totp');

    const withCode = await call('POST', '/api/auth/login', {
      payload: {
        email: mfaEmail,
        password: 'MfaUser@12345',
        totpCode: currentTotpCode(setup.body.secret),
      },
    });
    expect(withCode.status, JSON.stringify(withCode.body)).toBe(200);

    const disabled = await call('POST', '/api/auth/mfa/disable', {
      cookie,
      payload: {
        password: 'MfaUser@12345',
        code: currentTotpCode(setup.body.secret),
      },
    });
    expect(disabled.status, JSON.stringify(disabled.body)).toBe(204);

    const finalStatus = await call('GET', '/api/auth/mfa', { cookie });
    expect(finalStatus.body.enabled).toBe(false);
  });
});

describe('student admission idempotency', () => {
  it('replays the exact response and rejects a changed payload for the same key', async () => {
    const admin = await login('admin@demo.test', 'Admin@12345');
    const years = await q<{ id: string }>(
      `SELECT id FROM academic_years WHERE school_id = $1 AND status = 'active'`,
      [schoolId],
    );
    const sections = await q<{ id: string }>(
      `SELECT id FROM sections WHERE school_id = $1 AND academic_year_id = $2 ORDER BY name LIMIT 1`,
      [schoolId, years[0]!.id],
    );
    const payload = {
      admissionNumber: 'IMP-IDEM-1',
      firstName: 'Idempotent',
      lastName: 'Admission',
      academicYearId: years[0]!.id,
      sectionId: sections[0]!.id,
      startsOn: '2026-04-01',
      guardians: [
        {
          firstName: 'Guardian',
          lastName: 'One',
          email: 'guardian.idem@example.test',
          relationshipType: 'Mother',
          isPrimary: true,
          portalAccessStatus: 'pending',
        },
      ],
    };
    const key = 'admission-idem-1';

    const first = await call('POST', `/api/schools/${schoolId}/students`, {
      cookie: admin,
      payload,
      idempotencyKey: key,
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    const replay = await call('POST', `/api/schools/${schoolId}/students`, {
      cookie: admin,
      payload,
      idempotencyKey: key,
    });
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(first.body.id);

    const mismatch = await call('POST', `/api/schools/${schoolId}/students`, {
      cookie: admin,
      payload: { ...payload, firstName: 'Changed' },
      idempotencyKey: key,
    });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.error.code).toBe('idempotency_mismatch');

    const count = await q<{ count: string }>(
      `SELECT count(*)::text AS count FROM students
       WHERE school_id = $1 AND admission_number = 'IMP-IDEM-1'`,
      [schoolId],
    );
    expect(count[0]!.count).toBe('1');
  });
});

describe('row-level security hardening', () => {
  it('scopes rows to app.school_id when the restricted role is used', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const otherSchool = await client.query<{ id: string }>(
        `INSERT INTO schools (code, name, timezone)
         VALUES ('RLS-OTHER', 'Row Level Security Other School', 'UTC')
         RETURNING id`,
      );
      await client.query(
        `INSERT INTO academic_years (school_id, code, name, starts_on, ends_on, status)
         VALUES ($1, '2026', 'Other year', '2026-01-01', '2026-12-31', 'active')`,
        [otherSchool.rows[0]!.id],
      );

      const role = await client.query(
        "SELECT 1 FROM pg_roles WHERE rolname = 'erp_app'",
      );
      expect(role.rowCount).toBe(1);

      await client.query('SET LOCAL ROLE erp_app');
      await client.query("SELECT set_config('app.school_id', $1, true)", [schoolId]);

      const visible = await client.query<{ school_id: string }>(
        'SELECT school_id FROM academic_years',
      );
      expect(visible.rows.length).toBeGreaterThan(0);
      expect(visible.rows.every((row) => row.school_id === schoolId)).toBe(true);

      await client.query("SELECT set_config('app.school_id', '', true)");
      const hidden = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM academic_years',
      );
      expect(hidden.rows[0]!.count).toBe('0');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});
