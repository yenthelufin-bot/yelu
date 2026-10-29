import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SavedSearch, Share } from "./types.ts";

// Searches are kept as one JSON file each, so they survive a restart and can
// be backed up or deleted by hand.

export class SearchStore {
  private readonly dir: string;
  private writes = new Map<string, Promise<void>>();
  /** Deleted while a write may still be queued; those writes are dropped. */
  private deleted = new Set<string>();

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "searches");
  }

  private file(id: string): string {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("ongeldige zoek-id");
    return path.join(this.dir, `${id}.json`);
  }

  /** Writes are serialised per search and atomic, so a crash never leaves half a file. */
  save(search: SavedSearch): Promise<void> {
    const previous = this.writes.get(search.id) ?? Promise.resolve();
    const snapshot = JSON.stringify(search, null, 2);
    const next = previous.then(async () => {
      if (this.deleted.has(search.id)) return;
      await mkdir(this.dir, { recursive: true });
      const target = this.file(search.id);
      await writeFile(`${target}.tmp`, snapshot);
      await rename(`${target}.tmp`, target);
    });
    this.writes.set(search.id, next.catch(() => {}));
    return next;
  }

  async get(id: string): Promise<SavedSearch | null> {
    try {
      return JSON.parse(await readFile(this.file(id), "utf8")) as SavedSearch;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async list(): Promise<SavedSearch[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const searches = await Promise.all(
      names.filter((n) => n.endsWith(".json")).map(async (n) => this.get(n.slice(0, -5)).catch(() => null)),
    );
    return searches.filter((s) => s !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async delete(id: string): Promise<void> {
    this.deleted.add(id);
    await this.writes.get(id);
    await rm(this.file(id), { force: true });
  }
}

/** Uploaded reference photos, kept as JPEG files. They are the user's own photos. */
export class ReferenceStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "references");
  }

  private file(id: string): string {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("ongeldige foto-id");
    return path.join(this.dir, `${id}.jpg`);
  }

  async save(jpeg: Buffer): Promise<string> {
    const id = randomUUID();
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.file(id), jpeg);
    return id;
  }

  load(id: string): Promise<Buffer> {
    return readFile(this.file(id));
  }
}

/** Shared selections, one JSON file each, with the votes of the people they were shared with. */
export class ShareStore {
  private readonly dir: string;
  private writes = new Map<string, Promise<void>>();

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "shares");
  }

  private file(token: string): string {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw new Error("ongeldige link");
    return path.join(this.dir, `${token}.json`);
  }

  save(share: Share): Promise<void> {
    const previous = this.writes.get(share.token) ?? Promise.resolve();
    const snapshot = JSON.stringify(share, null, 2);
    const next = previous.then(async () => {
      await mkdir(this.dir, { recursive: true });
      const target = this.file(share.token);
      await writeFile(`${target}.tmp`, snapshot);
      await rename(`${target}.tmp`, target);
    });
    this.writes.set(share.token, next.catch(() => {}));
    return next;
  }

  async get(token: string): Promise<Share | null> {
    try {
      return JSON.parse(await readFile(this.file(token), "utf8")) as Share;
    } catch {
      return null;
    }
  }

  async forSearch(searchId: string): Promise<Share[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const shares = await Promise.all(names.filter((n) => n.endsWith(".json")).map((n) => this.get(n.slice(0, -5))));
    return shares.filter((s) => s?.searchId === searchId).sort((a, b) => b!.createdAt.localeCompare(a!.createdAt)) as Share[];
  }

  async delete(token: string): Promise<void> {
    await this.writes.get(token);
    await rm(this.file(token), { force: true });
  }
}
