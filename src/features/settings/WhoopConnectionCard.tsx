"use client";

import { useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { WhoopConsentDialog } from "@/features/settings/WhoopConsentDialog";
import {
  type WhoopConnectionNotice,
  WhoopStatusMessage,
} from "@/features/settings/WhoopStatusMessage";
import { Loader2, RefreshCw, Unlink } from "lucide-react";

export type { WhoopConnectionNotice } from "@/features/settings/WhoopStatusMessage";

type WhoopAction = "connect" | "sync" | "disconnect" | null;

const WHOOP_SCOPE_LABELS: Readonly<Record<string, string>> = {
  "read:recovery": "Recovery",
  "read:sleep": "Sleep",
  "read:cycles": "Strain & cycles",
  "read:profile": "Profile",
};

const DISCONNECT_REASON_LABELS = {
  permission_revoked: "Permission revoked",
  token_invalid: "Authorization expired",
  user_disconnected: "Disconnected by you",
} as const;

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function formatDateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

interface WhoopConnectionCardProps {
  configured: boolean;
  callbackNotice?: WhoopConnectionNotice;
}

export function WhoopConnectionCard({ configured, callbackNotice }: WhoopConnectionCardProps) {
  const status = useQuery(api.whoop.connections.getMyWhoopStatus, {});
  const startOAuth = useAction(api.whoop.oauthFlow.startWhoopOAuth);
  const refreshWhoopData = useAction(api.whoop.sync.refreshWhoopData);
  const disconnectWhoop = useAction(api.whoop.sync.disconnectMyWhoop);

  const [activeAction, setActiveAction] = useState<WhoopAction>(null);
  const [consentOpen, setConsentOpen] = useState(false);
  const [message, setMessage] = useState<WhoopConnectionNotice | null>(null);
  const busy = activeAction !== null;

  const handleConnect = async () => {
    setActiveAction("connect");
    setMessage(null);
    try {
      const result = await startOAuth({});
      if (!result.success) {
        setMessage({ kind: "error", message: result.error });
        setActiveAction(null);
        setConsentOpen(false);
        return;
      }
      window.location.href = result.authorizeUrl;
    } catch (error) {
      setMessage({
        kind: "error",
        message: error instanceof Error ? error.message : "Failed to start Whoop connection.",
      });
      setActiveAction(null);
      setConsentOpen(false);
    }
  };

  const handleSync = async () => {
    setActiveAction("sync");
    setMessage(null);
    try {
      const result = await refreshWhoopData({});
      if (!result.success) {
        setMessage({ kind: "error", message: result.error });
        return;
      }
      setMessage({
        kind: "success",
        message: `Whoop synced ${pluralize(result.recoveries, "recovery", "recoveries")}, ${pluralize(result.sleeps, "sleep")}, and ${pluralize(result.cycles, "cycle")}.`,
      });
    } catch (error) {
      setMessage({
        kind: "error",
        message: error instanceof Error ? error.message : "Whoop sync failed.",
      });
    } finally {
      setActiveAction(null);
    }
  };

  const handleDisconnect = async () => {
    setActiveAction("disconnect");
    setMessage(null);
    try {
      const result = await disconnectWhoop({});
      if (!result.success) {
        setMessage({ kind: "error", message: result.error });
        return;
      }
      const cleanupMessage = "Local imported Whoop data is being removed.";
      setMessage({
        kind: result.warning ? "warning" : "success",
        message: result.warning
          ? `Whoop disconnected. ${cleanupMessage} ${result.warning}`
          : `Whoop disconnected. ${cleanupMessage}`,
      });
    } catch (error) {
      setMessage({
        kind: "error",
        message: error instanceof Error ? error.message : "Failed to disconnect Whoop.",
      });
    } finally {
      setActiveAction(null);
    }
  };

  const visibleMessage = message ?? callbackNotice ?? null;

  if (status === undefined) {
    return (
      <Card>
        <CardContent
          className="flex items-center gap-2 p-4 text-sm text-muted-foreground"
          role="status"
          aria-busy="true"
        >
          <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          Loading Whoop status…
        </CardContent>
      </Card>
    );
  }

  const scopeLabels =
    status.state === "none"
      ? []
      : Array.from(
          new Set(status.scopes.map((scope) => WHOOP_SCOPE_LABELS[scope]).filter(Boolean)),
        );

  return (
    <Card>
      <CardContent className="p-4">
        {status.state === "active" ? (
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium text-foreground">Connected</p>
                <Badge variant="secondary">Whoop</Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                Connected {formatDate(status.connectedAt)}
              </p>
              {status.lastSyncedAt ? (
                <p className="text-sm text-muted-foreground">
                  Last synced {formatDateTime(status.lastSyncedAt)}
                </p>
              ) : null}
              {scopeLabels.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Whoop data access">
                  {scopeLabels.map((scope) => (
                    <Badge key={scope} variant="outline">
                      {scope}
                    </Badge>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-col gap-2 sm:min-w-36">
              <Button
                variant="outline"
                size="sm"
                className="min-h-11 w-full gap-1.5 sm:min-h-7"
                disabled={busy || !configured}
                onClick={handleSync}
              >
                {activeAction === "sync" ? (
                  <Loader2
                    className="size-3.5 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                ) : (
                  <RefreshCw className="size-3.5" aria-hidden="true" />
                )}
                {activeAction === "sync" ? "Syncing…" : "Sync now"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="min-h-11 w-full gap-1.5 sm:min-h-7"
                disabled={busy}
                onClick={handleDisconnect}
              >
                {activeAction === "disconnect" ? (
                  <Loader2
                    className="size-3.5 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                ) : (
                  <Unlink className="size-3.5" aria-hidden="true" />
                )}
                {activeAction === "disconnect" ? "Disconnecting…" : "Disconnect"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium text-foreground">
                  {status.state === "disconnected" ? "Disconnected" : "Not connected"}
                </p>
                <Badge variant="outline">Whoop</Badge>
              </div>
              {status.state === "disconnected" ? (
                <p className="text-sm text-muted-foreground">
                  Disconnected {formatDate(status.disconnectedAt)} (
                  {DISCONNECT_REASON_LABELS[status.reason]})
                </p>
              ) : null}
              <p className="mt-1 text-sm text-muted-foreground">
                Sync recovery, sleep, and strain from your Whoop membership into Roni. Data flows
                one way from Whoop; Roni never writes back.
              </p>
            </div>
            <WhoopConsentDialog
              state={
                !configured ? "unavailable" : activeAction === "connect" ? "connecting" : "ready"
              }
              open={consentOpen}
              onOpenChange={setConsentOpen}
              onContinue={handleConnect}
            />
          </div>
        )}

        {!configured ? (
          <WhoopStatusMessage
            notice={{
              kind: "warning",
              message:
                status.state === "active"
                  ? "Whoop sync is unavailable because this deployment is no longer configured. You can still disconnect."
                  : "Whoop connection is unavailable because this deployment is not configured.",
            }}
          />
        ) : null}
        {status.state === "active" && status.lastSyncError ? (
          <WhoopStatusMessage
            notice={{ kind: "warning", message: `Last sync failed: ${status.lastSyncError}` }}
          />
        ) : null}
        {visibleMessage ? <WhoopStatusMessage notice={visibleMessage} /> : null}
      </CardContent>
    </Card>
  );
}
