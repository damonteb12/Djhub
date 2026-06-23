import { useState, useEffect } from "react";

// ── Vibe Definitions ──────────────────────────────────────────────────────────
const VIBES = [
  { id: "hiphop",    label: "Hip Hop / Trap",       emoji: "🔥", color: "#ff4060", bpmRange: [85, 105] },
  { id: "rnb",       label: "R&B / Soul",            emoji: "💜", color: "#b06ef3", bpmRange: [65,  90] },
  { id: "afrobeats", label: "Afrobeats",             emoji: "🌍", color: "#f59e0b", bpmRange: [95, 115] },
  { id: "pop",       label: "Pop / Dance",           emoji: "💫", color: "#06b6d4", bpmRange: [110, 135] },
  { id: "classics",  label: "Classics / Old School", emoji: "👑", color: "#22c55e", bpmRange: [85, 110] },
];

const VIBE_BPM_DEFAULT = { hiphop: 95, rnb: 78, afrobeats: 105, pop: 122, classics: 96 };
const MODEL = "claude-sonnet-4-20250514";

// ── Spotify PKCE ──────────────────────────────────────────────────────────────
async function pkceChallenge() {
  const arr = crypto.getRandomValues(new Uint8Array(32));
  const verifier = btoa(String.fromCharCode(...arr)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
  return { verifier, challenge };
}

// ── Spotify API ───────────────────────────────────────────────────────────────
async function spGet(path, token) {
  const r = await fetch(`https://api.spotify.com/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (r.status === 401) throw new Error("TOKEN_EXPIRED");
  if (r.status === 429) throw new Error("Spotify rate limit hit — wait a moment and try again.");
  if (!r.ok) throw new Error(`Spotify API error (${r.status})`);
  return r.json();
}

async function fetchAllPlaylists(token) {
  let items = [], next = "/me/playlists?limit=50";
  while (next) {
    const d = await spGet(next, token);
    items = [...items, ...d.items.filter(Boolean)];
    next = d.next?.replace("https://api.spotify.com/v1", "") ?? null;
  }
  return items;
}

async function fetchPlaylistTracks(id, token) {
  let tracks = [], next = `/playlists/${id}/tracks?limit=100`;
  while (next) {
    const d = await spGet(next, token);
    const valid = d.items.filter((i) => i?.track?.id && i.track.type === "track");
    tracks = [...tracks, ...valid.map((i) => i.track)];
    next = d.next?.replace("https://api.spotify.com/v1", "") ?? null;
  }
  return tracks;
}

// Search Spotify for a suggested song → real URI so it can be saved to a playlist.
async function searchSpotifyTrack(title, artist, token) {
  const q = encodeURIComponent(`track:${title} artist:${artist}`);
  let d;
  try {
    d = await spGet(`/search?type=track&limit=1&q=${q}`, token);
  } catch (e) {
    if (e.message === "TOKEN_EXPIRED") throw e;
    // Fall back to a looser query if the strict field search errors out.
    d = await spGet(`/search?type=track&limit=1&q=${encodeURIComponent(`${title} ${artist}`)}`, token);
  }
  const hit = d.tracks?.items?.[0];
  if (!hit) return null;
  return {
    uri: hit.uri,
    id: hit.id,
    duration_ms: hit.duration_ms,
    album: hit.album,
    spotifyName: hit.name,
    spotifyArtists: hit.artists,
  };
}

async function saveSpotifyPlaylist(userId, name, uris, token) {
  const res = await fetch(`https://api.spotify.com/v1/users/${userId}/playlists`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, description: "Built with Tae Tempo Crate Builder 🎧", public: false }),
  });
  if (res.status === 401) throw new Error("TOKEN_EXPIRED");
  if (!res.ok) throw new Error(`Could not create playlist (Spotify ${res.status})`);
  const pl = await res.json();
  for (let i = 0; i < uris.length; i += 100) {
    const add = await fetch(`https://api.spotify.com/v1/playlists/${pl.id}/tracks`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ uris: uris.slice(i, i + 100) }),
    });
    if (!add.ok) throw new Error(`Playlist created but adding tracks failed (Spotify ${add.status})`);
  }
  return pl;
}

// ── Claude API ────────────────────────────────────────────────────────────────
async function callClaude(body, apiKey) {
  if (!apiKey) throw new Error("No Anthropic API key set — add it in Setup.");
  const headers = {
    "Content-Type": "application/json",
    "anthropic-dangerous-direct-browser-access": "true",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  };
  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify({ model: MODEL, ...body }),
    });
  } catch {
    throw new Error("Couldn't reach Anthropic — check your internet connection.");
  }
  if (!res.ok) {
    let detail = "";
    try {
      const e = await res.json();
      detail = e?.error?.message || "";
    } catch { /* ignore */ }
    if (res.status === 401) throw new Error("Invalid Anthropic API key — double-check it in Setup (it should start with sk-ant-).");
    if (res.status === 429) throw new Error("Anthropic rate limit reached — wait a moment and try again.");
    if (res.status === 400 && /credit|balance/i.test(detail)) throw new Error("Anthropic account is out of credits — top up at console.anthropic.com.");
    throw new Error(`Claude API error (${res.status})${detail ? ": " + detail : ""}`);
  }
  const d = await res.json();
  return d.content.map((c) => c.text || "").join("");
}

// Robustly pull a JSON object out of a Claude text response.
function parseClaudeJSON(text) {
  let clean = text.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(clean);
  } catch {
    // Last resort: grab the outermost {...} block.
    const start = clean.indexOf("{");
    const end = clean.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try { return JSON.parse(clean.slice(start, end + 1)); } catch { /* fall through */ }
    }
    throw new Error("Claude returned something we couldn't read. Try again — if it keeps happening, fewer tracks at a time helps.");
  }
}

async function claudeAnalyze(tracks, apiKey) {
  const sample = tracks.slice(0, 150);
  const list = sample.map((t) => `${t.id}||"${t.name.replace(/"/g, "'")}"|${t.artists.map((a) => a.name).join(" & ")}`).join("\n");

  const text = await callClaude({
    max_tokens: 8000,
    messages: [{
      role: "user",
      content: `You are an expert DJ and music analyst. Analyze these ${sample.length} tracks and organize them into DJ crates.

FORMAT: ID||"Title"|Artist
${list}

Return ONLY valid JSON (no markdown, no backticks):
{
  "tracks": [{"id":"...","bpm":95,"key":"8A","vibe":"hiphop","energy":7}],
  "crates": {"hiphop":["id1"],"rnb":["id2"],"afrobeats":[],"pop":[],"classics":[]}
}

Rules:
- vibe: hiphop | rnb | afrobeats | pop | classics only
- BPM: hiphop 85–105, rnb 65–90, afrobeats 95–115, pop 110–135, classics 80–110
- key: Camelot notation e.g. "8A" "3B" "10B"
- energy: 1–10
- Order each crate for smooth DJ flow (similar BPM progression, compatible keys)
- Every track ID must appear in exactly one crate`,
    }],
  }, apiKey);

  return parseClaudeJSON(text);
}

