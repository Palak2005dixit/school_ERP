import type pg from 'pg';
import { notFound } from './errors';

type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

/**
 * Confirms the signed-in user is a verified guardian of the student. Guardian
 * portal routes use the student id in the path, so this check is the only thing
 * standing between one family's records and another's. A non-match returns 404
 * rather than 403 so the API does not reveal that the student exists.
 */
export async function assertGuardianLinked(
  client: Queryable,
  schoolId: string,
  userId: string,
  studentId: string,
): Promise<void> {
  const { rowCount } = await client.query(
    `SELECT 1
     FROM student_guardians sg
     JOIN guardians g ON g.id = sg.guardian_id AND g.school_id = sg.school_id
     WHERE sg.school_id = $1 AND sg.student_id = $2 AND g.user_id = $3
       AND sg.portal_access_status = 'verified'
       AND sg.valid_to IS NULL`,
    [schoolId, studentId, userId],
  );
  if (rowCount === 0) throw notFound('Student not found');
}
