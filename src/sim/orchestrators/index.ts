/**
 * Picks the intent orchestrator: Bedrock when `BEDROCK_MODEL_ID` is set (the
 * AWS Builder path — the same decision Alexa+'s own model makes in
 * production, made here by a real Bedrock model over the live tool list),
 * the offline rule grammar otherwise. Both return the same `Interpretation`
 * shape, so the simulator and its tests never need to know which is active.
 */
import { bedrockConfigFromEnv, bedrockInterpret } from './bedrock.js';
import type { BedrockConfig, McpToolInfo, Turn } from './bedrock.js';
import { interpret } from './rules.js';
import type { Interpretation, PlanContext } from './rules.js';

export type { Interpretation, PlanContext, McpToolInfo, Turn };

export interface Orchestrator {
  readonly kind: 'bedrock' | 'rules';
  readonly modelId?: string;
  run(utterance: string, plan: PlanContext | undefined, history: Turn[], tools: McpToolInfo[]): Promise<Interpretation>;
}

class RuleOrchestrator implements Orchestrator {
  readonly kind = 'rules' as const;
  async run(utterance: string, plan: PlanContext | undefined, _history: Turn[], _tools: McpToolInfo[]): Promise<Interpretation> {
    return interpret(utterance, plan);
  }
}

class BedrockOrchestrator implements Orchestrator {
  readonly kind = 'bedrock' as const;
  readonly modelId: string;
  private fallback = new RuleOrchestrator();
  constructor(private cfg: BedrockConfig) {
    this.modelId = cfg.modelId;
  }
  async run(utterance: string, plan: PlanContext | undefined, history: Turn[], tools: McpToolInfo[]): Promise<Interpretation> {
    try {
      return await bedrockInterpret(this.cfg, tools, history, utterance);
    } catch (e) {
      // A model or network hiccup should degrade the demo, never break it.
      console.error('bedrock orchestrator failed, falling back to rules:', (e as Error).message);
      return this.fallback.run(utterance, plan, history, tools);
    }
  }
}

export function createOrchestrator(env: NodeJS.ProcessEnv = process.env): Orchestrator {
  const cfg = bedrockConfigFromEnv(env);
  return cfg ? new BedrockOrchestrator(cfg) : new RuleOrchestrator();
}
