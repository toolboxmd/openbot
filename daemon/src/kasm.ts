import http from "node:http";
import https from "node:https";

export type KasmWriteOptions = {
  upstream: string;
  user: string;
  password: string;
  name: string;
  write: boolean;
};

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
        if (status >= 400) {
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
