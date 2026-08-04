import { describe, expect, it } from "vitest";
import { deriveRecoveryState } from "./recovery";
import type { RecoveryObservation } from "./types";

const NOW = Date.parse("2026-08-04T12:00:00.000Z");
const TODAY = "2026-08-04";

function whoopObservation(overrides: Partial<RecoveryObservation> = {}): RecoveryObservation {
  return {
    source: "whoop",
    calendarDate: TODAY,
    ingestedAt: NOW - 60_000,
    recoveryScorePercent: 55,
    hrvMilliseconds: 45,
    restingHeartRate: 52,
    sleepPerformancePercent: 80,
    dayStrain: 10.5,
    ...overrides,
  };
}

describe("deriveRecoveryState with Whoop observations", () => {
  it("selects a fresh Whoop observation and carries its metrics through", () => {
    const state = deriveRecoveryState({
      now: NOW,
      currentCalendarDate: TODAY,
      inputs: { preferredSource: null, observations: [whoopObservation()], checkIns: [] },
    });

    expect(state.source).toBe("whoop");
    expect(state.status).toBe("normal");
    expect(state.metrics).toMatchObject({
      recoveryScorePercent: 55,
      sleepPerformancePercent: 80,
      dayStrain: 10.5,
      hrvMilliseconds: 45,
      restingHeartRate: 52,
    });
  });

  it("flags caution for a red-zone Whoop recovery score", () => {
    const state = deriveRecoveryState({
      now: NOW,
      currentCalendarDate: TODAY,
      inputs: {
        preferredSource: null,
        observations: [whoopObservation({ recoveryScorePercent: 33 })],
        checkIns: [],
      },
    });

    expect(state.status).toBe("caution");
    expect(state.reasons).toContain("low_recovery_score");
  });

  it("does not apply the Whoop threshold to other providers", () => {
    const state = deriveRecoveryState({
      now: NOW,
      currentCalendarDate: TODAY,
      inputs: {
        preferredSource: null,
        observations: [
          {
            source: "garmin",
            calendarDate: TODAY,
            ingestedAt: NOW - 60_000,
            recoveryScorePercent: 20,
            sleepDurationSeconds: 8 * 3600,
          },
        ],
        checkIns: [],
      },
    });

    expect(state.reasons).not.toContain("low_recovery_score");
  });

  it("honors an explicit Whoop preference over a fresher provider", () => {
    const garmin: RecoveryObservation = {
      source: "garmin",
      calendarDate: TODAY,
      ingestedAt: NOW - 1_000,
      sleepDurationSeconds: 7 * 3600,
    };

    const state = deriveRecoveryState({
      now: NOW,
      currentCalendarDate: TODAY,
      inputs: {
        preferredSource: "whoop",
        observations: [garmin, whoopObservation({ ingestedAt: NOW - 120_000 })],
        checkIns: [],
      },
    });

    expect(state.source).toBe("whoop");
  });

  it("breaks equal-freshness ties deterministically across all three providers", () => {
    const shared = { calendarDate: TODAY, ingestedAt: NOW - 60_000 };

    const state = deriveRecoveryState({
      now: NOW,
      currentCalendarDate: TODAY,
      inputs: {
        preferredSource: null,
        observations: [
          { source: "fitbit", ...shared, restingHeartRate: 60 },
          { source: "whoop", ...shared, recoveryScorePercent: 70 },
          { source: "garmin", ...shared, sleepDurationSeconds: 8 * 3600 },
        ],
        checkIns: [],
      },
    });

    expect(state.source).toBe("garmin");
  });

  it("falls back past a stale Whoop observation to a fresh provider", () => {
    const staleWhoop = whoopObservation({ ingestedAt: NOW - 48 * 3600 * 1000 });
    const freshFitbit: RecoveryObservation = {
      source: "fitbit",
      calendarDate: TODAY,
      ingestedAt: NOW - 60_000,
      restingHeartRate: 58,
    };

    const state = deriveRecoveryState({
      now: NOW,
      currentCalendarDate: TODAY,
      inputs: {
        preferredSource: "whoop",
        observations: [staleWhoop, freshFitbit],
        checkIns: [],
      },
    });

    expect(state.source).toBe("fitbit");
  });
});
