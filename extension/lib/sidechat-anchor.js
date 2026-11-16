/**
 * SideChat text-anchoring utilities: captures selection offsets/fingerprints
 * inside rendered bot markdown and safely restores <mark> highlights + badges
 * across re-renders without mutating protected blocks (KaTeX/Mermaid/badges).
 */

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG"]);

function isSkippedElement(el) {
  if (!el || el.nodeType !== 1) return false;
  if (SKIP_TAGS.has(el.tagName)) return true;
  const cl = el.classList;
  if (!cl) return false;
  return (
    cl.contains("sc-anno-group") ||
    cl.contains("sc-anno-badge") ||
    cl.contains("sc-anno-del") ||
    cl.contains("sc-orphan-bar") ||
    cl.contains("katex-mathml") ||
    cl.contains("mermaid-wrap") ||
    cl.contains("mermaid-src")
  );
}

function isProtectedHighlightContainer(node) {
  let cur = node?.nodeType === 1 ? node : node?.parentElement;
  while (cur) {
    if (cur.classList?.contains("katex") || cur.classList?.contains("katex-display")) {
      return cur;
    }
    cur = cur.parentElement;
  }
  return null;
}

/**
 * Collects visible Text nodes in reading order along with their cumulative
 * character offsets inside `root`.
 */
export function collectTextSegments(root) {
  const segments = [];
  let offset = 0;

  function walk(node) {
    if (!node) return;
    if (node.nodeType === 3) {
      const value = node.nodeValue || "";
      if (value.length > 0) {
        segments.push({ node, start: offset, end: offset + value.length, text: value });
        offset += value.length;
      }
      return;
    }
    if (node.nodeType === 1) {
      if (isSkippedElement(node)) return;
      for (let child = node.firstChild; child; child = child.nextSibling) {
        walk(child);
      }
    }
  }

  walk(root);
  return {
    segments,
    plainText: segments.map((s) => s.text).join(""),
  };
}

function compareCollapsedToSegment(doc, collapsedRange, segNode, segLen) {
  const nodeStart = doc.createRange();
  nodeStart.setStart(segNode, 0);
  nodeStart.collapse(true);
  const cmpStart = collapsedRange.compareBoundaryPoints(0 /* START_TO_START */, nodeStart);
  if (cmpStart <= 0) return { rel: -1, local: 0 };

  const nodeEnd = doc.createRange();
  nodeEnd.setStart(segNode, segLen);
  nodeEnd.collapse(true);
  const cmpEnd = collapsedRange.compareBoundaryPoints(0 /* START_TO_START */, nodeEnd);
  if (cmpEnd >= 0) return { rel: 1, local: segLen };

  return {
    rel: 0,
    local: collapsedRange.startContainer === segNode ? collapsedRange.startOffset : 0,
  };
}

/**
 * Captures a resilient selection anchor from a user Selection inside `bodyEl`.
 * Returns null if the selection is collapsed, empty, or outside `bodyEl`.
 */
export function captureSelectionAnchor(bodyEl, selection) {
  if (!bodyEl || !selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!bodyEl.contains(range.startContainer) || !bodyEl.contains(range.endContainer)) {
    return null;
  }

  const rawSelected = selection.toString();
  const trimmed = rawSelected.trim();
  if (trimmed.length < 2) return null;

  const doc = bodyEl.ownerDocument;
  const { segments, plainText } = collectTextSegments(bodyEl);
  if (!segments.length) return null;

  const selStart = doc.createRange();
  selStart.setStart(range.startContainer, range.startOffset);
  selStart.collapse(true);

  const selEnd = doc.createRange();
  selEnd.setStart(range.endContainer, range.endOffset);
  selEnd.collapse(true);

  let plainStart = null;
  let plainEnd = null;

  for (const seg of segments) {
    const len = seg.text.length;
    if (plainStart === null) {
      const s = compareCollapsedToSegment(doc, selStart, seg.node, len);
      if (s.rel <= 0) {
        plainStart = seg.start + s.local;
      }
    }
    const e = compareCollapsedToSegment(doc, selEnd, seg.node, len);
    if (e.rel <= 0) {
      plainEnd = seg.start + e.local;
      break;
    }
  }

  if (plainStart === null) plainStart = 0;
  if (plainEnd === null) plainEnd = plainText.length;
  if (plainEnd <= plainStart) return null;

  // Trim leading/trailing whitespace inside the captured plain range so re-anchoring stays tight.
  while (plainStart < plainEnd && /\s/.test(plainText[plainStart])) plainStart += 1;
  while (plainEnd > plainStart && /\s/.test(plainText[plainEnd - 1])) plainEnd -= 1;

  const quoteText = plainText.slice(plainStart, plainEnd).trim() || trimmed;
  if (quoteText.length < 2) return null;

  return {
    quoteText: quoteText.slice(0, 4000),
    contextBefore: plainText.slice(Math.max(0, plainStart - 40), plainStart),
    contextAfter: plainText.slice(plainEnd, Math.min(plainText.length, plainEnd + 40)),
    plainStart,
    plainEnd,
    status: "attached",
  };
}

