import { FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { unlock } from "@/lib/session";

type Props = {
  onUnlocked: () => void;
};

export function PasswordGate({ onUnlocked }: Props) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const result = await unlock(password);
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onUnlocked();
  }

  return (
    <main className="flex min-h-full items-center justify-center px-6">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm rounded-2xl border border-border bg-card p-8 shadow-lg"
      >
        <p className="text-xs font-medium tracking-[0.2em] text-primary uppercase">OpenBot</p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">Unlock this Computer</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Enter the Password once. An HttpOnly cookie keeps this PWA signed in.
        </p>
        <label className="mt-6 block text-sm font-medium" htmlFor="password">
          Password
        </label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="mt-2"
        />
        {error ? (
          <p className="mt-2 text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <Button type="submit" className="mt-6 w-full" disabled={pending || password.length === 0}>
          {pending ? "Checking…" : "Enter"}
        </Button>
      </form>
    </main>
  );
}
