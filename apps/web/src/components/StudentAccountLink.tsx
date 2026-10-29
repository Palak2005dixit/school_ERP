import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "../lib/api";
import { listUsers } from "../lib/endpoints";
import { useSchoolId, useAuth } from "../auth/AuthContext";
import { Alert, Button, Card, Field, Select } from "./ui";
export function StudentAccountLink({ studentId }: { studentId: string }) {
  const school = useSchoolId(),
    { can } = useAuth(),
    cache = useQueryClient();
  const [userId, setUser] = useState(""),
    [message, setMessage] = useState("");
  const enabled = can("access.roles.manage");
  const users = useQuery({
    queryKey: ["student-link-users", school],
    queryFn: () => listUsers(school),
    enabled,
  });
  const linked = useQuery({
    queryKey: ["student-account", school, studentId],
    queryFn: () =>
      api<{ userId: string | null }>(
        `/api/schools/${school}/students/${studentId}/login-account`,
      ),
    enabled,
  });
  const save = useMutation({
    mutationFn: () =>
      api(`/api/schools/${school}/students/${studentId}/login-account`, {
        method: "POST",
        body: JSON.stringify({ userId: userId || null }),
      }),
    onSuccess: () => {
      setMessage("Student login link saved.");
      void cache.invalidateQueries({
        queryKey: ["student-account", school, studentId],
      });
    },
  });
  if (!enabled) return null;
  return (
    <Card>
      <div className="space-y-3 p-4">
        <h2 className="font-semibold">Student login account</h2>
        <p>
          First create a dedicated student account in Users. Linking enables
          this student's own homework view and submissions.
        </p>
        <p>Current link: {linked.data?.userId ?? "None"}</p>
        {linked.error && <Alert>{errorMessage(linked.error)}</Alert>}
        {users.error && <Alert>{errorMessage(users.error)}</Alert>}
        {save.error && <Alert>{errorMessage(save.error)}</Alert>}
        {message && <p role="status">{message}</p>}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (
              window.confirm(
                "Change the student login link? Removing a link revokes that student role and sessions.",
              )
            )
              save.mutate();
          }}
        >
          <Field label="Student account">
            <Select value={userId} onChange={(e) => setUser(e.target.value)}>
              <option value="">Remove login link</option>
              {users.data?.items.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName} — {u.email}
                </option>
              ))}
            </Select>
          </Field>
          <Button disabled={save.isPending}>Save login link</Button>
        </form>
      </div>
    </Card>
  );
}
