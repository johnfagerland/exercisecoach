import { z } from "zod";

const TIMEZONE_OFFSET_PATTERN = /^([+-])(\d{2}):(\d{2})$/;

const recoveryRecordSchema = z
  .object({
    cycle_id: z.number().int(),
    sleep_id: z.string().min(1),
    user_id: z.number().int(),
    score_state: z.string().min(1),
    score: z
      .object({
        user_calibrating: z.boolean().optional(),
        recovery_score: z.number().finite().optional(),
        resting_heart_rate: z.number().finite().optional(),
        hrv_rmssd_milli: z.number().finite().optional(),
        spo2_percentage: z.number().finite().optional(),
        skin_temp_celsius: z.number().finite().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const sleepRecordSchema = z
  .object({
    id: z.string().min(1),
    user_id: z.number().int(),
    start: z.string().min(1),
    end: z.string().min(1),
    timezone_offset: z.string().optional(),
    nap: z.boolean(),
    score_state: z.string().min(1),
    score: z
      .object({
        stage_summary: z
          .object({
            total_in_bed_time_milli: z.number().finite().optional(),
            total_awake_time_milli: z.number().finite().optional(),
            total_light_sleep_time_milli: z.number().finite().optional(),
            total_slow_wave_sleep_time_milli: z.number().finite().optional(),
            total_rem_sleep_time_milli: z.number().finite().optional(),
            sleep_cycle_count: z.number().finite().optional(),
            disturbance_count: z.number().finite().optional(),
          })
          .passthrough()
          .optional(),
        respiratory_rate: z.number().finite().optional(),
        sleep_performance_percentage: z.number().finite().optional(),
        sleep_consistency_percentage: z.number().finite().optional(),
        sleep_efficiency_percentage: z.number().finite().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const cycleRecordSchema = z
  .object({
    id: z.number().int(),
    user_id: z.number().int(),
    start: z.string().min(1),
    end: z.string().nullable().optional(),
    timezone_offset: z.string().optional(),
    score_state: z.string().min(1),
    score: z
      .object({
        strain: z.number().finite().optional(),
        kilojoule: z.number().finite().optional(),
        average_heart_rate: z.number().finite().optional(),
        max_heart_rate: z.number().finite().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export interface WhoopRecoveryRow {
  calendarDate: string;
  sleepId: string;
  cycleId: number;
  timezoneOffset?: string;
  scoreState: string;
  userCalibrating?: boolean;
  recoveryScore?: number;
  hrvRmssdMilli?: number;
  restingHeartRate?: number;
  spo2Percentage?: number;
  skinTempCelsius?: number;
  rawJson: string;
}

export interface WhoopSleepRow {
  calendarDate: string;
  sleepId: string;
  start: string;
  end: string;
  timezoneOffset?: string;
  nap: boolean;
  scoreState: string;
  sleepPerformancePercentage?: number;
  sleepEfficiencyPercentage?: number;
  sleepConsistencyPercentage?: number;
  respiratoryRate?: number;
  totalInBedTimeMilli?: number;
  totalAwakeTimeMilli?: number;
  totalLightSleepTimeMilli?: number;
  totalSlowWaveSleepTimeMilli?: number;
  totalRemSleepTimeMilli?: number;
  sleepCycleCount?: number;
  disturbanceCount?: number;
  rawJson: string;
}

export interface WhoopCycleRow {
  calendarDate: string;
  cycleId: number;
  start: string;
  end?: string;
  timezoneOffset?: string;
  scoreState: string;
  strain?: number;
  kilojoule?: number;
  averageHeartRate?: number;
  maxHeartRate?: number;
  rawJson: string;
}

/**
 * Calendar date of an instant in the timezone Whoop reported for the record
 * (offset like "-05:00"). Malformed offsets fall back to the UTC date.
 */
export function whoopLocalCalendarDate(isoInstant: string, timezoneOffset?: string): string | null {
  const instantMs = Date.parse(isoInstant);
  if (Number.isNaN(instantMs)) return null;
  const match = timezoneOffset ? TIMEZONE_OFFSET_PATTERN.exec(timezoneOffset) : null;
  const offsetMs = match
    ? (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) * 60 * 1000
    : 0;
  return new Date(instantMs + offsetMs).toISOString().slice(0, 10);
}

function compactRow<T extends Record<string, unknown>>(row: T): T {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined)) as T;
}

/** Parse Whoop sleep records, dropping malformed entries rather than failing the batch. */
export function normalizeWhoopSleeps(records: readonly unknown[]): WhoopSleepRow[] {
  const rows: WhoopSleepRow[] = [];
  for (const record of records) {
    const parsed = sleepRecordSchema.safeParse(record);
    if (!parsed.success) continue;
    const sleep = parsed.data;
    // Attribute the night's sleep to the wake-up day.
    const calendarDate = whoopLocalCalendarDate(sleep.end, sleep.timezone_offset);
    if (!calendarDate) continue;
    const stages = sleep.score?.stage_summary;
    rows.push(
      compactRow({
        calendarDate,
        sleepId: sleep.id,
        start: sleep.start,
        end: sleep.end,
        timezoneOffset: sleep.timezone_offset,
        nap: sleep.nap,
        scoreState: sleep.score_state,
        sleepPerformancePercentage: sleep.score?.sleep_performance_percentage,
        sleepEfficiencyPercentage: sleep.score?.sleep_efficiency_percentage,
        sleepConsistencyPercentage: sleep.score?.sleep_consistency_percentage,
        respiratoryRate: sleep.score?.respiratory_rate,
        totalInBedTimeMilli: stages?.total_in_bed_time_milli,
        totalAwakeTimeMilli: stages?.total_awake_time_milli,
        totalLightSleepTimeMilli: stages?.total_light_sleep_time_milli,
        totalSlowWaveSleepTimeMilli: stages?.total_slow_wave_sleep_time_milli,
        totalRemSleepTimeMilli: stages?.total_rem_sleep_time_milli,
        sleepCycleCount: stages?.sleep_cycle_count,
        disturbanceCount: stages?.disturbance_count,
        rawJson: JSON.stringify(record),
      }),
    );
  }
  return rows;
}

export function normalizeWhoopCycles(records: readonly unknown[]): WhoopCycleRow[] {
  const rows: WhoopCycleRow[] = [];
  for (const record of records) {
    const parsed = cycleRecordSchema.safeParse(record);
    if (!parsed.success) continue;
    const cycle = parsed.data;
    const calendarDate = whoopLocalCalendarDate(cycle.start, cycle.timezone_offset);
    if (!calendarDate) continue;
    rows.push(
      compactRow({
        calendarDate,
        cycleId: cycle.id,
        start: cycle.start,
        end: cycle.end ?? undefined,
        timezoneOffset: cycle.timezone_offset,
        scoreState: cycle.score_state,
        strain: cycle.score?.strain,
        kilojoule: cycle.score?.kilojoule,
        averageHeartRate: cycle.score?.average_heart_rate,
        maxHeartRate: cycle.score?.max_heart_rate,
        rawJson: JSON.stringify(record),
      }),
    );
  }
  return rows;
}

/**
 * Parse Whoop recovery records. A recovery carries no timestamp of its own, so
 * its calendar date comes from the owning cycle (fallback: the scored sleep's
 * wake date). Recoveries whose cycle and sleep are both absent are dropped —
 * the next sync window that includes the cycle will pick them up.
 */
export function normalizeWhoopRecoveries(
  records: readonly unknown[],
  cyclesById: ReadonlyMap<number, WhoopCycleRow>,
  sleepsById: ReadonlyMap<string, WhoopSleepRow>,
): WhoopRecoveryRow[] {
  const rows: WhoopRecoveryRow[] = [];
  for (const record of records) {
    const parsed = recoveryRecordSchema.safeParse(record);
    if (!parsed.success) continue;
    const recovery = parsed.data;
    const cycle = cyclesById.get(recovery.cycle_id);
    const sleep = sleepsById.get(recovery.sleep_id);
    const source = cycle ?? sleep;
    if (!source) continue;
    rows.push(
      compactRow({
        calendarDate: source.calendarDate,
        sleepId: recovery.sleep_id,
        cycleId: recovery.cycle_id,
        timezoneOffset: source.timezoneOffset,
        scoreState: recovery.score_state,
        userCalibrating: recovery.score?.user_calibrating,
        recoveryScore: recovery.score?.recovery_score,
        hrvRmssdMilli: recovery.score?.hrv_rmssd_milli,
        restingHeartRate: recovery.score?.resting_heart_rate,
        spo2Percentage: recovery.score?.spo2_percentage,
        skinTempCelsius: recovery.score?.skin_temp_celsius,
        rawJson: JSON.stringify(record),
      }),
    );
  }
  return rows;
}
