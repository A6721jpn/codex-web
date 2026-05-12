import type { CodexWebDatabase } from "./db.ts";
import { hmacHex, randomToken } from "./crypto.ts";

export type WebSocketTicketStoreOptions = {
  now?: () => number;
  secret: string;
  ttlMs?: number;
};

export class WebSocketTicketStore {
  #db: CodexWebDatabase;
  #now: () => number;
  #secret: string;
  #ttlMs: number;

  constructor(db: CodexWebDatabase, options: WebSocketTicketStoreOptions) {
    this.#db = db;
    this.#now = options.now ?? Date.now;
    this.#secret = options.secret;
    this.#ttlMs = options.ttlMs ?? 30_000;
  }

  issue(sessionId: string): string {
    const ticket = randomToken();
    const now = this.#now();
    this.#db
      .prepare("INSERT INTO ws_tickets (ticket_hash, session_id_hash, issued_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(this.#hash(ticket), sessionId, now, now + this.#ttlMs);
    return ticket;
  }

  consume(ticket: string, sessionId: string): { sessionId: string } | undefined {
    const now = this.#now();
    const ticketHash = this.#hash(ticket);
    const row = this.#db
      .prepare("SELECT session_id_hash FROM ws_tickets WHERE ticket_hash = ? AND used_at IS NULL AND expires_at > ?")
      .get(ticketHash, now) as { session_id_hash: string } | undefined;
    if (!row || row.session_id_hash !== sessionId) {
      return undefined;
    }
    this.#db.prepare("UPDATE ws_tickets SET used_at = ? WHERE ticket_hash = ? AND used_at IS NULL").run(now, ticketHash);
    return { sessionId };
  }

  #hash(ticket: string): string {
    return hmacHex(this.#secret, ticket);
  }
}
