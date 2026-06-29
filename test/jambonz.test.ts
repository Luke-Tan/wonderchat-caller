import { test } from "node:test";
import assert from "node:assert/strict";

process.env.RETELL_API_KEY = "test_key";
process.env.RETELL_AGENT_ID = "agent_test";
process.env.LOG_LEVEL = "silent";

const realFetch = globalThis.fetch;

test("parseInbound extracts call metadata and sip headers", async () => {
  const { parseInbound } = await import("../src/jambonz.ts");
  const parsed = parseInbound({
    call_sid: "cs_1",
    from: "+61400000000",
    to: "+61399999999",
    caller_name: "Test Caller",
    direction: "inbound",
    sip: { headers: { "X-Foo": "bar" } },
  });
  assert.equal(parsed.callSid, "cs_1");
  assert.equal(parsed.from, "+61400000000");
  assert.equal(parsed.to, "+61399999999");
  assert.equal(parsed.callerName, "Test Caller");
  assert.equal(parsed.sipHeaders["X-Foo"], "bar");
});

test("buildDialVerb produces a valid SIP dial verb", async () => {
  const { buildDialVerb } = await import("../src/jambonz.ts");
  const verb = buildDialVerb({
    sipUri: "sip:call_5@sip.retellai.com",
    callerId: "+61400000000",
    retellCallId: "call_5",
  }) as any;
  assert.equal(verb.verb, "dial");
  assert.equal(verb.callerId, "+61400000000");
  assert.equal(verb.answerOnBridge, true);
  assert.equal(verb.target[0].type, "sip");
  assert.equal(verb.target[0].sipUri, "sip:call_5@sip.retellai.com");
  assert.equal(verb.headers["X-Retell-Call-Id"], "call_5");
});

test("handleInbound returns a dial verb on success", async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ call_id: "call_ok" }), { status: 201 })) as typeof fetch;
  try {
    const { handleInbound } = await import("../src/jambonz.ts");
    const pino = (await import("pino")).default;
    const log = pino({ level: "silent" });
    const verbs = (await handleInbound(
      { call_sid: "cs", from: "+1", to: "+2" },
      log,
    )) as any[];
    assert.equal(verbs.length, 1);
    assert.equal(verbs[0].verb, "dial");
    assert.equal(verbs[0].target[0].sipUri, "sip:call_ok@sip.retellai.com");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("handleInbound falls back to hangup when Retell fails", async () => {
  globalThis.fetch = (async () =>
    new Response("err", { status: 500 })) as typeof fetch;
  try {
    const { handleInbound } = await import("../src/jambonz.ts");
    const pino = (await import("pino")).default;
    const log = pino({ level: "silent" });
    const verbs = (await handleInbound(
      { call_sid: "cs", from: "+1", to: "+2" },
      log,
    )) as any[];
    // Default ERROR_FALLBACK_MODE=hangup
    assert.equal(verbs[verbs.length - 1].verb, "hangup");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("isAuthorized passes when no secret is configured", async () => {
  const { isAuthorized } = await import("../src/jambonz.ts");
  assert.equal(isAuthorized({ headers: {} } as any), true);
});
