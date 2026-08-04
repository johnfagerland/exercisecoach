"use client";

import { useAction } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useActionData } from "@/hooks/useActionData";

export function useWhoopFeatureStatus() {
  return useActionData(useAction(api.whoop.connections.getWhoopFeatureStatus));
}
