// "This message will self-destruct": a dead drop for one-time messages.
// Bun.serve, no framework. Messages live in Materia KV (see drops.ts).
import { MAX_BYTES, dropStatus, isFuse, isId, openDrop, pulse, sealDrop, seedDecoys } from "./drops";
import { client, endpoint, kv, wireMark, wireSince, wireTail } from "./kv";

const PUBLIC = `${import.meta.dir}/../public`;
const MAX_ACTIVE = 500; // drop box capacity: a public demo should not fill the add-on

// Only these platform variables are ever shown in the page.
const PLATFORM_VARS = ["CC_APP_NAME", "APP_ID", "INSTANCE_NUMBER", "INSTANCE_TYPE", "CC_PRETTY_INSTANCE_NAME", "CC_COMMIT_ID", "CC_DEPLOYMENT_ID"];
const platform = {
  ...Object.fromEntries(PLATFORM_VARS.map((k) => [k, (k === "CC_COMMIT_ID" ? process.env[k]?.slice(0, 7) : process.env[k]) || null])),
  bun: Bun.version,
  kv: endpoint, // host and port only
};

const HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; " +
    "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { ...HEADERS, "Cache-Control": "no-store" } });
const file = (path: string) => new Response(Bun.file(path), { headers: HEADERS });

// A few messages per minute and per address is plenty for a demo.
const hits = new Map<string, number[]>();
setInterval(() => hits.clear(), 10 * 60_000);
function tooMany(ip: string) {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > 12;
}

// The link id travels in the request body, never in a URL: it stays out of access logs.
async function readId(req: Request) {
  const body = (await req.json().catch(() => null)) as { id?: unknown } | null;
  return isId(body?.id) ? body.id : null;
}

const server = Bun.serve({
  port: Number(process.env.PORT ?? 8080),
  hostname: "0.0.0.0",
  maxRequestBodySize: 16 * 1024,

  routes: {
    "/": () => file(`${PUBLIC}/index.html`),
    "/r": () => file(`${PUBLIC}/index.html`), // reader view: /r#<id>, the id stays in the fragment

    "/health": () => new Response("ok"),
    "/health/deep": async () => {
      try {
        const start = performance.now();
        const reply = await kv("PING", [], "health");
        return json({ status: "ok", kv: reply, ms: Math.round((performance.now() - start) * 10) / 10 });
      } catch (err) {
        return json({ status: "error", error: (err as Error).message }, 503);
      }
    },

    "/api/platform": () => json(platform),
    "/api/pulse": async () => json({ ...(await pulse()), wire: wireTail() }),

    "/api/drops": {
      POST: async (req, srv) => {
        const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || srv.requestIP(req)?.address || "?";
        if (tooMany(ip)) return json({ error: "Too many messages from your network. Wait a minute and try again." }, 429);

        const body = (await req.json().catch(() => null)) as { message?: unknown; fuse?: unknown } | null;
        const message = typeof body?.message === "string" ? body.message : "";
        if (!message.trim()) return json({ error: "Write a message first." }, 400);
        if (Buffer.byteLength(message) > MAX_BYTES) return json({ error: `Messages are limited to ${MAX_BYTES} bytes.` }, 413);
        if (!isFuse(body?.fuse)) return json({ error: "Choose when the message burns." }, 400);
        if ((await pulse()).active >= MAX_ACTIVE) return json({ error: "The drop box is full. Try again in a minute." }, 503);

        const mark = wireMark();
        const drop = await sealDrop(message, body.fuse);
        return json({ ...drop, wire: wireSince(mark) }, 201);
      },
    },

    "/api/drops/open": {
      POST: async (req) => {
        const id = await readId(req);
        if (!id) return json({ error: "This link is not a valid dead drop." }, 400);
        const mark = wireMark();
        const result = await openDrop(id);
        return json({ ...result, wire: wireSince(mark) }, "burned" in result ? 410 : 200);
      },
    },

    "/api/drops/status": {
      POST: async (req) => {
        const id = await readId(req);
        if (!id) return json({ error: "This link is not a valid dead drop." }, 400);
        const mark = wireMark();
        const status = await dropStatus(id);
        return json({ ...status, wire: wireSince(mark) });
      },
    },
  },

  // Static assets: /css/* and /js/* only.
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (/^\/(css|js)\/[\w.-]+\.(css|js)$/.test(path)) {
      const asset = Bun.file(PUBLIC + path);
      if (await asset.exists()) return new Response(asset, { headers: HEADERS });
    }
    return json({ error: "Not found" }, 404);
  },

  error(err) {
    console.error(err);
    return json({ error: "The dead drop is unreachable right now. Try again in a moment." }, 500);
  },
});

console.log(`Dead drop listening on ${server.url} (Bun ${Bun.version}, KV ${endpoint.host}:${endpoint.port}${endpoint.tls ? " TLS" : ""})`);

// Seed the decoy dossiers. Retries if Materia KV is not reachable yet.
async function seed(attempt = 1): Promise<void> {
  try {
    console.log(`Seed: ${await seedDecoys()} decoy dossier(s) created`);
  } catch (err) {
    console.error(`Seed failed (attempt ${attempt}): ${(err as Error).message}`);
    if (attempt < 5) setTimeout(() => seed(attempt + 1), 10_000);
  }
}
seed();

process.on("SIGTERM", () => {
  server.stop();
  client.close();
  process.exit(0);
});
