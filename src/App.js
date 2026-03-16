import { useState, useEffect, useRef, useCallback } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";

// ─── Constants ───────────────────────────────────────────────────────────────
const TDEE = 2904;
const STORAGE_KEY = "calorie_tracker_v1";
const API_KEY_STORAGE = "gemini_api_key";

// ─── Helpers ─────────────────────────────────────────────────────────────────
const todayStr = () => new Date().toISOString().slice(0, 10);

function loadData() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
  catch { return {}; }
}
function saveData(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}
function getLast30Days() {
  return Array.from({ length: 30 }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() - (29 - i));
    return d.toISOString().slice(0, 10);
  });
}
function getLast7Days() {
  return getLast30Days().slice(23);
}
function formatDate(str) {
  const d = new Date(str + "T00:00:00");
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// ─── Gemini API ───────────────────────────────────────────────────────────────
async function analyzeFood(imageBase64, mimeType, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const prompt = `Analyze this food image and respond ONLY with a JSON object (no markdown, no explanation):
{
  "name": "food name in Chinese",
  "calories": number,
  "protein": number,
  "fat": number,
  "carbs": number,
  "portion": "estimated portion size",
  "confidence": "high/medium/low"
}
All nutritional values should be in grams (protein/fat/carbs) or kcal (calories).`;

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

// ─── Home Page ────────────────────────────────────────────────────────────────
function HomePage({ data, onNavigate }) {
  const today = todayStr();
  const todayEntries = data[today] || [];
  const totalCal = todayEntries.reduce((s, e) => s + e.calories, 0);
  const totalProtein = todayEntries.reduce((s, e) => s + (e.protein || 0), 0);
  const totalFat = todayEntries.reduce((s, e) => s + (e.fat || 0), 0);
  const totalCarbs = todayEntries.reduce((s, e) => s + (e.carbs || 0), 0);
  const gap = TDEE - totalCal;
  const pct = Math.min((totalCal / TDEE) * 100, 100);
  const over = totalCal > TDEE;

  return (
    <div style={{ padding: "24px 20px 100px", maxWidth: "430px", margin: "0 auto" }}>
      {/* Header */}
      <div style={{ marginBottom: "28px" }}>
        <p style={{ color: "#666", fontSize: "13px", margin: "0 0 4px" }}>{new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" })}</p>
        <h1 style={{ color: "#fff", fontSize: "26px", fontWeight: "700", margin: 0 }}>今日摄入</h1>
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
            <p style={{ color: "#666", fontSize: "13px", margin: "6px 0 0" }}>目标 {TDEE.toLocaleString()} kcal</p>
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
          <span style={{ color: "#555", fontSize: "11px" }}>{TDEE.toLocaleString()}</span>
        </div>

        {over && (
          <div style={{ marginTop: "16px", background: "rgba(239,68,68,0.15)", borderRadius: "10px", padding: "10px 14px", display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ fontSize: "16px" }}>⚠️</span>
            <span style={{ color: "#fca5a5", fontSize: "13px" }}>已超出今日热量目标！</span>
          </div>
        )}
      </div>

      {/* Macros */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "10px", marginBottom: "20px" }}>
        {[
          { label: "蛋白质", value: totalProtein, unit: "g", color: "#60a5fa" },
          { label: "脂肪", value: totalFat, unit: "g", color: "#f59e0b" },
          { label: "碳水", value: totalCarbs, unit: "g", color: "#a78bfa" },
        ].map(m => (
          <div key={m.label} style={{ background: "#16161f", borderRadius: "16px", padding: "16px 12px", border: "1px solid #2a2a3a", textAlign: "center" }}>
            <div style={{ color: m.color, fontSize: "22px", fontWeight: "700" }}>{m.value.toFixed(0)}<span style={{ fontSize: "12px", fontWeight: "400" }}>{m.unit}</span></div>
            <div style={{ color: "#666", fontSize: "12px", marginTop: "4px" }}>{m.label}</div>
          </div>
        ))}
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
  const [phase, setPhase] = useState("select"); // select | preview | analyzing | result | confirm
  const [imgSrc, setImgSrc] = useState(null);
  const [mimeType, setMimeType] = useState("image/jpeg");
  const [base64, setBase64] = useState(null);
  const [result, setResult] = useState(null);
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
      const r = await analyzeFood(base64, mimeType, apiKey);
      setResult(r); setPhase("result");
    } catch (e) {
      setError("识别失败：" + e.message); setPhase("preview");
    }
  }

  function confirmAdd() {
    const entry = {
      ...result,
      time: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
      id: Date.now()
    };
    onAdd(entry);
    reset();
  }

  function reset() {
    setPhase("select"); setImgSrc(null); setBase64(null); setResult(null); setError(""); stopCamera();
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
          {error && <p style={{ color: "#ef4444", fontSize: "14px", textAlign: "center" }}>{error}</p>}
          <div style={{ background: "#16161f", borderRadius: "16px", padding: "16px", border: "1px solid #2a2a3a" }}>
            <p style={{ color: "#666", fontSize: "13px", lineHeight: "1.6", margin: 0 }}>💡 小贴士：拍摄时让食物居中，光线充足，识别效果更佳</p>
          </div>
        </>
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

      {phase === "result" && result && (
        <div>
          <img src={imgSrc} alt="food" style={{ width: "100%", borderRadius: "20px", marginBottom: "16px", maxHeight: "240px", objectFit: "cover" }} />
          <div style={{ background: "#16161f", borderRadius: "20px", padding: "24px", border: "1px solid #2a2a3a", marginBottom: "14px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "20px" }}>
              <div>
                <h2 style={{ color: "#fff", fontSize: "22px", fontWeight: "700", margin: "0 0 6px" }}>{result.name}</h2>
                <span style={{ color: "#555", fontSize: "13px" }}>📏 {result.portion}</span>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ color: "#f97316", fontSize: "32px", fontWeight: "800", lineHeight: 1 }}>{result.calories}</div>
                <div style={{ color: "#666", fontSize: "12px" }}>kcal</div>
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "10px" }}>
              {[
                { label: "蛋白质", value: result.protein, color: "#60a5fa" },
                { label: "脂肪", value: result.fat, color: "#f59e0b" },
                { label: "碳水", value: result.carbs, color: "#a78bfa" },
              ].map(m => (
                <div key={m.label} style={{ background: "#0a0a0f", borderRadius: "12px", padding: "12px", textAlign: "center" }}>
                  <div style={{ color: m.color, fontSize: "18px", fontWeight: "700" }}>{m.value}g</div>
                  <div style={{ color: "#555", fontSize: "11px", marginTop: "3px" }}>{m.label}</div>
                </div>
              ))}
            </div>
            <div style={{ marginTop: "14px", textAlign: "right" }}>
              <span style={{ color: "#444", fontSize: "12px" }}>置信度：{result.confidence === "high" ? "高 ✓" : result.confidence === "medium" ? "中等" : "较低"}</span>
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
function TrendsPage({ data }) {
  const [range, setRange] = useState(7);
  const days = range === 7 ? getLast7Days() : getLast30Days();
  const chartData = days.map(d => ({
    date: formatDate(d),
    calories: (data[d] || []).reduce((s, e) => s + e.calories, 0),
    over: (data[d] || []).reduce((s, e) => s + e.calories, 0) > TDEE
  }));
  const avg = chartData.filter(d => d.calories > 0).reduce((s, d) => s + d.calories, 0) / (chartData.filter(d => d.calories > 0).length || 1);

  return (
    <div style={{ padding: "24px 20px 100px", maxWidth: "430px", margin: "0 auto" }}>
      <h1 style={{ color: "#fff", fontSize: "24px", fontWeight: "700", marginBottom: "6px" }}>卡路里趋势</h1>
      <p style={{ color: "#666", fontSize: "13px", marginBottom: "20px" }}>目标 {TDEE.toLocaleString()} kcal/天</p>

      <div style={{ display: "flex", gap: "8px", marginBottom: "24px" }}>
        {[7, 30].map(r => (
          <button key={r} onClick={() => setRange(r)} style={{ padding: "8px 20px", borderRadius: "99px", border: "1px solid", borderColor: range === r ? "#f97316" : "#2a2a3a", background: range === r ? "rgba(249,115,22,0.15)" : "transparent", color: range === r ? "#f97316" : "#666", cursor: "pointer", fontSize: "14px" }}>
            {r}天
          </button>
        ))}
      </div>

      <div style={{ background: "#16161f", borderRadius: "20px", padding: "20px 10px 10px", border: "1px solid #2a2a3a", marginBottom: "16px" }}>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={chartData} margin={{ top: 0, right: 10, left: -20, bottom: 0 }}>
            <XAxis dataKey="date" tick={{ fill: "#555", fontSize: 11 }} axisLine={false} tickLine={false} interval={range === 7 ? 0 : 4} />
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
          <div style={{ color: avg > TDEE ? "#ef4444" : "#34d399", fontSize: "22px", fontWeight: "700" }}>
            {avg > TDEE ? "+" : ""}{Math.round(avg - TDEE).toLocaleString()}
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
      {page === "home" && <HomePage data={data} onNavigate={setPage} />}
      {page === "scan" && <ScanPage apiKey={apiKey} onAdd={addEntry} />}
      {page === "records" && <RecordsPage data={data} onDelete={deleteEntry} />}
      {page === "trends" && <TrendsPage data={data} />}

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