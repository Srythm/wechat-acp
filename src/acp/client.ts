/**
 * ACP Client implementation for WeChat.
 *
 * Implements the acp.Client interface: handles session updates (accumulates
 * text chunks), auto-allows all permission requests, and provides filesystem
 * access for the agent.
 */

import fs from "node:fs";
import type * as acp from "@agentclientprotocol/sdk";

export interface WeChatAcpClientOpts {
  sendTyping: () => Promise<void>;
  onThoughtFlush: (text: string) => Promise<void>;
  onMessageFlush: (text: string) => Promise<void>;
  /**
   * Called when the agent produces an image content block in its reply.
   * The image is passed as the raw ACP ImageContent (base64 `data` +
   * `mimeType`). If not provided, image output is dropped.
   */
  onImageFlush?: (image: acp.ImageContent) => Promise<void>;
  onConfigOptionsUpdate?: (configOptions: acp.SessionConfigOption[]) => void;
  log: (msg: string) => void;
  showThoughts: boolean;
  showDiffs?: boolean;
}

export class WeChatAcpClient implements acp.Client {
  private chunks: string[] = [];
  private thoughtChunks: string[] = [];
  // Accumulated image content blocks produced by the agent this turn.
  // Flushed (drained) at thought/tool_call boundaries and at the final
  // flush(), mirroring how text chunks are delivered to WeChat.
  private imageBlocks: acp.ImageContent[] = [];
  private opts: WeChatAcpClientOpts;
  private lastTypingAt = 0;
  private producedMessageThisTurn = false;
  // Promise chain serializing onMessageFlush calls so concurrent boundary events
  // cannot interleave sends (e.g. chunk B reaching WeChat before chunk A).
  private messageFlushChain: Promise<void> = Promise.resolve();
  // Separate chain for image sends so image delivery cannot race with text
  // delivery to the same user (one CDN upload + send at a time per turn).
  private imageFlushChain: Promise<void> = Promise.resolve();
  private static readonly TYPING_INTERVAL_MS = 5_000;
  private static readonly SEND_MAX_ATTEMPTS = 3;
  private static readonly SEND_RETRY_BASE_MS = 300;

  /** Whether the agent emitted any non-empty message content during the current turn. */
  get hasProducedMessage(): boolean {
    return this.producedMessageThisTurn;
  }

  /** Reset per-turn delivery state. Call at the start of each prompt. */
  newTurn(): void {
    this.producedMessageThisTurn = false;
  }

  constructor(opts: WeChatAcpClientOpts) {
    this.opts = opts;
  }

  updateCallbacks(callbacks: {
    sendTyping: () => Promise<void>;
    onThoughtFlush: (text: string) => Promise<void>;
    onMessageFlush: (text: string) => Promise<void>;
    onImageFlush?: (image: acp.ImageContent) => Promise<void>;
  }): void {
    this.opts = {
      ...this.opts,
      sendTyping: callbacks.sendTyping,
      onThoughtFlush: callbacks.onThoughtFlush,
      onMessageFlush: callbacks.onMessageFlush,
      ...(callbacks.onImageFlush !== undefined
        ? { onImageFlush: callbacks.onImageFlush }
        : {}),
    };
  }

  async requestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    // Auto-allow: find first "allow" option
    const allowOpt = params.options.find(
      (o) => o.kind === "allow_once" || o.kind === "allow_always",
    );
    const optionId = allowOpt?.optionId ?? params.options[0]?.optionId ?? "allow";

    this.opts.log(`[permission] auto-allowed: ${params.toolCall?.title ?? "unknown"} → ${optionId}`);

    return {
      outcome: {
        outcome: "selected",
        optionId,
      },
    };
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const update = params.update;

    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        await this.maybeFlushThoughts();
        if (update.content.type === "text") {
          this.chunks.push(update.content.text);
          if (update.content.text.trim()) {
            this.producedMessageThisTurn = true;
          }
        } else if (update.content.type === "image") {
          // Drain any buffered text first so text-before-image ordering is
          // preserved on the receiving end, then queue the image for delivery.
          await this.maybeFlushMessage();
          this.imageBlocks.push(update.content);
          this.producedMessageThisTurn = true;
        }
        // Throttle typing indicators
        await this.maybeSendTyping();
        break;

