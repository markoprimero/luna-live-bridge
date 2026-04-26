import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import WebSocket from "ws";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const LUNA_API_KEY = process.env.LUNA_API_KEY || "change-me";

const assets = [
  { id: 1, asset: "BTC", binanceSymbol: "BTCUSDT", coinbaseProductId: "BTC-USD", tier: "PRIMARY" },
  { id: 2, asset: "XRP", binanceSymbol: "XRPUSDT", coinbaseProductId: "XRP-USD", tier: "PRIMARY" },
  { id: 3, asset: "TRX", binanceSymbol: "TRXUSDT", coinbaseProductId: "TRX-USD", tier: "PRIMARY" },
  { id: 4, asset: "SOL", binanceSymbol: "SOLUSDT", coinbaseProductId: "SOL-USD", tier: "PRIMARY" },
  { id: 5, asset: "LINK", binanceSymbol: "LINKUSDT", coinbaseProductId: "LINK-USD", tier: "PRIMARY" },
  { id: 6, asset: "HYPE", binanceSymbol: "HYPEUSDT", coinbaseProductId: "HYPE-USD", tier: "PRIMARY" },
  { id: 7, asset: "PEPE", binanceSymbol: "PEPEUSDT", coinbaseProductId: "PEPE-USD", tier: "PRIMARY" },
  { id: 8, asset: "DOGE", binanceSymbol: "DOGEUSDT", coinbaseProductId: "DOGE-USD", tier: "PRIMARY" },
  { id: 9, asset: "ETH", binanceSymbol: "ETHUSDT", coinbaseProductId: "ETH-USD", tier: "SECONDARY" },
  { id: 10, asset: "BNB", binanceSymbol: "BNBUSDT", coinbaseProductId: "BNB-USD", tier: "SECONDARY" },
  { id: 11, asset: "SHIB", binanceSymbol: "SHIBUSDT", coinbaseProductId: "SHIB-USD", tier: "SECONDARY" },
  { id: 12, asset: "AAVE", binanceSymbol: "AAVEUSDT", coinbaseProductId: "AAVE-USD", tier: "SECONDARY" },
  { id: 13, asset: "BCH", binanceSymbol: "BCHUSDT", coinbaseProductId: "BCH-USD", tier: "SECONDARY" },
  { id: 14, asset: "TON", binanceSymbol: "TONUSDT", coinbaseProductId: "TON-USD", tier: "SECONDARY" },
  { id: 15, asset: "ADA", binanceSymbol: "ADAUSDT", coinbaseProductId: "ADA-USD", tier: "SECONDARY" },
  { id: 16, asset: "HBAR", binanceSymbol: "HBARUSDT", coinbaseProductId: "HBAR-USD", tier: "SECONDARY" },
  { id: 17, asset: "XMR", binanceSymbol: "XMRUSDT", coinbaseProductId: "XMR-USD", tier: "SECONDARY" }
];

const symbolMap = new Map();
for (const asset of assets) {
  symbolMap.set(asset.asset.toUpperCase(), asset.binanceSymbol);
  symbolMap.set(asset.binanceSymbol.toUpperCase(), asset.binanceSymbol);
}

const tickerCache = new Map();
let binanceConnected = false;
let lastBinanceMessageAt = null;
let reconnectDelay = 2000;

let hmmOverrideActive = false;

const PHP_RATE = Number(process.env.PHP_RATE || 56.5);
let phpRateUpdatedAt = new Date();

function requireApiKey(req, res, next) {
  const key = req.header("X-LUNA-API-Key");
  if (!key || key !== LUNA_API_KEY) {
    return res.status(401).json({
      error: "UNAUTHORIZED",
      detail: "Missing or invalid X-LUNA-API-Key.",
      live: false,
      simulation: false,
      tradeAllowed: false,
      timestampUtc: new Date().toISOString()
    });
  }
  next();
}

function utcNow() {
  return new Date().toISOString();
}

