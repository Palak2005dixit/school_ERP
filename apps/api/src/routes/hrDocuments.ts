import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { uuid } from "@erp/shared";
import { isSchoolScoped } from "@erp/core";
import { getActor, requireAnyPermission, requestMeta } from "../auth/guards";
import { getPool, withTransaction } from "../db";
import { badRequest, forbidden, notFound, parseInput } from "../lib/errors";
import { recordAudit } from "../lib/audit";
const permission = requireAnyPermission(
  "hr.employee.manage",
  "hr.recruitment.manage",
);
function ensure(actor: ReturnType<typeof getActor>, candidate: boolean) {
  if (
    !isSchoolScoped(actor) ||
    !actor.permissions.has(
      candidate ? "hr.recruitment.manage" : "hr.employee.manage",
    )
  )
    throw forbidden();
}
export async function registerHrDocuments(app: FastifyInstance): Promise<void> {
  app.get(
    "/api/schools/:schoolId/hr/documents",
    { preHandler: permission },
    async (request) => {
      const { schoolId } = parseInput(
        z.object({ schoolId: uuid }),
        request.params,
      );
      const input = parseInput(
        z
          .object({ candidateId: uuid.optional(), staffId: uuid.optional() })
          .refine(
            (v) => !!v.candidateId !== !!v.staffId,
            "Choose one candidate or employee",
          ),
        request.query,
      );
      ensure(getActor(request), !!input.candidateId);
      const rows = await getPool().query(
        `SELECT id,filename,document_type,status,byte_size,created_at FROM hr_documents WHERE school_id=$1 AND ${input.candidateId ? "candidate_id" : "staff_id"}=$2 ORDER BY created_at DESC`,
        [schoolId, input.candidateId ?? input.staffId],
      );
      return { items: rows.rows };
    },
  );
  app.post(
    "/api/schools/:schoolId/hr/documents",
    { preHandler: permission, bodyLimit: 2 * 1024 * 1024 },
    async (request, reply) => {
      const { schoolId } = parseInput(
        z.object({ schoolId: uuid }),
        request.params,
      );
      const input = parseInput(
        z
          .object({
            candidateId: uuid.optional(),
            staffId: uuid.optional(),
            filename: z.string().trim().min(1).max(255),
            contentType: z.enum([
              "application/pdf",
              "image/png",
              "image/jpeg",
              "text/plain",
            ]),
            documentType: z.string().trim().min(1).max(80),
            dataBase64: z.string().min(1).max(1500000),
          })
          .refine(
            (v) => !!v.candidateId !== !!v.staffId,
            "Choose one candidate or employee",
          ),
        request.body,
      );
      const actor = getActor(request);
      ensure(actor, !!input.candidateId);
      if (
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          input.dataBase64,
        )
      )
        throw badRequest("Invalid file encoding");
      const data = Buffer.from(input.dataBase64, "base64");
      if (!data.length || data.length > 1048576)
        throw badRequest("Files must be between 1 byte and 1 MiB");
      const saved = await withTransaction(async (client) => {
        const row = (
          await client.query(
            `INSERT INTO hr_documents(school_id,candidate_id,staff_id,filename,content_type,document_type,byte_size,data,uploaded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
            [
              schoolId,
              input.candidateId ?? null,
              input.staffId ?? null,
              input.filename,
              input.contentType,
              input.documentType,
              data.length,
              data,
              actor.userId,
            ],
          )
        ).rows[0];
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: "hr.document_uploaded",
          entityType: "hr_document",
          entityId: row.id,
          outcome: "success",
          after: { documentType: input.documentType, byteSize: data.length },
          ...requestMeta(request),
        });
        return row;
      });
      return reply.status(201).send(saved);
    },
  );
  app.get(
    "/api/schools/:schoolId/hr/documents/:id/download",
    { preHandler: permission },
    async (request, reply) => {
      const { schoolId, id } = parseInput(
        z.object({ schoolId: uuid, id: uuid }),
        request.params,
      );
      const row = (
        await getPool().query(
          "SELECT * FROM hr_documents WHERE school_id=$1 AND id=$2",
          [schoolId, id],
        )
      ).rows[0];
      if (!row) throw notFound("Document not found");
      const actor = getActor(request);
      ensure(actor, !!row.candidate_id);
      await recordAudit(getPool(), {
        schoolId,
        actorUserId: actor.userId,
        action: "hr.document_downloaded",
        entityType: "hr_document",
        entityId: id,
        outcome: "success",
        ...requestMeta(request),
      });
      return reply
        .header("Cache-Control", "private, no-store")
        .header("Content-Type", row.content_type)
        .header(
          "Content-Disposition",
          `attachment; filename="${row.filename.replace(/["\\\r\n]/g, "_")}"`,
        )
        .send(row.data);
    },
  );
  app.patch(
    "/api/schools/:schoolId/hr/documents/:id",
    { preHandler: permission },
    async (request) => {
      const { schoolId, id } = parseInput(
        z.object({ schoolId: uuid, id: uuid }),
        request.params,
      );
      const { status } = parseInput(
        z.object({ status: z.enum(["verified", "rejected"]) }),
        request.body,
      );
      const actor = getActor(request);
      return withTransaction(async (client) => {
        const row = (
          await client.query(
            "SELECT candidate_id FROM hr_documents WHERE school_id=$1 AND id=$2 FOR UPDATE",
            [schoolId, id],
          )
        ).rows[0];
        if (!row) throw notFound("Document not found");
        ensure(actor, !!row.candidate_id);
        await client.query(
          "UPDATE hr_documents SET status=$3,reviewed_by=$4,reviewed_at=now() WHERE school_id=$1 AND id=$2",
          [schoolId, id, status, actor.userId],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: "hr.document_reviewed",
          entityType: "hr_document",
          entityId: id,
          outcome: "success",
          after: { status },
          ...requestMeta(request),
        });
        return { id, status };
      });
    },
  );
}
