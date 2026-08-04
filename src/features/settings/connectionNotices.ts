/**
 * Query-param → connection-card notice mapping for the settings page,
 * split out for file-size hygiene. Reasons are matched against the fixed
 * set each OAuth callback emits; anything else falls to a generic message.
 */

import type { GarminConnectionNotice } from "./GarminConnectionCard";
import type { FitbitConnectionNotice } from "./FitbitConnectionCard";
import type { StravaConnectionNotice } from "./StravaConnectionCard";
import type { WhoopConnectionNotice } from "./WhoopConnectionCard";

export function garminNoticeFromParams(
  param: string | null,
  reason: string | null,
): GarminConnectionNotice | undefined {
  if (param === "connected") return { kind: "success", message: "Garmin connected." };
  if (param !== "error") return undefined;
  return {
    kind: "error",
    message: `Garmin connection failed${reason ? `: ${reason.replaceAll("_", " ")}` : "."}`,
  };
}

export function fitbitNoticeFromParams(
  param: string | null,
  reason: string | null,
): FitbitConnectionNotice | undefined {
  if (param === "connected") {
    return { kind: "success", message: "Fitbit connected. Your first sync is starting." };
  }
  if (param !== "error") return undefined;
  const message =
    reason === "access_denied"
      ? "Fitbit connection was canceled."
      : reason === "missing_params"
        ? "Fitbit connection failed because the authorization response was incomplete. Please try again."
        : reason === "oauth_error"
          ? "Fitbit connection failed while completing authorization. Please try again."
          : "Fitbit connection failed. Please try again.";
  return { kind: "error", message };
}

export function stravaNoticeFromParams(
  param: string | null,
  reason: string | null,
): StravaConnectionNotice | undefined {
  if (param === "connected") {
    return { kind: "success", message: "Strava connected. Your first sync is starting." };
  }
  if (param !== "error") return undefined;
  const message =
    reason === "access_denied"
      ? "Strava connection was canceled."
      : reason === "missing_params"
        ? "Strava connection failed because the authorization response was incomplete. Please try again."
        : "Strava connection failed. Please try again.";
  return { kind: "error", message };
}

export function whoopNoticeFromParams(
  param: string | null,
  reason: string | null,
): WhoopConnectionNotice | undefined {
  if (param === "connected") {
    return { kind: "success", message: "Whoop connected. Your first sync is starting." };
  }
  if (param !== "error") return undefined;
  const message =
    reason === "access_denied"
      ? "Whoop connection was canceled."
      : reason === "missing_params"
        ? "Whoop connection failed because the authorization response was incomplete. Please try again."
        : reason === "oauth_error"
          ? "Whoop connection failed while completing authorization. Please try again."
          : "Whoop connection failed. Please try again.";
  return { kind: "error", message };
}
