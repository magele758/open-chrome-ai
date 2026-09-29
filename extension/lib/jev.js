// Connection settings only. Decision policies belong to the new agent-loop adapter.
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";

export function normalizeJevSettings(raw = {}) {
  return {
    ...raw,
    enabled: raw?.enabled === true,
    baseUrl: typeof raw?.baseUrl === "string" ? raw.baseUrl.trim() : JEV_ENDPOINT,
    model: typeof raw?.model === "string" ? raw.model.trim() : JEV_MODEL,
    apiKey: typeof raw?.apiKey === "string" ? raw.apiKey.trim() : "",
  };
}

export function isJevConfigured(config) {
  if (!config?.model?.trim() || !config?.apiKey?.trim()) return false;
  try {
    const url = new URL(config.baseUrl);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}

export async function testJevConnection(config, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const settings = normalizeJevSettings(config);
  if (!isJevConfigured(settings)) throw new Error("请填写模型名称、API Key 和有效的 HTTP(S) 服务地址。");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    const response = await fetchImpl(settings.baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.apiKey}` },
      redirect: "error",
      signal: controller.signal,
      body: JSON.stringify({
        model: settings.model,
        state: "PageLens connection test. The status is ready.",
        questions: { ready: { type: "noul", instructions: "Does the state say the status is ready?" } },
      }),
    });
    // Don't reflect arbitrary response bodies: they can contain echoed credentials.
    if (!response.ok) throw new Error(`连接失败（HTTP ${response.status}），请检查地址、密钥和模型。`);
    const data = await response.json();
    const probability = data?.answers?.ready?.noul;
    if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new Error("服务未返回有效的 JEV 结构化判断，请检查接口地址。");
    }
    return { ms: Date.now() - start };
  } catch (error) {
    if (controller.signal.aborted) throw new Error("连接超时，请检查服务后重试。");
    if (error instanceof TypeError) throw new Error("无法连接 JEV 服务，请检查网络和接口地址。");
    if (error instanceof SyntaxError) throw new Error("服务返回了无效数据，请检查 JEV 接口地址。");
    throw error;
  } finally { clearTimeout(timer); }
}
