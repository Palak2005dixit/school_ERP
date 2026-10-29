import { hashPassword } from '@erp/core';
import { PERMISSIONS, PERMISSION_DESCRIPTIONS, ROLES } from '@erp/shared';
import type pg from 'pg';

export interface SeedResult {
  schoolId: string;
  studentsCreated: number;
  usersCreated: number;
}

const DEMO_PASSWORD = {
  admin: 'Admin@12345',
  coordinator: 'Coord@12345',
  teacher: 'Teacher@12345',
  parent: 'Parent@12345',
  finance: 'Finance@12345',
  auditor: 'Auditor@12345',
} as const;

/**
 * Seeds reference data plus a synthetic demo school. Safe to re-run: reference
 * data is refreshed, demo records are upserted, and students are only created
 * when the demo school has none. Never run against a database with real data.
 */
export async function seedDemoData(client: pg.PoolClient): Promise<SeedResult> {
  await client.query('BEGIN');
  try {
    const result = await seed(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function seed(client: pg.PoolClient): Promise<SeedResult> {
  /* ----------------------------- reference data ---------------------------- */
  for (const code of PERMISSIONS) {
    await client.query(
      `INSERT INTO permissions (code, description) VALUES ($1, $2)
       ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description`,
      [code, PERMISSION_DESCRIPTIONS[code]],
    );
  }

  const roleIds = new Map<string, string>();
  for (const role of ROLES) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO roles (code, name, description, privileged_flag)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (code) DO UPDATE
         SET name = EXCLUDED.name,
             description = EXCLUDED.description,
             privileged_flag = EXCLUDED.privileged_flag
       RETURNING id`,
      [role.code, role.name, role.description, role.code === 'main_admin'],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error(`Could not upsert role ${role.code}`);
    roleIds.set(role.code, id);

    await client.query('DELETE FROM role_permissions WHERE role_id = $1', [id]);
    for (const permission of role.permissions) {
      await client.query(
        `INSERT INTO role_permissions (role_id, permission_id)
         SELECT $1, id FROM permissions WHERE code = $2`,
        [id, permission],
      );
    }
  }

  /* ------------------------------- demo school ----------------------------- */
  const school = await one<{ id: string }>(
    client,
    `INSERT INTO schools (code, name, timezone)
     VALUES ('GREENFIELD', 'Greenfield Public School', 'Asia/Kolkata')
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
  );
  const schoolId = school.id;

  await client.query(
    `INSERT INTO campuses (school_id, code, name)
     VALUES ($1, 'MAIN', 'Main Campus')
     ON CONFLICT (school_id, code) DO UPDATE SET name = EXCLUDED.name`,
    [schoolId],
  );

  // 2025-26 is closed so the single-active-year index is satisfied.
  await client.query(
    `INSERT INTO academic_years (school_id, code, name, starts_on, ends_on, status)
     VALUES ($1, '2025-26', 'Academic Year 2025-26', '2025-04-01', '2026-03-31', 'closed')
     ON CONFLICT (school_id, code) DO NOTHING`,
    [schoolId],
  );
  const activeYear = await one<{ id: string; name: string }>(
    client,
    `INSERT INTO academic_years (school_id, code, name, starts_on, ends_on, status)
     VALUES ($1, '2026-27', 'Academic Year 2026-27', '2026-04-01', '2027-03-31', 'active')
     ON CONFLICT (school_id, code) DO UPDATE SET name = EXCLUDED.name
     RETURNING id, name`,
    [schoolId],
  );

  const classSpecs = [
    { code: 'G1', name: 'Grade 1', order: 1 },
    { code: 'G2', name: 'Grade 2', order: 2 },
    { code: 'G3', name: 'Grade 3', order: 3 },
    { code: 'G4', name: 'Grade 4', order: 4 },
    { code: 'G5', name: 'Grade 5', order: 5 },
  ];
  const classIds = new Map<string, string>();
  for (const spec of classSpecs) {
    const row = await one<{ id: string }>(
      client,
      `INSERT INTO classes (school_id, code, name, grade_order)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (school_id, code) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [schoolId, spec.code, spec.name, spec.order],
    );
    classIds.set(spec.code, row.id);
  }

  const sectionIds = new Map<string, string>();
  for (const classCode of ['G1', 'G2', 'G3', 'G4', 'G5']) {
    const classId = classIds.get(classCode);
    if (!classId) throw new Error(`Missing class ${classCode}`);
    for (const sectionCode of ['A', 'B']) {
      const row = await one<{ id: string }>(
        client,
        `INSERT INTO sections (school_id, academic_year_id, class_id, code, name, capacity)
         VALUES ($1, $2, $3, $4, $5, 40)
         ON CONFLICT (academic_year_id, class_id, code)
         DO UPDATE SET capacity = EXCLUDED.capacity
         RETURNING id`,
        [schoolId, activeYear.id, classId, sectionCode, `Section ${sectionCode}`],
      );
      sectionIds.set(`${classCode}-${sectionCode}`, row.id);
    }
  }

  const subjectSpecs = [
    ['ENG', 'English'],
    ['MAT', 'Mathematics'],
    ['SCI', 'Science'],
    ['SST', 'Social Studies'],
    ['HIN', 'Hindi'],
    ['ART', 'Art & Craft'],
  ] as const;
  for (const [code, name] of subjectSpecs) {
    await client.query(
      `INSERT INTO subjects (school_id, code, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (school_id, code) DO UPDATE SET name = EXCLUDED.name`,
      [schoolId, code, name],
    );
  }

  /* --------------------------------- users -------------------------------- */
  const passwordHashes: Record<string, string> = {
    admin: await hashPassword(DEMO_PASSWORD.admin),
    coordinator: await hashPassword(DEMO_PASSWORD.coordinator),
    teacher: await hashPassword(DEMO_PASSWORD.teacher),
    parent: await hashPassword(DEMO_PASSWORD.parent),
    finance: await hashPassword(DEMO_PASSWORD.finance),
    auditor: await hashPassword(DEMO_PASSWORD.auditor),
  };

  let usersCreated = 0;
  const users: Record<string, string> = {};
  async function ensureUser(
    key: keyof typeof passwordHashes,
    email: string,
    displayName: string,
  ): Promise<string> {
    const existing = await client.query<{ id: string }>(
      'SELECT id FROM users WHERE lower(email) = lower($1)',
      [email],
    );
    if (existing.rows[0]) {
      await client.query(
        `UPDATE users SET display_name = $2, password_hash = $3, status = 'active' WHERE id = $1`,
        [existing.rows[0].id, displayName, passwordHashes[key]],
      );
      return existing.rows[0].id;
    }
    const row = await one<{ id: string }>(
      client,
      `INSERT INTO users (email, display_name, password_hash, status)
       VALUES ($1, $2, $3, 'active') RETURNING id`,
      [email, displayName, passwordHashes[key]],
    );
    usersCreated += 1;
    return row.id;
  }

  users.admin = await ensureUser('admin', 'admin@demo.test', 'Anita Deshpande');
  users.coordinator = await ensureUser('coordinator', 'coordinator@demo.test', 'Rahul Menon');
  users.teacher = await ensureUser('teacher', 'teacher@demo.test', 'Sneha Kulkarni');
  users.parent = await ensureUser('parent', 'parent@demo.test', 'Priya Sharma');
  users.finance = await ensureUser('finance', 'finance@demo.test', 'Vikram Rao');
  users.auditor = await ensureUser('auditor', 'auditor@demo.test', 'Farah Khan');

  const grade1A = sectionIds.get('G1-A');
  if (!grade1A) throw new Error('Missing G1-A section');

  const assignments: Array<{
    userId: string;
    role: string;
    scopeType: 'school' | 'section' | 'linked_student';
    scopeId: string | null;
  }> = [
    { userId: users.admin!, role: 'main_admin', scopeType: 'school', scopeId: null },
    { userId: users.coordinator!, role: 'academic_coordinator', scopeType: 'school', scopeId: null },
    { userId: users.teacher!, role: 'teacher', scopeType: 'section', scopeId: grade1A },
    { userId: users.parent!, role: 'parent', scopeType: 'linked_student', scopeId: null },
    { userId: users.finance!, role: 'finance', scopeType: 'school', scopeId: null },
    { userId: users.auditor!, role: 'auditor', scopeType: 'school', scopeId: null },
  ];

  const demoUserIds = Object.values(users);
  await client.query(
    'DELETE FROM user_role_assignments WHERE school_id = $1 AND user_id = ANY($2::uuid[])',
    [schoolId, demoUserIds],
  );
  for (const assignment of assignments) {
    const roleId = roleIds.get(assignment.role);
    if (!roleId) throw new Error(`Missing role ${assignment.role}`);
    await client.query(
      `INSERT INTO user_role_assignments
         (user_id, role_id, school_id, scope_type, scope_id, reason)
       VALUES ($1, $2, $3, $4, $5, 'Demo seed')`,
      [assignment.userId, roleId, schoolId, assignment.scopeType, assignment.scopeId],
    );
  }

  /* -------------------------------- students ------------------------------- */
  const existingStudents = await one<{ count: string }>(
    client,
    'SELECT count(*)::text AS count FROM students WHERE school_id = $1',
    [schoolId],
  );
  let studentsCreated = 0;
  const admittedStudents: Array<{
    id: string;
    name: string;
    admissionNumber: string;
    sectionLabel: string;
  }> = [];

  if (Number(existingStudents.count) === 0) {
    const specs = [
      {
        first: 'Aarav',
        last: 'Sharma',
        dob: '2019-06-14',
        classCode: 'G1',
        section: 'A',
        guardian: { first: 'Priya', last: 'Sharma', email: 'parent@demo.test', phone: '+91 98765 40001', relation: 'Mother', primary: true, status: 'verified', userId: users.parent },
      },
      {
        first: 'Diya',
        last: 'Sharma',
        dob: '2017-02-09',
        classCode: 'G3',
        section: 'B',
        guardian: { first: 'Priya', last: 'Sharma', email: 'parent@demo.test', phone: '+91 98765 40001', relation: 'Mother', primary: true, status: 'verified', userId: users.parent },
      },
      {
        first: 'Kabir',
        last: 'Nair',
        dob: '2019-11-23',
        classCode: 'G1',
        section: 'A',
        guardian: { first: 'Rohan', last: 'Nair', email: 'rohan.nair@example.test', phone: '+91 98765 40002', relation: 'Father', primary: true, status: 'verified', userId: null },
      },
      {
        first: 'Meera',
        last: 'Iyer',
        dob: '2018-08-30',
        classCode: 'G2',
        section: 'A',
        guardian: { first: 'Ananya', last: 'Iyer', email: 'ananya.iyer@example.test', phone: '+91 98765 40003', relation: 'Mother', primary: true, status: 'verified', userId: null },
      },
      {
        first: 'Vivaan',
        last: 'Patel',
        dob: '2016-05-18',
        classCode: 'G4',
        section: 'B',
        guardian: { first: 'Nisha', last: 'Patel', email: 'nisha.patel@example.test', phone: '+91 98765 40004', relation: 'Mother', primary: true, status: 'pending', userId: null },
      },
      {
        first: 'Anaya',
        last: 'Gupta',
        dob: '2015-12-02',
        classCode: 'G5',
        section: 'A',
        guardian: { first: 'Sanjay', last: 'Gupta', email: 'sanjay.gupta@example.test', phone: '+91 98765 40005', relation: 'Father', primary: true, status: 'verified', userId: null },
      },
    ];

    let admissionSequence = 0;
    for (const spec of specs) {
      admissionSequence += 1;
      const admissionNumber = `ADM-2026-${String(admissionSequence).padStart(5, '0')}`;
      const student = await one<{ id: string }>(
        client,
        `INSERT INTO students
           (school_id, admission_number, first_name, last_name, date_of_birth, status)
         VALUES ($1, $2, $3, $4, $5, 'active') RETURNING id`,
        [schoolId, admissionNumber, spec.first, spec.last, spec.dob],
      );

      const sectionId = sectionIds.get(`${spec.classCode}-${spec.section}`);
      const classId = classIds.get(spec.classCode);
      if (!sectionId || !classId) throw new Error(`Missing section ${spec.classCode}-${spec.section}`);

      await client.query(
        `INSERT INTO enrollments
           (school_id, student_id, academic_year_id, class_id, section_id, enrollment_status, starts_on)
         VALUES ($1, $2, $3, $4, $5, 'active', '2026-04-01')`,
        [schoolId, student.id, activeYear.id, classId, sectionId],
      );

      const existingGuardian = await client.query<{ id: string }>(
        `SELECT id FROM guardians WHERE school_id = $1 AND lower(email) = lower($2) LIMIT 1`,
        [schoolId, spec.guardian.email],
      );
      const guardian =
        existingGuardian.rows[0] ??
        (await one<{ id: string }>(
          client,
          `INSERT INTO guardians (school_id, user_id, first_name, last_name, email, phone)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [schoolId, spec.guardian.userId, spec.guardian.first, spec.guardian.last, spec.guardian.email, spec.guardian.phone],
        ));

      await client.query(
        `INSERT INTO student_guardians
           (school_id, student_id, guardian_id, relationship_type, is_primary, portal_access_status)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [schoolId, student.id, guardian.id, spec.guardian.relation, spec.guardian.primary, spec.guardian.status],
      );

      const className = classSpecs.find((entry) => entry.code === spec.classCode)?.name ?? spec.classCode;
      admittedStudents.push({
        id: student.id,
        name: `${spec.first} ${spec.last}`,
        admissionNumber,
        sectionLabel: `${className} · Section ${spec.section}`,
      });
      studentsCreated += 1;
    }

    await client.query(
      `INSERT INTO school_counters (school_id, name, value)
       VALUES ($1, 'admission_number', $2)
       ON CONFLICT (school_id, name) DO UPDATE SET value = EXCLUDED.value`,
      [schoolId, admissionSequence],
    );
  }

  /* --------------------------- demo activity log --------------------------- */  // Only written when the demo students were just created, so re-running the
  // seed never duplicates history (and history itself is append-only).
  if (admittedStudents.length > 0) {
    const hour = 60 * 60 * 1000;
    const base = Date.now() - (admittedStudents.length + 1) * hour;

    await client.query(
      `INSERT INTO activity_events
         (school_id, entity_type, entity_id, event_type, summary, occurred_at)
       VALUES ($1, 'academic_year', $2, 'academic_year.activated', $3, $4)`,
      [schoolId, activeYear.id, `${activeYear.name} set as the active academic year`, new Date(base)],
    );

    for (const [index, student] of admittedStudents.entries()) {
      const occurredAt = new Date(base + (index + 1) * hour);
      await client.query(
        `INSERT INTO activity_events
           (school_id, entity_type, entity_id, event_type, summary, occurred_at)
         VALUES ($1, 'student', $2, 'student.admitted', $3, $4)`,
        [schoolId, student.id, `${student.name} admitted to ${student.sectionLabel}`, occurredAt],
      );
      await client.query(
        `INSERT INTO audit_events
           (school_id, actor_type, action, entity_type, entity_id, outcome, after_state, occurred_at)
         VALUES ($1, 'system', 'student.admitted', 'student', $2, 'success', $3, $4)`,
        [
          schoolId,
          student.id,
          JSON.stringify({
            admissionNumber: student.admissionNumber,
            name: student.name,
            status: 'active',
          }),
          occurredAt,
        ],
      );
    }
  }

  /* ------------------------ operational demo modules ---------------------- */
  // Timetable, fees, exams, staff and notices are seeded idempotently so a
  // re-run refreshes reference rows without duplicating money or marks.
  await seedOperationalData(client, {
    schoolId,
    activeYearId: activeYear.id,
    users,
    classIds,
    sectionIds,
  });

  return { schoolId, studentsCreated, usersCreated };
}

async function one<T extends object>(
  client: pg.PoolClient,
  sql: string,
  params?: unknown[],
): Promise<T> {
  const { rows } = await client.query<T>(sql, params);
  const row = rows[0];
  if (!row) throw new Error('Expected one row but got none');
  return row;
}

/**
 * Synthetic operational data for the demo school: periods and a Grade 1
 * timetable, fee structures and a small payment ledger, a draft term exam with
 * marks, staff with gated salaries and leave, and three notices. Every insert
 * is idempotent so `db:seed` can be re-run safely.
 */
async function seedOperationalData(
  client: pg.PoolClient,
  context: {
    schoolId: string;
    activeYearId: string;
    users: Record<string, string>;
    classIds: Map<string, string>;
    sectionIds: Map<string, string>;
  },
): Promise<void> {
  const { schoolId, activeYearId, users, classIds, sectionIds } = context;
  const admin = users.admin!;
  const coordinator = users.coordinator!;
  const teacher = users.teacher!;
  const finance = users.finance!;

  /* -------------------------------- timetable ------------------------------ */
  const periodSpecs = [
    ['Period 1', 1, '08:00', '08:45', false],
    ['Period 2', 2, '08:45', '09:30', false],
    ['Short break', 3, '09:30', '09:50', true],
    ['Period 3', 4, '09:50', '10:35', false],
    ['Period 4', 5, '10:35', '11:20', false],
    ['Period 5', 6, '11:20', '12:05', false],
  ] as const;
  const periodIds = new Map<number, string>();
  for (const [name, sequence, startsAt, endsAt, isBreak] of periodSpecs) {
    const row = await one<{ id: string }>(
      client,
      `INSERT INTO timetable_periods
         (school_id, academic_year_id, name, sequence_no, starts_at, ends_at, is_break)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (academic_year_id, sequence_no) DO UPDATE
         SET name = EXCLUDED.name,
             starts_at = EXCLUDED.starts_at,
             ends_at = EXCLUDED.ends_at,
             is_break = EXCLUDED.is_break
       RETURNING id`,
      [schoolId, activeYearId, name, sequence, startsAt, endsAt, isBreak],
    );
    periodIds.set(sequence, row.id);
  }

  const roomSpecs = [
    ['ROOM-101', 'Grade 1 classroom', 40],
    ['ROOM-102', 'Grade 2 classroom', 40],
    ['LAB-01', 'Science laboratory', 32],
    ['HALL-01', 'Assembly hall', 200],
  ] as const;
  const roomIds = new Map<string, string>();
  for (const [code, name, capacity] of roomSpecs) {
    const row = await one<{ id: string }>(
      client,
      `INSERT INTO rooms (school_id, code, name, capacity)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (school_id, code) DO UPDATE
         SET name = EXCLUDED.name, capacity = EXCLUDED.capacity
       RETURNING id`,
      [schoolId, code, name, capacity],
    );
    roomIds.set(code, row.id);
  }

  const subjectRows = await client.query<{ id: string; code: string }>(
    'SELECT id, code FROM subjects WHERE school_id = $1',
    [schoolId],
  );
  const subjectIds = new Map(subjectRows.rows.map((row) => [row.code, row.id]));
  const grade1A = sectionIds.get('G1-A');
  if (grade1A) {
    const plan = [
      [1, 1, 'ENG'],
      [1, 2, 'MAT'],
      [1, 4, 'SCI'],
      [1, 5, 'HIN'],
      [2, 1, 'MAT'],
      [2, 2, 'ENG'],
      [2, 4, 'SST'],
      [2, 5, 'ART'],
      [3, 1, 'SCI'],
      [3, 2, 'HIN'],
      [3, 4, 'ENG'],
      [3, 5, 'MAT'],
      [4, 1, 'SST'],
      [4, 2, 'SCI'],
      [4, 4, 'ART'],
      [4, 5, 'ENG'],
      [5, 1, 'HIN'],
      [5, 2, 'MAT'],
      [5, 4, 'ENG'],
      [5, 5, 'SCI'],
    ] as const;
    for (const [day, periodSequence, subjectCode] of plan) {
      const subjectId = subjectIds.get(subjectCode);
      const periodId = periodIds.get(periodSequence);
      if (!subjectId || !periodId) continue;
      await client.query(
        `INSERT INTO timetable_slots
           (school_id, academic_year_id, section_id, period_id, day_of_week,
            subject_id, teacher_user_id, room_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (section_id, day_of_week, period_id) DO UPDATE
           SET subject_id = EXCLUDED.subject_id,
               teacher_user_id = EXCLUDED.teacher_user_id,
               room_id = EXCLUDED.room_id`,
        [
          schoolId,
          activeYearId,
          grade1A,
          periodId,
          day,
          subjectId,
          teacher,
          roomIds.get('ROOM-101') ?? null,
        ],
      );
    }
  }

  /* ---------------------------------- fees --------------------------------- */
  const headSpecs = [
    ['TUITION', 'Tuition fee', 'Annual tuition'],
    ['EXAM', 'Examination fee', 'Term examination charges'],
    ['TRANSPORT', 'Transport fee', 'Optional school bus service'],
  ] as const;
  const headIds = new Map<string, string>();
  for (const [code, name, description] of headSpecs) {
    const row = await one<{ id: string }>(
      client,
      `INSERT INTO fee_heads (school_id, code, name, description)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (school_id, code) DO UPDATE
         SET name = EXCLUDED.name, description = EXCLUDED.description
       RETURNING id`,
      [schoolId, code, name, description],
    );
    headIds.set(code, row.id);
  }

  const amountByClass: Record<string, number> = {
    G1: 45000,
    G2: 48000,
    G3: 52000,
    G4: 56000,
    G5: 60000,
  };
  for (const [classCode, classId] of classIds) {
    const tuition = amountByClass[classCode] ?? 45000;
    const structures: Array<[string, number, string | null]> = [
      ['TUITION', tuition, '2026-04-15'],
      ['EXAM', classCode === 'G5' ? 3500 : 2500, '2026-09-01'],
    ];
    if (classCode === 'G4') structures.push(['TRANSPORT', 10000, '2026-04-15']);
    for (const [headCode, amount, dueOn] of structures) {
      const headId = headIds.get(headCode);
      if (!headId) continue;
      await client.query(
        `INSERT INTO fee_structures
           (school_id, academic_year_id, class_id, fee_head_id, amount, due_on)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (academic_year_id, class_id, fee_head_id) DO UPDATE
           SET amount = EXCLUDED.amount, due_on = EXCLUDED.due_on`,
        [schoolId, activeYearId, classId, headId, amount, dueOn],
      );
    }
  }

  const studentRows = await client.query<{
    id: string;
    class_id: string;
    section_id: string;
    admission_number: string;
  }>(
    `SELECT st.id, e.class_id, e.section_id, st.admission_number
     FROM students st
     JOIN enrollments e ON e.student_id = st.id AND e.enrollment_status = 'active'
     WHERE st.school_id = $1
     ORDER BY st.admission_number`,
    [schoolId],
  );

  for (const student of studentRows.rows) {
    const structures = await client.query<{
      fee_head_id: string;
      fee_head_name: string;
      amount: string;
      due_on: string;
    }>(
      `SELECT fs.fee_head_id, fh.name AS fee_head_name, fs.amount, fs.due_on
       FROM fee_structures fs
       JOIN fee_heads fh ON fh.id = fs.fee_head_id
       WHERE fs.school_id = $1 AND fs.academic_year_id = $2 AND fs.class_id = $3`,
      [schoolId, activeYearId, student.class_id],
    );
    for (const structure of structures.rows) {
      await client.query(
        `INSERT INTO student_charges
           (school_id, student_id, academic_year_id, fee_head_id, description,
            amount, due_on, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (student_id, academic_year_id, fee_head_id) DO NOTHING`,
        [
          schoolId,
          student.id,
          activeYearId,
          structure.fee_head_id,
          structure.fee_head_name,
          structure.amount,
          structure.due_on,
          admin,
        ],
      );
    }
  }

  async function ensurePayment(
    receiptNumber: string,
    studentId: string,
    amount: number,
    method: string,
    paidOn: string,
  ): Promise<string | null> {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO payments
         (school_id, student_id, academic_year_id, receipt_number, amount, method,
          paid_on, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (school_id, receipt_number) DO NOTHING
       RETURNING id`,
      [schoolId, studentId, activeYearId, receiptNumber, amount, method, paidOn, finance],
    );
    const paymentId = inserted.rows[0]?.id;
    if (!paymentId) return null;

    const charges = await client.query<{ id: string; net: string }>(
      `SELECT ch.id, (ch.amount - ch.concession_amount - ch.write_off_amount)::text AS net
       FROM student_charges ch
       WHERE ch.school_id = $1 AND ch.student_id = $2 AND ch.academic_year_id = $3
       ORDER BY ch.due_on, ch.id`,
      [schoolId, studentId, activeYearId],
    );
    let remaining = Math.round(amount * 100) / 100;
    for (const charge of charges.rows) {
      if (remaining <= 0) break;
      const net = Number(charge.net);
      const allocation = Math.min(net, remaining);
      if (allocation <= 0) continue;
      await client.query(
        `INSERT INTO payment_allocations (school_id, payment_id, charge_id, amount)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (payment_id, charge_id) DO NOTHING`,
        [schoolId, paymentId, charge.id, allocation],
      );
      remaining = Math.round((remaining - allocation) * 100) / 100;
    }
    return paymentId;
  }

  const paymentPlan: Array<[string, string, number, string, string]> = [
    ['RCPT-SEED-0001', studentRows.rows[0]?.id ?? '', 20000, 'cash', '2026-05-10'],
    ['RCPT-SEED-0002', studentRows.rows[1]?.id ?? '', 5000, 'upi', '2026-05-18'],
    ['RCPT-SEED-0003', studentRows.rows[2]?.id ?? '', 47500, 'bank_transfer', '2026-06-02'],
    ['RCPT-SEED-0004', studentRows.rows[3]?.id ?? '', 12000, 'card', '2026-06-20'],
    ['RCPT-SEED-0005', studentRows.rows[4]?.id ?? '', 20000, 'cash', '2026-07-04'],
    ['RCPT-SEED-0006', studentRows.rows[5]?.id ?? '', 63500, 'bank_transfer', '2026-07-15'],
  ];
  let firstPaymentId: string | null = null;
  for (const [receipt, studentId, amount, method, paidOn] of paymentPlan) {
    if (!studentId) continue;
    const id = await ensurePayment(receipt, studentId, amount, method, paidOn);
    firstPaymentId ??= id;
  }

  if (firstPaymentId) {
    await client.query(
      `INSERT INTO refunds (school_id, payment_id, amount, reason, requested_by)
       VALUES ($1, $2, 1000, 'Transport fee charged twice for one term', $3)
       ON CONFLICT (payment_id) WHERE status = 'pending' DO NOTHING`,
      [schoolId, firstPaymentId, finance],
    );
  }

  /* --------------------------------- exams --------------------------------- */
  await client.query(
    `UPDATE grading_schemes SET is_default = false
     WHERE school_id = $1 AND code <> 'CBSE10' AND is_default`,
    [schoolId],
  );
  const scheme = await one<{ id: string }>(
    client,
    `INSERT INTO grading_schemes (school_id, code, name, is_default)
     VALUES ($1, 'CBSE10', 'CBSE 8-point scale', true)
     ON CONFLICT (school_id, code) DO UPDATE
       SET name = EXCLUDED.name, is_default = true
     RETURNING id`,
    [schoolId],
  );
  await client.query('DELETE FROM grading_bands WHERE school_id = $1 AND scheme_id = $2', [
    schoolId,
    scheme.id,
  ]);
  const bands = [
    [90, 100, 'A1', 'Outstanding'],
    [80, 89.99, 'A2', 'Excellent'],
    [70, 79.99, 'B1', 'Very good'],
    [60, 69.99, 'B2', 'Good'],
    [50, 59.99, 'C1', 'Above average'],
    [40, 49.99, 'C2', 'Average'],
    [33, 39.99, 'D', 'Needs improvement'],
    [0, 32.99, 'E', 'Essential repeat'],
  ] as const;
  for (const [min, max, grade, remark] of bands) {
    await client.query(
      `INSERT INTO grading_bands (school_id, scheme_id, min_percent, max_percent, grade, remark)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [schoolId, scheme.id, min, max, grade, remark],
    );
  }

  const exam = await one<{ id: string }>(
    client,
    `INSERT INTO exams
       (school_id, academic_year_id, name, exam_type, starts_on, ends_on,
        grading_scheme_id, pass_percent, created_by)
     VALUES ($1, $2, 'Term 1 Examination', 'term', '2026-09-14', '2026-09-25', $3, 35, $4)
     ON CONFLICT (academic_year_id, name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [schoolId, activeYearId, scheme.id, coordinator],
  );

  const examSubjectCodes = ['ENG', 'MAT', 'SCI', 'HIN'];
  const examSubjects: Array<{ id: string; code: string }> = [];
  for (const code of examSubjectCodes) {
    const subjectId = subjectIds.get(code);
    if (!subjectId) continue;
    const row = await one<{ id: string }>(
      client,
      `INSERT INTO exam_subjects (school_id, exam_id, subject_id, max_marks, pass_marks)
       VALUES ($1, $2, $3, 100, 35)
       ON CONFLICT (exam_id, subject_id) DO UPDATE
         SET max_marks = EXCLUDED.max_marks, pass_marks = EXCLUDED.pass_marks
       RETURNING id`,
      [schoolId, exam.id, subjectId],
    );
    examSubjects.push({ id: row.id, code });
  }

  for (const [studentIndex, student] of studentRows.rows.entries()) {
    for (const [subjectIndex, subject] of examSubjects.entries()) {
      const absent = studentIndex === studentRows.rows.length - 1 && subjectIndex === 0;
      const marks = absent ? null : 55 + ((studentIndex * 7 + subjectIndex * 11) % 40);
      await client.query(
        `INSERT INTO exam_marks
           (school_id, exam_subject_id, student_id, marks_obtained, is_absent, entered_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (exam_subject_id, student_id) DO NOTHING`,
        [schoolId, subject.id, student.id, marks, absent, teacher],
      );
    }
  }

  /* --------------------------------- staff --------------------------------- */
  const staffSpecs = [
    ['EMP-0001', admin, 'Anita', 'Deshpande', 'Principal', 'Administration', 95000],
    ['EMP-0002', coordinator, 'Rahul', 'Menon', 'Academic Coordinator', 'Academics', 72000],
    ['EMP-0003', teacher, 'Sneha', 'Kulkarni', 'Grade 1 Teacher', 'Primary', 55000],
    ['EMP-0004', finance, 'Vikram', 'Rao', 'Finance Officer', 'Finance', 62000],
    ['EMP-0005', null, 'Meena', 'Joshi', 'Office Manager', 'Administration', 38000],
  ] as const;
  const staffIds = new Map<string, string>();
  for (const [employeeNumber, userId, first, last, designation, department, salary] of staffSpecs) {
    const row = await one<{ id: string }>(
      client,
      `INSERT INTO staff
         (school_id, user_id, employee_number, first_name, last_name, designation,
          department, joined_on, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '2024-06-01', 'active')
       ON CONFLICT (school_id, employee_number) DO UPDATE
         SET user_id = EXCLUDED.user_id,
             first_name = EXCLUDED.first_name,
             last_name = EXCLUDED.last_name,
             designation = EXCLUDED.designation,
             department = EXCLUDED.department,
             status = 'active'
       RETURNING id`,
      [schoolId, userId, employeeNumber, first, last, designation, department],
    );
    staffIds.set(employeeNumber, row.id);
    await client.query(
      `INSERT INTO staff_salaries
         (school_id, staff_id, amount, currency, effective_from, notes, updated_by)
       VALUES ($1, $2, $3, 'INR', '2026-04-01', 'Annual revision', $4)
       ON CONFLICT (school_id, staff_id) DO UPDATE
         SET amount = EXCLUDED.amount,
             effective_from = EXCLUDED.effective_from,
             notes = EXCLUDED.notes,
             updated_by = EXCLUDED.updated_by,
             updated_at = now()`,
      [schoolId, row.id, salary, admin],
    );
  }
  await client.query(
    `INSERT INTO school_counters (school_id, name, value)
     VALUES ($1, 'employee_number', 5)
     ON CONFLICT (school_id, name) DO UPDATE SET value = GREATEST(school_counters.value, 5)`,
    [schoolId],
  );

  const teacherStaff = staffIds.get('EMP-0003');
  const coordinatorStaff = staffIds.get('EMP-0002');

  /* --------------------------- leave configuration ------------------------- */
  const leaveTypeSpecs = [
    ['casual', 'Casual leave', 12, true],
    ['earned', 'Earned leave', 15, true],
    ['sick', 'Sick leave', 10, true],
    ['maternity', 'Maternity leave', 90, true],
    ['unpaid', 'Unpaid leave', 0, false],
  ] as const;
  for (const [code, name, quota, paid] of leaveTypeSpecs) {
    await client.query(
      `INSERT INTO leave_types (school_id, code, name, annual_quota_days, paid, active)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT (school_id, code) DO UPDATE
         SET name = EXCLUDED.name,
             annual_quota_days = EXCLUDED.annual_quota_days,
             paid = EXCLUDED.paid,
             active = true`,
      [schoolId, code, name, quota, paid],
    );
  }

  const holidaySpecs = [
    ['Diwali break', '2026-11-08'],
    ['Republic Day', '2027-01-26'],
  ] as const;
  for (const [name, holidayOn] of holidaySpecs) {
    await client.query(
      `INSERT INTO holidays (school_id, name, holiday_on, academic_year_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (school_id, holiday_on, name) DO NOTHING`,
      [schoolId, name, holidayOn, activeYearId],
    );
  }

  if (teacherStaff) {
    await client.query(
      `INSERT INTO leave_requests
         (school_id, staff_id, leave_type, starts_on, ends_on, reason, requested_by)
       SELECT $1, $2, 'casual', '2026-11-09', '2026-11-10', 'Family function', $3
       WHERE NOT EXISTS (
         SELECT 1 FROM leave_requests
         WHERE school_id = $1 AND staff_id = $2 AND starts_on = '2026-11-09'
       )`,
      [schoolId, teacherStaff, teacher],
    );
  }
  if (coordinatorStaff) {
    await client.query(
      `INSERT INTO leave_requests
         (school_id, staff_id, leave_type, starts_on, ends_on, reason, status,
          requested_by, reviewed_by, reviewed_at, review_note)
       SELECT $1, $2, 'earned', '2026-10-12', '2026-10-13', 'Conference travel', 'approved',
              $3, $4, now(), 'Approved for the leadership conference'
       WHERE NOT EXISTS (
         SELECT 1 FROM leave_requests
         WHERE school_id = $1 AND staff_id = $2 AND starts_on = '2026-10-12'
       )`,
      [schoolId, coordinatorStaff, coordinator, admin],
    );
  }

  /* -------------------------------- notices -------------------------------- */
  const notices = [
    [
      'Parent-teacher meeting',
      'The Term 1 parent-teacher meeting is on 18 October 2026 from 9:00 am to 12:30 pm. Please book a slot with your child\'s class teacher at the front desk.',
      'parents',
      true,
      '2026-10-18',
    ],
    [
      'Annual sports day',
      'Annual sports day will be held on 21 November 2026. Students should arrive by 7:30 am in their house colours and carry a water bottle.',
      'all',
      false,
      null,
    ],
    [
      'Staff meeting reminder',
      'A short staff meeting will follow assembly on Friday to review term results and the December timetable.',
      'staff',
      false,
      null,
    ],
  ] as const;
  for (const [title, body, audience, pinned, expiresOn] of notices) {
    await client.query(
      `INSERT INTO notices
         (school_id, title, body, audience, status, pinned, published_at, expires_on, created_by)
       SELECT $1, $2::varchar, $3, $4, 'published', $5, now(), $6, $7
       WHERE NOT EXISTS (SELECT 1 FROM notices WHERE school_id = $1 AND title = $2::varchar)`,
      [schoolId, title, body, audience, pinned, expiresOn, admin],
    );
  }

  // A draft so the publishing workflow is visible without faking a send.
  await client.query(
    `INSERT INTO notices (school_id, title, body, audience, status, created_by)
     SELECT $1, 'Winter uniform from November',
            'From 1 November the winter uniform is compulsory. Blazers can be collected from the school store.',
            'all', 'draft', $2
     WHERE NOT EXISTS (
       SELECT 1 FROM notices WHERE school_id = $1 AND title = 'Winter uniform from November'
     )`,
    [schoolId, admin],
  );

  /* ------------------------------ late fee rule ---------------------------- */
  await client.query(
    `INSERT INTO fee_late_fee_rules
       (school_id, name, grace_days, percent_per_month, max_amount, active)
     SELECT $1, 'Standard monthly late fee', 7, 1.50, 500.00, true
     WHERE NOT EXISTS (
       SELECT 1 FROM fee_late_fee_rules
       WHERE school_id = $1 AND name = 'Standard monthly late fee'
     )`,
    [schoolId],
  );

  /* -------------------------------- payroll -------------------------------- */
  const payrollRun = await one<{ id: string }>(
    client,
    `INSERT INTO payroll_runs
       (school_id, period_start, period_end, notes, status, created_by,
        approved_by, approved_at)
     VALUES ($1, '2026-09-01', '2026-09-30',
             'Synthetic September payroll run created by the seed.',
             'approved', $2, $3, now())
     ON CONFLICT (school_id, period_start, period_end) DO UPDATE
       SET notes = EXCLUDED.notes
     RETURNING id`,
    [schoolId, finance, admin],
  );
  await client.query(
    `INSERT INTO payslips
       (school_id, run_id, staff_id, gross_amount, deductions, net_amount, notes)
     SELECT $1, $2, s.id, sal.amount, 0, sal.amount, 'Synthetic payslip'
     FROM staff s
     JOIN staff_salaries sal ON sal.school_id = s.school_id AND sal.staff_id = s.id
     WHERE s.school_id = $1 AND s.status IN ('active', 'on_leave')
     ON CONFLICT (school_id, run_id, staff_id) DO NOTHING`,
    [schoolId, payrollRun.id],
  );

  /* ------------------------------ safeguarding ----------------------------- */
  const firstStudentId = studentRows.rows[0]?.id;
  if (firstStudentId) {
    const safeguarding = await one<{ id: string }>(
      client,
      `INSERT INTO safeguarding_cases
         (school_id, student_id, reference, category, severity, summary, opened_on, opened_by)
       VALUES ($1, $2, 'SG-0001', 'wellbeing', 'medium',
               'Synthetic case: the student asked to speak to the pastoral lead about settling into the new term.',
               '2026-10-05', $3)
       ON CONFLICT (school_id, reference) DO UPDATE SET updated_at = now()
       RETURNING id`,
      [schoolId, firstStudentId, admin],
    );
    await client.query(
      `INSERT INTO safeguarding_notes (school_id, case_id, note, author_id)
       SELECT $1, $2,
              'Pastoral check-in completed; the student is happy and no further action is needed this week.',
              $3
       WHERE NOT EXISTS (
         SELECT 1 FROM safeguarding_notes WHERE school_id = $1 AND case_id = $2
       )`,
      [schoolId, safeguarding.id, admin],
    );
    await client.query(
      `INSERT INTO school_counters (school_id, name, value)
       VALUES ($1, 'safeguarding_case', 1)
       ON CONFLICT (school_id, name) DO UPDATE SET value = GREATEST(school_counters.value, 1)`,
      [schoolId],
    );
  }
}

export { DEMO_PASSWORD };
