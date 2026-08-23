// The translation, and the one thing it must not do quietly.
//
//     npm run check
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ConverseError, converseClient, converseInput, fromConverse, hasCachePoint,
} from './converse.js';
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
  assert.deepEqual(input.system.filter((b) => b.text), [{ text: 'frame' }, { text: 'deployment' }]);
  assert.equal(input.messages.length, 1);
  assert.equal(input.messages[0].role, 'user');
  assert.deepEqual(input.messages[0].content.filter((b) => b.text).map((b) => b.text.slice(0, 12)),
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
});

test('a marked block becomes the block plus a cache point AFTER it', () => {
  // The placement is the whole of it. cache_control is a property of the block it applies to;
  // cachePoint is a block of its own that ENDS the prefix before it. Put one before the content it
  // was meant to cover and the cached prefix is everything except that content.
  const input = converseInput(BODY);
  assert.deepEqual(input.system, [
    { text: 'frame' }, { cachePoint: { type: 'default' } },
    { text: 'deployment' }, { cachePoint: { type: 'default' } },
  ]);
  const content = input.messages[0].content;
  assert.match(content[0].text, /assessment_digest/);
  assert.deepEqual(content[1], { cachePoint: { type: 'default' } });
  // The batch is last and unmarked: it differs every request, so a marker there would write an
  // entry per batch that nothing ever reads.
  assert.match(content[2].text, /candidates/);
  assert.equal(content.length, 3);
  assert.equal(hasCachePoint(input), true);
});

test('cache markers can be turned off without changing anything else', () => {
  const on = converseInput(BODY);
  const off = converseInput(BODY, { cache: false });
  assert.equal(hasCachePoint(off), false);
  assert.deepEqual(off.system, on.system.filter((b) => b.text));
  assert.deepEqual(off.messages[0].content, on.messages[0].content.filter((b) => b.text));
  assert.deepEqual(off.toolConfig, on.toolConfig);
  assert.deepEqual(off.additionalModelRequestFields, on.additionalModelRequestFields);
});

test('a schema turns thinking off, explicitly, because the two cannot both be set', () => {
  // The test that would have caught it. BODY asks for adaptive thinking AND carries a schema, and
  // the schema travels as a FORCED tool call - a combination Bedrock refuses outright:
  //
  //     Thinking may not be enabled when tool_choice forces tool use.
  //
  // Every batch of a deployed run came back that way, ten candidates at a time with no verdicts.
  const input = converseInput(BODY);
  assert.deepEqual(input.toolChoice ?? input.toolConfig.toolChoice, { tool: { name: 'record_verdicts' } });
  assert.deepEqual(input.additionalModelRequestFields, { thinking: { type: 'disabled' } },
                   'a forced tool choice was sent with thinking not explicitly disabled');
  // SENT and set to disabled, not left out. Bedrock wants the conflict resolved rather than
  // implied, and omitting the field is a different request from turning the feature off.
  assert.ok('additionalModelRequestFields' in input,
            'the field was dropped instead of being set to disabled');
});

test('without a forced tool the request keeps the thinking it asked for', () => {
  // The rule is about the COMBINATION, not about thinking. A request with no schema has no forced
  // tool choice and nothing to conflict with, so what it asked for travels unchanged.
  const { output_config: schema, ...prose } = BODY;
  assert.deepEqual(converseInput(prose).additionalModelRequestFields,
                   { thinking: { type: 'adaptive' } });
  // And a request that asked for neither must not grow an empty field: an endpoint that rejects
  // the field would then reject every request over something nobody asked for.
  const { thinking, ...plain } = prose;
  assert.equal('additionalModelRequestFields' in converseInput(plain), false);
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
  // Two rungs, cheapest first. The markers go before the model-specific block because dropping
  // them changes only the price - the same bytes are sent - while dropping the block changes what
  // the model was asked to do. So a refusal of the block costs one wasted attempt, and a refusal
  // of the markers costs none.
  assert.equal(sent.length, 3);
  assert.ok(hasCachePoint(sent[0]), 'the first attempt did not carry the markers');
  assert.equal(hasCachePoint(sent[1]), false);
  assert.ok(sent[1].additionalModelRequestFields, 'the second attempt gave up two things at once');
  assert.equal('additionalModelRequestFields' in sent[2], false);
  assert.equal(answer.content[0].text, '{"verdicts":[]}');
  // Reported rather than swallowed: the run answered under a different configuration from the one
  // it asked for, and the log is where somebody finds out why the answers changed.
  assert.deepEqual(degraded.dropped, { thinking: { type: 'disabled' } });
});

test('an endpoint that refuses cache markers is asked without them, once and then always', async () => {
  // Whether a region and a model take cachePoint is a property of the endpoint, not of a request.
  // Retrying it per batch would buy one wasted call on every batch of every analysis, which is the
  // shape of failure the markers were added to remove.
  const sent = [];
  const degraded = [];
  const client = converseClient({
    send: async (input) => {
      sent.push(input);
      if (hasCachePoint(input)) {
        const error = new Error('The model returned the following errors: cachePoint is not '
          + 'supported for this model.');
        error.$metadata = { httpStatusCode: 400 };
        throw error;
      }
      return { output: { message: { content: [{ toolUse: { input: { verdicts: [] } } }] } },
               stopReason: 'tool_use', usage: {} };
    },
    onDegrade: (event) => { degraded.push(event); },
  });

  await client.messages.create(BODY);
  await client.messages.create(BODY);
  await client.messages.create(BODY);
  assert.equal(sent.length, 4, 'the markers were tried again after being refused');
  assert.deepEqual(sent.map(hasCachePoint), [true, false, false, false]);
  assert.equal(degraded.length, 1);
  assert.deepEqual(degraded[0].dropped, { cachePoint: true });
});

