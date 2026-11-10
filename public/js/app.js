// Two scenes on one page: "/" leaves a message, "/r#<id>" reads it once.
// The id stays in the URL fragment: browsers never send it to the server or to
// link previewers, so a chat app unfurling the link cannot burn it by accident.
import { clock, countdown, printWire, pulseNow, remember, startPulse } from "./wire.js";
import { prepareBurn } from "./burn.js";

const $ = (id) => document.getElementById(id);
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const isReader = location.pathname === "/r";

const SAMPLE =
  "Agent,\n\nThe client meeting is at 10:00. Show them this page, then let it burn.\n" +
  "Materia KV keeps no copy: the first read deletes the key.\n\nHQ";

async function post(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({ error: "Unexpected answer from the server." }));
  printWire(data.wire);
  return { res, data };
}

/* ---------- Page setup ---------- */
document.querySelectorAll("[data-scene]").forEach((node) => {
  node.hidden = node.dataset.scene !== (isReader ? "read" : "compose");
});
typeTitle();
startPulse();
loadPlatform();
if (isReader) reader();
else composer();
// Pasting another /r#… link into the same tab only changes the fragment: start over.
addEventListener("hashchange", () => location.pathname === "/r" && location.hash.length > 1 && location.reload());

// The one page-load moment: the title types itself.
async function typeTitle() {
  const span = document.querySelector(".intro__typed");
  if (reduced) return;
  const text = span.textContent;
  span.textContent = "";
  span.classList.add("is-typing");
  for (const ch of text) {
    span.textContent += ch;
    await wait(ch === " " ? 70 : 38 + Math.random() * 40);
  }
  await wait(1800);
  span.classList.remove("is-typing");
}

async function loadPlatform() {
  const labels = {
    CC_APP_NAME: "Application", APP_ID: "App ID", INSTANCE_NUMBER: "Instance", INSTANCE_TYPE: "Instance type",
    CC_PRETTY_INSTANCE_NAME: "Instance name", CC_COMMIT_ID: "Commit", CC_DEPLOYMENT_ID: "Deployment",
  };
  try {
    const p = await (await fetch("/api/platform")).json();
    const live = Boolean(p.APP_ID); // Clever Cloud injects APP_ID; without it this is a local run
    $("liveText").textContent = live ? "Live on Clever Cloud" : "Local · not on Clever Cloud";
    $("livePill").classList.toggle("cc-pill--live", live);
    $("livePill").classList.toggle("cc-pill--muted", !live);
    $("livePill").firstElementChild.classList.toggle("cc-dot--muted", !live);
    const dl = $("platformVars");
    for (const [key, label] of Object.entries(labels)) {
      const box = document.createElement("div");
      const dt = document.createElement("dt");
      const dd = document.createElement("dd");
      dt.textContent = label;
      dd.textContent = p[key] ?? "not set (local run)";
      if (p[key] == null) dd.className = "is-empty";
      box.append(dt, dd);
      dl.append(box);
    }
    $("stackPill").textContent = `Bun ${p.bun} + Materia KV`;
    $("wireEndpoint").textContent = p.kv.tls
      ? `Bun ${p.bun} RedisClient, TLS to ${p.kv.host}:${p.kv.port}`
      : `Bun ${p.bun} RedisClient, local ${p.kv.host}:${p.kv.port} (no TLS)`;
  } catch { /* the panel stays empty */ }
}

/* ---------- Scene 1: leave a message ---------- */
function composer() {
  const form = $("composeForm"), ta = $("message"), bytes = $("bytes"), error = $("composeError");
  const encoder = new TextEncoder();
  let stopWatch = () => {};

  const countBytes = () => {
    const n = encoder.encode(ta.value).length;
    bytes.textContent = `${n} / 2048 bytes`;
    bytes.classList.toggle("is-over", n > 2048);
    return n;
  };
  ta.addEventListener("input", countBytes);
  $("sample").addEventListener("click", () => { ta.value = SAMPLE; countBytes(); ta.focus(); });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.hidden = true;
    if (!ta.value.trim()) return fail("Write a message first.");
    if (countBytes() > 2048) return fail("Messages are limited to 2048 bytes. Shorten it a little.");
    const fuse = form.ownerDocument.querySelector('input[name="fuse"]:checked').value;
    $("sealBtn").disabled = true;
    try {
      const { res, data } = await post("/api/drops", { message: ta.value, fuse });
      if (!res.ok) return fail(data.error ?? "The dead drop is unreachable right now.");
      remember(data.code);
      seal(ta.value, data.code);
      stopWatch = receipt(data);
      pulseNow();
    } catch {
      fail("The dead drop is unreachable right now. Check your connection and try again.");
    } finally {
      $("sealBtn").disabled = false;
    }
  });

  $("again").addEventListener("click", () => {
    stopWatch();
    form.classList.remove("is-sealed");
    $("sealedText").replaceChildren();
    $("sealedText").hidden = true;
    ta.hidden = false;
    ta.value = "";
    countBytes();
    $("fileNo").textContent = "pending";
    $("receipt").hidden = true;
    $("fuseSet").hidden = false;
    document.querySelector(".slip__rule").hidden = false;
    ta.focus();
  });

  function fail(message) {
    error.textContent = message;
    error.hidden = false;
  }
}