function commonSuffixLength(a, b) {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1;
  return i;
}

function commonPrefixLength(a, b) {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i += 1;
  return i;
}

function normalizeWithMap(text) {
  let norm = "";
  const map = [];
  let inSpace = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (!inSpace && norm.length > 0) {
        norm += " ";
        map.push(i);
      }
      inSpace = true;
    } else {
      norm += ch;
      map.push(i);
      inSpace = false;
    }
  }
  if (norm.endsWith(" ")) {
    norm = norm.slice(0, -1);
    map.pop();
  }
  return { norm, map };
}

/**
 * Resolves [start, end] offsets inside `plainText` using saved offsets first,
 * then context-scored exact substring search, then whitespace-normalized search.
 */
export function locateAnchorInText(plainText, anchor) {
  const hay = String(plainText || "");
  const quote = String(anchor?.quoteText || "").trim();
  if (!hay || !quote) return null;

  const s0 = anchor?.plainStart;
  const e0 = anchor?.plainEnd;
  if (Number.isInteger(s0) && Number.isInteger(e0) && s0 >= 0 && e0 <= hay.length && e0 > s0) {
    const slice = hay.slice(s0, e0);
    if (slice === quote) return { start: s0, end: e0 };
    if (slice.trim() === quote) {
      let a = s0;
      let b = e0;
      while (a < b && /\s/.test(hay[a])) a += 1;
      while (b > a && /\s/.test(hay[b - 1])) b -= 1;
      return { start: a, end: b };
    }
  }

  const before = String(anchor?.contextBefore || "");
  const after = String(anchor?.contextAfter || "");
  const candidates = [];
  let idx = hay.indexOf(quote);
  while (idx !== -1) {
    const end = idx + quote.length;
    const score =
      commonSuffixLength(hay.slice(Math.max(0, idx - before.length), idx), before) +
      commonPrefixLength(hay.slice(end, end + after.length), after);
    candidates.push({ start: idx, end, score });
    idx = hay.indexOf(quote, idx + 1);
  }
  if (candidates.length) {
    candidates.sort((a, b) => b.score - a.score || a.start - b.start);
    return { start: candidates[0].start, end: candidates[0].end };
  }

  // Fallback: ignore whitespace differences introduced by markdown wrapping
  const { norm: normHay, map } = normalizeWithMap(hay);
  const { norm: normQuote } = normalizeWithMap(quote);
  if (!normQuote) return null;
  const normCandidates = [];
  let nIdx = normHay.indexOf(normQuote);
  while (nIdx !== -1) {
    const rawStart = map[nIdx];
    const lastNorm = nIdx + normQuote.length - 1;
    const rawEnd = (map[lastNorm] ?? rawStart) + 1;
    const score =
      commonSuffixLength(hay.slice(Math.max(0, rawStart - before.length), rawStart), before) +
      commonPrefixLength(hay.slice(rawEnd, rawEnd + after.length), after);
    normCandidates.push({ start: rawStart, end: rawEnd, score });
    nIdx = normHay.indexOf(normQuote, nIdx + 1);
  }
  if (normCandidates.length) {
    normCandidates.sort((a, b) => b.score - a.score || a.start - b.start);
    return { start: normCandidates[0].start, end: normCandidates[0].end };
  }

  return null;
}

