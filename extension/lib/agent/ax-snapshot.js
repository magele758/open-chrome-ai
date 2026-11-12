/**
 * 只读 CDP 无障碍语义树感知通道（AX Snapshot）。
 *
 * 设计边界：
 * - 日常轻量阅读（extract_page）不附加 debugger；仅在已授权/启用 CDP 的交互与工作流场景按需调用。
 * - 只读采集 `Accessibility.getFullAXTree`：生成带代际校验 `snapshotId` 与 `backendDOMNodeId` 的紧凑语义快照。
 * - 支持跨快照前后状态差分（`diffAxSnapshots`）以及与现有 DOM 控件通道并行对比（`compareAxWithDom`）。
 * - 零业务词汇、零组件库私有类名。
 */

export const INTERACTIVE_AX_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "option",
  "checkbox",
  "radio",
  "switch",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "treeitem",
  "tab",
  "dialog",
  "alertdialog",
  "heading",
  "spinbutton",
  "slider",
]);

const IGNORED_CONTAINER_ROLES = new Set([
  "",
  "none",
  "presentation",
  "generic",
  "inlinetextbox",
  "statictext",
  "linebreak",
  "rootwebarea",
  "webarea",
  "group",
  "paragraph",
]);

const MAX_SNAPSHOTS_PER_TAB = 6;
const tabSnapshots = new Map();
let snapshotSeq = 0;

function cleanText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function readAxProps(properties) {
  const out = {};
  if (!Array.isArray(properties)) return out;
  for (const prop of properties) {
    const key = String(prop?.name || "");
    if (!key) continue;
    out[key] = prop?.value?.value;
  }
  return out;
}

function normalizeChecked(raw) {
  if (raw === true || raw === "true") return true;
  if (raw === false || raw === "false") return false;
  if (raw === "mixed") return "mixed";
  return undefined;
}

function collectFrameIds(frameTree, out = []) {
  if (!frameTree || typeof frameTree !== "object") return out;
  const id = frameTree.frame?.id;
  if (id) out.push({ frameId: String(id), isMain: out.length === 0 });
  if (Array.isArray(frameTree.childFrames)) {
    for (const child of frameTree.childFrames) collectFrameIds(child, out);
  }
  return out;
}

/**
 * 将原始 CDP AXNode 列表清洗为紧凑交互/语义节点数组（纯函数，便于离线单测）。
 */
export function normalizeAxTreeNodes(rawNodes, { frameId = "", includeAllRoles = false, limit = 150 } = {}) {
  const nodes = Array.isArray(rawNodes) ? rawNodes : [];
  const max = Math.max(1, Math.min(Number(limit) || 150, 500));
  const items = [];
  let eligibleCount = 0;

  for (const node of nodes) {
    if (!node || node.ignored) continue;
    const role = cleanText(node.role?.value).toLowerCase();
    if (!includeAllRoles) {
      if (IGNORED_CONTAINER_ROLES.has(role)) continue;
      if (!INTERACTIVE_AX_ROLES.has(role)) continue;
    } else if (!role || role === "inlinetextbox") {
      continue;
    }

    const name = cleanText(node.name?.value).slice(0, 120);
    const value = cleanText(node.value?.value).slice(0, 120);
    const props = readAxProps(node.properties);
    const backendDOMNodeId = Number.isInteger(node.backendDOMNodeId) ? node.backendDOMNodeId : null;

    // 过滤既无名称也无值、且非输入框/复选框/弹窗的空壳节点
    if (
      !name &&
      !value &&
      role !== "textbox" &&
      role !== "searchbox" &&
      role !== "combobox" &&
      role !== "checkbox" &&
      role !== "radio" &&
      role !== "switch" &&
      role !== "dialog" &&
      role !== "alertdialog"
    ) {
      continue;
    }

    eligibleCount += 1;
    if (items.length >= max) continue;

    const entry = {
      nodeId: String(node.nodeId ?? ""),
      backendDOMNodeId,
      frameId: String(frameId || node.frameId || ""),
      role,
      name,
    };
    if (value) entry.value = value;
    const checked = normalizeChecked(props.checked);
    if (checked !== undefined) entry.checked = checked;
    if (typeof props.expanded === "boolean") entry.expanded = props.expanded;
    if (typeof props.selected === "boolean") entry.selected = props.selected;
    if (props.disabled === true) entry.disabled = true;
    if (props.modal === true) entry.modal = true;
    if (props.required === true) entry.required = true;
    if (Number.isFinite(Number(props.level))) entry.level = Number(props.level);
    items.push(entry);
  }

  return {
    items,
    totalRawNodes: nodes.length,
    omitted: Math.max(0, eligibleCount - items.length),
  };
}

