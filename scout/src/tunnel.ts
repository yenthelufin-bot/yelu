import { type ChildProcess, execFile, spawn } from "node:child_process";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

// A public link to this computer, so a client or model can open a shared
// selection from anywhere. It uses Cloudflare's free "quick tunnel": no
// account, a random https://….trycloudflare.com address, and it lasts as long
// as the app runs. Only the share pages answer through it: the rest of the API
// refuses requests that do not come from this computer (see isTrustedRequest).

const run = promisify(execFile);
const RELEASES = "https://github.com/cloudflare/cloudflared/releases/latest/download";

/** The cloudflared download for this system, or null where there is none. */
export function downloadName(platform = process.platform, arch = process.arch): string | null {
  const a = arch === "arm64" ? "arm64" : arch === "x64" ? "amd64" : null;
  if (!a) return null;
  if (platform === "win32") return "cloudflared-windows-amd64.exe"; // also runs on ARM Windows
  if (platform === "darwin") return `cloudflared-darwin-${a}.tgz`;
  if (platform === "linux") return `cloudflared-linux-${a}`;
  return null;
}

export class Tunnel {
  private readonly binDir: string;
  private proc: ChildProcess | null = null;
  private starting: Promise<string> | null = null;
  url: string | null = null;

  constructor(binDir: string) {
    this.binDir = binDir;
  }

  private localBinary(): string {
    return path.join(this.binDir, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
  }

  /** cloudflared from our own folder, or one installed on the system. */
  async findBinary(): Promise<string | null> {
    if (existsSync(this.localBinary())) return this.localBinary();
    try {
      const { stdout } = await run(process.platform === "win32" ? "where" : "which", ["cloudflared"]);
      return stdout.split(/\r?\n/)[0].trim() || null;
    } catch {
      return null;
    }
  }

  /** Downloads cloudflared from Cloudflare's GitHub releases into our own folder. */
  async install(fetchFn: typeof fetch = fetch): Promise<string> {
    const name = downloadName();
    if (!name) throw new Error("Voor dit systeem is er geen cloudflared om te downloaden.");
    const res = await fetchFn(`${RELEASES}/${name}`, { signal: AbortSignal.timeout(180_000) });
    if (!res.ok) throw new Error(`Downloaden mislukt (${res.status}).`);
    const data = Buffer.from(await res.arrayBuffer());
    await mkdir(this.binDir, { recursive: true });
    const target = this.localBinary();
    if (name.endsWith(".tgz")) {
      const archive = path.join(this.binDir, name);
      await writeFile(archive, data);
      await run("tar", ["-xzf", archive, "-C", this.binDir]);
      await rm(archive, { force: true });
    } else {
      await writeFile(target, data);
    }
    if (process.platform !== "win32") await chmod(target, 0o755);
    return target;
  }

  /** Starts the tunnel to the given local port; resolves with the public https address. */
  start(port: number): Promise<string> {
    if (this.url) return Promise.resolve(this.url);
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const bin = await this.findBinary();
      if (!bin) throw new Error("cloudflared is niet geïnstalleerd.");
      const proc = spawn(bin, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      this.proc = proc;
      return await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("De internetlink kwam niet tot stand (time-out). Probeer opnieuw.")), 45_000);
        const onData = (chunk: Buffer) => {
          const match = chunk.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
          if (match) {
            clearTimeout(timer);
            this.url = match[0];
            resolve(match[0]);
          }
        };
        proc.stdout?.on("data", onData);
        proc.stderr?.on("data", onData);
        proc.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        proc.on("exit", () => {
          clearTimeout(timer);
          this.url = null;
          this.proc = null;
          reject(new Error("De internetlink is gestopt."));
        });
      });
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  stop(): void {
    this.proc?.kill();
    this.proc = null;
    this.url = null;
  }
}
