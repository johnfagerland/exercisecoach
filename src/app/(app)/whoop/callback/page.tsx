import { Suspense } from "react";
import { Loader2 } from "lucide-react";
import { WhoopCallbackContent } from "./WhoopCallbackContent";

export default function WhoopCallbackPage() {
  return (
    <Suspense
      fallback={
        <div
          className="flex min-h-[40vh] flex-col items-center justify-center gap-3 text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          <Loader2 className="size-6 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          <p className="text-sm">Linking your Whoop account…</p>
        </div>
      }
    >
      <WhoopCallbackContent />
    </Suspense>
  );
}
