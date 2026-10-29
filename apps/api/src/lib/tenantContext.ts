import { AsyncLocalStorage } from "node:async_hooks";

/** Created once per HTTP request; populated only after authenticated membership. */
export const tenantContext = new AsyncLocalStorage<{ schoolId?: string }>();
export function authorizeTenant(schoolId: string): void {
  const context = tenantContext.getStore();
  if (context) context.schoolId = schoolId;
}
