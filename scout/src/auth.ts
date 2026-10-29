import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

const COOKIE = "ff_session";
const SESSION_DAYS = 30;
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60_000;

const sha256 = (text: string) => createHash("sha256").update(text).digest();

/**
 * One shared password for the online version. Sessions are signed with a key
 * derived from the password, so a restart keeps people logged in and changing
 * the password logs everyone out.
 */
export class PasswordAuth {
  private readonly passwordHash: Buffer;
  private readonly signingKey: Buffer;
  private readonly failures = new Map<string, number[]>();
  private readonly now: () => number;

  constructor(password: string, now: () => number = Date.now) {
    if (password.length < 10) throw new Error("FRAMEFINDER_PASSWORD moet minstens 10 tekens lang zijn.");
    this.passwordHash = sha256(password);
    this.signingKey = sha256(`frame-finder-session:${password}`);
    this.now = now;
  }

  /** Too many wrong passwords from this address lately. */
  isBlocked(ip: string): boolean {
    const recent = (this.failures.get(ip) ?? []).filter((t) => this.now() - t < FAILURE_WINDOW_MS);
    this.failures.set(ip, recent);
    return recent.length >= MAX_FAILURES;
  }

  /** Checks the password; returns a session cookie value, or null when wrong. */
  login(password: string, ip: string): string | null {
    if (timingSafeEqual(sha256(password), this.passwordHash)) {
      this.failures.delete(ip);
      const expires = this.now() + SESSION_DAYS * 86_400_000;
      return `${expires}.${this.sign(String(expires))}`;
    }
    const list = this.failures.get(ip) ?? [];
    list.push(this.now());
    this.failures.set(ip, list);
    if (this.failures.size > 10_000) this.failures.delete(this.failures.keys().next().value!);
    return null;
  }

  isLoggedIn(req: IncomingMessage): boolean {
    const token = readCookie(req, COOKIE);
    if (!token) return false;
    const [expires, signature = ""] = token.split(".");
    if (!/^\d+$/.test(expires) || Number(expires) < this.now()) return false;
    const expected = Buffer.from(this.sign(expires));
    const given = Buffer.from(signature);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  cookie(value: string, secure: boolean): string {
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86_400}${secure ? "; Secure" : ""}`;
  }

  clearCookie(secure: boolean): string {
    return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
  }

  private sign(text: string): string {
    return createHmac("sha256", this.signingKey).update(text).digest("base64url");
  }
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

/** The visitor's address behind the hosting proxy: the last X-Forwarded-For entry, which the proxy itself added. */
export function clientIp(req: IncomingMessage): string {
  const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return forwarded.at(-1) ?? req.socket.remoteAddress ?? "?";
}

/** Whether the visitor reached us over HTTPS (directly or through the hosting proxy). */
export function isHttps(req: IncomingMessage): boolean {
  return String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() === "https" || "encrypted" in req.socket;
}
