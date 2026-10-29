import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { uuid } from "@erp/shared";
import { getActor, requirePermission, requestMeta } from "../auth/guards";
import { getPool, withTransaction } from "../db";
import { recordAudit } from "../lib/audit";
import { conflict, notFound, parseInput } from "../lib/errors";
const params = z.object({ schoolId: uuid, id: uuid });
export async function registerStudentAccounts(
  app: FastifyInstance,
): Promise<void> {
  app.get(
    "/api/schools/:schoolId/students/:id/login-account",
    { preHandler: requirePermission("access.roles.manage") },
    async (request) => {
      const { schoolId, id } = parseInput(params, request.params);
      const row = (
        await getPool().query(
          "SELECT user_id FROM students WHERE school_id=$1 AND id=$2",
          [schoolId, id],
        )
      ).rows[0];
      if (!row) throw notFound("Student not found");
      return { userId: row.user_id };
    },
  );
  app.post(
    "/api/schools/:schoolId/students/:id/login-account",
    { preHandler: requirePermission("access.roles.manage") },
    async (request) => {
      const { schoolId, id } = parseInput(params, request.params);
      const { userId } = parseInput(
        z.object({ userId: uuid.nullable() }),
        request.body,
      );
      const actor = getActor(request);
      return withTransaction(async (client) => {
        const row = (
          await client.query(
            "SELECT user_id FROM students WHERE school_id=$1 AND id=$2 FOR UPDATE",
            [schoolId, id],
          )
        ).rows[0];
        if (!row) throw notFound("Student not found");
        if (userId) {
          if (
            !(
              await client.query(
                "SELECT id FROM users WHERE id=$1 AND status='active' FOR UPDATE",
                [userId],
              )
            ).rowCount
          )
            throw notFound("Active account not found");
          const incompatible = await client.query(
            `SELECT 1 FROM user_role_assignments a JOIN roles r ON r.id=a.role_id WHERE a.school_id=$1 AND a.user_id=$2 AND a.revoked_at IS NULL AND r.code<>'student' LIMIT 1`,
            [schoolId, userId],
          );
          if (incompatible.rowCount)
            throw conflict(
              "Use a dedicated student account without staff or guardian roles in this school",
            );
        }
        if (row.user_id && row.user_id !== userId) {
          await client.query(
            `UPDATE user_role_assignments SET revoked_at=now() WHERE school_id=$1 AND user_id=$2 AND role_id IN(SELECT id FROM roles WHERE code='student') AND revoked_at IS NULL`,
            [schoolId, row.user_id],
          );
          await client.query("DELETE FROM sessions WHERE user_id=$1", [
            row.user_id,
          ]);
        }
        await client.query(
          "UPDATE students SET user_id=$3 WHERE school_id=$1 AND id=$2",
          [schoolId, id, userId],
        );
        if (userId)
          await client.query(
            `INSERT INTO user_role_assignments(school_id,user_id,role_id,scope_type) SELECT $1,$2,id,'self' FROM roles WHERE code='student' AND NOT EXISTS(SELECT 1 FROM user_role_assignments a WHERE a.school_id=$1 AND a.user_id=$2 AND a.role_id=roles.id AND a.revoked_at IS NULL)`,
            [schoolId, userId],
          );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: "access.student_account_linked",
          entityType: "student",
          entityId: id,
          outcome: "success",
          after: { userId },
          ...requestMeta(request),
        });
        return { userId };
      });
    },
  );
  app.get(
    "/api/schools/:schoolId/learning/learners",
    { preHandler: requirePermission("learning.view") },
    async (request) => {
      const { schoolId } = parseInput(
        z.object({ schoolId: uuid }),
        request.params,
      );
      const actor = getActor(request);
      const { rows } = await getPool().query(
        `SELECT DISTINCT st.id AS "studentId",concat_ws(' ',st.first_name,st.middle_name,st.last_name) AS "fullName",c.name AS "className",sec.name AS "sectionName"
   FROM students st LEFT JOIN enrollments e ON e.school_id=st.school_id AND e.student_id=st.id AND e.enrollment_status='active'
   LEFT JOIN classes c ON c.school_id=e.school_id AND c.id=e.class_id LEFT JOIN sections sec ON sec.school_id=e.school_id AND sec.id=e.section_id
   WHERE st.school_id=$1 AND st.status='active' AND (st.user_id=$2 OR EXISTS(SELECT 1 FROM student_guardians sg JOIN guardians g ON g.school_id=sg.school_id AND g.id=sg.guardian_id WHERE sg.school_id=st.school_id AND sg.student_id=st.id AND g.user_id=$2 AND sg.portal_access_status='verified' AND sg.valid_to IS NULL))`,
        [schoolId, actor.userId],
      );
      return { items: rows };
    },
  );
}
