import { renderAttach } from "./composer.js";
import { $ } from "./dom.js";
import { flagInjection, ingestTaint, showHitlModal, updateHitlBadge } from "./hitl-ui.js";
import { renderContext } from "./media-chrome.js";
import {
  createThinkingBox,
  fillBotBody,
  fillToolTrace,
  finishTraceTool,
  maybeUploadTraceToLangfuse,
  pushTraceItem,
  renderMessages,
  renderSkills,
  setUiErrorObserver,
  syncLiveStatus,
  updateThinkingBox,
} from "./messages.js";
import { applyUiFont, renderModelLine, setSendButton, skillsOn } from "./model-line.js";
import { messageScroll, settingsPage } from "./panel-refs.js";
import { ensureSessionId, persistSession, setView, settleBusy } from "./session.js";
import { renderSettingsForm } from "./settings-form.js";
import { ensureSkillsMeta } from "./slash-menu.js";
import { state } from "./state.js";
import { refreshTab } from "./tab-context.js";
import { applyUiTheme } from "./theme.js";
import { approvalQueue, trustPanel } from "./trust-runtime.js";
import { applyCaptions, captureTab } from "./video-actions.js";
import { resolveClickElementText } from "../lib/agent/click-label.js";
import { isResumableRun } from "../lib/agent/context.js";
import { buildEgressPolicy } from "../lib/agent/egress.js";
import { auditConfirmReason, auditToolCall } from "../lib/agent/guardrail.js";
import { LOOP_ENGINE_ID, createKernelAgentLoop } from "../lib/agent/loop-kernel.js";
import { shortcutsAsSkills, skillCatalogText } from "../lib/agent/skills.js";
import {
  checkHitlRequirement,
  createAgentTools,
  resolveActiveTools,
  resolveHitlTargetUrl,
  urlOrigin,
} from "../lib/agent/tools.js";
import { extractCapsule, mergeCapsules } from "../lib/agent/trust/capsule.js";
import { formatTrustDenial } from "../lib/agent/trust/decide.js";
import { normalizeIrreversibleActions } from "../lib/agent/trust/irreversible.js";
import { inject, injectFrames } from "../lib/chrome.js";
import { debugLog } from "../lib/debug-log.js";
import { splitThinking } from "../lib/markdown.js";
import { multimodalUserContent, streamTurn } from "../lib/openai.js";
import { loadTabPack } from "../lib/page-pack.js";
import { packToContext, systemPrompt } from "../lib/prompts.js";
import {
  createRunId,
  formatTimestampForFilename,
  persistRunBundle,
  stripAttachedPageContext,
} from "../lib/run-recorder.js";
import { ensureSkillBody } from "../lib/skill-folder.js";
import { composeSkillPrompt, userInvokedSkill } from "../lib/slash.js";
import { isModelReady, resolveModel } from "../lib/storage.js";
import { detectInjection, withUntrustedOutput } from "../lib/untrusted.js";
import {
  WORKFLOW_MODEL_ID,
  formatWorkflowSummary,
  isWorkflowDirectiveText,
  runDeterministicWorkflow,
} from "../lib/agent/workflow-runner.js";

const AGENT_BUSY_SESSION_KEY = "pl.agent.busy";

function writeAgentBusyState(busy, runId = "") {
  try {
    const area = globalThis.chrome?.storage?.session;
    if (!area?.set) return;
    Promise.resolve(
      area.set({
        [AGENT_BUSY_SESSION_KEY]: {
          busy: Boolean(busy),
          runId: String(runId || ""),
          updatedAt: Date.now(),
        },
      }),
    ).catch(() => {});
  } catch {
    /* ignore session storage errors */
  }
}

function currentKind(wantImage) {
  return wantImage || state.image ? "multimodal" : "text";
}

function needModelMessage(kind) {
  return kind === "multimodal"
    ? "未配置多模态模型。点右上角「设」，或勾选「与文本模型相同」。"
    : "未配置文本模型。点右上角「设」添加服务商并勾选模型。";
}

function requireModel(kind) {
  const model = resolveModel(state.settings, kind);
  if (isModelReady(model)) return model;
  console.warn("[pagelens] no-model", kind);
  const el = $("save-status");
  if (el) {
    el.textContent = needModelMessage(kind);
    el.className = "status bad";
  }
  return null;
}

function isPlaceholderBotText(text) {
  const s = String(text || "").trim();
  return !s || s === "…";
}

function afterLive(wrap) {
  return wrap.querySelector(":scope > .stream-live") || wrap.querySelector(":scope > .who");
}

