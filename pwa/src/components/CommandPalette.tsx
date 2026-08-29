import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { Bot, MessageSquare, Monitor, Plug, Plus, Search, Settings } from "lucide-react";
import { Button } from "./ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog.tsx";
import { Input } from "./ui/input.tsx";
import type { ChatInboxRow } from "../lib/chat-inbox.ts";
import { cn } from "../lib/utils.ts";
import {
  commandPaletteAnnouncement,
  commandPaletteResults,
  commandPaletteShortcutMatches,
  moveCommandPaletteSelection,
  restoreCommandPaletteFocus,
  type CommandPaletteAction,
  type CommandPaletteResult,
  type FocusableTarget,
} from "./command-palette-state.ts";

export * from "./command-palette-state.ts";

function ResultIcon({ result }: { result: CommandPaletteResult }) {
  if (result.kind === "chat") return <MessageSquare aria-hidden="true" />;
  if (result.action.id === "new-bot") return <Plus aria-hidden="true" />;
  if (result.action.id === "app-settings") return <Settings aria-hidden="true" />;
  if (result.action.id === "bot-settings") return <Bot aria-hidden="true" />;
  if (result.action.id === "plugins") return <Plug aria-hidden="true" />;
  return <Monitor aria-hidden="true" />;
}

export function CommandPaletteBody({
  query,
  results,
  activeIndex,
  onQueryChange,
  onActiveIndexChange,
  onSelect,
}: {
  query: string;
  results: CommandPaletteResult[];
  activeIndex: number;
  onQueryChange: (query: string) => void;
  onActiveIndexChange: (index: number) => void;
  onSelect: (result: CommandPaletteResult) => void;
}) {
  const selectedIndex = results.length === 0
    ? -1
    : Math.min(Math.max(activeIndex, 0), results.length - 1);
  const activeResult = selectedIndex >= 0 ? results[selectedIndex] : undefined;

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      onActiveIndexChange(moveCommandPaletteSelection(
        selectedIndex,
        event.key === "ArrowDown" ? 1 : -1,
        results.length,
      ));
      return;
    }
    if (event.key === "Enter" && activeResult) {
      event.preventDefault();
      onSelect(activeResult);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative shrink-0 border-b border-border">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-4 top-1/2 size-[var(--icon-default)] -translate-y-1/2 text-muted-foreground"
        />
        <Input
          autoFocus
          role="combobox"
          type="search"
          value={query}
          aria-label="Search commands and Chats"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls="command-palette-results"
          aria-activedescendant={selectedIndex >= 0 ? `command-palette-option-${selectedIndex}` : undefined}
          placeholder="Search commands and Chats"
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={onKeyDown}
          className="h-14 rounded-none border-0 bg-transparent pl-12 pr-14 text-base shadow-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        />
      </div>

      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {commandPaletteAnnouncement(results.length)}
      </p>

      <div
        id="command-palette-results"
        role="listbox"
        aria-label="Command palette results"
        className="min-h-0 max-h-[min(60dvh,30rem)] overflow-y-auto overscroll-contain p-2 max-[47.999rem]:max-h-none max-[47.999rem]:flex-1"
      >
        {results.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">No results.</p>
        ) : results.map((result, index) => {
          const selected = index === selectedIndex;
          return (
            <Button
              key={result.id}
              id={`command-palette-option-${index}`}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={selected}
              variant="ghost"
              data-command-palette-result={result.id}
              onPointerDown={(event) => event.preventDefault()}
              onPointerMove={() => onActiveIndexChange(index)}
              onClick={() => onSelect(result)}
              className={cn(
                "h-auto min-h-[var(--touch-min)] w-full min-w-0 justify-start gap-3 rounded-[var(--radius-control)] px-3 py-2 text-left whitespace-normal focus-visible:ring-2 focus-visible:ring-ring",
                selected && "bg-muted",
              )}
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-background text-muted-foreground [&_svg]:size-[var(--icon-default)]">
                <ResultIcon result={result} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{result.label}</span>
                <span className="block truncate text-xs font-normal text-muted-foreground">{result.detail}</span>
              </span>
              <span className="shrink-0 text-[11px] font-normal text-muted-foreground">
                {result.kind === "chat" ? "Chat" : "Action"}
              </span>
            </Button>
          );
        })}
      </div>
    </div>
  );
}

