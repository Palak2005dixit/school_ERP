import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "../lib/api";
import { useAuth, useSchoolId } from "../auth/AuthContext";
import { Alert, Button, Card, Field, Input, Select } from "./ui";
import { listStudents } from "../lib/endpoints";
interface Intent {
  id: string;
  amount_minor: string;
  currency: string;
  status: string;
  provider_reference: string | null;
}
interface Event {
  id: string;
  event_id: string;
  status: string;
  exception_reason: string | null;
}
export function PaymentBoundaryPanel() {
  const school = useSchoolId(),
    { can } = useAuth(),
    cache = useQueryClient(),
    base = `/api/schools/${school}/fees`;
  const [studentId, setStudent] = useState(""),
    [amount, setAmount] = useState(""),
    [currency, setCurrency] = useState("INR"),
    [eventId, setEvent] = useState(""),
    [paymentId, setPayment] = useState(""),
    [message, setMessage] = useState("");
  const status = useQuery({
    queryKey: ["gateway", school],
    queryFn: () =>
      api<{ configured: boolean; message: string }>(`${base}/gateway`),
  });
  const intents = useQuery({
    queryKey: ["intents", school],
    queryFn: () => api<{ items: Intent[] }>(`${base}/payment-intents`),
    enabled: can("fees.reconciliation.manage"),
  });
  const events = useQuery({
    queryKey: ["gateway-events", school],
    queryFn: () => api<{ items: Event[] }>(`${base}/gateway-events`),
    enabled: can("fees.reconciliation.manage"),
  });
  const students = useQuery({
    queryKey: ["gateway-students", school],
    queryFn: () => listStudents(school, {}),
    enabled: can("fees.payment.verify"),
  });
  const action = useMutation({
    mutationFn: ({ path, body }: { path: string; body: object }) =>
      api<{ status: string; checkoutUrl?: string }>(`${base}/${path}`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (result) => {
      setMessage(`Saved with status: ${result.status}.`);
      void cache.invalidateQueries({ queryKey: ["intents", school] });
      void cache.invalidateQueries({ queryKey: ["gateway-events", school] });
    },
  });
  return (
    <Card>
      <div className="space-y-4 p-4">
        <h2 className="font-semibold">
          Payment gateway and verified-event reconciliation
        </h2>
        {status.isPending && <p role="status">Checking configuration…</p>}
        {status.error && <Alert>{errorMessage(status.error)}</Alert>}
        {status.data && (
          <Alert>
            {status.data.configured
              ? "Provider configured; live processing requires provider verification."
              : "BLOCKED: no approved payment provider configured."}{" "}
            {status.data.message}
          </Alert>
        )}
        {action.error && <Alert>{errorMessage(action.error)}</Alert>}
        {message && <p role="status">{message}</p>}
        {can("fees.payment.verify") && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              action.mutate({
                path: "payment-intents",
                body: { studentId, amountMinor: Number(amount), currency },
              });
            }}
          >
            <Field label="Student">
              <Select
                required
                value={studentId}
                onChange={(e) => setStudent(e.target.value)}
              >
                <option value="">Select student</option>
                {students.data?.items.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.firstName} {s.lastName}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Amount in minor units (100 paise = INR 1)">
              <Input
                required
                type="number"
                min="1"
                step="1"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
            <Field label="Currency (existing INR fee ledger)">
              <Input
                required
                minLength={3}
                maxLength={3}
                readOnly
                pattern="[A-Z]{3}"
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              />
            </Field>
            <Button disabled={action.isPending || !status.data?.configured}>
              Create payment intent
            </Button>
          </form>
        )}
        {intents.error && <Alert>{errorMessage(intents.error)}</Alert>}
        {intents.data && (
          <ul>
            {intents.data.items.length ? (
              intents.data.items.map((i) => (
                <li key={i.id}>
                  {i.id}: {i.amount_minor} {i.currency} minor units — {i.status}
                </li>
              ))
            ) : (
              <li>No payment intents.</li>
            )}
          </ul>
        )}
        {can("fees.reconciliation.manage") && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (
                window.confirm(
                  "Link this verified event to the existing receipt?",
                )
              )
                action.mutate({
                  path: `gateway-events/${eventId}/reconcile`,
                  body: { paymentId },
                });
            }}
          >
            <Field label="Verified gateway event">
              <Select
                required
                value={eventId}
                onChange={(e) => setEvent(e.target.value)}
              >
                <option value="">Select event</option>
                {events.data?.items
                  .filter((e) => e.status === "verified")
                  .map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.event_id}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="Existing payment record ID">
              <Input
                required
                value={paymentId}
                onChange={(e) => setPayment(e.target.value)}
              />
            </Field>
            <Button disabled={action.isPending}>
              Reconcile existing receipt
            </Button>
            {events.error && <Alert>{errorMessage(events.error)}</Alert>}
            {events.data?.items
              .filter((e) => e.status === "exception")
              .map((e) => (
                <p key={e.id}>
                  Exception {e.event_id}: {e.exception_reason}
                </p>
              ))}
          </form>
        )}
      </div>
    </Card>
  );
}
