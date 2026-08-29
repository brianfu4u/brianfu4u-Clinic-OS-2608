import type { ActorContext } from "./contracts.ts";
import { DomainError } from "./errors.ts";

export function assertActorContext(context: ActorContext): void {
  if (
    !context ||
    typeof context.clinicId !== "string" ||
    context.clinicId.trim() === "" ||
    typeof context.actorId !== "string" ||
    context.actorId.trim() === "" ||
    !["EMPLOYEE", "MANAGER"].includes(context.role)
  ) {
    throw new DomainError("INVALID_ACTOR_CONTEXT", "ActorContext must contain exact clinic, actor and role values.");
  }
}

export function assertActorAccess(
  context: ActorContext,
  clinicId: string,
  role: ActorContext["role"],
): void {
  assertActorContext(context);
  if (context.clinicId !== clinicId) {
    throw new DomainError("TENANT_SCOPE_VIOLATION", "ActorContext is outside this clinic scope.");
  }
  if (context.role !== role) {
    throw new DomainError("ROLE_SCOPE_VIOLATION", `This operation requires the ${role} role.`);
  }
}