test('a refusal that is not about caching does not turn caching off for good', async () => {
  // The markers are given up first because losing them is free, which means they are given up on
  // refusals that have nothing to do with them. Making that stick would be a silent and permanent
  // doubling of the bill on the strength of one unrelated 400.
  const sent = [];
  let failFirst = true;
  const client = converseClient({
    send: async (input) => {
      sent.push(input);
      if (failFirst) {
        failFirst = false;
        const error = new Error('Malformed input request: #: extraneous key [speed] is not '
          + 'permitted.');
        error.$metadata = { httpStatusCode: 400 };
        throw error;
      }
      return { output: { message: { content: [{ toolUse: { input: { verdicts: [] } } }] } },
               stopReason: 'tool_use', usage: {} };
    },
  });

  await client.messages.create(BODY);
  await client.messages.create(BODY);
  assert.deepEqual(sent.map(hasCachePoint), [true, false, true]);
});

test('a refusal that is not about a field is not retried', async () => {
  // Sending less cannot fix a denial or a model that is not enabled, and a blind retry would double
  // the cost of every outage. A throttle is the exception and is tested separately below: it is
  // fixed by sending the SAME thing after a wait, which is a different move from sending less.
  for (const [status, message] of [[403, 'not authorized to perform: bedrock:InvokeModel'],
                                   [400, 'The provided model identifier is invalid'],
                                   [400, 'The model returned an unexpected answer']]) {
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

test('a refusal about two fields conflicting is retried, not just an unknown one', () => {
  // The retry existed and sat there. Its list only recognised fields nobody had heard of -
  // "extraneous key", "unknown field" - so "Thinking may not be enabled when tool_choice forces
  // tool use", which is a conflict between two fields the endpoint knows perfectly well, read as
  // an ordinary refusal and every batch was lost.
  //
  // The primary path no longer produces that combination. This is the backstop for the next
  // conflict, which will be worded differently and will not be predicted here either.
  let calls = 0;
  const client = converseClient({
    send: async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error('Thinking may not be enabled when tool_choice forces tool use.');
        error.$metadata = { httpStatusCode: 400 };
        throw error;
      }
      return { output: { message: { content: [{ toolUse: { input: { verdicts: [] } } }] } },
               stopReason: 'tool_use', usage: {} };
    },
  });
  return client.messages.create(BODY).then((answer) => {
    assert.equal(calls, 2, 'the conflict was not retried');
    assert.equal(answer.content[0].text, '{"verdicts":[]}');
  });
});


// ---- throttling, which is what concurrency buys -------------------------------------------------

/** A send that throttles the first `n` calls, then answers. */
function throttlingSend(n, { status = 429, name = 'ThrottlingException' } = {}) {
  const state = { calls: 0 };
  state.send = async () => {
    state.calls += 1;
    if (state.calls <= n) {
      const error = new Error('Too many requests, please wait before trying again.');
      error.$metadata = { httpStatusCode: status };
      error.name = name;
      throw error;
    }
    return { output: { message: { content: [{ toolUse: { input: { verdicts: [] } } }] } },
             stopReason: 'tool_use', usage: {} };
  };
  return state;
}

test('a throttle is retried with the same request, after a wait', async () => {
  // The analysis sends its batches together now - six requests at once against one account's token
  // budget is exactly the shape that gets throttled. A throttle that is not retried costs the
  // candidates in that batch and reports them as failed, which is a worse answer for no reason:
  // unlike a refused field, this one IS fixed by asking again.
  const waits = [];
  const state = throttlingSend(2);
  const client = converseClient({
    send: state.send,
    sleep: async (ms) => { waits.push(ms); },
    onRetry: ({ attempt, waitMs }) => waits.push(`reported ${attempt}@${waitMs}`),
  });
  const answer = await client.messages.create(BODY);
  assert.equal(state.calls, 3, 'the throttle was not retried twice');
  assert.equal(answer.content[0].text, '{"verdicts":[]}');
  // Backoff, and reported. A run that spent half its budget waiting is a run whose concurrency is
  // too high for the account, and the log line is the only place that would say so.
  assert.deepEqual(waits, ['reported 1@400', 400, 'reported 2@800', 800]);
});

test('a throttle that never clears is given up on rather than retried forever', async () => {
  // Bounded. The deadline in analyse() is the outer bound, but a client that retried without a cap
  // would sit inside one batch spending the whole budget on it.
  const state = throttlingSend(99);
  const client = converseClient({ send: state.send, sleep: async () => {}, retries: 2 });
  await assert.rejects(() => client.messages.create(BODY), /Too many requests/);
  assert.equal(state.calls, 3, 'the retry cap did not hold');
});

test('a throttle is recognised by name as well as by status', async () => {
  // The SDK does not always carry a status on a throttle - it does always carry the name.
  const state = throttlingSend(1, { status: undefined, name: 'ThrottlingException' });
  const client = converseClient({ send: state.send, sleep: async () => {} });
  await client.messages.create(BODY);
  assert.equal(state.calls, 2);
});