/**
 * 采集指定标签页的只读 CDP 无障碍快照，并记录代际 `snapshotId`。
 */
export async function captureAxSnapshot(
  cdp,
  tabId,
  { limit = 150, includeAllRoles = false, includeFrames = true } = {},
) {
  await cdp.ensure(tabId);
  const generation = typeof cdp.generation === "function" ? cdp.generation(tabId) : 1;
  const max = Math.max(1, Math.min(Number(limit) || 150, 500));

  let frameEntries = [];
  if (includeFrames) {
    const treeRes = await cdp.send(tabId, "Page.getFrameTree", {}).catch(() => null);
    if (treeRes?.frameTree) {
      frameEntries = collectFrameIds(treeRes.frameTree);
    }
  }

  let totalRawNodes = 0;
  let omitted = 0;
  const merged = [];

  if (frameEntries.length > 0) {
    for (const f of frameEntries) {
      let res = await cdp.send(tabId, "Accessibility.getFullAXTree", { frameId: f.frameId }).catch(() => null);
      if (!res?.nodes && f.isMain) {
        res = await cdp.send(tabId, "Accessibility.getFullAXTree", {}).catch(() => null);
      }
      if (!Array.isArray(res?.nodes)) continue;
      const norm = normalizeAxTreeNodes(res.nodes, {
        frameId: f.isMain ? "" : f.frameId,
        includeAllRoles,
        limit: Math.max(1, max - merged.length),
      });
      totalRawNodes += norm.totalRawNodes;
      omitted += norm.omitted;
      for (const item of norm.items) {
        if (merged.length < max) merged.push(item);
        else omitted += 1;
      }
    }
  } else {
    const res = await cdp.send(tabId, "Accessibility.getFullAXTree", {});
    const norm = normalizeAxTreeNodes(res?.nodes || [], {
      frameId: "",
      includeAllRoles,
      limit: max,
    });
    totalRawNodes = norm.totalRawNodes;
    omitted = norm.omitted;
    merged.push(...norm.items);
  }

  const items = merged.map((item, idx) => ({ axRef: idx + 1, ...item }));
  snapshotSeq += 1;
  const snapshotId = `ax_${tabId}_g${generation}_${snapshotSeq}`;
  const snapshot = {
    snapshotId,
    tabId,
    generation,
    capturedAt: Date.now(),
    totalRawNodes,
    omitted,
    items,
  };

  let history = tabSnapshots.get(tabId);
  if (!history) {
    history = [];
    tabSnapshots.set(tabId, history);
  }
  history.push(snapshot);
  if (history.length > MAX_SNAPSHOTS_PER_TAB) {
    history.splice(0, history.length - MAX_SNAPSHOTS_PER_TAB);
  }
  return snapshot;
}

/**
 * 校验给定 `snapshotId` 是否仍在当前页面代际内有效（页面导航或文档重置后即失效）。
 */
export function validateAxSnapshot(cdp, tabId, snapshotId) {
  const history = tabSnapshots.get(tabId) || [];
  const snap = history.find((s) => s.snapshotId === snapshotId) || null;
  if (!snap) {
    return {
      valid: false,
      stale: true,
      error: `未找到 AX 快照 ${snapshotId}，请重新调用 ax_snapshot`,
    };
  }
  const currentGen = typeof cdp.generation === "function" ? cdp.generation(tabId) : snap.generation;
  if (snap.generation !== currentGen) {
    return {
      valid: false,
      stale: true,
      error: `AX 快照 ${snapshotId} 已过期（页面已发生导航或文档更新），请重新调用 ax_snapshot`,
    };
  }
  return { valid: true, snapshot: snap };
}

export function getSavedAxSnapshot(tabId, snapshotId) {
  const history = tabSnapshots.get(tabId) || [];
  if (!snapshotId) return history.at(-1) || null;
  return history.find((s) => s.snapshotId === snapshotId) || null;
}

