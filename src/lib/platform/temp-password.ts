import { randomBytes } from "node:crypto";

const WORDS = ["amber", "bridge", "cedar", "delta", "ember", "falcon", "grove", "harbor"];

/** Human-copyable temporary password (not logged). */
export function generateTemporaryPassword(): string {
  const word = WORDS[randomBytes(1)[0] % WORDS.length];
  const digits = randomBytes(2).readUInt16BE(0) % 10000;
  const suffix = String(digits).padStart(4, "0");
  const tail = randomBytes(3).toString("base64url").slice(0, 4);
  return `${word}-${suffix}-${tail}`;
}
