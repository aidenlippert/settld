export const MONTH_CLOSE_HOLD_POLICY = Object.freeze({
  BLOCK_ANY_OPEN_HOLDS: "BLOCK_ANY_OPEN_HOLDS",
  BLOCK_HOLDS_ORIGINATED_IN_PERIOD: "BLOCK_HOLDS_ORIGINATED_IN_PERIOD",
  ALLOW_WITH_DISCLOSURE: "ALLOW_WITH_DISCLOSURE"
});

export function normalizeMonthCloseHoldPolicy(value) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return MONTH_CLOSE_HOLD_POLICY.BLOCK_HOLDS_ORIGINATED_IN_PERIOD;
  }
  const raw = String(value).trim().toUpperCase();
  for (const v of Object.values(MONTH_CLOSE_HOLD_POLICY)) {
    if (raw === v) return v;
  }
  throw new TypeError(
    `invalid month close hold policy: ${String(value)} (expected one of ${Object.values(MONTH_CLOSE_HOLD_POLICY).join(", ")})`
  );
}

