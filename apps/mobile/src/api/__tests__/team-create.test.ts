import { strict as assert } from "node:assert";
import { test } from "node:test";

import { ApiClient, team, type AuthTokens, type TokenStore } from "@matgary/api-client";

const TEST_TOKENS: AuthTokens = {
  accessToken: "test-access",
  refreshToken: "test-refresh",
  expiresAt: Date.now() + 60 * 60 * 1000,
};

function stubStore(): TokenStore {
  let tokens: AuthTokens | null = TEST_TOKENS;
  return {
    async get() {
      return tokens;
    },
    async set(next) {
      tokens = next;
    },
    async clear() {
      tokens = null;
    },
  };
}

type FetchCall = { url: string; init: RequestInit };

function stubFetch(response: Response): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: typeof input === "string" ? input : input.toString(), init: init ?? {} });
    return response.clone();
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = original) };
}

test("createMember POSTs /api/team with the expected body and returns the row", async () => {
  const stub = stubFetch(
    new Response(JSON.stringify({ userId: "u1", loginEmail: "ahmed@yourstore.local" }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }),
  );
  try {
    const api = new ApiClient({
      baseUrl: "http://localhost:3003",
      tokens: stubStore(),
      getBranchId: () => "11111111-1111-1111-1111-111111111111",
    });
    const result = await team.createMember(api, {
      username: "ahmed",
      displayName: "Ahmed Mohamed",
      password: "letmein!",
      phone: null,
      nationalId: null,
      address: null,
      permissions: ["view_dashboard", "record_sales"],
      branchId: "22222222-2222-2222-2222-222222222222",
    });

    assert.equal(result.userId, "u1");
    assert.equal(result.loginEmail, "ahmed@yourstore.local");

    assert.equal(stub.calls.length, 1);
    const call = stub.calls[0]!;
    assert.equal(call.url, "http://localhost:3003/api/team");
    assert.equal(call.init.method, "POST");

    const body = JSON.parse(String(call.init.body));
    assert.equal(body.username, "ahmed");
    assert.equal(body.displayName, "Ahmed Mohamed");
    assert.equal(body.password, "letmein!");
    assert.equal(body.branchId, "22222222-2222-2222-2222-222222222222");
    assert.deepEqual(body.permissions, ["view_dashboard", "record_sales"]);
    assert.equal(body.phone, null);
    assert.equal(body.nationalId, null);
    assert.equal(body.address, null);

    const headers = new Headers(call.init.headers as HeadersInit);
    assert.equal(headers.get("Authorization"), "Bearer test-access");
    // The branch POSTed in the body is the caller-provided one; the ambient
    // X-Branch-Id header still carries the session's active branch — exactly
    // the data isolation the server expects.
    assert.equal(headers.get("X-Branch-Id"), "11111111-1111-1111-1111-111111111111");
  } finally {
    stub.restore();
  }
});

test("createMember surfaces a 409 conflict as an ApiError", async () => {
  const stub = stubFetch(
    new Response(JSON.stringify({ error: "اسم المستخدم مستخدم بالفعل في هذا المتجر" }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    }),
  );
  try {
    const api = new ApiClient({
      baseUrl: "http://localhost:3003",
      tokens: stubStore(),
      getBranchId: () => null,
    });
    await assert.rejects(
      () =>
        team.createMember(api, {
          username: "dupe",
          displayName: "Dupe",
          password: "letmein!",
          permissions: [],
          branchId: "22222222-2222-2222-2222-222222222222",
        }),
      (err: unknown) => {
        const e = err as { kind?: string; status?: number; message?: string };
        return e.kind === "conflict" && e.status === 409 && typeof e.message === "string";
      },
    );
  } finally {
    stub.restore();
  }
});

test("createMember surfaces a 403 as a forbidden ApiError", async () => {
  const stub = stubFetch(
    new Response(JSON.stringify({ error: "FORBIDDEN" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    }),
  );
  try {
    const api = new ApiClient({
      baseUrl: "http://localhost:3003",
      tokens: stubStore(),
      getBranchId: () => null,
    });
    await assert.rejects(
      () =>
        team.createMember(api, {
          username: "ahmed",
          displayName: "Ahmed",
          password: "letmein!",
          permissions: [],
          branchId: "22222222-2222-2222-2222-222222222222",
        }),
      (err: unknown) => {
        const e = err as { kind?: string; status?: number };
        return e.kind === "forbidden" && e.status === 403;
      },
    );
  } finally {
    stub.restore();
  }
});
