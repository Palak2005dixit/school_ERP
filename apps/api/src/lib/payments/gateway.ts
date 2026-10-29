import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export interface PaymentIntentRequest {
  id: string;
  amountMinor: number;
  currency: string;
  idempotencyKey: string;
}
export interface GatewayIntent {
  reference: string;
  checkoutUrl: string;
}
export const paymentEventSchema = z.object({
  eventId: z.string().min(1).max(200),
  intentId: z.string().uuid(),
  reference: z.string().min(1).max(200),
  amountMinor: z.number().int().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  state: z.enum(["captured", "failed"]),
});
export type PaymentEvent = z.infer<typeof paymentEventSchema>;
export interface PaymentGateway {
  readonly name: string;
  createIntent(input: PaymentIntentRequest): Promise<GatewayIntent>;
  verifyWebhook(
    raw: Buffer,
    timestamp: string,
    signature: string,
  ): PaymentEvent;
}
/** Shared contract for an approved bridge; never an emulation of gateway capture. */
export function verifySignedEvent(
  raw: Buffer,
  timestamp: string,
  signature: string,
  secret: string,
  now = Date.now(),
): PaymentEvent {
  const seconds = Number(timestamp);
  if (
    !secret ||
    !Number.isInteger(seconds) ||
    Math.abs(now / 1000 - seconds) > 300 ||
    !/^[a-f0-9]{64}$/i.test(signature)
  )
    throw new Error("Invalid webhook signature");
  const expected = createHmac("sha256", secret)
    .update(timestamp)
    .update(".")
    .update(raw)
    .digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex")))
    throw new Error("Invalid webhook signature");
  return paymentEventSchema.parse(JSON.parse(raw.toString("utf8")));
}
let override: PaymentGateway | null | undefined;
export function setPaymentGatewayForTests(
  value: PaymentGateway | null | undefined,
): void {
  if (process.env.NODE_ENV !== "test")
    throw new Error("Test override is unavailable");
  override = value;
}
export function getPaymentGateway(): PaymentGateway | null {
  if (override !== undefined) return override;
  const url = process.env.PAYMENT_BRIDGE_URL,
    token = process.env.PAYMENT_BRIDGE_TOKEN,
    secret = process.env.PAYMENT_WEBHOOK_SECRET;
  if (!url || !token || !secret) return null;
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    secret.length < 32
  )
    throw new Error("Invalid payment bridge configuration");
  return {
    name: process.env.PAYMENT_BRIDGE_NAME || "approved-bridge",
    verifyWebhook: (raw, time, signature) =>
      verifySignedEvent(raw, time, signature, secret),
    createIntent: async (input) => {
      const response = await fetch(parsed, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": input.idempotencyKey,
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error("Payment bridge request failed");
      return z
        .object({
          reference: z.string().min(1).max(200),
          checkoutUrl: z
            .string()
            .url()
            .refine((value) => new URL(value).protocol === "https:"),
        })
        .parse(await response.json());
    },
  };
}
