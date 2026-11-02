// Live panels fed by GET /api/pulse every 2.5 s: the intercepted wire log,
// the burned counter, the "active right now" gauge and the board of waiting drops.
// Everything user-visible is written with textContent: nothing is parsed as HTML.

const $ = (id) => document.getElementById(id);
const FUSE_TTL = { read: 86400, "30s": 30, "5m": 300, "1h": 3600 };
const FUSE_LABEL = { read: "Burns on first read", "30s": "30-second fuse", "5m": "5-minute fuse", "1h": "1-hour fuse" };
const WRITES = new Set(["SET", "GETDEL", "SADD", "SREM", "INCR"]);

const el = (tag, cls = "", text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
export const clock = (ms, withMs = false) => {
  const d = new Date(ms);
  const hms = d.toLocaleTimeString("en-GB", { hour12: false });
  return withMs ? `${hms}.${String(d.getMilliseconds()).padStart(3, "0")}` : hms;
};
export const countdown = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  const two = (n) => String(n).padStart(2, "0");
  return hh ? `${hh}:${two(mm)}:${two(ss)}` : `${two(mm)}:${two(ss)}`;
};

// Codes of the dossiers sealed from this browser, to mark them on the board.
const mine = new Set(readMine());
function readMine() {
  try { return JSON.parse(localStorage.getItem("dead-drop:mine") || "[]"); } catch { return []; }
}
export function remember(code) {
  mine.add(code);
  try { localStorage.setItem("dead-drop:mine", JSON.stringify([...mine].slice(-30))); } catch { /* private mode */ }
}

/* ---------- Wire log ---------- */
const seen = new Set();
const seq = (e) => Number(e.id.split("-").pop());

export function printWire(entries = []) {
  const roll = $("wireRoll"), lines = $("wireLines");
  const fresh = entries.filter((e) => !seen.has(e.id)).sort((a, b) => a.at - b.at || seq(a) - seq(b));
  if (!fresh.length) return;
  const atBottom = roll.scrollHeight - roll.scrollTop - roll.clientHeight < 60;
  for (const e of fresh) {
    seen.add(e.id);
    lines.append(line(e));
  }
  while (lines.children.length > 80) lines.firstElementChild.remove();
  if (atBottom) roll.scrollTop = roll.scrollHeight;
  if (fresh.some((e) => WRITES.has(e.cmd) && e.tag !== "sweep")) ack();
}

function line(e) {
  const li = el("li", `w w--${e.tag}`);
  const meta = el("div", "w__meta");
  const lat = el("span", "w__lat");
  lat.style.width = `${Math.min(60, 3 + e.ms * 2)}px`;
  meta.append(el("span", "", clock(e.at, true)), el("span", "", e.tag), el("span", "w__ms", `${e.ms.toFixed(1)} ms`), lat);
  const cmd = el("div", "w__cmd");
  cmd.append(el("b", "", e.cmd), ` ${e.args.join(" ")}`);
  const nil = e.reply === "(nil)" || e.reply === "-2";
  li.append(meta, cmd, el("div", `w__reply${nil ? " is-nil" : ""}`, `→ ${e.reply}`));
  return li;
}

// Three datacenters light up when a write is acknowledged.
function ack() {
  const r = $("replicas");
  r.classList.remove("is-acked");
  void r.offsetWidth; // restart the animation
  r.classList.add("is-acked");
}

/* ---------- Burned counter: one wheel per digit ---------- */
function setBurned(n) {
  const wheels = $("burnedWheels");
  const digits = String(n).padStart(4, "0");
  while (wheels.children.length < digits.length) {
    const wheel = el("span", "wheel");
    const strip = el("span", "wheel__strip");
    for (let d = 0; d < 10; d++) strip.append(el("span", "", String(d)));
    wheel.append(strip);
    wheels.prepend(wheel);
  }
  [...wheels.children].forEach((wheel, i) => {
    wheel.firstElementChild.style.transform = `translateY(${-Number(digits[i]) * 10}%)`;
  });
  $("burnedText").textContent = `${n} `;
}

/* ---------- Gauge: active drops ---------- */
const SCALES = [10, 25, 50, 100, 250, 500];
let gaugeMax = 0;

