import { describe, expect, it } from "vitest";
import {
  applyRecoveryModulationToBlocks,
  classifyRecoveryZone,
  computeRecoveryModulation,
  DELOAD_CONSECUTIVE_LOW_DAYS,
  type RecoveryModulationDecision,
  RED_DAY_SET_SCALE,
} from "./recoveryModulation";

function day(calendarDate: string, recoveryScore: number | null) {
  return { calendarDate, recoveryScore };
}

const REDUCE_DECISION: RecoveryModulationDecision = {
  kind: "reduce",
  zone: "red",
  setScale: RED_DAY_SET_SCALE,
  stripIntensityTechniques: true,
  consecutiveRedDays: 1,
  recommendRecoverySession: false,
  deloadSignal: false,
};

describe("classifyRecoveryZone", () => {
  it("classifies the documented Whoop zone boundaries", () => {
    expect(classifyRecoveryZone(100)).toBe("green");
    expect(classifyRecoveryZone(67)).toBe("green");
    expect(classifyRecoveryZone(66)).toBe("yellow");
    expect(classifyRecoveryZone(34)).toBe("yellow");
    expect(classifyRecoveryZone(33)).toBe("red");
    expect(classifyRecoveryZone(0)).toBe("red");
  });
});

describe("computeRecoveryModulation", () => {
  it("no-ops when no recovery score has landed", () => {
    const decision = computeRecoveryModulation({ todayScore: null, priorDays: [] });

    expect(decision).toEqual({ kind: "none", reason: "no_data", deloadSignal: false });
  });

  it("does not signal deload from HRV when today has no score", () => {
    const decision = computeRecoveryModulation({
      todayScore: null,
      priorDays: [],
      hrvRecentAvg: 30,
      hrvBaselineAvg: 60,
    });

    expect(decision).toEqual({ kind: "none", reason: "no_data", deloadSignal: false });
  });

  it("runs green days as programmed", () => {
    const decision = computeRecoveryModulation({ todayScore: 80, priorDays: [] });

    expect(decision).toEqual({ kind: "none", reason: "green", deloadSignal: false });
  });

  it("holds yellow days flat with one accessory set dropped", () => {
    const decision = computeRecoveryModulation({ todayScore: 50, priorDays: [] });

    expect(decision).toEqual({
      kind: "hold",
      zone: "yellow",
      dropAccessorySets: 1,
      deloadSignal: false,
    });
  });

  it("reduces red days and keeps the session on the first red day", () => {
    const decision = computeRecoveryModulation({
      todayScore: 20,
      priorDays: [day("2026-08-03", 70)],
    });

    expect(decision).toMatchObject({
      kind: "reduce",
      zone: "red",
      setScale: RED_DAY_SET_SCALE,
      stripIntensityTechniques: true,
      consecutiveRedDays: 1,
      recommendRecoverySession: false,
    });
  });

  it("recommends a recovery session on the second consecutive red day", () => {
    const decision = computeRecoveryModulation({
      todayScore: 25,
      priorDays: [day("2026-08-03", 30), day("2026-08-02", 75)],
    });

    expect(decision).toMatchObject({ consecutiveRedDays: 2, recommendRecoverySession: true });
  });

  it("breaks the red streak on an unscored day instead of counting it as red", () => {
    const decision = computeRecoveryModulation({
      todayScore: 25,
      priorDays: [day("2026-08-03", null), day("2026-08-02", 20)],
    });

    expect(decision).toMatchObject({ consecutiveRedDays: 1, recommendRecoverySession: false });
  });

  it("signals deload after three consecutive sub-green days", () => {
    const decision = computeRecoveryModulation({
      todayScore: 40,
      priorDays: [day("2026-08-03", 50), day("2026-08-02", 30), day("2026-08-01", 90)],
    });

    expect(decision.deloadSignal).toBe(true);
    expect(
      computeRecoveryModulation({
        todayScore: 40,
        priorDays: [day("2026-08-03", 50), day("2026-08-01", 90)],
      }).deloadSignal,
    ).toBe(DELOAD_CONSECUTIVE_LOW_DAYS <= 2);
  });

  it("signals deload when 7-day HRV sits meaningfully below baseline", () => {
    const decision = computeRecoveryModulation({
      todayScore: 80,
      priorDays: [],
      hrvRecentAvg: 40,
      hrvBaselineAvg: 50,
    });

    expect(decision).toEqual({ kind: "none", reason: "green", deloadSignal: true });
  });

  it("does not signal deload at exactly the HRV ratio boundary", () => {
    const decision = computeRecoveryModulation({
      todayScore: 80,
      priorDays: [],
      hrvRecentAvg: 45,
      hrvBaselineAvg: 50,
    });

    expect(decision.deloadSignal).toBe(false);
  });

  it("ignores the HRV rule when either average is missing or degenerate", () => {
    expect(
      computeRecoveryModulation({ todayScore: 80, priorDays: [], hrvRecentAvg: 30 }).deloadSignal,
    ).toBe(false);
    expect(
      computeRecoveryModulation({
        todayScore: 80,
        priorDays: [],
        hrvRecentAvg: 30,
        hrvBaselineAvg: 0,
      }).deloadSignal,
    ).toBe(false);
  });
});

