import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { uuid } from "@erp/shared";
import { getActor, requirePermission, requestMeta } from "../auth/guards";
import { getPool, withTransaction } from "../db";
import { recordAudit } from "../lib/audit";
import {
  badRequest,
  conflict,
  notFound,
  parseInput,
  unauthorized,
} from "../lib/errors";
import { getPaymentGateway, type PaymentEvent } from "../lib/payments/gateway";
import { idempotentRoute } from "../lib/idempotency";
import { tenantContext } from "../lib/tenantContext";
const schoolParams = z.object({ schoolId: uuid });
export async function registerPaymentGatewayRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get(
    "/api/schools/:schoolId/fees/gateway",
    { preHandler: requirePermission("fees.view") },
    async () => {
      const gateway = getPaymentGateway();
      return {
        configured: !!gateway,
        provider: gateway?.name ?? null,
        status: gateway ? "configured-unverified" : "BLOCKED",
        message:
          "A verified capture must be reconciled to an existing ERP receipt; no raw card data is accepted.",
      };
    },
  );
  app.get(
    "/api/schools/:schoolId/fees/payment-intents",
    { preHandler: requirePermission("fees.reconciliation.manage") },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      return {
        items: (
          await getPool().query(
            "SELECT id,student_id,amount_minor,currency,status,provider_reference,created_at FROM payment_intents WHERE school_id=$1 ORDER BY created_at DESC LIMIT 100",
            [schoolId],
          )
        ).rows,
      };
    },
  );
  app.post(
    "/api/schools/:schoolId/fees/payment-intents",
    { preHandler: requirePermission("fees.payment.verify") },
    idempotentRoute("POST /fees/payment-intents", async (request, reply) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      const input = parseInput(
        z.object({
          studentId: uuid,
          amountMinor: z.number().int().positive().max(9999999999),
          currency: z.literal("INR"),
        }),
        request.body,
      );
      const actor = getActor(request),
        gateway = getPaymentGateway();
      const id = await withTransaction(async (client) => {
        if (
          !(
            await client.query(
              "SELECT 1 FROM students WHERE school_id=$1 AND id=$2",
              [schoolId, input.studentId],
            )
          ).rowCount
        )
          throw notFound("Student not found");
        const row = (
          await client.query(
            `INSERT INTO payment_intents(school_id,student_id,amount_minor,currency,provider,status,requested_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
            [
              schoolId,
              input.studentId,
              input.amountMinor,
              input.currency,
              gateway?.name ?? null,
              gateway ? "creating" : "blocked",
              actor.userId,
            ],
          )
        ).rows[0];
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: "fees.intent_requested",
          entityType: "payment_intent",
          entityId: row.id,
          outcome: "success",
          ...requestMeta(request),
        });
        return row.id as string;
      });
      if (!gateway)
        return reply.status(201).send({
          id,
          status: "blocked",
          message:
            "No approved payment bridge is configured. No payment was processed.",
        });
      try {
        const result = await gateway.createIntent({
          id,
          amountMinor: input.amountMinor,
          currency: input.currency,
          idempotencyKey: id,
        });
        await getPool().query(
          "UPDATE payment_intents SET status='pending',provider_reference=$3,checkout_url=$4 WHERE school_id=$1 AND id=$2",
          [schoolId, id, result.reference, result.checkoutUrl],
        );
        return reply
          .status(201)
          .send({ id, status: "pending", checkoutUrl: result.checkoutUrl });
      } catch {
        await getPool().query(
          "UPDATE payment_intents SET status='exception' WHERE school_id=$1 AND id=$2",
          [schoolId, id],
        );
        throw conflict(
          "Gateway outcome is uncertain; reconcile this intent before retrying",
        );
      }
    }),
  );
  app.get(
    "/api/schools/:schoolId/fees/gateway-events",
    { preHandler: requirePermission("fees.reconciliation.manage") },
    async (request) => {
      const { schoolId } = parseInput(schoolParams, request.params);
      return {
        items: (
          await getPool().query(
            "SELECT * FROM payment_gateway_events WHERE school_id=$1 ORDER BY received_at DESC LIMIT 100",
            [schoolId],
          )
        ).rows,
      };
    },
  );
  app.post(
    "/api/schools/:schoolId/fees/gateway-events/:id/reconcile",
    { preHandler: requirePermission("fees.reconciliation.manage") },
    async (request) => {
      const { schoolId, id } = parseInput(
        z.object({ schoolId: uuid, id: uuid }),
        request.params,
      );
      const { paymentId } = parseInput(
        z.object({ paymentId: uuid }),
        request.body,
      );
      const actor = getActor(request);
      return withTransaction(async (client) => {
        const row = (
          await client.query(
            "SELECT * FROM payment_gateway_events WHERE school_id=$1 AND id=$2 FOR UPDATE",
            [schoolId, id],
          )
        ).rows[0];
        if (!row) throw notFound("Gateway event not found");
        if (row.status !== "verified" || row.event_state !== "captured")
          throw conflict("Only verified captured events can be reconciled");
        const payment = (
          await client.query(
            `SELECT p.amount,p.student_id,p.status,i.student_id AS expected_student,i.currency FROM payments p JOIN payment_intents i ON i.school_id=p.school_id AND i.id=$3 WHERE p.school_id=$1 AND p.id=$2`,
            [schoolId, paymentId, row.intent_id],
          )
        ).rows[0];
        if (
          !payment ||
          payment.status !== "recorded" ||
          payment.currency !== "INR" ||
          payment.student_id !== payment.expected_student ||
          Math.round(Number(payment.amount) * 100) !== Number(row.amount_minor)
        )
          throw badRequest("Receipt student or amount does not match");
        await client.query(
          "UPDATE payment_gateway_events SET status='reconciled',payment_id=$3 WHERE school_id=$1 AND id=$2",
          [schoolId, id, paymentId],
        );
        await recordAudit(client, {
          schoolId,
          actorUserId: actor.userId,
          action: "fees.gateway_reconciled",
          entityType: "payment_gateway_event",
          entityId: id,
          outcome: "success",
          after: { paymentId },
          ...requestMeta(request),
        });
        return { id, status: "reconciled" };
      });
    },
  );
  // Exact signed bytes are required. The approved bridge posts octet-stream JSON;
  // JSON middleware must never re-serialize the body before verification.
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );
  app.post(
    "/api/integrations/payments/webhook",
    {
      bodyLimit: 65536,
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const gateway = getPaymentGateway();
      if (!gateway) return reply.status(503).send({ status: "blocked" });
      if (!Buffer.isBuffer(request.body))
        throw badRequest("Send signed octet-stream JSON");
      let event: PaymentEvent;
      try {
        event = gateway.verifyWebhook(
          request.body,
          String(request.headers["x-payment-timestamp"] ?? ""),
          String(request.headers["x-payment-signature"] ?? ""),
        );
      } catch {
        throw unauthorized("Webhook signature is invalid");
      }
      const rawHash = createHash("sha256").update(request.body).digest("hex");
      // This single global lookup reveals no response data. Only an authenticated
      // provider event can select the tenant of its already-created intent.
      const intent = (
        await getPool().query(
          "SELECT school_id FROM payment_intents WHERE id=$1 AND provider=$2",
          [event.intentId, gateway.name],
        )
      ).rows[0];
      if (!intent) throw notFound("Intent not found");
      return tenantContext.run({ schoolId: intent.school_id }, () =>
        withTransaction(async (client) => {
          const row = (
            await client.query(
              "SELECT * FROM payment_intents WHERE school_id=$1 AND id=$2 FOR UPDATE",
              [intent.school_id, event.intentId],
            )
          ).rows[0];
          const prior = (
            await client.query(
              "SELECT payload_hash FROM payment_gateway_events WHERE provider=$1 AND event_id=$2",
              [gateway.name, event.eventId],
            )
          ).rows[0];
          if (prior) {
            if (prior.payload_hash !== rawHash)
              throw conflict("Event identity was reused with different bytes");
            return { status: "duplicate" };
          }
          const mismatch =
            Number(row.amount_minor) !== event.amountMinor ||
            row.currency !== event.currency ||
            row.provider_reference !== event.reference;
          await client.query(
            `INSERT INTO payment_gateway_events(school_id,intent_id,provider,event_id,payload_hash,amount_minor,currency,event_state,status,exception_reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              intent.school_id,
              event.intentId,
              gateway.name,
              event.eventId,
              rawHash,
              event.amountMinor,
              event.currency,
              event.state,
              mismatch ? "exception" : "verified",
              mismatch ? "Intent reference, amount or currency mismatch" : null,
            ],
          );
          await client.query(
            "UPDATE payment_intents SET status=$3 WHERE school_id=$1 AND id=$2",
            [
              intent.school_id,
              event.intentId,
              mismatch
                ? "exception"
                : event.state === "captured"
                  ? "verified"
                  : "failed",
            ],
          );
          await recordAudit(client, {
            schoolId: intent.school_id,
            actorType: "integration",
            action: "fees.gateway_event_verified",
            entityType: "payment_intent",
            entityId: event.intentId,
            outcome: "success",
            after: { eventId: event.eventId, mismatch },
          });
          return { status: mismatch ? "exception" : "verified" };
        }),
      );
    },
  );
}
