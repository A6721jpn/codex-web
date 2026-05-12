import type { CodexWebDatabase } from "./db.ts";
import { hashPassword, hmacHex, randomToken, safeEqual, verifyPasswordHash } from "./crypto.ts";

const SESSION_COOKIE = "codex_web_session";
const IDLE_TTL_MS = 8 * 60 * 60 * 1000;
const ABSOLUTE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export type AuthServiceOptions = {
  now?: () => number;
  sessionSecret: string;
};

export type LoginContext = {
  ip: string;
  userAgent: string;
};

export type LoginResult = {
  cookieValue: string;
  csrfToken: string;
  deviceSessionId: string;
  setCookie: string;
};

export type AuthenticatedSession = {
  csrfTokenHash: string;
  deviceSessionId: string;
  sessionHash: string;
};

export class AuthService {
  #db: CodexWebDatabase;
  #now: () => number;
  #secret: string;

  constructor(db: CodexWebDatabase, options: AuthServiceOptions) {
    this.#db = db;
    this.#now = options.now ?? Date.now;
    this.#secret = options.sessionSecret;
  }

  needsSetup(): boolean {
    return !this.#passwordHash();
  }

  async setupPassword(password: string): Promise<void> {
    if (!this.needsSetup()) {
      throw new Error("Password is already configured");
    }
    if (password.length < 8) {
      throw new Error("Password must be at least 8 characters");
    }
    this.#setSetting("password_hash", await hashPassword(password));
  }

  async verifyPassword(password: string): Promise<boolean> {
    const passwordHash = this.#passwordHash();
    return passwordHash ? await verifyPasswordHash(password, passwordHash) : false;
  }

  async login(password: string, context: LoginContext): Promise<LoginResult> {
    const now = this.#now();
    const attempt = this.#db
      .prepare("SELECT next_allowed_at FROM login_attempts WHERE subject = ?")
      .get(context.ip) as { next_allowed_at: number } | undefined;
    if (attempt && attempt.next_allowed_at > now) {
      throw new Error("Login temporarily blocked");
    }

    if (!(await this.verifyPassword(password))) {
      this.#recordFailedLogin(context.ip, now);
      throw new Error("Invalid password");
    }

    this.#db.prepare("DELETE FROM login_attempts WHERE subject = ?").run(context.ip);
    const sessionId = randomToken();
    const csrfToken = randomToken();
    const deviceId = randomToken();
    const sessionHash = hmacHex(this.#secret, sessionId);
    const deviceHash = hmacHex(this.#secret, deviceId);
    const csrfHash = hmacHex(this.#secret, csrfToken);
    this.#db
      .prepare(
        `INSERT INTO device_sessions (
          session_id_hash, device_session_id_hash, csrf_token_hash, user_agent, ip_address,
          created_at, last_seen_at, idle_expires_at, absolute_expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(sessionHash, deviceHash, csrfHash, context.userAgent, context.ip, now, now, now + IDLE_TTL_MS, now + ABSOLUTE_TTL_MS);

    const cookieValue = this.#sign(sessionId);
    return {
      cookieValue,
      csrfToken,
      deviceSessionId: deviceHash,
      setCookie: `${SESSION_COOKIE}=${cookieValue}; HttpOnly; Path=/; SameSite=Lax`,
    };
  }

  readSession(cookieValue: string | undefined): AuthenticatedSession | undefined {
    const sessionId = this.#verifySigned(cookieValue);
    if (!sessionId) {
      return undefined;
    }
    const now = this.#now();
    const sessionHash = hmacHex(this.#secret, sessionId);
    const row = this.#db
      .prepare(
        `SELECT session_id_hash, device_session_id_hash, csrf_token_hash
         FROM device_sessions
         WHERE session_id_hash = ? AND revoked_at IS NULL AND idle_expires_at > ? AND absolute_expires_at > ?`,
      )
      .get(sessionHash, now, now) as
      | { csrf_token_hash: string; device_session_id_hash: string; session_id_hash: string }
      | undefined;
    if (!row) {
      return undefined;
    }
    this.#db
      .prepare("UPDATE device_sessions SET last_seen_at = ?, idle_expires_at = ? WHERE session_id_hash = ?")
      .run(now, now + IDLE_TTL_MS, sessionHash);
    return {
      csrfTokenHash: row.csrf_token_hash,
      deviceSessionId: row.device_session_id_hash,
      sessionHash: row.session_id_hash,
    };
  }

  logout(cookieValue: string | undefined): void {
    const sessionId = this.#verifySigned(cookieValue);
    if (!sessionId) {
      return;
    }
    this.#db.prepare("UPDATE device_sessions SET revoked_at = ? WHERE session_id_hash = ?").run(
      this.#now(),
      hmacHex(this.#secret, sessionId),
    );
  }

  validateCsrfToken(session: AuthenticatedSession, token: string | undefined): boolean {
    return typeof token === "string" && safeEqual(hmacHex(this.#secret, token), session.csrfTokenHash);
  }

  cookieName(): string {
    return SESSION_COOKIE;
  }

  #passwordHash(): string | undefined {
    const row = this.#db.prepare("SELECT value FROM settings WHERE key = 'password_hash'").get() as { value: string } | undefined;
    return row?.value;
  }

  #setSetting(key: string, value: string): void {
    this.#db
      .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .run(key, value, this.#now());
  }

  #recordFailedLogin(subject: string, now: number): void {
    const current = this.#db.prepare("SELECT failed_count FROM login_attempts WHERE subject = ?").get(subject) as
      | { failed_count: number }
      | undefined;
    const failedCount = (current?.failed_count ?? 0) + 1;
    const backoffMs = Math.min(60_000, 500 * 2 ** (failedCount - 1));
    this.#db
      .prepare(
        `INSERT INTO login_attempts (subject, failed_count, last_failed_at, next_allowed_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(subject) DO UPDATE SET
           failed_count = excluded.failed_count,
           last_failed_at = excluded.last_failed_at,
           next_allowed_at = excluded.next_allowed_at`,
      )
      .run(subject, failedCount, now, now + backoffMs);
  }

  #sign(sessionId: string): string {
    return `${sessionId}.${hmacHex(this.#secret, sessionId)}`;
  }

  #verifySigned(cookieValue: string | undefined): string | undefined {
    if (!cookieValue) {
      return undefined;
    }
    const [sessionId, signature] = cookieValue.split(".");
    if (!sessionId || !signature || !safeEqual(hmacHex(this.#secret, sessionId), signature)) {
      return undefined;
    }
    return sessionId;
  }
}

export function readCookie(header: string | null, name: string): string | undefined {
  if (!header) {
    return undefined;
  }
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) {
      return value.join("=");
    }
  }
  return undefined;
}
