// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Security / JWT example. Run with: `deno run examples/jwt.ts`
 */

import { createService } from "../security/mod.ts";

// A validator that rejects blocked users.
const rejectBlocked = (claims: Record<string, unknown>) => {
  if (claims.sub === "blocked-user") throw new Error("user is blocked");
};

const jwt = createService({
  algorithm: "HS256",
  hmacSecret: "super-secret-key",
  validators: [rejectBlocked],
});

const token = await jwt.sign({ sub: "user-1", role: "admin", iat: Date.now() });
console.log("token:", token);

const verified = await jwt.verify(token);
console.log("claims:", verified.claims);

// Tampered / wrong-key tokens are rejected.
try {
  const other = createService({ algorithm: "HS256", hmacSecret: "different-key" });
  await other.verify(token);
} catch (err) {
  console.log("rejected as expected:", (err as Error).message);
}
