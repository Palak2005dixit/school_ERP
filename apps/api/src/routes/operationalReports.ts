import type { FastifyInstance } from "fastify";
import type { Permission } from "@erp/shared";
import { z } from "zod";
import { uuid } from "@erp/shared";
import { isSchoolScoped } from "@erp/core";
import { getActor, requirePermission, requestMeta } from "../auth/guards";
import { getPool } from "../db";
import { forbidden, parseInput } from "../lib/errors";
import { recordAudit } from "../lib/audit";
const definitions: Record<string, { permission: Permission; sql: string }> = {
  workforce: {
    permission: "hr.attendance.view",
    sql: `SELECT work_date,staff_id,status,late_minutes,early_departure_minutes,overtime_minutes FROM staff_attendance WHERE school_id=$1 AND work_date BETWEEN $2::date AND $3::date ORDER BY work_date,staff_id`,
  },
  recruitment: {
    permission: "hr.recruitment.view",
    sql: `SELECT v.reference,v.title,c.stage,count(*) AS candidate_count FROM candidates c JOIN vacancies v ON v.school_id=c.school_id AND v.id=c.vacancy_id WHERE c.school_id=$1 AND c.applied_on BETWEEN $2::date AND $3::date GROUP BY v.reference,v.title,c.stage ORDER BY v.reference,c.stage`,
  },
  procurement: {
    permission: "procurement.view",
    sql: `SELECT b.code,b.name,b.allocated_amount,COALESCE(sum(e.amount) FILTER(WHERE e.status<>'void'),0) AS utilized FROM procurement_budgets b LEFT JOIN procurement_expenses e ON e.school_id=b.school_id AND e.budget_id=b.id AND e.spent_on BETWEEN $2::date AND $3::date WHERE b.school_id=$1 GROUP BY b.id ORDER BY b.code`,
  },
  transport: {
    permission: "transport.view",
    sql: `SELECT r.code,r.name,v.registration_number,v.capacity,count(a.id) AS allocations FROM transport_routes r LEFT JOIN transport_vehicles v ON v.school_id=r.school_id AND v.id=r.vehicle_id LEFT JOIN student_transport_allocations a ON a.school_id=r.school_id AND a.route_id=r.id AND a.effective_from<=$3::date AND COALESCE(a.effective_to,'infinity'::date)>=$2::date WHERE r.school_id=$1 GROUP BY r.id,v.registration_number,v.capacity ORDER BY r.code`,
  },
  library: {
    permission: "library.view",
    sql: `SELECT b.title,c.accession_number,l.member_id,l.issued_on,l.due_on,l.returned_on,l.status FROM library_loans l JOIN library_copies c ON c.school_id=l.school_id AND c.id=l.copy_id JOIN library_books b ON b.school_id=c.school_id AND b.id=c.book_id WHERE l.school_id=$1 AND l.issued_on BETWEEN $2::date AND $3::date ORDER BY l.issued_on`,
  },
  learning: {
    permission: "learning.view",
    sql: `SELECT h.title,h.section_id,h.status,count(s.id) AS submissions,count(s.id) FILTER(WHERE s.status='reviewed') AS reviewed FROM homework_assignments h LEFT JOIN homework_submissions s ON s.school_id=h.school_id AND s.assignment_id=h.id WHERE h.school_id=$1 AND h.due_at::date BETWEEN $2::date AND $3::date GROUP BY h.id ORDER BY h.due_at`,
  },
  concerns: {
    permission: "concerns.assign",
    sql: `SELECT reference,subject,priority,status,created_at,sla_due_at,resolved_at,extract(epoch FROM (COALESCE(resolved_at,now())-created_at))/3600 AS age_hours FROM concerns WHERE school_id=$1 AND created_at::date BETWEEN $2::date AND $3::date ORDER BY created_at`,
  },
};
function cell(value: unknown): string {
  let valueText =
    value == null
      ? ""
      : value instanceof Date
        ? value.toISOString()
        : String(value);
  if (/^[=+\-@\t\r]/.test(valueText)) valueText = "'" + valueText;
  return '"' + valueText.replaceAll('"', '""') + '"';
}
export async function registerOperationalReports(
  app: FastifyInstance,
): Promise<void> {
  app.get(
    "/api/schools/:schoolId/operations/:module/export",
    { preHandler: requirePermission("reports.export") },
    async (request, reply) => {
      const { schoolId, module } = parseInput(
        z.object({
          schoolId: uuid,
          module: z.enum([
            "workforce",
            "recruitment",
            "procurement",
            "transport",
            "library",
            "learning",
            "concerns",
          ]),
        }),
        request.params,
      );
      const { from, to } = parseInput(
        z.object({ from: z.string().date(), to: z.string().date() }),
        request.query,
      );
      const actor = getActor(request),
        definition = definitions[module]!;
      if (
        !actor.permissions.has(definition.permission) ||
        !isSchoolScoped(actor) ||
        !actor.permissionAssignments
          .get(definition.permission)
          ?.some((a) => a.scopeType === "school")
      )
        throw forbidden(
          "This export requires school-wide access and the module view permission",
        );
      if (from > to)
        throw forbidden("Choose an end date on or after the start date");
      const result = await getPool().query(definition.sql + " LIMIT 5000", [
        schoolId,
        from,
        to,
      ]);
      const columns = result.fields.map((f) => f.name);
      const csv =
        "\uFEFF" +
        [
          columns.map(cell).join(","),
          ...result.rows.map((row) =>
            columns.map((c) => cell(row[c])).join(","),
          ),
        ].join("\r\n");
      await recordAudit(getPool(), {
        schoolId,
        actorUserId: actor.userId,
        action: "reports.operational_export",
        entityType: module,
        outcome: "success",
        after: { from, to, rows: result.rowCount, limit: 5000 },
        ...requestMeta(request),
      });
      return reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Cache-Control", "private, no-store")
        .header(
          "Content-Disposition",
          `attachment; filename="${module}-${from}-${to}.csv"`,
        )
        .send(csv);
    },
  );
}
