import { robotIsAvailableForWindow } from "./robots.js";

export function selectRobotForJob({ robots, window, reservations, minTrustScore = 0 }) {
  if (!Array.isArray(robots)) throw new TypeError("robots must be an array");
  if (!window?.startAt || !window?.endAt) throw new TypeError("window must include startAt/endAt");
  const isReservedOverlapping = typeof reservations === "function" ? reservations : () => false;

  const candidates = [];
  for (const robot of robots) {
    if (!robot) continue;
    if (robot.status && robot.status !== "active") continue;
    const trustScore = typeof robot.trustScore === "number" ? robot.trustScore : 0;
    if (trustScore < minTrustScore) continue;
    if (!robotIsAvailableForWindow(robot, window)) continue;
    if (isReservedOverlapping(robot.id, window)) continue;
    candidates.push({ robotId: robot.id, score: trustScore });
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.robotId.localeCompare(b.robotId);
  });

  return { selected: candidates[0] ?? null, candidates };
}

