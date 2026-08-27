import { useEffect, useRef, type MouseEvent, type RefObject } from "react";
import { ArrowLeft, MessageCircle, Plug, Plus, RefreshCw, Settings } from "lucide-react";
import { AppSettings } from "@/components/AppSettings";
import { Eyes } from "@/components/Eyes";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EMPTY_CHAT_SUGGESTIONS } from "@/lib/first-use";
import type { FaceShape } from "@/lib/face";
import type { Bot } from "@/lib/session";

export function Welcome({
  onNewBot,
  onPlugins,
  pluginsRef,
  destinationRef,
}: {
  onNewBot: (event: MouseEvent<HTMLButtonElement>) => void;
  onPlugins: () => void;
  pluginsRef: RefObject<HTMLButtonElement | null>;
  destinationRef: RefObject<HTMLElement | null>;
}) {
  return (
    <main
      ref={destinationRef}
      tabIndex={-1}
      className="flex min-h-dvh flex-col bg-background text-foreground outline-none"
    >
      <header className="flex min-h-[var(--header-height)] items-center gap-3 px-5 sm:px-8">
        <Eyes size={32} className="aspect-square shrink-0" />
        <div>
          <p className="text-sm font-semibold">OpenBot</p>
          <p className="text-xs text-muted-foreground">This Computer</p>
        </div>
      </header>
      <Separator />

      <section className="flex flex-1 items-center justify-center px-6 py-12 text-center">
        <div className="flex w-full max-w-md flex-col items-center gap-5">
          <Eyes size={156} />
          <div className="grid gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">Meet OpenBot</h1>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Create a Bot to start a private conversation on this Computer.
            </p>
          </div>
          <Card className="w-full gap-4 py-5 text-left">
            <CardHeader className="gap-2 px-5">
              <CardTitle>Create your first Bot</CardTitle>
              <CardDescription>
                Give it a name now, then choose its AI connection in the new Chat.
              </CardDescription>
            </CardHeader>
            <CardFooter className="px-5">
              <Button
                type="button"
                size="lg"
                onClick={onNewBot}
                className="min-h-[var(--touch-min)]"
              >
                <Plus />
                New Bot
              </Button>
            </CardFooter>
          </Card>
        </div>
      </section>

      <footer className="flex min-h-[var(--header-height)] items-center justify-center gap-2 border-t px-4">
        <Button
          ref={pluginsRef}
          type="button"
          variant="ghost"
          onClick={onPlugins}
          className="min-h-[var(--touch-min)]"
        >
          <Plug />
          Plugins
        </Button>
        <AppSettings className="w-auto" />
      </footer>
    </main>
  );
}

export function LoadingHome({ destinationRef }: { destinationRef: RefObject<HTMLElement | null> }) {
  return (
    <main
      ref={destinationRef}
      tabIndex={-1}
      className="flex min-h-dvh flex-col bg-background text-foreground outline-none"
      aria-busy="true"
    >
      <header className="flex min-h-[var(--header-height)] items-center gap-3 px-5 sm:px-8">
        <Eyes size={32} className="aspect-square shrink-0" />
        <div>
          <p className="text-sm font-semibold">OpenBot</p>
          <p className="text-xs text-muted-foreground">This Computer</p>
        </div>
      </header>
      <Separator />
      <p className="sr-only" role="status">Loading Chats…</p>
    </main>
  );
}

export function BotsLoadError({
  onRetry,
  destinationRef,
}: {
  onRetry: () => void;
  destinationRef: RefObject<HTMLElement | null>;
}) {
  return (
    <main
      ref={destinationRef}
      tabIndex={-1}
      className="flex min-h-dvh items-center justify-center bg-background px-6 py-12 text-center text-foreground outline-none"
    >
      <div className="flex max-w-sm flex-col items-center gap-5">
        <Eyes size={112} />
        <div className="grid gap-2">
          <h1 className="text-xl font-semibold tracking-tight">Could not load Bots</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            OpenBot could not read this Computer right now.
          </p>
        </div>
        <Button type="button" onClick={onRetry} className="min-h-[var(--touch-min)]">
          <RefreshCw />
          Retry
        </Button>
      </div>
    </main>
  );
}