      case "tool_call":
        await this.maybeFlushThoughts();
        await this.maybeFlushMessage();
        await this.maybeFlushImages();
        this.opts.log(`[tool] ${update.title} (${update.status})`);
        await this.maybeSendTyping();
        break;

      case "agent_thought_chunk":
        await this.maybeFlushMessage();
        await this.maybeFlushImages();
        if (update.content.type === "text") {
          const text = update.content.text;
          this.opts.log(`[thought] ${text.length > 80 ? text.substring(0, 80) + "..." : text}`);
          if (this.opts.showThoughts) {
            this.thoughtChunks.push(text);
          }
        }
        await this.maybeSendTyping();
        break;

      case "tool_call_update":
        if (update.status === "completed" && update.content) {
          for (const c of update.content) {
            if (c.type === "diff") {
              if (this.opts.showDiffs === false) {
                continue;
              }
              const diff = c as acp.Diff;
              const header = `--- ${diff.path}`;
              const lines: string[] = [header];
              if (diff.oldText != null) {
                for (const l of diff.oldText.split("\n")) lines.push(`- ${l}`);
              }
              if (diff.newText != null) {
                for (const l of diff.newText.split("\n")) lines.push(`+ ${l}`);
              }
              this.chunks.push("\n```diff\n" + lines.join("\n") + "\n```\n");
              this.producedMessageThisTurn = true;
            }
          }
        }
        if (update.status) {
          this.opts.log(`[tool] ${update.toolCallId} → ${update.status}`);
        }
        await this.maybeSendTyping();
        break;

      case "plan":
        // Log plan entries
        if (update.entries) {
          const items = update.entries
            .map((e: acp.PlanEntry, i: number) => `  ${i + 1}. [${e.status}] ${e.content}`)
            .join("\n");
          this.opts.log(`[plan]\n${items}`);
        }
        await this.maybeSendTyping();
        break;

