import { EventEmitter } from "node:events";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue | undefined };

export type JsonRpcMessage = {
  id?: number | string;
  method?: string;
  params?: JsonValue;
  result?: JsonValue;
  error?: JsonValue;
};

type PendingRequest = {
  reject: (reason: Error) => void;
  resolve: (value: JsonValue | undefined) => void;
};

export class JsonRpcLineBuffer {
  #buffer = "";

  push(chunk: Buffer | string): JsonRpcMessage[] {
    this.#buffer += chunk.toString();
    const messages: JsonRpcMessage[] = [];

    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline === -1) {
        return messages;
      }

      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.length === 0) {
        continue;
      }

      try {
        messages.push(JSON.parse(line) as JsonRpcMessage);
      } catch (cause) {
        throw new Error(`Invalid JSON-RPC line: ${line}`, { cause });
      }
    }
  }
}

export type JsonRpcPeerOptions = {
  includeJsonRpcField?: boolean;
  onNotification?: (message: JsonRpcMessage) => void;
};

export type JsonRpcPending = {
  id: number;
  response: Promise<JsonValue | undefined>;
};

export class JsonRpcPeer extends EventEmitter {
  #includeJsonRpcField: boolean;
  #nextId = 1;
  #onNotification?: (message: JsonRpcMessage) => void;
  #pending = new Map<number | string, PendingRequest>();
  #writeLine: (line: string) => void;

  constructor(writeLine: (line: string) => void, options: JsonRpcPeerOptions = {}) {
    super();
    this.#includeJsonRpcField = options.includeJsonRpcField ?? false;
    this.#onNotification = options.onNotification;
    this.#writeLine = writeLine;
  }

  request(method: string, params?: JsonValue): JsonRpcPending {
    const id = this.#nextId++;
    const message: JsonRpcMessage = { id, method };
    if (params !== undefined) {
      message.params = params;
    }
    if (this.#includeJsonRpcField) {
      (message as JsonRpcMessage & { jsonrpc: string }).jsonrpc = "2.0";
    }

    const response = new Promise<JsonValue | undefined>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.#writeLine(`${JSON.stringify(message)}\n`);
    return { id, response };
  }

  receive(message: JsonRpcMessage): void {
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.#pending.get(message.id);
      if (!pending) {
        this.emit("orphanResponse", message);
        return;
      }
      this.#pending.delete(message.id);
      if (message.error !== undefined) {
        pending.reject(new Error(`JSON-RPC error for id ${String(message.id)}: ${JSON.stringify(message.error)}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    this.#onNotification?.(message);
    this.emit("notification", message);
  }

  rejectAll(reason: Error): void {
    for (const pending of this.#pending.values()) {
      pending.reject(reason);
    }
    this.#pending.clear();
  }
}
