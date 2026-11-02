// End-to-end: starts a throwaway redis-server and the app on free ports (8100-8999),
// then drives the HTTP API like the page does. Requires `redis-server` in PATH.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { RedisClient, type Subprocess } from "bun";
import { lookupHash } from "../src/crypto";

const hasRedis = Bun.which("redis-server") !== null;
let redis: Subprocess, app: Subprocess, kv: RedisClient, base = "";

async function freePort(): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const port = 8100 + Math.floor(Math.random() * 900);
    try {
      Bun.listen({ hostname: "0.0.0.0", port, socket: { data() {} } }).stop(true);
      return port;
    } catch { /* busy, try another */ }
  }
  throw new Error("No free port in 8100-8999");
}

async function until(check: () => Promise<boolean>, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check().catch(() => false)) return;
    await Bun.sleep(100);
  }
  throw new Error("Timed out");
}

const post = (path: string, body: unknown) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe.skipIf(!hasRedis)("dead drop API", () => {
  beforeAll(async () => {
    const redisPort = await freePort();
    redis = Bun.spawn(["redis-server", "--port", String(redisPort), "--save", "", "--appendonly", "no"], { stdout: "ignore" });
    const url = `redis://127.0.0.1:${redisPort}`;
    kv = new RedisClient(url);
    await until(async () => (await kv.send("PING", [])) === "PONG");

    const appPort = await freePort();
    base = `http://127.0.0.1:${appPort}`;
    app = Bun.spawn(["bun", "src/server.ts"], { env: { ...process.env, PORT: String(appPort), REDIS_URL: url }, stdout: "ignore", stderr: "inherit" });
    await until(async () => (await fetch(`${base}/health`)).ok);
    await until(async () => (await kv.send("SCARD", ["drops:index"])) === 3); // seed done
  });

  afterAll(() => {
    app?.kill();
    kv?.close();
    redis?.kill();
  });

  test("health routes", async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
    const deep = await fetch(`${base}/health/deep`);
    expect(deep.status).toBe(200);
    expect((await deep.json()).kv).toBe("PONG");
  });

  test("pages carry security headers", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect((await fetch(`${base}/r`)).status).toBe(200);
    expect((await fetch(`${base}/src/server.ts`)).status).toBe(404);
  });

  test("seed: three decoys, idempotent across restarts", async () => {
    const pulse = await (await fetch(`${base}/api/pulse`)).json();
    expect(pulse.active).toBe(3);
    expect(pulse.drops).toHaveLength(3);
  });

  test("rejects bad input", async () => {
    expect((await post("/api/drops", { message: "  ", fuse: "read" })).status).toBe(400);
    expect((await post("/api/drops", { message: "é".repeat(1025), fuse: "read" })).status).toBe(413); // 2050 bytes
    expect((await post("/api/drops", { message: "hi", fuse: "forever" })).status).toBe(400);
    expect((await post("/api/drops/open", { id: "../../etc/passwd" })).status).toBe(400);
  });

  test("seal, read once, then burned", async () => {
    const message = "The package is under the bench. <script>alert(1)</script>";
    const sealed = await post("/api/drops", { message, fuse: "30s" });
    expect(sealed.status).toBe(201);
    const { id, ttl, wire } = await sealed.json();
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(ttl).toBe(30);
    expect(wire.some((l: { cmd: string; args: string[] }) => l.cmd === "SET" && l.args.includes("EX"))).toBe(true);

    // Materia KV (here: redis) holds a hash as key and ciphertext as value.
    const key = `drop:${lookupHash(id)}`;
    const stored = (await kv.get(key)) as string;
    expect(stored).not.toContain("bench");
    expect(key).not.toContain(id);

    const pending = await (await post("/api/drops/status", { id })).json();
    expect(pending.state).toBe("pending");
    expect(pending.pttl).toBeGreaterThan(0);
    expect(pending.pttl).toBeLessThanOrEqual(30_000);

    const first = await post("/api/drops/open", { id });
    expect(first.status).toBe(200);
    expect((await first.json()).message).toBe(message);
    expect(await kv.exists(key)).toBe(false);

    const second = await post("/api/drops/open", { id });
    expect(second.status).toBe(410);
    expect((await second.json()).burned.how).toBe("read");

    const after = await (await post("/api/drops/status", { id })).json();
    expect(after).toMatchObject({ state: "burned", how: "read" });
  });

  test("an unread message burns when its TTL runs out, and is counted once", async () => {
    const before = await (await fetch(`${base}/api/pulse`)).json();
    const { id } = await (await post("/api/drops", { message: "tick tock", fuse: "30s" })).json();
    await kv.send("PEXPIRE", [`drop:${lookupHash(id)}`, "1"]); // fast-forward the fuse
    await Bun.sleep(50);
    const pulse = await (await fetch(`${base}/api/pulse`)).json();
    expect(pulse.burned).toBe(before.burned + 1);
    expect(pulse.active).toBe(before.active);
    const status = await (await post("/api/drops/status", { id })).json();
    expect(status).toMatchObject({ state: "burned", how: "expired" });
  });

  test("platform panel only exposes the allowed variables", async () => {
    const p = await (await fetch(`${base}/api/platform`)).json();
    expect(Object.keys(p).sort()).toEqual(
      ["APP_ID", "CC_APP_NAME", "CC_COMMIT_ID", "CC_DEPLOYMENT_ID", "CC_PRETTY_INSTANCE_NAME", "INSTANCE_NUMBER", "INSTANCE_TYPE", "bun", "kv"].sort(),
    );
    expect(JSON.stringify(p)).not.toContain("redis://");
  });

  test("rate limit: a burst of seals from one address is throttled", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 14; i++) codes.push((await post("/api/drops", { message: `burst ${i}`, fuse: "30s" })).status);
    expect(codes).toContain(429);
  });
});

test.skipIf(hasRedis)("API tests need redis-server (brew install redis)", () => {});
