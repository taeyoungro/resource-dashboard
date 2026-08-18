// The translation, and the one thing it must not do quietly.
//
//     npm run check
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConverseError, converseClient, converseInput, fromConverse } from './converse.js';
import { VERDICT_SCHEMA, isAnthropicModel } from './riskAnalysis.js';

const BODY = {
  model: 'us.amazon.nova-pro-v1:0',
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

test('the model id decides the client, on the provider segment and not on a substring', () => {
  // A 400 about a request body is what a wrong choice produces, and nothing in it names the model.
  assert.ok(isAnthropicModel('anthropic.claude-sonnet-5'));
  assert.ok(isAnthropicModel('us.anthropic.claude-sonnet-5'));
  assert.ok(isAnthropicModel('global.anthropic.claude-opus-4-6-v1'));
  assert.ok(!isAnthropicModel('us.amazon.nova-pro-v1:0'));
  assert.ok(!isAnthropicModel('meta.llama3-70b-instruct-v1:0'));
  // A profile somebody named after the team rather than the provider.
  assert.ok(!isAnthropicModel('anthropic-eval.amazon.nova-pro-v1:0'));
  assert.ok(!isAnthropicModel(''));
});

test('the system array and the user turn survive, and the model id moves to modelId', () => {
  const input = converseInput(BODY);
  assert.equal(input.modelId, 'us.amazon.nova-pro-v1:0');
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
  // Adaptive thinking is Anthropic's. Emulating it with a temperature or a preamble would be
  // inventing a feature the model does not have.
  assert.equal('thinking' in input, false);
  assert.equal('additionalModelRequestFields' in input, false);
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
