import { test } from "node:test";
import assert from "node:assert/strict";

// Configure env BEFORE importing modules that read config at load time.
process.env.RETELL_API_KEY = "test_key";
process.env.RETELL_AGENT_ID = "agent_test";
process.env.RETELL_SIP_DOMAIN = "sip.retellai.com";
process.env.LOG_LEVEL = "silent";

const { buildRetellSipUri, registerRetellCall, RetellError } = await import(
  "../src/retell.ts"
);

const realFetch = globalThis.fetch;
function mockFetch(impl: typeof fetch) {
  globalThis.fetch = impl as typeof fetch;
}
function restoreFetch() {
  globalThis.fetch = realFetch;
}

test("buildRetellSipUri constructs sip:{call_id}@domain", () => {
  assert.equal(
    buildRetellSipUri("abc123"),
    "sip:abc123@sip.retellai.com",
  );
});

test("buildRetellSipUri rejects empty call_id", () => {
  assert.throws(() => buildRetellSipUri(""), RetellError);
});

test("registerRetellCall returns callId + sipUri on success", async () => {
  mockFetch(async () =>
    new Response(JSON.stringify({ call_id: "call_99", call_status: "registered" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    }),
  );
  try {
    const out = await registerRetellCall({
      fromNumber: "+61400000000",
      toNumber: "+61399999999",
      direction: "inbound",
    });
    assert.equal(out.callId, "call_99");
    assert.equal(out.sipUri, "sip:call_99@sip.retellai.com");
    assert.ok(out.expiresAt > Date.now());
  } finally {
    restoreFetch();
  }
});

test("registerRetellCall throws RetellError on non-200", async () => {
  mockFetch(async () =>
    new Response(JSON.stringify({ error: "bad agent" }), { status: 422 }),
  );
  try {
    await assert.rejects(
      registerRetellCall({ fromNumber: "a", toNumber: "b", direction: "inbound" }),
      (e: unknown) => e instanceof RetellError && (e as RetellError).status === 422,
    );
  } finally {
    restoreFetch();
  }
});

test("registerRetellCall throws on malformed (non-JSON) response", async () => {
  mockFetch(async () => new Response("<html>oops</html>", { status: 200 }));
  try {
    await assert.rejects(
      registerRetellCall({ fromNumber: "a", toNumber: "b", direction: "inbound" }),
      RetellError,
    );
  } finally {
    restoreFetch();
  }
});

test("registerRetellCall throws when call_id missing", async () => {
  mockFetch(async () =>
    new Response(JSON.stringify({ call_status: "registered" }), { status: 201 }),
  );
  try {
    await assert.rejects(
      registerRetellCall({ fromNumber: "a", toNumber: "b", direction: "inbound" }),
      (e: unknown) => e instanceof RetellError && /missing call_id/.test((e as Error).message),
    );
  } finally {
    restoreFetch();
  }
});

test("registerRetellCall throws on network failure", async () => {
  mockFetch(async () => {
    throw new Error("ECONNREFUSED");
  });
  try {
    await assert.rejects(
      registerRetellCall({ fromNumber: "a", toNumber: "b", direction: "inbound" }),
      (e: unknown) => e instanceof RetellError && /request failed/.test((e as Error).message),
    );
  } finally {
    restoreFetch();
  }
});