async function claudeSuggest(vibeLabel, songs, apiKey, count = 10) {
  const songList = songs.slice(0, 15).map((s) => `"${s.name}" by ${s.artists.map((a) => a.name).join(" & ")}`).join("\n");

  const text = await callClaude({
    max_tokens: 2000,
    messages: [{
      role: "user",
      content: `You are a DJ specializing in ${vibeLabel}. Suggest ${count} songs to add to this crate.

Current songs:
${songList || "(crate is empty — suggest staples for this vibe)"}

Include 2024–2025 trending hits AND classic staples. For hip hop and R&B, include current chart-toppers.

Return ONLY valid JSON (no markdown):
{"suggestions":[{"title":"Song Name","artist":"Artist","bpm":95,"key":"8A","trending":true,"year":2024,"reason":"Flows smoothly from previous track"}]}`,
    }],
  }, apiKey);

  return parseClaudeJSON(text).suggestions || [];
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmtMs = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
};
const fmtS = (s) => `${Math.floor(s / 60)}:${(Math.round(s) % 60).toString().padStart(2, "0")}`;

function getCues(durationMs = 210000, bpm = 90) {
  const total = Math.floor(durationMs / 1000);
  const beat = 60 / bpm;
  const bars = beat * 32; // 8 bars
  return {
    cueIn: fmtS(Math.min(Math.round(bars), total * 0.25)),
    cueOut: fmtS(Math.max(total - Math.round(bars), total * 0.75)),
  };
}

function bpmDiffLabel(a, b) {
  const diff = Math.abs((a || 90) - (b || 90));
  if (diff <= 3) return { label: "seamless", color: "#22c55e" };
  if (diff <= 8) return { label: "smooth", color: "#f59e0b" };
  if (diff <= 15) return { label: "pitch shift", color: "#f97316" };
  return { label: "manual mix", color: "#ff4060" };
}

// Camelot key compatibility: same key, ±1 on the wheel (same letter), or relative major/minor.
function parseCamelot(k) {
  const m = /^(\d{1,2})([AB])$/.exec((k || "").trim().toUpperCase());
  if (!m) return null;
  return { num: parseInt(m[1], 10), letter: m[2] };
}
function keyCompat(a, b) {
  const ka = parseCamelot(a), kb = parseCamelot(b);
  if (!ka || !kb) return { label: "unknown", color: "#666", ok: null };
  if (ka.num === kb.num && ka.letter === kb.letter) return { label: "perfect match", color: "#22c55e", ok: true };
  if (ka.num === kb.num && ka.letter !== kb.letter) return { label: "energy flip", color: "#22c55e", ok: true };
  const diff = Math.min(Math.abs(ka.num - kb.num), 12 - Math.abs(ka.num - kb.num));
  if (ka.letter === kb.letter && diff === 1) return { label: "harmonic", color: "#22c55e", ok: true };
  if (ka.letter === kb.letter && diff === 2) return { label: "close", color: "#f59e0b", ok: false };
  return { label: "key clash", color: "#ff4060", ok: false };
}

// Beginner-friendly mixing tip for a transition.
function transitionTip(bpmDiff, compat) {
  const tips = [];
  if (bpmDiff <= 3) tips.push("BPMs are basically matched — try a long blend, beatmatch on the intro and let them ride together.");
  else if (bpmDiff <= 8) tips.push("Small tempo gap — nudge the tempo fader on the incoming track to line the beats up before you bring it in.");
  else if (bpmDiff <= 15) tips.push("Noticeable tempo jump — use SYNC or the tempo fader, and keep the blend short.");
  else tips.push("Big tempo gap — easiest move is a clean cut on the 1, or drop the new track on a breakdown.");

  if (compat.ok === true) tips.push("Keys are compatible, so you can let both vocals/melodies overlap.");
  else if (compat.ok === false) tips.push("Keys can clash — use the high-pass filter to thin out the outgoing track and avoid overlapping vocals.");
  return tips.join(" ");
}

const uid = () => Math.random().toString(36).slice(2, 9);

// ── Styles ────────────────────────────────────────────────────────────────────
const css = `
  @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;600;700;900&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #06060f; }
  ::-webkit-scrollbar { width: 4px; }
  ::-webkit-scrollbar-track { background: #0a0a18; }
  ::-webkit-scrollbar-thumb { background: #2a2a4a; border-radius: 2px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.4; } }
  @keyframes bar { 0%,100% { width:0% } 50% { width:80% } }
  .track-row:hover { background: #14142a !important; }
  .crate-card:hover { transform: translateY(-2px); box-shadow: 0 8px 32px rgba(0,0,0,0.4); }
  .pl-card:hover { transform: translateY(-1px); }
  .btn-hover:hover { opacity: 0.85; }
  .track-row.dragging { opacity: 0.4; }
  .track-row.drag-over { box-shadow: inset 0 2px 0 0 #b06ef3; }
  input[type=range] { accent-color: #b06ef3; }
`;

const F = {
  app: { minHeight: "100vh", background: "#06060f", color: "#dce0f5", fontFamily: "'IBM Plex Mono', monospace" },
  header: { padding: "18px 28px", borderBottom: "1px solid #14142a", display: "flex", alignItems: "center", gap: 14, background: "#08081a" },
  logo: { fontSize: 20, fontWeight: 900, letterSpacing: 4, color: "#fff", fontFamily: "'Barlow Condensed', sans-serif", textTransform: "uppercase" },
  sub: { fontSize: 9, color: "#444", letterSpacing: 3, marginTop: 2 },
  screen: { maxWidth: 1100, margin: "0 auto", padding: "28px 24px" },
  card: (border = "#1e1e3a") => ({ background: "#0c0c1e", border: `1px solid ${border}`, borderRadius: 12, padding: 24 }),
  btn: (bg = "#a855f7", sm = false) => ({
    background: bg, color: "#fff", border: "none", borderRadius: 7,
    padding: sm ? "6px 12px" : "10px 20px", fontSize: sm ? 10 : 12,
    fontWeight: 600, cursor: "pointer", fontFamily: "'IBM Plex Mono', monospace",
    letterSpacing: 1, transition: "opacity 0.15s",
  }),
  ghost: (color = "#a855f7", sm = false) => ({
    background: "transparent", color, border: `1px solid ${color}55`,
    borderRadius: 7, padding: sm ? "5px 11px" : "9px 18px",
    fontSize: sm ? 10 : 12, fontWeight: 600, cursor: "pointer",
    fontFamily: "'IBM Plex Mono', monospace", letterSpacing: 1, transition: "all 0.15s",
  }),
  input: {
    background: "#0a0a18", border: "1px solid #1e1e3a", borderRadius: 8,
    color: "#dce0f5", padding: "12px 16px", fontSize: 12, width: "100%",
    fontFamily: "'IBM Plex Mono', monospace", outline: "none",
  },
  tag: (color) => ({
    display: "inline-flex", alignItems: "center",
    background: `${color}18`, color, border: `1px solid ${color}40`,
    borderRadius: 4, padding: "2px 7px", fontSize: 9, fontWeight: 600, letterSpacing: 1,
  }),
  err: { background: "#1e0810", border: "1px solid #ff406066", borderRadius: 8, padding: "12px 16px", fontSize: 11, color: "#ff8090", marginBottom: 20, display: "flex", alignItems: "center", gap: 10, justifyContent: "space-between" },
  ok: { background: "#08160c", border: "1px solid #22c55e66", borderRadius: 8, padding: "12px 16px", fontSize: 11, color: "#7ee29a", marginBottom: 20 },
};

