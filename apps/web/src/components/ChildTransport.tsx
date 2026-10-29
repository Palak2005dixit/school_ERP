import { useQuery } from "@tanstack/react-query";
import { api, errorMessage } from "../lib/api";
import { useSchoolId } from "../auth/AuthContext";
import { Alert, Card } from "./ui";
export function ChildTransport({ studentId }: { studentId: string }) {
  const school = useSchoolId();
  const data = useQuery({
    queryKey: ["child-transport", school, studentId],
    queryFn: () =>
      api<{
        items: Array<{
          route_name: string;
          stop_name: string;
          scheduled_pickup: string | null;
          scheduled_drop: string | null;
          registration_number: string | null;
        }>;
      }>(`/api/schools/${school}/portal/children/${studentId}/transport`),
  });
  return (
    <Card>
      <div className="space-y-2 p-4">
        <h2 className="font-semibold">Transport allocation</h2>
        {data.isPending && <p role="status">Loading transport…</p>}
        {data.error && <Alert>{errorMessage(data.error)}</Alert>}
        {data.data?.items.length === 0 && (
          <p>No current transport allocation.</p>
        )}
        {data.data?.items.map((r, i) => (
          <p key={i}>
            {r.route_name} · {r.stop_name} · Pickup{" "}
            {r.scheduled_pickup ?? "Not set"} · Drop{" "}
            {r.scheduled_drop ?? "Not set"} · Vehicle{" "}
            {r.registration_number ?? "Not assigned"}
          </p>
        ))}
      </div>
    </Card>
  );
}
