// JSDOM 2d stand-in for the local risk-control playground test.
// Page glyphs and the solver templates share this rasterizer.

const contexts = new WeakMap();
const colorCache = new Map();
const stampCache = new Map();
const TAU = Math.PI * 2;

function parseColor(input) {
  if (input && typeof input === "object") return null;
  const key = String(input ?? "#000").trim();
  const hit = colorCache.get(key);
  if (hit) return hit;
  let color = { r: 0, g: 0, b: 0, a: 1 };
  if (key[0] === "#") {
    let h = key.slice(1);
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (h.length === 6 || h.length === 8) {
      color = {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
      };
    }
  } else {
    const m = key.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
    if (m) {
      color = {
        r: Math.max(0, Math.min(255, Number(m[1]))),
        g: Math.max(0, Math.min(255, Number(m[2]))),
        b: Math.max(0, Math.min(255, Number(m[3]))),
        a: m[4] === undefined ? 1 : Math.max(0, Math.min(1, Number(m[4])))
      };
    }
  }
  colorCache.set(key, color);
  return color;
}

function oddSide(fontSize) {
  const raw = 0.42 * fontSize;
  let side = Math.round(raw);
  if (side % 2 === 0) {
    const down = side - 1;
    const up = side + 1;
    side = raw - down <= up - raw ? down : up;
  }
  if (side < 1) side = 1;
  return side;
}

function sectorCells(R) {
  const cells = [];
  for (let dx = 2; dx <= R; dx++) {
    for (let dy = 1; dy < dx; dy++) cells.push(dx, dy);
  }
  for (let dx = 1; dx <= R; dx++) cells.push(dx, 0);
  for (let d = 1; d <= R; d++) cells.push(d, d);
  return cells;
}

function setCell(mask, side, R, x, y) {
  const ix = x + R;
  const iy = y + R;
  if (ix >= 0 && iy >= 0 && ix < side && iy < side) mask[iy * side + ix] = 1;
}

function mirrorOn(mask, side, R, dx, dy) {
  if (dy === 0) {
    setCell(mask, side, R, dx, 0);
    setCell(mask, side, R, -dx, 0);
    setCell(mask, side, R, 0, dx);
    setCell(mask, side, R, 0, -dx);
    return;
  }
  if (dx === dy) {
    setCell(mask, side, R, dx, dy);
    setCell(mask, side, R, dx, -dy);
    setCell(mask, side, R, -dx, dy);
    setCell(mask, side, R, -dx, -dy);
    return;
  }
  setCell(mask, side, R, dx, dy);
  setCell(mask, side, R, dx, -dy);
  setCell(mask, side, R, -dx, dy);
  setCell(mask, side, R, -dx, -dy);
  setCell(mask, side, R, dy, dx);
  setCell(mask, side, R, dy, -dx);
  setCell(mask, side, R, -dy, dx);
  setCell(mask, side, R, -dy, -dx);
}

function choose(n, k) {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  let result = 1;
  for (let i = 1; i <= k; i++) result = (result * (n - k + i)) / i;
  return Math.round(result);
}

function weightBits(cp, bits, weight) {
  const on = new Uint8Array(bits);
  const total = choose(bits, weight) || 1;
  let index = cp % total;
  let left = weight;
  for (let i = bits - 1; i >= 0 && left > 0; i--) {
    const ways = choose(i, left);
    if (ways <= index) {
      on[i] = 1;
      index -= ways;
      left--;
    }
  }
  return on;
}

function stampFor(cp, fontSize) {
  const key = fontSize + ":" + cp;
  const cached = stampCache.get(key);
  if (cached) return cached;
  const side = oddSide(fontSize);
  const R = (side - 1) >> 1;
  const mask = new Uint8Array(side * side);
  const sector = sectorCells(R);
  const n = sector.length >> 1;
  let bits = n;
  let weight = Math.max(1, n >> 1);
  if (R >= 5) {
    bits = 20;
    weight = 10;
  } else if (R === 4) {
    bits = 14;
    weight = 7;
  }
  const use = Math.min(bits, n);
  const on = weightBits(cp, use, Math.min(weight, use));
  for (let i = 0; i < use; i++) {
    if (on[i]) mirrorOn(mask, side, R, sector[i * 2], sector[i * 2 + 1]);
  }
  setCell(mask, side, R, 0, 0);
  const stamp = { side, R, mask };
  stampCache.set(key, stamp);
  return stamp;
}