      case "config_option_update":
        this.opts.onConfigOptionsUpdate?.(update.configOptions);
        this.opts.log(`[config] ${update.configOptions.length} option(s) updated`);
        break;
    }
  }

  async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    try {
      const content = await fs.promises.readFile(params.path, "utf-8");
      return { content };
    } catch (err) {
      throw new Error(`Failed to read file ${params.path}: ${String(err)}`);
    }
  }

  async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    try {
      await fs.promises.writeFile(params.path, params.content, "utf-8");
      return {};
    } catch (err) {
      throw new Error(`Failed to write file ${params.path}: ${String(err)}`);
    }
  }

  /** Get accumulated text and reset the buffer. Also flushes any remaining thoughts. */
  async flush(): Promise<string> {
    await this.maybeFlushThoughts();
    // Drain any in-flight sends (queued by maybeFlushMessage) before reading
    // the buffer so a retried-and-restored flush cannot race with this read.
    await this.messageFlushChain.catch(() => {});
    // Deliver any accumulated image blocks before returning the final text,
    // so images produced during the turn are pushed to WeChat.
    await this.maybeFlushImages();
    const text = this.chunks.join("");
    this.chunks = [];
    this.lastTypingAt = 0;
    return text;
  }

  private async maybeFlushThoughts(): Promise<void> {
    if (this.thoughtChunks.length === 0) return;
    const thoughtText = this.thoughtChunks.join("");
    this.thoughtChunks = [];
    if (!thoughtText.trim()) return;
    const ok = await this.sendWithRetry(
      () => this.opts.onThoughtFlush(`💭 [Thinking]\n${thoughtText}`),
      "thought",
    );
    if (!ok) {
      this.opts.log(`[flush] dropping ${thoughtText.length} chars of thought after retries`);
    }
  }

  /**
   * Stream the buffered agent message (and any embedded diffs) as its own
   * WeChat reply. Called at thought/tool_call boundaries so multi-step turns
   * surface narrative segments in order; the final segment is still returned
   * by `flush()` so the caller can append stop-reason suffixes.
   */
  private async maybeFlushMessage(): Promise<void> {
    if (this.chunks.length === 0) return;
    const text = this.chunks.join("");
    if (!text.trim()) {
      this.chunks = [];
      return;
    }
    // Clear the buffer synchronously BEFORE awaiting so that any concurrent
    // sessionUpdate calls (the ACP SDK fires notifications without awaiting
    // handlers) see an empty buffer and skip the flush instead of re-sending
    // the same text. New chunks arriving during the send are appended to the
    // now-empty array and flushed at the next boundary.
    this.chunks = [];

    // Acquire a send slot using a simple mutex chain: each caller saves the
    // current tail of the chain, replaces it with a new unresolved promise,
    // and awaits the old tail before sending. This guarantees strict FIFO
    // ordering — chunk A always reaches WeChat before chunk B even when both
    // boundary events fire nearly simultaneously.
    const prev = this.messageFlushChain;
    let resolve!: () => void;
    this.messageFlushChain = new Promise<void>((r) => {
      resolve = r;
    });
    await prev.catch(() => {});

    try {
      const ok = await this.sendWithRetry(() => this.opts.onMessageFlush(text), "message");
      if (!ok) {
        // Send failed after all retries. Prepend the unsent text back so the
        // final flush() returns it and session.ts re-attempts via onReply (which
        // surfaces failure to the user). Any new chunks appended during the
        // failed send attempts are preserved after the restored text.
        this.chunks = [text, ...this.chunks];
        this.opts.log(
          `[flush] message send failed after retries; retaining ${text.length} chars for final flush`,
        );
      }
    } finally {
      resolve();
    }
  }

  /**
   * Deliver accumulated image content blocks to WeChat, one at a time,
   * in arrival order. Like {@link maybeFlushMessage} this drains the
   * buffer synchronously before awaiting so concurrent sessionUpdate
   * notifications don't re-send the same image.
   *
   * Images are uploaded to the WeChat CDN by the bridge (see
   * {@link WeChatAcpBridge.sendImageReply}) and referenced from a BOT
   * message, so each flush is a multi-step network call and is serialized
   * via {@link imageFlushChain} to avoid racing uploads for the same turn.
   */
  private async maybeFlushImages(): Promise<void> {
    if (this.imageBlocks.length === 0) return;
    if (!this.opts.onImageFlush) {
      // No image sink wired — drop and log so it's visible.
      const dropped = this.imageBlocks.length;
      this.imageBlocks = [];
      this.opts.log(`[flush] dropping ${dropped} image block(s): no onImageFlush wired`);
      return;
    }
    const images = this.imageBlocks;
    this.imageBlocks = [];

    // Serialize image sends on a per-turn chain so concurrent boundary
    // flushes cannot interleave CDN uploads.
    const prev = this.imageFlushChain;
    let resolve!: () => void;
    this.imageFlushChain = new Promise<void>((r) => {
      resolve = r;
    });
    await prev.catch(() => {});

    try {
      for (const image of images) {
        const ok = await this.sendWithRetry(
          () => this.opts.onImageFlush!(image),
          "image",
        );
        if (!ok) {
          this.opts.log(`[flush] image send failed after retries; dropping image`);
        }
      }
    } finally {
      resolve();
    }
  }

  /**
   * Send with bounded retries and linear backoff (`SEND_RETRY_BASE_MS *
   * attempt`). Returns true on success, false if all attempts failed
   * (logging each failure so transient WeChat send errors are surfaced
   * instead of silently swallowed).
   */
  private async sendWithRetry(send: () => Promise<void>, label: string): Promise<boolean> {
    for (let attempt = 1; attempt <= WeChatAcpClient.SEND_MAX_ATTEMPTS; attempt++) {
      try {
        await send();
        return true;
      } catch (err) {
        this.opts.log(
          `[flush] ${label} send failed (attempt ${attempt}/${WeChatAcpClient.SEND_MAX_ATTEMPTS}): ${String(err)}`,
        );
        if (attempt < WeChatAcpClient.SEND_MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, WeChatAcpClient.SEND_RETRY_BASE_MS * attempt));
        }
      }
    }
    return false;
  }

  private async maybeSendTyping(): Promise<void> {
    const now = Date.now();
    if (now - this.lastTypingAt < WeChatAcpClient.TYPING_INTERVAL_MS) return;
    this.lastTypingAt = now;
    try {
      await this.opts.sendTyping();
    } catch {
      // typing is best-effort
    }
  }
}
