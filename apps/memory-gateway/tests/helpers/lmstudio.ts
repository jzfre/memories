/**
 * Minimal client for LM Studio's OpenAI-compatible API plus a tool-call loop,
 * used by the LM Studio integration tests. The loop mirrors what an MCP host does:
 * send the model the tool schemas, execute any tool calls it emits against local
 * handlers, feed the results back, and repeat until the model returns prose.
 */

export const LMSTUDIO_URL = process.env.LMSTUDIO_URL ?? "http://localhost:1234/v1";
export const LMSTUDIO_MODEL = process.env.LMSTUDIO_MODEL ?? "qwen/qwen3.6-35b-a3b";

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export type ToolHandler = (args: any) => Promise<unknown>;

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

/** True if the LM Studio dev server is up and serving the OpenAI API. */
export async function lmStudioReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${LMSTUDIO_URL}/models`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function chatComplete(body: Record<string, unknown>): Promise<ChatMessage> {
  const res = await fetch(`${LMSTUDIO_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: LMSTUDIO_MODEL, temperature: 0, ...body }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`LM Studio HTTP ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { choices: { message: ChatMessage }[] };
  return json.choices[0].message;
}

export interface ToolInvocation {
  name: string;
  args: any;
  result: unknown;
}

export interface ConversationResult {
  finalText: string;
  invocations: ToolInvocation[];
}

/**
 * Run a full tool-using conversation: the model may call tools across several
 * turns; each call is executed by `handlers` and the result is fed back. Returns
 * the model's final prose plus every tool invocation (name, args, result) so
 * tests can assert on the deterministic tool I/O as well as the prose.
 */
export async function runToolConversation(opts: {
  system: string;
  user: string;
  tools: ToolDef[];
  handlers: Record<string, ToolHandler>;
  maxTurns?: number;
}): Promise<ConversationResult> {
  const messages: ChatMessage[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.user },
  ];
  const invocations: ToolInvocation[] = [];
  const maxTurns = opts.maxTurns ?? 5;

  for (let turn = 0; turn < maxTurns; turn++) {
    const msg = await chatComplete({ messages, tools: opts.tools, tool_choice: "auto" });
    messages.push(msg);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return { finalText: msg.content ?? "", invocations };
    }

    for (const call of msg.tool_calls) {
      const handler = opts.handlers[call.function.name];
      let result: unknown;
      if (!handler) {
        result = { error: `unknown tool ${call.function.name}` };
      } else {
        let args: any = {};
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          args = {};
        }
        result = await handler(args);
        invocations.push({ name: call.function.name, args, result });
      }
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }

  return { finalText: "", invocations };
}