function fontSizeOf(font) {
  const m = String(font).match(/([\d.]+)px/);
  return m ? Number(m[1]) : 10;
}

class LinearGradient {
  constructor(x0, y0, x1, y1) {
    this.x0 = x0;
    this.y0 = y0;
    this.x1 = x1;
    this.y1 = y1;
    this.stops = [];
  }

  addColorStop(offset, color) {
    const t = Math.max(0, Math.min(1, Number(offset)));
    this.stops.push({ t, color: parseColor(color) });
    this.stops.sort((a, b) => a.t - b.t);
  }
}

function sampleGradient(g, ux, uy) {
  const dx = g.x1 - g.x0;
  const dy = g.y1 - g.y0;
  const den = dx * dx + dy * dy;
  let t = den === 0 ? 0 : ((ux - g.x0) * dx + (uy - g.y0) * dy) / den;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const stops = g.stops;
  if (!stops.length) return { r: 0, g: 0, b: 0, a: 0 };
  if (t <= stops[0].t) return stops[0].color;
  for (let i = 1; i < stops.length; i++) {
    const b = stops[i];
    if (t <= b.t) {
      const a = stops[i - 1];
      const span = b.t - a.t || 1;
      const u = (t - a.t) / span;
      return {
        r: Math.round(a.color.r + (b.color.r - a.color.r) * u),
        g: Math.round(a.color.g + (b.color.g - a.color.g) * u),
        b: Math.round(a.color.b + (b.color.b - a.color.b) * u),
        a: a.color.a + (b.color.a - a.color.a) * u
      };
    }
  }
  return stops[stops.length - 1].color;
}

function pushEdge(edges, a, b) {
  if (a.y === b.y) return;
  edges.push({
    x1: a.x,
    y1: a.y,
    x2: b.x,
    y2: b.y,
    dir: b.y > a.y ? 1 : -1
  });
}

function buildEdges(subs, implicitClose) {
  const edges = [];
  for (let s = 0; s < subs.length; s++) {
    const sub = subs[s];
    const pts = sub.pts;
    const n = pts.length;
    if (n < 2) continue;
    for (let i = 0; i < n - 1; i++) pushEdge(edges, pts[i], pts[i + 1]);
    const a = pts[n - 1];
    const b = pts[0];
    if ((a.x !== b.x || a.y !== b.y) && (sub.closed || implicitClose)) pushEdge(edges, a, b);
  }
  return edges;
}

class SoftContext {
  constructor(canvas) {
    this.canvas = canvas;
    this._inReset = false;
    this.buf = new Uint8ClampedArray(0);
    this.w = 0;
    this.h = 0;
    this._reset();
  }

  _reset() {
    const w = Math.max(0, this.canvas.width | 0);
    const h = Math.max(0, this.canvas.height | 0);
    const n = w * h * 4;
    if (!this.buf || this.buf.length !== n) this.buf = new Uint8ClampedArray(n);
    else this.buf.fill(0);
    this.w = w;
    this.h = h;
    this.a = 1;
    this.b = 0;
    this.c = 0;
    this.d = 1;
    this.e = 0;
    this.f = 0;
    this.subs = [];
    this.sub = null;
    this.hasPen = false;
    this.ux = 0;
    this.uy = 0;
    this.sx = 0;
    this.sy = 0;
    this.clipMask = null;
    this.stack = [];
    this.fillStyle = "#000";
    this.strokeStyle = "#000";
    this.lineWidth = 1;
    this.font = "10px sans-serif";
    this.textAlign = "start";
    this.textBaseline = "alphabetic";
  }

