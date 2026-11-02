// Burns an element away on a canvas laid exactly over it.
// A noise field decides when each pixel catches fire (a corner first, then ragged),
// the edge glows in the Clever palette, the paper chars, sparks and ash fly off.
// prepareBurn() does the heavy maths up front (during the fuse countdown).

const EMBER = [[255, 246, 214], [252, 185, 0], [245, 116, 97], [203, 28, 66]]; // white-hot, gold, orange, cherry
const CHAR = [48, 24, 10];
const SCORCH = [156, 92, 28];

export function prepareBurn(target, stage) {
  const W = target.offsetWidth + 2, H = target.offsetHeight + 2; // 1 px margin: offset sizes are rounded
  const scale = Math.min(1, Math.sqrt(360000 / (W * H)));
  const w = Math.max(1, Math.round(W * scale)), h = Math.max(1, Math.round(H * scale));

  // When does each pixel burn? 0 = first, 1 = last.
  const noise = valueNoise();
  const field = new Float32Array(w * h);
  const fromLeft = Math.random() < 0.5;
  const ox = fromLeft ? -0.05 * w : 1.05 * w, oy = 1.05 * h;
  const reach = Math.hypot(w * 1.1, h * 1.1);
  const f = 1 / (70 * scale); // noise cell ~70 CSS px
  let lo = Infinity, hi = -Infinity;
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      const n = 0.5 * noise(x * f, y * f) + 0.3 * noise(x * f * 2.1, y * f * 2.1) + 0.2 * noise(x * f * 4.3, y * f * 4.3);
      const v = 0.66 * (Math.hypot(x - ox, y - oy) / reach) + 0.34 * n;
      field[i] = v;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  for (let i = 0; i < field.length; i++) field[i] = (field[i] - lo) / (hi - lo);

  return { ignite: () => ignite({ target, stage, W, H, w, h, scale, field }) };
}