export function clearAxSnapshots(tabId) {
  if (tabId == null) tabSnapshots.clear();
  else tabSnapshots.delete(tabId);
}

function itemIdentityKey(item, fallbackIdx = 0) {
  if (item.backendDOMNodeId != null) {
    return `b:${item.frameId || ""}:${item.backendDOMNodeId}`;
  }
  return `s:${item.frameId || ""}:${item.role}:${item.name || fallbackIdx}`;
}

/**
 * 计算两次 AX 快照之间的增量状态差异（新增节点、消失节点、属性变化）。
 */
export function diffAxSnapshots(prevSnap, nextSnap) {
  const prevItems = Array.isArray(prevSnap?.items) ? prevSnap.items : [];
  const nextItems = Array.isArray(nextSnap?.items) ? nextSnap.items : [];
  const prevMap = new Map();
  prevItems.forEach((item, idx) => prevMap.set(itemIdentityKey(item, idx), item));
  const nextMap = new Map();
  nextItems.forEach((item, idx) => nextMap.set(itemIdentityKey(item, idx), item));

  const added = [];
  const removed = [];
  const changed = [];
  const stateKeys = ["name", "value", "checked", "expanded", "selected", "disabled"];

  for (const [key, nextItem] of nextMap.entries()) {
    const prevItem = prevMap.get(key);
    if (!prevItem) {
      added.push({ role: nextItem.role, name: nextItem.name, backendDOMNodeId: nextItem.backendDOMNodeId });
      continue;
    }
    const diffs = {};
    let hasDiff = false;
    for (const k of stateKeys) {
      if (prevItem[k] !== nextItem[k]) {
        diffs[k] = { from: prevItem[k], to: nextItem[k] };
        hasDiff = true;
      }
    }
    if (hasDiff) {
      changed.push({
        role: nextItem.role,
        name: nextItem.name || prevItem.name,
        backendDOMNodeId: nextItem.backendDOMNodeId,
        changes: diffs,
      });
    }
  }

  for (const [key, prevItem] of prevMap.entries()) {
    if (!nextMap.has(key)) {
      removed.push({ role: prevItem.role, name: prevItem.name, backendDOMNodeId: prevItem.backendDOMNodeId });
    }
  }

  return { added, removed, changed };
}

function mapDomControlRole(domItem) {
  const explicitRole = cleanText(domItem?.role).toLowerCase();
  if (explicitRole) return explicitRole;
  const tag = cleanText(domItem?.tag).toLowerCase();
  const type = cleanText(domItem?.type).toLowerCase();
  if (tag === "a") return "link";
  if (tag === "button") return "button";
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (tag === "input") {
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "search") return "searchbox";
    if (type === "button" || type === "submit" || type === "reset") return "button";
    if (type === "number") return "spinbutton";
    if (type === "range") return "slider";
    return "textbox";
  }
  return tag || "generic";
}

/**
 * 将只读 AX 快照与现有 DOM 控件通道（`listControls` / `snapshotControls`）做并行对比诊断。
 */
export function compareAxWithDom(axSnapshot, domControls) {
  const axItems = (Array.isArray(axSnapshot?.items) ? axSnapshot.items : []).filter(
    (x) => x.role !== "heading" && x.role !== "dialog" && x.role !== "alertdialog",
  );
  const domItems = Array.isArray(domControls) ? domControls : [];

  const normDom = domItems.map((d) => ({
    role: mapDomControlRole(d),
    label: cleanText(d?.label ?? d?.text ?? ""),
    checked: typeof d?.checked === "boolean" ? d.checked : undefined,
    raw: d,
  }));

  const usedDom = new Set();
  const axOnly = [];
  const stateMismatches = [];
  let matchedCount = 0;

  for (const ax of axItems) {
    const axName = cleanText(ax.name || ax.value || "");
    const matchIdx = normDom.findIndex((d, idx) => {
      if (usedDom.has(idx)) return false;
      const roleCompatible =
        d.role === ax.role ||
        ((d.role === "textbox" || d.role === "searchbox") &&
          (ax.role === "combobox" || ax.role === "searchbox" || ax.role === "textbox")) ||
        (d.role === "button" && (ax.role === "combobox" || ax.role === "switch" || ax.role === "checkbox"));
      if (!roleCompatible) return false;
      if (!axName && !d.label) return true;
      return d.label === axName || (axName && d.label.includes(axName)) || (d.label && axName.includes(d.label));
    });

    if (matchIdx === -1) {
      axOnly.push({ role: ax.role, name: ax.name, backendDOMNodeId: ax.backendDOMNodeId });
      continue;
    }

    usedDom.add(matchIdx);
    matchedCount += 1;
    const domHit = normDom[matchIdx];
    if (typeof ax.checked === "boolean" && typeof domHit.checked === "boolean" && ax.checked !== domHit.checked) {
      stateMismatches.push({
        role: ax.role,
        name: ax.name || domHit.label,
        axChecked: ax.checked,
        domChecked: domHit.checked,
      });
    }
  }

  const domOnly = normDom
    .filter((_d, idx) => !usedDom.has(idx))
    .map((d) => ({ role: d.role, label: d.label }));

  return {
    axCount: axItems.length,
    domCount: normDom.length,
    matchedCount,
    axOnly,
    domOnly,
    stateMismatches,
  };
}