export function CommandPaletteDialog({
  open,
  query,
  results,
  activeIndex,
  returnFocusRef,
  appFocusRef,
  shouldRestoreFocusRef,
  onOpenChange,
  onQueryChange,
  onActiveIndexChange,
  onSelect,
}: {
  open: boolean;
  query: string;
  results: CommandPaletteResult[];
  activeIndex: number;
  returnFocusRef: RefObject<FocusableTarget | null>;
  appFocusRef: RefObject<FocusableTarget | null>;
  shouldRestoreFocusRef: RefObject<boolean>;
  onOpenChange: (open: boolean) => void;
  onQueryChange: (query: string) => void;
  onActiveIndexChange: (index: number) => void;
  onSelect: (result: CommandPaletteResult) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-command-palette-content={true}
        aria-labelledby="command-palette-title"
        aria-describedby="command-palette-description"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (!shouldRestoreFocusRef.current) return;
          window.requestAnimationFrame(() => {
            restoreCommandPaletteFocus(
              returnFocusRef.current,
              appFocusRef.current,
              document.body,
              document.documentElement,
            );
          });
        }}
        className="min-[48rem]:max-w-xl gap-0 overflow-hidden p-0 max-[47.999rem]:flex max-[47.999rem]:min-h-0 max-[47.999rem]:flex-col"
      >
        <DialogTitle id="command-palette-title" className="sr-only">
          Command palette
        </DialogTitle>
        <DialogDescription id="command-palette-description" className="sr-only">
          Search current Chats and available OpenBot actions.
        </DialogDescription>
        <CommandPaletteBody
          query={query}
          results={results}
          activeIndex={activeIndex}
          onQueryChange={onQueryChange}
          onActiveIndexChange={onActiveIndexChange}
          onSelect={onSelect}
        />
      </DialogContent>
    </Dialog>
  );
}

export function CommandPalette({
  open,
  enabled,
  chats,
  actions,
  appFocusRef,
  onOpenChange,
  onSelect,
}: {
  open: boolean;
  enabled: boolean;
  chats: ChatInboxRow[];
  actions: CommandPaletteAction[];
  appFocusRef: RefObject<HTMLElement | null>;
  onOpenChange: (open: boolean) => void;
  onSelect: (result: CommandPaletteResult) => boolean;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const shouldRestoreFocusRef = useRef(true);
  const results = useMemo(
    () => commandPaletteResults({ chats, actions, query }),
    [actions, chats, query],
  );

  useEffect(() => {
    if (activeIndex < results.length) return;
    setActiveIndex(results.length > 0 ? results.length - 1 : -1);
  }, [activeIndex, results.length]);

  useEffect(() => {
    if (!enabled || open) return;
    const onShortcut = (event: KeyboardEvent) => {
      const platform = typeof navigator === "undefined" ? "" : navigator.platform;
      if (!commandPaletteShortcutMatches(event, platform)) return;
      event.preventDefault();
      returnFocusRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : appFocusRef.current;
      setQuery("");
      setActiveIndex(0);
      shouldRestoreFocusRef.current = true;
      onOpenChange(true);
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [appFocusRef, enabled, onOpenChange, open]);

  function changeOpen(next: boolean) {
    if (!next) {
      setQuery("");
      setActiveIndex(0);
    }
    onOpenChange(next);
  }

  function chooseResult(result: CommandPaletteResult) {
    if (!onSelect(result)) return;
    shouldRestoreFocusRef.current = false;
    setQuery("");
    setActiveIndex(0);
    onOpenChange(false);
  }

  return (
    <CommandPaletteDialog
      open={open}
      query={query}
      results={results}
      activeIndex={activeIndex}
      returnFocusRef={returnFocusRef}
      appFocusRef={appFocusRef}
      shouldRestoreFocusRef={shouldRestoreFocusRef}
      onOpenChange={changeOpen}
      onQueryChange={(nextQuery) => {
        setQuery(nextQuery);
        setActiveIndex(0);
      }}
      onActiveIndexChange={setActiveIndex}
      onSelect={chooseResult}
    />
  );
}
