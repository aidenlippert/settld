export const DEFAULT_ZONE_ID = "zone_default";

export function normalizeZoneId(zoneId) {
  if (zoneId === undefined || zoneId === null) return DEFAULT_ZONE_ID;
  if (typeof zoneId !== "string" || zoneId.trim() === "") return DEFAULT_ZONE_ID;
  return zoneId.trim();
}

