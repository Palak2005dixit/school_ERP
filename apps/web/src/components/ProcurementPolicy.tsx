import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "../lib/api";
import { useSchoolId, useAuth } from "../auth/AuthContext";
import { Alert, Button, Card, Field, Input } from "./ui";
export function ProcurementPolicy() {
  const school = useSchoolId(),
    { can } = useAuth(),
    cache = useQueryClient();
  const [count, setCount] = useState("");
  const [message, setMessage] = useState("");
  const policy = useQuery({
    queryKey: ["procurement-policy", school],
    queryFn: () =>
      api<{ required_approvals: number }>(
        `/api/schools/${school}/procurement-settings`,
      ),
  });
  const save = useMutation({
    mutationFn: () =>
      api(`/api/schools/${school}/procurement-settings`, {
        method: "POST",
        body: JSON.stringify({ requiredApprovals: Number(count) }),
      }),
    onSuccess: () => {
      setMessage("Approval policy saved.");
      void cache.invalidateQueries({
        queryKey: ["procurement-policy", school],
      });
    },
  });
  return (
    <Card>
      <div className="space-y-3 p-4">
        <h2 className="font-semibold">Purchase request approval policy</h2>
        {policy.data && (
          <p>
            Required independent approvals: {policy.data.required_approvals}.
            Default 1 requires school confirmation.
          </p>
        )}
        {policy.error && <Alert>{errorMessage(policy.error)}</Alert>}
        {save.error && <Alert>{errorMessage(save.error)}</Alert>}
        {message && <p role="status">{message}</p>}
        {can("school.manage") && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (
                window.confirm(
                  "Apply this approval count to pending and future purchase requests?",
                )
              )
                save.mutate();
            }}
          >
            <Field label="Independent approvers required (1–5)">
              <Input
                required
                type="number"
                min="1"
                max="5"
                step="1"
                value={count}
                onChange={(e) => setCount(e.target.value)}
              />
            </Field>
            <Button disabled={save.isPending}>Save approval policy</Button>
          </form>
        )}
      </div>
    </Card>
  );
}
