/**
 * Tests for WeChatAcpClient message-flush behaviour.
 *
 * Verifies that intermediate status messages (flushed at tool_call /
 * thought boundaries) are delivered exactly once even when multiple
 * sessionUpdate notifications arrive concurrently – which happens because
 * the ACP SDK fires notification handlers without awaiting them.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { WeChatAcpClient } from "../src/acp/client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal WeChatAcpClient with controllable callbacks. */
function makeClient(opts: {
  onMessageFlush?: (text: string) => Promise<void>;
  onThoughtFlush?: (text: string) => Promise<void>;
  onImageFlush?: (image: { data: string; mimeType: string }) => Promise<void>;
  sendDelay?: number;
}): WeChatAcpClient {
  const { sendDelay = 0 } = opts;
  const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  return new WeChatAcpClient({
    sendTyping: async () => {},
    onThoughtFlush:
      opts.onThoughtFlush ??
      (async () => {
        if (sendDelay) await delay(sendDelay);
      }),
    onMessageFlush:
      opts.onMessageFlush ??
      (async () => {
        if (sendDelay) await delay(sendDelay);
      }),
    ...(opts.onImageFlush ? { onImageFlush: opts.onImageFlush } : {}),
    log: () => {},
    showThoughts: false,
  });
}

async function emitMessageChunk(client: WeChatAcpClient, text: string): Promise<void> {
  await client.sessionUpdate({
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  } as never);
}

async function emitToolCall(client: WeChatAcpClient): Promise<void> {
  await client.sessionUpdate({
    update: { sessionUpdate: "tool_call", title: "test-tool", status: "started" },
  } as never);
}

async function emitThoughtChunk(client: WeChatAcpClient, text = "thinking…"): Promise<void> {
  await client.sessionUpdate({
    update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text } },
  } as never);
}