function paintBot(botMsg) {
  const bots = document.querySelectorAll("#msgs .msg.bot");
  const wrap = bots[bots.length - 1];
  if (!wrap) return;
  syncLiveStatus(wrap, botMsg, { streaming: state.busy && !botMsg.metrics && !botMsg.error });
  const trace = Array.isArray(botMsg.trace) ? botMsg.trace : [];
  let traceEl = wrap.querySelector(".tool-trace") || wrap.querySelector(".trace");
  if (trace.length) {
    if (!traceEl) {
      traceEl = document.createElement("div");
      traceEl.className = "tool-trace";
      const anchor = afterLive(wrap);
      if (anchor) anchor.after(traceEl);
      else wrap.prepend(traceEl);
    }
    traceEl.className = "tool-trace";
    const sig = trace.map((t) => [t.id, t.status, t.ok, t.preview?.length, t.durationMs].join(":")).join("|");
    if (traceEl.dataset.sig !== sig) {
      fillToolTrace(traceEl, trace, { live: true });
      traceEl.dataset.sig = sig;
    }
  }

  const { thinking, answer, isStreamingThinking } = splitThinking(botMsg.text, botMsg.thinking);
  const isThinkingNow = state.busy && (isStreamingThinking || (!answer && Boolean(thinking)));

  let thinkingEl = wrap.querySelector(".thinking-box");
  if (thinking) {
    if (!thinkingEl) {
      thinkingEl = createThinkingBox(thinking, { isStreaming: isThinkingNow });
      const anchor = wrap.querySelector(".tool-trace") || wrap.querySelector(".trace") || afterLive(wrap);
      anchor ? anchor.after(thinkingEl) : wrap.prepend(thinkingEl);
    } else {
      updateThinkingBox(thinkingEl, thinking, { isStreaming: isThinkingNow });
    }
  } else if (thinkingEl) {
    thinkingEl.remove();
    thinkingEl = null;
  }

  let body = wrap.querySelector(".body");
  const displayText = answer && answer !== "…" ? answer : "";
  if (displayText) {
    if (!body) {
      body = document.createElement("div");
      body.className = "body";
      const afterEl = thinkingEl || wrap.querySelector(".tool-trace") || wrap.querySelector(".trace") || afterLive(wrap);
      if (afterEl) afterEl.after(body);
      else wrap.appendChild(body);
    }
    fillBotBody(body, displayText, { mermaid: false });
  } else if (body && !displayText) {
    body.innerHTML = "";
  }

  wrap.querySelector(".msg-footer")?.remove();
  messageScroll?.onContentGrow();
}

function lastUserAskedForSkill() {
  const lastUser = [...state.messages].reverse().find((m) => m.role === "user" && m.text);
  return userInvokedSkill(lastUser?.text || "");
}

function confirmAgentSettingsChange({ text, sensitive, reason, signal }) {
  const why = reason ? `\n模型说明（仅供参考，以下方对比为准）：${reason}` : "";
  return new Promise((resolve) => {
    showHitlModal({
      toolName: "update_settings",
      title: "修改设置需要确认",
      reason: (sensitive
        ? "⚠️ 包含安全相关设置（确认模式、本机权限、外部入口、服务地址或密钥）。请确认是你本人要求的修改，而不是网页内容诱导。"
        : "Agent 请求修改以下设置，确认后立即生效并保存。") + why,
      detail: text,
      allowRemember: false,
      approveLabel: "确认修改",
      armMs: sensitive ? 1500 : 0,
      signal,
      timeoutSeconds: Math.max(60, state.settings.hitlTimeoutSeconds || 30),
      onDecision: (decision) => {
        debugLog("settings.agent.decision", { allow: Boolean(decision?.allow), sensitive: Boolean(sensitive) });
        resolve(decision);
      },
    });
  });
}

function applyAgentSettings(saved) {
  state.settings = saved;
  applyUiFont(saved.uiFont);
  applyUiTheme(saved.uiTheme, saved.uiThemeColors);
  renderModelLine();
  updateHitlBadge();
  renderSkills();
  if (!$("view-settings")?.classList.contains("hidden")) renderSettingsForm();
  else settingsPage?.refreshSummary();
}

function createPageLensLoop(host) {
  return createKernelAgentLoop(host);
}

async function resolveSidepanelPageSnapshot(preferredTabId = null) {
  const candidateId =
    preferredTabId != null && preferredTabId !== "" && Number.isInteger(Number(preferredTabId))
      ? Number(preferredTabId)
      : (Number.isInteger(state.tab?.id) ? state.tab.id : null);
  if (candidateId != null && typeof globalThis.chrome?.tabs?.get === "function") {
    try {
      const liveTab = await chrome.tabs.get(candidateId);
      if (liveTab) {
        return {
          tabId: Number.isInteger(liveTab.id) ? liveTab.id : candidateId,
          url: String(liveTab.url || state.tab?.url || state.pack?.url || ""),
          title: String(liveTab.title || state.tab?.title || state.pack?.title || ""),
        };
      }
    } catch {
      /* fallback to cached state */
    }
  }
  const fallbackTabId = candidateId ?? (Number.isInteger(state.tab?.id) ? state.tab.id : null);
  const fallbackUrl = String(state.tab?.url || state.pack?.url || "");
  const fallbackTitle = String(state.tab?.title || state.pack?.title || "");
  if (fallbackTabId == null && !fallbackUrl && !fallbackTitle) return null;
  return {
    tabId: fallbackTabId,
    url: fallbackUrl,
    title: fallbackTitle,
  };
}