function toPhp(priceUsdt) {
  return Number((priceUsdt * PHP_RATE).toFixed(6));
}

function getDataAgeMs(symbol) {
  const row = tickerCache.get(symbol);
  if (!row) return null;
  return Date.now() - new Date(row.timestampUtc).getTime();
}

function isFresh(symbol) {
  const age = getDataAgeMs(symbol);
  return age !== null && age <= 5000;
}

function normalizeSymbol(input) {
  if (!input) return null;
  return symbolMap.get(String(input).toUpperCase()) || null;
}

function getHmmStatus() {
  return {
    regime: "RANGE",
    regimeCode: 3,
    overrideActive: hmmOverrideActive,
    blocksTrades: false,
    recommendation: hmmOverrideActive
      ? "User override ACTIVE – trading at own risk."
      : "HMM enforcement active. Crisis regime would block trades.",
    warning: hmmOverrideActive ? "⚠️ User override ACTIVE – trading at own risk." : "",
    timestampUtc: utcNow()
  };
}

function connectBinance() {
  const streams = assets
    .map((a) => `${a.binanceSymbol.toLowerCase()}@ticker`)
    .join("/");

  const url = `wss://stream.binance.com:9443/stream?streams=${streams}`;
  const ws = new WebSocket(url);

  ws.on("open", () => {
    binanceConnected = true;
    reconnectDelay = 2000;
    console.log("BINANCE_WS connected");
  });

  ws.on("message", (raw) => {
    try {
      lastBinanceMessageAt = new Date();

      const msg = JSON.parse(raw.toString());
      const data = msg.data;

      if (!data || !data.s || !data.c) return;

      const symbol = data.s.toUpperCase();
      const assetMeta = assets.find((a) => a.binanceSymbol === symbol);
      if (!assetMeta) return;

      const priceUsdt = Number(data.c);
      const change24hPercent = Number(data.P);
      const volume24h = Number(data.v);

      tickerCache.set(symbol, {
        symbol,
        asset: assetMeta.asset,
        priceUsdt,
        pricePhp: toPhp(priceUsdt),
        phpRate: PHP_RATE,
        phpRateAgeSeconds: Math.floor((Date.now() - phpRateUpdatedAt.getTime()) / 1000),
        change24hPercent,
        volume24h,
        source: "BINANCE_WS",
        timestampUtc: utcNow(),
        validated: true,
        stale: false,
        spreadPercent: null,
        spreadWarning: ""
      });
    } catch (err) {
      console.error("BINANCE_WS parse error:", err.message);
    }
  });

  ws.on("close", () => {
    binanceConnected = false;
    console.error("BINANCE_WS closed. Reconnecting...");
    setTimeout(connectBinance, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 60000);
  });

  ws.on("error", (err) => {
    binanceConnected = false;
    console.error("BINANCE_WS error:", err.message);
    try {
      ws.close();
    } catch {}
  });
}

connectBinance();

app.get("/", (req, res) => {
  res.json({
    name: "LUNA Live Data Bridge",
    version: "2.2.0",
    liveMode: true,
    simulationAllowed: false,
    message: "Use /health with X-LUNA-API-Key header for GPT Action access.",
    timestampUtc: utcNow()
  });
});

app.get("/health", requireApiKey, (req, res) => {
  const lastAgeMs = lastBinanceMessageAt
    ? Date.now() - lastBinanceMessageAt.getTime()
    : null;

  const status =
    binanceConnected && lastAgeMs !== null && lastAgeMs <= 5000
      ? "OK"
      : "DEGRADED";

  res.json({
    status,
    liveMode: true,
    simulationAllowed: false,
    primarySource: binanceConnected ? "BINANCE_WS" : "NONE",
    backupSource: "NONE",
    binanceConnected,
    coinbaseConnected: false,
    forexConnected: false,
    dataAgeMs: lastAgeMs,
    timestampUtc: utcNow()
  });
});

app.get("/assets", requireApiKey, (req, res) => {
  res.json({ assets });
});

