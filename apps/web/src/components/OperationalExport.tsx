import { useState } from "react";
import { useAuth, useSchoolId } from "../auth/AuthContext";
import { Button, Card, Field, Input, Select } from "./ui";
export function OperationalExport() {
  const { can } = useAuth(),
    school = useSchoolId();
  const [module, setModule] = useState("workforce"),
    [from, setFrom] = useState(""),
    [to, setTo] = useState("");
  if (!can("reports.export")) return null;
  return (
    <Card>
      <form
        className="flex flex-wrap items-end gap-3 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          window.location.assign(
            `/api/schools/${school}/operations/${module}/export?from=${from}&to=${to}`,
          );
        }}
      >
        <Field label="Operational report">
          <Select value={module} onChange={(e) => setModule(e.target.value)}>
            {[
              "workforce",
              "recruitment",
              "procurement",
              "transport",
              "library",
              "learning",
              "concerns",
            ].map((m) => (
              <option key={m}>{m}</option>
            ))}
          </Select>
        </Field>
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
        <Button type="submit">Download authorized CSV</Button>
        <p className="text-xs text-slate-500">
          Up to 5,000 rows. Narrow the dates for larger reports. School-wide
          module access is required.
        </p>
      </form>
    </Card>
  );
}
