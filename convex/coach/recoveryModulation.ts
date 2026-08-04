/**
 * Deterministic recovery-based workout modulation (Whoop recovery zones).
 *
 * Pure functions with no Convex dependencies; the AI coach explains these
 * decisions but never computes them. Tonal block programming has no weight
 * fields (the trainer sets loads), so modulation acts on the levers the
 * programming model owns: set volume and intensity techniques.
 */

export const RECOVERY_GREEN_MIN_SCORE = 67;
export const RECOVERY_YELLOW_MIN_SCORE = 34;
/** ~30% volume cut on red days, matching the deload set multiplier's intent. */
export const RED_DAY_SET_SCALE = 0.7;
export const RED_DAY_MIN_SETS = 2;
/** Sets below this are warmup/cooldown-sized and never scaled down. */
const SCALABLE_MIN_SETS = 3;
/** Consecutive sub-green days (including today) that signal an early deload. */
export const DELOAD_CONSECUTIVE_LOW_DAYS = 3;
/** A 7-day HRV average this far below baseline signals an early deload. */
export const HRV_DELOAD_BASELINE_RATIO = 0.9;

export type RecoveryZone = "green" | "yellow" | "red";

export interface RecoveryDayObservation {
  calendarDate: string;
  /** Null when the day exists but was never scored (calibrating/unscorable). */
  recoveryScore: number | null;
}

export interface RecoveryModulationInput {
  /** Today's scored recovery; null when no usable score has landed yet. */
  todayScore: number | null;
  /** Prior days, most recent first. Gaps are allowed and break streaks. */
  priorDays: readonly RecoveryDayObservation[];
  /** Mean HRV (ms) over the trailing 7 days, when enough data exists. */
  hrvRecentAvg?: number;
  /** Mean HRV (ms) over the preceding baseline window, when enough data exists. */
  hrvBaselineAvg?: number;
}

export type RecoveryModulationDecision =
  | { kind: "none"; reason: "no_data" | "green"; deloadSignal: boolean }
  | { kind: "hold"; zone: "yellow"; dropAccessorySets: number; deloadSignal: boolean }
  | {
      kind: "reduce";
      zone: "red";
      setScale: number;
      stripIntensityTechniques: true;
      consecutiveRedDays: number;
      recommendRecoverySession: boolean;
      deloadSignal: boolean;
    };

export function classifyRecoveryZone(score: number): RecoveryZone {
  if (score >= RECOVERY_GREEN_MIN_SCORE) return "green";
  if (score >= RECOVERY_YELLOW_MIN_SCORE) return "yellow";
  return "red";
}

/** Count consecutive days matching `matches`, starting from today's zone. */
function consecutiveDays(
  todayZone: RecoveryZone,
  priorDays: readonly RecoveryDayObservation[],
  matches: (zone: RecoveryZone) => boolean,
): number {
  if (!matches(todayZone)) return 0;
  let streak = 1;
  for (const day of priorDays) {
    // A missing or unscored day breaks the streak rather than counting as low.
    if (day.recoveryScore === null || !matches(classifyRecoveryZone(day.recoveryScore))) break;
    streak += 1;
  }
  return streak;
}

function hasHrvDeloadSignal(input: RecoveryModulationInput): boolean {
  return (
    input.hrvRecentAvg !== undefined &&
    input.hrvBaselineAvg !== undefined &&
    input.hrvBaselineAvg > 0 &&
    input.hrvRecentAvg < input.hrvBaselineAvg * HRV_DELOAD_BASELINE_RATIO
  );
}

/**
 * Decide how today's session should be modulated. No data always no-ops to
 * the plan as written — an unworn device is never treated as a zero score.
 */
export function computeRecoveryModulation(
  input: RecoveryModulationInput,
): RecoveryModulationDecision {
  if (input.todayScore === null) {
    return { kind: "none", reason: "no_data", deloadSignal: false };
  }

  const zone = classifyRecoveryZone(input.todayScore);
  const lowStreak = consecutiveDays(zone, input.priorDays, (dayZone) => dayZone !== "green");
  const deloadSignal = lowStreak >= DELOAD_CONSECUTIVE_LOW_DAYS || hasHrvDeloadSignal(input);

  if (zone === "green") {
    return { kind: "none", reason: "green", deloadSignal };
  }
  if (zone === "yellow") {
    return { kind: "hold", zone, dropAccessorySets: 1, deloadSignal };
  }
  const consecutiveRedDays = consecutiveDays(zone, input.priorDays, (dayZone) => dayZone === "red");
  return {
    kind: "reduce",
    zone,
    setScale: RED_DAY_SET_SCALE,
    stripIntensityTechniques: true,
    consecutiveRedDays,
    recommendRecoverySession: consecutiveRedDays >= 2,
    deloadSignal,
  };
}

interface ExerciseShape {
  movementId: string;
  sets: number;
  reps?: number;
  duration?: number;
  spotter?: boolean;
  eccentric?: boolean;
  chains?: boolean;
  burnout?: boolean;
  dropSet?: boolean;
  warmUp?: boolean;
}

interface BlockShape {
  exercises: ExerciseShape[];
}

function isWarmupBlock(block: BlockShape): boolean {
  return block.exercises.some((exercise) => exercise.warmUp === true);
}

function isScalableBlock(block: BlockShape): boolean {
  return (
    !isWarmupBlock(block) && block.exercises.every((exercise) => exercise.sets >= SCALABLE_MIN_SETS)
  );
}

function stripIntensityTechniques(exercise: ExerciseShape): ExerciseShape {
  return {
    ...exercise,
    eccentric: undefined,
    chains: undefined,
    burnout: undefined,
    dropSet: undefined,
  };
}

/**
 * Apply a modulation decision to draft workout blocks. Warmup blocks and
 * cooldown-sized work (fewer than 3 sets) are never reduced; set counts are
 * scaled uniformly within a block so superset partners and injected rest
 * stay in sync.
 */
export function applyRecoveryModulationToBlocks(
  blocks: readonly BlockShape[],
  decision: RecoveryModulationDecision,
): BlockShape[] {
  if (decision.kind === "none") return [...blocks];

  if (decision.kind === "hold") {
    // Drop one set from the final full-sized block: accessories program last.
    let targetIndex = -1;
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      if (isScalableBlock(blocks[index])) {
        targetIndex = index;
        break;
      }
    }
    return blocks.map((block, index) =>
      index === targetIndex
        ? {
            ...block,
            exercises: block.exercises.map((exercise) => ({
              ...exercise,
              sets: exercise.sets - decision.dropAccessorySets,
            })),
          }
        : { ...block },
    );
  }

  return blocks.map((block) => {
    if (isWarmupBlock(block)) return { ...block };
    const scalable = isScalableBlock(block);
    return {
      ...block,
      exercises: block.exercises.map((exercise) => {
        const stripped = stripIntensityTechniques(exercise);
        if (!scalable) return stripped;
        return {
          ...stripped,
          sets: Math.max(RED_DAY_MIN_SETS, Math.round(exercise.sets * decision.setScale)),
        };
      }),
    };
  });
}
