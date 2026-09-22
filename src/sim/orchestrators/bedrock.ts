/**
 * The AWS Builder path: an Amazon Bedrock model picks the Dinner Bell tool
 * call, the same job Alexa+'s own orchestrator does in production. This is
 * what actually decides intent when `BEDROCK_MODEL_ID` is configured; the
 * hand-written grammar in `rules.ts` is the offline fallback so the demo
 * still works without AWS credentials.
 *
 * Uses the Bedrock Converse API's native tool-use support: the live MCP tool
 * list (fetched once from the running server, so it can never drift from
 * what the server actually exposes) is handed to the model as `toolConfig`,
 * and the model's `toolUse` block becomes the call. A model turn that
 * produces `text` instead of a tool call is treated as a spoken answer
 * (small talk, a clarifying question) rather than forced into a tool call.
 */
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import type { ContentBlock, Message, Tool } from '@aws-sdk/client-bedrock-runtime';
import type { DocumentType } from '@smithy/types';
import type { Interpretation } from './rules.js';

/** Our schemas and tool args are plain JSON; Bedrock's SDK just wants that asserted as its recursive `DocumentType`. */
const asDoc = (v: unknown): DocumentType => v as DocumentType;

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface Turn {
  role: 'user' | 'assistant';
  text?: string;
  toolCall?: { name: string; args: Record<string, unknown> };
  toolResult?: { name: string; spoken: string };
}

const SYSTEM = `You are the voice orchestrator for Dinner Bell, a kitchen-timing add-on. A person is talking to you while they cook. Decide which single Dinner Bell tool to call for their message, and with what arguments, using the tool descriptions to decide. Only call a tool when their message clearly asks for one of its actions; for greetings, thanks, or anything unrelated, reply with a short plain sentence instead of calling a tool. Never invent facts about the meal that were not returned by a tool. Keep any direct reply to one short sentence.`;

let cachedClient: BedrockRuntimeClient | undefined;
const client = (region: string): BedrockRuntimeClient => (cachedClient ??= new BedrockRuntimeClient({ region }));

export interface BedrockConfig {
  modelId: string;
  region: string;
}

export function bedrockConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BedrockConfig | undefined {
  const modelId = env.BEDROCK_MODEL_ID;
  if (!modelId) return undefined;
  return { modelId, region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? 'us-east-1' };
}

function toBedrockTools(tools: McpToolInfo[]): Tool[] {
  return tools.map((t) => ({
    toolSpec: {
      name: t.name,
      description: t.description?.slice(0, 4000) ?? t.name,
      inputSchema: { json: asDoc(t.inputSchema) },
    },
  }));
}

function toMessages(history: Turn[], utterance: string): Message[] {
  const messages: Message[] = [];
  for (const turn of history) {
    if (turn.role === 'user') {
      messages.push({ role: 'user', content: [{ text: turn.text ?? '' }] });
    } else if (turn.toolCall) {
      // Represent the assistant's earlier tool choice as Converse's toolUse content,
      // and its outcome as the paired toolResult — the shape the API requires for turn history.
      const toolUseId = `tu_${messages.length}`;
      messages.push({ role: 'assistant', content: [{ toolUse: { toolUseId, name: turn.toolCall.name, input: asDoc(turn.toolCall.args) } }] });
      messages.push({
        role: 'user',
        content: [{ toolResult: { toolUseId, content: [{ text: turn.toolResult?.spoken ?? '(no result)' }] } }],
      });
    } else if (turn.text) {
      messages.push({ role: 'assistant', content: [{ text: turn.text }] });
    }
  }
  messages.push({ role: 'user', content: [{ text: utterance }] });
  return messages;
}

export async function bedrockInterpret(cfg: BedrockConfig, tools: McpToolInfo[], history: Turn[], utterance: string): Promise<Interpretation> {
  const res = await client(cfg.region).send(
    new ConverseCommand({
      modelId: cfg.modelId,
      system: [{ text: SYSTEM }],
      messages: toMessages(history, utterance),
      toolConfig: { tools: toBedrockTools(tools) },
      inferenceConfig: { maxTokens: 400, temperature: 0.1 },
    }),
  );
  const blocks: ContentBlock[] = res.output?.message?.content ?? [];
  const toolUse = blocks.find((b) => 'toolUse' in b && b.toolUse)?.toolUse;
  if (toolUse?.name) {
    return { call: { name: toolUse.name, args: (toolUse.input as Record<string, unknown>) ?? {} } };
  }
  const text = blocks
    .map((b) => ('text' in b ? b.text : undefined))
    .filter((t): t is string => !!t)
    .join(' ')
    .trim();
  return { say: text || `I'm not sure what to do with that. Try "what's next?" or "plan Thanksgiving for ten at five".` };
}
