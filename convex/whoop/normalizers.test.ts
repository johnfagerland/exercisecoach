import { describe, expect, it } from "vitest";
import {
  normalizeWhoopCycles,
  normalizeWhoopRecoveries,
  normalizeWhoopSleeps,
  type WhoopCycleRow,
  whoopLocalCalendarDate,
  type WhoopSleepRow,
} from "./normalizers";

const sleepId = "e3f34cf9-4bd6-4a80-9c60-63a3b9391eaa";

const fullSleepRecord = {
  id: sleepId,
  user_id: 10_129,
  start: "2026-02-09T21:10:00.000Z",
  end: "2026-02-10T04:45:00.000Z",
  timezone_offset: "-05:00",
  nap: false,
  score_state: "SCORED",
  score: {
    stage_summary: {
      total_in_bed_time_milli: 27_300_000,
      total_awake_time_milli: 1_200_000,
      total_light_sleep_time_milli: 14_000_000,
      total_slow_wave_sleep_time_milli: 6_500_000,
      total_rem_sleep_time_milli: 5_600_000,
      sleep_cycle_count: 4,
      disturbance_count: 7,
    },
    respiratory_rate: 14.2,
    sleep_performance_percentage: 91,
    sleep_consistency_percentage: 84,
    sleep_efficiency_percentage: 95.5,
  },
};

const fullCycleRecord = {
  id: 93_845,
  user_id: 10_129,
  start: "2026-02-09T23:30:00.000Z",
  end: "2026-02-10T23:10:00.000Z",
  timezone_offset: "-05:00",
  score_state: "SCORED",
  score: {
    strain: 14.3,
    kilojoule: 8_300.5,
    average_heart_rate: 72,
    max_heart_rate: 165,
  },
};

const fullRecoveryRecord = {
  cycle_id: 93_845,
  sleep_id: sleepId,
  user_id: 10_129,
  score_state: "SCORED",
  score: {
    user_calibrating: false,
    recovery_score: 67,
    resting_heart_rate: 52,
    hrv_rmssd_milli: 48.7,
    spo2_percentage: 96.5,
    skin_temp_celsius: 33.1,
  },
};

function mapsFrom(records: { cycles?: unknown[]; sleeps?: unknown[] }): {
  cyclesById: Map<number, WhoopCycleRow>;
  sleepsById: Map<string, WhoopSleepRow>;
} {
  return {
    cyclesById: new Map(
      normalizeWhoopCycles(records.cycles ?? []).map((row) => [row.cycleId, row]),
    ),
    sleepsById: new Map(
      normalizeWhoopSleeps(records.sleeps ?? []).map((row) => [row.sleepId, row]),
    ),
  };
}

describe("whoopLocalCalendarDate", () => {
  it("shifts the date backward across midnight for a negative offset", () => {
    expect(whoopLocalCalendarDate("2026-01-01T03:30:00.000Z", "-05:00")).toBe("2025-12-31");
  });

  it("shifts the date forward across midnight for a positive half-hour offset", () => {
    expect(whoopLocalCalendarDate("2026-01-01T20:00:00.000Z", "+05:30")).toBe("2026-01-02");
  });

  it("falls back to the UTC date when the offset is missing", () => {
    expect(whoopLocalCalendarDate("2026-01-01T03:30:00.000Z")).toBe("2026-01-01");
  });

  it("falls back to the UTC date for a malformed offset", () => {
    expect(whoopLocalCalendarDate("2026-01-01T03:30:00.000Z", "EST")).toBe("2026-01-01");
    expect(whoopLocalCalendarDate("2026-01-01T03:30:00.000Z", "-5:00")).toBe("2026-01-01");
  });

  it("returns null for an unparseable instant", () => {
    expect(whoopLocalCalendarDate("not-an-instant", "-05:00")).toBeNull();
  });
});

describe("normalizeWhoopSleeps", () => {
  it("maps every score and stage-summary field of a scored sleep", () => {
    const rows = normalizeWhoopSleeps([fullSleepRecord]);

    expect(rows).toEqual([
      {
        calendarDate: "2026-02-09",
        sleepId,
        start: "2026-02-09T21:10:00.000Z",
        end: "2026-02-10T04:45:00.000Z",
        timezoneOffset: "-05:00",
        nap: false,
        scoreState: "SCORED",
        sleepPerformancePercentage: 91,
        sleepEfficiencyPercentage: 95.5,
        sleepConsistencyPercentage: 84,
        respiratoryRate: 14.2,
        totalInBedTimeMilli: 27_300_000,
        totalAwakeTimeMilli: 1_200_000,
        totalLightSleepTimeMilli: 14_000_000,
        totalSlowWaveSleepTimeMilli: 6_500_000,
        totalRemSleepTimeMilli: 5_600_000,
        sleepCycleCount: 4,
        disturbanceCount: 7,
        rawJson: JSON.stringify(fullSleepRecord),
      },
    ]);
  });

  it("preserves the nap flag", () => {
    const nap = { ...fullSleepRecord, id: "nap-1", nap: true };

    const rows = normalizeWhoopSleeps([nap]);

    expect(rows[0]?.nap).toBe(true);
  });

  it("attributes the night to the wake-up date in the record timezone", () => {
    const rows = normalizeWhoopSleeps([
      { ...fullSleepRecord, end: "2026-02-10T04:45:00.000Z", timezone_offset: "-05:00" },
    ]);

    // 04:45Z on Feb 10 is still the evening of Feb 9 at UTC-5.
    expect(rows[0]?.calendarDate).toBe("2026-02-09");
  });

  it("drops a malformed record without failing the batch", () => {
    const rows = normalizeWhoopSleeps([{ id: sleepId, nap: "yes" }, fullSleepRecord]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.sleepId).toBe(sleepId);
  });

  it("round-trips the raw record through rawJson", () => {
    const rows = normalizeWhoopSleeps([fullSleepRecord]);

    expect(JSON.parse(rows[0]?.rawJson ?? "")).toEqual(fullSleepRecord);
  });
});

