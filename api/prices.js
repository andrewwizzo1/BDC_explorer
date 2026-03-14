// api/prices.js
// Vercel Serverless Function — fetches daily prices via Yahoo Finance
// Tries multiple endpoints for reliability
// Deploy: place at /api/prices.js in your Vercel project root
//
// Usage: /api/prices?tickers=ARCC,TCPC,OBDC,OTF,TSLX,GBDC,BXSL&months=12

export default async function handler(req, res) {
  const {
    tickers = "ARCC,TCPC,OBDC,OTF,TSLX,GBDC,BXSL",
    months = "12",
  } = req.query;

  const tickerList = tickers.split(",").map((t) => t.trim().toUpperCase());
  const now = Math.floor(Date.now() / 1000);
  const period1 = now - parseInt(months) * 30 * 24 * 60 * 60;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  const perTickerErrors = {};

  try {
    const results = {};

    await Promise.all(
      tickerList.map(async (ticker) => {
        const tryErrors = [];

        // Method 1: Yahoo v8 chart via query2
        try {
          const url = `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${period1}&period2=${now}&interval=1d`;
          const response = await fetch(url, {
            headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
          });
          if (!response.ok) throw new Error(`query2 v8: HTTP ${response.status}`);
          const data = await response.json();
          const chart = data?.chart?.result?.[0];
          if (!chart) throw new Error("query2 v8: no chart data");
          const timestamps = chart.timestamp || [];
          const closes = chart.indicators?.quote?.[0]?.close || [];
          const parsed = timestamps.map((ts, i) => closes[i] != null ? { ts, close: Math.round(closes[i] * 100) / 100 } : null).filter(Boolean);
          if (parsed.length > 0) { results[ticker] = parsed; return; }
          throw new Error("query2 v8: empty result");
        } catch (e) { tryErrors.push(e.message); }

        // Method 2: Yahoo v8 chart via query1
        try {
          const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${period1}&period2=${now}&interval=1d&includePrePost=false`;
          const response = await fetch(url, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
          });
          if (!response.ok) throw new Error(`query1 v8: HTTP ${response.status}`);
          const data = await response.json();
          const chart = data?.chart?.result?.[0];
          if (!chart) throw new Error("query1 v8: no chart data");
          const timestamps = chart.timestamp || [];
          const closes = chart.indicators?.quote?.[0]?.close || [];
          const parsed = timestamps.map((ts, i) => closes[i] != null ? { ts, close: Math.round(closes[i] * 100) / 100 } : null).filter(Boolean);
          if (parsed.length > 0) { results[ticker] = parsed; return; }
          throw new Error("query1 v8: empty result");
        } catch (e) { tryErrors.push(e.message); }

        // Method 3: Yahoo CSV download
        try {
          const url = `https://query1.finance.yahoo.com/v7/finance/download/${ticker}?period1=${period1}&period2=${now}&interval=1d&events=history`;
          const response = await fetch(url, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
              "Accept": "text/csv,*/*",
            },
          });
          if (!response.ok) throw new Error(`CSV download: HTTP ${response.status}`);
          const text = await response.text();
          const lines = text.trim().split("\n");
          const parsed = lines.slice(1).map((line) => {
            const parts = line.split(",");
            const close = parseFloat(parts[4]);
            if (isNaN(close)) return null;
            const d = new Date(parts[0]);
            return { ts: Math.floor(d.getTime() / 1000), close: Math.round(close * 100) / 100 };
          }).filter(Boolean);
          if (parsed.length > 0) { results[ticker] = parsed; return; }
          throw new Error("CSV: empty result");
        } catch (e) { tryErrors.push(e.message); }

        perTickerErrors[ticker] = tryErrors;
        results[ticker] = [];
      })
    );

    // Find a ticker with data
    const baseTicker = tickerList.find((t) => results[t]?.length > 0) || tickerList[0];
    const baseDates = results[baseTicker] || [];

    if (baseDates.length === 0) {
      return res.status(502).json({
        error: "Could not fetch price data from any Yahoo Finance endpoint.",
        details: perTickerErrors,
        hint: "Yahoo Finance may be rate-limiting or blocking this server IP. Try again in a few minutes.",
      });
    }

    // Sample to weekly
    const weeklyIdx = baseDates.filter((_, i) => i % 5 === 0);
    if (baseDates.length > 0 && weeklyIdx[weeklyIdx.length - 1]?.ts !== baseDates[baseDates.length - 1]?.ts) {
      weeklyIdx.push(baseDates[baseDates.length - 1]);
    }

    const weekly = weeklyIdx.map((ref) => {
      const d = new Date(ref.ts * 1000);
      const label = `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`;
      const row = { d: label };
      tickerList.forEach((t) => {
        const arr = results[t];
        if (!arr || arr.length === 0) return;
        let best = arr[0];
        for (const entry of arr) {
          if (Math.abs(entry.ts - ref.ts) < Math.abs(best.ts - ref.ts)) best = entry;
        }
        if (Math.abs(best.ts - ref.ts) < 5 * 24 * 3600) row[t] = best.close;
      });
      return row;
    });

    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=7200");

    return res.status(200).json({
      tickers: tickerList,
      months: parseInt(months),
      fetchedAt: new Date().toISOString(),
      dataPoints: weekly.length,
      tickersWithData: tickerList.filter((t) => results[t]?.length > 0),
      tickersFailed: Object.keys(perTickerErrors),
      errors: Object.keys(perTickerErrors).length > 0 ? perTickerErrors : undefined,
      weekly,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

