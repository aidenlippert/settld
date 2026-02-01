import { ENV_TIER } from "./booking.js";
import { DEFAULT_ZONE_ID } from "./zones.js";

export const PILOT_TEMPLATES = Object.freeze({
  managed_common_area_reset_l1: {
    id: "managed_common_area_reset_l1",
    name: "Managed Common Area Reset L1",
    jobTemplateId: "reset_lite",
    environmentTier: ENV_TIER.ENV_MANAGED_BUILDING,
    requiresOperatorCoverage: false,
    windowMinutes: 60,
    defaultZoneId: DEFAULT_ZONE_ID,
    allowedAccessMethods: ["BUILDING_CONCIERGE", "DOCKED_IN_BUILDING"],
    skillBundle: ["reset_lite_v1"]
  }
});

export function listPilotTemplates() {
  return Object.values(PILOT_TEMPLATES);
}

export function getPilotTemplate(pilotTemplateId) {
  if (typeof pilotTemplateId !== "string" || pilotTemplateId.trim() === "") return null;
  return PILOT_TEMPLATES[pilotTemplateId.trim()] ?? null;
}

