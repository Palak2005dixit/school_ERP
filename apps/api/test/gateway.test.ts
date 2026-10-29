import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { verifySignedEvent } from "../src/lib/payments/gateway";
import { validateBackup } from "../../../packages/db/src/backup";
import { canAccessSection, visibleSectionIds } from "@erp/core";
const secret = "a".repeat(32),
  now = Date.now(),
  timestamp = String(Math.floor(now / 1000));
const raw = Buffer.from(
  JSON.stringify({
    eventId: "capture-1",
    intentId: "f5a716fc-6cf3-4d3b-9f3c-31704843d27d",
    reference: "provider-1",
    amountMinor: 100,
    currency: "INR",
    state: "captured",
  }),
);
const signature = createHmac("sha256", secret)
  .update(timestamp)
  .update(".")
  .update(raw)
  .digest("hex");
describe("payment signature contract", () => {
  it("accepts exactly signed, fresh event bytes", () =>
    expect(
      verifySignedEvent(raw, timestamp, signature, secret, now).eventId,
    ).toBe("capture-1"));
  it("rejects changed bytes", () =>
    expect(() =>
      verifySignedEvent(
        Buffer.concat([raw, Buffer.from(" ")]),
        timestamp,
        signature,
        secret,
        now,
      ),
    ).toThrow());
  it("rejects stale timestamps", () =>
    expect(() =>
      verifySignedEvent(raw, timestamp, signature, secret, now + 301000),
    ).toThrow());
  it("rejects absent credentials and malformed signatures", () => {
    expect(() =>
      verifySignedEvent(raw, timestamp, signature, "", now),
    ).toThrow();
    expect(() =>
      verifySignedEvent(raw, timestamp, "bad", secret, now),
    ).toThrow();
  });
});
describe("backup preflight", () => {
  const known = new Set(["students"]);
  const payload = {
    format: "school-erp-json-backup",
    version: 1,
    createdAt: new Date().toISOString(),
    database: "test",
    tables: [{ name: "students", rows: [] }],
  };
  it("accepts a complete legacy backup", () =>
    expect(() => validateBackup(payload, known)).not.toThrow());
  it("rejects missing and duplicate tables", () => {
    expect(() => validateBackup({ ...payload, tables: [] }, known)).toThrow();
    expect(() =>
      validateBackup(
        { ...payload, tables: [...payload.tables, ...payload.tables] },
        known,
      ),
    ).toThrow();
  });
  it("requires integrity for v2", () =>
    expect(() => validateBackup({ ...payload, version: 2 }, known)).toThrow());
});
describe("scope fail-closed behavior", () => {
  const actor = {
    userId: "u",
    schoolId: "s",
    permissions: new Set<string>(),
    assignments: [{ scopeType: "campus" as const, scopeId: "c" }],
  };
  it("does not convert unsupported campus or custom mappings to school access", () => {
    expect(canAccessSection(actor, "section")).toBe(false);
    expect(visibleSectionIds(actor)).toEqual([]);
  });
  it("preserves explicit school-wide access when mixed with section scopes", () =>
    expect(
      visibleSectionIds({
        ...actor,
        assignments: [
          { scopeType: "school", scopeId: null },
          { scopeType: "section", scopeId: "section" },
        ],
      }),
    ).toBeNull());
});
