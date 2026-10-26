import argon2 from "argon2";
import { createHmac, scryptSync, timingSafeEqual } from "crypto";

/* ── Argon2id settings (OWASP recommended) ─────────────────────────────── */
const ARGON2_OPTS = {
  type:        argon2.argon2id,
  memoryCost:  65536,   // 64 MB — GPU cracking almost impossible
  timeCost:    3,       // 3 iterations
  parallelism: 1,
  hashLength:  32,
} as const;

const ARGON2_PREFIX = "$argon2id$";
const SCRYPT_PREFIX = "scrypt$";

/* ── Pepper — ENV VAR mein, DB mein KABHI NAHI ─────────────────────────── */
function getPepper(): Buffer | undefined {
  const p = process.env["PIN_PEPPER"];
  return p ? Buffer.from(p, "utf8") : undefined;
}

/* ── Hash banao (Argon2id + pepper) ────────────────────────────────────── */
export async function hashPin(pin: string): Promise<string> {
  const pepper = getPepper();
  return argon2.hash(pin, {
    ...ARGON2_OPTS,
    ...(pepper ? { secret: pepper } : {}),
  });
}

/* ── Stored value ka type check ────────────────────────────────────────── */
export function isHashed(value: string): boolean {
  return value.startsWith(ARGON2_PREFIX) || isScryptHash(value);
}

function isScryptHash(value: string): boolean {
  if (!value.startsWith(SCRYPT_PREFIX)) return false;
  const parts = value.slice(SCRYPT_PREFIX.length).split("$");
  return parts.length === 2 && parts[0].length === 32 && parts[1].length === 64;
}

export function isArgon2Hash(value: string): boolean {
  return value.startsWith(ARGON2_PREFIX);
}

/* ── Verify karo — teeno formats support karta hai ─────────────────────── */
export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  // 1. Plaintext (legacy — 564 apps)
  if (!isHashed(stored)) {
    return pin === stored;
  }

  // 2. Argon2id (new)
  if (stored.startsWith(ARGON2_PREFIX)) {
    const pepper = getPepper();
    try {
      return await argon2.verify(stored, pin, {
        ...(pepper ? { secret: pepper } : {}),
      });
    } catch {
      return false;
    }
  }

  // 3. Legacy scrypt (backward compat — 1 app)
  if (stored.startsWith(SCRYPT_PREFIX)) {
    return verifyScrypt(pin, stored);
  }

  return false;
}

/* ── Legacy scrypt verify (backward compat only) ───────────────────────── */
function verifyScrypt(pin: string, stored: string): boolean {
  const KEY_LEN  = 32;
  const SALT_LEN = 16;
  const N = 16384, R = 8, P = 1;

  try {
    const [saltHex, keyHex] = stored.slice(SCRYPT_PREFIX.length).split("$");
    if (!saltHex || !keyHex) return false;
    const salt     = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(keyHex,  "hex");

    // Old pepper (HMAC) — agar laga tha scrypt ke waqt
    const pepperStr = process.env["PIN_PEPPER"];
    const peppered  = pepperStr
      ? createHmac("sha256", pepperStr).update(pin).digest("hex")
      : pin;

    const actual = scryptSync(peppered, salt, KEY_LEN, { N, r: R, p: P });
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