/**
 * Removes existing SideChat <mark> wrappers and badges inside `bodyEl` so anchors
 * can be cleanly re-applied after SideChat mutations without losing DOM structure.
 */
export function stripSideChatAnchors(bodyEl) {
  if (!bodyEl) return;
  bodyEl.querySelectorAll(".sc-anno-group, .sc-anno-badge, .sc-anno-del").forEach((el) => el.remove());
  const marks = [...bodyEl.querySelectorAll("mark.sc-anchor")];
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) {
      parent.insertBefore(mark.firstChild, mark);
    }
    parent.removeChild(mark);
    parent.normalize();
  }
}

function choosePrimarySideChat(list, activeId) {
  if (!list.length) return null;
  const active = list.find((sc) => sc.id === activeId);
  if (active) return active;
  return list[list.length - 1];
}

function wrapTextSlice(doc, seg, localStart, localEnd, covering, activeId) {
  let target = seg.node;
  if (localStart > 0) {
    target = target.splitText(localStart);
  }
  const sliceLen = localEnd - localStart;
  if (sliceLen < target.length) {
    target.splitText(sliceLen);
  }

  const primary = choosePrimarySideChat(covering, activeId);
  const mark = doc.createElement("mark");
  const allResolved = covering.every((sc) => sc.status === "resolved");
  const isActive = covering.some((sc) => sc.id === activeId);
  const hasPinned = covering.some((sc) => Boolean(sc.pinnedNote));

  mark.className = [
    "sc-anchor",
    allResolved ? "is-resolved" : "",
    isActive ? "is-active" : "",
    hasPinned ? "has-pinned" : "",
  ]
    .filter(Boolean)
    .join(" ");

  mark.dataset.scId = primary.id;
  mark.dataset.scIds = covering.map((sc) => sc.id).join(",");

  const tooltip = primary.pinnedNote
    ? `📌 ${primary.pinnedNote}`
    : `${primary.title || "旁注"}（点击打开 SideChat）`;
  mark.title = tooltip;

  target.parentNode.insertBefore(mark, target);
  mark.appendChild(target);
  return mark;
}

function buildBadgeElement(doc, sc, displayNum, activeId) {
  const group = doc.createElement("span");
  group.className = "sc-anno-group" + (sc.id === activeId ? " is-active" : "");
  group.dataset.scId = sc.id;

  const badge = doc.createElement("button");
  badge.type = "button";
  const isResolved = sc.status === "resolved";
  const isPinned = Boolean(sc.pinnedNote);
  badge.className = [
    "sc-anno-badge",
    isResolved ? "is-resolved" : "",
    isPinned ? "has-pinned" : "",
    sc.id === activeId ? "is-active" : "",
  ]
    .filter(Boolean)
    .join(" ");
  badge.dataset.scId = sc.id;
  const icon = isResolved ? "✓" : isPinned ? "📌" : "💬";
  badge.textContent = `${icon} ${displayNum}`;
  badge.title = sc.pinnedNote ? `📌 ${sc.pinnedNote}` : `打开旁注：${sc.title || "SideChat"}`;
  badge.setAttribute("aria-label", badge.title);

  const del = doc.createElement("button");
  del.type = "button";
  del.className = "sc-anno-del";
  del.dataset.scId = sc.id;
  del.textContent = "×";
  del.title = `删除旁注：${sc.title || "SideChat"}`;
  del.setAttribute("aria-label", del.title);

  group.append(badge, del);
  return group;
}

/**
 * Applies selection anchors for `sideChats` onto `bodyEl`.
 * Handles overlapping spans cleanly using atomic boundary intervals and appends
 * clickable inline badges after each anchor's end position.
 */
