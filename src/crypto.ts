// The one-time link carries a random 128-bit id. That id is the only key to a message:
//  - the Materia KV key is a hash of it, so the database cannot rebuild a link;
//  - the value is AES-256-GCM ciphertext sealed with a key derived from it.
// Whoever reads the database (or the wire log) sees only hashes and ciphertext.

export const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/; // 16 bytes, base64url

const sha256 = (text: string) => new Uint8Array(new Bun.CryptoHasher("sha256").update(text).digest());
const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const fromB64url = (text: string) => new Uint8Array(Buffer.from(text, "base64url"));

export function newId(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(16)));
}

export function lookupHash(id: string): string {
  return Buffer.from(sha256(`lookup|${id}`)).toString("hex").slice(0, 32);
}

function sealKey(id: string) {
  return crypto.subtle.importKey("raw", sha256(`seal|${id}`), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(id: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(plaintext);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await sealKey(id), data));
  return `v1.${b64url(iv)}.${b64url(ct)}`;
}

export async function unseal(id: string, sealed: string): Promise<string> {
  const [version, iv, ct] = sealed.split(".");
  if (version !== "v1" || !iv || !ct) throw new Error("Unknown payload format");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64url(iv) },
    await sealKey(id),
    fromB64url(ct),
  );
  return new TextDecoder().decode(plain);
}
