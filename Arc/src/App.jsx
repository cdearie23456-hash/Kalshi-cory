import { useState, useEffect, useRef, useCallback } from "react";

const KALSHI_BASE = "https://trading-api.kalshi.com/trade-api/v2";

// RSA-PSS signing using Web Crypto API (works in browser)
function encodeLen(len) {
  if (len < 128) return [len];
  if (len < 256) return [0x81, len];
  return [0x82, (len >> 8) & 0xff, len & 0xff];
}

function pkcs1ToPkcs8(pkcs1) {
  const rsaAlg = new Uint8Array([0x30,0x0d,0x06,0x09,0x2a,0x86,0x48,0x86,0xf7,0x0d,0x01,0x01,0x01,0x05,0x00]);
  const ver = new Uint8Array([0x02,0x01,0x00]);
  const octet = new Uint8Array([0x04, ...encodeLen(pkcs1.length), ...pkcs1]);
  const inner = new Uint8Array([...ver, ...rsaAlg, ...octet]);
  return new Uint8Array([0x30, ...encodeLen(inner.length), ...inner]);
}

async function importPrivateKey(pemKey) {
  // Accept key with or without headers
  if (!pemKey.includes("-----")) {
    pemKey = "-----BEGIN RSA PRIVATE KEY-----\n" + pemKey + "\n-----END RSA PRIVATE KEY-----";
  }
  const cleaned = pemKey
    .replace(/-----BEGIN RSA PRIVATE KEY-----/, "")
    .replace(/-----END RSA PRIVATE KEY-----/, "")
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const pkcs1 = Uint8Array.from(atob(cleaned), c => c.charCodeAt(0));
  for (const der of [pkcs1, pkcs1ToPkcs8(pkcs1)]) {
    try {
      return await crypto.subtle.importKey(
        "pkcs8", der.buffer,
        { name: "RSA-PSS", hash: "SHA-256" },
        false, ["sign"]
      );
    } catch {}
  }
  throw new Error("Could not import private key. Make sure you copied the full key including the BEGIN/END lines.");
}

async function makeKalshiHeaders(keyId, privateKey, method, path) {
  const timestamp = Date.now().toString();
  const pathWithoutQuery = path.split("?")[0];
  const message = timestamp + method.toUpperCase() + pathWithoutQuery;
  const encoded = new TextEncoder().encode(message);
  const sigBuffer = await crypto.subtle.sign(
    { name: "RSA-PSS", saltLength: 32 },
    privateKey, encoded
  );
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuffer)));
  return {
    "Content-Type": "application/json",
    "KALSHI-ACCESS-KEY": keyId,
    "KALSHI-ACCESS-TIMESTAMP": timestamp,
    "KALSHI-ACCESS-SIGNATURE": sig,
  };
}

function kellyBetSize(edge, confidence, price, balance) {
  const p = confidence;
  const q = 1 - p;
  const b = (100 - price) / price;
  const kelly = (p * b - q) / b;
  const halfKelly = Math.max(0, kelly * 0.5);
  const raw = balance * Math.min(halfKelly, 0.08);
  return Math.round(Math.max(5, Math.min(10000, raw)));
}

const css = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600&family=Bebas+Neue&display=swap');
*{box-sizing:border-box;margin:0;padding:0;}
:root{
  --bg:#04060a;--panel:#080d14;--panel2:#0d1520;
  --border:rgba(0,200,100,0.12);--green:#00c864;--green2:#00ff87;
  --red:#ff3355;--gold:#f5c400;--blue:#00aaff;--text:#c8d8c0;--dim:#3a5040;
  --mono:'IBM Plex Mono',monospace;--display:'Bebas Neue',sans-serif;
}
body{background:var(--bg);color:var(--text);font-family:var(--mono);min-height:100vh;overflow-x:hidden;}
body::before{content:'';position:fixed;inset:0;background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,200,100,0.015) 2px,rgba(0,200,100,0.015) 4px);pointer-events:none;z-index:0;}
.app{position:relative;z-index:1;max-width:1240px;margin:0 auto;padding:20px 16px;}