// The sealing moment: the text is redacted line by line, then the stamp lands.
function seal(text, code) {
  const sealed = $("sealedText");
  sealed.textContent = text;
  sealed.hidden = false;
  $("message").hidden = true;
  $("fileNo").textContent = code;

  const range = document.createRange();
  range.selectNodeContents(sealed);
  const box = sealed.getBoundingClientRect();
  const rects = [...range.getClientRects()].filter((r) => r.width > 2);
  const step = Math.min(55, 520 / Math.max(1, rects.length));
  rects.forEach((r, i) => {
    const bar = document.createElement("span");
    bar.className = "bar";
    Object.assign(bar.style, {
      left: `${r.left - box.left - 3}px`, top: `${r.top - box.top - 1}px`,
      width: `${r.width + 6}px`, height: `${r.height + 2}px`, animationDelay: `${i * step}ms`,
    });
    sealed.append(bar);
  });
  $("composeForm").classList.add("is-sealed");
}

// Receipt: the one-time link, and a live status read from Materia KV (PTTL).
function receipt({ id, code, fuse }) {
  const link = `${location.origin}/r#${id}`;
  $("fuseSet").hidden = true;
  document.querySelector(".slip__rule").hidden = true;
  $("receipt").hidden = false;
  $("receiptCode").textContent = code;
  $("receiptLink").value = link;
  $("openSelf").href = link;

  const copy = $("copyLink");
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(link); } catch { $("receiptLink").select(); document.execCommand("copy"); }
    copy.textContent = "Copied";
    setTimeout(() => (copy.textContent = "Copy link"), 1600);
  };

  const status = $("receiptStatus");
  let expiresAt = 0, done = false;
  const show = (parts, burned = false) => {
    status.replaceChildren(...parts);
    status.classList.toggle("is-burned", burned);
  };
  const b = (text) => Object.assign(document.createElement("b"), { textContent: text });
  const render = () => {
    if (done || !expiresAt) return;
    const left = countdown(expiresAt - Date.now());
    show(fuse === "read" ? ["Waiting for its reader. Burns unread in ", b(left), "."] : ["Waiting. Burns unread in ", b(left), "."]);
  };
  const poll = async () => {
    if (done) return;
    try {
      const { data } = await post("/api/drops/status", { id });
      if (data.state === "pending") expiresAt = Date.now() + data.pttl;
      if (data.state === "burned") {
        done = true;
        show(data.how === "read"
          ? ["Burned. Opened at ", b(clock(data.at)), " and deleted in the same step."]
          : ["Burned. The fuse ran out before anyone opened it."], true);
        return;
      }
    } catch { /* retry */ }
    render();
    setTimeout(poll, 2000);
  };
  const timer = setInterval(render, 250);
  poll();
  return () => { done = true; clearInterval(timer); };
}

/* ---------- Scene 2: read once ---------- */
async function reader() {
  const id = location.hash.slice(1);
  if (!/^[A-Za-z0-9_-]{22}$/.test(id)) {
    return aftermath("This link is not a valid dead drop.", "Check that you copied the whole link, including the part after #.");
  }
  const { data } = await post("/api/drops/status", { id });
  $("coverCode").textContent = data.code ?? "····";
  if (data.state !== "pending") return burnedEarlier(data);

  const fuseText = $("coverFuse");
  const expiresAt = Date.now() + data.pttl;
  const showFuse = () => {
    const b = Object.assign(document.createElement("b"), { textContent: countdown(expiresAt - Date.now()) });
    fuseText.replaceChildren(data.pttl > 3_700_000 ? "Burns on first read. Shelf life " : "Burns unread in ", b, ".");
  };
  showFuse();
  const fuseTimer = setInterval(showFuse, 250);

  const button = $("breakSeal");
  button.disabled = false;
  button.addEventListener("click", async () => {
    button.disabled = true;
    clearInterval(fuseTimer);
    const { res, data: drop } = await post("/api/drops/open", { id });
    pulseNow();
    if (res.status === 410) return burnedEarlier({ state: "burned", ...drop.burned });
    if (!res.ok) {
      fuseText.textContent = drop.error ?? "The dead drop is unreachable right now.";
      button.disabled = false;
      return;
    }
    history.replaceState(null, "", "/r"); // the id leaves the address bar and the history
    await revealSheet(drop);
  }, { once: true });
}

