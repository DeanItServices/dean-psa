import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

/**
 * Application-layer encryption for secrets at rest (currently: QuickBooks
 * OAuth access/refresh tokens in `QuickBooksConnection`). AES-256-GCM via
 * Node's built-in `crypto` module -- no third-party dependency.
 *
 * `encrypt()`'s output format is self-contained: a single string of the form
 *   base64(iv) : base64(authTag) : base64(ciphertext)
 * (12-byte IV, 16-byte GCM auth tag, colon-separated, each base64-encoded).
 * `decrypt()` parses that exact format back apart. No additional state is
 * needed beyond the stored string itself.
 *
 * Key source: `TOKEN_ENCRYPTION_KEY` env var, a base64-encoded 32-byte
 * (256-bit) value. Generate one with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const KEY_LENGTH = 32;

const KEY_ERROR_MESSAGE =
  "TOKEN_ENCRYPTION_KEY must be a 32-byte base64-encoded value. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"";

function getEncryptionKey(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;

  if (!raw) {
    throw new Error(KEY_ERROR_MESSAGE);
  }

  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    throw new Error(KEY_ERROR_MESSAGE);
  }

  if (key.length !== KEY_LENGTH) {
    throw new Error(KEY_ERROR_MESSAGE);
  }

  return key;
}

/**
 * Encrypts `plaintext` with AES-256-GCM using a fresh random IV. Returns a
 * self-contained string: `base64(iv):base64(authTag):base64(ciphertext)`.
 */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(
    ":",
  );
}

/**
 * Reverses `encrypt()` exactly. Throws if `ciphertext` is not in the
 * expected format, or if AES-256-GCM decryption/auth-tag verification fails
 * (wrong key, corrupted data, tampered ciphertext). Callers are responsible
 * for catching and handling that failure -- this module does not swallow it.
 */
export function decrypt(ciphertext: string): string {
  const key = getEncryptionKey();

  const parts = ciphertext.split(":");
  if (parts.length !== 3) {
    throw new Error("Malformed ciphertext: expected iv:authTag:ciphertext format.");
  }

  const [ivB64, authTagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const data = Buffer.from(dataB64, "base64");

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
  return plaintext.toString("utf8");
}
