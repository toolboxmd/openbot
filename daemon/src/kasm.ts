import { randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";

export type KasmWriteOptions = {
  upstream: string;
  user: string;
  password: string;
  name: string;
  write: boolean;
};

export type KasmWriteAuthority = "view-only" | "write" | "unknown";

export type KasmWriteOwnershipState = {
  authority: KasmWriteAuthority;
  error?: string;
};

export type KasmWriteOwnershipOptions = {
  update: (target: string, write: boolean) => Promise<void>;
  publish?: (target: string, state: KasmWriteOwnershipState) => void;
};

/**
 * Owns the one-at-a-time transition between Kasm write targets. The published
 * state changes only after Kasm confirms the matching update_user request.
 */
export class KasmWriteOwnership {
  private readonly states = new Map<string, KasmWriteOwnershipState>();
  private readonly update: KasmWriteOwnershipOptions["update"];
  private readonly publishState: NonNullable<KasmWriteOwnershipOptions["publish"]>;
  private readonly ownershipEpochId = randomUUID();
  private owner: string | null = null;
  private ownershipBarrier = 0n;
  private tail: Promise<void> = Promise.resolve();
  private closing = false;
  private shutdownResult: Promise<void> | null = null;

  constructor(options: KasmWriteOwnershipOptions) {
    this.update = options.update;
    this.publishState = options.publish ?? (() => undefined);
  }

  state(target: string): KasmWriteOwnershipState {
    return this.states.get(target) ?? {
      authority: "unknown",
      error: "Computer write ownership has not been reconciled.",
    };
  }

  epoch(): string {
    return `${this.ownershipEpochId}:${this.ownershipBarrier}`;
  }

  reconcile(targets: string[]): Promise<KasmWriteOwnershipState[]> {
    return this.serialize(async () => {
      this.owner = null;
      const states: KasmWriteOwnershipState[] = [];
      for (const target of [...new Set(targets)]) {
        try {
          await this.update(target, false);
          states.push(this.setState(target, { authority: "view-only" }));
        } catch (error) {
          states.push(this.setUnknown(target, "reconcile", error));
        }
      }
      return states;
    });
  }

  register(target: string): Promise<KasmWriteOwnershipState> {
    return this.serialize(async () => {
      const current = this.states.get(target);
      if (current) return current;
      return this.revoke(target);
    });
  }

  transition(
    target: string,
    write: boolean,
    expectedEpoch?: string,
  ): Promise<KasmWriteOwnershipState> {
    if (this.closing) {
      return Promise.reject(
        ownershipError("change", target, new Error("Computer ownership is shutting down")),
      );
    }
    let acceptedEpoch = this.epoch();
    if (write) {
      if (expectedEpoch === undefined || expectedEpoch !== acceptedEpoch) {
        return Promise.reject(ownershipEpochError(target, expectedEpoch, acceptedEpoch));
      }
    } else {
      this.ownershipBarrier += 1n;
      acceptedEpoch = this.epoch();
    }
    return this.serialize(async () => {
      if (this.closing) {
        throw ownershipError("change", target, new Error("Computer ownership is shutting down"));
      }
      if (write && this.epoch() !== acceptedEpoch) {
        throw ownershipEpochError(target, acceptedEpoch, this.epoch());
      }
      await this.reconcileUnknownTargets();
      if (!write) {
        const targets = [...new Set([this.owner, target].filter((value): value is string => value !== null))];
        const failures: Error[] = [];
        for (const releaseTarget of targets) {
          try {
            await this.revoke(releaseTarget);
          } catch (error) {
            failures.push(error instanceof Error ? error : new Error(String(error)));
          }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
          throw Object.assign(
            new AggregateError(failures, "Could not confirm the Computer release barrier."),
            { status: 503 },
          );
        }
        return this.state(target);
      }
      if (target === this.owner) return this.state(target);

      const previous = this.owner;
      if (previous !== null) {
        await this.revoke(previous);
      }

      if (!this.states.has(target)) {
        await this.revoke(target);
      }

      if (this.epoch() !== acceptedEpoch) {
        throw ownershipEpochError(target, acceptedEpoch, this.epoch());
      }
      try {
        await this.update(target, true);
        if (this.epoch() !== acceptedEpoch) {
          this.owner = target;
          this.setUnknown(
            target,
            "confirm enable after release barrier",
            ownershipEpochError(target, acceptedEpoch, this.epoch()),
          );
          throw ownershipEpochError(target, acceptedEpoch, this.epoch());
        }
        this.owner = target;
        return this.setState(target, { authority: "write" });
      } catch (error) {
        this.owner = null;
        this.setUnknown(target, "enable", error);
        try {
          await this.update(target, false);
          this.setState(target, { authority: "view-only" });
        } catch (reconcileError) {
          this.setUnknown(target, "reconcile after enable", reconcileError);
        }
        throw ownershipError("enable", target, error);
      }
    });
  }

  shutdown(): Promise<void> {
    if (this.shutdownResult) return this.shutdownResult;
    this.closing = true;
    this.shutdownResult = this.serialize(async () => {
      const failures: Error[] = [];
      const riskyTargets = [...this.states]
        .filter(([target, state]) => target === this.owner || state.authority !== "view-only")
        .map(([target]) => target);
      for (const target of riskyTargets) {
        try {
          await this.revoke(target);
        } catch (error) {
          failures.push(error instanceof Error ? error : new Error(String(error)));
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw Object.assign(
          new AggregateError(
            failures,
            "Could not confirm Computer write ownership cleanup during shutdown.",
          ),
          { status: 503 },
        );
      }
    });
    return this.shutdownResult;
  }

  private async reconcileUnknownTargets(): Promise<void> {
    for (const [target, state] of this.states) {
      if (state.authority !== "unknown") continue;
      await this.revoke(target);
    }
  }

  private async revoke(target: string): Promise<KasmWriteOwnershipState> {
    try {
      await this.update(target, false);
      if (this.owner === target) this.owner = null;
      return this.setState(target, { authority: "view-only" });
    } catch (error) {
      if (this.owner === target) this.owner = null;
      this.setUnknown(target, "disable", error);
      throw ownershipError("disable", target, error);
    }
  }

  private setUnknown(target: string, action: string, error: unknown): KasmWriteOwnershipState {
    const detail = error instanceof Error ? error.message : String(error);
    return this.setState(target, {
      authority: "unknown",
      error: `Kasm could not ${action} write ownership: ${detail}`,
    });
  }

  private setState(target: string, state: KasmWriteOwnershipState): KasmWriteOwnershipState {
    const copy = { ...state };
    this.states.set(target, copy);
    this.publishState(target, copy);
    return copy;
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function ownershipError(action: string, target: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return Object.assign(
    new Error(`Could not ${action} Computer write ownership for ${target}: ${detail}`),
    { status: 503 },
  );
}

function ownershipEpochError(
  target: string,
  expected: string | undefined,
  current: string,
): Error {
  void target;
  void expected;
  void current;
  return Object.assign(
    new Error("Computer changed. Refresh and retry Computer."),
    { status: 409, code: "STALE_OWNERSHIP_EPOCH" },
  );
}

/** Real KasmVNC write vs view-only. Owner keeps API access; write is mouse/keyboard. */
export function kasmUpdateUserUrl(opts: KasmWriteOptions): URL {
  const dest = new URL("/api/update_user", opts.upstream);
  dest.searchParams.set("name", opts.name);
  dest.searchParams.set("write", opts.write ? "true" : "false");
  dest.searchParams.set("read", "true");
  dest.searchParams.set("owner", "true");
  return dest;
}

export function kasmUpdateWrite(opts: KasmWriteOptions): Promise<void> {
  const dest = kasmUpdateUserUrl(opts);
  const auth = `Basic ${Buffer.from(`${opts.user}:${opts.password}`).toString("base64")}`;
  const request = dest.protocol === "https:" ? https.request : http.request;
  return new Promise((resolve, reject) => {
    const req = request(
      dest,
      {
        method: "GET",
        headers: {
          host: dest.host,
          authorization: auth,
          connection: "close",
        },
        timeout: 3000,
      },
      (res) => {
        res.resume();
        const status = res.statusCode ?? 500;
        if (status < 200 || status >= 300) {
          reject(new Error(`Kasm update_user failed: ${status}`));
          return;
        }
        resolve();
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Kasm update_user timeout"));
    });
    req.end();
  });
}
