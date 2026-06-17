// Pluggable summarizer backends. See SPEC.md §6.
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Config } from "./config.js";

export interface SummarizeInput {
  prompt: string;
  maxTokens?: number;
}

export interface Summarizer {
  readonly kind: string;
  summarize(input: SummarizeInput): Promise<string>;
}

/** Calls an OpenAI-compatible /chat/completions endpoint (Ollama, vLLM, etc.). Host-agnostic. */
export class DirectSummarizer implements Summarizer {
  readonly kind = "direct";
  constructor(private cfg: Config) {}

  async summarize({ prompt, maxTokens = 2048 }: SummarizeInput): Promise<string> {
    const url = `${this.cfg.llm.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.cfg.llm.apiKey) headers.Authorization = `Bearer ${this.cfg.llm.apiKey}`;
    // Custom headers win — covers Azure (`api-key`), gateway tokens, tenant routing, etc.
    Object.assign(headers, this.cfg.llm.headers);

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.cfg.llm.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
        temperature: 0.2,
        stream: false,
      }),
    });
    if (!res.ok) {
      throw new Error(`E_SUMMARIZER_UNAVAILABLE: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = json.choices?.[0]?.message?.content;
    if (!text) throw new Error("E_SUMMARIZER_UNAVAILABLE: empty completion");
    return text;
  }
}

/** Delegates the completion to the host via MCP sampling. Needs a sampling-capable client. */
export class SamplingSummarizer implements Summarizer {
  readonly kind = "sampling";
  constructor(private lowLevel: Server) {}

  async summarize({ prompt, maxTokens = 2048 }: SummarizeInput): Promise<string> {
    const result = await this.lowLevel.createMessage({
      messages: [{ role: "user", content: { type: "text", text: prompt } }],
      maxTokens,
      // Bias the host toward a cheaper/faster model for summarization.
      modelPreferences: { speedPriority: 0.6, intelligencePriority: 0.5 },
    });
    return result.content.type === "text" ? result.content.text : "";
  }
}

/**
 * Build the active summarizer.
 * - `direct`   → always DirectSummarizer
 * - `sampling` → SamplingSummarizer (throws at call time if host lacks support)
 * - `auto`     → SamplingSummarizer when the connected client advertised sampling, else Direct
 */
export function makeSummarizer(cfg: Config, lowLevel: Server): Summarizer {
  if (cfg.summarizer === "direct") return new DirectSummarizer(cfg);
  if (cfg.summarizer === "sampling") return new SamplingSummarizer(lowLevel);

  const caps = lowLevel.getClientCapabilities();
  return caps?.sampling
    ? new SamplingSummarizer(lowLevel)
    : new DirectSummarizer(cfg);
}