describe("applyRecoveryModulationToBlocks", () => {
  const warmupBlock = {
    exercises: [{ movementId: "warm-1", sets: 2, reps: 15, warmUp: true }],
  };
  const mainSuperset = {
    exercises: [
      { movementId: "bench", sets: 4, reps: 8, dropSet: true },
      { movementId: "row", sets: 4, reps: 8 },
    ],
  };
  const straightSetWithRest = {
    exercises: [
      { movementId: "squat", sets: 3, reps: 10, eccentric: true },
      { movementId: "rest-movement", sets: 3, duration: 90 },
    ],
  };
  const cooldownBlock = {
    exercises: [{ movementId: "cool-1", sets: 2, reps: 12 }],
  };

  it("returns blocks unchanged for a none decision", () => {
    const blocks = [warmupBlock, mainSuperset];

    const result = applyRecoveryModulationToBlocks(blocks, {
      kind: "none",
      reason: "green",
      deloadSignal: false,
    });

    expect(result).toEqual(blocks);
    expect(result).not.toBe(blocks);
  });

  it("drops one set from only the last full-sized block on hold", () => {
    const result = applyRecoveryModulationToBlocks(
      [warmupBlock, mainSuperset, straightSetWithRest, cooldownBlock],
      { kind: "hold", zone: "yellow", dropAccessorySets: 1, deloadSignal: false },
    );

    expect(result[0]).toEqual(warmupBlock);
    expect(result[1]).toEqual(mainSuperset);
    expect(result[2].exercises.map((exercise) => exercise.sets)).toEqual([2, 2]);
    expect(result[3]).toEqual(cooldownBlock);
  });

  it("leaves blocks unchanged on hold when nothing is full-sized", () => {
    const blocks = [warmupBlock, cooldownBlock];

    const result = applyRecoveryModulationToBlocks(blocks, {
      kind: "hold",
      zone: "yellow",
      dropAccessorySets: 1,
      deloadSignal: false,
    });

    expect(result).toEqual(blocks);
  });

  it("scales sets ~30% down on red and keeps superset partners in sync", () => {
    const result = applyRecoveryModulationToBlocks([mainSuperset, straightSetWithRest], {
      ...REDUCE_DECISION,
    });

    expect(result[0].exercises.map((exercise) => exercise.sets)).toEqual([3, 3]);
    expect(result[1].exercises.map((exercise) => exercise.sets)).toEqual([2, 2]);
  });

  it("strips intensity techniques on red but preserves reps and duration", () => {
    const result = applyRecoveryModulationToBlocks([mainSuperset, straightSetWithRest], {
      ...REDUCE_DECISION,
    });

    const [bench] = result[0].exercises;
    expect(bench.dropSet).toBeUndefined();
    expect(bench.reps).toBe(8);
    const [squat, rest] = result[1].exercises;
    expect(squat.eccentric).toBeUndefined();
    expect(squat.reps).toBe(10);
    expect(rest.duration).toBe(90);
  });

  it("never reduces warmup or cooldown-sized work on red", () => {
    const result = applyRecoveryModulationToBlocks([warmupBlock, cooldownBlock], {
      ...REDUCE_DECISION,
    });

    expect(result[0]).toEqual(warmupBlock);
    expect(result[1].exercises[0].sets).toBe(2);
  });

  it("never scales below the red-day set floor", () => {
    const threeSetBlock = { exercises: [{ movementId: "curl", sets: 3, reps: 12 }] };

    const result = applyRecoveryModulationToBlocks([threeSetBlock], { ...REDUCE_DECISION });

    expect(result[0].exercises[0].sets).toBe(2);
  });

  it("does not mutate the input blocks", () => {
    const blocks = [
      {
        exercises: [{ movementId: "bench", sets: 4, reps: 8, dropSet: true }],
      },
    ];

    applyRecoveryModulationToBlocks(blocks, { ...REDUCE_DECISION });

    expect(blocks[0].exercises[0].sets).toBe(4);
    expect(blocks[0].exercises[0].dropSet).toBe(true);
  });
});
