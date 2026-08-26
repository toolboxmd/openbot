import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  HOST_GRANT_ACCESS,
  HOST_GRANT_DURATIONS,
  type HostGrantAccessId,
  type HostGrantDurationId,
  type HostGrantPrompt,
} from "@/lib/harness-home";

export function HostGrantCard({
  grant,
  busy,
  onAnswer,
}: {
  grant: HostGrantPrompt;
  busy?: boolean;
  onAnswer: (access: HostGrantAccessId, duration: HostGrantDurationId) => void;
}) {
  const [duration, setDuration] = useState<HostGrantDurationId>("session");
  return (
    <div data-testid="host-grant-card" className="mx-auto mt-3 w-full max-w-2xl rounded-2xl bg-secondary p-4 text-sm">
      <p className="font-medium">Host grant</p>
      <p className="mt-1 text-muted-foreground">
        This Bot wants a path on this PC outside Workspace.
      </p>
      <p className="mt-2 break-all font-mono text-xs">{grant.path}</p>
      <fieldset className="mt-3">
        <legend className="mb-1 text-xs text-muted-foreground">How long</legend>
        <div className="flex flex-wrap gap-3">
          {HOST_GRANT_DURATIONS.map((item) => (
            <label key={item.id} className="flex items-center gap-1.5 text-sm">
              <input
                type="radio"
                name="host-grant-duration"
                data-testid={`host-grant-duration-${item.id}`}
                checked={duration === item.id}
                onChange={() => setDuration(item.id)}
              />
              {item.label}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="mt-3 flex flex-wrap gap-2">
        {HOST_GRANT_ACCESS.map((item) => (
          <Button
            key={item.id}
            type="button"
            size="sm"
            data-testid={`host-grant-${item.id}`}
            variant={item.id === "deny" ? "outline" : "default"}
            disabled={busy}
            onClick={() => onAnswer(item.id, duration)}
          >
            {item.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
