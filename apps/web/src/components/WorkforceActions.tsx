import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "../lib/api";
import { useAuth, useSchoolId } from "../auth/AuthContext";
import { listStaff, listStaffShifts } from "../lib/endpoints";
import { Alert, Button, Card, Field, Input, Select } from "./ui";
export function WorkforceActions() {
  const school = useSchoolId();
  const { can } = useAuth();
  const cache = useQueryClient();
  const [staffId, setStaff] = useState(""),
    [shiftId, setShift] = useState(""),
    [from, setFrom] = useState(""),
    [to, setTo] = useState("");
  const [message, setMessage] = useState("");
  const staff = useQuery({
    queryKey: ["workforce-picker", school],
    queryFn: () => listStaff(school),
  });
  const shifts = useQuery({
    queryKey: ["workforce-shifts", school],
    queryFn: () => listStaffShifts(school),
  });
  const assignments = useQuery({
    queryKey: ["shift-assignments", school],
    queryFn: () =>
      api<{
        items: Array<{
          id: string;
          staff_name: string;
          shift_name: string;
          effective_from: string;
          effective_to: string | null;
        }>;
      }>(`/api/schools/${school}/staff/shift-assignments`),
  });
  const action = useMutation({
    mutationFn: ({ path, body }: { path: string; body: object }) =>
      api(`/api/schools/${school}/staff/${path}`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ["shift-assignments", school] });
      setMessage("Saved successfully.");
      void cache.invalidateQueries({ queryKey: ["staff-attendance", school] });
    },
  });
  return (
    <Card>
      <div className="space-y-3 p-4">
        <h2 className="font-semibold">Shift assignment and live punches</h2>
        {message && <p role="status">{message}</p>}
        {action.error && <Alert>{errorMessage(action.error)}</Alert>}
        {staff.error && <Alert>{errorMessage(staff.error)}</Alert>}
        <Field label="Staff member">
          <Select value={staffId} onChange={(e) => setStaff(e.target.value)}>
            <option value="">Select staff</option>
            {staff.data?.items.map((s) => (
              <option key={s.id} value={s.id}>
                {s.fullName}
              </option>
            ))}
          </Select>
        </Field>
        {can("hr.attendance.record") && (
          <div className="flex gap-2">
            {(["in", "out"] as const).map((direction) => (
              <Button
                key={direction}
                disabled={!staffId || action.isPending}
                onClick={() => {
                  setMessage("");
                  action.mutate({
                    path: "attendance/punch",
                    body: { staffId, direction },
                  });
                }}
              >
                Punch {direction}
              </Button>
            ))}
          </div>
        )}
        {can("hr.attendance.configure") && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              setMessage("");
              action.mutate({
                path: "shift-assignments",
                body: {
                  staffId,
                  shiftId,
                  effectiveFrom: from,
                  effectiveTo: to || null,
                },
              });
            }}
          >
            <Field label="Shift">
              <Select
                required
                value={shiftId}
                onChange={(e) => setShift(e.target.value)}
              >
                <option value="">Select shift</option>
                {shifts.data?.items.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Effective from">
              <Input
                required
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </Field>
            <Field label="Effective to (optional)">
              <Input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </Field>
            <Button disabled={!staffId || action.isPending} type="submit">
              Assign shift
            </Button>
          </form>
        )}
        {can("hr.attendance.configure") &&
          assignments.data?.items.map((a) => (
            <div key={a.id} className="flex gap-3">
              <span>
                {a.staff_name}: {a.shift_name}, {a.effective_from} to{" "}
                {a.effective_to ?? "open"}
              </span>
              <Button
                disabled={!to || action.isPending}
                onClick={() => {
                  if (
                    window.confirm(
                      "End this shift assignment on the selected Effective to date?",
                    )
                  )
                    action.mutate({
                      path: `shift-assignments/${a.id}/end`,
                      body: { effectiveTo: to },
                    });
                }}
              >
                End on selected date
              </Button>
            </div>
          ))}
        {assignments.error && <Alert>{errorMessage(assignments.error)}</Alert>}
      </div>
    </Card>
  );
}