async function executeLoop({
  userText,
  rawUserText,
  attachedContextChars = 0,
  history,
  resume,
  turnsUsed,
  lastText,
  botMsg,
  model,
  clearImage,
  workflowMode = false,
}) {
  const strippedPromptInfo = stripAttachedPageContext(userText || "");
  const cleanLoopUserText =
    rawUserText !== undefined ? String(rawUserText) : strippedPromptInfo.cleanPrompt;
  const isWorkflowRun = Boolean(workflowMode) || isWorkflowDirectiveText(cleanLoopUserText);
  const effectiveAttachedContextChars = isWorkflowRun
    ? 0
    : Math.max(0, Number(attachedContextChars) || strippedPromptInfo.strippedChars || 0);
  const runId = createRunId("run");
  const runStartTime = Date.now();
  const startedAtIso = new Date(runStartTime).toISOString();
  const runTraceSteps = [];
  const sidepanelErrors = [];
  let latestHistory = Array.isArray(history) ? [...history] : [];
  let systemPromptText = "";
  let errorText = null;
  let runEndReason = "stop";
  let runStatus = "done";
  let queuedForApproval = false;
  let result = null;
  let failed = false;
  let setupFailed = false;
  let lastCapturedImageUrl = null;
  let lockedEndedAtIso = null;
  let lockedTsSlug = null;

  const initialPage = await resolveSidepanelPageSnapshot();
  setUiErrorObserver((msg) => {
    const ts = Date.now();
    const iso = new Date(ts).toISOString();
    const message = String(msg ?? "");
    sidepanelErrors.push({ timestamp: ts, isoTime: iso, message });
    runTraceSteps.push({ type: "ui_error", message, timestamp: ts, isoTime: iso });
  });

  state.busy = true;
  writeAgentBusyState(true, runId);

  try {
    const useSkills = !isWorkflowRun && skillsOn() && lastUserAskedForSkill();
    const hitlUserUrl = state.tab?.url || state.pack?.url || "";
    const skills = useSkills ? [...(state.skills || []), ...shortcutsAsSkills(state.settings)] : [];
    let rawTools;
    let tools;
    let loop;
    try {
      const requestedDomains = new Set(state.activeToolDomains || []);
      rawTools = createAgentTools({
        getTabId: () => state.tab?.id,
        getWindowId: () => state.tab?.windowId,
        refreshPack: async (tabId) => {
          // Always re-extract the task's page. refreshTab can return a stale
          // pack during transcription, or switch targets when the user browses.
          const pack = await loadTabPack(tabId);
          if (state.tab?.id === tabId) state.pack = { ...state.pack, ...pack };
          return pack;
        },
        capture: captureTab,
        setImage: (url) => {
          lastCapturedImageUrl = url;
          state.image = url;
          renderAttach();
        },
        onTabsMutated: async () => {
          await refreshTab();
        },
        getTaskGroupId: () => state.taskGroupId,
        setTaskGroupId: (id) => {
          state.taskGroupId = id;
        },
        getTaskGroupTitle: () => {
          const user = [...state.messages].reverse().find((m) => m.role === "user" && m.text);
          const line = String(user?.text || "任务").split("\n")[0].trim().slice(0, 24);
          return `PL · ${line || "任务"}`;
        },
        getAbortSignal: () => state.abort?.signal,
        getSessionId: () => state.sessionId,
        setCaptions: applyCaptions,
        onTranscribeProgress: (info) => {
          state.transcribe = { ...(state.transcribe || {}), ...info };
          renderContext();
        },
        onRequestToolsets: (domains) => {
          for (const d of domains) {
            requestedDomains.add(d);
            state.activeToolDomains?.add?.(d);
          }
        },
        skills,
        get settings() {
          return state.settings;
        },
        getEgressPolicy: () =>
          buildEgressPolicy({
            capsule: state.capsule,
            sourceUrl: state.tab?.url || state.pack?.url || "",
            approvedOrigins: state.hitlApprovedOrigins,
            taint: state.taint,
          }),
        get nativeShell() {
          return state.settings.nativeShell !== false;
        },
        enableSkills: useSkills,
        confirmSettingsChange: confirmAgentSettingsChange,
        onSettingsChanged: applyAgentSettings,
        exposeRefLabel: (fn) => {
          state.refLabel = fn;
        },
        // 用户在对话里要求改非安全设置、且没勾选「修改设置」确认时：直接生效 + 一键撤销
        autoApplySettings: () =>
          Boolean(state.capsule?.actions?.includes("settings")) &&
          !normalizeIrreversibleActions(state.settings.irreversibleActions).settings_change &&
          state.taint?.level !== "high",
        onSettingsAutoApplied: ({ text, undo }) => {
          debugLog("settings.agent.autoApplied", { text: String(text || "").slice(0, 200) });
          trustPanel.showUndo({ text, undo });
        },
      });
      tools = withUntrustedOutput(rawTools, {
        onInjection: (hit) => flagInjection(hit, botMsg),
        onIngest: ingestTaint,
      });

      if (!isWorkflowRun) {
        systemPromptText = [systemPrompt(state.settings, { useSkills }), useSkills ? skillCatalogText(skills) : ""]
          .filter(Boolean)
          .join("\n\n");

        loop = createKernelAgentLoop({
        maxTurns: 0,
        allTools: tools,
        systemPrompt: systemPromptText,
        getToolPageContext: ({ args }) => resolveSidepanelPageSnapshot(args?.tabId),
        get tools() {
          const lastUser = [...state.messages].reverse().find((m) => m.role === "user" && m.text);
          return resolveActiveTools({
            userText: cleanLoopUserText || lastUser?.text || "",
            history,
            tools,
            hasVideo: Boolean(state.pack?.hasVideo),
            requestedDomains: Array.from(requestedDomains),
          });
        },
        async interceptToolCall({ tool, args, call, signal }) {
          const hitlMode = state.settings.hitlMode || "balanced";
          const sessionOverride = Boolean(state.sessionHitlOverride);
          const targetUrl = await resolveHitlTargetUrl(tool.name, args, {
            getTabId: () => state.tab?.id,
            getTabUrl: async (tabId) => (await chrome.tabs.get(tabId))?.url,
          });
          const refTab = args?.tabId != null && args?.tabId !== "" ? Number(args.tabId) : state.tab?.id;
          const elementText = await resolveClickElementText({
            toolName: tool.name,
            args,
            tabId: refTab,
            refLabel: state.refLabel,
            inject,
            injectFrames,
          });
          const req = checkHitlRequirement({
            toolName: tool.name,
            args,
            hitlMode,
            sessionOverride,
            targetUrl,
            userUrl: hitlUserUrl,
            approvedOrigins: state.hitlApprovedOrigins,
            injectionSuspected: state.injectionSuspected,
            capsule: state.capsule,
            taint: state.taint,
            attended: true,
            settings: state.settings,
            elementText,
          });
          debugLog("trust.decision", {
            tool: tool.name,
            decision: req.decision,
            code: req.code || "",
            inCapsule: Boolean(req.inCapsule),
            taint: req.taint,
            irreversible: req.irreversible?.id || "",
            egress: req.egress?.channel || "",
          });
          if (req.decision === "deny") {
            return { allow: false, reason: formatTrustDenial(req) };
          }
          if (!req.needsConfirmation) {
            if (tool.name === "run_shell") {
              debugLog("hitl.skip", { tool: tool.name, command: args?.command || "", hitlMode, inCapsule: Boolean(req.inCapsule) });
            }
            return { allow: true };
          }

          // 用户已在侧栏批准过同一调用（之前确认超时进了待批准队列）
          if (req.irreversible) {
            const approved = await approvalQueue.consumeApproved(tool.name, args, { principal: "user" }).catch(() => null);
            if (approved) {
              debugLog("hitl.queue.consume", { tool: tool.name, pendingId: approved.id });
              return { allow: true };
            }
          }

          if (req.needsAudit && isModelReady(resolveModel(state.settings, "text"))) {
            const lastUser = [...state.messages].reverse().find((m) => m.role === "user" && m.text);
            const audit = await auditToolCall({
              toolName: tool.name,
              args,
              userText: cleanLoopUserText || lastUser?.text || "",
              model: resolveModel(state.settings, "text"),
              signal,
            });
            req.reason = auditConfirmReason(audit, req.reason);
            debugLog("hitl.audit", { tool: tool.name, command: args?.command || "", verdict: audit.verdict, risk: audit.risk, reason: audit.reason });
          }

          return new Promise((resolve) => {
            showHitlModal({
              toolName: tool.name,
              args,
              reason: req.reason,
              signal,
              allowRemember: req.allowRemember !== false,
              timeoutSeconds: state.settings.hitlTimeoutSeconds || 30,
              onDecision: async (decision) => {
                debugLog("hitl.decision", {
                  tool: tool.name,
                  command: args?.command || "",
                  allow: Boolean(decision?.allow),
                  reason: decision?.reason || req.reason || "",
                });
                if (decision?.allow && req.approveOrigin) state.hitlApprovedOrigins.add(req.approveOrigin);
                if (!decision?.allow && decision?.timedOut && req.irreversible) {
                  const entry = await approvalQueue
                    .enqueue({ toolName: tool.name, args, reason: req.reason, item: req.irreversible, principal: "user", sessionId: state.sessionId || "" })
                    .catch(() => null);
                  trustPanel.render();
                  if (entry) {
                    queuedForApproval = true;
                    resolve({ allow: false, reason: formatTrustDenial({ ...req, code: "CONFIRMATION_REQUIRED" }, { pendingId: entry.id }) });
                    return;
                  }
                }
                resolve(decision);
              },
            });
          });
        },
        model: {
          async runTurn({ messages, tools: turnTools, signal, onTextDelta, onReasoningDelta }) {
            const visionReady = Boolean(state.image) && isModelReady(resolveModel(state.settings, "multimodal"));
            const active = visionReady ? resolveModel(state.settings, "multimodal") : model;
            let msgs = messages;
            if (visionReady) {
              msgs = [
                ...messages,
                { role: "user", content: multimodalUserContent("当前标签页截图：", state.image) },
              ];
            }
            return streamTurn(active, {
              messages: msgs,
              tools: turnTools,
              signal,
              onReasoningDelta,
            }, onTextDelta);
          },
        },
      });
      console.info("[pagelens] executeLoop", {
        runId,
        tools: tools.length,
        useSkills,
        loopEngine: LOOP_ENGINE_ID,
      });
      }
    } catch (err) {
      setupFailed = true;
      failed = true;
      errorText = err?.message || String(err);
      runEndReason = "error";
      runStatus = "failed";
      console.error("[pagelens] executeLoop setup", err);
      botMsg.text = "请求失败：" + errorText;
      botMsg.error = true;
      botMsg.metrics = {
        durationMs: Math.max(1, Date.now() - runStartTime),
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        finishReason: "error",
      };
    }

    if (!setupFailed) {
      state.abort = new AbortController();
      if (isWorkflowRun) {
        state.run = {
          status: "running",
          workflow: true,
          history: [],
          lastText: "",
          turnsUsed: 0,
          startedAt: Date.now(),
        };
      } else {
        state.run = {
          status: "running",
          history: history || [],
          lastText: lastText || "",
          turnsUsed: turnsUsed || 0,
          startedAt: resume && state.run?.startedAt ? state.run.startedAt : Date.now(),
        };
      }
      setSendButton(true);

      const loopStartTime = Date.now();
      try {
        try {
          renderMessages();
        } catch (err) {
          console.error("[pagelens] renderMessages", err);
        }
        ensureSessionId();
        persistSession();
        if (isWorkflowRun) {
          const wfRes = await runDeterministicWorkflow({
            rawText: cleanLoopUserText,
            rawTools,
            getLastCapturedImage: () => lastCapturedImageUrl,
            clearLastCapturedImage: () => {
              lastCapturedImageUrl = null;
            },
            resolvePageSnapshot: resolveSidepanelPageSnapshot,
            settings: state.settings,
            signal: state.abort.signal,
            traceSteps: runTraceSteps,
            onStepStart: (ev) => {
              try {
                pushTraceItem(botMsg, {
                  kind: "tool",
                  name: ev.name,
                  args: ev.args || {},
                  status: "running",
                  ok: null,
                  preview: "",
                });
                paintBot(botMsg);
              } catch (err) {
                console.warn("[pagelens] workflow onStepStart", err);
              }
            },
            onStepDone: (ev) => {
              try {
                finishTraceTool(botMsg, {
                  name: ev.name,
                  ok: ev.ok,
                  args: ev.args,
                  content: ev.result || "",
                  durationMs: ev.durationMs || 0,
                });
                paintBot(botMsg);
              } catch (err) {
                console.warn("[pagelens] workflow onStepDone", err);
              }
            },
          });
          lockedEndedAtIso = new Date().toISOString();
          lockedTsSlug = formatTimestampForFilename(lockedEndedAtIso);
          botMsg.text = formatWorkflowSummary(wfRes);
          const wfAborted = Boolean(wfRes.aborted) || state.stopIntent === "user";
          runEndReason = wfAborted ? "abort" : (wfRes.ok ? "stop" : "error");
          runStatus = wfAborted ? "cancelled" : (wfRes.ok ? "done" : "failed");
          botMsg.error = !wfRes.ok && !wfAborted;
          failed = Boolean(botMsg.error);
          errorText = wfRes.ok || wfAborted ? null : (wfRes.errorMessage || botMsg.text);
          botMsg.metrics = {
            durationMs: Math.max(1, Date.now() - loopStartTime),
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            finishReason: runEndReason,
          };
          latestHistory = [
            ...(history || []),
            { role: "user", content: cleanLoopUserText },
            { role: "assistant", content: botMsg.text },
          ];
          result = {
            reason: runEndReason,
            turnsUsed: 0,
            text: botMsg.text,
            metrics: botMsg.metrics,
          };
          try {
            paintBot(botMsg);
          } catch (err) {
            console.warn("[pagelens] paintBot", err);
          }
        } else {
        result = await loop.run(userText, {
          sessionId: state.sessionId,
          history,
          resume: Boolean(resume),
          turnsUsed: turnsUsed || 0,
          lastText: lastText || "",
          signal: state.abort.signal,
          traceSteps: runTraceSteps,
          onReasoningDelta: (delta) => {
            if (!botMsg.thinking) botMsg.thinking = "";
            botMsg.thinking += delta;
            try {
              paintBot(botMsg);
            } catch (err) {
              console.warn("[pagelens] paintBot", err);
            }
          },
          onTextDelta: (delta) => {
            if (isPlaceholderBotText(botMsg.text)) botMsg.text = "";
            botMsg.text += delta;
            try {
              paintBot(botMsg);
            } catch (err) {
              console.warn("[pagelens] paintBot", err);
            }
          },
          onEvent: (ev) => {
            try {
              if (ev.type === "checkpoint" && Array.isArray(ev.history)) {
                latestHistory = ev.history;
              }
              if (ev.type === "checkpoint" && !ev.done) {
                state.run = {
                  status: "running",
                  history: ev.history,
                  lastText: ev.lastText,
                  turnsUsed: ev.turnsUsed,
                  startedAt: state.run?.startedAt || Date.now(),
                };
                persistSession();
              }
              if (ev.type === "compressed") {
                pushTraceItem(botMsg, { kind: "meta", name: "压缩上下文", ok: true });
                paintBot(botMsg);
              }
              if (ev.type === "turn_prepared") {
                writeAgentBusyState(true, runId);
                if (botMsg.thinking && !botMsg.thinking.endsWith("\n\n")) {
                  botMsg.thinking += "\n\n";
                }
                if (!isPlaceholderBotText(botMsg.text)) {
                  pushTraceItem(botMsg, { kind: "meta", name: "思考", ok: true });
                  botMsg.text = "";
                }
                paintBot(botMsg);
              }
              if (ev.type === "model_done" && ev.content && isPlaceholderBotText(botMsg.text)) {
                botMsg.text = ev.content;
                paintBot(botMsg);
              }
              if (ev.type === "tools_start") {
                pushTraceItem(botMsg, {
                  kind: "tool",
                  name: ev.name,
                  args: ev.args || {},
                  status: "running",
                  ok: null,
                  preview: "",
                });
                paintBot(botMsg);
              }
              if (ev.type === "tools_done") {
                finishTraceTool(botMsg, ev);
                paintBot(botMsg);
              }
            } catch (err) {
              console.warn("[pagelens] onEvent", err);
            }
          },
        });
        if (Array.isArray(result?.history)) {
          latestHistory = result.history;
        }
        if (!botMsg.error) {
          if (result?.text) botMsg.text = result.text;
          if (result?.reasoning && !botMsg.thinking) botMsg.thinking = result.reasoning;
          const parsed = splitThinking(botMsg.text, botMsg.thinking);
          if (parsed.thinking) botMsg.thinking = parsed.thinking;
          if (parsed.answer) botMsg.text = parsed.answer;
          else if (isPlaceholderBotText(botMsg.text)) {
            botMsg.text = result?.reason === "abort"
              ? "已停止。"
              : (botMsg.thinking ? "（已完成思考，未输出进一步正文）" : (result?.reason === "empty_assistant" ? "模型连续多次未返回内容（已自动重试），请重试或检查模型服务。" : "模型未返回正文，请重试或检查模型服务。"));
            botMsg.error = result?.reason !== "abort" && !botMsg.thinking;
          }
        }
        runEndReason = result?.reason || "stop";
        if (runEndReason === "abort" || state.stopIntent === "user") {
          runEndReason = "abort";
          runStatus = "cancelled";
        } else if (queuedForApproval) {
          runEndReason = "needs_approval";
          runStatus = "needs_approval";
        } else if (botMsg.error) {
          runStatus = "failed";
          errorText = errorText || botMsg.text || "empty_assistant";
        } else {
          runStatus = "done";
        }
        botMsg.metrics = result?.metrics || {
          durationMs: Math.max(1, Date.now() - loopStartTime),
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          finishReason: runEndReason,
        };
        }
      } catch (err) {
        const durMs = Math.max(1, Date.now() - loopStartTime);
        const isAbort = err?.name === "AbortError" || state.stopIntent === "user";
        if (Array.isArray(err?.history) && err.history.length > 0) {
          latestHistory = err.history;
        }
        if (runTraceSteps.length === 0 && Array.isArray(err?.traceSteps) && err.traceSteps.length > 0) {
          runTraceSteps.push(...err.traceSteps);
        }
        errorText = err?.message || String(err);
        if (err?.name === "AbortError" || isAbort) {
          console.info("[pagelens] executeLoop abort", { runId });
          botMsg.text = botMsg.text || (state.stopIntent === "user" ? "已停止。" : "已中断，重新打开侧栏会继续。");
          runEndReason = "abort";
          runStatus = "cancelled";
        } else {
          console.error("[pagelens] executeLoop", err);
          botMsg.text = "请求失败：" + errorText;
          botMsg.error = true;
          failed = true;
          runEndReason = "error";
          runStatus = "failed";
        }
        const errMetrics = err?.metrics || {};
        botMsg.metrics = {
          durationMs: Number(errMetrics.durationMs) || durMs,
          inputTokens: Number(errMetrics.inputTokens) || 0,
          outputTokens: Number(errMetrics.outputTokens) || 0,
          totalTokens: Number(errMetrics.totalTokens) || 0,
          finishReason: isAbort ? "abort" : "error",
        };
      }
    }
  } finally {
    setUiErrorObserver(null);
    const userStop = state.stopIntent === "user";
    const finished = ["stop", "max_turns", "empty_assistant"].includes(result?.reason);
    if (isWorkflowRun || userStop || finished || failed) state.run = null;
    state.busy = false;
    state.abort = null;
    state.stopIntent = null;
    setSendButton(false);
    if (clearImage) {
      state.image = null;
      renderAttach();
    }
    try {
      ensureSessionId();
      const finalPage = await resolveSidepanelPageSnapshot();
      const messagesSummary = Array.isArray(state.messages)
        ? state.messages.map((m) => ({
            role: m.role,
            textPreview: String(m.text || "").slice(0, 500),
            hasImage: Boolean(m.image),
            hasTrace: Boolean(m.trace?.length),
            error: Boolean(m.error),
          }))
        : [];
      const lastUserMsg = [...state.messages].reverse().find((m) => m.role === "user" && m.text);
      const cleanPersistedPrompt =
        rawUserText !== undefined
          ? String(rawUserText)
          : (cleanLoopUserText || lastUserMsg?.text || "");
      const persisted = await persistRunBundle({
        runId,
        source: "sidepanel",
        settings: state.settings,
        sessionId: state.sessionId || "default",
        sessionTitle: state.sessionTitle || undefined,
        startedAt: startedAtIso,
        endedAt: lockedEndedAtIso || new Date().toISOString(),
        ...(lockedTsSlug ? { tsSlug: lockedTsSlug } : {}),
        status: runStatus,
        endReason: runEndReason,
        model: isWorkflowRun
          ? WORKFLOW_MODEL_ID
          : ((typeof model === "object" ? model?.model : String(model || "")) || "unknown"),
        durationMs: botMsg.metrics?.durationMs,
        metrics: botMsg.metrics,
        initialPage,
        finalPage,
        userPrompt: cleanPersistedPrompt,
        attachedContextChars: effectiveAttachedContextChars,
        thinking: botMsg.thinking || "",
        botResponse: botMsg.text || "",
        error: errorText,
        sidepanelErrors,
        trace: botMsg.trace ? [...botMsg.trace] : [],
        steps: runTraceSteps,
        history: latestHistory,
        ...(isWorkflowRun ? { conversationMessages: latestHistory } : {}),
        systemPrompt: systemPromptText,
        messagesSummary,
      });
      if (persisted?.traceRecord) {
        botMsg.traceLog = persisted.traceRecord;
        maybeUploadTraceToLangfuse(botMsg.traceLog);
      }
    } catch (err) {
      const reason = String(err?.message || err);
      console.info("[pagelens] executeLoop persistRunBundle fallback:", reason);
      debugLog("runRecorder.sidepanelError", { runId, reason });
    } finally {
      writeAgentBusyState(false, runId);
    }
    renderMessages();
    await persistSession();
    console.info("[pagelens] executeLoop done", failed ? "fail" : result?.reason || "ok");
    debugLog("agent.loop", {
      runId,
      reason: failed ? "fail" : result?.reason || "ok",
      turns: result?.turnsUsed,
      sessionId: state.sessionId,
      windowId: state.windowId,
    });
  }
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label || `超时 ${ms}ms`)), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function sendPrompt(userText, options = {}) {
  const text = String(userText || "").trim();
  console.info("[pagelens] sendPrompt", text.slice(0, 80) || "(empty)");
  debugLog("prompt.send", {
    chars: text.length,
    preview: text.slice(0, 80),
    sessionId: state.sessionId,
    windowId: state.windowId,
  });
  if (!text && !options.image && !state.image) {
    console.warn("[pagelens] sendPrompt empty");
    return;
  }
  if (state.view !== "chat") setView("chat");
  if (state.busy) {
    console.warn("[pagelens] sendPrompt busy, abort previous then send");
    state.stopIntent = "user";
    state.abort?.abort();
    await settleBusy();
    if (state.busy) {
      console.warn("[pagelens] sendPrompt force-clear busy");
      state.busy = false;
      writeAgentBusyState(false);
      state.abort = null;
      state.stopIntent = null;
    }
  }

  const image = options.image || state.image;
  messageScroll?.reset();
  // 胶囊只从用户本人写的文字抽取，必须在页面内容拼进上下文之前
  if (text) {
    state.capsule = mergeCapsules(state.capsule, extractCapsule(text));
    debugLog("trust.capsule", { actions: state.capsule.actions, origins: state.capsule.origins, commands: state.capsule.commands.length });
  }
  state.messages.push({ role: "user", text: text || userText, image: image || null });
  const botMsg = { role: "bot", text: "…", trace: [], thinking: "" };
  state.messages.push(botMsg);
  try {
    renderMessages();
  } catch (err) {
    console.error("[pagelens] renderMessages", err);
  }

  const isWorkflow = isWorkflowDirectiveText(text);
  const wantImage = Boolean(image);
  const kind = currentKind(wantImage);
  const model = isWorkflow ? { model: WORKFLOW_MODEL_ID } : requireModel(kind);
  if (!model) {
    console.warn("[pagelens] sendPrompt no-model");
    botMsg.text = needModelMessage(kind);
    botMsg.error = true;
    renderMessages();
    return;
  }

  try {
    console.info("[pagelens] sendPrompt executeLoop");
    if (isWorkflow) {
      trustPanel.render();
      botMsg.sourceTitle = state.share ? (state.pack?.title || state.tab?.title || "") : "";
      const prior = [];
      for (const m of state.messages.slice(0, -2)) {
        if (m.error || (m.role === "bot" && !m.text)) continue;
        if (m.role === "user") prior.push({ role: "user", content: m.text });
        if (m.role === "bot") prior.push({ role: "assistant", content: m.text });
      }
      const rawPromptText = text || String(userText || "");
      await executeLoop({
        userText: rawPromptText,
        rawUserText: rawPromptText,
        attachedContextChars: 0,
        history: prior,
        resume: false,
        botMsg,
        model,
        clearImage: options.clearImage,
        workflowMode: true,
      });
      console.info("[pagelens] sendPrompt workflow ok");
      return;
    }
    if (state.share && state.tab) {
      try {
        await withTimeout(refreshTab(), 8000, "读当前页超时，先用已缓存内容。");
      } catch (err) {
        console.warn("[pagelens] refreshTab", err);
        pushTraceItem(botMsg, { kind: "meta", name: "读页", ok: false });
      }
    }
    const pack = state.share ? state.pack : null;
    const context = state.chatRef?.context
      || (pack ? packToContext(pack) : "（用户未分享页面）");
    if (pack || state.chatRef?.context) {
      ingestTaint({ source: state.chatRef?.context ? "reference" : "page", tool: "context", origin: urlOrigin(pack?.url) });
    }
    const contextHit = detectInjection(context);
    if (contextHit) flagInjection({ tool: pack ? "page" : "reference", ...contextHit }, botMsg);
    trustPanel.render();
    botMsg.sourceTitle = state.chatRef?.title
      || (state.share ? (state.pack?.title || state.tab?.title || "") : "");
    const prior = [];
    for (const m of state.messages.slice(0, -2)) {
      if (m.error || (m.role === "bot" && !m.text)) continue;
      if (m.role === "user") prior.push({ role: "user", content: m.text });
      if (m.role === "bot") prior.push({ role: "assistant", content: m.text });
    }
    let loopText = text || userText;
    if (skillsOn() && userInvokedSkill(loopText)) {
      try {
        await ensureSkillsMeta();
      } catch (err) {
        console.warn("[pagelens] skills meta", err);
        pushTraceItem(botMsg, { kind: "meta", name: "skill 扫描", ok: false });
      }
      const runtimeSkills = [...(state.skills || []), ...shortcutsAsSkills(state.settings)];
      try {
        loopText = await withTimeout(
          composeSkillPrompt(loopText, runtimeSkills, { loadBody: ensureSkillBody }),
          8000,
          "读取 skill 超时",
        );
      } catch (err) {
        console.warn("[pagelens] skill body", err);
        pushTraceItem(botMsg, { kind: "meta", name: "读取 skill", ok: false });
      }
    }
    const rawPromptText = text || String(userText || "");
    await executeLoop({
      userText: context ? `${loopText}\n\n${context}` : loopText,
      rawUserText: rawPromptText,
      attachedContextChars: context ? String(context).length : 0,
      history: prior,
      resume: false,
      botMsg,
      model,
      clearImage: options.clearImage,
    });
    console.info("[pagelens] sendPrompt ok");
  } catch (err) {
    console.error("[pagelens] sendPrompt fail", err);
    botMsg.text = "请求失败：" + (err.message || String(err));
    botMsg.error = true;
    state.busy = false;
    writeAgentBusyState(false);
    renderMessages();
  }
}

