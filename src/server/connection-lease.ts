import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

import type { AuthService } from "./auth.ts";
import { hmacHex, randomToken } from "./crypto.ts";
import type { CodexWebDatabase } from "./db.ts";

export type LeaseOptions = {
  leaseTtlMs?: number;
  now?: () => number;
  secret?: string;
};

export type LeaseResult =
  | {
      connectionId: string;
      epoch: number;
      fencingToken: string;
      leaseExpiresAt: number;
      state: "active";
    }
  | {
      activeDeviceLabel: string;
      activeUserAgent: string;
      state: "busy";
    };

export type TakeoverResult = Extract<LeaseResult, { state: "active" }> & {
  revokedConnectionId?: string;
};

export class ConnectionLeaseManager extends EventEmitter {
  #db: CodexWebDatabase;
  #leaseTtlMs: number;
  #now: () => number;
  #secret: string;

  constructor(db: CodexWebDatabase, options: LeaseOptions = {}) {
    super();
    this.#db = db;
    this.#leaseTtlMs = options.leaseTtlMs ?? 60_000;
    this.#now = options.now ?? Date.now;
    this.#secret = options.secret ?? "lease-secret";
  }

  acquire(deviceSessionId: string, deviceLabel: string, userAgent: string): LeaseResult {
    const now = this.#now();
    const active = this.#active();
    if (active && active.lease_expires_at > now) {
      const epoch = this.#epoch(active.connection_id);
      if (epoch?.device_session_id_hash === deviceSessionId) {
        return this.#grant(deviceSessionId, deviceLabel, userAgent, active.epoch + 1);
      }
      return {
        activeDeviceLabel: epoch?.device_label ?? "Unknown device",
        activeUserAgent: epoch?.user_agent ?? "",
        state: "busy",
      };
    }
    return this.#grant(deviceSessionId, deviceLabel, userAgent, (active?.epoch ?? 0) + 1);
  }

  async takeover(input: {
    auth: AuthService;
    deviceLabel: string;
    deviceSessionId: string;
    password: string;
    userAgent: string;
  }): Promise<TakeoverResult> {
    if (!(await input.auth.verifyPassword(input.password))) {
      throw new Error("Invalid password");
    }
    const active = this.#active();
    const now = this.#now();
    let revokedConnectionId: string | undefined;
    let nextEpoch = 1;
    if (active) {
      revokedConnectionId = active.connection_id;
      nextEpoch = active.epoch + 1;
      this.#db
        .prepare("UPDATE connection_epochs SET revoked_at = ?, revocation_reason = ? WHERE connection_id = ?")
        .run(now, "takeover", active.connection_id);
    }
    const granted = this.#grant(input.deviceSessionId, input.deviceLabel, input.userAgent, nextEpoch);
    this.emit("revoked", { connectionId: revokedConnectionId, reason: "takeover" });
    return { ...granted, revokedConnectionId };
  }

  heartbeat(connectionId: string, epoch: number, fencingToken: string): boolean {
    if (!this.canUse(connectionId, epoch, fencingToken)) {
      return false;
    }
    const now = this.#now();
    const expires = now + this.#leaseTtlMs;
    this.#db
      .prepare("UPDATE connection_epochs SET heartbeat_at = ?, lease_expires_at = ? WHERE connection_id = ?")
      .run(now, expires, connectionId);
    this.#db
      .prepare("UPDATE active_connection SET lease_expires_at = ?, updated_at = ? WHERE singleton_id = 1 AND connection_id = ?")
      .run(expires, now, connectionId);
    return true;
  }

  canUse(connectionId: string, epoch: number, fencingToken: string): boolean {
    const active = this.#active();
    if (!active || active.connection_id !== connectionId || active.epoch !== epoch || active.lease_expires_at <= this.#now()) {
      return false;
    }
    const row = this.#epoch(connectionId);
    return Boolean(
      row &&
        row.revoked_at === null &&
        row.epoch === epoch &&
        row.lease_expires_at > this.#now() &&
        row.fencing_token_hash === this.#hash(fencingToken),
    );
  }

  #grant(deviceSessionId: string, deviceLabel: string, userAgent: string, epoch: number): Extract<LeaseResult, { state: "active" }> {
    const now = this.#now();
    const connectionId = randomUUID();
    const fencingToken = randomToken();
    const leaseExpiresAt = now + this.#leaseTtlMs;
    this.#db
      .prepare(
        `INSERT INTO connection_epochs (
          connection_id, epoch, fencing_token_hash, device_session_id_hash, device_label, user_agent,
          heartbeat_at, lease_expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(connectionId, epoch, this.#hash(fencingToken), deviceSessionId, deviceLabel, userAgent, now, leaseExpiresAt, now);
    this.#db
      .prepare(
        `INSERT INTO active_connection (singleton_id, connection_id, epoch, device_session_id_hash, lease_expires_at, updated_at)
         VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT(singleton_id) DO UPDATE SET
           connection_id = excluded.connection_id,
           epoch = excluded.epoch,
           device_session_id_hash = excluded.device_session_id_hash,
           lease_expires_at = excluded.lease_expires_at,
           updated_at = excluded.updated_at`,
      )
      .run(connectionId, epoch, deviceSessionId, leaseExpiresAt, now);
    return { connectionId, epoch, fencingToken, leaseExpiresAt, state: "active" };
  }

  #active(): { connection_id: string; epoch: number; lease_expires_at: number } | undefined {
    return this.#db.prepare("SELECT connection_id, epoch, lease_expires_at FROM active_connection WHERE singleton_id = 1").get() as
      | { connection_id: string; epoch: number; lease_expires_at: number }
      | undefined;
  }

  #epoch(connectionId: string):
    | {
        device_label: string;
        device_session_id_hash: string;
        epoch: number;
        fencing_token_hash: string;
        lease_expires_at: number;
        revoked_at: number | null;
        user_agent: string;
      }
    | undefined {
    return this.#db
      .prepare(
        `SELECT device_label, device_session_id_hash, epoch, fencing_token_hash, lease_expires_at, revoked_at, user_agent
         FROM connection_epochs WHERE connection_id = ?`,
      )
      .get(connectionId) as
      | {
          device_label: string;
          device_session_id_hash: string;
          epoch: number;
          fencing_token_hash: string;
          lease_expires_at: number;
          revoked_at: number | null;
          user_agent: string;
        }
      | undefined;
  }

  #hash(value: string): string {
    return hmacHex(this.#secret, value);
  }
}
