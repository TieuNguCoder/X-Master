import assert from "node:assert/strict";
import {
  PBKDF2_ITERATIONS,
  createPasswordHash,
  verifyPassword,
  encryptJson,
  decryptJson,
  hmacHex,
  slugify
} from "../src/security.js";

assert.equal(PBKDF2_ITERATIONS, 100000);

const hash = await createPasswordHash("owner-password-123");
assert.match(hash, /^pbkdf2-sha256\$100000\$/);
assert.equal(await verifyPassword("owner-password-123", hash), true);
assert.equal(await verifyPassword("wrong-password", hash), false);

const master = "master-key-for-test";
const payload = { cloudflare_api_token: "cf-secret", cloudinary_api_secret: "cloud-secret" };
const encrypted = await encryptJson(master, payload);
assert.notEqual(encrypted.includes("cf-secret"), true);
assert.deepEqual(await decryptJson(master, encrypted), payload);

assert.equal((await hmacHex("pepper", "value")).length, 64);
assert.equal(slugify("Tester Việt Nam #01"), "tester-viet-nam-01");

console.log("security.test: PASS");
