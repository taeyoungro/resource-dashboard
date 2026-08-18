// The translation, and the one thing it must not do quietly.
//
//     npm run check
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConverseError, converseClient, converseInput, fromConverse } from './converse.js';
import { VERDICT_SCHEMA } from './riskAnalysis.js';

const BODY = {
  model: 'us.anthropic.claude-sonnet-4-6',
  max_tokens: 16000,
  thinking: { type: 'adaptive' },
  output_config: { effort: 'high', format: { type: 'json_schema', schema: VERDICT_SCHEMA } },
  system: [
    { type: 'text', text: 'frame', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'deployment', cache_control: { type: 'ephemeral' } },
  ],
  messages: [{ role: 'user', content: [
    { type: 'text', text: '<assessment_digest>…</assessment_digest>', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: '<candidates>…</candidates>' },
  ] }],
};

test('the system array and the user turn survive, and the model id moves to modelId', () => {
  const input = converseInput(BODY);
  assert.equal(input.modelId, 'us.anthropic.claude-sonnet-4-6');
  assert.deepEqual(input.system, [{ text: 'frame' }, { text: 'deployment' }]);
  assert.equal(input.messages.length, 1);
  assert.equal(input.messages[0].role, 'user');
  assert.deepEqual(input.messages[0].content.map((b) => b.text.slice(0, 12)),
                   ['<assessment_', '<candidates>']);
  assert.deepEqual(input.inferenceConfig, { maxTokens: 16000 });
});

test('the schema becomes a forced tool, because Converse has no output_config', () => {
  const { toolConfig } = converseInput(BODY);
  assert.equal(toolConfig.tools.length, 1);
  assert.equal(toolConfig.tools[0].toolSpec.name, 'record_verdicts');
  assert.deepEqual(toolConfig.tools[0].toolSpec.inputSchema.json, VERDICT_SCHEMA);
  assert.deepEqual(toolConfig.toolChoice, { tool: { name: 'record_verdicts' } });
  // The description is read even with toolChoice set, and it carries the instruction most often
  // lost when a schema is the only guidance.
  assert.match(toolConfig.tools[0].toolSpec.description, /every candidate/);
});

test('what Converse cannot carry is dropped, not translated into something else', () => {
  const input = converseInput(BODY);
  // Converse has no top-level thinking field. It goes through the one field reserved for
  // model-specific parameters, and the client retries once without it if the endpoint refuses it.
  assert.equal('thinking' in input, false);
  assert.deepEqual(input.additionalModelRequestFields, { thinking: { type: 'adaptive' } });
  // cachePoint is accepted by some models and rejected by others with a 400 on every request, so it
  // is not sent at all. The cost of that shows up in the usage line rather than as a surprise.
  assert.equal(JSON.stringify(input).includes('cachePoint'), false);
});

test('a forced tool call comes back as the text the caller parses', () => {
  const verdicts = { verdicts: [{ candidate_id: 'C1', real: true }] };
  const shaped = fromConverse({
    output: { message: { content: [{ toolUse: { name: 'record_verdicts', input: verdicts } }] } },
    stopReason: 'tool_use',
    usage: { inputTokens: 12000, outputTokens: 900, cacheReadInputTokens: 0 },
  });
  assert.equal(shaped.content[0].type, 'text');
  assert.deepEqual(JSON.parse(shaped.content[0].text), verdicts);
  assert.equal(shaped.usage.input_tokens, 12000);
  assert.equal(shaped.usage.output_tokens, 900);
});

test('a model that ignored the tool returns its prose, and the batch fails on the parse', () => {
  // Not repaired, and not coaxed. Support for forced tool use varies by model, and a loose parse
  // here would turn "this model cannot do structured output" into verdicts nobody wrote.
  const shaped = fromConverse({
    output: { message: { content: [{ text: 'I will explain in prose instead.' }] } },
    stopReason: 'end_turn',
    usage: {},
  });
  assert.equal(shaped.content[0].text, 'I will explain in prose instead.');
  assert.throws(() => JSON.parse(shaped.content[0].text));
});

