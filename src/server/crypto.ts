import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hmacHex(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomToken(16);
  const key = await scrypt(password, salt, 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt}$${key.toString("base64url")}`;
}

export async function verifyPasswordHash(password: string, encoded: string): Promise<boolean> {
  const [scheme, nRaw, rRaw, pRaw, salt, expected] = encoded.split("$");
  if (scheme !== "scrypt" || !nRaw || !rRaw || !pRaw || !salt || !expected) {
    return false;
  }
  const key = await scrypt(password, salt, 64, {
    N: Number.parseInt(nRaw, 10),
    r: Number.parseInt(rRaw, 10),
    p: Number.parseInt(pRaw, 10),
    maxmem: 64 * 1024 * 1024,
  });
  return safeEqual(key.toString("base64url"), expected);
}

async function scrypt(password: string, salt: string, keylen: number, options: Parameters<typeof scryptCallback>[3]): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  });
}