async function emitImageChunk(
  client: WeChatAcpClient,
  data = "ZmFrZS1pbWFnZS1kYXRh",
  mimeType = "image/png",
): Promise<void> {
  await client.sessionUpdate({
    update: { sessionUpdate: "agent_message_chunk", content: { type: "image", data, mimeType } },
  } as never);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("single intermediate message is flushed exactly once (sequential)", async () => {
  const calls: string[] = [];
  const client = makeClient({ onMessageFlush: async (t) => { calls.push(t); } });

  await emitMessageChunk(client, "status update");
  await emitToolCall(client);

  assert.equal(calls.length, 1);
  assert.equal(calls[0], "status update");
});

test("concurrent tool_call events send the buffered message exactly once", async () => {
  /**
   * The ACP SDK fires notification handlers without awaiting them, so two
   * tool_call notifications can both reach maybeFlushMessage while the first
   * send is still in-progress. Regression: before the fix, both would see
   * non-empty chunks and each would trigger an independent send (triple-send).
   */
  const calls: string[] = [];
  const client = makeClient({
    onMessageFlush: async (text) => {
      calls.push(text);
      await new Promise<void>((r) => setTimeout(r, 20));
    },
  });

  await emitMessageChunk(client, "intermediate status");

  // Fire two concurrent boundary events without awaiting between them.
  const flush1 = emitToolCall(client);
  const flush2 = emitToolCall(client);
  await Promise.all([flush1, flush2]);

  assert.equal(calls.length, 1, `expected 1 send, got ${calls.length}: ${JSON.stringify(calls)}`);
  assert.equal(calls[0], "intermediate status");
});

test("three concurrent boundary events send the message exactly once", async () => {
  const calls: string[] = [];
  const client = makeClient({
    onMessageFlush: async (text) => {
      calls.push(text);
      await new Promise<void>((r) => setTimeout(r, 30));
    },
  });

  await emitMessageChunk(client, "部分搜索结果像是媒体汇总和平台片单混在一起");

  const p1 = emitToolCall(client);
  const p2 = emitThoughtChunk(client, "thinking");
  const p3 = emitToolCall(client);
  await Promise.all([p1, p2, p3]);

  assert.equal(
    calls.length,
    1,
    `intermediate status message sent ${calls.length}x instead of once`,
  );
});

test("final answer is delivered after intermediate flush clears the buffer", async () => {
  const messageCalls: string[] = [];
  const client = makeClient({
    onMessageFlush: async (t) => { messageCalls.push(t); },
  });
  client.newTurn();

  await emitMessageChunk(client, "searching…");
  await emitToolCall(client); // flushes "searching…"

  await emitMessageChunk(client, "here is the answer");
  const replyText = await client.flush();

  assert.equal(messageCalls.length, 1);
  assert.equal(messageCalls[0], "searching…");
  assert.equal(replyText, "here is the answer");
});

test("failed send retains buffer so final flush delivers the message", async () => {
  const client = makeClient({
    onMessageFlush: async () => { throw new Error("WeChat API error"); },
  });

  await emitMessageChunk(client, "status");
  await emitToolCall(client); // will fail; buffer should be retained

  const replyText = await client.flush();
  assert.equal(replyText, "status");
});

test("two sequential flushes are delivered in order (second waits for first)", async () => {
  /**
   * Scenario: chunk A is flushed at boundary-1, then chunk B is flushed at
   * boundary-2 while A's send is still awaiting. The mutex chain must ensure
   * A completes before B starts, so WeChat always receives A before B.
   */
  const order: string[] = [];
  let releaseA!: () => void;
  const client = makeClient({
    onMessageFlush: async (text) => {
      if (text === "chunk A") {
        // Simulate a slow first send
        await new Promise<void>((r) => {
          releaseA = r;
        });
      }
      order.push(text);
    },
  });

  await emitMessageChunk(client, "chunk A");
  // Fire boundary-1 without awaiting so it blocks on the slow send
  const p1 = emitToolCall(client);

  await emitMessageChunk(client, "chunk B");
  // Fire boundary-2 — must queue behind A
  const p2 = emitToolCall(client);

  // Release A's send
  releaseA();
  await Promise.all([p1, p2]);

  assert.deepEqual(order, ["chunk A", "chunk B"], "second message must arrive after first");
});

// ---------------------------------------------------------------------------
// Image content tests
// ---------------------------------------------------------------------------

test("image chunk is flushed via onImageFlush at tool_call boundary", async () => {
  const images: { data: string; mimeType: string }[] = [];
  const client = makeClient({
    onImageFlush: async (img) => { images.push(img); },
  });

  await emitImageChunk(client, "YQ==", "image/png");
  await emitToolCall(client);

  assert.equal(images.length, 1, "image must be flushed at tool_call boundary");
  assert.equal(images[0].data, "YQ==");
  assert.equal(images[0].mimeType, "image/png");
});

test("image is flushed at final flush()", async () => {
  const images: { data: string; mimeType: string }[] = [];
  const client = makeClient({
    onImageFlush: async (img) => { images.push(img); },
  });

  await emitImageChunk(client, "YmI=", "image/jpeg");
  await client.flush();

  assert.equal(images.length, 1, "image must be delivered at final flush");
  assert.equal(images[0].data, "YmI=");
});

test("text before image is flushed first so ordering is preserved", async () => {
  const order: string[] = [];
  const client = makeClient({
    onMessageFlush: async (t) => { order.push(`text:${t}`); },
    onImageFlush: async (img) => { order.push(`image:${img.data}`); },
  });

  await emitMessageChunk(client, "here is a diagram");
  await emitImageChunk(client, "Yw==", "image/png");
  await emitToolCall(client);

  assert.deepEqual(
    order,
    ["text:here is a diagram", "image:Yw=="],
    "text must be flushed before the image that follows it",
  );
});

test("multiple images are flushed in arrival order", async () => {
  const images: string[] = [];
  const client = makeClient({
    onImageFlush: async (img) => { images.push(img.data); },
  });

  await emitImageChunk(client, "img1");
  await emitImageChunk(client, "img2");
  await emitImageChunk(client, "img3");
  await client.flush();

  assert.deepEqual(images, ["img1", "img2", "img3"], "images must preserve arrival order");
});

test("no onImageFlush wired → image is dropped with a log (no throw)", async () => {
  const logs: string[] = [];
  const client = new WeChatAcpClient({
    sendTyping: async () => {},
    onThoughtFlush: async () => {},
    onMessageFlush: async () => {},
    log: (msg) => { logs.push(msg); },
    showThoughts: false,
  });

  await emitImageChunk(client, "ZHJvcA==", "image/png");
  await client.flush();

  const dropLog = logs.find((l) => l.includes("dropping") && l.includes("image"));
  assert.ok(dropLog, "must log that the image was dropped");
});
