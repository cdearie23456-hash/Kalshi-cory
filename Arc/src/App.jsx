import { useState, useEffect, useRef, useCallback } from "react";

const KALSHI_BASE = "https://trading-api.kalshi.com/trade-api/v2";
const DEMO_BASE = "https://demo-api.kalshi.co/trade-api/v2";

function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/-----BEGIN RSA PRIVATE KEY-----/, "")
    .replace(/-----END RSA PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(b64);
  const buf = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
  return buf;
}

async function importPrivateKey(pem) {
  const keyData = pemToArrayBuffer(pem);
  return await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSA-PSS", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function signRequest(privateKeyPem, method, path) {
  const timestamp = Date.now().toString();
  const msgString = timestamp + method + path.split("?")[0];
  const encoder = new TextEncoder();
  const key = await importPrivateKey(privateKeyPem);
  const signature = await crypto.subtle.sign(
    { name: "RSA-PSS", saltLength: 32 },
    key,
    encoder.encode(msgString)
  );
  const sigBase64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
  return { timestamp, sigBase64 };
}

async function kalshiFetch(path, method = "GET", keyId, privateKeyPem, body = null, useDemo = false) {
  const base = useDemo ? DEMO_BASE : KALSHI_BASE;
  const { timestamp, sigBase64 } = await signRequest(privateKeyPem, method, `/trade-api/v2${path}`);
  const headers = {
    "Content-Type": "application/json",
    "KALSHI-ACCESS-KEY": keyId,
    "KALSHI-ACCESS-SIGNATURE": sigBase64,
    "KALSHI-ACCESS-TIMESTAMP": timestamp,
  };
  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(base + path, options);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `HTTP ${res.status}`);
  }
  return await res.json();
}