.hdr{display:flex;align-items:center;gap:20px;padding:16px 24px;background:var(--panel);border:1px solid var(--border);border-radius:16px;margin-bottom:16px;flex-wrap:wrap;}
.hdr-logo{font-family:var(--display);font-size:34px;letter-spacing:2px;color:var(--green2);line-height:1;text-shadow:0 0 20px rgba(0,255,135,0.4);}
.hdr-sub{font-size:9px;color:var(--dim);letter-spacing:3px;text-transform:uppercase;margin-top:2px;}
.hdr-stats{display:flex;gap:16px;margin-left:auto;flex-wrap:wrap;}
.stat{text-align:right;}
.stat-val{font-family:var(--display);font-size:22px;letter-spacing:1px;}
.stat-val.green{color:var(--green2);}
.stat-val.gold{color:var(--gold);}
.stat-val.blue{color:var(--blue);}
.stat-val.red{color:var(--red);}
.stat-lbl{font-size:9px;color:var(--dim);text-transform:uppercase;letter-spacing:2px;}

.status-bar{display:flex;align-items:center;gap:10px;padding:10px 16px;background:var(--panel);border:1px solid var(--border);border-radius:10px;margin-bottom:16px;font-size:11px;flex-wrap:wrap;}
.pulse{width:8px;height:8px;border-radius:50%;background:var(--dim);flex-shrink:0;}
.pulse.active{background:var(--green2);animation:pulse 2s infinite;}
.pulse.scanning{background:var(--gold);animation:pulse 0.8s infinite;}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(0,255,135,0.5);}70%{box-shadow:0 0 0 8px rgba(0,255,135,0);}100%{box-shadow:0 0 0 0 rgba(0,255,135,0);}}
.status-text{color:var(--green);}
.btn-toggle{padding:7px 14px;border-radius:6px;border:1px solid;font-family:var(--mono);font-size:11px;cursor:pointer;font-weight:600;letter-spacing:1px;text-transform:uppercase;transition:all 0.15s;}
.btn-start{background:rgba(0,200,100,0.1);color:var(--green2);border-color:rgba(0,200,100,0.3);}
.btn-start:hover{background:rgba(0,200,100,0.2);}
.btn-stop{background:rgba(255,51,85,0.1);color:var(--red);border-color:rgba(255,51,85,0.3);}
.btn-stop:hover{background:rgba(255,51,85,0.2);}
.btn-toggle:disabled{opacity:0.4;cursor:not-allowed;}

.main{display:grid;grid-template-columns:1fr 340px;gap:14px;}
@media(max-width:860px){.main{grid-template-columns:1fr;}}

.log-wrap{background:var(--panel);border:1px solid var(--border);border-radius:16px;overflow:hidden;}
.log-hdr{padding:12px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;font-size:10px;text-transform:uppercase;letter-spacing:2px;color:var(--dim);}
.log-body{height:480px;overflow-y:auto;padding:10px;scrollbar-width:thin;scrollbar-color:var(--border) transparent;}
.log-entry{padding:10px 12px;border-radius:8px;margin-bottom:7px;font-size:11px;line-height:1.7;border-left:3px solid transparent;animation:fadeIn 0.3s ease;}
@keyframes fadeIn{from{opacity:0;transform:translateY(3px);}to{opacity:1;transform:none;}}
.log-entry.trade{background:rgba(0,200,100,0.06);border-left-color:var(--green);}
.log-entry.skip{background:rgba(255,255,255,0.02);border-left-color:var(--dim);}
.log-entry.scan{background:rgba(0,170,255,0.05);border-left-color:var(--blue);}
.log-entry.error{background:rgba(255,51,85,0.05);border-left-color:var(--red);}
.log-time{color:var(--dim);font-size:10px;margin-bottom:2px;}
.log-market{color:var(--text);font-weight:500;margin-bottom:3px;}
.log-detail{color:var(--dim);font-size:10px;}
.tag{display:inline-block;padding:1px 7px;border-radius:3px;font-size:9px;font-weight:600;letter-spacing:1px;text-transform:uppercase;margin-right:6px;}
.tag-trade{background:rgba(0,200,100,0.15);color:var(--green2);}
.tag-skip{background:rgba(58,80,64,0.3);color:var(--dim);}
.tag-scan{background:rgba(0,170,255,0.1);color:var(--blue);}
.tag-err{background:rgba(255,51,85,0.15);color:var(--red);}

