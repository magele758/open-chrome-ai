import assert from "node:assert/strict";
import { formatTracePayload } from "../lib/debug/langfuse-exporter.js";
import {
  isSensitiveFieldKey,
  sanitizePayload,
  sanitizeString,
  sanitizeUrl,
} from "../lib/debug/sanitizer.js";

// 1. 敏感键识别（strict vs loop）
{
  for (const k of [
    "apiKey",
    "api_key",
    "openai.apiKey",
    "secretKey",
    "client_secret",
    "password",
    "Authorization",
    "cookie",
    "set-cookie",
    "private_key",
    "session_id",
    "sessionId",
    "credential",
  ]) {
    assert.equal(isSensitiveFieldKey(k, { profile: "strict" }), true, `strict key: ${k}`);
    assert.equal(isSensitiveFieldKey(k, { profile: "loop" }), true, `loop key: ${k}`);
  }
  assert.equal(isSensitiveFieldKey("headers", { profile: "strict" }), true);
  assert.equal(isSensitiveFieldKey("blob", { profile: "strict" }), true);
  assert.equal(isSensitiveFieldKey("pageUrl", { profile: "strict" }), false);
  console.log("PASS 1: sensitive key detection covers strict and loop profiles");
}

// 2. URL 脱敏双档对比（strict 强制剥离 ?query 与 #hash；loop 保留非敏感路由仅擦除敏感参数与口令）
{
  const oauthUrl = "https://auth.example.com/oauth/callback?code=secret_code_123&mallId=77#/token=abc";
  assert.equal(
    sanitizeUrl(oauthUrl, { profile: "strict" }),
    "https://auth.example.com/oauth/callback",
    "strict strips all query params and hash fragments",
  );
  assert.equal(
    sanitizeUrl(oauthUrl, { profile: "loop" }),
    "https://auth.example.com/oauth/callback?code=[REDACTED]&mallId=77#/token=abc",
    "loop redacts sensitive query param while keeping mallId & hash route",
  );

  const basicAuthUrl = "https://admin:super_pass@internal.example.org/api/v1?q=test";
  assert.equal(sanitizeUrl(basicAuthUrl, { profile: "strict" }), "https://internal.example.org/api/v1");
  assert.equal(sanitizeUrl(basicAuthUrl, { profile: "loop" }), "https://admin:[REDACTED]@internal.example.org/api/v1?q=test");
  console.log("PASS 2: URL sanitization enforces strict query/hash stripping vs loop route preservation");
}

// 3. 令牌、JWT、内联图片 Base64、PII 掩码与超长 DOM 截断
{
  const fakeJwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  const inlinePng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const rawDom = [
    `Authorization: Bearer secret_bearer_tok_999`,
    `Basic dXNlcjpwYXNzd29yZA==`,
    `OpenAI: sk-liveSecretKeyAbcdef123456`,
    `Langfuse: pk-lf-pub123456 sk-lf-sec987654`,
    `JWT: ${fakeJwt}`,
    `Image: ${inlinePng}`,
    `客服邮箱 support@shop.example.cn 手机 13987654321 身份证 11010119900307451X`,
    `URL: https://seller.example.com/order/detail?orderSn=9988&access_token=xyz#section-price`,
    "正文填充：" + "商".repeat(600),
  ].join(" | ");

  const strictOut = sanitizeString(rawDom, { profile: "strict", maxChars: 500, maskPii: true });
  for (const leaked of [
    "secret_bearer_tok_999",
    "dXNlcjpwYXNzd29yZA==",
    "sk-liveSecretKeyAbcdef123456",
    "pk-lf-pub123456",
    "sk-lf-sec987654",
    fakeJwt,
    "iVBORw0KGgo",
    "support@shop.example.cn",
    "13987654321",
    "11010119900307451X",
    "orderSn=9988",
    "access_token=xyz",
    "#section-price",
  ]) {
    assert.ok(!strictOut.includes(leaked), `strict sanitizer must scrub ${leaked}`);
  }
  assert.match(strictOut, /\[IMAGE_DATA_URL len=\d+\]/);
  assert.match(strictOut, /\[EMAIL_REDACTED\]/);
  assert.match(strictOut, /\[PHONE_REDACTED\]/);
  assert.match(strictOut, /\[ID_REDACTED\]/);
  assert.match(strictOut, /\[TRUNCATED \d+ chars\]$/);

  // loop 档保留原始 data:image 字符串（交由 run-recorder 拆离落盘），但仍擦除所有密钥
  assert.equal(sanitizeString(inlinePng, { profile: "loop" }), inlinePng);
  const loopObj = sanitizePayload(
    {
      apiKey: "sk-loopSecret123456",
      change: { key: "tts.apiKey", value: "tts-secret-val", name: "TTS" },
      note: `Bearer tok_abc ${fakeJwt}`,
    },
    { profile: "loop" },
  );
  assert.equal(loopObj.apiKey, "[REDACTED]");
  assert.equal(loopObj.change.value, "[REDACTED]");
  assert.equal(loopObj.change.name, "TTS");
  assert.ok(!loopObj.note.includes("tok_abc") && !loopObj.note.includes(fakeJwt));
  console.log("PASS 3: strict & loop sanitizers scrub tokens, JWT, inline images, PII, and overlong DOM text");
}

// 4. Langfuse 远程上报前严格脱敏拦截（保留信封 sessionId，擦除正文/URL 参数/Token/PII）
{
  const payload = formatTracePayload(
    {
      sessionId: "sess-keep-id-001",
      sessionTitle: "客户 13800138000 的订单排障",
      userPrompt: "打开 https://merchant.example.com/list?token=oauth_999#frag 并使用 sk-remoteLeakKey12345678",
      botResponse: "已联系 merchant@example.com 处理",
      model: "gpt-test",
      status: "done",
      page: {
        url: "https://merchant.example.com/list?token=oauth_999#frag",
        title: "列表页",
      },
      steps: [
        {
          type: "tool_exec",
          name: "extract_page",
          args: { apiKey: "inline_secret_key", url: "https://merchant.example.com/detail?sig=123" },
          resultSummary: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD",
          durationMs: 25,
        },
      ],
    },
    { release: "0.12.1" },
  );

  const serialized = JSON.stringify(payload);
  const traceEvent = payload.batch.find((x) => x.type === "trace-create");
  assert.equal(traceEvent.body.sessionId, "sess-keep-id-001", "Langfuse envelope sessionId preserved for session grouping");
  for (const forbidden of [
    "13800138000",
    "oauth_999",
    "#frag",
    "sk-remoteLeakKey12345678",
    "merchant@example.com",
    "inline_secret_key",
    "sig=123",
    "/9j/4AAQSkZJRgABAQAAAQABAAD",
  ]) {
    assert.ok(!serialized.includes(forbidden), `Langfuse payload must not leak ${forbidden}`);
  }
  console.log("PASS 4: formatTracePayload enforces strict sanitization before remote Langfuse export");
}

console.log("ALL PASS test_debug_sanitizer.mjs");
