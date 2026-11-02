// Materia KV speaks the Redis protocol, so Bun's built-in RedisClient talks to it
// directly, over TLS, with no driver to install. Every command goes through kv(),
// which times it and appends a redacted line to the "wire log" shown in the page.
import { RedisClient } from "bun";

// REDIS_URL is injected by the Materia KV add-on (rediss://:<token>@<host>:6379).
const url = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
export const client = new RedisClient(url, { connectionTimeout: 5000 });

// Public part of the endpoint, for display. Never the token.
const parsed = new URL(url);
export const endpoint = { host: parsed.hostname, port: parsed.port || "6379", tls: parsed.protocol === "rediss:" };

export type WireLine = {
  id: string; // unique across instances
  at: number; // epoch ms
  cmd: string;
  args: string[]; // as displayed (keys shortened, payloads summarised)
  reply: string;
  ms: number;
  tag: string; // seal | open | status | sweep | seed | health
};

const WIRE_SIZE = 80;
const wire: WireLine[] = [];
const instance = process.env.INSTANCE_NUMBER ?? "local";
let seq = 0;

export const wireMark = () => seq;
export const wireSince = (mark: number) => wire.filter((l) => Number(l.id.split("-")[1]) > mark);
export const wireTail = (n = 40) => wire.slice(-n);

// Run one command. `show` is what the wire log prints instead of the raw arguments.
export async function kv<T = unknown>(cmd: string, args: string[], tag: string, show = args): Promise<T> {
  const start = performance.now();
  const reply = await withTimeout(client.send(cmd, args));
  log(cmd, show, summarise(reply), performance.now() - start, tag);
  return reply as T;
}

// Run the same command on many keys at once. Bun pipelines concurrent commands on
// one connection, so N lookups cost about one round trip. Logged as a single line.
export async function kvMany<T = unknown>(cmd: string, argsList: string[][], tag: string, show: string): Promise<T[]> {
  if (argsList.length === 0) return [];
  const start = performance.now();
  const replies = await withTimeout(Promise.all(argsList.map((a) => client.send(cmd, a))));
  log(cmd, [show], summarise(replies), performance.now() - start, tag);
  return replies as T[];
}

function log(cmd: string, args: string[], reply: string, ms: number, tag: string) {
  wire.push({ id: `${instance}-${++seq}`, at: Date.now(), cmd, args, reply, ms: Math.round(ms * 10) / 10, tag });
  if (wire.length > WIRE_SIZE) wire.shift();
}

function summarise(reply: unknown): string {
  if (reply === null || reply === undefined) return "(nil)";
  if (Array.isArray(reply)) {
    const short = reply.length <= 4 && reply.every((r) => typeof r !== "string" || r.length <= 24);
    return short ? `[${reply.map(summarise).join(", ")}]` : `[${reply.length} items]`;
  }
  if (typeof reply === "string" && reply.length > 24) return `‹${reply.length} B›`;
  return typeof reply === "string" ? `"${reply}"` : String(reply);
}

function withTimeout<T>(p: Promise<T>, ms = 4000): Promise<T> {
  let timer: Timer | undefined;
  const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("Materia KV timeout")), ms)));
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// drop:3f9a0c…  →  readable key in the log, without the full hash.
export const shortKey = (key: string) => key.replace(/([0-9a-f]{6})[0-9a-f]{26}/, "$1…");