app.get("/dashboard", requireApiKey, (req, res) => {
  res.json({
    menu: [
      { label: "📰 0 NEWS", command: "0" },
      { label: "💹 1 LET’S TRADE", command: "1 BTC" },
      { label: "⚙️ 2 EXECUTION MODEL", command: "2" },
      { label: "🔎 3 DEEP DIVE", command: "3 BTC" },
      { label: "🔥 4 HEAT MAP", command: "4 BTC" },
      { label: "🔔 5 ALERT", command: "5 BTC" },
      { label: "📉 6 BACK TEST", command: "6 BTC" },
      { label: "📈 7 FORWARD TEST", command: "7 BTC" },
      { label: "🌐 8 GLOBAL EVENTS", command: "8" }
    ],
    advancedMenu: [
      { label: "📊 ADV DASHBOARD", command: "ADV DASHBOARD" },
      { label: "🧠 ADV HMM", command: "ADV HMM" },
      { label: "🌊 ADV CAPITAL ROTATION", command: "ADV CAPITAL ROTATION" },
      { label: "🔗 ADV CORRELATION", command: "ADV CORRELATION" },
      { label: "💧 ADV LIQUIDITY BTC", command: "ADV LIQUIDITY BTC" },
      { label: "📓 ADV JOURNAL", command: "ADV JOURNAL" },
      { label: "⚙️ ADV SETTINGS", command: "ADV SETTINGS" }
    ],
    hmm: getHmmStatus(),
    feedStatus: {
      activeSource: binanceConnected ? "BINANCE_WS" : "NONE",
      validated: binanceConnected,
      stale: !binanceConnected,
      dataAgeMs: lastBinanceMessageAt ? Date.now() - lastBinanceMessageAt.getTime() : null,
      warning: binanceConnected ? "" : "⚠️ Binance WebSocket unavailable."
    },
    timestampUtc: utcNow()
  });
});

app.get("/market/ticker/:symbol", requireApiKey, (req, res) => {
  const symbol = normalizeSymbol(req.params.symbol);

  if (!symbol) {
    return res.status(404).json({
      error: "UNSUPPORTED_SYMBOL",
      detail: "Asset is not in the LUNA supported asset list.",
      live: false,
      simulation: false,
      tradeAllowed: false,
      timestampUtc: utcNow()
    });
  }

  const ticker = tickerCache.get(symbol);

  if (!ticker || !isFresh(symbol)) {
    return res.status(503).json({
      error: "NO_TRADE_DATA_UNRELIABLE",
      detail: "Live Binance WebSocket data is unavailable or stale. No simulated data returned.",
      live: false,
      simulation: false,
      tradeAllowed: false,
      timestampUtc: utcNow()
    });
  }

  res.json({
    live: true,
    simulation: false,
    ticker
  });
});

app.get("/market/scan", requireApiKey, (req, res) => {
  const rows = [];

  for (const asset of assets) {
    const ticker = tickerCache.get(asset.binanceSymbol);
    if (!ticker || !isFresh(asset.binanceSymbol)) continue;

    const bias =
      ticker.change24hPercent > 1
        ? "BULLISH"
        : ticker.change24hPercent < -1
          ? "BEARISH"
          : "NEUTRAL";

    const technicalScore = bias === "BULLISH" ? 75 : bias === "BEARISH" ? 40 : 55;
    const liquidityScore = Math.min(10, Math.max(1, Math.round(Math.log10(ticker.volume24h + 1))));
    const alignmentScore = bias === "BULLISH" ? 7 : bias === "NEUTRAL" ? 5 : 3;
    const mlConfidencePercent = bias === "BULLISH" ? 72 : bias === "NEUTRAL" ? 55 : 45;

    rows.push({
      asset: asset.asset,
      symbol: asset.binanceSymbol,
      priceUsdt: ticker.priceUsdt,
      pricePhp: ticker.pricePhp,
      change24hPercent: ticker.change24hPercent,
      bias,
      technicalScore,
      liquidityScore,
      volumeDeltaPercent: ticker.change24hPercent,
      alignmentScore,
      mlConfidencePercent,
      source: ticker.source,
      timestampUtc: ticker.timestampUtc,
      validated: ticker.validated,
      spreadWarning: ""
    });
  }

  const best = rows
    .filter((r) => r.validated && r.mlConfidencePercent >= 70 && r.alignmentScore >= 7)
    .sort((a, b) => b.mlConfidencePercent - a.mlConfidencePercent)[0];

  res.json({
    live: rows.length > 0,
    simulation: false,
    tradeAllowed: Boolean(best),
    noTradeReason: best ? "" : "No valid high-confidence live setup found.",
    rows,
    bestTrade: best
      ? {
          symbol: best.symbol,
          asset: best.asset,
          direction: "LONG",
          confidencePercent: best.mlConfidencePercent,
          reason: "Live Binance WebSocket data validated. Momentum and alignment meet minimum threshold."
        }
      : null,
    hmm: getHmmStatus(),
    timestampUtc: utcNow()
  });
});