async function revealSheet(drop) {
  const cover = $("cover"), sheet = $("readSheet"), text = $("readText");
  cover.classList.add("is-opening");
  await wait(reduced ? 0 : 700);
  cover.hidden = true;
  $("readCode").textContent = drop.code;
  $("readSealed").textContent = clock(drop.sealedAt).slice(0, 5);
  $("readOpened").textContent = clock(drop.readAt).slice(0, 5);
  sheet.hidden = false;
  await wait(reduced ? 0 : 450);
  await typewrite(text, drop.message);

  let left = Math.min(30, Math.max(8, Math.round(drop.message.length / 18) + 6));
  $("fuseCount").textContent = String(left);
  $("fuseLine").hidden = false;
  const size = () => `${sheet.offsetWidth}x${sheet.offsetHeight}`;
  let fire = reduced ? null : prepareBurn(sheet, $("stage")); // heavy maths now, while the fuse burns
  let preparedFor = size();
  let lit = false;
  const ignite = async () => {
    if (lit) return;
    lit = true;
    clearInterval(tick);
    $("fuseLine").querySelectorAll("button").forEach((btn) => (btn.disabled = true));
    sheet.classList.add("is-burning");
    if (fire) {
      if (size() !== preparedFor) fire = prepareBurn(sheet, $("stage")); // the layout changed meanwhile
      await fire.ignite();
    }
    sheet.hidden = true;
    aftermath("This message has self-destructed.", [
      "Materia KV deleted it the moment you opened it (",
      Object.assign(document.createElement("code"), { textContent: `GETDEL at ${clock(drop.readAt)}` }),
      "). What you just read was the only copy.",
    ]);
  };
  const tick = setInterval(() => {
    left -= 1;
    $("fuseCount").textContent = String(Math.max(0, left));
    if (left <= 0) ignite();
  }, 1000);
  $("burnNow").addEventListener("click", ignite);
  $("copyMsg").addEventListener("click", async (e) => {
    try { await navigator.clipboard.writeText(drop.message); e.target.textContent = "Copied"; } catch { e.target.textContent = "Select and copy"; }
  });
}

// Typewriter reveal. Text only: the message is never parsed as HTML. Click to skip.
function typewrite(node, message) {
  if (reduced) { node.textContent = message; return Promise.resolve(); }
  const chars = [...message];
  const textNode = document.createTextNode("");
  const caret = Object.assign(document.createElement("span"), { className: "caret" });
  node.replaceChildren(textNode, caret);
  const perChar = Math.min(48, Math.max(9, 2400 / chars.length));
  return new Promise((resolve) => {
    const start = performance.now();
    let skip = false;
    node.closest(".sheet").addEventListener("click", () => (skip = true), { once: true });
    const step = (now) => {
      const n = skip ? chars.length : Math.min(chars.length, Math.floor((now - start) / perChar));
      textNode.data = chars.slice(0, n).join("");
      if (n < chars.length) requestAnimationFrame(step);
      else { caret.remove(); resolve(); }
    };
    requestAnimationFrame(step);
  });
}

function burnedEarlier(info) {
  const detail = info.how === "read"
    ? ["It was opened at ", Object.assign(document.createElement("b"), { textContent: clock(info.at) }), " and deleted in the same step. Nothing is left to read."]
    : "Its fuse burned out before anyone opened it, or the link is incomplete.";
  aftermath("This message has self-destructed.", detail);
}

function aftermath(title, detail) {
  $("cover").hidden = true;
  $("readSheet").hidden = true;
  $("afterTitle").textContent = title;
  const text = $("afterText");
  if (Array.isArray(detail)) text.replaceChildren(...detail);
  else text.textContent = detail;
  $("aftermath").hidden = false;
}
