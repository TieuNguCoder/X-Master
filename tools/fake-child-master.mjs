import http from "node:http";

const port = Number(process.env.FAKE_MASTER_PORT || 8800);

function json(res, body, status = 200, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");

  if (req.headers["x-child-id"] !== "ch_smoke" || req.headers["x-child-secret"] !== "child-secret") {
    return json(res, { error: "unauthorized" }, 401);
  }

  if (req.url === "/internal/child/login" && req.method === "POST") {
    const body = JSON.parse(raw || "{}");
    if (body.password !== "tester-password") return json(res, { error: "invalid_credentials" }, 401);
    return json(res, { ok: true }, 200, { "x-child-session": "session-smoke" });
  }

  if (req.headers["x-child-session"] !== "session-smoke") {
    return json(res, { error: "unauthorized" }, 401);
  }

  if (req.url === "/internal/child/me" && req.method === "GET") {
    return json(res, {
      child: { id: "ch_smoke", name: "Tester Smoke", status: "ready" },
      sources: [{ id: "src_smoke", title: "Smoke Source", username: "smoke_source" }],
      settings: {
        content_mode: "news",
        x_premium: false,
        gemini_configured: false,
        buffer_configured: false
      }
    });
  }

  if (req.url === "/internal/child/settings" && req.method === "PUT") {
    const body = JSON.parse(raw || "{}");
    if (body.gemini_api_key !== "gemini-smoke" || body.buffer_api_key !== "buffer-smoke") {
      return json(res, { error: "bad_payload" }, 400);
    }
    return json(res, { saved: true });
  }

  return json(res, { error: "not_found" }, 404);
});

server.listen(port, "127.0.0.1", () => {
  console.log("fake child master ready on", port);
});