  _identity() {
    return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0;
  }

  _tf(x, y) {
    return {
      x: this.a * x + this.c * y + this.e,
      y: this.b * x + this.d * y + this.f
    };
  }

  _inv(xd, yd) {
    const det = this.a * this.d - this.c * this.b || 1;
    const x = xd - this.e;
    const y = yd - this.f;
    return [(this.d * x - this.c * y) / det, (this.a * y - this.b * x) / det];
  }

  _blend(px, py, src) {
    if (px < 0 || py < 0 || px >= this.w || py >= this.h) return;
    const sa = src.a;
    if (sa <= 0) return;
    const buf = this.buf;
    const i = (py * this.w + px) * 4;
    const daB = buf[i + 3];
    if (daB === 0) {
      buf[i] = src.r;
      buf[i + 1] = src.g;
      buf[i + 2] = src.b;
      buf[i + 3] = Math.round(sa * 255);
      return;
    }
    if (sa >= 1) {
      buf[i] = src.r;
      buf[i + 1] = src.g;
      buf[i + 2] = src.b;
      buf[i + 3] = 255;
      return;
    }
    const da = daB / 255;
    const outA = sa + da * (1 - sa);
    const inv = da * (1 - sa);
    const dr = buf[i];
    const dg = buf[i + 1];
    const db = buf[i + 2];
    buf[i] = Math.round((src.r * sa + dr * inv) / outA);
    buf[i + 1] = Math.round((src.g * sa + dg * inv) / outA);
    buf[i + 2] = Math.round((src.b * sa + db * inv) / outA);
    buf[i + 3] = Math.round(outA * 255);
  }

  save() {
    this.stack.push({
      a: this.a,
      b: this.b,
      c: this.c,
      d: this.d,
      e: this.e,
      f: this.f,
      clip: this.clipMask ? this.clipMask.slice() : null,
      fillStyle: this.fillStyle,
      strokeStyle: this.strokeStyle,
      lineWidth: this.lineWidth,
      font: this.font,
      textAlign: this.textAlign,
      textBaseline: this.textBaseline
    });
  }

  restore() {
    const s = this.stack.pop();
    if (!s) return;
    this.a = s.a;
    this.b = s.b;
    this.c = s.c;
    this.d = s.d;
    this.e = s.e;
    this.f = s.f;
    this.clipMask = s.clip;
    this.fillStyle = s.fillStyle;
    this.strokeStyle = s.strokeStyle;
    this.lineWidth = s.lineWidth;
    this.font = s.font;
    this.textAlign = s.textAlign;
    this.textBaseline = s.textBaseline;
  }

  translate(tx, ty) {
    this.e = this.a * tx + this.c * ty + this.e;
    this.f = this.b * tx + this.d * ty + this.f;
  }

  rotate(rad) {
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const a = this.a;
    const b = this.b;
    const c = this.c;
    const d = this.d;
    this.a = a * cos + c * sin;
    this.b = b * cos + d * sin;
    this.c = c * cos - a * sin;
    this.d = d * cos - b * sin;
  }

  beginPath() {
    this.subs = [];
    this.sub = null;
    this.hasPen = false;
  }

  _openSub() {
    if (!this.sub || this.sub.pts.length) {
      this.sub = { pts: [], closed: false };
      this.subs.push(this.sub);
    }
  }

  moveTo(x, y) {
    this._openSub();
    this.ux = x;
    this.uy = y;
    this.sx = x;
    this.sy = y;
    this.hasPen = true;
    this.sub.pts.push(this._tf(x, y));
  }

  lineTo(x, y) {
    if (!this.hasPen) {
      this.moveTo(x, y);
      return;
    }
    this.ux = x;
    this.uy = y;
    this.sub.pts.push(this._tf(x, y));
  }

  closePath() {
    if (!this.hasPen || !this.sub) return;
    if (Math.hypot(this.ux - this.sx, this.uy - this.sy) > 1e-6) this.lineTo(this.sx, this.sy);
    this.sub.closed = true;
    this.ux = this.sx;
    this.uy = this.sy;
  }