export function ChatDetailLoading({ bot }: { bot: Bot }) {
  return (
    <div
      className="flex min-h-0 flex-1 items-center justify-center px-6 py-12 text-center"
      aria-busy="true"
    >
      <div className="flex flex-col items-center gap-3">
        <Eyes
          name={bot.name}
          color={bot.eyes.color}
          shape={bot.eyes.shape as FaceShape}
          size={72}
        />
        <p className="text-sm text-muted-foreground" role="status">
          Opening Chat…
        </p>
      </div>
    </div>
  );
}

export function ChatDetailError({ bot, onRetry }: { bot: Bot; onRetry: () => void }) {
  return (
    <div
      className="flex min-h-0 flex-1 items-center justify-center px-6 py-12 text-center"
      role="alert"
    >
      <div className="flex max-w-sm flex-col items-center gap-4">
        <Eyes
          name={bot.name}
          color={bot.eyes.color}
          shape={bot.eyes.shape as FaceShape}
          size={72}
        />
        <div className="grid gap-1">
          <h2 className="text-lg font-semibold">Could not open Chat</h2>
          <p className="text-sm text-muted-foreground">OpenBot could not read this conversation right now.</p>
        </div>
        <Button type="button" onClick={onRetry} className="min-h-[var(--touch-min)]">
          <RefreshCw />
          Retry
        </Button>
      </div>
    </div>
  );
}

export function Plugins({ onBack }: { onBack: () => void }) {
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => headingRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  return (
    <main className="flex min-h-dvh flex-col bg-background text-foreground">
      <header className="flex min-h-[var(--header-height)] items-center gap-3 px-4 sm:px-6">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="Back to Chat"
              onClick={onBack}
              className="min-h-[var(--touch-min)] min-w-[var(--touch-min)]"
            >
              <ArrowLeft />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Back to Chat</TooltipContent>
        </Tooltip>
        <h1 ref={headingRef} tabIndex={-1} className="text-sm font-semibold outline-none">
          Plugins
        </h1>
      </header>
      <Separator />
      <section className="flex flex-1 items-center justify-center px-6 py-12 text-center">
        <div className="flex max-w-sm flex-col items-center gap-4">
          <div className="flex size-14 items-center justify-center rounded-[var(--radius-card)] bg-muted text-muted-foreground">
            <Plug aria-hidden="true" className="size-6 [stroke-width:var(--icon-stroke)]" />
          </div>
          <p className="text-base font-medium">Plugins are coming soon.</p>
        </div>
      </section>
    </main>
  );
}

export function EmptyChatStart({
  bot,
  onSuggestion,
  onOpenSettings,
}: {
  bot: Bot;
  onSuggestion: (text: string) => void;
  onOpenSettings: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 overflow-y-auto px-5 py-8">
      <div className="m-auto flex w-full max-w-2xl flex-col items-center gap-6 text-center">
        <Eyes
          name={bot.name}
          color={bot.eyes.color}
          shape={bot.eyes.shape as FaceShape}
          size={112}
        />
        <div className="grid gap-1">
          <h2 className="text-xl font-semibold">Start a conversation with {bot.name}</h2>
          <p className="text-sm text-muted-foreground">
            {bot.harness
              ? "Choose a suggestion or write your own message."
              : "Connect an AI before you send your first message."}
          </p>
        </div>

        {!bot.harness ? (
          <Card className="w-full max-w-lg gap-4 py-5 text-left" data-testid="bot-setup-card">
            <CardHeader className="gap-2 px-5">
              <CardTitle className="flex items-center gap-2 text-base">
                <Settings
                  aria-hidden="true"
                  className="size-[var(--icon-default)] [stroke-width:var(--icon-stroke)]"
                />
                Choose an AI connection
              </CardTitle>
              <CardDescription>
                Open Bot Settings to connect Codex before you send your first message.
              </CardDescription>
            </CardHeader>
            <CardFooter className="px-5">
              <Button type="button" size="sm" onClick={onOpenSettings} className="min-h-[var(--touch-min)]">
                Open Bot Settings
              </Button>
            </CardFooter>
          </Card>
        ) : (
          <div className="flex flex-wrap justify-center gap-2" aria-label="Conversation suggestions">
            {EMPTY_CHAT_SUGGESTIONS.map((suggestion) => (
              <Button
                key={suggestion}
                type="button"
                variant="outline"
                onClick={() => onSuggestion(suggestion)}
                className="h-auto min-h-[var(--touch-min)] max-w-full whitespace-normal px-4 py-2 text-left"
              >
                <MessageCircle aria-hidden="true" />
                {suggestion}
              </Button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