async function kalshiPublicFetch(path) {
  const res = await fetch(KALSHI_BASE + path);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

async function analyzeMarketWithClaude(market) {
  const prompt = `You are a prediction market analyst. Analyze this Kalshi market and give a YES or NO recommendation.

Market: ${market.title}
Current YES price: ${market.yes_ask}c
Current NO price: ${market.no_ask}c
Volume: ${market.volume || 0}
Close time: ${market.close_time ? new Date(market.close_time).toLocaleDateString() : "Unknown"}

Respond ONLY with valid JSON, no markdown:
{"side": "YES" or "NO", "confidence": number 1-99, "reasoning": "2 sentence explanation", "edge": "brief edge"}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await response.json();
  const text = data.content?.map(b => b.text || "").join("") || "";
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

export default function KalshiBot() {
  const [screen, setScreen] = useState("connect");
  const [keyId, setKeyId] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [useDemo, setUseDemo] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState(null);
  const [balance, setBalance] = useState(null);
  const [markets, setMarkets] = useState([]);
  const [loadingMarkets, setLoadingMarkets] = useState(false);
  const [analyses, setAnalyses] = useState({});
  const [analyzingId, setAnalyzingId] = useState(null);
  const [paperBalance, setPaperBalance] = useState(100.00);
  const [paperBets, setPaperBets] = useState([]);
  const [logs, setLogs] = useState([]);
  const [running, setRunning] = useState(false);
  const [betAmount, setBetAmount] = useState(5);
  const [marketFilter, setMarketFilter] = useState("all");
  const intervalRef = useRef(null);
  const keyIdRef = useRef(keyId);
  const privateKeyRef = useRef(privateKey);
  const betAmountRef = useRef(betAmount);
  const paperBalanceRef = useRef(paperBalance);

  useEffect(() => { keyIdRef.current = keyId; }, [keyId]);
  useEffect(() => { privateKeyRef.current = privateKey; }, [privateKey]);
  useEffect(() => { betAmountRef.current = betAmount; }, [betAmount]);
  useEffect(() => { paperBalanceRef.current = paperBalance; }, [paperBalance]);

  const addLog = useCallback((msg, type = "info") => {
    const time = new Date().toLocaleTimeString();
    setLogs(prev => [{ msg, type, time }, ...prev].slice(0, 60));
  }, []);

  const connect = async () => {
    if (!keyId.trim() || !privateKey.trim()) {
      setConnectError("Both API Key ID and Private Key are required.");
      return;
    }
    setConnecting(true);
    setConnectError(null);
    try {
      const data = await kalshiFetch("/portfolio/balance", "GET", keyId.trim(), privateKey.trim(), null, useDemo);
      setBalance((data.balance / 100).toFixed(2));
      addLog(`Connected to Kalshi ${useDemo ? "DEMO" : "LIVE"}. Balance: $${(data.balance / 100).toFixed(2)}`, "buy");
      setScreen("dashboard");
      loadMarkets();
    } catch (e) {
      setConnectError(`Connection failed: ${e.message}`);
    } finally {
      setConnecting(false);
    }
  };

  const loadMarkets = async () => {
    setLoadingMarkets(true);
    try {
      const data = await kalshiPublicFetch("/markets?limit=20&status=open");
      setMarkets(data.markets || []);
      addLog(`Loaded ${(data.markets || []).length} open markets`, "info");
    } catch (e) {
      addLog(`Could not load markets: ${e.message}`, "sell");
    } finally {
      setLoadingMarkets(false);
    }
  };

  const analyzeMarket = async (market) => {
    setAnalyzingId(market.ticker);
    try {
      const analysis = await analyzeMarketWithClaude(market);
      setAnalyses(prev => ({ ...prev, [market.ticker]: analysis }));
      addLog(`${market.title.slice(0, 35)}... -> ${analysis.side} (${analysis.confidence}% conf)`, analysis.side === "YES" ? "buy" : "sell");
    } catch (e) {
      addLog(`Analysis failed: ${e.message}`, "sell");
    } finally {
      setAnalyzingId(null);
    }
  };

  const placePaperBet = useCallback((market, analysis) => {
    const amount = betAmountRef.current;
    if (paperBalanceRef.current < amount) { addLog("Insufficient paper balance", "sell"); return; }
    const price = analysis.side === "YES" ? (market.yes_ask / 100) : (market.no_ask / 100);
    setPaperBalance(prev => parseFloat((prev - amount).toFixed(2)));
    setPaperBets(prev => [{
      ticker: market.ticker, title: market.title, side: analysis.side,
      price, spent: amount, confidence: analysis.confidence,
      reasoning: analysis.reasoning, time: new Date().toLocaleTimeString(),
    }, ...prev]);
    addLog(`PAPER: ${analysis.side} "${market.title.slice(0, 30)}..." @ ${market[analysis.side === "YES" ? "yes_ask" : "no_ask"]}c | $${amount}`, analysis.side === "YES" ? "buy" : "sell");
  }, [addLog]);

  const placeRealBet = async (market, analysis) => {
    try {
      const price = analysis.side === "YES" ? market.yes_ask : market.no_ask;
      const count = Math.floor((betAmount * 100) / price);
      if (count < 1) { addLog("Bet amount too small", "sell"); return; }
      await kalshiFetch("/portfolio/orders", "POST", keyIdRef.current, privateKeyRef.current, {
        ticker: market.ticker,
        side: analysis.side.toLowerCase(),
        type: "limit",
        yes_price: analysis.side === "YES" ? price : 100 - price,
        no_price: analysis.side === "NO" ? price : 100 - price,
        count,
        action: "buy",
      }, useDemo);
      addLog(`REAL ORDER: ${analysis.side} "${market.title.slice(0, 30)}..." | ${count} contracts`, "buy");
    } catch (e) {
      addLog(`Order failed: ${e.message}`, "sell");
    }
  };

  const autoRun = useCallback(async () => {
    addLog("Auto-scanning markets...", "info");
    try {
      const data = await kalshiPublicFetch("/markets?limit=10&status=open");
      const mrkts = (data.markets || []).slice(0, 3);
      for (const m of mrkts) {
        try {
          const analysis = await analyzeMarketWithClaude(m);
          setAnalyses(prev => ({ ...prev, [m.ticker]: analysis }));
          if (analysis.confidence >= 75) placePaperBet(m, analysis);
        } catch {}
        await new Promise(r => setTimeout(r, 1500));
      }
    } catch (e) {
      addLog(`Auto-scan error: ${e.message}`, "sell");
    }
  }, [addLog, placePaperBet]);

  useEffect(() => {
    if (running) {
      addLog("Bot started - AI scanning every 2 min...", "info");
      autoRun();
      intervalRef.current = setInterval(autoRun, 120000);
    } else {
      clearInterval(intervalRef.current);
    }
    return () => clearInterval(intervalRef.current);
  }, [running, autoRun]);

  const filteredMarkets = markets.filter(m => {
    if (marketFilter === "all") return true;
    const t = (m.title || "").toLowerCase();
    if (marketFilter === "politics") return t.includes("elect") || t.includes("president") || t.includes("congress") || t.includes("senate");
    if (marketFilter === "economy") return t.includes("fed") || t.includes("inflation") || t.includes("gdp") || t.includes("rate") || t.includes("jobs");
    if (marketFilter === "crypto") return t.includes("bitcoin") || t.includes("btc") || t.includes("eth") || t.includes("crypto");
    return true;
  });

  if (screen === "connect") {
    return (
      <div style={{ minHeight: "100vh", background: "#04060a", color: "#e0e0e0", fontFamily: "'Courier New', monospace", display: "flex", alignItems: "center", justifyContent: "center", padding: "24px" }}>
        <div style={{ width: "100%", maxWidth: "420px" }}>
          <div style={{ textAlign: "center", marginBottom: "32px" }}>
            <div style={{ fontSize: "10px", letterSpacing: "6px", color: "#444", marginBottom: "6px" }}>AI-POWERED</div>
            <h1 style={{ fontSize: "28px", fontWeight: "900", letterSpacing: "4px", margin: 0, background: "linear-gradient(135deg, #00e5b4, #00a8ff)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>KALSHI BOT</h1>
            <div style={{ fontSize: "10px", letterSpacing: "3px", color: "#444", marginTop: "6px" }}>PREDICTION MARKET TRADER</div>
          </div>
          <div style={{ background: "#0d1117", border: "1px solid #1a2030", borderRadius: "14px", padding: "24px", marginBottom: "12px" }}>
            <div style={{ fontSize: "10px", letterSpacing: "3px", color: "#555", marginBottom: "20px" }}>CONNECT YOUR ACCOUNT</div>
            <div style={{ marginBottom: "16px" }}>
              <div style={{ fontSize: "10px", color: "#555", letterSpacing: "2px", marginBottom: "6px" }}>API KEY ID</div>
              <input
                value={keyId}
                onChange={e => setKeyId(e.target.value)}
                placeholder="e.g. a952bcbe-ec3b-4b5b-b8f9-..."
                style={{ width: "100%", background: "#060a0f", border: "1px solid #1a2030", borderRadius: "8px", padding: "12px", color: "#e0e0e0", fontFamily: "'Courier New', monospace", fontSize: "12px", boxSizing: "border-box", outline: "none" }}
              />
            </div>
            <div style={{ marginBottom: "16px" }}>
              <div style={{ fontSize: "10px", color: "#555", letterSpacing: "2px", marginBottom: "6px" }}>RSA PRIVATE KEY (PEM FORMAT)</div>
              <textarea
                value={privateKey}
                onChange={e => setPrivateKey(e.target.value)}
                placeholder={"-----BEGIN PRIVATE KEY-----\nPaste your full private key here\n-----END PRIVATE KEY-----"}
                rows={5}
                style={{ width: "100%", background: "#060a0f", border: "1px solid #1a2030", borderRadius: "8px", padding: "12px", color: "#e0e0e0", fontFamily: "'Courier New', monospace", fontSize: "11px", boxSizing: "border-box", resize: "vertical", outline: "none" }}
              />
              <div style={{ fontSize: "10px", color: "#2a3040", marginTop: "4px" }}>Keys stay in your browser only. Never stored or sent anywhere.</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "20px" }}>
              <div onClick={() => setUseDemo(!useDemo)} style={{ width: "36px", height: "20px", background: useDemo ? "#00e5b4" : "#1a2030", borderRadius: "10px", cursor: "pointer", position: "relative", transition: "background 0.2s", flexShrink: 0 }}>
                <div style={{ position: "absolute", top: "3px", left: useDemo ? "18px" : "3px", width: "14px", height: "14px", background: "#fff", borderRadius: "50%", transition: "left 0.2s" }} />
              </div>
              <span style={{ fontSize: "11px", color: useDemo ? "#00e5b4" : "#ff4466" }}>
                {useDemo ? "DEMO MODE (safe to test - recommended)" : "LIVE MODE (real money at risk)"}
              </span>
            </div>
            {connectError && (
              <div style={{ background: "#ff446615", border: "1px solid #ff446640", borderRadius: "8px", padding: "12px", marginBottom: "16px", fontSize: "12px", color: "#ff7799", lineHeight: "1.5" }}>
                {connectError}
              </div>
            )}
            <button onClick={connect} disabled={connecting} style={{ width: "100%", padding: "16px", border: "none", borderRadius: "10px", fontSize: "14px", fontWeight: "900", letterSpacing: "3px", cursor: connecting ? "not-allowed" : "pointer", background: connecting ? "#1a2030" : "linear-gradient(135deg, #00e5b4, #00a8ff)", color: connecting ? "#555" : "#04060a" }}>
              {connecting ? "CONNECTING..." : "CONNECT"}
            </button>
          </div>
          <div style={{ background: "#080b10", border: "1px solid #0f1520", borderRadius: "10px", padding: "14px", fontSize: "11px", color: "#333", lineHeight: "1.8" }}>
            <div style={{ color: "#444", marginBottom: "4px", letterSpacing: "2px", fontSize: "9px" }}>HOW TO GET YOUR KEYS</div>
            1. kalshi.com - Settings - API<br />
            2. Create new key pair<br />
            3. Copy the Key ID (UUID)<br />
            4. Paste the full .pem private key file contents
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "#04060a", color: "#e0e0e0", fontFamily: "'Courier New', monospace", padding: "16px", maxWidth: "500px", margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
        <div>
          <h1 style={{ fontSize: "20px", fontWeight: "900", letterSpacing: "3px", margin: 0, background: "linear-gradient(135deg, #00e5b4, #00a8ff)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>KALSHI BOT</h1>
          <div style={{ fontSize: "9px", letterSpacing: "2px", color: useDemo ? "#00e5b4" : "#ff4466", marginTop: "2px" }}>{useDemo ? "DEMO" : "LIVE"}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: "9px", color: "#444", letterSpacing: "1px" }}>KALSHI BALANCE</div>
          <div style={{ fontSize: "20px", fontWeight: "700", color: "#00e5b4" }}>${balance}</div>
        </div>
      </div>

      <div style={{ background: "#0d1117", border: "1px solid #1a2030", borderRadius: "12px", padding: "16px", marginBottom: "12px" }}>
        <div style={{ fontSize: "10px", letterSpacing: "3px", color: "#555", marginBottom: "12px" }}>PAPER TRADING</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "10px" }}>
          <div>
            <div style={{ fontSize: "9px", color: "#444", marginBottom: "3px" }}>BALANCE</div>
            <div style={{ fontSize: "18px", fontWeight: "700", color: "#e0e0e0" }}>${paperBalance.toFixed(2)}</div>
          </div>
          <div>
            <div style={{ fontSize: "9px", color: "#444", marginBottom: "3px" }}>BETS PLACED</div>
            <div style={{ fontSize: "18px", fontWeight: "700", color: "#00a8ff" }}>{paperBets.length}</div>
          </div>
          <div>
            <div style={{ fontSize: "9px", color: "#444", marginBottom: "3px" }}>DEPLOYED</div>
            <div style={{ fontSize: "18px", fontWeight: "700", color: "#888" }}>${(100 - paperBalance).toFixed(2)}</div>
          </div>
        </div>
        <div style={{ marginTop: "12px", display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ fontSize: "10px", color: "#444" }}>BET $</span>
          <input type="number" value={betAmount} onChange={e => setBetAmount(Math.max(1, parseFloat(e.target.value) || 1))} style={{ width: "60px", background: "#060a0f", border: "1px solid #1a2030", borderRadius: "6px", padding: "6px 8px", color: "#e0e0e0", fontFamily: "'Courier New', monospace", fontSize: "13px", outline: "none" }} />
          <span style={{ fontSize: "10px", color: "#333" }}>per trade</span>
        </div>
      </div>

      <button onClick={() => setRunning(r => !r)} style={{ width: "100%", padding: "16px", border: running ? "1px solid #ff4466" : "none", borderRadius: "12px", fontSize: "14px", fontWeight: "900", letterSpacing: "4px", cursor: "pointer", marginBottom: "12px", background: running ? "#ff446620" : "linear-gradient(135deg, #00e5b4, #00a8ff)", color: running ? "#ff4466" : "#04060a" }}>
        {running ? "STOP AUTO-BOT" : "START AUTO-BOT"}
      </button>

      <div style={{ background: "#0d1117", border: "1px solid #1a2030", borderRadius: "12px", padding: "16px", marginBottom: "12px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
          <div style={{ fontSize: "10px", letterSpacing: "3px", color: "#555" }}>LIVE MARKETS</div>
          <button onClick={loadMarkets} style={{ background: "none", border: "1px solid #1a2030", borderRadius: "6px", color: "#555", fontSize: "9px", padding: "4px 10px", cursor: "pointer" }}>
            {loadingMarkets ? "LOADING..." : "REFRESH"}
          </button>
        </div>
        <div style={{ display: "flex", gap: "6px", marginBottom: "12px", flexWrap: "wrap" }}>
          {["all", "politics", "economy", "crypto"].map(f => (
            <button key={f} onClick={() => setMarketFilter(f)} style={{ background: marketFilter === f ? "#00e5b420" : "none", border: `1px solid ${marketFilter === f ? "#00e5b4" : "#1a2030"}`, borderRadius: "6px", color: marketFilter === f ? "#00e5b4" : "#444", fontSize: "9px", padding: "4px 10px", cursor: "pointer", letterSpacing: "1px", textTransform: "uppercase" }}>
              {f}
            </button>
          ))}
        </div>
        {loadingMarkets ? (
          <div style={{ color: "#333", fontSize: "12px", textAlign: "center", padding: "20px" }}>Loading markets...</div>
        ) : filteredMarkets.length === 0 ? (
          <div style={{ color: "#333", fontSize: "12px", textAlign: "center", padding: "20px" }}>No markets. Press REFRESH.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px", maxHeight: "420px", overflowY: "auto" }}>
            {filteredMarkets.slice(0, 10).map(m => {
              const analysis = analyses[m.ticker];
              const isAnalyzing = analyzingId === m.ticker;
              return (
                <div key={m.ticker} style={{ background: "#060a0f", border: `1px solid ${analysis ? (analysis.side === "YES" ? "#00e5b430" : "#ff446630") : "#0f1520"}`, borderRadius: "10px", padding: "12px" }}>
                  <div style={{ fontSize: "11px", color: "#bbb", marginBottom: "8px", lineHeight: "1.5" }}>{m.title}</div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ display: "flex", gap: "12px" }}>
                      <span style={{ fontSize: "11px", color: "#00e5b4" }}>YES {m.yes_ask}c</span>
                      <span style={{ fontSize: "11px", color: "#ff4466" }}>NO {m.no_ask}c</span>
                    </div>
                    <button onClick={() => analyzeMarket(m)} disabled={isAnalyzing} style={{ background: "none", border: "1px solid #1a2030", borderRadius: "6px", color: isAnalyzing ? "#333" : "#00a8ff", fontSize: "9px", padding: "4px 10px", cursor: isAnalyzing ? "not-allowed" : "pointer", letterSpacing: "1px", fontFamily: "'Courier New', monospace" }}>
                      {isAnalyzing ? "THINKING..." : "AI ANALYZE"}
                    </button>
                  </div>
                  {analysis && (
                    <div style={{ marginTop: "10px", paddingTop: "10px", borderTop: "1px solid #0f1520" }}>
                      <div style={{ fontSize: "13px", fontWeight: "700", color: analysis.side === "YES" ? "#00e5b4" : "#ff4466", marginBottom: "5px" }}>
                        {analysis.side} - {analysis.confidence}% confidence
                      </div>
                      <div style={{ fontSize: "10px", color: "#445", lineHeight: "1.5", marginBottom: "8px" }}>{analysis.reasoning}</div>
                      <div style={{ display: "flex", gap: "6px" }}>
                        <button onClick={() => placePaperBet(m, analysis)} style={{ flex: 1, background: "#00e5b410", border: "1px solid #00e5b430", borderRadius: "6px", color: "#00e5b4", fontSize: "9px", padding: "8px", cursor: "pointer", letterSpacing: "1px", fontFamily: "'Courier New', monospace" }}>
                          PAPER ${betAmount}
                        </button>
                        {!useDemo && (
                          <button onClick={() => placeRealBet(m, analysis)} style={{ flex: 1, background: "#ff446610", border: "1px solid #ff446630", borderRadius: "6px", color: "#ff4466", fontSize: "9px", padding: "8px", cursor: "pointer", letterSpacing: "1px", fontFamily: "'Courier New', monospace" }}>
                            REAL ${betAmount}
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {paperBets.length > 0 && (
        <div style={{ background: "#0d1117", border: "1px solid #1a2030", borderRadius: "12px", padding: "16px", marginBottom: "12px" }}>
          <div style={{ fontSize: "10px", letterSpacing: "3px", color: "#555", marginBottom: "10px" }}>PAPER BETS ({paperBets.length})</div>
          {paperBets.slice(0, 5).map((b, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid #080c10", fontSize: "11px" }}>
              <div>
                <span style={{ color: b.side === "YES" ? "#00e5b4" : "#ff4466", fontWeight: "700", marginRight: "6px" }}>{b.side}</span>
                <span style={{ color: "#333" }}>{b.title.slice(0, 30)}...</span>
              </div>
              <span style={{ color: "#666" }}>${b.spent} @ {(b.price * 100).toFixed(0)}c</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ background: "#0d1117", border: "1px solid #1a2030", borderRadius: "12px", padding: "16px" }}>
        <div style={{ fontSize: "10px", letterSpacing: "3px", color: "#555", marginBottom: "10px" }}>BOT LOG</div>
        <div style={{ maxHeight: "150px", overflowY: "auto" }}>
          {logs.length === 0 ? (
            <div style={{ color: "#222", fontSize: "11px" }}>Waiting for activity...</div>
          ) : logs.map((l, i) => (
            <div key={i} style={{ fontSize: "10px", color: l.type === "buy" ? "#00e5b4" : l.type === "sell" ? "#ff4466" : "#333", marginBottom: "3px" }}>
              <span style={{ color: "#1a2030", marginRight: "6px" }}>{l.time}</span>{l.msg}
            </div>
          ))}
        </div>
      </div>

      <div style={{ textAlign: "center", marginTop: "14px", fontSize: "9px", color: "#1a2030", letterSpacing: "2px" }}>
        {useDemo ? "DEMO MODE - NO REAL MONEY" : "LIVE MODE - REAL MONEY AT RISK"}
      </div>
    </div>
  );
}
