export async function solveRiskControlPlayground(options) {
  const doc = globalThis.document;
  if (!doc || !doc.body || !doc.body.dataset || doc.body.dataset.rcPlayground !== "pagelens") {
    return { ok: false, error: "当前页面不是 PageLens 风控沙盒" };
  }

  const view = doc.defaultView || globalThis;
  const mode = options && options.mode === "full" ? "full" : "visible";
  const only = options && Array.isArray(options.only) ? options.only : null;

  function wanted(id) {
    return only == null || only.includes(id);
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      view.setTimeout(resolve, ms);
    });
  }

  function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  function stripSecrets(value) {
    if (Array.isArray(value)) return value.map((item) => stripSecrets(item));
    if (!isPlainObject(value)) return value;
    const out = {};
    for (const key of Object.keys(value)) {
      if (
        key === "targetX" ||
        key === "expectedAnswer" ||
        key === "expectedCode" ||
        key === "targetSequence"
      ) {
        continue;
      }
      out[key] = stripSecrets(value[key]);
    }
    return out;
  }

  const cardIds = [
    "slider-puzzle",
    "click-text",
    "rotate-image",
    "image-grid",
    "checkbox-human",
    "text-captcha",
    "two-factor-auth",
    "iframe-challenge",
  ];

  function kindOf(root) {
    if (!root || typeof root.querySelector !== "function") return null;
    if (root.querySelector(".rl-retry")) return "rate-limit-429";
    if (root.querySelector(".puzzle-bg") && root.querySelector(".slider-handle")) return "slider";
    if (root.querySelector(".click-canvas")) return "click-text";
    if (root.querySelector(".rotate-canvas")) return "rotate";
    if (root.querySelector(".grid-tile")) return "image-grid";
    if (root.querySelector(".turnstile-check")) return "checkbox";
    if (root.querySelector(".text-captcha-canvas")) return "text-captcha";
    if (root.querySelector(".tfa-send")) return "2fa";
    if (root.querySelector("iframe")) return "iframe-challenge";
    return null;
  }

  async function dragHandle(handle, listenWin, delta) {
    const Ctor = (listenWin && listenWin.MouseEvent) || view.MouseEvent;
    const fire = (target, type, clientX, buttons) => {
      target.dispatchEvent(new Ctor(type, {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY: 8,
        buttons,
      }));
    };
    fire(handle, "pointerdown", 12, 1);
    for (let i = 1; i <= 4; i += 1) {
      const clientX = i === 4 ? 12 + delta : 12 + (delta * i) / 4;
      fire(listenWin, "pointermove", clientX, 1);
      await sleep(45);
    }
    fire(listenWin, "pointerup", 12 + delta, 0);
  }

  function solveGrid(root) {
    if (!root) return;
    const nameEl = root.querySelector(".grid-target-name");
    const label = (nameEl && nameEl.textContent ? nameEl.textContent : "").replace(/[「」]/g, "");
    let needle = null;
    if (label.includes("交通信号灯")) needle = "#22c55e";
    else if (label.includes("自行车")) needle = 'stroke="#2563eb"';
    else if (label.includes("消防栓")) needle = 'fill="#dc2626"';
    else if (label.includes("公交车")) needle = 'fill="#fffbeb"';
    else if (label.includes("房屋")) needle = 'fill="#4f46e5"';
    else if (label.includes("雨伞")) needle = 'fill="#7c3aed"';
    const tiles = root.querySelectorAll(".grid-tile");
    for (const tile of tiles) {
      const html = tile.innerHTML || "";
      const matched = needle != null && html.includes(needle);
      const selected = tile.classList.contains("selected") || tile.getAttribute("aria-pressed") === "true";
      if (matched && !selected) tile.click();
      else if (!matched && selected) tile.click();
    }
    const confirm = root.querySelector(".grid-confirm");
    if (confirm) confirm.click();
  }

  async function solveTwoFactor(root) {
    if (!root) return;
    const send = root.querySelector(".tfa-send");
    if (send) send.click();
    const notice = root.querySelector(".tfa-notice");
    const text = notice && notice.textContent ? notice.textContent : "";
    const match = text.match(/安全验证码为：(\d{6})/);
    const input = root.querySelector(".tfa-input");
    if (input && match) input.value = match[1];
    const verify = root.querySelector(".tfa-verify");
    if (verify) verify.click();
  }

  async function solveCheckbox(root, escalate) {
    if (!root) return;
    const toggle = root.querySelector(".escalate-toggle");
    if (toggle) toggle.checked = !!escalate;
    const check = root.querySelector(".turnstile-check");
    if (check) check.click();
    await sleep(600);
  }

  async function solveIframe(root) {
    if (!root || typeof root.querySelector !== "function") return;
    const iframe = root.querySelector("iframe");
    if (!iframe) return;
    let handle = null;
    const waitHandle = Math.ceil(1000 / 50);
    for (let i = 0; i <= waitHandle; i += 1) {
      const frameDoc = iframe.contentDocument;
      handle = frameDoc ? frameDoc.querySelector("#frame-handle") : null;
      if (handle) break;
      if (i === waitHandle) return;
      await sleep(50);
    }
    const listenWin = iframe.contentWindow;
    if (!listenWin) return;
    const cardWaits = !!(root.hasAttribute && root.hasAttribute("data-rc-status"));
    const waitMs = cardWaits ? 2000 : 500;

    async function pollFrame() {
      const slices = Math.ceil(waitMs / 50);
      for (let i = 0; i <= slices; i += 1) {
        const frameDoc = iframe.contentDocument;
        const frameBody = frameDoc && frameDoc.body;
        const frameStatus = frameBody && frameBody.dataset ? frameBody.dataset.status : "";
        const cardPassed = !!(root.dataset && root.dataset.rcStatus === "passed");
        if (cardWaits) {
          if (cardPassed) return "passed";
          if (frameStatus === "failed") return "failed";
        } else if (frameStatus === "passed") {
          return "passed";
        } else if (frameStatus === "failed") {
          return "failed";
        }
        if (i === slices) return "timeout";
        await sleep(50);
      }
      return "timeout";
    }

    await dragHandle(handle, listenWin, 2000);
    const first = await pollFrame();
    if (first !== "failed") return;
    await dragHandle(handle, listenWin, 2000);
    await pollFrame();
  }

  async function solveRateLimit(root) {
    if (!root) return;
    const slices = Math.ceil(8000 / 50);
    for (let i = 0; i <= slices; i += 1) {
      const btn = root.querySelector(".rl-retry");
      const text = btn && btn.textContent ? btn.textContent : "";
      if (btn && !btn.disabled && !text.includes("冷却")) {
        btn.click();
        return;
      }
      if (i === slices) return;
      await sleep(50);
    }
  }

  async function waitModalClosed(timeout) {
    const slices = Math.ceil(timeout / 50);
    for (let i = 0; i <= slices; i += 1) {
      if (doc.body.dataset.rcModalOpen !== "true") return true;
      if (i === slices) return false;
      await sleep(50);
    }
    return doc.body.dataset.rcModalOpen !== "true";
  }

  const scratch = doc.createElement("canvas");
  scratch.width = 41;
  scratch.height = 41;
  const scratchCtx = scratch.getContext("2d", { willReadFrequently: true });
  const cache = new Map();

  function isInkPixel(r, g, b, a) {
    if (a < 128) return false;
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    if (luma >= 140) return false;
    return Math.max(r, g, b) - Math.min(r, g, b) > 30 || luma < 70;
  }

  function templateFor(ch, font, rotRad, fracX, fracY) {
    const key = font + "|" + ch + "|" + rotRad.toFixed(5) + "|" + fracX.toFixed(3) + "|" + fracY.toFixed(3);
    const cached = cache.get(key);
    if (cached) return cached;

    const ox = Math.floor(20 + fracX);
    const oy = Math.floor(20 + fracY);
    let rel = new Int16Array(0);
    let n = 0;
    let meanX = 0;
    let meanY = 0;

    if (ch !== " ") {
      scratch.width = 41;
      const ctx = scratchCtx;
      ctx.font = font;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#000";
      ctx.translate(20 + fracX, 20 + fracY);
      ctx.rotate(rotRad);
      ctx.fillText(ch, 0, 0);

      const data = ctx.getImageData(0, 0, 41, 41).data;
      let count = 0;
      for (let p = 0; p < data.length; p += 4) {
        if (isInkPixel(data[p], data[p + 1], data[p + 2], data[p + 3])) count++;
      }
      rel = new Int16Array(count * 2);
      n = count;
      if (count !== 0) {
        let k = 0;
        let sumX = 0;
        let sumY = 0;
        for (let y = 0; y < 41; y++) {
          const row = y * 41;
          for (let x = 0; x < 41; x++) {
            const p = (row + x) * 4;
            if (!isInkPixel(data[p], data[p + 1], data[p + 2], data[p + 3])) continue;
            const rx = x - ox;
            const ry = y - oy;
            rel[k++] = rx;
            rel[k++] = ry;
            sumX += rx;
            sumY += ry;
          }
        }
        meanX = sumX / n;
        meanY = sumY / n;
      }
    }

    const out = { rel: rel, n: n, meanX: meanX, meanY: meanY };
    cache.set(key, out);
    return out;
  }

  function precision(data, w, h, ox, oy, rel) {
    const n = rel.length / 2;
    if (n === 0) return 0;
    let hit = 0;
    for (let i = 0; i < rel.length; i += 2) {
      const x = ox + rel[i];
      const y = oy + rel[i + 1];
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const p = (y * w + x) * 4;
      if (isInkPixel(data[p], data[p + 1], data[p + 2], data[p + 3])) hit++;
    }
    return hit / n;
  }

  async function solveSlider(root) {
    const bg = root.querySelector(".puzzle-bg");
    const piece = root.querySelector(".puzzle-piece");
    const handle = root.querySelector(".slider-handle");
    const track = root.querySelector(".slider-track");
    if (!bg || !piece || !handle || !track) return;
    if (track.classList.contains("passed")) return;

    const bgImage = bg.getContext("2d").getImageData(0, 0, bg.width, bg.height);
    const pieceImage = piece.getContext("2d").getImageData(0, 0, piece.width, piece.height);
    const bgPx = bgImage.data;
    const piecePx = pieceImage.data;
    const pw = piece.width;
    const ph = piece.height;
    const bw = bg.width;
    const bh = bg.height;

    const samples = [];
    for (let y = 8; y < ph - 8; y += 2) {
      for (let x = 8; x < pw - 8; x += 2) {
        const i = (y * pw + x) * 4;
        const r = piecePx[i];
        const g = piecePx[i + 1];
        const b = piecePx[i + 2];
        const a = piecePx[i + 3];
        if (a <= 250) continue;
        if (r > 230 && g > 230 && b > 230) continue;
        const up = piecePx[((y - 1) * pw + x) * 4 + 3];
        const down = piecePx[((y + 1) * pw + x) * 4 + 3];
        const left = piecePx[(y * pw + (x - 1)) * 4 + 3];
        const right = piecePx[(y * pw + (x + 1)) * 4 + 3];
        if (up <= 250 || down <= 250 || left <= 250 || right <= 250) continue;
        samples.push({
          px: x,
          py: y,
          r: Math.round(0.56 * 15 + 0.44 * r),
          g: Math.round(0.56 * 23 + 0.44 * g),
          b: Math.round(0.56 * 42 + 0.44 * b),
        });
      }
    }
    if (samples.length <= 30) return;

    let bestS = -1;
    let bestScore = Infinity;
    for (let s = 90; s <= 250; s++) {
      let score = 0;
      let compared = 0;
      for (let n = 0; n < samples.length; n++) {
        const sample = samples[n];
        const bx = sample.px + s;
        const by = sample.py;
        if (bx < 0 || by < 0 || bx >= bw || by >= bh) continue;
        const j = (by * bw + bx) * 4;
        score += Math.abs(sample.r - bgPx[j]) + Math.abs(sample.g - bgPx[j + 1]) + Math.abs(sample.b - bgPx[j + 2]);
        compared++;
      }
      if (compared > 30 && score < bestScore) {
        bestScore = score;
        bestS = s;
      }
    }
    if (bestS < 0) return;

    const maxHandle = Math.max(1, (track.clientWidth || 320) - (handle.offsetWidth || 44) - 6);
    const handleOffset = bestS / 253 * maxHandle;
    await dragHandle(handle, view, handleOffset);
    await sleep(40);
    if (!track.classList.contains("passed")) {
      await sleep(450);
      await dragHandle(handle, view, handleOffset);
    }
  }

  async function solveRotate(root) {
    const canvas = root.querySelector(".rotate-canvas");
    const input = root.querySelector(".range-input");
    const confirm = root.querySelector(".rotate-confirm");
    if (!canvas || !input) return;

    const size = canvas.width;
    const data = canvas.getContext("2d").getImageData(0, 0, size, canvas.height).data;
    let sumX = 0;
    let sumY = 0;
    let count = 0;
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const a = data[i + 3];
        if (r > 220 && g > 180 && b < 120 && a >= 200) {
          sumX += x + 0.5;
          sumY += y + 0.5;
          count += 1;
        }
      }
    }
    if (count === 0) return;

    const centroidX = sumX / count;
    const centroidY = sumY / count;
    const measured = Math.atan2(centroidY - size / 2, centroidX - size / 2);
    const ux = size * 0.74 - size / 2;
    const uy = size * 0.24 - size / 2;
    const upright = Math.atan2(uy, ux);
    const deltaDeg = ((measured - upright) * 180 / Math.PI % 360 + 360) % 360;
    const userAngle = deltaDeg <= 14 || deltaDeg >= 346 ? 0 : (360 - deltaDeg) % 360;

    input.value = String(userAngle);
    input.dispatchEvent(new view.Event("input", { bubbles: true }));
    if (confirm) confirm.click();
  }

  async function solveClick(root) {
    const sequence = [...root.querySelectorAll(".char-chip")].map((el) => (el.textContent || "").trim()).filter(Boolean);
    const needed = [];
    for (const text of sequence) {
      for (const ch of text) {
        if (!needed.includes(ch)) needed.push(ch);
      }
    }
    const pools = ["风和日丽云淡", "春暖花开山青", "晴空万里星河", "安全验证守护", "海阔天空明月", "锦绣前程如意"];
    let pool = "";
    if (needed.length) {
      for (const candidate of pools) {
        let ok = true;
        for (const ch of needed) {
          if (!candidate.includes(ch)) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        if (pool) return;
        pool = candidate;
      }
    }
    if (!pool) return;

    const canvas = root.querySelector(".click-canvas");
    const stage = root.querySelector(".click-stage");
    const confirm = root.querySelector(".click-confirm");
    if (!canvas || !stage || !confirm) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const font = 'bold 28px "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
    const chars = [...pool];
    const score = [0, 1, 2, 3, 4, 5].map(() => [0, 0, 0, 0, 0, 0]);
    const data = imageData.data;
    const w = imageData.width;
    const h = imageData.height;
    const cells = [];
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 3; col++) {
        const cx0 = col * 100 + 56;
        const cy0 = row * 74 + 43;
        const x0 = Math.max(0, cx0 - 36);
        const x1 = Math.min(w - 1, cx0 + 36);
        const y0 = Math.max(0, cy0 - 30);
        const y1 = Math.min(h - 1, cy0 + 30);
        let n = 0;
        let sumX = 0;
        let sumY = 0;
        for (let y = y0; y <= y1; y++) {
          const rowOff = y * w;
          for (let x = x0; x <= x1; x++) {
            const p = (rowOff + x) * 4;
            if (!isInkPixel(data[p], data[p + 1], data[p + 2], data[p + 3])) continue;
            n += 1;
            sumX += x + 0.5;
            sumY += y + 0.5;
          }
        }
        if (n < 40) return;
        cells.push({ cx: sumX / n, cy: sumY / n });
      }
    }

    for (let bi = 0; bi < 6; bi++) {
      const blob = cells[bi];
      for (let ci = 0; ci < 6; ci++) {
        let best = -1;
        for (let deg = -24; deg <= 24; deg++) {
          const tpl = templateFor(chars[ci], font, deg * Math.PI / 180, 0, 0);
          const ox0 = Math.round(blob.cx - tpl.meanX - 0.5);
          const oy0 = Math.round(blob.cy - tpl.meanY - 0.5);
          for (let dy = -1; dy <= 1; dy++) {
            const oy = oy0 + dy;
            for (let dx = -1; dx <= 1; dx++) {
              const s = precision(data, w, h, ox0 + dx, oy, tpl.rel);
              if (s > best) best = s;
            }
          }
        }
        score[bi][ci] = best;
      }
    }

    const perm = [0, 1, 2, 3, 4, 5];
    let bestSum = -1;
    let bestPerm = null;
    const walk = (k) => {
      if (k === 6) {
        let sum = 0;
        for (let i = 0; i < 6; i++) sum += score[i][perm[i]];
        if (sum > bestSum) {
          bestSum = sum;
          bestPerm = perm.slice();
        }
        return;
      }
      for (let i = k; i < 6; i++) {
        const t = perm[k];
        perm[k] = perm[i];
        perm[i] = t;
        walk(k + 1);
        perm[i] = perm[k];
        perm[k] = t;
      }
    };
    walk(0);
    if (!bestPerm) return;

    const blobFor = new Map();
    for (let i = 0; i < 6; i++) blobFor.set(chars[bestPerm[i]], cells[i]);
    const targets = [];
    for (const text of sequence) {
      for (const ch of text) {
        const blob = blobFor.get(ch);
        if (!blob) return;
        targets.push(blob);
      }
    }

    const rect = canvas.getBoundingClientRect();
    for (const blob of targets) {
      stage.dispatchEvent(new view.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + blob.cx * rect.width / canvas.width,
        clientY: rect.top + blob.cy * rect.height / canvas.height,
      }));
    }
    confirm.click();
  }

  async function solveCaptcha(root) {
    const canvas = root.querySelector(".text-captcha-canvas");
    const input = root.querySelector(".text-captcha-input");
    const submit = root.querySelector(".text-captcha-submit");
    if (!canvas || !input || !submit) return;
    const tab = root.querySelector(".mode-tab.active");
    const mode = tab && tab.dataset.mode === "math" ? "math" : "alnum";
    const answer = readCaptchaAnswer(canvas, mode);
    if (!answer) return;
    input.value = answer;
    submit.click();
    await sleep(30);
    const statusEl = root.closest("[data-rc-status]") || root;
    if (statusEl.dataset.rcStatus === "passed") return;
    const retry = readCaptchaAnswer(canvas, mode);
    if (!retry) return;
    input.value = retry;
    submit.click();
  }

  function readCaptchaAnswer(canvas, mode) {
    const width = canvas.width;
    const height = canvas.height;
    const data = canvas.getContext("2d").getImageData(0, 0, width, height).data;
    const font = mode === "math"
      ? "bold 21px ui-monospace, SFMono-Regular, Menlo, monospace"
      : "bold 25px ui-monospace, SFMono-Regular, Menlo, monospace";
    const alphabet = mode === "math" ? "0123456789+-=?" : "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const lengths = mode === "math" ? [9, 10, 11] : [5];
    const rots = [];
    for (let deg = -18; deg <= 18; deg++) rots.push(deg * Math.PI / 180);
    let best = null;
    for (let li = 0; li < lengths.length; li++) {
      const length = lengths[li];
      const step = (width - 24) / length;
      const chars = [];
      let sum = 0;
      let parsed = true;
      for (let i = 0; i < length; i++) {
        const x = 16 + i * step + step / 2;
        const ox = Math.floor(x);
        const fracX = Math.round((x - ox) * 1000) / 1000;
        if (!captchaSlotHasInk(data, width, height, ox)) {
          chars.push(" ");
          sum += 1;
          continue;
        }
        const scored = [];
        for (let ci = 0; ci < alphabet.length; ci++) {
          const ch = alphabet.charAt(ci);
          let top = -1;
          let topRot = 0;
          let topY = 28;
          let topRel = null;
          for (let ri = 0; ri < rots.length; ri++) {
            const tpl = templateFor(ch, font, rots[ri], fracX, 0);
            if (!tpl || !tpl.n) continue;
            for (let y = 24; y <= 32; y++) {
              const p = precision(data, width, height, ox, y, tpl.rel);
              if (p > top) {
                top = p;
                topRot = rots[ri];
                topY = y;
                topRel = tpl.rel;
              }
            }
          }
          scored.push({ ch: ch, p: top, rot: topRot, y: topY, rel: topRel });
        }
        scored.sort(function (a, b) { return b.p - a.p; });
        const lead = scored[0];
        if (lead && lead.p < 0.8 && lead.rel) {
          const refine = Math.min(3, scored.length);
          for (let k = 0; k < refine; k++) {
            const item = scored[k];
            const tpl = templateFor(item.ch, font, item.rot, fracX, 0);
            if (!tpl || !tpl.n) continue;
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                const p = precision(data, width, height, ox + dx, item.y + dy, tpl.rel);
                if (p > item.p) item.p = p;
              }
            }
          }
          scored.sort(function (a, b) { return b.p - a.p; });
        }
        const pick = scored[0];
        if (!pick || pick.p < 0) {
          parsed = false;
          break;
        }
        chars.push(pick.ch);
        sum += pick.p;
      }
      if (!parsed) continue;
      const raw = chars.join("");
      const mean = sum / length;
      if (mode === "math") {
        const match = raw.match(/^(\d+)\s*([+-])\s*(\d+)\s*=\s*\?$/);
        if (!match) continue;
        const left = Number(match[1]);
        const right = Number(match[3]);
        const value = match[2] === "+" ? left + right : left - right;
        if (!best || mean > best.mean) best = { mean: mean, answer: String(value) };
      } else if (!best || mean > best.mean) {
        best = { mean: mean, answer: raw.toLowerCase() };
      }
    }
    return best ? best.answer : "";
  }

  function captchaSlotHasInk(data, width, height, ox) {
    const x0 = Math.max(0, ox - 5);
    const x1 = Math.min(width - 1, ox + 5);
    const y0 = 16;
    const y1 = height - 4;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = (y * width + x) * 4;
        if (isInkPixel(data[i], data[i + 1], data[i + 2], data[i + 3])) return true;
      }
    }
    return false;
  }


  async function solveRoot(root, hint) {
    const kind = hint || kindOf(root);
    if (kind === "slider" || kind === "slider-puzzle") return solveSlider(root);
    if (kind === "click-text") return solveClick(root);
    if (kind === "rotate" || kind === "rotate-image") return solveRotate(root);
    if (kind === "image-grid") return solveGrid(root);
    if (kind === "checkbox" || kind === "checkbox-human") return solveCheckbox(root, false);
    if (kind === "text-captcha") return solveCaptcha(root);
    if (kind === "2fa" || kind === "two-factor-auth") return solveTwoFactor(root);
    if (kind === "iframe-challenge") return solveIframe(root);
    if (kind === "rate-limit-429") return solveRateLimit(root);
  }

  if (doc.body.dataset.rcModalOpen === "true") {
    const modalRoot = doc.querySelector("#rc-modal-body");
    const kind = kindOf(modalRoot);
    if (wanted(kind)) {
      await solveRoot(modalRoot, kind);
      await waitModalClosed(kind === "rate-limit-429" ? 8000 : 2000);
    }
  }

  for (const id of cardIds) {
    if (!wanted(id)) continue;
    const card = doc.querySelector(`#rc-${id}`);
    if (!card) continue;
    if (card.dataset.rcStatus === "passed") continue;
    await solveRoot(card, id);
  }

  if (mode === "full" && wanted("text-captcha")) {
    const tab = doc.querySelector('#rc-text-captcha .mode-tab[data-mode="math"]');
    if (tab) tab.click();
    await sleep(30);
    await solveCaptcha(doc.querySelector("#rc-text-captcha"));
  }

  if (mode === "full" && wanted("checkbox-human")) {
    const refresh = doc.querySelector('#rc-checkbox-human [data-action="refresh"]');
    if (refresh) refresh.click();
    await sleep(30);
    await solveCheckbox(doc.querySelector("#rc-checkbox-human"), true);
    await sleep(600);
    await solveSlider(doc.querySelector("#rc-modal-body"));
    await waitModalClosed(2000);
  }

  if (mode === "full") {
    const modalKinds = [
      "slider-puzzle",
      "click-text",
      "rotate-image",
      "iframe-challenge",
      "two-factor-auth",
      "rate-limit-429",
    ];
    for (const kind of modalKinds) {
      if (!wanted(kind)) continue;
      const opener = doc.querySelector(`[data-open-modal="${kind}"]`);
      if (opener) opener.click();
      await sleep(30);
      await solveRoot(doc.querySelector("#rc-modal-body"), kind);
      await waitModalClosed(kind === "rate-limit-429" ? 8000 : 2000);
    }
  }

  const widgets = {};
  for (const id of cardIds) {
    const card = doc.querySelector(`#rc-${id}`);
    widgets[id] = card && card.dataset ? card.dataset.rcStatus : undefined;
  }

  const modalOpen = doc.body.dataset.rcModalOpen === "true";
  const modalKind = modalOpen ? kindOf(doc.querySelector("#rc-modal-body")) : null;
  let ok = true;
  for (const id of cardIds) {
    if (!wanted(id)) continue;
    if (widgets[id] !== "passed") ok = false;
  }
  if (modalOpen && wanted(modalKind)) ok = false;

  let state = null;
  if (typeof view.__RC_PLAYGROUND_STATE__ === "function") {
    state = view.__RC_PLAYGROUND_STATE__();
  }

  return stripSecrets({
    ok,
    mode,
    widgets,
    modal: { open: modalOpen, kind: modalKind },
    state,
  });
}
