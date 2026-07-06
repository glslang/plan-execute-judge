import type { Query } from "@anthropic-ai/claude-agent-sdk";

/**
 * Drains a query() stream, optionally logging assistant text as it arrives
 * (useful when you're watching a run rather than piping it), and returns the
 * final result message. Throws if the phase didn't end in "success" -- a
 * phase that hit max_turns or errored mid-execution should stop the
 * pipeline, not be silently treated as done.
 */
export async function runPhase(stream: Query, opts: { label: string; verbose?: boolean }) {
  for await (const message of stream) {
    if (opts.verbose && message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") process.stdout.write(block.text);
      }
    }
    if (message.type === "result") {
      if (message.subtype !== "success") {
        throw new Error(`[${opts.label}] phase ended with subtype "${message.subtype}"`);
      }
      return message;
    }
  }
  throw new Error(`[${opts.label}] phase produced no result message`);
}
