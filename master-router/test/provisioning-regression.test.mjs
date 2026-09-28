import assert from "node:assert/strict";
import { __test } from "../src/index.js";

function cfJson(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;

try {
  const infra = {
    cloudflare_account_id: "account123456",
    cloudflare_api_token: "token-12345678901234567890"
  };

  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET" });
    if (String(url).endsWith("/workers/subdomain") && (init.method || "GET") === "GET") {
      return cfJson({ success: false, errors: [{ message: "subdomain not configured" }] }, 404);
    }
    if (String(url).endsWith("/workers/subdomain") && init.method === "PUT") {
      return cfJson({ success: true, result: { subdomain: "xmaster-test" } });
    }
    throw new Error("unexpected fetch: " + url + " " + (init.method || "GET"));
  };

  const subdomain = await __test.ensureWorkersSubdomain(infra);
  assert.equal(subdomain, "xmaster-test");
  assert.ok(calls.some((x) => x.method === "PUT" && x.url.endsWith("/workers/subdomain")));
  console.log("new-account workers.dev subdomain creation: PASS");

  let deleteCalled = false;
  let healthCalls = 0;
  globalThis.setTimeout = (fn) => {
    fn();
    return 0;
  };

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || "GET";

    if (u.includes("/workers/scripts/") && method === "PUT") {
      return cfJson({ success: true, result: {} });
    }
    if (u.includes("/workers/scripts/") && u.endsWith("/subdomain") && method === "POST") {
      return cfJson({ success: true, result: {} });
    }
    if (u.endsWith("/workers/subdomain") && method === "GET") {
      return cfJson({ success: true, result: { subdomain: "xmaster-test" } });
    }
    if (u.startsWith("https://xm-") && u.endsWith(".xmaster-test.workers.dev/health")) {
      healthCalls += 1;
      return new Response("not ready", { status: 503 });
    }
    if (u.includes("/workers/scripts/") && method === "DELETE") {
      deleteCalled = true;
      return cfJson({ success: true, result: {} });
    }
    throw new Error("unexpected fetch: " + u + " " + method);
  };

  await assert.rejects(
    () => __test.deployChildWorker(
      infra,
      { id: "ch_1234567890", name: "Smoke", slug: "smoke" },
      "child-secret",
      "https://master.example"
    ),
    /child_health_failed/
  );

  assert.equal(healthCalls, 12);
  assert.equal(deleteCalled, true, "orphan Child Worker must be deleted after health failure");
  console.log("child health failure rollback DELETE: PASS");

  const postingCalls = [];
  globalThis.fetch = async (url, init = {}) => {
    postingCalls.push({ url: String(url), init });
    if (String(url).includes("generativelanguage.googleapis.com")) {
      assert.equal(init.headers["x-goog-api-key"], "gemini-test-key");
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "Rewritten smoke post" }] } }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (String(url) === "https://api.buffer.com") {
      const payload = JSON.parse(init.body);
      assert.ok(payload.query.includes("mode: shareNow"));
      assert.ok(payload.query.includes('channelId: "buffer-channel-smoke"'));
      assert.ok(payload.query.includes("Rewritten smoke post"));
      return new Response(JSON.stringify({
        data: {
          createPost: {
            __typename: "PostActionSuccess",
            post: { id: "post-smoke", text: "Rewritten smoke post", status: "sent", dueAt: null }
          }
        }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error("unexpected posting fetch: " + url);
  };

  const rewritten = await __test.geminiRewrite(
    "gemini-test-key",
    "Original Telegram smoke post",
    { content_mode: "news", x_premium: 0 }
  );
  assert.equal(rewritten, "Rewritten smoke post");

  const post = await __test.bufferCreateNow(
    "buffer-test-key",
    "buffer-channel-smoke",
    rewritten
  );
  assert.equal(post.id, "post-smoke");
  assert.equal(post.status, "sent");
  assert.equal(postingCalls.length, 2);
  console.log("Gemini rewrite + Buffer shareNow posting: PASS");
} finally {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
}
