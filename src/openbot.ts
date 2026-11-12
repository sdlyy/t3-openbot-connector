import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AutomationLocation } from "./config.js";
import { BridgeError } from "./errors.js";

export const receiptSchema = z.object({
  messageId: z.string(),
  deliveries: z
    .array(z.object({ id: z.string(), recipientAgentId: z.string(), status: z.string() }))
    .min(1),
});

export const agentSchema = z.object({
  id: z.string(),
  name: z.string(),
  routines: z.array(z.object({ id: z.string(), name: z.string(), active: z.boolean() })),
});

export const runReceiptSchema = z.object({ runId: z.string(), deliveryId: z.string().nullable() });

export const pendingSchema = z.object({
  prompts: z.array(
    z
      .object({
        requestId: z.string(),
        requiresOpenBot: z.boolean(),
        questions: z.array(
          z
            .object({
              id: z.string(),
              header: z.string().optional(),
              question: z.string(),
              options: z.array(z.object({ label: z.string(), description: z.string().optional() })).optional(),
            })
            .passthrough(),
        ),
      })
      .passthrough(),
  ),
  approvals: z.array(z.record(z.string(), z.unknown())),
  browserTakeovers: z.array(z.record(z.string(), z.unknown())),
});

/** Talks to OpenBot's Local scripts API. The URL and token are read from their files on every request. */
export class OpenBotClient {
  constructor(
    readonly locate: () => Promise<AutomationLocation>,
    readonly timeoutMs = 10000,
  ) {}

  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const { directory } = await this.locate();
    let base: URL;
    let token: string;
    try {
      base = new URL((await readFile(join(directory, "url"), "utf8")).trim());
      token = (await readFile(join(directory, "token"), "utf8")).trim();
    } catch {
      throw new BridgeError("openbot_offline", "Start OpenBot and enable Local scripts for the selected agent.", true);
    }
    if (
      base.protocol !== "http:" ||
      base.hostname !== "127.0.0.1" ||
      base.username ||
      base.password ||
      base.pathname !== "/" ||
      base.search ||
      base.hash ||
      token.length < 16
    ) {
      throw new BridgeError("invalid_automation_files", "The OpenBot automation files are invalid.");
    }
    let response: Response;
    try {
      response = await fetch(new URL(path, base), {
        method,
        redirect: "error",
        headers: { authorization: "Bearer " + token, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new BridgeError("openbot_unavailable", "OpenBot did not acknowledge the request.", true, method !== "GET");
    }
    if (!response.ok) {
      await response.body?.cancel();
      const code =
        response.status === 401
          ? "openbot_auth_changed"
          : response.status === 403
            ? "openbot_access_denied"
            : response.status === 404
              ? "openbot_not_found"
              : response.status === 409
                ? "openbot_conflict"
                : response.status === 429
                  ? "openbot_rate_limited"
                  : "openbot_request_rejected";
      throw new BridgeError(
        code,
        "OpenBot returned HTTP " + response.status + ".",
        [401, 403, 429].includes(response.status) || response.status >= 500,
        method !== "GET" && response.status >= 500,
      );
    }
    let text: string;
    try {
      text = await boundedText(response);
    } catch (error) {
      if (error instanceof BridgeError) {
        throw new BridgeError(error.code, error.message, error.retryable, method !== "GET");
      }
      throw new BridgeError("openbot_unavailable", "OpenBot did not finish the response.", true, method !== "GET");
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new BridgeError("invalid_openbot_response", "OpenBot returned an invalid response.", false, method !== "GET");
    }
  }

  async agents() {
    return z.array(agentSchema).parse(await this.request("GET", "/v1/agents"));
  }

  async send(agentId: string, clientMessageId: string, text: string) {
    return receiptSchema.parse(
      await this.request("POST", "/v1/agents/" + encodeURIComponent(agentId) + "/messages", { text, clientMessageId }),
    );
  }

  /** Starts an existing routine now. This stock route has no retry key. */
  async run(agentId: string, routineId: string, payload?: string) {
    return runReceiptSchema.parse(
      await this.request(
        "POST",
        "/v1/agents/" + encodeURIComponent(agentId) + "/routines/" + encodeURIComponent(routineId) + "/run",
        payload === undefined ? {} : { payload },
      ),
    );
  }

  async pending(agentId: string) {
    return pendingSchema.parse(await this.request("GET", "/v1/agents/" + encodeURIComponent(agentId) + "/pending"));
  }

  async answerPrompt(agentId: string, requestId: string, answers: Record<string, string[]>) {
    return z
      .object({ ok: z.boolean() })
      .parse(
        await this.request(
          "POST",
          "/v1/agents/" + encodeURIComponent(agentId) + "/prompts/" + encodeURIComponent(requestId) + "/answer",
          { answers },
        ),
      );
  }
}

async function boundedText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2_000_000) {
        await reader.cancel();
        throw new BridgeError("openbot_response_limit", "The OpenBot response exceeded the size limit.");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    reader.releaseLock();
  }
}
