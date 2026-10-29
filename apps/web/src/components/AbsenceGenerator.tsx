import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "../lib/api";
import { useSchoolId, useAuth } from "../auth/AuthContext";
import { Alert, Button, Card, Field, Input } from "./ui";
export function AbsenceGenerator() {
  const school = useSchoolId(),
    { can } = useAuth(),
    cache = useQueryClient();
  const [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [days, setDays] = useState<number[]>([]),
    [message, setMessage] = useState("");
  const action = useMutation({
    mutationFn: () =>
      api<{ created: number }>(
        `/api/schools/${school}/staff/attendance/generate-absences`,
        {
          method: "POST",
          body: JSON.stringify({
            from,
            to,
            workingDays: days,
            confirmed: true,
          }),
        },
      ),
    onSuccess: (result) => {
      setMessage(
        `Created ${result.created} missing attendance records as absent.`,
      );
      void cache.invalidateQueries({ queryKey: ["staff-attendance", school] });
    },
  });
  if (!can("hr.attendance.record")) return null;
  return (
    <Card>
      <form
        className="space-y-3 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (
            window.confirm(
              "Mark unrecorded days as absent for every active employee on only the working days selected? Holidays and approved leave are excluded.",
            )
          )
            action.mutate();
        }}
      >
        <h2 className="font-semibold">Generate missing absences</h2>
        <p className="text-sm">
          Completed periods only, maximum 31 days. Select the school's actual
          working days explicitly. Existing attendance is preserved. No payroll
          deductions are created.
        </p>
        <Field label="From">
          <Input
            required
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </Field>
        <Field label="To">
          <Input
            required
            type="date"
            min={from}
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </Field>
        <fieldset>
          <legend>Confirmed working days</legend>
          <div className="flex flex-wrap gap-3">
            {[
              "Sunday",
              "Monday",
              "Tuesday",
              "Wednesday",
              "Thursday",
              "Friday",
              "Saturday",
            ].map((name, index) => (
              <label key={name}>
                <input
                  type="checkbox"
                  checked={days.includes(index)}
                  onChange={(e) =>
                    setDays(
                      e.target.checked
                        ? [...days, index]
                        : days.filter((d) => d !== index),
                    )
                  }
                />{" "}
                {name}
              </label>
            ))}
          </div>
        </fieldset>
        {action.error && <Alert>{errorMessage(action.error)}</Alert>}
        {message && <p role="status">{message}</p>}
        <Button disabled={!days.length || action.isPending}>
          Generate absences after confirmation
        </Button>
      </form>
    </Card>
  );
}
