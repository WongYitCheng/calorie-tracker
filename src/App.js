import { useState, useEffect, useRef, useCallback } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";

// ─── Constants ───────────────────────────────────────────────────────────────
const STORAGE_KEY = "calorie_tracker_v1";
const API_KEY_STORAGE = "gemini_api_key";
const TARGETS_STORAGE_KEY = "calorie_targets_v1";
const LEARNED_UNITS_KEY = "learned_units_v1";
const DEFAULT_TARGETS = { calories: 2716, carbs: 232.5, protein: 148.8, fat: 83.7 };

// ─── Helpers ─────────────────────────────────────────────────────────────────
const todayStr = () => new Date().toISOString().slice(0, 10);

// entries are stored keyed by date with no cap, so history already persists
// indefinitely (a year of daily entries is well under localStorage's ~5MB limit)
function loadData() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
  catch { return {}; }
}
function saveData(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}
function loadTargets() {
  try {
    const t = JSON.parse(localStorage.getItem(TARGETS_STORAGE_KEY));
    return t ? { ...DEFAULT_TARGETS, ...t } : { ...DEFAULT_TARGETS };
  } catch { return { ...DEFAULT_TARGETS }; }
}
function saveTargets(t) {
  localStorage.setItem(TARGETS_STORAGE_KEY, JSON.stringify(t));
}
// generic day-range generator so Trends can show a week, a month, or a full year
function getLastNDays(n) {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() - (n - 1 - i));
    return d.toISOString().slice(0, 10);
  });
}
function formatDate(str) {
  const d = new Date(str + "T00:00:00");
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// ─── Learned unit weights (per-user portion memory) ───────────────────────────
// When a user corrects how many pieces/units a food actually was, we remember
// the resulting per-unit nutrition for that food name, so next time the same
// food is detected the AI starts from the user's real-world portions instead
// of a generic guess.
function loadLearnedUnits() {
  try { return JSON.parse(localStorage.getItem(LEARNED_UNITS_KEY)) || {}; }
  catch { return {}; }
}
function saveLearnedUnits(u) {
  localStorage.setItem(LEARNED_UNITS_KEY, JSON.stringify(u));
}
// Rolling average over the last N corrections so it adapts but isn't thrown
// off by one outlier entry.
function recordUnitCorrection(name, unitName, perUnit) {
  const learned = loadLearnedUnits();
  const prev = learned[name];
  const MAX_SAMPLES = 8;
  const samples = prev ? Math.min(prev.samples + 1, MAX_SAMPLES) : 1;
  const w = prev ? 1 / samples : 1;
  const blended = prev
    ? {
        calories: prev.calories * (1 - w) + perUnit.calories * w,
        protein: prev.protein * (1 - w) + perUnit.protein * w,
        fat: prev.fat * (1 - w) + perUnit.fat * w,
        carbs: prev.carbs * (1 - w) + perUnit.carbs * w,
      }
    : perUnit;
  learned[name] = { unitName, samples, ...blended };
  saveLearnedUnits(learned);
}
// Builds a short hint injected into the AI prompt so past corrections inform
// future estimates. Kept short (a handful of entries) to avoid bloating the prompt.
function buildLearnedHint(learned) {
  const names = Object.keys(learned).slice(-5);
  if (names.length === 0) return "";
  const lines = names.map(n => {
    const u = learned[n];
    return `- ${n}：约 ${Math.round(u.calories)} kcal/${u.unitName}（用户历史修正，${u.samples}次）`;
  });
  return `\n\n用户历史份量修正参考（如果识别到同名或相似食物，请优先参考这些真实份量数据）：\n${lines.join("\n")}`;
}

// Safety net: if the AI doesn't return usable unit_count/unit_name (missing,
// zero, or non-numeric), pull a leading number + counting word straight out
// of its own portion text (e.g. "3块" → count 3, unit "块"). Falls back to a
// single generic "份" so every food always gets an editable count.
function parsePortionFallback(portion) {
  if (portion) {
    const m = String(portion).match(/^(\d+(?:\.\d+)?)\s*([\u4e00-\u9fa5]{1,2})/);
    if (m) {
      const count = parseFloat(m[1]);
      if (count > 0) return { count, unitName: m[2] };
    }
  }
  return { count: 1, unitName: "份" };
}
// Normalizes a raw AI result so it always has a usable unit_count/unit_name,
// regardless of whether the model complied with the schema this turn.
function normalizeResult(r) {
  const fallback = parsePortionFallback(r.portion);
  const unit_count = (typeof r.unit_count === "number" && r.unit_count > 0) ? r.unit_count : fallback.count;
  const unit_name = (r.unit_name && String(r.unit_name).trim()) ? r.unit_name : fallback.unitName;
  return { ...r, unit_count, unit_name };
}

// ─── Gemini API ───────────────────────────────────────────────────────────────
async function analyzeFood(imageBase64, mimeType, apiKey, learnedUnits = {}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const prompt = `Analyze this food image and respond ONLY with a JSON object (no markdown, no explanation):
{
  "name": "food name in Chinese",
  "calories": number,
  "protein": number,
  "fat": number,
  "carbs": number,
  "portion": "estimated portion size, described in natural units where possible (e.g. '3块' not just weight)",
  "confidence": "high/medium/low",
  "unit_name": "the natural counting word for this food's portion, in Chinese — a piece/serving word like '块','个','只','片','碗','杯','份'. Always provide one, even for foods without discrete pieces (use '份' or '碗' for things like soup, rice, salad)",
  "unit_count": "number of that unit you estimate are in the image (e.g. 3 for '3块', 1 for a single bowl of soup). Always a positive number, never null"
}
All nutritional values should be in grams (protein/fat/carbs) or kcal (calories) for the TOTAL portion shown, not per unit.${buildLearnedHint(learnedUnits)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: mimeType, data: imageBase64 } }
        ]
      }]
    })
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error?.message || "API 请求失败");
  }
  const data = await res.json();
  const text = data.candidates[0].content.parts[0].text.trim();
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// Text-based entry: user types a food name/description (optionally with amount)
// and Gemini estimates nutrition the same way it would from a photo.
async function analyzeFoodText(description, apiKey, learnedUnits = {}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const prompt = `Based on this food description (which may include a name, amount, and preparation method), estimate its nutrition. Respond ONLY with a JSON object (no markdown, no explanation):
{
  "name": "food name in Chinese",
  "calories": number,
  "protein": number,
  "fat": number,
  "carbs": number,
  "portion": "the amount as stated, or your best estimate if not given, described in natural units where possible (e.g. '3块' not just weight)",
  "confidence": "high/medium/low",
  "unit_name": "the natural counting word for this food's portion, in Chinese — a piece/serving word like '块','个','只','片','碗','杯','份'. Always provide one, even for foods without discrete pieces (use '份' or '碗' for things like soup, rice, salad)",
  "unit_count": "number of that unit implied or stated in the description (e.g. 3 for '3块', 1 for a single bowl). Always a positive number, never null"
}
All nutritional values should be in grams (protein/fat/carbs) or kcal (calories) for the TOTAL amount described, not per unit.${buildLearnedHint(learnedUnits)}
Food description: "${description}"`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error?.message || "API 请求失败");
  }
  const data = await res.json();
  const text = data.candidates[0].content.parts[0].text.trim();
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// ─── Icons ────────────────────────────────────────────────────────────────────
const IconCamera = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="24" height="24">
    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
    <circle cx="12" cy="13" r="4"/>
  </svg>
);
const IconUpload = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="24" height="24">
    <polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/>
    <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/>
  </svg>
);
// eslint-disable-next-line no-unused-vars
const IconFlame = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
    <path d="M12 2C9.5 5 8 7.5 8 10c0 2.2 1.8 4 4 4s4-1.8 4-4c0-.7-.2-1.4-.5-2C14.5 9.5 14 11 12 11c0 0 2-4 0-9z"/>
    <path d="M12 2c0 0-6 5-6 10a6 6 0 0 0 12 0C18 7 12 2 12 2z" opacity=".4"/>
  </svg>
);
const IconTrend = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="20" height="20">
    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
  </svg>
);
const IconList = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="20" height="20">
    <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
    <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
  </svg>
);
const IconHome = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="20" height="20">
    <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
    <polyline points="9 22 9 12 15 12 15 22"/>
  </svg>
);
const IconPlus = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" width="28" height="28">
    <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
  </svg>
);
const IconTrash = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
    <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
    <path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
  </svg>
);
const IconKey = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="20" height="20">
    <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
  </svg>
);
const IconSettings = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="20" height="20">
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
  </svg>
);
const IconEdit = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="20" height="20">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
  </svg>
);

// ─── API Key Setup Screen ─────────────────────────────────────────────────────
function ApiKeySetup({ onSave }) {
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [testing, setTesting] = useState(false);

  async function handleSave() {
    if (!key.trim()) { setError("请输入 API Key"); return; }
    setTesting(true); setError("");
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key.trim()}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: "reply: ok" }] }] })
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error?.message); }
      localStorage.setItem(API_KEY_STORAGE, key.trim());
      onSave(key.trim());
    } catch (e) {
      setError("API Key 无效：" + e.message);
    }
    setTesting(false);
  }

  return (
    <div style={{ minHeight: "100vh", background: "#0a0a0f", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "24px", fontFamily: "'DM Sans', sans-serif" }}>
      <div style={{ width: "100%", maxWidth: "400px" }}>
        <div style={{ textAlign: "center", marginBottom: "40px" }}>
          <div style={{ fontSize: "48px", marginBottom: "12px" }}>🔥</div>
          <h1 style={{ color: "#fff", fontSize: "28px", fontWeight: "700", margin: "0 0 8px" }}>CalorieSnap</h1>
          <p style={{ color: "#666", fontSize: "15px", margin: 0 }}>拍照识别食物，追踪每日卡路里</p>
        </div>

        <div style={{ background: "#16161f", borderRadius: "20px", padding: "28px", border: "1px solid #2a2a3a" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "20px" }}>
            <IconKey />
            <h2 style={{ color: "#fff", fontSize: "17px", fontWeight: "600", margin: 0 }}>设置 Gemini API Key</h2>
          </div>
          <p style={{ color: "#888", fontSize: "13px", lineHeight: "1.6", marginBottom: "20px" }}>
            前往 <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" style={{ color: "#f97316" }}>Google AI Studio</a> 免费获取 API Key，每天可免费识别 1500 次。
          </p>
          <input
            type="password"
            placeholder="AIza..."
            value={key}
            onChange={e => setKey(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleSave()}
            style={{ width: "100%", background: "#0a0a0f", border: "1px solid #2a2a3a", borderRadius: "12px", padding: "14px 16px", color: "#fff", fontSize: "15px", outline: "none", boxSizing: "border-box", marginBottom: "12px" }}
          />
          {error && <p style={{ color: "#ef4444", fontSize: "13px", marginBottom: "12px" }}>{error}</p>}
          <button onClick={handleSave} disabled={testing} style={{ width: "100%", background: "linear-gradient(135deg, #f97316, #ef4444)", border: "none", borderRadius: "12px", padding: "14px", color: "#fff", fontSize: "16px", fontWeight: "600", cursor: testing ? "not-allowed" : "pointer", opacity: testing ? 0.7 : 1 }}>
            {testing ? "验证中..." : "开始使用 →"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Settings Page (daily targets) ────────────────────────────────────────────
function SettingsPage({ targets, onSave, onBack }) {
  const [form, setForm] = useState({ ...targets });

  function update(key, val) {
    setForm(f => ({ ...f, [key]: val }));
  }
  function save() {
    const cleaned = {
      calories: Number(form.calories) || 0,
      carbs: Number(form.carbs) || 0,
      protein: Number(form.protein) || 0,
      fat: Number(form.fat) || 0,
    };
    saveTargets(cleaned);
    onSave(cleaned);
    onBack();
  }

  const fields = [
    { key: "calories", label: "每日热量目标", unit: "kcal" },
    { key: "carbs", label: "碳水目标", unit: "g" },
    { key: "protein", label: "蛋白质目标", unit: "g" },
    { key: "fat", label: "脂肪目标", unit: "g" },
  ];

  return (
    <div style={{ padding: "24px 20px 100px", maxWidth: "430px", margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "24px" }}>
        <button onClick={onBack} style={{ background: "none", border: "none", color: "#888", cursor: "pointer", fontSize: "20px", padding: 0, lineHeight: 1 }}>←</button>
        <h1 style={{ color: "#fff", fontSize: "22px", fontWeight: "700", margin: 0 }}>每日目标设置</h1>
      </div>
      <div style={{ background: "#16161f", borderRadius: "20px", padding: "20px", border: "1px solid #2a2a3a", display: "flex", flexDirection: "column", gap: "16px" }}>
        {fields.map(f => (
          <div key={f.key}>
            <label style={{ color: "#888", fontSize: "13px", display: "block", marginBottom: "6px" }}>{f.label}</label>
            <div style={{ display: "flex", alignItems: "center", background: "#0a0a0f", border: "1px solid #2a2a3a", borderRadius: "12px", padding: "10px 14px" }}>
              <input
                type="number"
                value={form[f.key]}
                onChange={e => update(f.key, e.target.value)}
                style={{ flex: 1, background: "transparent", border: "none", color: "#fff", fontSize: "16px", outline: "none" }}
              />
              <span style={{ color: "#555", fontSize: "13px" }}>{f.unit}</span>
            </div>
          </div>
        ))}
      </div>
      <button onClick={save} style={{ width: "100%", marginTop: "20px", background: "linear-gradient(135deg, #f97316, #ef4444)", border: "none", borderRadius: "14px", padding: "14px", color: "#fff", fontSize: "16px", fontWeight: "600", cursor: "pointer" }}>
        保存
      </button>
    </div>
  );
}

// ─── Home Page ────────────────────────────────────────────────────────────────
function HomePage({ data, targets, onNavigate, onOpenSettings }) {
  const today = todayStr();
  const todayEntries = data[today] || [];
  const totalCal = todayEntries.reduce((s, e) => s + e.calories, 0);
  const totalProtein = todayEntries.reduce((s, e) => s + (e.protein || 0), 0);
  const totalFat = todayEntries.reduce((s, e) => s + (e.fat || 0), 0);
  const totalCarbs = todayEntries.reduce((s, e) => s + (e.carbs || 0), 0);
  const gap = targets.calories - totalCal;
  const pct = Math.min((totalCal / targets.calories) * 100, 100);
  const over = totalCal > targets.calories;

  return (
    <div style={{ padding: "24px 20px 100px", maxWidth: "430px", margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "28px" }}>
        <div>
          <p style={{ color: "#666", fontSize: "13px", margin: "0 0 4px" }}>{new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" })}</p>
          <h1 style={{ color: "#fff", fontSize: "26px", fontWeight: "700", margin: 0 }}>今日摄入</h1>
        </div>
        <button onClick={onOpenSettings} style={{ background: "#16161f", border: "1px solid #2a2a3a", borderRadius: "12px", width: "38px", height: "38px", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "#888", marginTop: "4px" }}>
          <IconSettings />
        </button>
      </div>

      {/* Main Calorie Card */}
      <div style={{ background: over ? "linear-gradient(135deg, #3a0a0a, #1f0a0a)" : "linear-gradient(135deg, #0f1a2a, #0a1520)", borderRadius: "24px", padding: "28px", marginBottom: "16px", border: `1px solid ${over ? "#7f1d1d" : "#1a3a5c"}`, position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", top: "-20px", right: "-20px", width: "120px", height: "120px", background: over ? "rgba(239,68,68,0.1)" : "rgba(249,115,22,0.1)", borderRadius: "50%", filter: "blur(30px)" }} />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={{ display: "flex", alignItems: "baseline", gap: "6px" }}>
              <span style={{ color: over ? "#ef4444" : "#f97316", fontSize: "52px", fontWeight: "800", lineHeight: 1 }}>{totalCal.toLocaleString()}</span>
              <span style={{ color: "#888", fontSize: "16px" }}>kcal</span>
            </div>
            <p style={{ color: "#666", fontSize: "13px", margin: "6px 0 0" }}>目标 {targets.calories.toLocaleString()} kcal</p>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ color: over ? "#ef4444" : "#34d399", fontSize: "22px", fontWeight: "700" }}>
              {over ? "+" : ""}{Math.abs(gap).toLocaleString()}
            </div>
            <div style={{ color: "#666", fontSize: "12px" }}>{over ? "超出" : "剩余"}</div>
          </div>
        </div>

        {/* Progress Bar */}
        <div style={{ marginTop: "20px", background: "rgba(255,255,255,0.08)", borderRadius: "99px", height: "8px", overflow: "hidden" }}>
          <div style={{ width: `${pct}%`, height: "100%", background: over ? "linear-gradient(90deg, #ef4444, #dc2626)" : "linear-gradient(90deg, #f97316, #fb923c)", borderRadius: "99px", transition: "width 0.6s ease" }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: "6px" }}>
          <span style={{ color: "#555", fontSize: "11px" }}>0</span>
          <span style={{ color: "#555", fontSize: "11px" }}>{pct.toFixed(0)}%</span>
          <span style={{ color: "#555", fontSize: "11px" }}>{targets.calories.toLocaleString()}</span>
        </div>

        {over && (
          <div style={{ marginTop: "16px", background: "rgba(239,68,68,0.15)", borderRadius: "10px", padding: "10px 14px", display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ fontSize: "16px" }}>⚠️</span>
            <span style={{ color: "#fca5a5", fontSize: "13px" }}>已超出今日热量目标！</span>
          </div>
        )}
      </div>

      {/* Macros vs. target */}
      <div style={{ background: "#16161f", borderRadius: "20px", padding: "18px 18px 14px", border: "1px solid #2a2a3a", marginBottom: "20px", display: "flex", flexDirection: "column", gap: "14px" }}>
        {[
          { label: "蛋白质", value: totalProtein, target: targets.protein, color: "#60a5fa" },
          { label: "脂肪", value: totalFat, target: targets.fat, color: "#f59e0b" },
          { label: "碳水", value: totalCarbs, target: targets.carbs, color: "#a78bfa" },
        ].map(m => {
          const mPct = Math.min((m.value / (m.target || 1)) * 100, 100);
          const mOver = m.value > m.target;
          return (
            <div key={m.label}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "6px" }}>
                <span style={{ color: "#999", fontSize: "13px" }}>{m.label}</span>
                <span style={{ fontSize: "13px" }}>
                  <span style={{ color: mOver ? "#ef4444" : "#e5e5e5", fontWeight: "600" }}>{m.value.toFixed(0)}</span>
                  <span style={{ color: "#555" }}> / {m.target.toFixed(0)}g</span>
                </span>
              </div>
              <div style={{ background: "rgba(255,255,255,0.08)", borderRadius: "99px", height: "6px", overflow: "hidden" }}>
                <div style={{ width: `${mPct}%`, height: "100%", background: mOver ? "#ef4444" : m.color, borderRadius: "99px", transition: "width 0.6s ease" }} />
              </div>
            </div>
          );
        })}
      </div>

      {/* Recent entries */}
      {todayEntries.length > 0 && (
        <div style={{ background: "#16161f", borderRadius: "20px", padding: "20px", border: "1px solid #2a2a3a" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
            <h3 style={{ color: "#fff", fontSize: "15px", fontWeight: "600", margin: 0 }}>今日饮食</h3>
            <button onClick={() => onNavigate("records")} style={{ color: "#f97316", fontSize: "13px", background: "none", border: "none", cursor: "pointer", padding: 0 }}>查看全部</button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {todayEntries.slice(-3).reverse().map((e, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ color: "#e5e5e5", fontSize: "14px", fontWeight: "500" }}>{e.name}</div>
                  <div style={{ color: "#555", fontSize: "12px" }}>{e.time} · {e.portion}</div>
                </div>
                <div style={{ color: "#f97316", fontSize: "15px", fontWeight: "600" }}>{e.calories} kcal</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {todayEntries.length === 0 && (
        <div style={{ textAlign: "center", padding: "40px 20px", color: "#444" }}>
          <div style={{ fontSize: "48px", marginBottom: "12px" }}>🍽️</div>
          <p style={{ fontSize: "15px", margin: 0 }}>今天还没有记录，点击 + 拍照添加</p>
        </div>
      )}
    </div>
  );
}

// ─── Scan Page ────────────────────────────────────────────────────────────────
function ScanPage({ apiKey, onAdd }) {
  const [phase, setPhase] = useState("select"); // select | preview | textInput | analyzing | result
  const [imgSrc, setImgSrc] = useState(null);
  const [mimeType, setMimeType] = useState("image/jpeg");
  const [base64, setBase64] = useState(null);
  const [result, setResult] = useState(null);       // raw AI estimate (base portion, count = its own estimate)
  const [unitCount, setUnitCount] = useState(1);      // user-corrected piece/serving count
  const [sizeFactor, setSizeFactor] = useState(1);    // "each unit was smaller/bigger than assumed"
  const [form, setForm] = useState(null);            // editable, user-facing values
  const [textDesc, setTextDesc] = useState("");       // for word/text-based entry
  const [error, setError] = useState("");
  const fileRef = useRef();
  // eslint-disable-next-line no-unused-vars
  const cameraRef = useRef();
  const videoRef = useRef();
  const streamRef = useRef();
  const [cameraActive, setCameraActive] = useState(false);

  const stopCamera = useCallback(() => {
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
    setCameraActive(false);
  }, []);

  async function startCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setCameraActive(true);
    } catch {
      setError("无法访问摄像头，请检查权限");
    }
  }

  function capturePhoto() {
    const video = videoRef.current;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    const b64 = dataUrl.split(",")[1];
    setImgSrc(dataUrl); setBase64(b64); setMimeType("image/jpeg");
    stopCamera(); setPhase("preview");
  }

  function handleFileChange(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const dataUrl = ev.target.result;
      setImgSrc(dataUrl);
      setBase64(dataUrl.split(",")[1]);
      setMimeType(file.type || "image/jpeg");
      setPhase("preview");
    };
    reader.readAsDataURL(file);
  }

  async function analyze() {
    setPhase("analyzing"); setError("");
    try {
      const raw = await analyzeFood(base64, mimeType, apiKey, loadLearnedUnits());
      const r = normalizeResult(raw);
      setResult(r);
      setForm({ ...r });
      setUnitCount(r.unit_count);
      setSizeFactor(1);
      setPhase("result");
    } catch (e) {
      setError("识别失败：" + e.message); setPhase("preview");
    }
  }

  // Per-unit nutrition, derived from the AI's original total ÷ its original
  // estimated count. This stays fixed as the anchor; count/size corrections
  // just multiply against it, so the user never has to think in grams.
  function getPerUnit() {
    const baseCount = (result.unit_count && result.unit_count > 0) ? result.unit_count : 1;
    return {
      calories: result.calories / baseCount,
      protein: result.protein / baseCount,
      fat: result.fat / baseCount,
      carbs: result.carbs / baseCount,
    };
  }

  // Called when the user corrects "how many pieces" (descriptive, not gram-based).
  function applyUnitCount(n) {
    if (!result) return;
    const count = Math.max(1, n);
    setUnitCount(count);
    const perUnit = getPerUnit();
    setForm(f => ({
      ...f,
      calories: Math.round(perUnit.calories * count * sizeFactor),
      protein: Math.round(perUnit.protein * count * sizeFactor * 10) / 10,
      fat: Math.round(perUnit.fat * count * sizeFactor * 10) / 10,
      carbs: Math.round(perUnit.carbs * count * sizeFactor * 10) / 10,
      portion: `${count}${result.unit_name || "份"}`,
    }));
  }

  // Called when the user says each piece looked smaller/about right/bigger
  // than the AI assumed — a second, independent axis from count.
  function applySizeFactor(sf) {
    if (!result) return;
    setSizeFactor(sf);
    const perUnit = getPerUnit();
    setForm(f => ({
      ...f,
      calories: Math.round(perUnit.calories * unitCount * sf),
      protein: Math.round(perUnit.protein * unitCount * sf * 10) / 10,
      fat: Math.round(perUnit.fat * unitCount * sf * 10) / 10,
      carbs: Math.round(perUnit.carbs * unitCount * sf * 10) / 10,
    }));
  }

  function updateField(key, value) {
    setForm(f => ({ ...f, [key]: value }));
  }

  function confirmAdd() {
    const entry = {
      ...form,
      calories: Math.round(Number(form.calories) || 0),
      protein: Number(form.protein) || 0,
      fat: Number(form.fat) || 0,
      carbs: Number(form.carbs) || 0,
      time: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
      id: Date.now()
    };
    onAdd(entry);

    // If the user corrected the piece count or size, remember the resulting
    // per-unit nutrition so future estimates for this food start from the
    // user's real portions instead of guessing again.
    if (result && (unitCount !== result.unit_count || sizeFactor !== 1)) {
      const perUnit = {
        calories: (entry.calories / unitCount),
        protein: (entry.protein / unitCount),
        fat: (entry.fat / unitCount),
        carbs: (entry.carbs / unitCount),
      };
      recordUnitCorrection(form.name, result.unit_name || "份", perUnit);
    }

    reset();
  }

  function reset() {
    setPhase("select"); setImgSrc(null); setBase64(null); setResult(null); setForm(null);
    setUnitCount(1); setSizeFactor(1); setError(""); setTextDesc(""); stopCamera();
  }

  async function analyzeText() {
    if (!textDesc.trim()) return;
    setPhase("analyzing"); setError("");
    try {
      const raw = await analyzeFoodText(textDesc.trim(), apiKey, loadLearnedUnits());
      const r = normalizeResult(raw);
      setResult(r);
      setForm({ ...r });
      setUnitCount(r.unit_count);
      setSizeFactor(1);
      setImgSrc(null);
      setPhase("result");
    } catch (e) {
      setError("识别失败：" + e.message); setPhase("textInput");
    }
  }

  useEffect(() => () => stopCamera(), [stopCamera]);

  return (
    <div style={{ padding: "24px 20px 100px", maxWidth: "430px", margin: "0 auto" }}>
      <h1 style={{ color: "#fff", fontSize: "24px", fontWeight: "700", marginBottom: "24px" }}>识别食物</h1>

      {phase === "select" && (
        <>
          {/* Camera */}
          {cameraActive ? (
            <div style={{ borderRadius: "20px", overflow: "hidden", marginBottom: "16px", position: "relative" }}>
              <video ref={videoRef} autoPlay playsInline style={{ width: "100%", display: "block", borderRadius: "20px" }} />
              <div style={{ position: "absolute", bottom: "16px", left: 0, right: 0, display: "flex", justifyContent: "center", gap: "16px" }}>
                <button onClick={stopCamera} style={{ background: "rgba(0,0,0,0.6)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: "50px", padding: "10px 20px", color: "#fff", cursor: "pointer", fontSize: "14px" }}>取消</button>
                <button onClick={capturePhoto} style={{ background: "#fff", border: "4px solid rgba(255,255,255,0.5)", borderRadius: "50%", width: "64px", height: "64px", cursor: "pointer" }} />
              </div>
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "20px" }}>
              <button onClick={startCamera} style={{ background: "linear-gradient(135deg, #f97316, #ef4444)", border: "none", borderRadius: "20px", padding: "28px 16px", color: "#fff", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: "10px" }}>
                <IconCamera /><span style={{ fontSize: "15px", fontWeight: "600" }}>拍照</span>
              </button>
              <button onClick={() => fileRef.current.click()} style={{ background: "#16161f", border: "1px solid #2a2a3a", borderRadius: "20px", padding: "28px 16px", color: "#fff", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: "10px" }}>
                <IconUpload /><span style={{ fontSize: "15px", fontWeight: "600" }}>上传图片</span>
              </button>
              <input ref={fileRef} type="file" accept="image/*" onChange={handleFileChange} style={{ display: "none" }} />
            </div>
          )}
          {!cameraActive && (
            <button onClick={() => setPhase("textInput")} style={{ width: "100%", background: "#16161f", border: "1px solid #2a2a3a", borderRadius: "16px", padding: "14px", color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", fontSize: "14px", fontWeight: "600", marginBottom: "20px" }}>
              <IconEdit /> 文字输入食物
            </button>
          )}
          {error && <p style={{ color: "#ef4444", fontSize: "14px", textAlign: "center" }}>{error}</p>}
          <div style={{ background: "#16161f", borderRadius: "16px", padding: "16px", border: "1px solid #2a2a3a" }}>
            <p style={{ color: "#666", fontSize: "13px", lineHeight: "1.6", margin: 0 }}>💡 小贴士：拍摄时让食物居中，光线充足，识别效果更佳；也可以直接用文字描述食物和份量</p>
          </div>
        </>
      )}

      {phase === "textInput" && (
        <div>
          <p style={{ color: "#666", fontSize: "13px", marginBottom: "12px", lineHeight: "1.6" }}>输入食物名称和份量，AI 将估算热量与营养成分</p>
          <textarea
            value={textDesc}
            onChange={e => setTextDesc(e.target.value)}
            placeholder="例如：鸡胸肉200克 / 一碗牛肉面 / 苹果一个"
            rows={4}
            autoFocus
            style={{ width: "100%", background: "#16161f", border: "1px solid #2a2a3a", borderRadius: "16px", padding: "14px 16px", color: "#fff", fontSize: "15px", outline: "none", boxSizing: "border-box", marginBottom: "16px", resize: "none", fontFamily: "inherit" }}
          />
          {error && <p style={{ color: "#ef4444", fontSize: "14px", marginBottom: "12px" }}>{error}</p>}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
            <button onClick={reset} style={{ background: "#16161f", border: "1px solid #2a2a3a", borderRadius: "14px", padding: "14px", color: "#fff", cursor: "pointer", fontSize: "15px" }}>取消</button>
            <button onClick={analyzeText} disabled={!textDesc.trim()} style={{ background: "linear-gradient(135deg, #f97316, #ef4444)", border: "none", borderRadius: "14px", padding: "14px", color: "#fff", cursor: textDesc.trim() ? "pointer" : "not-allowed", opacity: textDesc.trim() ? 1 : 0.5, fontSize: "15px", fontWeight: "600" }}>开始识别 🔍</button>
          </div>
        </div>
      )}

      {phase === "preview" && imgSrc && (
        <div>
          <img src={imgSrc} alt="food" style={{ width: "100%", borderRadius: "20px", marginBottom: "16px", maxHeight: "360px", objectFit: "cover" }} />
          {error && <p style={{ color: "#ef4444", fontSize: "14px", marginBottom: "12px" }}>{error}</p>}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
            <button onClick={reset} style={{ background: "#16161f", border: "1px solid #2a2a3a", borderRadius: "14px", padding: "14px", color: "#fff", cursor: "pointer", fontSize: "15px" }}>重新选择</button>
            <button onClick={analyze} style={{ background: "linear-gradient(135deg, #f97316, #ef4444)", border: "none", borderRadius: "14px", padding: "14px", color: "#fff", cursor: "pointer", fontSize: "15px", fontWeight: "600" }}>开始识别 🔍</button>
          </div>
        </div>
      )}

      {phase === "analyzing" && (
        <div style={{ textAlign: "center", padding: "60px 20px" }}>
          <div style={{ fontSize: "56px", marginBottom: "20px", animation: "spin 1.5s linear infinite", display: "inline-block" }}>🔍</div>
          <p style={{ color: "#fff", fontSize: "18px", fontWeight: "600", marginBottom: "8px" }}>AI 识别中...</p>
          <p style={{ color: "#666", fontSize: "14px" }}>正在分析食物营养成分</p>
          <style>{`@keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }`}</style>
        </div>
      )}

      {phase === "result" && result && form && (
        <div>
          {imgSrc ? (
            <img src={imgSrc} alt="food" style={{ width: "100%", borderRadius: "20px", marginBottom: "16px", maxHeight: "240px", objectFit: "cover" }} />
          ) : (
            <div style={{ width: "100%", height: "100px", borderRadius: "20px", marginBottom: "16px", background: "#16161f", border: "1px solid #2a2a3a", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "36px" }}>✏️</div>
          )}

          {/* Portion adjustment: always descriptive — count + size, never grams */}
          <div style={{ background: "#16161f", borderRadius: "16px", padding: "14px 16px", border: "1px solid #2a2a3a", marginBottom: "14px" }}>
            <div style={{ color: "#888", fontSize: "13px", marginBottom: "10px" }}>
              AI 识别份量：{result.unit_count} {result.unit_name} · 数量不对可直接改
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "14px", marginBottom: "14px" }}>
              <button
                onClick={() => applyUnitCount(unitCount - 1)}
                disabled={unitCount <= 1}
                style={{ width: "40px", height: "40px", borderRadius: "12px", border: "1px solid #2a2a3a", background: "#0a0a0f", color: unitCount <= 1 ? "#333" : "#fff", fontSize: "20px", cursor: unitCount <= 1 ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
              >−</button>
              <div style={{ display: "flex", alignItems: "baseline", gap: "6px" }}>
                <input
                  type="number"
                  value={unitCount}
                  onChange={e => applyUnitCount(Number(e.target.value) || 1)}
                  style={{ width: "56px", background: "transparent", border: "none", borderBottom: "1px solid #2a2a3a", color: "#f97316", fontSize: "24px", fontWeight: "800", textAlign: "center", outline: "none" }}
                />
                <input
                  value={result.unit_name}
                  onChange={e => setResult(r => ({ ...r, unit_name: e.target.value }))}
                  style={{ width: "44px", background: "transparent", border: "none", borderBottom: "1px solid #2a2a3a", color: "#888", fontSize: "14px", fontWeight: "500", outline: "none" }}
                />
              </div>
              <button
                onClick={() => applyUnitCount(unitCount + 1)}
                style={{ width: "40px", height: "40px", borderRadius: "12px", border: "1px solid #2a2a3a", background: "#0a0a0f", color: "#fff", fontSize: "20px", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
              >+</button>
            </div>
            <div style={{ color: "#666", fontSize: "12px", marginBottom: "8px" }}>每{result.unit_name}大小</div>
            <div style={{ display: "flex", gap: "8px" }}>
              {[{ v: 0.8, label: "偏小" }, { v: 1, label: "正常" }, { v: 1.2, label: "偏大" }].map(s => (
                <button
                  key={s.v}
                  onClick={() => applySizeFactor(s.v)}
                  style={{
                    flex: 1, padding: "8px 0", borderRadius: "10px", border: "1px solid",
                    borderColor: sizeFactor === s.v ? "#f97316" : "#2a2a3a",
                    background: sizeFactor === s.v ? "rgba(249,115,22,0.15)" : "transparent",
                    color: sizeFactor === s.v ? "#f97316" : "#666",
                    cursor: "pointer", fontSize: "13px", fontWeight: "600"
                  }}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          {/* Editable result card */}
          <div style={{ background: "#16161f", borderRadius: "20px", padding: "24px", border: "1px solid #2a2a3a", marginBottom: "14px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px", marginBottom: "20px" }}>
              <input
                value={form.name}
                onChange={e => updateField("name", e.target.value)}
                style={{ flex: 1, background: "transparent", border: "none", borderBottom: "1px solid #2a2a3a", color: "#fff", fontSize: "20px", fontWeight: "700", padding: "4px 0", outline: "none" }}
              />
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <input
                  type="number"
                  value={form.calories}
                  onChange={e => updateField("calories", e.target.value)}
                  style={{ width: "90px", background: "transparent", border: "none", borderBottom: "1px solid #2a2a3a", color: "#f97316", fontSize: "26px", fontWeight: "800", textAlign: "right", outline: "none" }}
                />
                <div style={{ color: "#666", fontSize: "12px" }}>kcal</div>
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "10px" }}>
              {[
                { key: "protein", label: "蛋白质", color: "#60a5fa" },
                { key: "fat", label: "脂肪", color: "#f59e0b" },
                { key: "carbs", label: "碳水", color: "#a78bfa" },
              ].map(m => (
                <div key={m.key} style={{ background: "#0a0a0f", borderRadius: "12px", padding: "10px", textAlign: "center" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "2px" }}>
                    <input
                      type="number"
                      value={form[m.key]}
                      onChange={e => updateField(m.key, e.target.value)}
                      style={{ width: "48px", background: "transparent", border: "none", color: m.color, fontSize: "16px", fontWeight: "700", textAlign: "right", outline: "none" }}
                    />
                    <span style={{ color: m.color, fontSize: "12px" }}>g</span>
                  </div>
                  <div style={{ color: "#555", fontSize: "11px", marginTop: "3px" }}>{m.label}</div>
                </div>
              ))}
            </div>
            <div style={{ marginTop: "14px", textAlign: "right" }}>
              <span style={{ color: "#444", fontSize: "12px" }}>置信度：{result.confidence === "high" ? "高 ✓" : result.confidence === "medium" ? "中等" : "较低"} · 可直接点击数值修改</span>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
            <button onClick={reset} style={{ background: "#16161f", border: "1px solid #2a2a3a", borderRadius: "14px", padding: "14px", color: "#fff", cursor: "pointer", fontSize: "15px" }}>重新识别</button>
            <button onClick={confirmAdd} style={{ background: "linear-gradient(135deg, #22c55e, #16a34a)", border: "none", borderRadius: "14px", padding: "14px", color: "#fff", cursor: "pointer", fontSize: "15px", fontWeight: "600" }}>✓ 添加记录</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Records Page ─────────────────────────────────────────────────────────────
function RecordsPage({ data, onDelete }) {
  const today = todayStr();
  const entries = data[today] || [];
  const total = entries.reduce((s, e) => s + e.calories, 0);

  return (
    <div style={{ padding: "24px 20px 100px", maxWidth: "430px", margin: "0 auto" }}>
      <h1 style={{ color: "#fff", fontSize: "24px", fontWeight: "700", marginBottom: "6px" }}>饮食记录</h1>
      <p style={{ color: "#666", fontSize: "13px", marginBottom: "24px" }}>今天 · 共 {total} kcal</p>

      {entries.length === 0 ? (
        <div style={{ textAlign: "center", padding: "60px 20px", color: "#444" }}>
          <div style={{ fontSize: "48px", marginBottom: "12px" }}>📋</div>
          <p style={{ fontSize: "15px" }}>今天还没有记录</p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {[...entries].reverse().map((e) => (
            <div key={e.id} style={{ background: "#16161f", borderRadius: "16px", padding: "16px 18px", border: "1px solid #2a2a3a", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ flex: 1 }}>
                <div style={{ color: "#e5e5e5", fontSize: "15px", fontWeight: "600", marginBottom: "4px" }}>{e.name}</div>
                <div style={{ color: "#555", fontSize: "12px" }}>
                  {e.time} · {e.portion}
                  {e.protein != null && <span style={{ marginLeft: "8px" }}>🥩{e.protein}g 🧈{e.fat}g 🍞{e.carbs}g</span>}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
                <span style={{ color: "#f97316", fontSize: "16px", fontWeight: "700" }}>{e.calories}</span>
                <button onClick={() => onDelete(today, e.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "#444", padding: "4px" }}>
                  <IconTrash />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Trends Page ──────────────────────────────────────────────────────────────
function TrendsPage({ data, targets }) {
  const [range, setRange] = useState(7);
  const days = getLastNDays(range);
  const chartData = days.map(d => ({
    date: formatDate(d),
    calories: (data[d] || []).reduce((s, e) => s + e.calories, 0),
    over: (data[d] || []).reduce((s, e) => s + e.calories, 0) > targets.calories
  }));
  const avg = chartData.filter(d => d.calories > 0).reduce((s, d) => s + d.calories, 0) / (chartData.filter(d => d.calories > 0).length || 1);
  // sparser x-axis ticks as the range grows, otherwise a year of bars is unreadable
  const tickInterval = range <= 7 ? 0 : range <= 30 ? 4 : range <= 90 ? 13 : 29;

  const RANGES = [
    { days: 7, label: "7天" },
    { days: 30, label: "30天" },
    { days: 90, label: "90天" },
    { days: 365, label: "全年" },
  ];

  return (
    <div style={{ padding: "24px 20px 100px", maxWidth: "430px", margin: "0 auto" }}>
      <h1 style={{ color: "#fff", fontSize: "24px", fontWeight: "700", marginBottom: "6px" }}>卡路里趋势</h1>
      <p style={{ color: "#666", fontSize: "13px", marginBottom: "20px" }}>目标 {targets.calories.toLocaleString()} kcal/天</p>

      <div style={{ display: "flex", gap: "8px", marginBottom: "24px", flexWrap: "wrap" }}>
        {RANGES.map(r => (
          <button key={r.days} onClick={() => setRange(r.days)} style={{ padding: "8px 16px", borderRadius: "99px", border: "1px solid", borderColor: range === r.days ? "#f97316" : "#2a2a3a", background: range === r.days ? "rgba(249,115,22,0.15)" : "transparent", color: range === r.days ? "#f97316" : "#666", cursor: "pointer", fontSize: "14px" }}>
            {r.label}
          </button>
        ))}
      </div>

      <div style={{ background: "#16161f", borderRadius: "20px", padding: "20px 10px 10px", border: "1px solid #2a2a3a", marginBottom: "16px" }}>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={chartData} margin={{ top: 0, right: 10, left: -20, bottom: 0 }}>
            <XAxis dataKey="date" tick={{ fill: "#555", fontSize: 11 }} axisLine={false} tickLine={false} interval={tickInterval} />
            <YAxis tick={{ fill: "#555", fontSize: 11 }} axisLine={false} tickLine={false} />
            <Tooltip contentStyle={{ background: "#1a1a2a", border: "1px solid #2a2a3a", borderRadius: "10px", color: "#fff" }} formatter={v => [`${v} kcal`, "摄入"]} />
            <Bar dataKey="calories" radius={[6, 6, 0, 0]}>
              {chartData.map((entry, i) => (
                <Cell key={i} fill={entry.calories === 0 ? "#1a1a2a" : entry.over ? "#ef4444" : "#f97316"} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
        <div style={{ display: "flex", justifyContent: "center", gap: "20px", marginTop: "10px" }}>
          <span style={{ color: "#555", fontSize: "12px", display: "flex", alignItems: "center", gap: "6px" }}><span style={{ width: "10px", height: "10px", borderRadius: "2px", background: "#f97316", display: "inline-block" }} />正常</span>
          <span style={{ color: "#555", fontSize: "12px", display: "flex", alignItems: "center", gap: "6px" }}><span style={{ width: "10px", height: "10px", borderRadius: "2px", background: "#ef4444", display: "inline-block" }} />超标</span>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
        <div style={{ background: "#16161f", borderRadius: "16px", padding: "18px", border: "1px solid #2a2a3a" }}>
          <div style={{ color: "#666", fontSize: "12px", marginBottom: "6px" }}>平均摄入</div>
          <div style={{ color: "#fff", fontSize: "22px", fontWeight: "700" }}>{Math.round(avg).toLocaleString()}</div>
          <div style={{ color: "#666", fontSize: "12px" }}>kcal/天</div>
        </div>
        <div style={{ background: "#16161f", borderRadius: "16px", padding: "18px", border: "1px solid #2a2a3a" }}>
          <div style={{ color: "#666", fontSize: "12px", marginBottom: "6px" }}>vs 目标</div>
          <div style={{ color: avg > targets.calories ? "#ef4444" : "#34d399", fontSize: "22px", fontWeight: "700" }}>
            {avg > targets.calories ? "+" : ""}{Math.round(avg - targets.calories).toLocaleString()}
          </div>
          <div style={{ color: "#666", fontSize: "12px" }}>kcal/天</div>
        </div>
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(API_KEY_STORAGE) || "");
  const [page, setPage] = useState("home");
  const [data, setData] = useState(loadData);
  const [targets, setTargets] = useState(loadTargets);

  function addEntry(entry) {
    const today = todayStr();
    setData(prev => {
      const updated = { ...prev, [today]: [...(prev[today] || []), entry] };
      saveData(updated);
      return updated;
    });
    setPage("home");
  }

  function deleteEntry(date, id) {
    setData(prev => {
      const updated = { ...prev, [date]: prev[date].filter(e => e.id !== id) };
      saveData(updated);
      return updated;
    });
  }

  if (!apiKey) return <ApiKeySetup onSave={setApiKey} />;

  const tabs = [
    { id: "home", label: "首页", Icon: IconHome },
    { id: "scan", label: "识别", Icon: null },
    { id: "records", label: "记录", Icon: IconList },
    { id: "trends", label: "趋势", Icon: IconTrend },
  ];

  return (
    <div style={{ minHeight: "100vh", background: "#0a0a0f", fontFamily: "'DM Sans', sans-serif", color: "#fff" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet" />

      {/* Page Content */}
      {page === "home" && <HomePage data={data} targets={targets} onNavigate={setPage} onOpenSettings={() => setPage("settings")} />}
      {page === "scan" && <ScanPage apiKey={apiKey} onAdd={addEntry} />}
      {page === "records" && <RecordsPage data={data} onDelete={deleteEntry} />}
      {page === "trends" && <TrendsPage data={data} targets={targets} />}
      {page === "settings" && <SettingsPage targets={targets} onSave={setTargets} onBack={() => setPage("home")} />}

      {/* Bottom Nav */}
      <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: "rgba(10,10,15,0.95)", backdropFilter: "blur(20px)", borderTop: "1px solid #1a1a2a", padding: "10px 0 20px", display: "flex", justifyContent: "space-around", alignItems: "center", zIndex: 100 }}>
        {tabs.map(tab => {
          if (tab.id === "scan") {
            return (
              <button key="scan" onClick={() => setPage("scan")} style={{ background: "linear-gradient(135deg, #f97316, #ef4444)", border: "none", borderRadius: "50%", width: "56px", height: "56px", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", marginTop: "-20px", boxShadow: "0 4px 20px rgba(249,115,22,0.5)" }}>
                <IconPlus />
              </button>
            );
          }
          const active = page === tab.id;
          return (
            <button key={tab.id} onClick={() => setPage(tab.id)} style={{ background: "none", border: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: "4px", padding: "4px 16px" }}>
              <span style={{ color: active ? "#f97316" : "#444" }}><tab.Icon /></span>
              <span style={{ color: active ? "#f97316" : "#444", fontSize: "11px", fontWeight: active ? "600" : "400" }}>{tab.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}