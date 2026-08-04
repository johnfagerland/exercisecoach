"use client";

import Link from "next/link";
import { Link2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

type WhoopConsentState = "ready" | "unavailable" | "connecting";

interface WhoopConsentDialogProps {
  state: WhoopConsentState;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onContinue: () => void;
}

export function WhoopConsentDialog({
  state,
  open,
  onOpenChange,
  onContinue,
}: WhoopConsentDialogProps) {
  const connecting = state === "connecting";

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!connecting) onOpenChange(nextOpen);
      }}
    >
      <DialogTrigger
        render={
          <Button
            size="sm"
            className="min-h-11 gap-1.5 sm:min-h-7 sm:min-w-36"
            disabled={state !== "ready"}
          />
        }
      >
        {connecting ? (
          <Loader2
            className="size-3.5 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
        ) : (
          <Link2 className="size-3.5" aria-hidden="true" />
        )}
        {connecting ? "Connecting…" : "Connect Whoop"}
      </DialogTrigger>

      <DialogContent
        showCloseButton={false}
        aria-busy={connecting}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto motion-reduce:duration-0 motion-reduce:data-open:animate-none motion-reduce:data-closed:animate-none sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>Connect Whoop to Roni?</DialogTitle>
          <DialogDescription>
            Review how Roni uses your Whoop data before continuing to Whoop.
          </DialogDescription>
        </DialogHeader>

        <ul className="list-disc space-y-2 pl-5 text-sm text-muted-foreground">
          <li>
            Roni requests read-only access to the recovery, sleep, and strain (cycle) data recorded
            by your Whoop membership. Data flows one way; Roni never writes to Whoop.
          </li>
          <li>Syncs include up to 30 days of recent data.</li>
          <li>
            Roni and its Gemini coach use these summaries to personalize coaching. Convex, Vercel,
            and Google AI process the data to provide the service.
          </li>
          <li>Whoop data is not sold or used for advertising.</li>
          <li>
            You may grant only a subset of access; recovery access is required for the connection.
            Roni adapts based on the data you allow.
          </li>
          <li>
            Disconnecting asks Whoop to revoke access and starts removing imported Whoop data. You
            can also revoke access in your Whoop account. Deleting your Roni account removes stored
            Whoop connection and imported data and asks Whoop to revoke access.
          </li>
        </ul>

        <Link
          href="/privacy"
          className="inline-flex min-h-11 items-center self-start text-sm font-medium text-primary underline underline-offset-2 hover:text-primary/80"
        >
          Read the Privacy Policy
        </Link>

        <DialogFooter>
          <DialogClose
            disabled={connecting}
            render={<Button variant="outline" className="min-h-11" />}
          >
            Cancel
          </DialogClose>
          <Button className="min-h-11" disabled={connecting} onClick={onContinue}>
            {connecting ? (
              <Loader2
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : null}
            {connecting ? "Opening Whoop…" : "Continue to Whoop"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
