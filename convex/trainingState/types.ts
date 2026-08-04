export type RecoveryProviderSource = "garmin" | "fitbit" | "whoop";
export type RecoverySource = RecoveryProviderSource | "manual";
export type RecoveryStatus = "unknown" | "normal" | "caution";
export type RecoveryConfidence = "low" | "medium" | "high";

export type RecoveryReason =
  | "no_fresh_data"
  | "short_sleep"
  | "low_hrv_status"
  | "low_body_battery"
  | "low_recovery_score"
  | "low_energy"
  | "high_soreness";

export interface RecoveryObservation {
  source: RecoveryProviderSource;
  calendarDate: string;
  ingestedAt: number;
  sleepDurationSeconds?: number;
  sleepScore?: number;
  hrvMilliseconds?: number;
  hrvStatus?: string;
  avgStress?: number;
  bodyBatteryHighestValue?: number;
  bodyBatteryLowestValue?: number;
  restingHeartRate?: number;
  avgSpo2?: number;
  avgRespirationRate?: number;
  skinTempDeviationCelsius?: number;
  /** Whoop 0-100 recovery score. */
  recoveryScorePercent?: number;
  /** Whoop 0-100 sleep performance. */
  sleepPerformancePercent?: number;
  /** Whoop 0-21 day strain. */
  dayStrain?: number;
}

export interface RecoveryCheckInSignal {
  calendarDate: string;
  energy: number;
  soreness: number;
  stress: number;
  notes?: string;
  updatedAt: number;
}

export interface RecoveryInputs {
  preferredSource: RecoveryProviderSource | null;
  observations: readonly RecoveryObservation[];
  checkIns: readonly RecoveryCheckInSignal[];
}

export interface RecoveryMetrics {
  sleepHours?: number;
  sleepScore?: number;
  hrvMilliseconds?: number;
  hrvStatus?: string;
  avgStress?: number;
  bodyBatteryHighestValue?: number;
  bodyBatteryLowestValue?: number;
  restingHeartRate?: number;
  avgSpo2?: number;
  avgRespirationRate?: number;
  skinTempDeviationCelsius?: number;
  recoveryScorePercent?: number;
  sleepPerformancePercent?: number;
  dayStrain?: number;
  energy?: number;
  soreness?: number;
  stress?: number;
}

export interface RecoveryState {
  status: RecoveryStatus;
  confidence: RecoveryConfidence;
  source: RecoverySource | null;
  observedDate: string | null;
  reasons: readonly RecoveryReason[];
  metrics: RecoveryMetrics;
  checkIn: RecoveryCheckInSignal | null;
  history: readonly RecoveryObservation[];
}
