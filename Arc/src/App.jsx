import { useState, useEffect, useRef, useCallback } from "import { useState, useEffect, useRef, useCallback } from "react";

// ── Public market data (no auth needed, CORS enabled) ──
const KRAKEN_BASE = "https://api.kraken.com/0/public";

// ── Technical Indicators ──
function calcEMA(data, period) {
  const k = 2 / (period + 1);
  let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const result = new Array(period - 1).fill(null);
  result.push(ema);
  for (let i = period; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

function calcRSI(data, period = 14) {
  const result = new Array(period).fill(null);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = data[i] - data[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < data.length; i++) {
    const diff = data[i] - data[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
    result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return result;
}

function calcMACD(closes) {
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macd = ema12.map((v, i) => (v && ema26[i] ? v - ema26[i] : null));
  const validMacd = macd.filter(Boolean);
  const signal = calcEMA(validMacd, 9);
  const fullSignal = new Array(macd.length - signal.length).fill(null).concat(signal);
  return { macd, signal: fullSignal };
}

function calcBollingerBands(closes, period = 20, stdDev = 2) {
  const result = { upper: [], middle: [], lower: [] };
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { result.upper.push(null); result.middle.push(null); result.lower.push(null); continue; }
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
    const sd = Math.sqrt(variance);
    result.upper.push(mean + stdDev * sd);
    result.middle.push(mean);
    result.lower.push(mean - stdDev * sd);
  }
  return result;
}

// ── Signal Engine ──
function generateSignal(closes, volumes) {
  if (closes.length < 30) return { signal: "WAIT", confidence: 0, reasons: [] };
  const rsi = calcRSI(closes);
  const ema9 = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const { macd, signal: macdSignal } = calcMACD(closes);
  const bb = calcBollingerBands(closes);
  const n = closes.length - 1;
  const curRSI = rsi[n], prevRSI = rsi[n - 1];
  const curEMA9 = ema9[n], prevEMA9 = ema9[n - 1];
  const curEMA21 = ema21[n], prevEMA21 = ema21[n - 1];
  const curMACD = macd[n], curSignal = macdSignal[n];
  const prevMACD = macd[n - 1], prevSignalLine = macdSignal[n - 1];
  const price = closes[n];
  const bbLower = bb.lower[n], bbUpper = bb.upper[n];
  const avgVol = volumes.slice(-10).reduce((a, b) => a + b, 0) / 10;
  const volSpike = volumes[n] > avgVol * 1.3;

  let buyScore = 0, sellScore = 0;
  const reasons = [];

  // RSI signals
  if (curRSI < 30) { buyScore += 3; reasons.push({ type: "buy", text: `RSI oversold (${curRSI.toFixed(1)})` }); }
  else if (curRSI < 40 && prevRSI < curRSI) { buyScore += 2; reasons.push({ type: "buy", text: `RSI rising from low (${curRSI.toFixed(1)})` }); }
  if (curRSI > 70) { sellScore += 3; reasons.push({ type: "sell", text: `RSI overbought (${curRSI.toFixed(1)})` }); }
  else if (curRSI > 60 && prevRSI > curRSI) { sellScore += 2; reasons.push({ type: "sell", text: `RSI falling from high (${curRSI.toFixed(1)})` }); }

  // EMA crossover
  if (prevEMA9 < prevEMA21 && curEMA9 > curEMA21) { buyScore += 3; reasons.push({ type: "buy", text: "EMA9 crossed above EMA21 🚀" }); }
  if (prevEMA9 > prevEMA21 && curEMA9 < curEMA21) { sellScore += 3; reasons.push({ type: "sell", text: "EMA9 crossed below EMA21 ⬇️" }); }
  if (curEMA9 > curEMA21) { buyScore += 1; reasons.push({ type: "buy", text: "Uptrend (EMA9 > EMA21)" }); }
  else { sellScore += 1; reasons.push({ type: "sell", text: "Downtrend (EMA9 < EMA21)" }); }

  // MACD
  if (curMACD && curSignal && prevMACD && prevSignalLine) {
    if (prevMACD < prevSignalLine && curMACD > curSignal) { buyScore += 3; reasons.push({ type: "buy", text: "MACD bullish crossover ✨" }); }
    if (prevMACD > prevSignalLine && curMACD < curSignal) { sellScore += 3; reasons.push({ type: "sell", text: "MACD bearish crossover ⚠️" }); }
    if (curMACD > 0 && curMACD > curSignal) { buyScore += 1; reasons.push({ type: "buy", text: "MACD positive momentum" }); }
  }

  // Bollinger Bands
  if (bbLower && price < bbLower) { buyScore += 2; reasons.push({ type: "buy", text: "Price below BB lower band" }); }
  if (bbUpper && price > bbUpper) { sellScore += 2; reasons.push({ type: "sell", text: "Price above BB upper band" }); }

  // Volume
  if (volSpike && buyScore > sellScore) { buyScore += 1; reasons.push({ type: "buy", text: "High volume confirms move" }); }

  const total = buyScore + sellScore;
  if (total === 0) return { signal: "WAIT", confidence: 0, reasons };

  if (buyScore > sellScore && buyScore >= 5) {
    return { signal: "BUY", confidence: Math.min(Math.round((buyScore / (buyScore + sellScore)) * 100), 99), reasons };
  }
  if (sellScore > buyScore && sellScore >= 5) {
    return { signal: "SELL", confidence: Math.min(Math.round((sellScore / (buyScore + sellScore)) * 100), 99), reasons };
  }
  return { signal: "WAIT", confidence: 0, reasons };
}

// ── Main App ──
export default function CryptoBot() {
  const [candles, setCandles] = useState([]);
  const [price, setPrice] = useState(null);
  const [signal, setSignal] = useState({ signal: "WAIT", confidence: 0, reasons: [] });
  const [balance, setBalance] = useState(500);
  const [btcHeld, setBtcHeld] = useState(0);
  const [trades, setTrades] = useState([]);
  const [logs, setLogs] = useState([]);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [entryPrice, setEntryPrice] = useState(null);
  const [totalPnl, setTotalPnl] = useState(0);
  const [lastUpdate, setLastUpdate] = useState(null);
  const intervalRef = useRef(null);
  const tradeRef = useRef({ balance: 500, btcHeld: 0, entryPrice: null });

  const addLog = useCallback((msg, type = "info") => {
    const time = new Date().toLocaleTimeString();
    setLogs(prev => [{ msg, type, time }, ...prev].slice(0, 50));
  }, []);

  const fetchCandles = useCallback(async () => {
    try {
      const res = await fetch(`${KRAKEN_BASE}/OHLC?pair=XBTUSD&interval=15`);
      const data = await res.json();
      if (data.error && data.error.length > 0) throw new Error(data.error[0]);
      const raw = data.result.XXBTZUSD || data.result[Object.keys(data.result)[0]];
      const parsed = raw.slice(-60).map(c => ({
        time: c[0], open: parseFloat(c[1]), high: parseFloat(c[2]),
        low: parseFloat(c[3]), close: parseFloat(c[4]), volume: parseFloat(c[6])
      }));
      setCandles(parsed);
      const latest = parsed[parsed.length - 1].close;
      setPrice(latest);
      setLastUpdate(new Date().toLocaleTimeString());
      setError(null);
      setLoading(false);
      const closes = parsed.map(c => c.close);
      const volumes = parsed.map(c => c.volume);
      const sig = generateSignal(closes, volumes);
      setSignal(sig);
      return { closes, volumes, latest, sig };
    } catch (e) {
      setError("Could not fetch Bitcoin price. Check your internet connection.");
      setLoading(false);
      return null;
    }
  }, []);

  const executeTrade = useCallback((sig, currentPrice) => {
    const { balance: bal, btcHeld: held, entryPrice: entry } = tradeRef.current;
    const fee = 0.001; // 0.1% fee

    // Stop loss / take profit check
    if (held > 0 && entry) {
      const pnlPct = (currentPrice - entry) / entry;
      if (pnlPct <= -0.008) {
        // Stop loss at -0.8%
        const proceeds = held * currentPrice * (1 - fee);
        const pnl = proceeds - (held * entry);
        tradeRef.current.balance = bal + proceeds;
        tradeRef.current.btcHeld = 0;
        tradeRef.current.entryPrice = null;
        setBalance(tradeRef.current.balance);
        setBtcHeld(0);
        setEntryPrice(null);
        setTotalPnl(prev => prev + pnl);
        const trade = { type: "SELL", price: currentPrice, amount: held, pnl, time: new Date().toLocaleTimeString(), reason: "🛑 Stop Loss" };
        setTrades(prev => [trade, ...prev].slice(0, 20));
        addLog(`🛑 STOP LOSS at $${currentPrice.toLocaleString()} | P&L: $${pnl.toFixed(2)}`, "sell");
        return;
      }
      if (pnlPct >= 0.015) {
        // Take profit at +1.5%
        const proceeds = held * currentPrice * (1 - fee);
        const pnl = proceeds - (held * entry);
        tradeRef.current.balance = bal + proceeds;
        tradeRef.current.btcHeld = 0;
        tradeRef.current.entryPrice = null;
        setBalance(tradeRef.current.balance);
        setBtcHeld(0);
        setEntryPrice(null);
        setTotalPnl(prev => prev + pnl);
        const trade = { type: "SELL", price: currentPrice, amount: held, pnl, time: new Date().toLocaleTimeString(), reason: "🎯 Take Profit" };
        setTrades(prev => [trade, ...prev].slice(0, 20));
        addLog(`🎯 TAKE PROFIT at $${currentPrice.toLocaleString()} | P&L: +$${pnl.toFixed(2)}`, "buy");
        return;
      }
    }

    if (sig.signal === "BUY" && held === 0 && bal > 10) {
      const risk = bal * 0.95; // use 95% of balance
      const btcAmount = (risk * (1 - fee)) / currentPrice;
      tradeRef.current.balance = bal - risk;
      tradeRef.current.btcHeld = btcAmount;
      tradeRef.current.entryPrice = currentPrice;
      setBalance(tradeRef.current.balance);
      setBtcHeld(btcAmount);
      setEntryPrice(currentPrice);
      const trade = { type: "BUY", price: currentPrice, amount: btcAmount, pnl: null, time: new Date().toLocaleTimeString(), reason: `${sig.confidence}% confidence` };
      setTrades(prev => [trade, ...prev].slice(0, 20));
      addLog(`🟢 BUY ${btcAmount.toFixed(6)} BTC @ $${currentPrice.toLocaleString()} | Confidence: ${sig.confidence}%`, "buy");
    } else if (sig.signal === "SELL" && held > 0) {
      const proceeds = held * currentPrice * (1 - fee);
      const pnl = proceeds - (held * entry);
      tradeRef.current.balance = bal + proceeds;
      tradeRef.current.btcHeld = 0;
      tradeRef.current.entryPrice = null;
      setBalance(tradeRef.current.balance);
      setBtcHeld(0);
      setEntryPrice(null);
      setTotalPnl(prev => prev + pnl);
      const trade = { type: "SELL", price: currentPrice, amount: held, pnl, time: new Date().toLocaleTimeString(), reason: `Signal sell` };
      setTrades(prev => [trade, ...prev].slice(0, 20));
      addLog(`🔴 SELL @ $${currentPrice.toLocaleString()} | P&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`, pnl >= 0 ? "buy" : "sell");
    }
  }, [addLog]);

  useEffect(() => { fetchCandles(); }, [fetchCandles]);

  useEffect(() => {
    if (running) {
      addLog("🤖 Bot started — scanning 15-min BTC candles...", "info");
      intervalRef.current = setInterval(async () => {
        const result = await fetchCandles();
        if (result) executeTrade(result.sig, result.latest);
      }, 30000); // refresh every 30s
    } else {
      clearInterval(intervalRef.current);
      if (trades.length > 0) addLog("⏸ Bot paused.", "info");
    }
    return () => clearInterval(intervalRef.current);
  }, [running, fetchCandles, executeTrade, addLog]);

  const portfolioValue = balance + (btcHeld * (price || 0));
  const totalReturn = ((portfolioValue - 500) / 500 * 100).toFixed(2);
  const unrealizedPnl = entryPrice && price ? (btcHeld * (price - entryPrice)).toFixed(2) : null;

  const sigColor = signal.signal === "BUY" ? "#00ff87" : signal.signal === "SELL" ? "#ff4466" : "#888";

  return (
    <div style={{ minHeight: "100vh", background: "#04060a", color: "#e0e0e0", fontFamily: "'Courier New', monospace", padding: "16px", maxWidth: "480px", margin: "0 auto" }}>
      {/* Header */}
      <div style={{ textAlign: "center", marginBottom: "24px" }}>
        <div style={{ fontSize: "11px", letterSpacing: "6px", color: "#555", marginBottom: "4px" }}>AUTONOMOUS</div>
        <h1 style={{ fontSize: "32px", fontWeight: "900", letterSpacing: "4px", margin: 0, background: "linear-gradient(135deg, #f7931a, #ffcd3c)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
          BTC BOT
        </h1>
        <div style={{ fontSize: "10px", letterSpacing: "4px", color: "#555", marginTop: "4px" }}>15-MINUTE SCALPER • PAPER TRADING</div>
      </div>

      {/* Price */}
      <div style={{ background: "#0d1117", border: "1px solid #1a2030", borderRadius: "12px", padding: "16px", marginBottom: "12px", textAlign: "center" }}>
        {loading ? (
          <div style={{ color: "#555", fontSize: "14px" }}>Loading Bitcoin price...</div>
        ) : error ? (
          <div style={{ color: "#ff4466", fontSize: "13px" }}>{error}</div>
        ) : (
          <>
            <div style={{ fontSize: "36px", fontWeight: "900", color: "#f7931a", letterSpacing: "2px" }}>
              ${price?.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
            <div style={{ fontSize: "11px", color: "#444", marginTop: "4px" }}>BTC/USD • Updated {lastUpdate}</div>
          </>
        )}
      </div>

      {/* Signal */}
      <div style={{ background: "#0d1117", border: `1px solid ${sigColor}33`, borderRadius: "12px", padding: "16px", marginBottom: "12px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
          <span style={{ fontSize: "11px", letterSpacing: "3px", color: "#555" }}>AI SIGNAL</span>
          <span style={{ fontSize: "22px", fontWeight: "900", color: sigColor, letterSpacing: "3px" }}>
            {signal.signal}
            {signal.signal !== "WAIT" && <span style={{ fontSize: "13px", marginLeft: "8px", color: "#888" }}>{signal.confidence}% conf.</span>}
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          {signal.reasons.slice(0, 4).map((r, i) => (
            <div key={i} style={{ fontSize: "11px", color: r.type === "buy" ? "#00ff87aa" : r.type === "sell" ? "#ff4466aa" : "#666", paddingLeft: "8px", borderLeft: `2px solid ${r.type === "buy" ? "#00ff8744" : r.type === "sell" ? "#ff446644" : "#333"}` }}>
              {r.text}
            </div>
          ))}
          {signal.reasons.length === 0 && <div style={{ fontSize: "11px", color: "#444" }}>Waiting for clear setup...</div>}
        </div>
      </div>

      {/* Portfolio */}
      <div style={{ background: "#0d1117", border: "1px solid #1a2030", borderRadius: "12px", padding: "16px", marginBottom: "12px" }}>
        <div style={{ fontSize: "11px", letterSpacing: "3px", color: "#555", marginBottom: "12px" }}>PORTFOLIO</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
          <div>
            <div style={{ fontSize: "10px", color: "#444", marginBottom: "4px" }}>TOTAL VALUE</div>
            <div style={{ fontSize: "22px", fontWeight: "700", color: portfolioValue >= 500 ? "#00ff87" : "#ff4466" }}>
              ${portfolioValue.toFixed(2)}
            </div>
          </div>
          <div>
            <div style={{ fontSize: "10px", color: "#444", marginBottom: "4px" }}>TOTAL RETURN</div>
            <div style={{ fontSize: "22px", fontWeight: "700", color: parseFloat(totalReturn) >= 0 ? "#00ff87" : "#ff4466" }}>
              {totalReturn >= 0 ? "+" : ""}{totalReturn}%
            </div>
          </div>
          <div>
            <div style={{ fontSize: "10px", color: "#444", marginBottom: "4px" }}>CASH</div>
            <div style={{ fontSize: "16px", fontWeight: "600", color: "#e0e0e0" }}>${balance.toFixed(2)}</div>
          </div>
          <div>
            <div style={{ fontSize: "10px", color: "#444", marginBottom: "4px" }}>BTC HELD</div>
            <div style={{ fontSize: "16px", fontWeight: "600", color: "#f7931a" }}>{btcHeld.toFixed(6)}</div>
          </div>
          {unrealizedPnl && (
            <div style={{ gridColumn: "1/-1" }}>
              <div style={{ fontSize: "10px", color: "#444", marginBottom: "4px" }}>UNREALIZED P&L</div>
              <div style={{ fontSize: "16px", fontWeight: "600", color: parseFloat(unrealizedPnl) >= 0 ? "#00ff87" : "#ff4466" }}>
                {parseFloat(unrealizedPnl) >= 0 ? "+" : ""}${unrealizedPnl}
              </div>
            </div>
          )}
        </div>
        <div style={{ marginTop: "12px", display: "flex", justifyContent: "space-between", fontSize: "11px", color: "#444" }}>
          <span>Realized P&L: <span style={{ color: totalPnl >= 0 ? "#00ff87" : "#ff4466" }}>{totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}</span></span>
          <span>Trades: {trades.length}</span>
        </div>
      </div>

      {/* Start/Stop */}
      <button
        onClick={() => setRunning(r => !r)}
        style={{
          width: "100%", padding: "18px", border: "none", borderRadius: "12px", fontSize: "16px", fontWeight: "900", letterSpacing: "4px", cursor: "pointer", marginBottom: "12px",
          background: running ? "#ff446620" : "#00ff87",
          color: running ? "#ff4466" : "#04060a",
          border: running ? "1px solid #ff4466" : "none",
          transition: "all 0.2s"
        }}
      >
        {running ? "⏸ STOP BOT" : "▶ START BOT"}
      </button>

      {/* Trade History */}
      {trades.length > 0 && (
        <div style={{ background: "#0d1117", border: "1px solid #1a2030", borderRadius: "12px", padding: "16px", marginBottom: "12px" }}>
          <div style={{ fontSize: "11px", letterSpacing: "3px", color: "#555", marginBottom: "12px" }}>TRADE HISTORY</div>
          {trades.slice(0, 5).map((t, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid #0f1620", fontSize: "12px" }}>
              <div>
                <span style={{ color: t.type === "BUY" ? "#00ff87" : "#ff4466", fontWeight: "700", marginRight: "8px" }}>{t.type}</span>
                <span style={{ color: "#555" }}>{t.time}</span>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ color: "#e0e0e0" }}>${t.price.toLocaleString()}</div>
                {t.pnl !== null && (
                  <div style={{ color: t.pnl >= 0 ? "#00ff87" : "#ff4466", fontSize: "11px" }}>
                    {t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(2)}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Logs */}
      <div style={{ background: "#0d1117", border: "1px solid #1a2030", borderRadius: "12px", padding: "16px" }}>
        <div style={{ fontSize: "11px", letterSpacing: "3px", color: "#555", marginBottom: "12px" }}>BOT LOG</div>
        <div style={{ maxHeight: "160px", overflowY: "auto" }}>
          {logs.length === 0 ? (
            <div style={{ color: "#333", fontSize: "12px" }}>Press START BOT to begin trading...</div>
          ) : logs.map((l, i) => (
            <div key={i} style={{ fontSize: "11px", color: l.type === "buy" ? "#00ff87" : l.type === "sell" ? "#ff4466" : "#555", marginBottom: "4px" }}>
              <span style={{ color: "#333", marginRight: "6px" }}>{l.time}</span>{l.msg}
            </div>
          ))}
        </div>
      </div>

      <div style={{ textAlign: "center", marginTop: "16px", fontSize: "10px", color: "#333", letterSpacing: "2px" }}>
        PAPER TRADING ONLY • NO REAL MONEY AT RISK
      </div>
    </div>
  );
}


// ── Public market data (no auth needed, CORS enabled) ──
const KRAKEN_BASE = "https://api.kraken.com/0/public";

// ── Technical Indicators ──
function calcEMA(data, period) {
  const k = 2 / (period + 1);
  let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const result = new Array(period - 1).fill(null);
  result.push(ema);
  for (let i = period; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

function calcRSI(data, period = 14) {
  const result = new Array(period).fill(null);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = data[i] - data[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < data.length; i++) {
    const diff = data[i] - data[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
    result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return result;
}

function calcMACD(closes) {
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macd = ema12.map((v, i) => (v && ema26[i] ? v - ema26[i] : null));
  const validMacd = macd.filter(Boolean);
  const signal = calcEMA(validMacd, 9);
  const fullSignal = new Array(macd.length - signal.length).fill(null).concat(signal);
  return { macd, signal: fullSignal };
}

function calcBollingerBands(closes, period = 20, stdDev = 2) {
  const result = { upper: [], middle: [], lower: [] };
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { result.upper.push(null); result.middle.push(null); result.lower.push(null); continue; }
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
    const sd = Math.sqrt(variance);
    result.upper.push(mean + stdDev * sd);
    result.middle.push(mean);
    result.lower.push(mean - stdDev * sd);
  }
  return result;
}

// ── Signal Engine ──
function generateSignal(closes, volumes) {
  if (closes.length < 30) return { signal: "WAIT", confidence: 0, reasons: [] };
  const rsi = calcRSI(closes);
  const ema9 = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const { macd, signal: macdSignal } = calcMACD(closes);
  const bb = calcBollingerBands(closes);
  const n = closes.length - 1;
  const curRSI = rsi[n], prevRSI = rsi[n - 1];
  const curEMA9 = ema9[n], prevEMA9 = ema9[n - 1];
  const curEMA21 = ema21[n], prevEMA21 = ema21[n - 1];
  const curMACD = macd[n], curSignal = macdSignal[n];
  const prevMACD = macd[n - 1], prevSignalLine = macdSignal[n - 1];
  const price = closes[n];
  const bbLower = bb.lower[n], bbUpper = bb.upper[n];
  const avgVol = volumes.slice(-10).reduce((a, b) => a + b, 0) / 10;
  const volSpike = volumes[n] > avgVol * 1.3;

  let buyScore = 0, sellScore = 0;
  const reasons = [];

  // RSI signals
  if (curRSI < 30) { buyScore += 3; reasons.push({ type: "buy", text: `RSI oversold (${curRSI.toFixed(1)})` }); }
  else if (curRSI < 40 && prevRSI < curRSI) { buyScore += 2; reasons.push({ type: "buy", text: `RSI rising from low (${curRSI.toFixed(1)})` }); }
  if (curRSI > 70) { sellScore += 3; reasons.push({ type: "sell", text: `RSI overbought (${curRSI.toFixed(1)})` }); }
  else if (curRSI > 60 && prevRSI > curRSI) { sellScore += 2; reasons.push({ type: "sell", text: `RSI falling from high (${curRSI.toFixed(1)})` }); }

  // EMA crossover
  if (prevEMA9 < prevEMA21 && curEMA9 > curEMA21) { buyScore += 3; reasons.push({ type: "buy", text: "EMA9 crossed above EMA21 🚀" }); }
  if (prevEMA9 > prevEMA21 && curEMA9 < curEMA21) { sellScore += 3; reasons.push({ type: "sell", text: "EMA9 crossed below EMA21 ⬇️" }); }
  if (curEMA9 > curEMA21) { buyScore += 1; reasons.push({ type: "buy", text: "Uptrend (EMA9 > EMA21)" }); }
  else { sellScore += 1; reasons.push({ type: "sell", text: "Downtrend (EMA9 < EMA21)" }); }

  // MACD
  if (curMACD && curSignal && prevMACD && prevSignalLine) {
    if (prevMACD < prevSignalLine && curMACD > curSignal) { buyScore += 3; reasons.push({ type: "buy", text: "MACD bullish crossover ✨" }); }
    if (prevMACD > prevSignalLine && curMACD < curSignal) { sellScore += 3; reasons.push({ type: "sell", text: "MACD bearish crossover ⚠️" }); }
    if (curMACD > 0 && curMACD > curSignal) { buyScore += 1; reasons.push({ type: "buy", text: "MACD positive momentum" }); }
  }

  // Bollinger Bands
  if (bbLower && price < bbLower) { buyScore += 2; reasons.push({ type: "buy", text: "Price below BB lower band" }); }
  if (bbUpper && price > bbUpper) { sellScore += 2; reasons.push({ type: "sell", text: "Price above BB upper band" }); }

  // Volume
  if (volSpike && buyScore > sellScore) { buyScore += 1; reasons.push({ type: "buy", text: "High volume confirms move" }); }

  const total = buyScore + sellScore;
  if (total === 0) return { signal: "WAIT", confidence: 0, reasons };

  if (buyScore > sellScore && buyScore >= 5) {
    return { signal: "BUY", confidence: Math.min(Math.round((buyScore / (buyScore + sellScore)) * 100), 99), reasons };
  }
  if (sellScore > buyScore && sellScore >= 5) {
    return { signal: "SELL", confidence: Math.min(Math.round((sellScore / (buyScore + sellScore)) * 100), 99), reasons };
  }
  return { signal: "WAIT", confidence: 0, reasons };
}

// ── Main App ──
export default function CryptoBot() {
  const [candles, setCandles] = useState([]);
  const [price, setPrice] = useState(null);
  const [signal, setSignal] = useState({ signal: "WAIT", confidence: 0, reasons: [] });
  const [balance, setBalance] = useState(500);
  const [btcHeld, setBtcHeld] = useState(0);
  const [trades, setTrades] = useState([]);
  const [logs, setLogs] = useState([]);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [entryPrice, setEntryPrice] = useState(null);
  const [totalPnl, setTotalPnl] = useState(0);
  const [lastUpdate, setLastUpdate] = useState(null);
  const intervalRef = useRef(null);
  const tradeRef = useRef({ balance: 500, btcHeld: 0, entryPrice: null });

  const addLog = useCallback((msg, type = "info") => {
    const time = new Date().toLocaleTimeString();
    setLogs(prev => [{ msg, type, time }, ...prev].slice(0, 50));
  }, []);

  const fetchCandles = useCallback(async () => {
    try {
      const res = await fetch(`${KRAKEN_BASE}/OHLC?pair=XBTUSD&interval=15`);
      const data = await res.json();
      if (data.error && data.error.length > 0) throw new Error(data.error[0]);
      const raw = data.result.XXBTZUSD || data.result[Object.keys(data.result)[0]];
      const parsed = raw.slice(-60).map(c => ({
        time: c[0], open: parseFloat(c[1]), high: parseFloat(c[2]),
        low: parseFloat(c[3]), close: parseFloat(c[4]), volume: parseFloat(c[6])
      }));
      setCandles(parsed);
      const latest = parsed[parsed.length - 1].close;
      setPrice(latest);
      setLastUpdate(new Date().toLocaleTimeString());
      setError(null);
      setLoading(false);
      const closes = parsed.map(c => c.close);
      const volumes = parsed.map(c => c.volume);
      const sig = generateSignal(closes, volumes);
      setSignal(sig);
      return { closes, volumes, latest, sig };
    } catch (e) {
      setError("Could not fetch Bitcoin price. Check your internet connection.");
      setLoading(false);
      return null;
    }
  }, []);

  const executeTrade = useCallback((sig, currentPrice) => {
    const { balance: bal, btcHeld: held, entryPrice: entry } = tradeRef.current;
    const fee = 0.001; // 0.1% fee

    // Stop loss / take profit check
    if (held > 0 && entry) {
      const pnlPct = (currentPrice - entry) / entry;
      if (pnlPct <= -0.008) {
        // Stop loss at -0.8%
        const proceeds = held * currentPrice * (1 - fee);
        const pnl = proceeds - (held * entry);
        tradeRef.current.balance = bal + proceeds;
        tradeRef.current.btcHeld = 0;
        tradeRef.current.entryPrice = null;
        setBalance(tradeRef.current.balance);
        setBtcHeld(0);
        setEntryPrice(null);
        setTotalPnl(prev => prev + pnl);
        const trade = { type: "SELL", price: currentPrice, amount: held, pnl, time: new Date().toLocaleTimeString(), reason: "🛑 Stop Loss" };
        setTrades(prev => [trade, ...prev].slice(0, 20));
        addLog(`🛑 STOP LOSS at $${currentPrice.toLocaleString()} | P&L: $${pnl.toFixed(2)}`, "sell");
        return;
      }
      if (pnlPct >= 0.015) {
        // Take profit at +1.5%
        const proceeds = held * currentPrice * (1 - fee);
        const pnl = proceeds - (held * entry);
        tradeRef.current.balance = bal + proceeds;
        tradeRef.current.btcHeld = 0;
        tradeRef.current.entryPrice = null;
        setBalance(tradeRef.current.balance);
        setBtcHeld(0);
        setEntryPrice(null);
        setTotalPnl(prev => prev + pnl);
        const trade = { type: "SELL", price: currentPrice, amount: held, pnl, time: new Date().toLocaleTimeString(), reason: "🎯 Take Profit" };
        setTrades(prev => [trade, ...prev].slice(0, 20));
        addLog(`🎯 TAKE PROFIT at $${currentPrice.toLocaleString()} | P&L: +$${pnl.toFixed(2)}`, "buy");
        return;
      }
    }

    if (sig.signal === "BUY" && held === 0 && bal > 10) {
      const risk = bal * 0.95; // use 95% of balance
      const btcAmount = (risk * (1 - fee)) / currentPrice;
      tradeRef.current.balance = bal - risk;
      tradeRef.current.btcHeld = btcAmount;
      tradeRef.current.entryPrice = currentPrice;
      setBalance(tradeRef.current.balance);
      setBtcHeld(btcAmount);
      setEntryPrice(currentPrice);
      const trade = { type: "BUY", price: currentPrice, amount: btcAmount, pnl: null, time: new Date().toLocaleTimeString(), reason: `${sig.confidence}% confidence` };
      setTrades(prev => [trade, ...prev].slice(0, 20));
      addLog(`🟢 BUY ${btcAmount.toFixed(6)} BTC @ $${currentPrice.toLocaleString()} | Confidence: ${sig.confidence}%`, "buy");
    } else if (sig.signal === "SELL" && held > 0) {
      const proceeds = held * currentPrice * (1 - fee);
      const pnl = proceeds - (held * entry);
      tradeRef.current.balance = bal + proceeds;
      tradeRef.current.btcHeld = 0;
      tradeRef.current.entryPrice = null;
      setBalance(tradeRef.current.balance);
      setBtcHeld(0);
      setEntryPrice(null);
      setTotalPnl(prev => prev + pnl);
      const trade = { type: "SELL", price: currentPrice, amount: held, pnl, time: new Date().toLocaleTimeString(), reason: `Signal sell` };
      setTrades(prev => [trade, ...prev].slice(0, 20));
      addLog(`🔴 SELL @ $${currentPrice.toLocaleString()} | P&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`, pnl >= 0 ? "buy" : "sell");
    }
  }, [addLog]);

  useEffect(() => { fetchCandles(); }, [fetchCandles]);

  useEffect(() => {
    if (running) {
      addLog("🤖 Bot started — scanning 15-min BTC candles...", "info");
      intervalRef.current = setInterval(async () => {
        const result = await fetchCandles();
        if (result) executeTrade(result.sig, result.latest);
      }, 30000); // refresh every 30s
    } else {
      clearInterval(intervalRef.current);
      if (trades.length > 0) addLog("⏸ Bot paused.", "info");
    }
    return () => clearInterval(intervalRef.current);
  }, [running, fetchCandles, executeTrade, addLog]);

  const portfolioValue = balance + (btcHeld * (price || 0));
  const totalReturn = ((portfolioValue - 500) / 500 * 100).toFixed(2);
  const unrealizedPnl = entryPrice && price ? (btcHeld * (price - entryPrice)).toFixed(2) : null;

  const sigColor = signal.signal === "BUY" ? "#00ff87" : signal.signal === "SELL" ? "#ff4466" : "#888";

  return (
    <div style={{ minHeight: "100vh", background: "#04060a", color: "#e0e0e0", fontFamily: "'Courier New', monospace", padding: "16px", maxWidth: "480px", margin: "0 auto" }}>
      {/* Header */}
      <div style={{ textAlign: "center", marginBottom: "24px" }}>
        <div style={{ fontSize: "11px", letterSpacing: "6px", color: "#555", marginBottom: "4px" }}>AUTONOMOUS</div>
        <h1 style={{ fontSize: "32px", fontWeight: "900", letterSpacing: "4px", margin: 0, background: "linear-gradient(135deg, #f7931a, #ffcd3c)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
          BTC BOT
        </h1>
        <div style={{ fontSize: "10px", letterSpacing: "4px", color: "#555", marginTop: "4px" }}>15-MINUTE SCALPER • PAPER TRADING</div>
      </div>

      {/* Price */}
      <div style={{ background: "#0d1117", border: "1px solid #1a2030", borderRadius: "12px", padding: "16px", marginBottom: "12px", textAlign: "center" }}>
        {loading ? (
          <div style={{ color: "#555", fontSize: "14px" }}>Loading Bitcoin price...</div>
        ) : error ? (
          <div style={{ color: "#ff4466", fontSize: "13px" }}>{error}</div>
        ) : (
          <>
            <div style={{ fontSize: "36px", fontWeight: "900", color: "#f7931a", letterSpacing: "2px" }}>
              ${price?.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
            <div style={{ fontSize: "11px", color: "#444", marginTop: "4px" }}>BTC/USD • Updated {lastUpdate}</div>
          </>
        )}
      </div>

      {/* Signal */}
      <div style={{ background: "#0d1117", border: `1px solid ${sigColor}33`, borderRadius: "12px", padding: "16px", marginBottom: "12px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
          <span style={{ fontSize: "11px", letterSpacing: "3px", color: "#555" }}>AI SIGNAL</span>
          <span style={{ fontSize: "22px", fontWeight: "900", color: sigColor, letterSpacing: "3px" }}>
            {signal.signal}
            {signal.signal !== "WAIT" && <span style={{ fontSize: "13px", marginLeft: "8px", color: "#888" }}>{signal.confidence}% conf.</span>}
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          {signal.reasons.slice(0, 4).map((r, i) => (
            <div key={i} style={{ fontSize: "11px", color: r.type === "buy" ? "#00ff87aa" : r.type === "sell" ? "#ff4466aa" : "#666", paddingLeft: "8px", borderLeft: `2px solid ${r.type === "buy" ? "#00ff8744" : r.type === "sell" ? "#ff446644" : "#333"}` }}>
              {r.text}
            </div>
          ))}
          {signal.reasons.length === 0 && <div style={{ fontSize: "11px", color: "#444" }}>Waiting for clear setup...</div>}
        </div>
      </div>

      {/* Portfolio */}
      <div style={{ background: "#0d1117", border: "1px solid #1a2030", borderRadius: "12px", padding: "16px", marginBottom: "12px" }}>
        <div style={{ fontSize: "11px", letterSpacing: "3px", color: "#555", marginBottom: "12px" }}>PORTFOLIO</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
          <div>
            <div style={{ fontSize: "10px", color: "#444", marginBottom: "4px" }}>TOTAL VALUE</div>
            <div style={{ fontSize: "22px", fontWeight: "700", color: portfolioValue >= 500 ? "#00ff87" : "#ff4466" }}>
              ${portfolioValue.toFixed(2)}
            </div>
          </div>
          <div>
            <div style={{ fontSize: "10px", color: "#444", marginBottom: "4px" }}>TOTAL RETURN</div>
            <div style={{ fontSize: "22px", fontWeight: "700", color: parseFloat(totalReturn) >= 0 ? "#00ff87" : "#ff4466" }}>
              {totalReturn >= 0 ? "+" : ""}{totalReturn}%
            </div>
          </div>
          <div>
            <div style={{ fontSize: "10px", color: "#444", marginBottom: "4px" }}>CASH</div>
            <div style={{ fontSize: "16px", fontWeight: "600", color: "#e0e0e0" }}>${balance.toFixed(2)}</div>
          </div>
          <div>
            <div style={{ fontSize: "10px", color: "#444", marginBottom: "4px" }}>BTC HELD</div>
            <div style={{ fontSize: "16px", fontWeight: "600", color: "#f7931a" }}>{btcHeld.toFixed(6)}</div>
          </div>
          {unrealizedPnl && (
            <div style={{ gridColumn: "1/-1" }}>
              <div style={{ fontSize: "10px", color: "#444", marginBottom: "4px" }}>UNREALIZED P&L</div>
              <div style={{ fontSize: "16px", fontWeight: "600", color: parseFloat(unrealizedPnl) >= 0 ? "#00ff87" : "#ff4466" }}>
                {parseFloat(unrealizedPnl) >= 0 ? "+" : ""}${unrealizedPnl}
              </div>
            </div>
          )}
        </div>
        <div style={{ marginTop: "12px", display: "flex", justifyContent: "space-between", fontSize: "11px", color: "#444" }}>
          <span>Realized P&L: <span style={{ color: totalPnl >= 0 ? "#00ff87" : "#ff4466" }}>{totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}</span></span>
          <span>Trades: {trades.length}</span>
        </div>
      </div>

      {/* Start/Stop */}
      <button
        onClick={() => setRunning(r => !r)}
        style={{
          width: "100%", padding: "18px", border: "none", borderRadius: "12px", fontSize: "16px", fontWeight: "900", letterSpacing: "4px", cursor: "pointer", marginBottom: "12px",
          background: running ? "#ff446620" : "#00ff87",
          color: running ? "#ff4466" : "#04060a",
          border: running ? "1px solid #ff4466" : "none",
          transition: "all 0.2s"
        }}
      >
        {running ? "⏸ STOP BOT" : "▶ START BOT"}
      </button>

      {/* Trade History */}
      {trades.length > 0 && (
        <div style={{ background: "#0d1117", border: "1px solid #1a2030", borderRadius: "12px", padding: "16px", marginBottom: "12px" }}>
          <div style={{ fontSize: "11px", letterSpacing: "3px", color: "#555", marginBottom: "12px" }}>TRADE HISTORY</div>
          {trades.slice(0, 5).map((t, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid #0f1620", fontSize: "12px" }}>
              <div>
                <span style={{ color: t.type === "BUY" ? "#00ff87" : "#ff4466", fontWeight: "700", marginRight: "8px" }}>{t.type}</span>
                <span style={{ color: "#555" }}>{t.time}</span>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ color: "#e0e0e0" }}>${t.price.toLocaleString()}</div>
                {t.pnl !== null && (
                  <div style={{ color: t.pnl >= 0 ? "#00ff87" : "#ff4466", fontSize: "11px" }}>
                    {t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(2)}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Logs */}
      <div style={{ background: "#0d1117", border: "1px solid #1a2030", borderRadius: "12px", padding: "16px" }}>
        <div style={{ fontSize: "11px", letterSpacing: "3px", color: "#555", marginBottom: "12px" }}>BOT LOG</div>
        <div style={{ maxHeight: "160px", overflowY: "auto" }}>
          {logs.length === 0 ? (
            <div style={{ color: "#333", fontSize: "12px" }}>Press START BOT to begin trading...</div>
          ) : logs.map((l, i) => (
            <div key={i} style={{ fontSize: "11px", color: l.type === "buy" ? "#00ff87" : l.type === "sell" ? "#ff4466" : "#555", marginBottom: "4px" }}>
              <span style={{ color: "#333", marginRight: "6px" }}>{l.time}</span>{l.msg}
            </div>
          ))}
        </div>
      </div>

      <div style={{ textAlign: "center", marginTop: "16px", fontSize: "10px", color: "#333", letterSpacing: "2px" }}>
        PAPER TRADING ONLY • NO REAL MONEY AT RISK
      </div>
    </div>
  );
}
