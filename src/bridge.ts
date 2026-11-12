import { BridgeError } from "./errors.js";
import type { OpenBotClient } from "./openbot.js";

export interface Submission {
  agent: string;
  text: string;
  requestId: string;
  report?: boolean | undefined;
  reportToThreadId?: string | undefined;
}

export interface ResolvedAgent {
  id: string;
  name: string;
}

/** Translates tool calls into OpenBot requests. It keeps no state: OpenBot owns queues, results, and routines. */
export class Bridge {
  constructor(
    readonly openbot: OpenBotClient,
    /** The T3 thread that reports go to unless a call names another one. */
    readonly callingThreadId: string | null = null,
  ) {}

  async status() {
    const location = await this.openbot.locate();
    return {
      automationDirectory: location.directory,
      source: location.source,
      callingThreadId: this.callingThreadId,
      agents: (await this.openbot.agents()).map(({ id, name }) => ({ id, name })),
    };
  }

  agents() {
    return this.openbot.agents();
  }

  /** An agent by ID, else by exact name, else by name ignoring case. Names must be unique to match. */
  async resolveAgent(agent: string): Promise<ResolvedAgent> {
    const agents = await this.openbot.agents();
    const byId = agents.find((item) => item.id === agent);
    if (byId) return { id: byId.id, name: byId.name };
    const exact = agents.filter((item) => item.name === agent);
    const loose = exact.length > 0 ? exact : agents.filter((item) => item.name.toLowerCase() === agent.toLowerCase());
    const [match] = loose;
    if (match && loose.length === 1) return { id: match.id, name: match.name };
    if (loose.length > 1) {
      throw new BridgeError(
        "agent_ambiguous",
        "Several agents are named " + agent + ". Use an ID: " + loose.map((item) => item.id).join(", ") + ".",
      );
    }
    throw new BridgeError(
      "agent_not_found",
      "No agent with Local scripts is called " +
        agent +
        ". Available: " +
        (agents.map((item) => item.name).join(", ") || "none") +
        ".",
    );
  }

  async submit(input: Submission) {
    const agent = await this.resolveAgent(input.agent);
    const threadId = input.report === false ? null : (input.reportToThreadId ?? this.callingThreadId);
    const text = threadId ? input.text + reportInstruction(threadId, input.requestId, agent.name) : input.text;
    const receipt = await this.openbot.send(agent.id, "t3-bridge:" + input.requestId, text);
    const delivery = receipt.deliveries.find((item) => item.recipientAgentId === agent.id);
    if (!delivery) {
      throw new BridgeError("delivery_mismatch", "The submission receipt did not name the selected agent.");
    }
    return {
      agentId: agent.id,
      agentName: agent.name,
      deliveryId: delivery.id,
      messageId: receipt.messageId,
      status: delivery.status,
      reportsToThreadId: threadId,
      reportClientRequestId: threadId ? reportKey(input.requestId) : null,
      note: threadId
        ? "Queued, not completed. Tell the user it is queued and end your turn; do not wait or poll. The agent's " +
          'report arrives in the T3 thread as a new message whose first line starts with "[OpenBot report]". ' +
          "If the user later asks and no report has arrived, call list_pending for this agent: it may be waiting " +
          "on a question or an approval in OpenBot."
        : input.report === false
          ? "Queued, not completed. Reporting was turned off, so no result will come back to T3."
          : "Queued, not completed. This session has no T3 thread and no reportToThreadId was set, so no result " +
            "will come back to T3.",
    };
  }

  async runRoutine(agent: string, routineId: string, payload?: string) {
    const resolved = await this.resolveAgent(agent);
    const receipt = await this.openbot.run(resolved.id, routineId, payload);
    return {
      ...receipt,
      agentId: resolved.id,
      agentName: resolved.name,
      routineId,
      note: "Queued, not completed. A routine run has no retry key: a lost acknowledgement may still have started it.",
    };
  }

  async pending(agent: string) {
    const resolved = await this.resolveAgent(agent);
    return { agentId: resolved.id, agentName: resolved.name, ...(await this.openbot.pending(resolved.id)) };
  }

  async answerPrompt(agent: string, requestId: string, answers: Record<string, string[]>) {
    const resolved = await this.resolveAgent(agent);
    return this.openbot.answerPrompt(resolved.id, requestId, answers);
  }
}

export function reportKey(requestId: string): string {
  return "openbot-report:" + requestId;
}

export function reportHeader(agentName: string, requestId: string, outcome: "completed" | "failed"): string {
  return "[OpenBot report] agent: " + agentName + " · request: " + requestId + " · outcome: " + outcome;
}

/**
 * Appended to a task so the OpenBot agent posts its own tagged answer, or failure, into the T3 thread.
 * It also says what happens afterwards: nothing. Without that, the agent waits for a reply that never
 * comes through this channel, or invents one.
 */
export function reportInstruction(threadId: string, requestId: string, agentName: string): string {
  return (
    "\n\n--- report to T3 Code ---\n" +
    "When you are done, whether or not you completed the task, call the T3 Code MCP tool named t3_thread_send " +
    'with threadId "' +
    threadId +
    '", mode "queue", clientRequestId "' +
    reportKey(requestId) +
    '", and a message whose first line is exactly:\n' +
    reportHeader(agentName, requestId, "completed") +
    "\n" +
    'Use "outcome: failed" instead if you could not finish, and say why. After that line, give your complete ' +
    "final answer. Send it exactly once. If the T3 Code tools are not available to you, say so in your answer instead.\n" +
    "This report is one-way. T3 Code does not answer inside this request and nothing will wake you afterwards. " +
    "Once t3_thread_send returns its receipt, end your turn with one short line saying the report was sent. " +
    "Do not wait for a reply, do not open a wait with openbot.await_event, do not ask the user whether to wait, " +
    "do not read or poll the T3 thread, and do not guess or write what T3 Code might answer. " +
    "If T3 Code has a follow-up, it arrives later as a new message in your queue."
  );
}