function setActive(n) {
  const max = SCALES.find((s) => n <= s) ?? 500;
  if (max !== gaugeMax) drawTicks((gaugeMax = max));
  $("gaugeNeedle").style.transform = `rotate(${-90 + 180 * Math.min(n / max, 1)}deg)`;
  $("activeCount").textContent = String(n);
}

function drawTicks(max) {
  const svg = "http://www.w3.org/2000/svg";
  const g = $("gaugeTicks");
  g.replaceChildren();
  const at = (frac, r) => {
    const a = Math.PI + frac * Math.PI;
    return [100 + r * Math.cos(a), 106 + r * Math.sin(a)];
  };
  const zone = document.createElementNS(svg, "path");
  const [zx1, zy1] = at(0.8, 80), [zx2, zy2] = at(1, 80);
  zone.setAttribute("d", `M${zx1} ${zy1} A80 80 0 0 1 ${zx2} ${zy2}`);
  zone.setAttribute("class", "zone");
  g.append(zone);
  for (let i = 0; i <= 20; i++) {
    const major = i % 5 === 0;
    const [x1, y1] = at(i / 20, 86), [x2, y2] = at(i / 20, major ? 70 : 77);
    const tick = document.createElementNS(svg, "line");
    Object.entries({ x1, y1, x2, y2 }).forEach(([k, v]) => tick.setAttribute(k, v.toFixed(1)));
    if (major) tick.setAttribute("class", "major");
    g.append(tick);
  }
  $("gaugeMax").textContent = String(max);
}

/* ---------- Board of waiting drops ---------- */
const tags = new Map(); // code -> { li, fuse, expiresAt, time, bar }

function renderBoard(drops) {
  const board = $("board");
  const live = new Set(drops.map((d) => d.code));
  for (const code of tags.keys()) if (!live.has(code)) burnTag(code);

  for (const d of drops) {
    const expiresAt = Date.now() + d.pttl;
    const known = tags.get(d.code);
    if (known) { known.expiresAt = expiresAt; continue; }
    const li = el("li", "tag");
    const time = el("p", "tag__time");
    const bar = el("i");
    const track = el("div", "tag__bar");
    track.append(bar);
    li.append(el("p", "tag__code", d.code), el("p", "tag__fuse", FUSE_LABEL[d.fuse] ?? d.fuse), time, track);
    if (mine.has(d.code)) li.append(el("span", "tag__mine", "Yours"));
    const entry = { li, fuse: d.fuse, expiresAt, time, bar };
    tags.set(d.code, entry);
    // keep the soonest-to-burn first, without moving existing tags
    const next = [...tags.values()].find((t) => t !== entry && t.li.isConnected && !t.burning && t.expiresAt > expiresAt);
    board.insertBefore(li, next ? next.li : null);
  }
  tickBoard();
  $("boardEmpty").hidden = tags.size > 0;
}

function tickBoard() {
  const now = Date.now();
  for (const [code, t] of tags) {
    if (t.burning) continue;
    const left = t.expiresAt - now;
    t.time.textContent = countdown(left);
    t.bar.style.width = `${Math.max(0, Math.min(100, (left / 1000 / FUSE_TTL[t.fuse]) * 100))}%`;
    if (left <= 0) burnTag(code);
  }
}

function burnTag(code) {
  const t = tags.get(code);
  if (!t || t.burning) return;
  t.burning = true;
  t.li.classList.add("is-burning");
  const remove = () => {
    t.li.remove();
    tags.delete(code);
    $("boardEmpty").hidden = tags.size > 0;
  };
  t.li.addEventListener("animationend", remove, { once: true });
  setTimeout(remove, 1500); // reduced motion: no animationend
}

/* ---------- Polling ---------- */
function apply(p) {
  setBurned(p.burned);
  setActive(p.active);
  renderBoard(p.drops);
  printWire(p.wire);
}

export async function pulseNow() {
  try {
    const res = await fetch("/api/pulse");
    if (res.ok) apply(await res.json());
  } catch { /* offline for a moment: next poll retries */ }
}

export function startPulse() {
  setBurned(0);
  setActive(0);
  const loop = async () => {
    if (document.visibilityState === "visible") await pulseNow();
    setTimeout(loop, 2500);
  };
  loop();
  setInterval(tickBoard, 250);
}
