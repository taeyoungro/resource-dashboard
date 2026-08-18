// How every model on Bedrock is called: one request shape, whoever answers.
//
// The analysis is written as an Anthropic Messages request - a system array, a user turn, and a
// JSON schema for the answer - because that is the shape the design is stated in. Bedrock does not
// take that shape. It was sent anyway, through @anthropic-ai/bedrock-sdk, and every batch came back
//
//     400 Malformed input request: #: extraneous key [output_config] is not permitted
//
// because InvokeModel on bedrock-runtime validates a narrower body than the first-party API does.
// So this translates instead, to Converse, which is the model-agnostic surface and which takes a
// schema as a tool. The translation is small, and stating what it CANNOT carry matters more than
// what it can:
//
//   structured output   Converse has no output_config. A forced tool call does the same job - the
//                       schema becomes a tool's input schema and toolChoice makes the model use it
//                       - and the tool's input IS the answer. This is also the reason the model is
//                       not a free choice: one that ignores toolChoice produces prose, and that
//                       batch is reported as failed rather than parsed loosely
//   adaptive thinking   passed through Converse's own field for model-specific parameters, and
//                       dropped with one retry if the endpoint refuses it - whether a given region
//                       accepts one is not knowable from here and is therefore not assumed
//   prompt caching      cachePoint is supported by some models and rejected by others, and the
//                       failure is a 400 on every request rather than a silent cost. So it is not
//                       sent here at all: the frame and the digest are paid for on every batch, and
//                       what that costs is visible in the usage line rather than guessed at
//
// The adapter returns the Anthropic response shape - content blocks and a usage object - so
// analyse() and everything it feeds does not know how the answer was carried. That is deliberate:
// the validation is what makes a model's answer usable, and it must not depend on the transport.

export class ConverseError extends Error {}

/**
 * Whether a failure is the endpoint refusing a field rather than refusing the request.
 *
 * The distinction is worth drawing because only the first is recoverable by sending less. This
 * pipeline learned it the expensive way: output_config went to InvokeModel because a wire probe
 * proved the SDK PASSED it, which is not the same as proving Bedrock ACCEPTED it, and every batch
 * came back "extraneous key [output_config] is not permitted".
 */
function refusesAField(error) {
  const text = `${error?.message ?? ''}`;
  const status = error?.$metadata?.httpStatusCode ?? error?.status;
  if (status && status !== 400) return false;
  return /extraneous key|unsupported|not permitted|unknown field|validation/i.test(text);
}

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

  // Model-specific parameters go through the one field Converse reserves for them. Whether the
  // endpoint accepts this one is not knowable from here - it varies by region as well as by model
  // - so it is not assumed: the client below retries once without this field when the answer is a
  // 400 about a field it does not know.
  if (body.thinking) {
    input.additionalModelRequestFields = { thinking: body.thinking };
  }

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
export function converseClient({ send, onDegrade = null }) {
  async function ask(input) {
    const shaped = fromConverse(await send(input));
    if (shaped.content.length === 0) {
      throw new ConverseError(`the model returned no content (stop reason: ${shaped.stop_reason})`);
    }
    return shaped;
  }

  return {
    messages: {
      async create(body) {
        const input = converseInput(body);
        try {
          return await ask(input);
        } catch (error) {
          // One retry, and only for the one thing sending less can fix. The optional field is the
          // model-specific block; everything else in the request is the analysis itself, and
          // retrying without a piece of that would be answering a different question quietly.
          if (!input.additionalModelRequestFields || !refusesAField(error)) throw error;
          const { additionalModelRequestFields: dropped, ...plain } = input;
          if (onDegrade) onDegrade({ dropped, why: error.message });
          return ask(plain);
        }
      },
    },
  };
}

/** The production client. Imported lazily, like the Anthropic one, for the same reason. */
export async function bedrockConverse({ region, onDegrade = null }) {
  let BedrockRuntimeClient;
  let ConverseCommand;
  try {
    ({ BedrockRuntimeClient, ConverseCommand } = await import('@aws-sdk/client-bedrock-runtime'));
  } catch (error) {
    throw new ConverseError('@aws-sdk/client-bedrock-runtime is not installed, so a non-Anthropic '
      + `model cannot be called: ${error.message}`);
  }
  const client = new BedrockRuntimeClient({ region });
  return converseClient({ send: (input) => client.send(new ConverseCommand(input)), onDegrade });
}
