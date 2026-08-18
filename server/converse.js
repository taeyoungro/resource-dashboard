// Every other model on Bedrock, behind the same interface the Anthropic client offers.
//
// Why this exists: the analysis speaks one shape - an Anthropic Messages request with a system
// array, a user turn, and a JSON schema for the answer - and @anthropic-ai/bedrock-sdk only carries
// that shape to Anthropic models. A deployment waiting on Anthropic model access, or one that has
// settled on Nova or Llama, needs the same analysis to run against a model that does not speak it.
//
// Bedrock's Converse API is the model-agnostic surface, so this translates between the two. The
// translation is small, and stating what it CANNOT carry matters more than what it can:
//
//   structured output   Converse has no output_config. A forced tool call does the same job - the
//                       schema becomes a tool's input schema and toolChoice makes the model use it
//                       - and the tool's input IS the answer. Support for forced tool use varies by
//                       model, so a model that ignores toolChoice produces prose and the batch is
//                       reported as failed rather than parsed loosely
//   adaptive thinking   Anthropic-only. Dropped, not emulated
//   prompt caching      cachePoint is supported by some models and rejected by others, and the
//                       failure is a 400 on every request rather than a silent cost. So it is not
//                       sent here at all: the frame and the digest are paid for on every batch, and
//                       what that costs is visible in the usage line rather than guessed at
//
// The adapter returns the Anthropic response shape - content blocks and a usage object - so
// analyse() and everything it feeds cannot tell which client answered. That is deliberate: the
// validation is what makes a model's answer usable, and it must not have a per-model branch in it.

export class ConverseError extends Error {}

/** The tool a schema becomes. One name, used in the request and read back out of the answer. */
const TOOL = 'record_verdicts';

/** Anthropic-shaped body in, Converse command input out. */
export function converseInput(body) {
  const system = (body.system ?? [])
    .filter((block) => block?.type === 'text' && block.text)
    .map((block) => ({ text: block.text }));

  const messages = (body.messages ?? []).map((message) => ({
    role: message.role,
    content: (Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content }])
      .filter((block) => block?.type === 'text' && block.text)
      .map((block) => ({ text: block.text })),
  }));

  const input = {
    modelId: body.model,
    system,
    messages,
    inferenceConfig: { maxTokens: body.max_tokens },
  };

  const schema = body.output_config?.format?.schema;
  if (schema) {
    input.toolConfig = {
      tools: [{
        toolSpec: {
          name: TOOL,
          // Converse requires a description, and this one is load-bearing rather than decorative:
          // with toolChoice set the model still reads it, and "answer for every candidate" is the
          // instruction most often dropped when a schema is the only guidance.
          description: 'Record one verdict for every candidate you were given, including the ones '
            + 'you find are not real paths.',
          inputSchema: { json: schema },
        },
      }],
      toolChoice: { tool: { name: TOOL } },
    };
  }
  return input;
}

/** Converse output back into the Anthropic response shape. */
export function fromConverse(answer) {
  const blocks = answer?.output?.message?.content ?? [];
  const content = [];
  for (const block of blocks) {
    // The forced tool call IS the answer. Serialised back to text because that is what the caller
    // parses, and because a caller that received an object could not tell a parsed answer from a
    // repaired one.
    if (block.toolUse?.input !== undefined) {
      content.push({ type: 'text', text: JSON.stringify(block.toolUse.input) });
    } else if (typeof block.text === 'string') {
      content.push({ type: 'text', text: block.text });
    }
  }
  const usage = answer?.usage ?? {};
  return {
    content,
    stop_reason: answer?.stopReason ?? null,
    usage: {
      input_tokens: usage.inputTokens ?? 0,
      output_tokens: usage.outputTokens ?? 0,
      cache_read_input_tokens: usage.cacheReadInputTokens ?? 0,
      cache_creation_input_tokens: usage.cacheWriteInputTokens ?? 0,
    },
  };
}

/**
 * A client shaped like the Anthropic one, talking Converse underneath.
 *
 * `send` is injected so the translation is testable without the network and without the AWS SDK -
 * in production it is a BedrockRuntimeClient's send, bound to a ConverseCommand.
 */
export function converseClient({ send }) {
  return {
    messages: {
      async create(body) {
        const answer = await send(converseInput(body));
        const shaped = fromConverse(answer);
        if (shaped.content.length === 0) {
          throw new ConverseError(`the model returned no content (stop reason: ${shaped.stop_reason})`);
        }
        return shaped;
      },
    },
  };
}

/** The production client. Imported lazily, like the Anthropic one, for the same reason. */
export async function bedrockConverse({ region }) {
  let BedrockRuntimeClient;
  let ConverseCommand;
  try {
    ({ BedrockRuntimeClient, ConverseCommand } = await import('@aws-sdk/client-bedrock-runtime'));
  } catch (error) {
    throw new ConverseError('@aws-sdk/client-bedrock-runtime is not installed, so a non-Anthropic '
      + `model cannot be called: ${error.message}`);
  }
  const client = new BedrockRuntimeClient({ region });
  return converseClient({ send: (input) => client.send(new ConverseCommand(input)) });
}
