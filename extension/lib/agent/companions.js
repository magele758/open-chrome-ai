/**
 * Page-level bridges to other installed extensions.
 * Chrome forbids extension→extension sendMessage unless the target lists us in
 * externally_connectable.ids. Automa and COSE expose a MAIN-world page API instead.
 */

export const COMPANIONS = [
  {
    id: "infppggnoaenmfagbfknfkancpbljcca",
    name: "Automa",
    via: "automa:execute-workflow",
    tools: ["automa_execute"],
  },
  {
    id: "ilhikcdphhpjofhlnbojifbihhfmmhfk",
    name: "COSE",
    via: "window.$cose",
    tools: ["cose_accounts", "cose_publish"],
  },
];

/** MAIN world. */
export function probeCompanions() {
  const w = globalThis;
  const cose = w.$cose;
  return {
    automa: Boolean(w.isAutomaInjected),
    cose: Boolean(cose && typeof cose.getAccounts === "function"),
  };
}

/** MAIN world. */
export function automaExecute(detail) {
  const w = globalThis;
  if (!w.isAutomaInjected) {
    return { ok: false, error: "当前页没有 Automa。打开任意 https 网页后再试，或确认已安装 Automa。" };
  }
  const payload = detail && typeof detail === "object" ? detail : {};
  if (!payload.id && !payload.publicId) {
    return { ok: false, error: "需要 Automa 工作流的 id 或 publicId（在工作流设置里复制）。" };
  }
  const Ev = w.CustomEvent;
  w.dispatchEvent(new Ev("automa:execute-workflow", { detail: payload }));
  w.dispatchEvent(new Ev("__automaExecuteWorkflow", { detail: payload }));
  return { ok: true, dispatched: true, id: payload.id || payload.publicId };
}

/** MAIN world. */
export async function coseGetAccounts() {
  const api = globalThis.$cose;
  const accounts = await api.getAccounts();
  return {
    ok: true,
    platforms: (accounts || []).map((a) => ({
      id: a.uid || a.type,
      title: a.title || a.displayName,
      loggedIn: Boolean(a.loggedIn),
    })),
  };
}

/** MAIN world. */
export async function cosePublish(opts) {
  const api = globalThis.$cose;
  if (!api || typeof api.addTask !== "function") {
    return { ok: false, error: "当前页没有 COSE。打开任意 https 网页后再试。" };
  }
  const title = String(opts?.title || "").trim();
  const markdown = String(opts?.markdown || opts?.content || "").trim();
  if (!title || !markdown) return { ok: false, error: "需要 title 和 markdown。" };
  const want = new Set((opts?.platforms || []).map((s) => String(s).toLowerCase()));
  if (!want.size) return { ok: false, error: "需要 platforms，例如 [\"zhihu\",\"juejin\"]。" };

  const accounts = await api.getAccounts();
  const selected = (accounts || []).filter((a) => {
    const id = String(a.uid || a.type || "").toLowerCase();
    return want.has(id);
  });
  if (!selected.length) {
    return {
      ok: false,
      error: "没有匹配的平台。",
      available: (accounts || []).map((a) => a.uid || a.type),
    };
  }
  selected.forEach((a) => {
    a.checked = true;
  });

  await new Promise((resolve, reject) => {
    try {
      api.addTask(
        {
          post: {
            title,
            content: markdown,
            markdown,
            desc: String(opts?.desc || "").slice(0, 200),
          },
          accounts: selected,
        },
        null,
        () => resolve(),
      );
    } catch (err) {
      reject(err);
    }
  });

  return {
    ok: true,
    platforms: selected.map((a) => a.uid || a.type),
  };
}