/**
 * 格式化为紧凑可读文本表。
 */
export function formatAxSnapshot(snapshot, { limit = 80 } = {}) {
  const items = Array.isArray(snapshot?.items) ? snapshot.items.slice(0, limit) : [];
  const lines = items.map((item) => {
    const flags = [];
    if (item.checked !== undefined) flags.push(`checked=${item.checked}`);
    if (item.expanded !== undefined) flags.push(`expanded=${item.expanded}`);
    if (item.selected) flags.push("selected");
    if (item.disabled) flags.push("disabled");
    if (item.modal) flags.push("modal");
    const stateStr = flags.length ? ` (${flags.join(", ")})` : "";
    const valStr = item.value ? ` val="${item.value}"` : "";
    const bidStr = item.backendDOMNodeId != null ? ` #b${item.backendDOMNodeId}` : "";
    return `[ax#${item.axRef}${bidStr}] ${item.role} ${item.name || ""}${valStr}${stateStr}`.trim();
  });
  return lines.join("\n");
}

/**
 * 通过 `backendDOMNodeId` 滚动目标进视口并计算中心坐标（供 `resolvePoint` 使用）。
 */
export async function resolvePointByBackendNodeId(
  cdp,
  tabId,
  backendDOMNodeId,
  { frameOffset = { x: 0, y: 0 } } = {},
) {
  const backendNodeId = Number(backendDOMNodeId);
  if (!Number.isInteger(backendNodeId) || backendNodeId <= 0) {
    throw new Error("无效的 backendDOMNodeId");
  }
  await cdp.send(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => {});

  let quad = null;
  const quadsRes = await cdp.send(tabId, "DOM.getContentQuads", { backendNodeId }).catch(() => null);
  if (Array.isArray(quadsRes?.quads) && quadsRes.quads.length > 0 && quadsRes.quads[0].length >= 8) {
    quad = quadsRes.quads[0];
  } else {
    const boxRes = await cdp.send(tabId, "DOM.getBoxModel", { backendNodeId }).catch(() => null);
    const candidate = boxRes?.model?.content || boxRes?.model?.border || null;
    if (Array.isArray(candidate) && candidate.length >= 8) {
      quad = candidate;
    }
  }
  if (!quad) {
    throw new Error(`backendDOMNodeId=${backendNodeId} 没有可见几何盒模型`);
  }

  const xs = [quad[0], quad[2], quad[4], quad[6]].map(Number);
  const ys = [quad[1], quad[3], quad[5], quad[7]].map(Number);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const width = maxX - minX;
  const height = maxY - minY;
  if (!(width > 0 && height > 0)) {
    throw new Error(`backendDOMNodeId=${backendNodeId} 可点击区域宽高为 0`);
  }

  const localX = Math.round(minX + width / 2);
  const localY = Math.round(minY + height / 2);
  const desc = await cdp.send(tabId, "DOM.describeNode", { backendNodeId }).catch(() => null);
  const tag = String(desc?.node?.localName || desc?.node?.nodeName || "element").toLowerCase();

  return {
    x: localX + (frameOffset.x || 0),
    y: localY + (frameOffset.y || 0),
    localX,
    localY,
    width: Math.round(width),
    height: Math.round(height),
    tag,
    backendDOMNodeId: backendNodeId,
  };
}
