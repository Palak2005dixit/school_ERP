import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "../lib/api";
import { useSchoolId, useAuth } from "../auth/AuthContext";
import { Alert, Button, Card, Field, Input, Select } from "./ui";
interface Document {
  id: string;
  filename: string;
  document_type: string;
  status: string;
}
export function HrDocuments() {
  const school = useSchoolId(),
    { can } = useAuth(),
    cache = useQueryClient();
  const [kind, setKind] = useState("candidateId"),
    [id, setId] = useState(""),
    [type, setType] = useState(""),
    [file, setFile] = useState<File | null>(null),
    [message, setMessage] = useState("");
  const docs = useQuery({
    queryKey: ["hr-documents", school, kind, id],
    queryFn: () =>
      api<{ items: Document[] }>(
        `/api/schools/${school}/hr/documents?${kind}=${encodeURIComponent(id)}`,
      ),
    enabled: /^[0-9a-f-]{36}$/i.test(id),
  });
  const action = useMutation({
    mutationFn: async (input?: { id: string; status: string }) => {
      if (input)
        return api(`/api/schools/${school}/hr/documents/${input.id}`, {
          method: "PATCH",
          body: JSON.stringify({ status: input.status }),
        });
      if (!file) throw new Error("Choose a document");
      if (file.size > 1048576) throw new Error("Maximum file size is 1 MiB");
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]!);
        reader.onerror = () => reject(new Error("Cannot read file"));
        reader.readAsDataURL(file);
      });
      return api(`/api/schools/${school}/hr/documents`, {
        method: "POST",
        body: JSON.stringify({
          [kind]: id,
          filename: file.name,
          contentType: file.type,
          documentType: type,
          dataBase64,
        }),
      });
    },
    onSuccess: () => {
      setMessage("Document saved.");
      void cache.invalidateQueries({ queryKey: ["hr-documents", school] });
    },
  });
  if (!can("hr.recruitment.manage") && !can("hr.employee.manage")) return null;
  return (
    <Card>
      <div className="space-y-3 p-4">
        <h2 className="font-semibold">Private onboarding documents</h2>
        <p className="text-sm">
          Use the candidate or employee record ID. Files are retained; automatic
          deletion requires an approved retention policy.
        </p>
        <Field label="Record type">
          <Select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="candidateId">Candidate</option>
            <option value="staffId">Employee</option>
          </Select>
        </Field>
        <Field label="Record ID">
          <Input value={id} onChange={(e) => setId(e.target.value)} />
        </Field>
        {docs.error && <Alert>{errorMessage(docs.error)}</Alert>}
        {action.error && <Alert>{errorMessage(action.error)}</Alert>}
        {message && <p role="status">{message}</p>}
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            action.mutate(undefined);
          }}
        >
          <Field label="Document category">
            <Input
              required
              value={type}
              onChange={(e) => setType(e.target.value)}
            />
          </Field>
          <Field label="File (PDF, PNG, JPEG or text; maximum 1 MiB)">
            <Input
              required
              type="file"
              accept=".pdf,.png,.jpg,.jpeg,.txt"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </Field>
          <Button disabled={action.isPending || !id}>
            Upload private document
          </Button>
        </form>
        {docs.data?.items.map((d) => (
          <div key={d.id} className="flex flex-wrap gap-3">
            <a
              className="underline"
              href={`/api/schools/${school}/hr/documents/${d.id}/download`}
            >
              {d.filename}
            </a>
            <span>
              {d.document_type}: {d.status}
            </span>
            {["verified", "rejected"].map((status) => (
              <Button
                key={status}
                disabled={action.isPending}
                onClick={() => action.mutate({ id: d.id, status })}
              >
                Mark {status}
              </Button>
            ))}
          </div>
        ))}
      </div>
    </Card>
  );
}