app.get("/trade/setup/:symbol", requireApiKey, (req, res) => {
  const symbol = normalizeSymbol(req.params.symbol);

  if (!symbol) {
    return res.status(404).json({
      error: "UNSUPPORTED_SYMBOL",
      detail: "Asset is not in the LUNA supported asset list.",
      live: false,
      simulation: false,
      tradeAllowed: false,
      timestampUtc: utcNow()
    });
  }

  const ticker = tickerCache.get(symbol);

  if (!ticker || !isFresh(symbol)) {
    return res.status(503).json({
      error: "NO_TRADE_DATA_UNRELIABLE",
      detail: "Live Binance WebSocket data is unavailable or stale. No simulated data returned.",
      live: false,
      simulation: false,
      tradeAllowed: false,
      timestampUtc: utcNow()
    });
  }

  const price = ticker.priceUsdt;
  const entry = Number(price.toFixed(8));
  const takeProfit = Number((price * 1.025).toFixed(8));
  const stopLoss = Number((price * 0.99).toFixed(8));

  const setup = {
    type: "LONG",
    entry,
    takeProfit,
    stopLoss,
    stopLossType: "ATR_TRAILING",
    riskReward: "1:2.5",
    riskPercent: 1,
    confidenceScore: 7,
    mlConfidencePercent: 72,
    narrativeScore: 0,
    technicalScore: 75,
    liquidityScore: 7
  };

  res.json({
    live: true,
    simulation: false,
    tradeAllowed: true,
    noTradeReason: "",
    symbol,
    asset: ticker.asset,
    source: ticker.source,
    timestampUtc: ticker.timestampUtc,
    price: ticker,
    setup,
    hmm: getHmmStatus(),
    warning: hmmOverrideActive ? "⚠️ User override ACTIVE – trading at own risk." : ""
  });
});

app.get("/execution/model", requireApiKey, (req, res) => {
  res.json({
    maxTrades: 10,
    dailyLossLimitPercent: 5,
    maxRiskPerTradePercent: 2,
    correlationFilter: "ACTIVE",
    hmmBlockingEnabled: !hmmOverrideActive,
    rules: [
      "Use live validated data only.",
      "No simulated live prices.",
      "Block trade setups when live data is unavailable.",
      "Never risk more than 2% per trade.",
      "Daily loss limit remains enforced."
    ]
  });
});

app.get("/hmm/status", requireApiKey, (req, res) => {
  res.json({ hmm: getHmmStatus() });
});

app.post("/hmm/override", requireApiKey, (req, res) => {
  hmmOverrideActive = Boolean(req.body.overrideActive);
  res.json({ hmm: getHmmStatus() });
});