  arc(cx, cy, radius, start, end, anticlockwise) {
    const r = Number(radius);
    if (!(r > 0)) return;
    let s = Number(start);
    let e = Number(end);
    const ac = !!anticlockwise;
    if (!ac && e < s) e += TAU;
    else if (ac && e > s) e -= TAU;
    let sweep = e - s;
    let full = Math.abs(sweep) >= TAU - 1e-9;
    if (full) sweep = sweep < 0 ? -TAU : TAU;
    const x0 = cx + r * Math.cos(s);
    const y0 = cy + r * Math.sin(s);
    if (full) this.moveTo(x0, y0);
    else if (this.hasPen) this.lineTo(x0, y0);
    else this.moveTo(x0, y0);
    if (Math.abs(sweep) < 1e-12) return;
    const dTheta = Math.min(2 / r, Math.PI / 8);
    const steps = Math.max(2, Math.ceil(Math.abs(sweep) / dTheta));
    for (let i = 1; i <= steps; i++) {
      const t = s + sweep * (i / steps);
      this.lineTo(cx + r * Math.cos(t), cy + r * Math.sin(t));
    }
    if (full) this.closePath();
  }

  quadraticCurveTo(cpx, cpy, x, y) {
    if (!this.hasPen) {
      this.moveTo(cpx, cpy);
    }
    const x0 = this.ux;
    const y0 = this.uy;
    const steps = 16;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const mt = 1 - t;
      this.lineTo(mt * mt * x0 + 2 * mt * t * cpx + t * t * x, mt * mt * y0 + 2 * mt * t * cpy + t * t * y);
    }
  }

  bezierCurveTo(c1x, c1y, c2x, c2y, x, y) {
    if (!this.hasPen) this.moveTo(c1x, c1y);
    const x0 = this.ux;
    const y0 = this.uy;
    const steps = 16;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const mt = 1 - t;
      const a = mt * mt * mt;
      const b = 3 * mt * mt * t;
      const c = 3 * mt * t * t;
      const d = t * t * t;
      this.lineTo(a * x0 + b * c1x + c * c2x + d * x, a * y0 + b * c1y + c * c2y + d * y);
    }
  }

  _rectPixels(x, y, w, h) {
    if (w < 0) {
      x += w;
      w = -w;
    }
    if (h < 0) {
      y += h;
      h = -h;
    }
    if (!(w > 0) || !(h > 0)) return null;
    let x0 = Math.ceil(x - 0.5);
    let y0 = Math.ceil(y - 0.5);
    let x1 = Math.ceil(x + w - 0.5);
    let y1 = Math.ceil(y + h - 0.5);
    if (x0 < 0) x0 = 0;
    if (y0 < 0) y0 = 0;
    if (x1 > this.w) x1 = this.w;
    if (y1 > this.h) y1 = this.h;
    if (x0 >= x1 || y0 >= y1) return null;
    return [x0, y0, x1, y1];
  }

  _paintRect(x, y, w, h, color, clear) {
    const bounds = this._rectPixels(x, y, w, h);
    if (!bounds) return;
    const [x0, y0, x1, y1] = bounds;
    const buf = this.buf;
    const width = this.w;
    const clip = this.clipMask;
    if (clear) {
      if (!clip && x0 === 0 && y0 === 0 && x1 === this.w && y1 === this.h) {
        buf.fill(0);
        return;
      }
      for (let py = y0; py < y1; py++) {
        const row = py * width;
        let i = (row + x0) * 4;
        for (let px = x0; px < x1; px++) {
          if (!clip || clip[row + px]) {
            buf[i] = 0;
            buf[i + 1] = 0;
            buf[i + 2] = 0;
            buf[i + 3] = 0;
          }
          i += 4;
        }
      }
      return;
    }
    if (color.a >= 1 && !clip) {
      for (let py = y0; py < y1; py++) {
        let i = (py * width + x0) * 4;
        for (let px = x0; px < x1; px++) {
          buf[i] = color.r;
          buf[i + 1] = color.g;
          buf[i + 2] = color.b;
          buf[i + 3] = 255;
          i += 4;
        }
      }
      return;
    }
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        if (clip && !clip[py * width + px]) continue;
        this._blend(px, py, color);
      }
    }
  }

  _walk(edges, paint) {
    if (!edges.length || this.w <= 0 || this.h <= 0) return;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      if (e.y1 < minY) minY = e.y1;
      if (e.y2 < minY) minY = e.y2;
      if (e.y1 > maxY) maxY = e.y1;
      if (e.y2 > maxY) maxY = e.y2;
    }
    let yStart = Math.ceil(minY - 0.5);
    let yEnd = Math.ceil(maxY - 0.5);
    if (yStart < 0) yStart = 0;
    if (yEnd > this.h) yEnd = this.h;
    const crossings = [];
    for (let y = yStart; y < yEnd; y++) {
      const ys = y + 0.5;
      crossings.length = 0;
      for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        const lo = e.y1 < e.y2 ? e.y1 : e.y2;
        const hi = e.y1 < e.y2 ? e.y2 : e.y1;
        if (ys >= lo && ys < hi) {
          const t = (ys - e.y1) / (e.y2 - e.y1);
          crossings.push(e.x1 + t * (e.x2 - e.x1), e.dir);
        }
      }
      const n = crossings.length >> 1;
      if (n < 2) continue;
      const order = new Array(n);
      for (let i = 0; i < n; i++) order[i] = i;
      order.sort((i, j) => crossings[i * 2] - crossings[j * 2]);
      let wind = 0;
      let prev = null;
      for (let k = 0; k < n; k++) {
        const idx = order[k];
        const x = crossings[idx * 2];
        const dir = crossings[idx * 2 + 1];
        if (prev !== null && x > prev && wind !== 0) {
          let x0 = Math.ceil(prev - 0.5);
          let x1 = Math.ceil(x - 0.5);
          if (x0 < 0) x0 = 0;
          if (x1 > this.w) x1 = this.w;
          if (x0 < x1) paint(x0, x1, y);
        }
        if (prev === null || x > prev) prev = x;
        wind += dir;
      }
    }
  }

  _paintPath(style, implicitClose, mode) {
    const edges = buildEdges(this.subs, implicitClose);
    const clip = this.clipMask;
    const width = this.w;
    const solid = mode === "fill" && !(style && typeof style === "object" && style.stops);
    const color = solid ? parseColor(style) : null;
    const opaque = solid && color.a >= 1;
    this._walk(edges, (x0, x1, y) => {
      if (mode === "clip") {
        const row = y * width;
        const mask = style;
        for (let x = x0; x < x1; x++) {
          if (!clip || clip[row + x]) mask[row + x] = 1;
        }
        return;
      }
      if (mode === "clear") {
        const buf = this.buf;
        const row = y * width;
        let i = (row + x0) * 4;
        for (let x = x0; x < x1; x++) {
          if (!clip || clip[row + x]) {
            buf[i] = 0;
            buf[i + 1] = 0;
            buf[i + 2] = 0;
            buf[i + 3] = 0;
          }
          i += 4;
        }
        return;
      }
      if (opaque && !clip) {
        const buf = this.buf;
        let i = (y * width + x0) * 4;
        for (let x = x0; x < x1; x++) {
          buf[i] = color.r;
          buf[i + 1] = color.g;
          buf[i + 2] = color.b;
          buf[i + 3] = 255;
          i += 4;
        }
        return;
      }
      for (let x = x0; x < x1; x++) {
        if (clip && !clip[y * width + x]) continue;
        let col = color;
        if (!solid) {
          const uv = this._inv(x + 0.5, y + 0.5);
          col = sampleGradient(style, uv[0], uv[1]);
        }
        this._blend(x, y, col);
      }
    });
  }

  _snapshotPath() {
    return {
      subs: this.subs,
      sub: this.sub,
      hasPen: this.hasPen,
      ux: this.ux,
      uy: this.uy,
      sx: this.sx,
      sy: this.sy
    };
  }

  _restorePath(s) {
    this.subs = s.subs;
    this.sub = s.sub;
    this.hasPen = s.hasPen;
    this.ux = s.ux;
    this.uy = s.uy;
    this.sx = s.sx;
    this.sy = s.sy;
  }

  _useRect(x, y, w, h) {
    if (w < 0) {
      x += w;
      w = -w;
    }
    if (h < 0) {
      y += h;
      h = -h;
    }
    this.beginPath();
    this.moveTo(x, y);
    this.lineTo(x + w, y);
    this.lineTo(x + w, y + h);
    this.lineTo(x, y + h);
    this.closePath();
  }

  fill() {
    this._paintPath(this.fillStyle, true, "fill");
  }

  clip() {
    const next = new Uint8Array(this.w * this.h);
    this._paintPath(next, true, "clip");
    this.clipMask = next;
  }

  fillRect(x, y, w, h) {
    if (this._identity()) {
      const style = this.fillStyle;
      if (style && typeof style === "object" && style.stops) {
        const bounds = this._rectPixels(x, y, w, h);
        if (!bounds) return;
        const [x0, y0, x1, y1] = bounds;
        const vertical = style.x0 === style.x1;
        const clip = this.clipMask;
        for (let py = y0; py < y1; py++) {
          const rowColor = vertical ? sampleGradient(style, 0, py + 0.5) : null;
          for (let px = x0; px < x1; px++) {
            if (clip && !clip[py * this.w + px]) continue;
            const col = rowColor || sampleGradient(style, px + 0.5, py + 0.5);
            if (col.a >= 1 && !clip) {
              const i = (py * this.w + px) * 4;
              this.buf[i] = col.r;
              this.buf[i + 1] = col.g;
              this.buf[i + 2] = col.b;
              this.buf[i + 3] = 255;
            } else this._blend(px, py, col);
          }
        }
        return;
      }
      this._paintRect(x, y, w, h, parseColor(style), false);
      return;
    }
    const saved = this._snapshotPath();
    this._useRect(x, y, w, h);
    this.fill();
    this._restorePath(saved);
  }

  clearRect(x, y, w, h) {
    if (this._identity()) {
      this._paintRect(x, y, w, h, null, true);
      return;
    }
    const saved = this._snapshotPath();
    this._useRect(x, y, w, h);
    this._paintPath(null, true, "clear");
    this._restorePath(saved);
  }

  stroke() {
    const width = Number(this.lineWidth) || 0;
    if (!(width > 0)) return;
    const scale = Math.hypot(this.a, this.b) || 1;
    const radius = (width * scale) / 2;
    const style = this.strokeStyle;
    const solid = !(style && typeof style === "object" && style.stops);
    const color = solid ? parseColor(style) : null;
    const clip = this.clipMask;
    const subs = this.subs;
    for (let s = 0; s < subs.length; s++) {
      const pts = subs[s].pts;
      const n = pts.length;
      const segN = n - 1 + (subs[s].closed && n > 1 && (pts[n - 1].x !== pts[0].x || pts[n - 1].y !== pts[0].y) ? 1 : 0);
      for (let i = 0; i < segN; i++) {
        const p = pts[i];
        const q = pts[(i + 1) % n];
        const dx = q.x - p.x;
        const dy = q.y - p.y;
        const len2 = dx * dx + dy * dy;
        const pad = radius + 1;
        let x0 = Math.floor(Math.min(p.x, q.x) - pad);
        let y0 = Math.floor(Math.min(p.y, q.y) - pad);
        let x1 = Math.ceil(Math.max(p.x, q.x) + pad);
        let y1 = Math.ceil(Math.max(p.y, q.y) + pad);
        if (x0 < 0) x0 = 0;
        if (y0 < 0) y0 = 0;
        if (x1 > this.w) x1 = this.w;
        if (y1 > this.h) y1 = this.h;
        for (let py = y0; py < y1; py++) {
          const cy = py + 0.5;
          for (let px = x0; px < x1; px++) {
            if (clip && !clip[py * this.w + px]) continue;
            const cx = px + 0.5;
            let dist;
            if (len2 === 0) dist = Math.hypot(cx - p.x, cy - p.y);
            else {
              let t = ((cx - p.x) * dx + (cy - p.y) * dy) / len2;
              if (t < 0) t = 0;
              else if (t > 1) t = 1;
              dist = Math.hypot(cx - (p.x + t * dx), cy - (p.y + t * dy));
            }
            const cov = Math.min(1, Math.max(0, radius + 0.5 - dist));
            if (cov <= 0) continue;
            const src = solid ? color : sampleGradient(style, this._inv(cx, cy)[0], this._inv(cx, cy)[1]);
            this._blend(px, py, { r: src.r, g: src.g, b: src.b, a: src.a * (242 / 255) * cov });
          }
        }
      }
    }
  }

  drawImage(image, dx, dy) {
    const srcCtx = contexts.get(image);
    if (!srcCtx || !srcCtx.buf) return;
    const sw = image.width | 0;
    const sh = image.height | 0;
    const src = srcCtx.buf;
    if (sw <= 0 || sh <= 0) return;
    if (this._identity()) {
      let x0 = Math.ceil(dx);
      let y0 = Math.ceil(dy);
      let x1 = Math.ceil(dx + sw);
      let y1 = Math.ceil(dy + sh);
      if (x0 < 0) x0 = 0;
      if (y0 < 0) y0 = 0;
      if (x1 > this.w) x1 = this.w;
      if (y1 > this.h) y1 = this.h;
      const clip = this.clipMask;
      for (let py = y0; py < y1; py++) {
        const sy = Math.floor(py - dy);
        if (sy < 0 || sy >= sh) continue;
        const srow = sy * sw;
        for (let px = x0; px < x1; px++) {
          const sx = Math.floor(px - dx);
          if (sx < 0 || sx >= sw) continue;
          if (clip && !clip[py * this.w + px]) continue;
          const si = (srow + sx) * 4;
          const saB = src[si + 3];
          if (saB === 0) continue;
          this._blend(px, py, {
            r: src[si],
            g: src[si + 1],
            b: src[si + 2],
            a: saB / 255
          });
        }
      }
      return;
    }
    const clip = this.clipMask;
    for (let py = 0; py < this.h; py++) {
      for (let px = 0; px < this.w; px++) {
        if (clip && !clip[py * this.w + px]) continue;
        const uv = this._inv(px + 0.5, py + 0.5);
        const sx = Math.floor(uv[0] - dx);
        const sy = Math.floor(uv[1] - dy);
        if (sx < 0 || sy < 0 || sx >= sw || sy >= sh) continue;
        const si = (sy * sw + sx) * 4;
        const saB = src[si + 3];
        if (saB === 0) continue;
        this._blend(px, py, { r: src[si], g: src[si + 1], b: src[si + 2], a: saB / 255 });
      }
    }
  }

  fillText(text, x, y) {
    const value = String(text);
    if (!value) return;
    const size = fontSizeOf(this.font);
    const style = this.fillStyle;
    const solid = !(style && typeof style === "object" && style.stops);
    const color = solid ? parseColor(style) : null;
    let cursor = x;
    for (const ch of value) {
      const side = oddSide(size);
      if (ch !== " ") this._glyph(ch, cursor, y, size, solid, color, style);
      cursor += side;
    }
  }

  _glyph(ch, x, y, size, solid, color, style) {
    const stamp = stampFor(ch.codePointAt(0), size);
    const R = stamp.R;
    const side = stamp.side;
    const mask = stamp.mask;
    let ax = x;
    let ay = y;
    const align = this.textAlign;
    const baseline = this.textBaseline;
    if (align === "left" || align === "start") ax = x + R;
    else if (align === "right" || align === "end") ax = x - R;
    if (baseline === "top") ay = y + R;
    else if (baseline === "bottom" || baseline === "alphabetic") ay = y - R;
    const pad = R + 1.5;
    const corners = [
      [ax - pad, ay - pad],
      [ax + pad, ay - pad],
      [ax - pad, ay + pad],
      [ax + pad, ay + pad]
    ];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < 4; i++) {
      const p = this._tf(corners[i][0], corners[i][1]);
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    let x0 = Math.floor(minX) - 1;
    let y0 = Math.floor(minY) - 1;
    let x1 = Math.ceil(maxX) + 1;
    let y1 = Math.ceil(maxY) + 1;
    if (x0 < 0) x0 = 0;
    if (y0 < 0) y0 = 0;
    if (x1 > this.w) x1 = this.w;
    if (y1 > this.h) y1 = this.h;
    const clip = this.clipMask;
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        if (clip && !clip[py * this.w + px]) continue;
        const uv = this._inv(px + 0.5, py + 0.5);
        const cx = Math.floor(uv[0] - ax + 0.5);
        const cy = Math.floor(uv[1] - ay + 0.5);
        if (cx < -R || cy < -R || cx > R || cy > R) continue;
        if (!mask[(cy + R) * side + (cx + R)]) continue;
        const col = solid ? color : sampleGradient(style, uv[0], uv[1]);
        this._blend(px, py, col);
      }
    }
  }

  createLinearGradient(x0, y0, x1, y1) {
    return new LinearGradient(x0, y0, x1, y1);
  }

  getImageData(sx, sy, sw, sh) {
    const w = sw | 0;
    const h = sh | 0;
    const data = new Uint8ClampedArray(Math.max(0, w * h * 4));
    if (sx === 0 && sy === 0 && w === this.w && h === this.h) {
      data.set(this.buf);
      return { data, width: w, height: h };
    }
    for (let y = 0; y < h; y++) {
      const py = sy + y;
      if (py < 0 || py >= this.h) continue;
      for (let x = 0; x < w; x++) {
        const px = sx + x;
        if (px < 0 || px >= this.w) continue;
        const di = (y * w + x) * 4;
        const si = (py * this.w + px) * 4;
        data[di] = this.buf[si];
        data[di + 1] = this.buf[si + 1];
        data[di + 2] = this.buf[si + 2];
        data[di + 3] = this.buf[si + 3];
      }
    }
    return { data, width: w, height: h };
  }
}