const crateName = (cr) => cr.name || cr.vibe.label;

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [screen, setScreen] = useState("setup");
  const [token, setToken] = useState(() => localStorage.getItem("sp_token") || "");
  const [clientId, setClientId] = useState(() => localStorage.getItem("sp_client_id") || "");
  const [anthropicKey, setAnthropicKey] = useState(() => localStorage.getItem("anthropic_key") || "");
  const [user, setUser] = useState(null);
  const [playlists, setPlaylists] = useState([]);
  const [selected, setSelected] = useState([]);
  const [crates, setCrates] = useState(() => { try { return JSON.parse(localStorage.getItem("dj_crates") || "[]"); } catch { return []; } });
  const [activeId, setActiveId] = useState(null);
  const [progress, setProgress] = useState("");
  const [loadingId, setLoadingId] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // detail-view UI state
  const [detailView, setDetailView] = useState("list"); // "list" | "mix"
  const [bpmFilter, setBpmFilter] = useState(null);      // null | { min, max }
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [tagDraft, setTagDraft] = useState("");
  const [dragId, setDragId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);

  const activeCrate = crates.find((c) => c.id === activeId) || null;

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    if (code) {
      window.history.replaceState({}, document.title, window.location.pathname);
      handleOAuthCallback(code);
    } else if (token) {
      initSession(token);
    }
  }, []);

  function reportError(e) {
    const msg = e?.message || String(e);
    if (msg === "TOKEN_EXPIRED") {
      localStorage.removeItem("sp_token");
      setToken("");
      setUser(null);
      setError("Your Spotify session expired. Reconnect Spotify to keep going — your crates are saved.");
      setScreen("setup");
    } else {
      setError(msg);
    }
  }

  async function handleOAuthCallback(code) {
    const verifier = sessionStorage.getItem("pkce_verifier");
    const cid = localStorage.getItem("sp_client_id");
    if (!verifier || !cid) { setScreen("setup"); return; }
    try {
      const r = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code", code,
          redirect_uri: window.location.origin + window.location.pathname,
          client_id: cid, code_verifier: verifier,
        }),
      });
      const d = await r.json();
      if (d.access_token) {
        localStorage.setItem("sp_token", d.access_token);
        setToken(d.access_token);
        await initSession(d.access_token);
      } else {
        setError("Spotify auth failed: " + (d.error_description || JSON.stringify(d)));
        setScreen("setup");
      }
    } catch (e) {
      reportError(e);
      setScreen("setup");
    }
  }

  async function initSession(t) {
    try {
      const u = await spGet("/me", t);
      setUser(u);
      const pls = await fetchAllPlaylists(t);
      setPlaylists(pls);
      const saved = JSON.parse(localStorage.getItem("dj_crates") || "[]");
      setScreen(saved.length ? "crates" : "playlists");
    } catch (e) {
      reportError(e);
    }
  }

  async function connectSpotify() {
    if (!clientId.trim()) { setError("Enter your Spotify Client ID"); return; }
    if (!anthropicKey.trim()) { setError("Enter your Anthropic API Key"); return; }
    if (!anthropicKey.trim().startsWith("sk-ant-")) { setError("That Anthropic key doesn't look right — it should start with sk-ant-"); return; }
    localStorage.setItem("sp_client_id", clientId.trim());
    localStorage.setItem("anthropic_key", anthropicKey.trim());
    setError("");
    const { verifier, challenge } = await pkceChallenge();
    sessionStorage.setItem("pkce_verifier", verifier);
    const p = new URLSearchParams({
      client_id: clientId.trim(), response_type: "code",
      redirect_uri: window.location.origin + window.location.pathname,
      scope: "playlist-read-private playlist-read-collaborative playlist-modify-public playlist-modify-private",
      code_challenge_method: "S256", code_challenge: challenge,
    });
    window.location.href = `https://accounts.spotify.com/authorize?${p}`;
  }

  function persist(updated) {
    localStorage.setItem("dj_crates", JSON.stringify(updated));
  }

  async function buildCrates() {
    if (!selected.length) { setError("Select at least one playlist"); return; }
    setScreen("building"); setError(""); setNotice("");
    try {
      let all = [], seen = new Set();
      for (let i = 0; i < selected.length; i++) {
        const pl = selected[i];
        setProgress(`📥  Loading playlist ${i + 1}/${selected.length} — "${pl.name}"…`);
        const tracks = await fetchPlaylistTracks(pl.id, token);
        tracks.forEach((t) => { if (!seen.has(t.id)) { seen.add(t.id); all.push(t); } });
        setProgress(`📥  Loaded "${pl.name}" — ${all.length} unique tracks so far…`);
      }
      if (!all.length) { setError("Those playlists had no playable tracks."); setScreen("playlists"); return; }
      setProgress(`🤖  Claude is analyzing ${Math.min(all.length, 150)} tracks (BPM, key, vibe)…`);
      const analysis = await claudeAnalyze(all, anthropicKey);

      const trackMap = {}; all.forEach((t) => { trackMap[t.id] = t; });
      const infoMap = {}; (analysis.tracks || []).forEach((t) => { infoMap[t.id] = t; });

      const newCrates = VIBES.map((vibe) => {
        const ids = analysis.crates?.[vibe.id] || [];
        const songs = ids.filter((id) => trackMap[id]).map((id) => ({
          ...trackMap[id],
          bpm: infoMap[id]?.bpm || VIBE_BPM_DEFAULT[vibe.id],
          key: infoMap[id]?.key || "8A",
          energy: infoMap[id]?.energy || 7,
          suggested: false,
        }));
        return { id: vibe.id, vibe, songs, name: vibe.label, tags: [], notes: "", createdAt: Date.now() };
      });

      setCrates(newCrates);
      persist(newCrates);
      setScreen("crates");
    } catch (e) {
      reportError(e);
      if ((e?.message || "") !== "TOKEN_EXPIRED") setScreen("playlists");
    } finally {
      setProgress("");
    }
  }

  function updateCrate(id, fn) {
    setCrates((prev) => {
      const updated = prev.map((c) => (c.id === id ? fn(c) : c));
      persist(updated);
      return updated;
    });
  }

  function deleteCrate(id) {
    setCrates((prev) => {
      const updated = prev.filter((c) => c.id !== id);
      persist(updated);
      return updated;
    });
    if (activeId === id) { setActiveId(null); setScreen("crates"); }
  }

  function duplicateCrate(crate) {
    const copy = {
      ...crate,
      id: `${crate.vibe.id}_${uid()}`,
      name: `${crateName(crate)} V2`,
      songs: crate.songs.map((s) => ({ ...s })),
      createdAt: Date.now(),
    };
    setCrates((prev) => {
      const idx = prev.findIndex((c) => c.id === crate.id);
      const updated = [...prev];
      updated.splice(idx + 1, 0, copy);
      persist(updated);
      return updated;
    });
    setNotice(`Created variation "${copy.name}"`);
  }

  async function addMore(crateId, e) {
    e?.stopPropagation();
    setLoadingId(crateId); setError(""); setNotice("");
    try {
      const crate = crates.find((c) => c.id === crateId);
      setProgress("🤖  Asking Claude for fresh suggestions…");
      const suggestions = await claudeSuggest(crate.vibe.label, crate.songs, anthropicKey);

      // Try to resolve each suggestion to a real Spotify track so it can be saved.
      let matched = 0;
      const newSongs = [];
      for (let i = 0; i < suggestions.length; i++) {
        const s = suggestions[i];
        setProgress(`🔎  Finding "${s.title}" on Spotify (${i + 1}/${suggestions.length})…`);
        let sp = null;
        try {
          sp = await searchSpotifyTrack(s.title, s.artist, token);
        } catch (err) {
          if (err.message === "TOKEN_EXPIRED") throw err;
          sp = null; // a single failed search shouldn't kill the batch
        }
        if (sp) matched++;
        newSongs.push({
          id: sp?.id || `sug_${crateId}_${Date.now()}_${i}`,
          name: s.title,
          artists: [{ name: s.artist }],
          duration_ms: sp?.duration_ms || 210000,
          album: sp?.album || null,
          bpm: s.bpm, key: s.key, energy: 7,
          trending: s.trending, year: s.year, reason: s.reason,
          suggested: true,
          uri: sp?.uri || null,
          onSpotify: !!sp,
        });
      }
      updateCrate(crateId, (c) => ({ ...c, songs: [...c.songs, ...newSongs] }));
      setNotice(`Added ${newSongs.length} suggestions — ${matched} found on Spotify and ready to save${matched < newSongs.length ? `, ${newSongs.length - matched} couldn't be matched.` : "."}`);
    } catch (e) {
      reportError(e);
    } finally {
      setProgress("");
      setLoadingId(null);
    }
  }

  function reshuffle(crateId, e) {
    e?.stopPropagation();
    setLoadingId(crateId);
    updateCrate(crateId, (c) => ({
      ...c,
      songs: [...c.songs].sort((a, b) => (a.bpm || 90) - (b.bpm || 90)),
    }));
    setTimeout(() => setLoadingId(null), 500);
  }

  function removeSong(crateId, songId, e) {
    e?.stopPropagation();
    updateCrate(crateId, (c) => ({ ...c, songs: c.songs.filter((s) => s.id !== songId) }));
  }

  function moveSong(crateId, fromId, toId) {
    if (!fromId || !toId || fromId === toId) return;
    updateCrate(crateId, (c) => {
      const arr = [...c.songs];
      const from = arr.findIndex((s) => s.id === fromId);
      const to = arr.findIndex((s) => s.id === toId);
      if (from < 0 || to < 0) return c;
      const [moved] = arr.splice(from, 1);
      arr.splice(to, 0, moved);
      return { ...c, songs: arr };
    });
  }

  async function saveCrate(crate, e) {
    e?.stopPropagation();
    setError(""); setNotice("");
    try {
      const uris = crate.songs.filter((s) => s.uri).map((s) => s.uri);
      if (!uris.length) { setError("Nothing to save yet — none of these tracks have a Spotify match."); return; }
      const skipped = crate.songs.length - uris.length;
      const name = `${crate.vibe.emoji} ${crateName(crate)} — Tae Tempo`;
      await saveSpotifyPlaylist(user.id, name, uris, token);
      setNotice(`✅ Saved "${name}" to Spotify with ${uris.length} tracks${skipped ? ` (${skipped} suggested track${skipped > 1 ? "s" : ""} couldn't be matched and were skipped).` : "."}`);
    } catch (e) {
      reportError(e);
    }
  }

  function openCrate(crate) {
    setActiveId(crate.id);
    setDetailView("list");
    setBpmFilter(null);
    setEditingName(false);
    setError(""); setNotice("");
    setScreen("detail");
  }

  function addTag(crateId) {
    const t = tagDraft.trim();
    if (!t) return;
    updateCrate(crateId, (c) => c.tags.includes(t) ? c : ({ ...c, tags: [...c.tags, t] }));
    setTagDraft("");
  }

  function disconnect() {
    localStorage.removeItem("sp_token");
    localStorage.removeItem("dj_crates");
    localStorage.removeItem("anthropic_key");
    setToken(""); setUser(null); setPlaylists([]); setCrates([]); setActiveId(null); setAnthropicKey("");
    setScreen("setup");
  }

  // ── Reusable bits ───────────────────────────────────────────────────────────
  const Header = ({ back }) => (
    <div style={F.header}>
      {back && (
        <button className="btn-hover" onClick={back} style={{ ...F.ghost("#444", true), marginRight: 4 }}>
          ← BACK
        </button>
      )}
      <div>
        <div style={F.logo}>🎧 Crate Builder</div>
        <div style={F.sub}>TAE TEMPO · MNTE · Movement Navigates The Evolution</div>
      </div>
      {user && (
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
          {user.images?.[0]?.url && <img src={user.images[0].url} style={{ width: 28, height: 28, borderRadius: "50%", objectFit: "cover" }} />}
          <span style={{ fontSize: 11, color: "#555" }}>{user.display_name}</span>
          <button className="btn-hover" onClick={disconnect} style={F.ghost("#444", true)}>Disconnect</button>
        </div>
      )}
    </div>
  );

  const Alerts = () => (
    <>
      {error && (
        <div style={F.err}>
          <span>⚠ {error}</span>
          <button onClick={() => setError("")} style={{ ...F.ghost("#ff8090", true), padding: "2px 8px" }}>✕</button>
        </div>
      )}
      {notice && (
        <div style={F.ok}>
          <span>{notice}</span>
        </div>
      )}
    </>
  );

  // ── SETUP ─────────────────────────────────────────────────────────────────
  if (screen === "setup") return (
    <div style={F.app}>
      <style>{css}</style>
      <Header />
      <div style={{ ...F.screen, maxWidth: 620 }}>
        <div style={{ marginBottom: 40, paddingTop: 12 }}>
          <h1 style={{ fontFamily: "'Barlow Condensed',sans-serif", fontSize: 48, fontWeight: 900, lineHeight: 1, marginBottom: 10, color: "#fff" }}>
            Build Your DJ<br />
            <span style={{ background: "linear-gradient(135deg,#ff4060,#b06ef3,#06b6d4)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
              Crates.
            </span>
          </h1>
          <p style={{ color: "#555", fontSize: 11, letterSpacing: 1, lineHeight: 1.8 }}>
            Connect Spotify → Select playlists → AI organizes your music into vibe-based crates with BPM, key, and cue points.
          </p>
        </div>

        <Alerts />

        <div style={{ ...F.card(), marginBottom: 16 }}>
          <div style={{ fontSize: 10, color: "#b06ef3", letterSpacing: 2, fontWeight: 600, marginBottom: 12 }}>
            STEP 1 — SPOTIFY DEVELOPER SETUP
          </div>
          <ol style={{ fontSize: 11, color: "#666", lineHeight: 2.2, paddingLeft: 18 }}>
            <li>Go to <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noreferrer" style={{ color: "#06b6d4" }}>developer.spotify.com/dashboard</a></li>
            <li>Create an app (any name)</li>
            <li>Add this exact Redirect URI:<br />
              <code style={{ color: "#f59e0b", fontSize: 10, wordBreak: "break-all", background: "#0a0a18", padding: "2px 6px", borderRadius: 4 }}>
                {window.location.origin + window.location.pathname}
              </code>
            </li>
            <li>Copy your Client ID below</li>
          </ol>
        </div>

        <div style={{ ...F.card(), marginBottom: 16 }}>
          <div style={{ fontSize: 10, color: "#b06ef3", letterSpacing: 2, fontWeight: 600, marginBottom: 12 }}>
            STEP 2 — ANTHROPIC API KEY
          </div>
          <div style={{ fontSize: 11, color: "#666", lineHeight: 1.8, marginBottom: 12 }}>
            Get a key at <a href="https://console.anthropic.com" target="_blank" rel="noreferrer" style={{ color: "#06b6d4" }}>console.anthropic.com</a> → API Keys → Create Key
          </div>
          <input
            style={F.input}
            placeholder="sk-ant-..."
            type="password"
            value={anthropicKey}
            onChange={(e) => setAnthropicKey(e.target.value)}
          />
        </div>

        <div style={{ ...F.card(), marginBottom: 16 }}>
          <div style={{ fontSize: 10, color: "#b06ef3", letterSpacing: 2, fontWeight: 600, marginBottom: 12 }}>
            STEP 3 — ENTER SPOTIFY CLIENT ID
          </div>
          <input
            style={F.input}
            placeholder="Paste your Spotify Client ID here…"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && connectSpotify()}
          />
        </div>

        <button className="btn-hover" onClick={connectSpotify}
          style={{ ...F.btn("#22c55e"), width: "100%", padding: "14px", fontSize: 13, letterSpacing: 2 }}>
          CONNECT SPOTIFY →
        </button>

        <div style={{ marginTop: 36 }}>
          <div style={{ fontSize: 9, color: "#333", letterSpacing: 2, marginBottom: 14 }}>WHAT YOU'LL BUILD</div>
          <div style={{ display: "grid", gap: 6 }}>
            {VIBES.map((v) => (
              <div key={v.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", background: "#0a0a18", borderRadius: 8, border: `1px solid ${v.color}22` }}>
                <span style={{ fontSize: 16 }}>{v.emoji}</span>
                <span style={{ fontSize: 11, fontWeight: 600, color: v.color, fontFamily: "'Barlow Condensed',sans-serif", letterSpacing: 1 }}>{v.label}</span>
                <span style={{ fontSize: 9, color: "#333", marginLeft: "auto" }}>{v.bpmRange[0]}–{v.bpmRange[1]} BPM</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );

  // ── BUILDING ──────────────────────────────────────────────────────────────
  if (screen === "building") return (
    <div style={F.app}>
      <style>{css}</style>
      <Header />
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "70vh", gap: 20 }}>
        <div style={{ fontSize: 52, animation: "spin 3s linear infinite" }}>🎧</div>
        <div style={{ fontFamily: "'Barlow Condensed',sans-serif", fontSize: 32, fontWeight: 900, color: "#fff", letterSpacing: 2 }}>
          Building Crates…
        </div>
        <div style={{ fontSize: 11, color: "#8a8ab0", letterSpacing: 1, minHeight: 20, textAlign: "center", maxWidth: 420, padding: "0 16px" }}>{progress}</div>
        <div style={{ width: 280, height: 3, background: "#14142a", borderRadius: 2, overflow: "hidden" }}>
          <div style={{ height: "100%", background: "linear-gradient(90deg,#ff4060,#b06ef3,#06b6d4)", animation: "bar 1.8s ease-in-out infinite", borderRadius: 2, transformOrigin: "left" }} />
        </div>
      </div>
    </div>
  );

  // ── PLAYLISTS ─────────────────────────────────────────────────────────────
  if (screen === "playlists") return (
    <div style={F.app}>
      <style>{css}</style>
      <Header back={crates.length ? () => setScreen("crates") : null} />
      <div style={F.screen}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 28, flexWrap: "wrap", gap: 12 }}>
          <div>
            <h2 style={{ fontFamily: "'Barlow Condensed',sans-serif", fontSize: 32, fontWeight: 900, color: "#fff" }}>Select Playlists</h2>
            <div style={{ fontSize: 10, color: "#555", marginTop: 4 }}>{selected.length} selected · {playlists.length} playlists found</div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn-hover" onClick={() => setSelected(playlists)} style={F.ghost("#b06ef3", true)}>SELECT ALL</button>
            <button className="btn-hover" onClick={() => setSelected([])} style={F.ghost("#444", true)}>CLEAR</button>
            <button className="btn-hover" onClick={buildCrates} style={{ ...F.btn("#22c55e"), opacity: selected.length ? 1 : 0.4 }}>
              BUILD CRATES →
            </button>
          </div>
        </div>

        <Alerts />

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: 10 }}>
          {playlists.map((pl) => {
            const isSel = selected.some((s) => s.id === pl.id);
            return (
              <div key={pl.id} className="pl-card" onClick={() => setSelected((s) => isSel ? s.filter((p) => p.id !== pl.id) : [...s, pl])}
                style={{ background: isSel ? "#1a0a30" : "#0c0c1e", border: `1px solid ${isSel ? "#b06ef3" : "#1e1e3a"}`, borderRadius: 10, padding: 14, cursor: "pointer", transition: "all 0.15s", position: "relative" }}>
                {isSel && <div style={{ position: "absolute", top: 10, right: 12, color: "#b06ef3", fontSize: 14, fontWeight: 700 }}>✓</div>}
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  {pl.images?.[0]?.url
                    ? <img src={pl.images[0].url} style={{ width: 44, height: 44, borderRadius: 6, objectFit: "cover", flexShrink: 0 }} />
                    : <div style={{ width: 44, height: 44, background: "#14142a", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>🎵</div>}
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: isSel ? "#dce0f5" : "#aaa", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingRight: 18 }}>{pl.name}</div>
                    <div style={{ fontSize: 10, color: "#444", marginTop: 2 }}>{pl.tracks.total} tracks</div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );

  // ── CRATE DETAIL ──────────────────────────────────────────────────────────
  if (screen === "detail" && activeCrate) {
    const cr = activeCrate;
    const v = cr.vibe;
    const sugCount = cr.songs.filter((s) => s.suggested).length;
    const trendCount = cr.songs.filter((s) => s.trending).length;
    const saveable = cr.songs.filter((s) => s.uri).length;

    const bpms = cr.songs.map((s) => s.bpm || VIBE_BPM_DEFAULT[v.id]);
    const minBpm = bpms.length ? Math.min(...bpms) : v.bpmRange[0];
    const maxBpm = bpms.length ? Math.max(...bpms) : v.bpmRange[1];
    const filter = bpmFilter || { min: minBpm, max: maxBpm };
    const visible = cr.songs.filter((s) => {
      const b = s.bpm || VIBE_BPM_DEFAULT[v.id];
      return b >= filter.min && b <= filter.max;
    });
    const filterActive = bpmFilter && (filter.min > minBpm || filter.max < maxBpm);

    return (
      <div style={F.app}>
        <style>{css}</style>
        <Header back={() => setScreen("crates")} />
        <div style={F.screen}>
          {/* Crate Header */}
          <div style={{ padding: "20px 24px", background: `linear-gradient(135deg, ${v.color}0d, #0c0c1e)`, borderRadius: 14, border: `1px solid ${v.color}33`, marginBottom: 24 }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
              <span style={{ fontSize: 44 }}>{v.emoji}</span>
              <div style={{ flex: 1, minWidth: 200 }}>
                {editingName ? (
                  <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                    <input autoFocus style={{ ...F.input, fontSize: 20, padding: "6px 10px", maxWidth: 360 }}
                      value={nameDraft} onChange={(e) => setNameDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { updateCrate(cr.id, (c) => ({ ...c, name: nameDraft.trim() || c.vibe.label })); setEditingName(false); } if (e.key === "Escape") setEditingName(false); }} />
                    <button className="btn-hover" onClick={() => { updateCrate(cr.id, (c) => ({ ...c, name: nameDraft.trim() || c.vibe.label })); setEditingName(false); }} style={F.btn("#22c55e", true)}>Save</button>
                  </div>
                ) : (
                  <h1 onClick={() => { setNameDraft(crateName(cr)); setEditingName(true); }}
                    title="Click to rename"
                    style={{ fontFamily: "'Barlow Condensed',sans-serif", fontSize: 34, fontWeight: 900, color: v.color, letterSpacing: 1, cursor: "pointer" }}>
                    {crateName(cr)} <span style={{ fontSize: 13, color: "#444" }}>✎</span>
                  </h1>
                )}
                <div style={{ fontSize: 10, color: "#555", marginTop: 4, marginBottom: 12 }}>
                  {cr.vibe.label} · {cr.songs.length} tracks · BPM zone {v.bpmRange[0]}–{v.bpmRange[1]} · {saveable} ready to save
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                  {cr.tags.map((t) => (
                    <span key={t} style={{ ...F.tag(v.color), gap: 5 }}>
                      {t}
                      <span onClick={() => updateCrate(cr.id, (c) => ({ ...c, tags: c.tags.filter((x) => x !== t) }))} style={{ cursor: "pointer", opacity: 0.6 }}>✕</span>
                    </span>
                  ))}
                  {sugCount > 0 && <span style={F.tag(v.color)}>✨ {sugCount} AI suggested</span>}
                  {trendCount > 0 && <span style={F.tag("#f59e0b")}>🔥 {trendCount} trending</span>}
                  <input
                    style={{ ...F.input, width: 130, padding: "4px 8px", fontSize: 10 }}
                    placeholder="+ add tag"
                    value={tagDraft}
                    onChange={(e) => setTagDraft(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && addTag(cr.id)}
                  />
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                <button className="btn-hover" onClick={(e) => addMore(cr.id, e)} disabled={loadingId === cr.id} style={F.ghost(v.color)}>
                  {loadingId === cr.id ? "⏳ Loading…" : "+ Need More Songs"}
                </button>
                <button className="btn-hover" onClick={(e) => reshuffle(cr.id, e)} disabled={loadingId === cr.id} style={F.ghost("#f59e0b")}>
                  🔀 Reshuffle
                </button>
                <button className="btn-hover" onClick={() => duplicateCrate(cr)} style={F.ghost("#06b6d4")}>
                  ⧉ Variation
                </button>
                <button className="btn-hover" onClick={(e) => saveCrate(cr, e)} style={F.btn("#22c55e")}>
                  💾 Save to Spotify
                </button>
              </div>
            </div>

            {/* Crate notes */}
            <textarea
              value={cr.notes || ""}
              onChange={(e) => updateCrate(cr.id, (c) => ({ ...c, notes: e.target.value }))}
              placeholder="📝 Crate notes — e.g. 'play this second set', 'good for 1am', 'warm-up only'…"
              style={{ ...F.input, marginTop: 16, minHeight: 44, resize: "vertical", fontSize: 11, color: "#bbb" }}
            />
          </div>

          <Alerts />
          {progress && loadingId === cr.id && (
            <div style={{ fontSize: 10, color: "#8a8ab0", marginBottom: 14, animation: "pulse 1.5s infinite" }}>{progress}</div>
          )}

          {/* View toggle + BPM filter */}
          <div style={{ display: "flex", gap: 16, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
            <div style={{ display: "flex", gap: 4, background: "#0a0a18", borderRadius: 8, padding: 4 }}>
              <button onClick={() => setDetailView("list")} style={{ ...F.btn(detailView === "list" ? v.color : "transparent", true), color: detailView === "list" ? "#fff" : "#666" }}>📋 Track List</button>
              <button onClick={() => setDetailView("mix")} style={{ ...F.btn(detailView === "mix" ? v.color : "transparent", true), color: detailView === "mix" ? "#fff" : "#666" }}>🎚 Preview Mix</button>
            </div>

            {cr.songs.length > 1 && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 240, background: "#0a0a18", borderRadius: 8, padding: "8px 14px", border: "1px solid #1e1e3a" }}>
                <span style={{ fontSize: 9, color: "#666", letterSpacing: 1 }}>BPM FILTER</span>
                <input type="range" min={minBpm} max={maxBpm} value={filter.min}
                  onChange={(e) => setBpmFilter({ min: Math.min(+e.target.value, filter.max), max: filter.max })}
                  style={{ flex: 1 }} />
                <input type="range" min={minBpm} max={maxBpm} value={filter.max}
                  onChange={(e) => setBpmFilter({ min: filter.min, max: Math.max(+e.target.value, filter.min) })}
                  style={{ flex: 1 }} />
                <span style={{ fontSize: 11, color: v.color, fontFamily: "'Barlow Condensed',sans-serif", fontWeight: 700, minWidth: 64, textAlign: "right" }}>{filter.min}–{filter.max}</span>
                {filterActive && <button onClick={() => setBpmFilter(null)} style={F.ghost("#444", true)}>reset</button>}
              </div>
            )}
          </div>

          {filterActive && (
            <div style={{ fontSize: 10, color: "#666", marginBottom: 10 }}>
              Showing {visible.length} of {cr.songs.length} tracks · drag-to-reorder disabled while filtering
            </div>
          )}

          {/* ── PREVIEW MIX VIEW ── */}
          {detailView === "mix" ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {visible.length < 2 && (
                <div style={{ textAlign: "center", padding: 50, color: "#444", fontSize: 12 }}>
                  Need at least 2 tracks to preview transitions.
                </div>
              )}
              {visible.slice(0, -1).map((song, i) => {
                const next = visible[i + 1];
                const diff = Math.abs((song.bpm || 90) - (next.bpm || 90));
                const dl = bpmDiffLabel(song.bpm, next.bpm);
                const compat = keyCompat(song.key, next.key);
                const curCues = getCues(song.duration_ms, song.bpm);
                const nextCues = getCues(next.duration_ms, next.bpm);
                return (
                  <div key={song.id + "_mix_" + i} style={{ ...F.card(`${v.color}22`), padding: 18 }}>
                    <div style={{ fontSize: 9, color: "#555", letterSpacing: 2, marginBottom: 14 }}>TRANSITION {i + 1} → {i + 2}</div>
                    <div style={{ display: "flex", gap: 16, alignItems: "stretch", flexWrap: "wrap" }}>
                      {/* Outgoing */}
                      <div style={{ flex: 1, minWidth: 200 }}>
                        <div style={{ fontSize: 9, color: "#ff4060", letterSpacing: 1, marginBottom: 4 }}>MIX OUT ▸</div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "#dce0f5", marginBottom: 2 }}>{song.name}</div>
                        <div style={{ fontSize: 10, color: "#555", marginBottom: 8 }}>{song.artists.map((a) => a.name).join(", ")}</div>
                        <div style={{ display: "flex", gap: 14, fontSize: 11 }}>
                          <span style={{ color: v.color }}>{song.bpm} BPM</span>
                          <span style={{ color: "#b06ef3" }}>{song.key}</span>
                          <span style={{ color: "#ff4060" }}>out @ {curCues.cueOut}</span>
                        </div>
                      </div>

                      {/* Center meta */}
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, minWidth: 120 }}>
                        <span style={{ ...F.tag(dl.color) }}>{dl.label}</span>
                        <span style={{ fontSize: 10, color: "#666" }}>{diff} BPM diff</span>
                        <span style={{ ...F.tag(compat.color) }}>{compat.label}</span>
                      </div>

                      {/* Incoming */}
                      <div style={{ flex: 1, minWidth: 200, textAlign: "right" }}>
                        <div style={{ fontSize: 9, color: "#22c55e", letterSpacing: 1, marginBottom: 4 }}>▸ MIX IN</div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "#dce0f5", marginBottom: 2 }}>{next.name}</div>
                        <div style={{ fontSize: 10, color: "#555", marginBottom: 8 }}>{next.artists.map((a) => a.name).join(", ")}</div>
                        <div style={{ display: "flex", gap: 14, fontSize: 11, justifyContent: "flex-end" }}>
                          <span style={{ color: "#22c55e" }}>in @ {nextCues.cueIn}</span>
                          <span style={{ color: "#b06ef3" }}>{next.key}</span>
                          <span style={{ color: v.color }}>{next.bpm} BPM</span>
                        </div>
                      </div>
                    </div>
                    <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid #14142a", fontSize: 11, color: "#9a9ac0", lineHeight: 1.6 }}>
                      💡 <strong style={{ color: "#cfcff0" }}>Beginner tip:</strong> {transitionTip(diff, compat)}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <>
              {/* Column Headers */}
              <div style={{ display: "flex", gap: 12, padding: "0 16px 8px", borderBottom: "1px solid #14142a", marginBottom: 6 }}>
                <div style={{ width: 28, fontSize: 9, color: "#333" }}>#</div>
                <div style={{ flex: 1, fontSize: 9, color: "#333", letterSpacing: 1 }}>TRACK</div>
                <div style={{ width: 52, textAlign: "center", fontSize: 9, color: "#333", letterSpacing: 1 }}>BPM</div>
                <div style={{ width: 44, textAlign: "center", fontSize: 9, color: "#333", letterSpacing: 1 }}>KEY</div>
                <div style={{ width: 52, textAlign: "center", fontSize: 9, color: "#333", letterSpacing: 1 }}>CUE IN</div>
                <div style={{ width: 52, textAlign: "center", fontSize: 9, color: "#333", letterSpacing: 1 }}>CUE OUT</div>
                <div style={{ width: 44, textAlign: "center", fontSize: 9, color: "#333", letterSpacing: 1 }}>DUR</div>
                <div style={{ width: 20 }} />
              </div>

              {/* Track List */}
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                {visible.map((song, i) => {
                  const cues = getCues(song.duration_ms || 210000, song.bpm || VIBE_BPM_DEFAULT[v.id]);
                  const next = visible[i + 1];
                  const diff = next ? bpmDiffLabel(song.bpm, next.bpm) : null;
                  const draggable = !filterActive;
                  return (
                    <div key={song.id + i}>
                      <div
                        className={"track-row" + (dragId === song.id ? " dragging" : "") + (dragOverId === song.id ? " drag-over" : "")}
                        draggable={draggable}
                        onDragStart={() => setDragId(song.id)}
                        onDragOver={(e) => { if (draggable) { e.preventDefault(); setDragOverId(song.id); } }}
                        onDragLeave={() => setDragOverId((id) => id === song.id ? null : id)}
                        onDrop={(e) => { e.preventDefault(); moveSong(cr.id, dragId, song.id); setDragId(null); setDragOverId(null); }}
                        onDragEnd={() => { setDragId(null); setDragOverId(null); }}
                        style={{
                          display: "flex", alignItems: "center", gap: 12, padding: "11px 16px",
                          background: song.suggested ? `${v.color}0a` : "#0c0c1e",
                          borderRadius: 8, border: song.suggested ? `1px solid ${v.color}25` : "1px solid transparent",
                          transition: "background 0.15s", cursor: draggable ? "grab" : "default",
                        }}>
                        <div style={{ width: 28, fontSize: 10, color: "#333", fontWeight: 700, flexShrink: 0, display: "flex", alignItems: "center", gap: 4 }}>
                          {draggable && <span style={{ color: "#2a2a4a", cursor: "grab" }}>⠿</span>}{i + 1}
                        </div>

                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 2, flexWrap: "wrap" }}>
                            <span style={{ fontSize: 12, fontWeight: 600, color: song.suggested ? v.color : "#dce0f5", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" }}>
                              {song.name}
                            </span>
                            {song.suggested && <span style={{ ...F.tag(v.color), fontSize: 8, flexShrink: 0 }}>✨ AI</span>}
                            {song.trending && <span style={{ ...F.tag("#f59e0b"), fontSize: 8, flexShrink: 0 }}>🔥 TRENDING</span>}
                            {song.suggested && (song.onSpotify
                              ? <span style={{ ...F.tag("#22c55e"), fontSize: 8, flexShrink: 0 }}>✓ ON SPOTIFY</span>
                              : <span style={{ ...F.tag("#666"), fontSize: 8, flexShrink: 0 }}>⌀ NO MATCH</span>)}
                          </div>
                          <div style={{ fontSize: 10, color: "#555" }}>{song.artists.map((a) => a.name).join(", ")}</div>
                          {song.reason && <div style={{ fontSize: 9, color: "#444", marginTop: 3, fontStyle: "italic" }}>💡 {song.reason}</div>}
                        </div>

                        <div style={{ width: 52, textAlign: "center", flexShrink: 0 }}>
                          <div style={{ fontSize: 15, fontWeight: 700, color: v.color, fontFamily: "'Barlow Condensed',sans-serif" }}>{song.bpm}</div>
                          <div style={{ fontSize: 8, color: "#333" }}>BPM</div>
                        </div>
                        <div style={{ width: 44, textAlign: "center", flexShrink: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: "#b06ef3" }}>{song.key}</div>
                          <div style={{ fontSize: 8, color: "#333" }}>KEY</div>
                        </div>
                        <div style={{ width: 52, textAlign: "center", flexShrink: 0 }}>
                          <div style={{ fontSize: 11, color: "#22c55e", fontWeight: 600 }}>{cues.cueIn}</div>
                          <div style={{ fontSize: 8, color: "#333" }}>IN</div>
                        </div>
                        <div style={{ width: 52, textAlign: "center", flexShrink: 0 }}>
                          <div style={{ fontSize: 11, color: "#ff4060", fontWeight: 600 }}>{cues.cueOut}</div>
                          <div style={{ fontSize: 8, color: "#333" }}>OUT</div>
                        </div>
                        <div style={{ width: 44, textAlign: "center", flexShrink: 0 }}>
                          <div style={{ fontSize: 10, color: "#444" }}>{fmtMs(song.duration_ms || 210000)}</div>
                        </div>
                        <button title="Remove track" onClick={(e) => removeSong(cr.id, song.id, e)}
                          style={{ width: 20, flexShrink: 0, background: "transparent", border: "none", color: "#444", cursor: "pointer", fontSize: 12 }}
                          className="btn-hover">✕</button>
                      </div>

                      {diff && (
                        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 44px", opacity: 0.7 }}>
                          <div style={{ flex: 1, height: 1, background: "#14142a" }} />
                          <span style={{ fontSize: 9, color: diff.color, letterSpacing: 1 }}>
                            ↓ {diff.label} · {Math.abs((next?.bpm || 90) - (song.bpm || 90))} BPM diff
                          </span>
                          <div style={{ flex: 1, height: 1, background: "#14142a" }} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {cr.songs.length === 0 && (
            <div style={{ textAlign: "center", padding: 60, color: "#444" }}>
              <div style={{ fontSize: 36, marginBottom: 14 }}>📭</div>
              <div style={{ fontSize: 12, marginBottom: 16 }}>No tracks yet — add some songs!</div>
              <button className="btn-hover" onClick={(e) => addMore(cr.id, e)} style={F.btn(v.color)}>
                + Add Songs via AI
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── CRATES OVERVIEW ───────────────────────────────────────────────────────
  return (
    <div style={F.app}>
      <style>{css}</style>
      <Header />
      <div style={F.screen}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28, flexWrap: "wrap", gap: 12 }}>
          <div>
            <h2 style={{ fontFamily: "'Barlow Condensed',sans-serif", fontSize: 36, fontWeight: 900, color: "#fff" }}>Your Crates</h2>
            <div style={{ fontSize: 10, color: "#444", marginTop: 4 }}>
              {crates.reduce((a, c) => a + c.songs.length, 0)} tracks organized across {crates.length} crates
            </div>
          </div>
          <button className="btn-hover" onClick={() => setScreen("playlists")} style={F.ghost("#b06ef3")}>
            ↺ REBUILD CRATES
          </button>
        </div>

        <Alerts />

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(300px,1fr))", gap: 14 }}>
          {crates.map((cr) => {
            const v = cr.vibe;
            const sugCount = cr.songs.filter((s) => s.suggested).length;
            const trendCount = cr.songs.filter((s) => s.trending).length;
            const bpmRange = cr.songs.length ? `${Math.min(...cr.songs.map((s) => s.bpm || 90))}–${Math.max(...cr.songs.map((s) => s.bpm || 90))} BPM` : `${v.bpmRange[0]}–${v.bpmRange[1]} BPM`;

            return (
              <div key={cr.id} className="crate-card" onClick={() => openCrate(cr)}
                style={{ ...F.card(`${v.color}33`), cursor: "pointer", transition: "all 0.2s", position: "relative", overflow: "hidden" }}>
                <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: v.color }} />
                <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginBottom: 16 }}>
                  <span style={{ fontSize: 36, lineHeight: 1 }}>{v.emoji}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: "'Barlow Condensed',sans-serif", fontSize: 20, fontWeight: 900, color: v.color, letterSpacing: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{crateName(cr)}</div>
                    <div style={{ fontSize: 10, color: "#444", marginTop: 2 }}>{bpmRange}</div>
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <div style={{ fontFamily: "'Barlow Condensed',sans-serif", fontSize: 32, fontWeight: 900, color: "#fff", lineHeight: 1 }}>{cr.songs.length}</div>
                    <div style={{ fontSize: 9, color: "#444" }}>tracks</div>
                  </div>
                </div>

                <div style={{ marginBottom: 12, borderTop: "1px solid #14142a", paddingTop: 12 }}>
                  {cr.songs.slice(0, 4).map((s, i) => (
                    <div key={s.id + i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", borderBottom: "1px solid #0e0e1e" }}>
                      <span style={{ fontSize: 10, color: "#777", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                        {s.suggested && "✨ "}{s.name}
                      </span>
                      <span style={{ fontSize: 10, color: v.color, marginLeft: 8, flexShrink: 0, fontFamily: "'Barlow Condensed',sans-serif", fontWeight: 700 }}>{s.bpm}</span>
                    </div>
                  ))}
                  {cr.songs.length > 4 && <div style={{ fontSize: 9, color: "#333", marginTop: 6 }}>+{cr.songs.length - 4} more tracks…</div>}
                  {cr.songs.length === 0 && <div style={{ fontSize: 10, color: "#333", padding: "4px 0" }}>Empty — open to add songs</div>}
                </div>

                <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 12 }}>
                  {cr.tags.slice(0, 3).map((t) => <span key={t} style={F.tag("#06b6d4")}>{t}</span>)}
                  {sugCount > 0 && <span style={F.tag(v.color)}>✨ {sugCount} suggested</span>}
                  {trendCount > 0 && <span style={F.tag("#f59e0b")}>🔥 {trendCount} trending</span>}
                </div>

                <div style={{ display: "flex", gap: 6 }} onClick={(e) => e.stopPropagation()}>
                  <button className="btn-hover" onClick={(e) => addMore(cr.id, e)} disabled={loadingId === cr.id}
                    style={{ ...F.btn(v.color, true), flex: 1, fontSize: 10 }}>
                    {loadingId === cr.id ? "…" : "+ Songs"}
                  </button>
                  <button className="btn-hover" onClick={(e) => reshuffle(cr.id, e)} disabled={loadingId === cr.id} style={F.ghost("#f59e0b", true)}>🔀</button>
                  <button className="btn-hover" onClick={(e) => saveCrate(cr, e)} style={F.ghost("#22c55e", true)}>💾</button>
                  <button className="btn-hover" title="Delete this crate"
                    onClick={(e) => { e.stopPropagation(); if (window.confirm(`Delete "${crateName(cr)}"? This can't be undone.`)) deleteCrate(cr.id); }}
                    style={F.ghost("#ff4060", true)}>🗑</button>
                </div>
              </div>
            );
          })}
        </div>

        {crates.length === 0 && (
          <div style={{ textAlign: "center", padding: 80, color: "#444" }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>🎧</div>
            <div style={{ fontSize: 14, marginBottom: 20, color: "#666" }}>No crates built yet</div>
            <button className="btn-hover" onClick={() => setScreen("playlists")} style={F.btn("#b06ef3")}>
              Select Playlists →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
