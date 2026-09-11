# Borsa Smart PRO V19 Ultimate

لوحة تحليل أسهم EGX بواجهة عربية RTL، تعمل عبر Node.js وتستخدم EGXpilot كمصدر بيانات مباشر من خلال Proxy آمن على الخادم.

## التشغيل محليًا
```bash
npm install
npm start
```
ثم افتحي `http://localhost:3000`.

## النشر
المشروع جاهز للرفع مباشرة على GitHub ثم ربطه بـ Render أو أي استضافة Node.js.

- Build: `npm install`
- Start: `npm start`
- Node: `>=18`
- EGXpilot MCP: `https://egxpilot.com/api/mcp`

## أهم الوظائف
- بيانات السوق والأسعار عبر EGXpilot MCP.
- Technical + Fundamental + Fair Value + Risk.
- Scanner وترتيب الإشارات.
- Stop Loss وTarget وإدارة حجم الصفقة.
- Backtest + Walk-Forward + Sensitivity + Monte Carlo.
- Data Integrity وRegime Stability.
- Fallback تاريخي مدمج داخل `legacy_history.json`.

> نتائج الاختبارات التاريخية ليست ضمانًا لنتائج مستقبلية، والمشروع أداة تحليل تعليمية وليست نصيحة استثمارية.

## EGXpilot MCP (No API Key)

The hosted configuration uses the official EGXpilot Streamable HTTP MCP endpoint:

- `DATA_PROVIDER=egxpilot-mcp`
- `EGXPILOT_MCP_URL=https://egxpilot.com/api/mcp`
- `MCP_CONNECT_TIMEOUT_MS=15000`
- `MCP_CALL_TIMEOUT_MS=15000`
- `MCP_RETRIES=2`

Diagnostics are available at `/api/egx/diagnostic?symbol=COMI`.