function findDesc(proto, name) {
  let obj = proto;
  while (obj) {
    const desc = Object.getOwnPropertyDescriptor(obj, name);
    if (desc) return desc;
    obj = Object.getPrototypeOf(obj);
  }
  return null;
}

function wrapDim(proto, name) {
  const desc = findDesc(proto, name);
  const origGet = desc && desc.get;
  const origSet = desc && desc.set;
  Object.defineProperty(proto, name, {
    configurable: true,
    enumerable: desc ? desc.enumerable : true,
    get() {
      return origGet ? origGet.call(this) : Number(this.getAttribute(name)) || 0;
    },
    set(v) {
      if (origSet) origSet.call(this, v);
      else this.setAttribute(name, v);
      const ctx = contexts.get(this);
      if (ctx && !ctx._inReset) ctx._reset();
    }
  });
}

export function installSoftwareCanvas(window) {
  const proto = window.HTMLCanvasElement && window.HTMLCanvasElement.prototype;
  if (!proto || proto.__rcSoftwareCanvas) return;
  Object.defineProperty(proto, "__rcSoftwareCanvas", { value: true, configurable: true });
  wrapDim(proto, "width");
  wrapDim(proto, "height");
  const origGetContext = proto.getContext;
  proto.getContext = function getContext(type, _options) {
    if (String(type).toLowerCase() !== "2d") {
      return origGetContext ? origGetContext.apply(this, arguments) : null;
    }
    let ctx = contexts.get(this);
    if (!ctx) {
      ctx = new SoftContext(this);
      contexts.set(this, ctx);
    }
    return ctx;
  };
}
