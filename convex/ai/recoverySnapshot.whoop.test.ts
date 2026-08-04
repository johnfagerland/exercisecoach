import { describe, expect, it } from "vitest";
import type { RecoveryState } from "../trainingState/types";
import { formatRecoveryLines } from "./recoverySnapshot";

function whoopState(overrides: Partial<RecoveryState> = {}): RecoveryState {
  return {
    status: "normal",
    confidence: "medium",
    source: "whoop",
    observedDate: "2026-08-04",
    reasons: [],
    metrics: {
      recoveryScorePercent: 62,
      sleepHours: 7.4,
      sleepPerformancePercent: 84,
      dayStrain: 12.3,
      hrvMilliseconds: 48,
      restingHeartRate: 51,
    },
    checkIn: null,
    history: [
      {
        source: "whoop",
        calendarDate: "2026-08-03",
        ingestedAt: 1,
        recoveryScorePercent: 41,
        dayStrain: 15.1,
        hrvMilliseconds: 39,
      },
    ],
    ...overrides,
  };
}

describe("formatRecoveryLines with Whoop metrics", () => {
  it("surfaces recovery score, sleep performance, and strain in the current line", () => {
    const lines = formatRecoveryLines(whoopState());

    expect(lines[0]).toContain("Whoop");
    const current = lines.find((line) => line.includes("Current"));
    expect(current).toContain("recovery 62%");
    expect(current).toContain("sleep performance 84%");
    expect(current).toContain("strain 12.3");
    expect(current).toContain("HRV 48ms");
  });

  it("carries Whoop metrics into history rows", () => {
    const lines = formatRecoveryLines(whoopState());

    const history = lines.find((line) => line.includes("2026-08-03"));
    expect(history).toContain("recovery 41%");
    expect(history).toContain("strain 15.1");
  });

  it("labels the red-zone caution reason", () => {
    const lines = formatRecoveryLines(
      whoopState({
        status: "caution",
        reasons: ["low_recovery_score"],
        metrics: { recoveryScorePercent: 20 },
      }),
    );

    const caution = lines.find((line) => line.includes("Caution"));
    expect(caution).toContain("red recovery zone");
  });
});
