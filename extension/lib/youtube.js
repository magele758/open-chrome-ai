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
    const text = ev.segs.map((s) => s.utf8 || "").join("").replace(/\s+/g, " ").trim();
    if (!text) continue;
    cues.push({ start: (ev.tStartMs || 0) / 1000, end: ((ev.tStartMs || 0) + (ev.dDurationMs || 0)) / 1000, text });
  }
  return cues;
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
  const response = await fetch(url);
  if (!response.ok) return { status: "missing", cues: [], text: "" };
  const json = await response.json();
  const cues = parseJson3(json);
  const text = cues
    .map((c) => `[${formatTime(c.start)}] ${c.text}`)
    .join("\n");
  return { status: cues.length ? "ready" : "missing", cues, text, complete: true, language: track.languageCode };
}