async function resumeInterruptedRun() {
  const run = state.run;
  if (!isResumableRun(run)) return;
  const model = requireModel("text");
  if (!model) return;
  if (state.share && state.tab) await refreshTab();

  let botMsg = state.messages[state.messages.length - 1];
  if (!botMsg || botMsg.role !== "bot") {
    botMsg = { role: "bot", text: run.lastText || "", trace: [] };
    state.messages.push(botMsg);
  } else if (!botMsg.text) {
    botMsg.text = run.lastText || "";
  }
  botMsg.trace = Array.isArray(botMsg.trace) ? botMsg.trace : [];
  if (!botMsg.trace.some((t) => t.name === "从中断处继续")) {
    botMsg.trace.unshift({ kind: "meta", name: "从中断处继续", ok: true });
  }

  await executeLoop({
    userText: "",
    history: run.history,
    resume: true,
    turnsUsed: run.turnsUsed,
    lastText: run.lastText,
    botMsg,
    model,
  });
}

async function runSkill(skill) {
  const prompt = String(skill?.prompt || "").trim();
  console.info("[pagelens] chip", skill?.label || "", prompt.slice(0, 80));
  if (!prompt) {
    console.warn("[pagelens] chip empty prompt");
    return;
  }
  if (skill.image) {
    const shot = await captureTab();
    if (!shot) return;
    state.image = shot;
    renderAttach();
    await sendPrompt(prompt, { image: shot, clearImage: true });
    return;
  }
  await sendPrompt(prompt);
}


export {
  currentKind,
  needModelMessage,
  requireModel,
  isPlaceholderBotText,
  paintBot,
  lastUserAskedForSkill,
  confirmAgentSettingsChange,
  applyAgentSettings,
  createPageLensLoop,
  executeLoop,
  withTimeout,
  sendPrompt,
  resumeInterruptedRun,
  runSkill,
};