.side{display:flex;flex-direction:column;gap:12px;}
.card{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:16px;}
.card-title{font-size:9px;text-transform:uppercase;letter-spacing:3px;color:var(--dim);margin-bottom:12px;}
.field{margin-bottom:11px;}
.field label{display:block;font-size:10px;color:var(--dim);letter-spacing:1px;margin-bottom:4px;text-transform:uppercase;}
.field input,.field textarea{width:100%;background:var(--panel2);border:1px solid var(--border);border-radius:6px;padding:9px 12px;color:var(--text);font-family:var(--mono);font-size:11px;outline:none;transition:border-color 0.2s;resize:vertical;}
.field input:focus,.field textarea:focus{border-color:var(--green);}
.field input[type=password]{letter-spacing:3px;}
.btn-connect{width:100%;padding:12px;border:none;border-radius:8px;background:var(--green);color:#04060a;font-family:var(--display);font-size:20px;letter-spacing:2px;cursor:pointer;transition:all 0.15s;margin-top:4px;}
.btn-connect:hover{background:var(--green2);}
.btn-connect:disabled{opacity:0.4;cursor:not-allowed;}

.kv{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;font-size:10px;}
.kv span:first-child{color:var(--dim);}
.kv span:last-child{color:var(--text);font-weight:500;}
.trades-list{max-height:180px;overflow-y:auto;scrollbar-width:thin;}
.trade-row{display:grid;grid-template-columns:1fr auto auto;gap:6px;align-items:center;padding:7px 9px;border-radius:5px;margin-bottom:3px;font-size:10px;}
.trade-row:nth-child(odd){background:rgba(255,255,255,0.02);}
.side-yes{color:var(--green);}
.side-no{color:var(--red);}
.t-amt{color:var(--gold);}

.alert{padding:9px 13px;border-radius:7px;font-size:11px;margin-bottom:10px;}
.alert-s{background:rgba(0,200,100,0.08);color:var(--green);border:1px solid rgba(0,200,100,0.2);}
.alert-e{background:rgba(255,51,85,0.08);color:var(--red);border:1px solid rgba(255,51,85,0.2);}
.alert-i{background:rgba(0,170,255,0.08);color:var(--blue);border:1px solid rgba(0,170,255,0.2);}

.connect-wrap{max-width:460px;margin:40px auto;}
.connect-title{font-family:var(--display);font-size:50px;letter-spacing:4px;color:var(--green2);text-align:center;margin-bottom:4px;text-shadow:0 0 30px rgba(0,255,135,0.3);}
.connect-sub{text-align:center;font-size:10px;color:var(--dim);letter-spacing:3px;text-transform:uppercase;margin-bottom:28px;}
.spinner{width:13px;height:13px;border:2px solid var(--border);border-top-color:var(--green);border-radius:50%;animation:spin 0.7s linear infinite;display:inline-block;vertical-align:middle;margin-right:6px;}
@keyframes spin{to{transform:rotate(360deg);}}
.empty{text-align:center;padding:36px 20px;color:var(--dim);font-size:11px;}
.strategy-pill{display:inline-block;padding:2px 7px;border-radius:99px;font-size:9px;letter-spacing:1px;text-transform:uppercase;border:1px solid;margin:2px;}
.hint{font-size:10px;color:var(--dim);margin-top:6px;line-height:1.7;}
`;

function parseAIResponse(text) {
  const t = text.toLowerCase();
  let side = null;
  if (t.includes("rec: buy yes") || t.includes("buy yes")) side = "yes";
  else if (t.includes("rec: buy no") || t.includes("buy no")) side = "no";

  let confidence = 0.58;
  const confMatch = text.match(/confidence[:\s]+(\d+)/i);
  if (confMatch) confidence = Math.min(0.99, parseInt(confMatch[1]) / 100);
  else if (t.includes("very high")) confidence = 0.90;
  else if (t.includes("high confidence") || t.includes("confidence: high")) confidence = 0.82;
  else if (t.includes("medium-high")) confidence = 0.70;
  else if (t.includes("medium")) confidence = 0.62;

  let edge = 0;
  const edgeMatch = text.match(/edge[:\s]+\+?(\d+)/i) || text.match(/(\d+)[¢c]\s*(edge|mispriced)/i);
  if (edgeMatch) edge = parseInt(edgeMatch[1]);
  else if (t.includes("strong edge")) edge = 14;
  else if (t.includes("clear edge")) edge = 9;
  else if (t.includes("slight edge")) edge = 5;

  let strategy = "ai_analysis";
  if (t.includes("favorite") || t.includes("heavily favored")) strategy = "favorite_bias";
  if (t.includes("daily") || t.includes("resolves today")) strategy = "daily_market";
  if (side === "no" && confidence > 0.68) strategy = "cheap_no";

  return { side, confidence, edge, strategy };
}

export default function KalshiBot() {
  const [keyId, setKeyId] = useState("");
  const [privateKeyPem, setPrivateKeyPem] = useState("");
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [balance, setBalance] = useState(0);
  const [startBalance, setStartBalance] = useState(0);
  const [running, setRunning] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [logs, setLogs] = useState([]);
  const [trades, setTrades] = useState([]);
  const [tradesPlaced, setTradesPlaced] = useState(0);
  const [totalWagered, setTotalWagered] = useState(0);
  const [countdown, setCountdown] = useState(null);
  const [alert, setAlert] = useState(null);
  const intervalRef = useRef(null);
  const countdownRef = useRef(null);
  const scanningRef = useRef(false);
  const cryptoKeyRef = useRef(null);
  const keyIdRef = useRef("");

  const addLog = useCallback((entry) => {
    setLogs(prev => [{ ...entry, id: Date.now() + Math.random(), time: new Date().toLocaleTimeString() }, ...prev].slice(0, 150));
  }, []);

  const showAlert = (msg, type = "i") => { setAlert({ msg, type }); setTimeout(() => setAlert(null), 5000); };

  const kalshiFetch = useCallback(async (method, path, body = null) => {
    const headers = await makeKalshiHeaders(keyIdRef.current, cryptoKeyRef.current, method, path);
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    return fetch(KALSHI_BASE + path, opts);
  }, []);

  const refreshBalance = useCallback(async () => {
    try {
      const r = await kalshiFetch("GET", "/portfolio/balance");
      const d = await r.json();
      setBalance(d.balance / 100);
      return d.balance / 100;
    } catch { return null; }
  }, [kalshiFetch]);

  const connect = async () => {
    if (!keyId.trim()) return showAlert("Enter your API Key ID", "e");
    if (!privateKeyPem.trim()) return showAlert("Paste your Private Key", "e");
    setConnecting(true);
    try {
      const imported = await importPrivateKey(privateKeyPem);
      cryptoKeyRef.current = imported;
      keyIdRef.current = keyId.trim();
      const res = await kalshiFetch("GET", "/portfolio/balance");
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "Auth failed");
      }
      const data = await res.json();
      const bal = data.balance / 100;
      setBalance(bal);
      setStartBalance(bal);
      setConnected(true);
      addLog({ type: "scan", title: "✅ Connected to Kalshi!", detail: `Balance: $${bal.toFixed(2)}` });
    } catch (e) {
      showAlert(`Connection failed: ${e.message}`, "e");
      cryptoKeyRef.current = null;
      keyIdRef.current = "";
    } finally { setConnecting(false); }
  };

  const runScan = useCallback(async () => {
    if (scanningRef.current) return;
    scanningRef.current = true;
    setScanning(true);
    addLog({ type: "scan", title: "Scanning markets...", detail: "Prioritizing: daily, favorites 60-88¢, cheap NOs, high volume" });

    try {
      const mRes = await kalshiFetch("GET", "/markets?limit=50&status=open");
      const mData = await mRes.json();
      const allMarkets = mData.markets || [];

      const scored = allMarkets.map(m => {
        let score = 0;
        const yp = m.yes_ask || 50;
        const np = m.no_ask || 50;
        const vol = m.volume || 0;
        const hoursLeft = m.close_time ? (new Date(m.close_time) - Date.now()) / 3600000 : 999;
        if (hoursLeft < 24) score += 40;
        else if (hoursLeft < 72) score += 20;
        if (yp >= 60 && yp <= 88) score += 30;
        if (np >= 8 && np <= 20) score += 25;
        if (vol > 10000) score += 20;
        else if (vol > 1000) score += 10;
        if (yp < 5 || yp > 95) score -= 50;
        return { ...m, _score: score, _hoursLeft: hoursLeft };
      });

      const targets = scored.filter(m => m._score > 20).sort((a, b) => b._score - a._score).slice(0, 10);
      addLog({ type: "scan", title: `Analyzing top ${targets.length} markets`, detail: `From ${allMarkets.length} open markets` });

      const currentBalance = await refreshBalance() || balance;

      for (const market of targets) {
        const yp = market.yes_ask || 50;
        const np = market.no_ask || 50;
        const hoursLabel = market._hoursLeft < 24 ? `${Math.round(market._hoursLeft)}h` : `${Math.round(market._hoursLeft / 24)}d`;

        let analysisText = "";
        try {
          const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "claude-sonnet-4-20250514",
              max_tokens: 500,
              tools: [{ type: "web_search_20250305", name: "web_search" }],
              messages: [{
                role: "user",
                content: `You are an expert prediction market trader. Analyze this Kalshi market.

Market: "${market.title}"
YES ask: ${yp}¢ | NO ask: ${np}¢
Volume: ${(market.volume||0).toLocaleString()} | Time left: ${hoursLabel}

Search the web for latest data. Is this market mispriced?

Respond EXACTLY:
REC: [BUY YES / BUY NO / SKIP]
CONFIDENCE: [50-99]
EDGE: [cents, e.g. 12]
REASON: [one sentence]

Only recommend if 6+ cents genuine edge. Otherwise SKIP.`
              }]
            }),
          });
          const aiData = await aiRes.json();
          analysisText = aiData.content?.filter(b => b.type === "text").map(b => b.text).join(" ") || "";
        } catch {
          addLog({ type: "error", title: `AI failed: ${(market.title||"").slice(0,50)}`, detail: "Skipping" });
          continue;
        }

        const { side, confidence, edge, strategy } = parseAIResponse(analysisText);
        const reason = analysisText.match(/REASON:\s*(.+)/i)?.[1]?.trim().slice(0, 90) || "";

        if (!side || edge < 6 || confidence < 0.55) {
          addLog({ type: "skip", title: (market.title||"").slice(0, 68), detail: `SKIP — edge ${edge}¢ / conf ${(confidence*100).toFixed(0)}% | ${reason}` });
          continue;
        }

        const price = side === "yes" ? yp : np;
        const betAmount = kellyBetSize(edge, confidence, price, currentBalance);
        const contracts = Math.max(1, Math.floor((betAmount * 100) / price));
        const actualCost = contracts * price / 100;

        addLog({ type: "trade", title: `TRADE: ${(market.title||"").slice(0,62)}`, detail: `BUY ${side.toUpperCase()} ×${contracts} @ ${price}¢ | $${actualCost.toFixed(2)} | +${edge}¢ edge | ${(confidence*100).toFixed(0)}% | ${reason}` });

        const limitPrice = Math.max(1, price - 1);
        let orderPlaced = false;

        try {
          const body = { ticker: market.ticker, client_order_id: `bot_${Date.now()}`, type: "limit", action: "buy", side, count: contracts };
          if (side === "yes") body.yes_price = limitPrice; else body.no_price = limitPrice;
          const r = await kalshiFetch("POST", "/portfolio/orders", body);
          if (r.ok) { orderPlaced = true; addLog({ type: "trade", title: `✅ Limit order: ${market.ticker}`, detail: `${side.toUpperCase()} ×${contracts} @ ${limitPrice}¢` }); }
        } catch {}

        if (!orderPlaced) {
          try {
            const r = await kalshiFetch("POST", "/portfolio/orders", { ticker: market.ticker, client_order_id: `bot_${Date.now()}_mkt`, type: "market", action: "buy", side, count: contracts });
            if (r.ok) { orderPlaced = true; addLog({ type: "trade", title: `✅ Market order: ${market.ticker}`, detail: `${side.toUpperCase()} ×${contracts}` }); }
            else { const e = await r.json().catch(()=>({})); addLog({ type: "error", title: `Rejected: ${market.ticker}`, detail: e.message || "Unknown" }); }
          } catch (e) { addLog({ type: "error", title: `Failed: ${market.ticker}`, detail: e.message }); }
        }

        if (orderPlaced) {
          setTrades(prev => [{ ticker: (market.ticker||"").slice(0,18), side, amount: actualCost.toFixed(2), contracts, edge, confidence: (confidence*100).toFixed(0), strategy, time: new Date().toLocaleTimeString() }, ...prev].slice(0, 60));
          setTradesPlaced(p => p + 1);
          setTotalWagered(w => w + actualCost);
        }

        await new Promise(r => setTimeout(r, 1200));
      }

      await refreshBalance();
      addLog({ type: "scan", title: `Scan complete — ${targets.length} analyzed`, detail: "Next scan in 60 minutes" });
    } catch (e) {
      addLog({ type: "error", title: "Scan error", detail: e.message });
    } finally {
      scanningRef.current = false;
      setScanning(false);
    }
  }, [kalshiFetch, balance, refreshBalance, addLog]);

  const startBot = useCallback(() => {
    setRunning(true);
    addLog({ type: "scan", title: "🤖 Bot activated", detail: "Favorite bias + Cheap NOs + Daily markets + Kelly sizing" });
    runScan();
    const HOUR = 60 * 60 * 1000;
    intervalRef.current = setInterval(runScan, HOUR);
    let secs = HOUR / 1000;
    setCountdown(secs);
    countdownRef.current = setInterval(() => { secs = secs <= 1 ? HOUR / 1000 : secs - 1; setCountdown(secs); }, 1000);
  }, [runScan, addLog]);

  const stopBot = useCallback(() => {
    setRunning(false);
    clearInterval(intervalRef.current);
    clearInterval(countdownRef.current);
    setCountdown(null);
    addLog({ type: "error", title: "Bot stopped", detail: "" });
  }, [addLog]);

  useEffect(() => () => { clearInterval(intervalRef.current); clearInterval(countdownRef.current); }, []);

  const fmt = s => { if (!s) return "--:--"; return `${String(Math.floor(s/60)).padStart(2,"0")}:${String(Math.floor(s%60)).padStart(2,"0")}`; };
  const pnl = balance - startBalance;
  const pnlPct = startBalance > 0 ? ((pnl / startBalance) * 100).toFixed(1) : "0.0";
  const stratColor = s => s === "favorite_bias" ? { color: "var(--green)", borderColor: "rgba(0,200,100,0.3)" } : s === "cheap_no" ? { color: "var(--red)", borderColor: "rgba(255,51,85,0.3)" } : s === "daily_market" ? { color: "var(--blue)", borderColor: "rgba(0,170,255,0.3)" } : { color: "var(--gold)", borderColor: "rgba(245,196,0,0.3)" };

  if (!connected) return (
    <>
      <style>{css}</style>
      <div className="app">
        <div className="connect-wrap">
          <div className="connect-title">KALSHI BOT</div>
          <div className="connect-sub">Profit-Optimized AI Trading Engine</div>
          <div className="card">
            {alert && <div className={`alert alert-${alert.type}`}>{alert.msg}</div>}
            <div className="card-title">Connect Your Kalshi Account</div>

            <div className="field">
              <label>API Key ID</label>
              <input type="text" placeholder="e.g. 0178fda7-5e4d-4fb2-a4fa-..." value={keyId} onChange={e => setKeyId(e.target.value)} />
              <div className="hint">The short ID (looks like: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)</div>
            </div>

            <div className="field">
              <label>Private Key</label>
              <textarea rows={6} placeholder="-----BEGIN RSA PRIVATE KEY-----&#10;Paste your full private key here...&#10;-----END RSA PRIVATE KEY-----" value={privateKeyPem} onChange={e => setPrivateKeyPem(e.target.value)} />
              <div className="hint">You can paste just the middle part (no BEGIN/END lines needed)</div>
            </div>

            <div className="alert alert-i" style={{ marginBottom: 14, fontSize: 10 }}>
              🔒 Your keys stay in your browser only. Never stored or sent anywhere except directly to Kalshi.
            </div>

            <button className="btn-connect" onClick={connect} disabled={connecting}>
              {connecting ? <><span className="spinner"/>CONNECTING...</> : "CONNECT"}
            </button>

            <div style={{ marginTop: 14, fontSize: 10, color: "var(--dim)", lineHeight: 1.9 }}>
              To get your keys: <strong style={{ color: "#94a3b8" }}>kalshi.com</strong> → Settings → API → Generate Key
            </div>
          </div>
        </div>
      </div>
    </>
  );

  return (
    <>
      <style>{css}</style>
      <div className="app">
        <div className="hdr">
          <div>
            <div className="hdr-logo">KALSHI BOT</div>
            <div className="hdr-sub">Profit-Optimized AI Engine</div>
          </div>
          <div className="hdr-stats">
            <div className="stat"><div className="stat-val green">${balance.toFixed(2)}</div><div className="stat-lbl">Balance</div></div>
            <div className="stat"><div className={`stat-val ${pnl >= 0 ? "green" : "red"}`}>{pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} ({pnlPct}%)</div><div className="stat-lbl">P&L</div></div>
            <div className="stat"><div className="stat-val gold">{tradesPlaced}</div><div className="stat-lbl">Trades</div></div>
            <div className="stat"><div className="stat-val blue">${totalWagered.toFixed(0)}</div><div className="stat-lbl">Wagered</div></div>
          </div>
        </div>

        {alert && <div className={`alert alert-${alert.type}`}>{alert.msg}</div>}

        <div className="status-bar">
          <div className={`pulse ${running ? (scanning ? "scanning" : "active") : ""}`} />
          <span className="status-text">{!running ? "BOT INACTIVE" : scanning ? "SCANNING..." : "ACTIVE"}</span>
          {running && countdown && <span style={{ marginLeft: "auto", color: "var(--dim)" }}>Next: {fmt(countdown)}</span>}
          <button className={`btn-toggle ${running ? "btn-stop" : "btn-start"}`} onClick={running ? stopBot : startBot} disabled={scanning}>
            {running ? "STOP" : "START BOT"}
          </button>
          <button className="btn-toggle btn-start" onClick={runScan} disabled={scanning}>
            {scanning ? <><span className="spinner"/>SCANNING</> : "SCAN NOW"}
          </button>
        </div>

        <div className="main">
          <div className="log-wrap">
            <div className="log-hdr"><span style={{ color: "var(--green)" }}>●</span> Live Activity <span style={{ marginLeft: "auto" }}>{logs.length} entries</span></div>
            <div className="log-body">
              {logs.length === 0 && <div className="empty">No activity yet.<br/>Hit START BOT or SCAN NOW.</div>}
              {logs.map(log => (
                <div key={log.id} className={`log-entry ${log.type}`}>
                  <div className="log-time">{log.time}</div>
                  <div className="log-market">
                    <span className={`tag tag-${log.type === "trade" ? "trade" : log.type === "scan" ? "scan" : log.type === "error" ? "err" : "skip"}`}>
                      {log.type === "trade" ? "TRADE" : log.type === "scan" ? "SCAN" : log.type === "error" ? "ERR" : "SKIP"}
                    </span>
                    {log.title}
                  </div>
                  {log.detail && <div className="log-detail">{log.detail}</div>}
                </div>
              ))}
            </div>
          </div>

          <div className="side">
            <div className="card">
              <div className="card-title">Configuration</div>
              <div className="kv"><span>Auth</span><span>RSA-PSS Signed</span></div>
              <div className="kv"><span>Sizing</span><span>Half-Kelly</span></div>
              <div className="kv"><span>Max/trade</span><span>8% of balance</span></div>
              <div className="kv"><span>Min edge</span><span>6¢</span></div>
              <div className="kv"><span>Min confidence</span><span>55%</span></div>
              <div className="kv"><span>Orders</span><span>Limit → Market</span></div>
              <div className="kv"><span>Scan freq</span><span>Every 60 min</span></div>
            </div>

            <div className="card">
              <div className="card-title">Recent Trades ({trades.length})</div>
              <div className="trades-list">
                {trades.length === 0 && <div className="empty" style={{ padding: "16px" }}>No trades yet</div>}
                {trades.map((t, i) => (
                  <div key={i} className="trade-row">
                    <div>
                      <div style={{ color: "var(--text)", marginBottom: 2 }}>{t.ticker}</div>
                      <span className="strategy-pill" style={stratColor(t.strategy)}>{(t.strategy||"").replace("_", " ")}</span>
                    </div>
                    <span className={t.side === "yes" ? "side-yes" : "side-no"}>{t.side?.toUpperCase()} ×{t.contracts}</span>
                    <span className="t-amt">${t.amount}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="alert alert-e" style={{ fontSize: 10, lineHeight: 1.7 }}>
              ⚠️ Real money at risk. No strategy guarantees profit. Only trade what you can afford to lose.
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