export function applyAnchorsToBody(bodyEl, sideChats, { activeId = "", indexMap = new Map() } = {}) {
  if (!bodyEl) return { attachedIds: [], orphanedIds: [] };
  stripSideChatAnchors(bodyEl);

  const selectionThreads = (sideChats || []).filter(
    (sc) => sc && sc.forkType === "selection" && sc.anchor?.quoteText,
  );
  if (!selectionThreads.length) return { attachedIds: [], orphanedIds: [] };

  const { segments, plainText } = collectTextSegments(bodyEl);
  if (!segments.length || !plainText) {
    return {
      attachedIds: [],
      orphanedIds: selectionThreads.map((sc) => sc.id),
    };
  }

  const resolved = [];
  const orphanedIds = [];

  for (const sc of selectionThreads) {
    const loc = locateAnchorInText(plainText, sc.anchor);
    if (loc && loc.end > loc.start) {
      resolved.push({ sc, start: loc.start, end: loc.end });
    } else {
      orphanedIds.push(sc.id);
    }
  }

  if (!resolved.length) {
    return { attachedIds: [], orphanedIds };
  }

  const points = new Set();
  for (const r of resolved) {
    points.add(r.start);
    points.add(r.end);
  }
  const sortedPoints = [...points].sort((a, b) => a - b);

  // Split into atomic intervals so overlapping annotations never break DOM nesting.
  const intervals = [];
  for (let i = 0; i < sortedPoints.length - 1; i += 1) {
    const a = sortedPoints[i];
    const b = sortedPoints[i + 1];
    if (b <= a) continue;
    const covering = resolved
      .filter((r) => r.start <= a && r.end >= b)
      .map((r) => r.sc);
    if (covering.length) intervals.push({ start: a, end: b, covering });
  }

  const doc = bodyEl.ownerDocument;
  const lastNodeByScId = new Map();

  // Process segments backwards so splitText() mutations never invalidate earlier offsets.
  for (let sIdx = segments.length - 1; sIdx >= 0; sIdx -= 1) {
    const seg = segments[sIdx];
    const protectedEl = isProtectedHighlightContainer(seg.node);
    const localSlices = [];

    for (const iv of intervals) {
      const ovStart = Math.max(seg.start, iv.start);
      const ovEnd = Math.min(seg.end, iv.end);
      if (ovEnd > ovStart) {
        localSlices.push({
          localStart: ovStart - seg.start,
          localEnd: ovEnd - seg.start,
          absEnd: ovEnd,
          covering: iv.covering,
        });
      }
    }
    if (!localSlices.length) continue;

    // Sort descending within the single Text node before splitting.
    localSlices.sort((a, b) => b.localStart - a.localStart);

    for (const slice of localSlices) {
      if (protectedEl) {
        for (const sc of slice.covering) {
          const match = resolved.find((r) => r.sc.id === sc.id);
          if (match && slice.absEnd === match.end && !lastNodeByScId.has(sc.id)) {
            lastNodeByScId.set(sc.id, protectedEl);
          }
        }
        continue;
      }
      const mark = wrapTextSlice(doc, seg, slice.localStart, slice.localEnd, slice.covering, activeId);
      for (const sc of slice.covering) {
        const match = resolved.find((r) => r.sc.id === sc.id);
        if (match && slice.absEnd === match.end && !lastNodeByScId.has(sc.id)) {
          lastNodeByScId.set(sc.id, mark);
        }
      }
    }
  }

  // Insert badges in reading order at the end of each resolved span.
  const orderedResolved = [...resolved].sort((a, b) => a.end - b.end || a.start - b.start);
  for (let i = 0; i < orderedResolved.length; i += 1) {
    const { sc } = orderedResolved[i];
    const anchorEl = lastNodeByScId.get(sc.id);
    if (!anchorEl || !anchorEl.parentNode) continue;
    const displayNum = indexMap.get(sc.id) || (i + 1);
    const badge = buildBadgeElement(doc, sc, displayNum, activeId);
    anchorEl.after(badge);
  }

  return {
    attachedIds: resolved.map((r) => r.sc.id),
    orphanedIds,
  };
}
