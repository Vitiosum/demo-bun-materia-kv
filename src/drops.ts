// Dead drops in Materia KV. Five keys tell the whole story:
//   drop:<hash>    the sealed message, with a TTL (SET … EX)       → gone after GETDEL or the TTL
//   ash:<hash>     "read:<timestamp>", kept 1 h so the sender sees how it burned
//   drops:index    set of "<hash>:<fuse>" for the "active right now" gauge
//   stats:sealed   INCR on every new message
//   stats:burned   INCR once per message destroyed, by a reader or by its fuse
import { kv, kvMany, shortKey } from "./kv";
import { ID_PATTERN, lookupHash, newId, seal, unseal } from "./crypto";

export const FUSES = { read: 86_400, "30s": 30, "5m": 300, "1h": 3_600 } as const; // seconds
export type Fuse = keyof typeof FUSES;
export const MAX_BYTES = 2048;

const INDEX = "drops:index";
const SEALED = "stats:sealed";
const BURNED = "stats:burned";
const dropKey = (hash: string) => `drop:${hash}`;
const ashKey = (hash: string) => `ash:${hash}`;
const code = (hash: string) => hash.slice(0, 4).toUpperCase();

export const isFuse = (f: unknown): f is Fuse => typeof f === "string" && f in FUSES;
export const isId = (id: unknown): id is string => typeof id === "string" && ID_PATTERN.test(id);

// Leave a message: encrypt it, store it with its TTL, index it, count it.
export async function sealDrop(message: string, fuse: Fuse, id = newId(), tag = "seal") {
  const hash = lookupHash(id);
  const payload = await seal(id, JSON.stringify({ message, fuse, sealedAt: Date.now() }));
  const ttl = String(FUSES[fuse]);
  const created = await kv("SET", [dropKey(hash), payload, "EX", ttl, "NX"], tag,
    [shortKey(dropKey(hash)), `‹${payload.length} B ciphertext›`, "EX", ttl, "NX"]);
  if (created !== "OK") return null; // id already used (seed already present)
  await kv("SADD", [INDEX, `${hash}:${fuse}`], tag, [INDEX, shortKey(`${hash}:${fuse}`)]);
  await kv("INCR", [SEALED], tag);
  cache = null; // next pulse shows the new dossier
  return { id, fuse, ttl: FUSES[fuse], code: code(hash) };
}

// Read a message once. GETDEL returns the value and deletes the key in one atomic step:
// two readers racing on the same link cannot both get it.
export async function openDrop(id: string) {
  const hash = lookupHash(id);
  const payload = await kv<string | null>("GETDEL", [dropKey(hash)], "open", [shortKey(dropKey(hash))]);
  if (!payload) return { burned: await ashOf(hash, "open") };

  const { message, fuse, sealedAt } = JSON.parse(await unseal(id, payload));
  const at = Date.now();
  await kv("SET", [ashKey(hash), `read:${at}`, "EX", "3600"], "open", [shortKey(ashKey(hash)), `"read:${at}"`, "EX", "3600"]);
  await retire(hash, fuse);
  cache = null; // next pulse shows the burn
  return { message: message as string, fuse: fuse as Fuse, sealedAt: sealedAt as number, readAt: at, code: code(hash) };
}

// Is the message still waiting? PTTL gives the countdown in milliseconds, -2 once it is gone.
export async function dropStatus(id: string) {
  const hash = lookupHash(id);
  const pttl = await kv<number>("PTTL", [dropKey(hash)], "status", [shortKey(dropKey(hash))]);
  if (pttl !== -2) return { state: "pending" as const, pttl, code: code(hash) };
  return { state: "burned" as const, ...(await ashOf(hash, "status")), code: code(hash) };
}

async function ashOf(hash: string, tag: string) {
  const ash = await kv<string | null>("GET", [ashKey(hash)], tag, [shortKey(ashKey(hash))]);
  return ash?.startsWith("read:") ? { how: "read" as const, at: Number(ash.slice(5)) } : { how: "expired" as const };
}

// Remove from the index. Only the caller whose SREM really removed the member counts
// the burn, so a reader and a sweep racing on the same message count it once.
async function retire(hash: string, fuse: string) {
  const removed = await kv<number>("SREM", [INDEX, `${hash}:${fuse}`], "burn", [INDEX, shortKey(`${hash}:${fuse}`)]);
  if (removed === 1) await kv("INCR", [BURNED], "burn");
}

// Counters, gauge and board. Materia KV expires keys lazily (on access), so the sweep
// reads every indexed key with PTTL: expired ones answer -2 and leave the index.
// Cached for 10 s per instance so that many open pages cost one sweep; a seal or a
// read on this instance clears the cache so the counters move at once.
type Pulse = { burned: number; sealed: number; active: number; drops: { code: string; fuse: Fuse; pttl: number }[] };
let cache: { at: number; value: Promise<Pulse> } | null = null;

export function pulse(): Promise<Pulse> {
  if (!cache || Date.now() - cache.at > 10_000) {
    const value = sweep();
    cache = { at: Date.now(), value };
    value.catch(() => (cache = null));
  }
  return cache.value;
}

async function sweep(): Promise<Pulse> {
  const members = await kv<string[]>("SMEMBERS", [INDEX], "sweep", [INDEX]);
  const pttls = await kvMany<number>("PTTL", members.map((m) => [dropKey(m.split(":")[0]!)]), "sweep",
    `drop:… ×${members.length}`);

  const drops: Pulse["drops"] = [];
  for (const [i, member] of members.entries()) {
    const [hash, fuse] = member.split(":") as [string, Fuse];
    if (pttls[i] === -2) await retire(hash, fuse);
    else drops.push({ code: code(hash), fuse, pttl: pttls[i]! });
  }
  const [burned, sealed] = await kv<(string | null)[]>("MGET", [BURNED, SEALED], "sweep");
  drops.sort((a, b) => a.pttl - b.pttl);
  return { burned: Number(burned ?? 0), sealed: Number(sealed ?? 0), active: drops.length, drops: drops.slice(0, 24) };
}

// Seed: three decoy dossiers from HQ, so the board is never empty. Their ids are derived
// from fixed names and SET … NX makes the seed idempotent across restarts and instances.
const DECOYS: { name: string; fuse: Fuse; text: string }[] = [
  { name: "hq-locker", fuse: "read", text: "The package is in locker 42. The code changes at midnight." },
  { name: "hq-bridge", fuse: "1h", text: "Skip the bridge. Use the backup site and come alone." },
  { name: "hq-coffee", fuse: "read", text: "The coffee machine on floor 3 is bugged. Say nothing near it." },
];

export async function seedDecoys() {
  let created = 0;
  for (const d of DECOYS) {
    const id = lookupHash(`decoy|${d.name}`).slice(0, 22);
    if (await sealDrop(d.text, d.fuse, id, "seed")) created++;
  }
  return created;
}
