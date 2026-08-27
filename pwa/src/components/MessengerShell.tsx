import type { ReactNode, RefObject } from "react";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

export type MobileSurface = "sidebar" | "chat";

export function MessengerShell({
  sidebar,
  chat,
  chatRef,
  computer,
  mobileSurface,
}: {
  sidebar: ReactNode;
  chat: ReactNode;
  chatRef: RefObject<HTMLElement | null>;
  computer: ReactNode | null;
  mobileSurface: MobileSurface;
}) {
  const computerVisible = computer !== null;

  return (
    <div data-testid="messenger" className="flex h-full min-h-0 bg-background">
      <aside
        aria-label="Chats"
        data-testid="sidebar-region"
        className={cn(
          "flex w-[min(var(--sidebar-width),28vw)] shrink-0 flex-col bg-sidebar text-sidebar-foreground",
          "max-[47.999rem]:w-full",
          (mobileSurface === "chat" || computerVisible) && "max-[47.999rem]:hidden",
        )}
      >
        {sidebar}
      </aside>

      <Separator orientation="vertical" className="max-[47.999rem]:hidden" />

      <main
        ref={chatRef}
        tabIndex={-1}
        aria-label="Chat"
        data-testid="chat-region"
        className={cn(
          "flex min-w-0 flex-1 flex-col outline-none",
          (mobileSurface === "sidebar" || computerVisible) && "max-[47.999rem]:hidden",
        )}
      >
        {chat}
      </main>

      {computerVisible ? (
        <>
          <Separator orientation="vertical" className="max-[47.999rem]:hidden" />
          <aside
            aria-label="Computer"
            data-testid="computer-region"
            className="flex w-[min(var(--computer-pane-width),28vw)] shrink-0 flex-col bg-surface max-[47.999rem]:w-full"
          >
            {computer}
          </aside>
        </>
      ) : null}
    </div>
  );
}
