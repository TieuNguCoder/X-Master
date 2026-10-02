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
      return cfJson({ success: false, errors: [{ message: "subdomain enable failed" }] }, 500);
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
    /cloudflare/
  );

  assert.equal(deleteCalled, true, "orphan User Web Worker must be deleted after provisioning failure");
  console.log("User Web provisioning rollback DELETE: PASS");

  const routerName = __test.accountRouterWorkerName(
    { id: "ch_1234567890", name: "Tester Alpha", slug: "tester-alpha" },
    3
  );
  assert.ok(routerName.includes("-r3-"));
  assert.ok(routerName.startsWith("xmr-tester-alpha"));

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
    if (u.startsWith("https://xmr-") && u.endsWith(".xmaster-test.workers.dev/health")) {
      return cfJson({
        ok: true,
        slot_id: "rs_smoke",
        child_id: "ch_1234567890",
        master: true
      });
    }
    throw new Error("unexpected router fetch: " + u + " " + method);
  };

  const routerDeploy = await __test.deployAccountRouterWorker(
    {
      CF_ACCOUNT_ID: "account123456",
      CF_API_TOKEN: "token-12345678901234567890"
    },
    { id: "ch_1234567890", name: "Tester Alpha", slug: "tester-alpha" },
    "rs_smoke",
    3,
    "router-secret",
    "https://master.example"
  );
  assert.ok(routerDeploy.workerName.includes("-r3-"));
  assert.ok(routerDeploy.webUrl.endsWith(".xmaster-test.workers.dev"));
  console.log("account router Worker upload + workers.dev enable: PASS");

  // Cloudflare lifecycle must change the real Worker, then verify the resulting state.
  const lifecycleCalls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || "GET";
    lifecycleCalls.push({ u, method });

    if (u.endsWith("/workers/scripts/lifecycle-smoke") && method === "GET") {
      return cfJson({ success: true, result: { id: "lifecycle-smoke" } });
    }
    if (u.endsWith("/workers/scripts/lifecycle-smoke/subdomain") && method === "DELETE") {
      return cfJson({ success: true, result: { enabled: false, previews_enabled: false } });
    }
    if (u.endsWith("/workers/scripts/lifecycle-smoke/subdomain") && method === "POST") {
      return cfJson({ success: true, result: { enabled: true, previews_enabled: false } });
    }
    if (u.endsWith("/workers/scripts/lifecycle-smoke/subdomain") && method === "GET") {
      const enabled = lifecycleCalls.some((x) => x.method === "POST" && x.u.endsWith("/subdomain"));
      return cfJson({ success: true, result: { enabled, previews_enabled: false } });
    }
    throw new Error("unexpected lifecycle fetch: " + u + " " + method);
  };

  const stopped = await __test.setCloudflareWorkerEnabled(infra, "lifecycle-smoke", false);
  assert.equal(stopped.exists, true);
  assert.equal(stopped.enabled, false);
  assert.ok(lifecycleCalls.some((x) => x.method === "DELETE" && x.u.endsWith("/subdomain")));

  const resumed = await __test.setCloudflareWorkerEnabled(infra, "lifecycle-smoke", true);
  assert.equal(resumed.exists, true);
  assert.equal(resumed.enabled, true);
  assert.ok(lifecycleCalls.some((x) => x.method === "POST" && x.u.endsWith("/subdomain")));
  console.log("real Cloudflare Worker stop/resume + verification: PASS");

  let deleteProbeCount = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || "GET";
    if (u.endsWith("/workers/scripts/delete-smoke") && method === "GET") {
      deleteProbeCount += 1;
      if (deleteProbeCount === 1) return cfJson({ success: true, result: { id: "delete-smoke" } });
      return cfJson({ success: false, errors: [{ message: "not found" }] }, 404);
    }
    if (u.endsWith("/workers/scripts/delete-smoke?force=true") && method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    throw new Error("unexpected verified-delete fetch: " + u + " " + method);
  };
  const deletedWorker = await __test.deleteCloudflareWorkerVerified(infra, "delete-smoke");
  assert.equal(deletedWorker.deleted, true);
  assert.equal(deletedWorker.verified_absent, true);
  assert.equal(deleteProbeCount, 2);
  console.log("real Cloudflare Worker DELETE + absence verification: PASS");

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || "GET";
    if (u.endsWith("/workers/scripts?per_page=1000") && method === "GET") {
      return cfJson({ success: true, result: [{ id: "x-master-router" }, { id: "xmr-user-r1-abc" }] });
    }
    if (u.endsWith("/billable/usage") && method === "GET") {
      return cfJson({
        success: true,
        result: [
          {
            ChargeDescription: "Workers Standard Requests — daily usage",
            ConsumedQuantity: 125000,
            ConsumedUnit: "Requests",
            BilledCost: 0,
            BillingCurrency: "USD",
            BillingPeriodStart: "2026-10-01T00:00:00Z",
            BillingPeriodEnd: "2026-11-01T00:00:00Z",
            x_BillableMetricId: "workers_standard_requests",
            x_BillableMetricName: "Workers Standard Requests",
            x_ProductFamilyName: "Workers"
          },
          {
            ChargeDescription: "D1 Rows Read — daily usage",
            ConsumedQuantity: 900000,
            ConsumedUnit: "Rows",
            BilledCost: 0,
            BillingCurrency: "USD",
            BillingPeriodStart: "2026-10-01T00:00:00Z",
            BillingPeriodEnd: "2026-11-01T00:00:00Z",
            x_BillableMetricId: "d1_rows_read",
            x_BillableMetricName: "D1 Rows Read",
            x_ProductFamilyName: "D1"
          }
        ]
      });
    }
    throw new Error("unexpected usage fetch: " + u + " " + method);
  };
  const usageSummary = await __test.cloudflareUsageSummary({
    CF_ACCOUNT_ID: "account123456",
    CF_API_TOKEN: "token-12345678901234567890"
  });
  assert.equal(usageSummary.worker_count, 2);
  assert.equal(usageSummary.billing.available, true);
  assert.equal(usageSummary.billing.metrics.length, 2);
  assert.equal(usageSummary.billing.metrics.find((x) => x.metric_id === "workers_standard_requests").quantity, 125000);
  console.log("Cloudflare Worker count + billable usage aggregation: PASS");

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || "GET";
    if (u.endsWith("/workers/scripts?per_page=1000") && method === "GET") {
      return cfJson({ success: true, result: [{ id: "x-master-router" }] });
    }
    if (u.endsWith("/billable/usage") && method === "GET") {
      return cfJson({ success: false, errors: [{ message: "permission denied" }] }, 403);
    }
    throw new Error("unexpected usage permission fetch: " + u + " " + method);
  };
  const limitedUsage = await __test.cloudflareUsageSummary({
    CF_ACCOUNT_ID: "account123456",
    CF_API_TOKEN: "token-12345678901234567890"
  });
  assert.equal(limitedUsage.worker_count, 1);
  assert.equal(limitedUsage.billing.available, false);
  assert.equal(limitedUsage.billing.permission_required, true);
  console.log("Cloudflare usage gracefully handles missing Billing Read: PASS");

  const airdropPrompt = __test.rewritePrompt(
    "Qyrolabs waitlist is open. Reward: XP. Join https://qyrolabs.space and complete the tasks.",
    { content_mode: "airdrop", x_premium: 0 }
  );
  assert.ok(airdropPrompt.prompt.includes("CONTENT MODE: AIRDROP — STANDARD X ACCOUNT."));
  assert.ok(airdropPrompt.prompt.includes("Final line: 2 to 4 hashtags."));
  assert.ok(airdropPrompt.prompt.includes("https://qyrolabs.space"));

  const bothPrompt = __test.rewritePrompt(
    "Project waitlist is live with XP rewards and tasks.",
    { content_mode: "both", x_premium: 0, post_language: "en-US" }
  );
  assert.ok(bothPrompt.prompt.includes("CONTENT MODE: AUTO — AIRDROP OR NEWS — STANDARD X ACCOUNT."));
  assert.ok(bothPrompt.prompt.includes("First classify SOURCE as AIRDROP/OPPORTUNITY or NEWS"));

  const weighted = __test.fitStandardX(
    "速報".repeat(180) + " https://example.com/path " + "#News #Update",
    270
  );
  assert.ok(__test.xWeightedLength(weighted) <= 270, "standard X post must stay under weighted safety limit");

  const premiumNewsPrompt = __test.rewritePrompt(
    "Bitcoin market update with additional context.",
    { content_mode: "news", x_premium: 1, post_language: "vi-VN" }
  );
  assert.ok(premiumNewsPrompt.prompt.includes("CONTENT MODE: NEWS — PREMIUM/BLUE X ACCOUNT."));
  assert.ok(premiumNewsPrompt.prompt.includes("TARGET LANGUAGE: Vietnamese (vi-VN)"));
  assert.ok(premiumNewsPrompt.prompt.includes("Translate SOURCE content as needed."));
  assert.ok(premiumNewsPrompt.maxChars > airdropPrompt.maxChars);

  const forcedAirdrop = __test.cleanAiOutput(
    "🎁 Qyrolabs waitlist is open.",
    275,
    "Qyrolabs waitlist is open. Reward: XP. Join https://qyrolabs.space and complete the tasks.",
    { content_mode: "airdrop", x_premium: 0 }
  );
  assert.ok(forcedAirdrop.includes("https://qyrolabs.space"));
  assert.ok(forcedAirdrop.includes("#Airdrop"));
  assert.ok(forcedAirdrop.includes("#Web3"));

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u === "https://api.cloudinary.com/v1_1/cloud-smoke/image/upload") {
      assert.equal(init.method, "POST");
      assert.equal(init.headers.Authorization, "Basic " + btoa("key-smoke:secret-smoke"));
      assert.ok(init.body instanceof FormData);
      const file = init.body.get("file");
      assert.ok(String(file).startsWith("data:image/jpeg;base64,"));
      return cfJson({
        secure_url: "https://res.cloudinary.com/cloud-smoke/image/upload/x-master-smoke.jpg",
        public_id: "x-master-smoke",
        width: 1200,
        height: 800
      });
    }
    throw new Error("unexpected Cloudinary fetch: " + u);
  };
  const uploadedImage = await __test.uploadCloudinaryImage(
    {
      cloudinary_cloud_name: "cloud-smoke",
      cloudinary_api_key: "key-smoke",
      cloudinary_api_secret: "secret-smoke"
    },
    {
      kind: "image",
      mime_type: "image/jpeg",
      data_base64: Buffer.from("fake-image").toString("base64")
    }
  );
  assert.equal(uploadedImage.kind, "image");
  assert.ok(uploadedImage.url.startsWith("https://res.cloudinary.com/"));
  console.log("Cloudinary Telegram image upload: PASS");

  const postingCalls = [];
  globalThis.fetch = async (url, init = {}) => {
    postingCalls.push({ url: String(url), init });
    if (String(url).includes("generativelanguage.googleapis.com")) {
      assert.equal(init.headers["x-goog-api-key"], "gemini-test-key");
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "Rewritten smoke post" }] } }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (String(url) === "https://api.deepseek.com/chat/completions") {
      assert.equal(init.headers.Authorization, "Bearer deepseek-test-key");
      const payload = JSON.parse(init.body);
      assert.equal(payload.model, "deepseek-flash");
      assert.equal(payload.thinking.type, "disabled");
      return new Response(JSON.stringify({
        choices: [{ message: { content: "DeepSeek rewritten smoke post" } }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (String(url) === "https://api.buffer.com") {
      const payload = JSON.parse(init.body);
      assert.ok(payload.query.includes("mode: shareNow"));
      assert.ok(payload.query.includes('channelId: "buffer-channel-smoke"'));
      assert.ok(payload.query.includes("mode: shareNow"));
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
  assert.ok(rewritten.startsWith("Rewritten smoke post"));
  assert.ok((rewritten.match(/#/g) || []).length >= 2, "news output must contain at least 2 hashtags");

  const deepseekRewritten = await __test.deepseekRewrite(
    "deepseek-test-key",
    "Original Telegram smoke post",
    { content_mode: "airdrop", x_premium: 0 }
  );
  assert.ok(deepseekRewritten.startsWith("DeepSeek rewritten smoke post"));
  assert.ok(deepseekRewritten.includes("#Airdrop"));
  assert.ok(deepseekRewritten.includes("#Web3"));

  const post = await __test.bufferCreateNow(
    "buffer-test-key",
    "buffer-channel-smoke",
    rewritten
  );
  assert.equal(post.id, "post-smoke");
  assert.equal(post.status, "sent");

  const mediaPost = await __test.bufferCreateNow(
    "buffer-test-key",
    "buffer-channel-smoke",
    "Image smoke post",
    [{ kind: "image", url: "https://res.cloudinary.com/demo/image/upload/sample.jpg" }]
  );
  assert.equal(mediaPost.id, "post-smoke");
  const mediaQuery = JSON.parse(postingCalls.at(-1).init.body).query;
  assert.ok(mediaQuery.includes("assets: ["));
  assert.ok(mediaQuery.includes('image: { url: "https://res.cloudinary.com/demo/image/upload/sample.jpg" }'));
  assert.equal(postingCalls.length, 4);
  console.log("DeepSeek rewrite + weighted X limit + Buffer image shareNow posting: PASS");
} finally {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
}
