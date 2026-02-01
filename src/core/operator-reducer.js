import { validateOperatorRegisteredPayload, validateOperatorShiftClosedPayload, validateOperatorShiftOpenedPayload } from "./operators.js";
import { DEFAULT_TENANT_ID } from "./tenancy.js";

export function reduceOperator(events) {
  if (!Array.isArray(events)) throw new TypeError("events must be an array");
  if (events.length === 0) return null;

  let operator = null;

  for (const event of events) {
    if (!event || typeof event !== "object") throw new TypeError("event must be an object");

    if (event.type === "OPERATOR_REGISTERED") {
      const payload = event.payload ?? {};
      validateOperatorRegisteredPayload(payload);
      if (payload.operatorId !== event.streamId) throw new TypeError("operatorId must match streamId");
      operator = {
        id: event.streamId,
        tenantId: payload.tenantId ?? DEFAULT_TENANT_ID,
        name: payload.name ?? null,
        signerKeyId: payload.signerKeyId ?? null,
        shift: { status: "closed", shiftId: null, openedAt: null, closedAt: null, zoneId: null, maxConcurrentJobs: 1 },
        revision: 0,
        registeredAt: event.at,
        createdAt: event.at,
        updatedAt: event.at
      };
      continue;
    }

    if (!operator) throw new TypeError("operator stream is missing OPERATOR_REGISTERED");

    const now = event.at ?? new Date().toISOString();
    operator = { ...operator, revision: operator.revision + 1, updatedAt: now };

    if (event.type === "OPERATOR_SHIFT_OPENED") {
      const payload = event.payload ?? {};
      validateOperatorShiftOpenedPayload(payload);
      if (payload.operatorId !== operator.id) throw new TypeError("payload.operatorId must match operator id");
      operator = {
        ...operator,
        shift: {
          status: "open",
          shiftId: payload.shiftId ?? null,
          openedAt: now,
          closedAt: null,
          zoneId: payload.zoneId ?? operator.shift?.zoneId ?? null,
          maxConcurrentJobs: payload.maxConcurrentJobs ?? operator.shift?.maxConcurrentJobs ?? 1
        }
      };
    }

    if (event.type === "OPERATOR_SHIFT_CLOSED") {
      const payload = event.payload ?? {};
      validateOperatorShiftClosedPayload(payload);
      if (payload.operatorId !== operator.id) throw new TypeError("payload.operatorId must match operator id");
      operator = {
        ...operator,
        shift: {
          status: "closed",
          shiftId: payload.shiftId ?? operator.shift?.shiftId ?? null,
          openedAt: operator.shift?.openedAt ?? null,
          closedAt: now,
          zoneId: operator.shift?.zoneId ?? null,
          maxConcurrentJobs: operator.shift?.maxConcurrentJobs ?? 1
        }
      };
    }
  }

  const head = events[events.length - 1];
  return { ...operator, lastChainHash: head?.chainHash ?? null, lastEventId: head?.id ?? null };
}