describe("normalizeWhoopCycles", () => {
  it("maps a scored cycle with its calendar date from start and offset", () => {
    const rows = normalizeWhoopCycles([fullCycleRecord]);

    expect(rows).toEqual([
      {
        // 23:30Z on Feb 9 is the afternoon of Feb 9 at UTC-5.
        calendarDate: "2026-02-09",
        cycleId: 93_845,
        start: "2026-02-09T23:30:00.000Z",
        end: "2026-02-10T23:10:00.000Z",
        timezoneOffset: "-05:00",
        scoreState: "SCORED",
        strain: 14.3,
        kilojoule: 8_300.5,
        averageHeartRate: 72,
        maxHeartRate: 165,
        rawJson: JSON.stringify(fullCycleRecord),
      },
    ]);
  });

  it("keeps an in-progress cycle whose end is null", () => {
    const inProgress = { ...fullCycleRecord, end: null, score_state: "PENDING_SCORE" };

    const rows = normalizeWhoopCycles([inProgress]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.end).toBeUndefined();
    expect(rows[0]?.scoreState).toBe("PENDING_SCORE");
  });

  it("drops a malformed record without failing the batch", () => {
    const rows = normalizeWhoopCycles([{ id: "not-a-number" }, fullCycleRecord]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.cycleId).toBe(93_845);
  });
});

describe("normalizeWhoopRecoveries", () => {
  it("joins the calendar date and timezone offset from the owning cycle", () => {
    const { cyclesById, sleepsById } = mapsFrom({ cycles: [fullCycleRecord] });

    const rows = normalizeWhoopRecoveries([fullRecoveryRecord], cyclesById, sleepsById);

    expect(rows).toEqual([
      {
        calendarDate: "2026-02-09",
        sleepId,
        cycleId: 93_845,
        timezoneOffset: "-05:00",
        scoreState: "SCORED",
        userCalibrating: false,
        recoveryScore: 67,
        hrvRmssdMilli: 48.7,
        restingHeartRate: 52,
        spo2Percentage: 96.5,
        skinTempCelsius: 33.1,
        rawJson: JSON.stringify(fullRecoveryRecord),
      },
    ]);
  });

  it("falls back to the scored sleep's wake date when the cycle is absent", () => {
    const { cyclesById, sleepsById } = mapsFrom({ sleeps: [fullSleepRecord] });

    const rows = normalizeWhoopRecoveries([fullRecoveryRecord], cyclesById, sleepsById);

    expect(rows[0]?.calendarDate).toBe("2026-02-09");
    expect(rows[0]?.timezoneOffset).toBe("-05:00");
  });

  it("drops a recovery when neither its cycle nor its sleep is present", () => {
    const { cyclesById, sleepsById } = mapsFrom({});

    const rows = normalizeWhoopRecoveries([fullRecoveryRecord], cyclesById, sleepsById);

    expect(rows).toEqual([]);
  });

  it("maps calibration recoveries with their partial scores", () => {
    const calibrating = {
      ...fullRecoveryRecord,
      score: { user_calibrating: true, resting_heart_rate: 55 },
    };
    const { cyclesById, sleepsById } = mapsFrom({ cycles: [fullCycleRecord] });

    const rows = normalizeWhoopRecoveries([calibrating], cyclesById, sleepsById);

    expect(rows[0]?.userCalibrating).toBe(true);
    expect(rows[0]?.restingHeartRate).toBe(55);
    expect(rows[0]?.recoveryScore).toBeUndefined();
  });

  it("drops a malformed record without failing the batch", () => {
    const { cyclesById, sleepsById } = mapsFrom({ cycles: [fullCycleRecord] });

    const rows = normalizeWhoopRecoveries(
      [{ cycle_id: "93845", sleep_id: sleepId }, fullRecoveryRecord],
      cyclesById,
      sleepsById,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.cycleId).toBe(93_845);
  });
});