function ignite({ target, stage, W, H, w, h, scale, field }) {
  return new Promise((resolve) => {
    const desk = rgb(getComputedStyle(stage).backgroundColor);
    const left = target.offsetLeft - 1, top = target.offsetTop - 1;

    // Burn layer: same box and same rotation as the sheet.
    const paper = document.createElement("canvas");
    paper.className = "burn-canvas";
    paper.width = w;
    paper.height = h;
    Object.assign(paper.style, { left: `${left}px`, top: `${top}px`, width: `${W}px`, height: `${H}px`, transform: getComputedStyle(target).transform });

    // Particle layer: the whole stage.
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const sw = stage.clientWidth, sh = stage.clientHeight;
    const sparks = document.createElement("canvas");
    sparks.className = "spark-canvas";
    sparks.width = sw * dpr;
    sparks.height = sh * dpr;
    Object.assign(sparks.style, { left: "0px", top: "0px", width: `${sw}px`, height: `${sh}px` });
    stage.append(paper, sparks);

    const pctx = paper.getContext("2d");
    const sctx = sparks.getContext("2d");
    sctx.scale(dpr, dpr);
    const img = pctx.createImageData(w, h);
    const buf = new Uint32Array(img.data.buffer);
    const DESK = pack(desk, 255);
    const emberLut = lut(64, (k) => pack(k < 0.85 ? mixStops(EMBER, k / 0.85) : mix(EMBER[3], desk, (k - 0.85) / 0.15), 255));
    const charLut = lut(64, (k) => pack(CHAR, Math.round(255 * 0.96 * Math.pow(k, 1.4))));
    const scorchLut = lut(64, (k) => pack(SCORCH, Math.round(255 * 0.38 * k)));

    const particles = [];
    const DURATION = 3000;
    const start = performance.now();
    let last = start;

    const frame = (now) => {
      const p = Math.min(1, (now - start) / DURATION);
      const dt = Math.min(48, now - last) / 16.7;
      last = now;
      const t = -0.08 + p * 1.25 * (0.6 + 0.4 * p); // slow catch, then it races
      const band = 0.032 * (0.85 + Math.random() * 0.3); // flickering ember width

      for (let i = 0; i < buf.length; i++) {
        const v = field[i] - t;
        if (v >= 0.12) buf[i] = 0;
        else if (v >= 0.05) buf[i] = scorchLut[((0.12 - v) / 0.07 * 63) | 0];
        else if (v >= 0) buf[i] = charLut[((0.05 - v) / 0.05 * 63) | 0];
        else if (v > -band) buf[i] = emberLut[((-v / band) * 63) | 0];
        else buf[i] = DESK;
      }
      pctx.putImageData(img, 0, 0);

      // Sparks and ash from the burning edge.
      if (p < 0.97) {
        for (let k = 0; k < 90 && particles.length < 260; k++) {
          const i = (Math.random() * buf.length) | 0;
          const v = field[i] - t;
          if (v > -band && v < 0.01) {
            const ash = Math.random() < 0.28;
            particles.push({
              x: left + (i % w) / scale, y: top + ((i / w) | 0) / scale,
              vx: (Math.random() - 0.5) * 0.8, vy: -(0.5 + Math.random() * (ash ? 0.8 : 1.9)),
              age: 0, life: ash ? 1400 + Math.random() * 1200 : 450 + Math.random() * 800,
              r: ash ? 1.5 + Math.random() * 2.5 : 0.7 + Math.random() * 1.7, ash, spin: Math.random() * 6,
            });
            if (Math.random() < 0.5) break;
          }
        }
      }
      sctx.clearRect(0, 0, sw, sh);
      for (let j = particles.length - 1; j >= 0; j--) {
        const s = particles[j];
        s.age += dt * 16.7;
        if (s.age > s.life) { particles.splice(j, 1); continue; }
        s.vx += (Math.random() - 0.5) * 0.09 * dt;
        s.vy -= 0.012 * dt;
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        const k = s.age / s.life;
        if (s.ash) {
          sctx.globalCompositeOperation = "source-over";
          sctx.fillStyle = `rgba(40, 36, 40, ${0.75 * (1 - k)})`;
          sctx.save();
          sctx.translate(s.x, s.y);
          sctx.rotate(s.spin + k * 4);
          sctx.fillRect(-s.r, -s.r * 0.6, s.r * 2, s.r * 1.2);
          sctx.restore();
        } else {
          const [r, g, b] = mixStops(EMBER, Math.min(1, 0.15 + k));
          sctx.globalCompositeOperation = "lighter";
          sctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${1 - k})`;
          sctx.beginPath();
          sctx.arc(s.x, s.y, s.r * (1 - k * 0.5), 0, Math.PI * 2);
          sctx.fill();
        }
      }

      if (p >= 1 && paper.isConnected) {
        // The paper is gone: hand over now, let the last ash drift on top.
        target.style.visibility = "hidden";
        paper.remove();
        resolve();
      }
      if (p < 1 || particles.length) requestAnimationFrame(frame);
      else sparks.remove();
    };
    requestAnimationFrame(frame);
  });
}

/* ---------- helpers ---------- */
function valueNoise() {
  const perm = new Uint8Array(512);
  const base = [...Array(256).keys()].sort(() => Math.random() - 0.5);
  for (let i = 0; i < 512; i++) perm[i] = base[i & 255];
  const val = (x, y) => perm[(perm[x & 255] + y) & 255] / 255;
  return (x, y) => {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = val(ix, iy), b = val(ix + 1, iy), c = val(ix, iy + 1), d = val(ix + 1, iy + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}
const pack = ([r, g, b], a) => ((a << 24) | (b << 16) | (g << 8) | r) >>> 0; // little-endian RGBA
const mix = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
function mixStops(stops, k) {
  const x = Math.max(0, Math.min(0.9999, k)) * (stops.length - 1);
  const i = Math.floor(x);
  return mix(stops[i], stops[i + 1], x - i);
}
function lut(n, fn) {
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) out[i] = fn(i / (n - 1));
  return out;
}
function rgb(css) {
  const m = css.match(/\d+(\.\d+)?/g) || ["23", "27", "55"];
  return m.slice(0, 3).map(Number);
}
