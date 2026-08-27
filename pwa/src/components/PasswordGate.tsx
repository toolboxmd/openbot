import { FormEvent, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { ArrowRight } from "lucide-react";
import { Eyes } from "@/components/Eyes";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createLatestRequestScope } from "@/lib/async-state";
import { unlock } from "@/lib/session";

type Props = {
  onUnlocked: () => void;
};

export function PasswordGate({ onUnlocked }: Props) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const unlockRequestRef = useRef(createLatestRequestScope());

  useEffect(() => () => unlockRequestRef.current.cancel(), []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await unlockRequestRef.current.run(
      (signal) => unlock(password, signal),
      {
        pending() {
          setPending(true);
          setError(null);
        },
        success(result) {
          if (!result.ok) {
            setError(result.error);
            return;
          }
          onUnlocked();
        },
        failure() {
          setError("Could not unlock OpenBot. Try again.");
        },
        settled() {
          setPending(false);
        },
      },
    );
  }

  return (
    <main className="flex min-h-full items-center justify-center bg-sidebar px-6">
      <motion.form
        onSubmit={onSubmit}
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
        className="w-full max-w-sm"
      >
        <Card className="border-border/80 shadow-none">
          <CardHeader>
            <Eyes size={56} />
            <CardTitle className="mt-3">Unlock this Computer</CardTitle>
            <CardDescription>Enter the Password once. You stay signed in here.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </CardContent>
          <CardFooter>
            <Button type="submit" className="w-full" disabled={pending || password.length === 0}>
              {pending ? "Checking…" : "Enter"}
              <ArrowRight />
            </Button>
          </CardFooter>
        </Card>
      </motion.form>
    </main>
  );
}
