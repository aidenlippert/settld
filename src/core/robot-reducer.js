import { validateRobotAvailabilitySetPayload, validateRobotHeartbeatPayload, validateRobotRegisteredPayload, validateRobotStatusChangedPayload } from "./robots.js";
import {
  validateMaintenanceCompletedPayload,
  validateMaintenanceRequestedPayload,
  validateRobotQuarantineClearedPayload,
  validateRobotQuarantinedPayload,
  validateRobotUnhealthyPayload
} from "./robot-health.js";
import { DEFAULT_TENANT_ID } from "./tenancy.js";

export function reduceRobot(events) {
  if (!Array.isArray(events)) throw new TypeError("events must be an array");
  if (events.length === 0) return null;

  let robot = null;

  for (const event of events) {
    if (!event || typeof event !== "object") throw new TypeError("event must be an object");

    if (event.type === "ROBOT_REGISTERED") {
      const payload = event.payload ?? {};
      validateRobotRegisteredPayload(payload);
      if (payload.robotId !== event.streamId) throw new TypeError("robotId must match streamId");
      robot = {
        id: event.streamId,
        tenantId: payload.tenantId ?? DEFAULT_TENANT_ID,
        name: payload.name ?? null,
        ownerId: payload.ownerId ?? null,
        capabilities: payload.capabilities ?? {},
        trustScore: payload.trustScore ?? 0.5,
        signerKeyId: payload.signerKeyId ?? null,
        homeZoneId: payload.homeZoneId ?? null,
        currentZoneId: payload.currentZoneId ?? payload.homeZoneId ?? null,
        status: "active",
        quarantine: {
          status: "none",
          reason: null,
          quarantinedAt: null,
          until: null,
          manualClearRequired: null,
          incidentId: null,
          jobId: null,
          notes: null,
          clearedAt: null,
          clearedReason: null,
          clearedNotes: null,
          maintenanceId: null
        },
        maintenance: {
          status: "none",
          maintenanceId: null,
          requestedAt: null,
          requestReason: null,
          requestNotes: null,
          completedAt: null,
          checklist: null,
          completedNotes: null
        },
        availability: [],
        lastHeartbeat: null,
        revision: 0,
        registeredAt: event.at,
        createdAt: event.at,
        updatedAt: event.at
      };
      continue;
    }

    if (!robot) throw new TypeError("robot stream is missing ROBOT_REGISTERED");

    const now = event.at ?? new Date().toISOString();
    robot = { ...robot, revision: robot.revision + 1, updatedAt: now };

    if (event.type === "ROBOT_AVAILABILITY_SET") {
      const payload = event.payload ?? {};
      validateRobotAvailabilitySetPayload(payload);
      if (payload.robotId !== robot.id) throw new TypeError("payload.robotId must match robot id");
      robot = { ...robot, availability: payload.availability ?? [], availabilityUpdatedAt: now };
    }

    if (event.type === "ROBOT_STATUS_CHANGED") {
      const payload = event.payload ?? {};
      validateRobotStatusChangedPayload(payload);
      if (payload.robotId !== robot.id) throw new TypeError("payload.robotId must match robot id");
      robot = { ...robot, status: payload.status, statusReason: payload.reason ?? null, statusUpdatedAt: now };
    }

    if (event.type === "ROBOT_UNHEALTHY") {
      const payload = event.payload ?? {};
      validateRobotUnhealthyPayload(payload);
      if (payload.robotId !== robot.id) throw new TypeError("payload.robotId must match robot id");
      robot = {
        ...robot,
        status: "unhealthy",
        statusReason: payload.reason ?? null,
        statusUpdatedAt: now,
        lastUnhealthy: { at: now, ...payload }
      };
    }

    if (event.type === "ROBOT_QUARANTINED") {
      const payload = event.payload ?? {};
      validateRobotQuarantinedPayload(payload);
      if (payload.robotId !== robot.id) throw new TypeError("payload.robotId must match robot id");
      robot = {
        ...robot,
        status: "quarantined",
        statusReason: payload.reason ?? null,
        statusUpdatedAt: now,
        quarantine: {
          status: "quarantined",
          reason: payload.reason ?? null,
          quarantinedAt: payload.quarantinedAt ?? now,
          until: payload.until ?? null,
          manualClearRequired: payload.manualClearRequired ?? null,
          incidentId: payload.incidentId ?? null,
          jobId: payload.jobId ?? null,
          notes: payload.notes ?? null,
          clearedAt: null,
          clearedReason: null,
          clearedNotes: null,
          maintenanceId: null
        }
      };
    }

    if (event.type === "ROBOT_QUARANTINE_CLEARED") {
      const payload = event.payload ?? {};
      validateRobotQuarantineClearedPayload(payload);
      if (payload.robotId !== robot.id) throw new TypeError("payload.robotId must match robot id");
      robot = {
        ...robot,
        status: "active",
        statusReason: null,
        statusUpdatedAt: now,
        quarantine: {
          ...robot.quarantine,
          status: "cleared",
          clearedAt: payload.clearedAt ?? now,
          clearedReason: payload.reason ?? null,
          clearedNotes: payload.notes ?? null,
          maintenanceId: payload.maintenanceId ?? null
        }
      };
    }

    if (event.type === "MAINTENANCE_REQUESTED") {
      const payload = event.payload ?? {};
      validateMaintenanceRequestedPayload(payload);
      if (payload.robotId !== robot.id) throw new TypeError("payload.robotId must match robot id");
      robot = {
        ...robot,
        maintenance: {
          status: "requested",
          maintenanceId: payload.maintenanceId ?? null,
          requestedAt: payload.requestedAt ?? now,
          requestReason: payload.reason ?? null,
          requestNotes: payload.notes ?? null,
          completedAt: null,
          checklist: null,
          completedNotes: null
        }
      };
    }

    if (event.type === "MAINTENANCE_COMPLETED") {
      const payload = event.payload ?? {};
      validateMaintenanceCompletedPayload(payload);
      if (payload.robotId !== robot.id) throw new TypeError("payload.robotId must match robot id");
      if (robot.maintenance?.maintenanceId && payload.maintenanceId !== robot.maintenance.maintenanceId) {
        throw new TypeError("payload.maintenanceId does not match active maintenance request");
      }
      robot = {
        ...robot,
        maintenance: {
          status: "completed",
          maintenanceId: payload.maintenanceId ?? robot.maintenance?.maintenanceId ?? null,
          requestedAt: robot.maintenance?.requestedAt ?? null,
          requestReason: robot.maintenance?.requestReason ?? null,
          requestNotes: robot.maintenance?.requestNotes ?? null,
          completedAt: payload.completedAt ?? now,
          checklist: payload.checklist ?? null,
          completedNotes: payload.notes ?? null
        }
      };
    }

    if (event.type === "ROBOT_HEARTBEAT") {
      const payload = event.payload ?? {};
      validateRobotHeartbeatPayload(payload);
      const zoneId = payload.location?.zoneId ?? null;
      robot = { ...robot, lastHeartbeat: { at: now, ...payload }, currentZoneId: zoneId ?? robot.currentZoneId ?? robot.homeZoneId ?? null };
    }
  }

  const head = events[events.length - 1];
  return { ...robot, lastChainHash: head?.chainHash ?? null, lastEventId: head?.id ?? null };
}
