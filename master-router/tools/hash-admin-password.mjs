import { createPasswordHash } from "../src/security.js";

const password = process.argv[2] || process.env.X_MASTER_ADMIN_PASSWORD || "";
if (password.length < 8) {
  console.error("Admin password must contain at least 8 characters.");
  process.exit(2);
}
console.log(await createPasswordHash(password));
