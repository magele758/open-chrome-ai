import { collapseRollingCues } from "./asr.js";
import { readYoutubeCaptionTracks } from "./extract.js";
import { formatTime } from "./prompts.js";

function isYoutube(url) {
  try {
    const u = new URL(url);
    return /(^|\.)youtube\.com$/.test(u.hostname) || u.hostname === "youtu.be";
  } catch {
    return false;
  }
}

function pickTrack(tracks) {
  if (!tracks?.length) return null;
  const scored = tracks.map((t) => {
    const lang = (t.languageCode || "").toLowerCase();
    let score = 0;
    if (lang.startsWith("zh")) score += 5;
    if (lang.startsWith("en")) score += 3;
    if (t.kind !== "asr") score += 2;
    return { t, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].t;
}

function parseJson3(json) {
  const events = json.events || [];
  const cues = [];
  for (const ev of events) {
    if (!ev.segs) continue;
    const joined = ev.segs.map((s) => s.utf8 || "").join("");
    const line = joined.includes("\n") ? joined.slice(joined.lastIndexOf("\n") + 1) : joined;
    const text = line.replace(/\s+/g, " ").trim();
    if (!text) continue;
    cues.push({ start: (ev.tStartMs || 0) / 1000, end: ((ev.tStartMs || 0) + (ev.dDurationMs || 0)) / 1000, text });
  }
  return cues;
}

async function fetchCaptionJson(url, tabId) {
  try {
    const response = await fetch(url);
    if (response.ok) return response.json();
  } catch {
    /* extension-context fetch is often blocked; try the page next */
  }
  if (!tabId || typeof chrome.scripting?.executeScript !== "function") return null;
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: async (href) => {
        try {
          const response = await fetch(href);
          if (!response.ok) return null;
          return response.json();
        } catch {
          return null;
        }
      },
      args: [url],
    });
    return result || null;
  } catch {
    return null;
  }
}

export async function loadYoutubeCaptions(tabId, pageUrl) {
  if (!isYoutube(pageUrl)) return { status: "n/a", cues: [], text: "" };
  let tracks = [];
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: readYoutubeCaptionTracks,
    });
    tracks = result || [];
  } catch {
    tracks = [];
  }
  const track = pickTrack(tracks);
  if (!track?.baseUrl) return { status: "missing", cues: [], text: "" };
  const url = track.baseUrl.includes("fmt=") ? track.baseUrl : `${track.baseUrl}&fmt=json3`;
  const json = await fetchCaptionJson(url, tabId);
  if (!json) return { status: "missing", cues: [], text: "" };
  const cues = collapseRollingCues(parseJson3(json));
  const text = cues
    .map((c) => `[${formatTime(c.start)}] ${c.text}`)
    .join("\n");
  return { status: cues.length ? "ready" : "missing", cues, text, complete: true, language: track.languageCode };
}
