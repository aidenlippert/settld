import http from "node:http";
import { URL } from "node:url";

const PORT = Number(process.env.PORT ?? 9402);
if (!Number.isSafeInteger(PORT) || PORT <= 0) throw new Error("PORT must be a positive integer");

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // "x402-style": if there's no payment proof header, require payment.
  const paid =
    (req.headers["x-payment"] && String(req.headers["x-payment"]).trim() !== "") ||
    (req.headers["x-payment-proof"] && String(req.headers["x-payment-proof"]).trim() !== "");
  if (!paid) {
    res.statusCode = 402;
    res.setHeader("x-payment-required", "amountCents=500; currency=USD; address=mock:payee; network=mocknet");
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        ok: false,
        error: "payment_required",
        hint: "retry with x-payment: paid (mock)"
      })
    );
    return;
  }

  res.statusCode = 200;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(
    JSON.stringify({
      ok: true,
      resource: url.pathname,
      note: "this is a mock upstream response"
    })
  );
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ok: true, service: "x402-upstream-mock", port: PORT }));
});