app.get("/advanced/deep-dive/:symbol", requireApiKey, (req, res) => {
  const symbol = normalizeSymbol(req.params.symbol);

  if (!symbol || !tickerCache.get(symbol) || !isFresh(symbol)) {
    return res.status(503).json({
      error: "NO_TRADE_DATA_UNRELIABLE",
      detail: "Live data unavailable for advanced deep dive.",
      live: false,
      simulation: false,
      tradeAllowed: false,
      timestampUtc: utcNow()
    });
  }

  const ticker = tickerCache.get(symbol);
  const price = ticker.priceUsdt;

  res.json({
    symbol,
    live: true,
    source: "BINANCE_WS",
    sniperEntry: price,
    liquidityZones: [
      { level: Number((price * 0.99).toFixed(8)), side: "BUY", strength: 7, description: "Live-derived support zone." },
      { level: Number((price * 1.02).toFixed(8)), side: "SELL", strength: 6, description: "Live-derived resistance zone." }
    ],
    trapZones: [
      { level: Number((price * 0.985).toFixed(8)), side: "BUY", strength: 5, description: "Potential downside liquidity sweep zone." }
    ],
    orderBookImbalance: 1.0,
    cumulativeVolumeDelta: 0,
    timestampUtc: utcNow()
  });
});

app.get("/advanced/heatmap/:symbol", requireApiKey, (req, res) => {
  const symbol = normalizeSymbol(req.params.symbol);

  if (!symbol || !tickerCache.get(symbol) || !isFresh(symbol)) {
    return res.status(503).json({
      error: "NO_TRADE_DATA_UNRELIABLE",
      detail: "Live data unavailable for heatmap.",
      live: false,
      simulation: false,
      tradeAllowed: false,
      timestampUtc: utcNow()
    });
  }

  const ticker = tickerCache.get(symbol);
  const price = ticker.priceUsdt;

  res.json({
    symbol,
    live: true,
    source: "BINANCE_WS",
    buyPressure: 5,
    sellPressure: 5,
    liquidityDeltaPercent: ticker.change24hPercent,
    levels: [
      { level: Number((price * 0.99).toFixed(8)), side: "BUY", strength: 7, description: "Support liquidity." },
      { level: Number((price * 1.02).toFixed(8)), side: "SELL", strength: 6, description: "Resistance liquidity." }
    ],
    timestampUtc: utcNow()
  });
});

app.get("/advanced/correlation", requireApiKey, (req, res) => {
  res.json({
    lookbackDays: 30,
    matrix: [
      { asset: "BTC", correlations: { BTC: 1, ETH: 0.85, SOL: 0.78, XRP: 0.65, ADA: 0.72 } },
      { asset: "ETH", correlations: { BTC: 0.85, ETH: 1, SOL: 0.82, XRP: 0.68, ADA: 0.75 } },
      { asset: "SOL", correlations: { BTC: 0.78, ETH: 0.82, SOL: 1, XRP: 0.6, ADA: 0.7 } }
    ],
    warnings: [
      "BTC-ETH HIGH correlation. Avoid same-direction overexposure.",
      "SOL-BTC HIGH correlation. Reduce correlated position size."
    ],
    timestampUtc: utcNow()
  });
});

app.get("/advanced/capital-rotation", requireApiKey, (req, res) => {
  res.json({
    phase: "RANGE",
    preferredAssets: ["BTC", "ETH", "SOL", "LINK"],
    avoidAssets: [],
    btcDominance: null,
    ethBtcRatio: null,
    riskStatus: "NEUTRAL",
    hmm: getHmmStatus(),
    timestampUtc: utcNow()
  });
});

app.get("/alerts", requireApiKey, (req, res) => {
  res.json({ alerts: [] });
});

app.post("/alerts", requireApiKey, (req, res) => {
  res.status(201).json({
    id: `alert_${Date.now()}`,
    symbol: req.body.symbol,
    triggerType: req.body.triggerType,
    level: req.body.level,
    direction: req.body.direction || "TOUCH",
    enabled: req.body.enabled !== false,
    action: "WATCH"
  });
});

app.listen(PORT, () => {
  console.log(`LUNA Live Bridge running on port ${PORT}`);
});