test('an empty answer is an error rather than an empty verdict list', async () => {
  // The difference matters: no content is a failed batch, and an empty verdicts array would be
  // recorded as "the model judged these candidates and found nothing".
  const client = converseClient({
    send: async () => ({ output: { message: { content: [] } }, stopReason: 'max_tokens' }),
  });
  await assert.rejects(() => client.messages.create(BODY), ConverseError);
});

test('the client answers in the shape analyse() reads, so validation has no per-model branch', async () => {
  const client = converseClient({
    send: async (input) => {
      assert.equal(input.modelId, BODY.model);
      return {
        output: { message: { content: [{ toolUse: { input: { verdicts: [] } } }] } },
        stopReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 2 },
      };
    },
  });
  const answer = await client.messages.create(BODY);
  assert.equal(answer.content.find((b) => b.type === 'text').text, '{"verdicts":[]}');
  assert.equal(answer.usage.cache_read_input_tokens, 0);
});

test('a field the endpoint refuses is dropped once, and the request goes again', async () => {
  // The failure this exists for, in its own words: the analysis sent a first-party Anthropic body
  // to InvokeModel and every batch came back "extraneous key [output_config] is not permitted".
  // Whether an endpoint accepts an optional field is not knowable from here, so it is not assumed.
  const sent = [];
  let degraded = null;
  const client = converseClient({
    send: async (input) => {
      sent.push(input);
      if (input.additionalModelRequestFields) {
        const error = new Error('Malformed input request: #: extraneous key [thinking] is not '
          + 'permitted, please reformat your input and try again.');
        error.$metadata = { httpStatusCode: 400 };
        throw error;
      }
      return { output: { message: { content: [{ toolUse: { input: { verdicts: [] } } }] } },
               stopReason: 'tool_use', usage: {} };
    },
    onDegrade: (event) => { degraded = event; },
  });

  const answer = await client.messages.create({ ...BODY, model: 'us.anthropic.claude-sonnet-4-6' });
  assert.equal(sent.length, 2);
  assert.ok(sent[0].additionalModelRequestFields, 'the first attempt did not carry the field');
  assert.equal('additionalModelRequestFields' in sent[1], false);
  assert.equal(answer.content[0].text, '{"verdicts":[]}');
  // Reported rather than swallowed: the run answered under a different configuration from the one
  // it asked for, and the log is where somebody finds out why the answers changed.
  assert.deepEqual(degraded.dropped, { thinking: { type: 'adaptive' } });
});

test('a refusal that is not about a field is not retried', async () => {
  // Sending less cannot fix a throttle, a denial or a model that is not enabled, and a blind retry
  // would double the cost of every outage.
  for (const [status, message] of [[403, 'not authorized to perform: bedrock:InvokeModel'],
                                   [429, 'Too many requests'],
                                   [400, 'The provided model identifier is invalid']]) {
    let calls = 0;
    const client = converseClient({
      send: async () => {
        calls += 1;
        const error = new Error(message);
        error.$metadata = { httpStatusCode: status };
        throw error;
      },
    });
    await assert.rejects(() => client.messages.create({ ...BODY, model: 'us.anthropic.claude-sonnet-4-6' }));
    assert.equal(calls, 1, `${status} was retried`);
  }
});

test('adaptive thinking rides along, and is absent when the request does not ask for one', () => {
  // It travels in additionalModelRequestFields rather than at the top level, because Converse has
  // no field of its own for it. A request without it must not grow an empty one - an endpoint that
  // rejects the field would then reject every request over something nobody asked for.
  const asked = converseInput(BODY);
  assert.deepEqual(asked.additionalModelRequestFields, { thinking: { type: 'adaptive' } });
  const { thinking, ...plain } = BODY;
  assert.equal('additionalModelRequestFields' in converseInput(plain), false);
});
