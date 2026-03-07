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
Current YES price: ${market.yes_ask}¢
Current NO price: ${market.no_ask}¢
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
  const [marketFilter​​​​​​​​​​​​​​​​
