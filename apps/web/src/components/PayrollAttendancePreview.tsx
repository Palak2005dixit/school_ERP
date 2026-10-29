import { useQuery } from "@tanstack/react-query";
import { api, errorMessage } from "../lib/api";
import { useSchoolId, useAuth } from "../auth/AuthContext";
import { Alert, Card } from "./ui";
export function PayrollAttendancePreview({
  from,
  to,
}: {
  from: string;
  to: string;
}) {
  const school = useSchoolId(),
    { can } = useAuth();
  const enabled = can("hr.payroll.manage") && !!from && !!to;
  const data = useQuery({
    queryKey: ["payroll-attendance-preview", school, from, to],
    queryFn: () =>
      api<{
        notice: string;
        items: Array<{
          staff_id: string;
          staff_name: string;
          days_marked: string;
          raw_punch_minutes: string;
          missing_punch_days: string;
          approved_leave_calendar_days: string;
        }>;
      }>(
        `/api/schools/${school}/staff/attendance/payroll-preview?from=${from}&to=${to}`,
      ),
    enabled,
  });
  if (!enabled) return null;
  return (
    <Card>
      <div className="space-y-3 p-4">
        <h2 className="font-semibold">Attendance source review for payroll</h2>
        {data.isPending && <p role="status">Loading payroll source data…</p>}
        {data.error && <Alert>{errorMessage(data.error)}</Alert>}
        {data.data && (
          <>
            <p className="text-sm">{data.data.notice}</p>
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr>
                    <th>Staff</th>
                    <th>Days marked</th>
                    <th>Raw minutes</th>
                    <th>Missing punches</th>
                    <th>Approved leave days</th>
                  </tr>
                </thead>
                <tbody>
                  {data.data.items.map((s) => (
                    <tr key={s.staff_id}>
                      <td>{s.staff_name}</td>
                      <td>{s.days_marked}</td>
                      <td>{s.raw_punch_minutes}</td>
                      <td>{s.missing_punch_days}</td>
                      <td>{s.approved_leave_calendar_days}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
