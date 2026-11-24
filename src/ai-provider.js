const MAX_BYTES = 1024 * 1024;
const SAFE = Symbol('assetdesk-ai-safe-error');
const ENDPOINTS = Object.freeze({ openai: 'https://api.openai.com/v1/', anthropic: 'https://api.anthropic.com/v1/' });
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = (message, statusCode = 400, extra = {}) => Object.assign(new Error(message), { statusCode, safeMessage: message, [SAFE]: true, ...extra });
const string = (maxLength, minLength = 0) => ({ type: 'string', minLength, maxLength });
const strings = (maxItems, maxLength, minLength = 1) => ({ type: 'array', maxItems, items: string(maxLength, minLength) });

export const AI_OUTPUT_SCHEMAS = Object.freeze({
  triage: { type: 'object', additionalProperties: false, required: ['tags', 'asset_mentions'], properties: { tags: strings(20, 50), asset_mentions: strings(50, 200) } },
  reply: { type: 'object', additionalProperties: false, required: ['needs_information', 'questions', 'body'], properties: { needs_information: { type: 'boolean' }, questions: strings(8, 1000), body: string(8000) } },
  suggestions: { type: 'object', additionalProperties: false, required: ['summary', 'steps', 'article_ids'], properties: { summary: string(4000), steps: strings(12, 2000), article_ids: strings(10, 100) } },
  summary: { type: 'object', additionalProperties: false, required: ['summary', 'highlights'], properties: { summary: string(6000, 1), highlights: { type: 'array', maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['ticket_key', 'text'], properties: { ticket_key: string(100, 1), text: string(1000, 1) } } } } },
  related: { type: 'object', additionalProperties: false, required: ['recent_tickets', 'asset_issues'], properties: {
    recent_tickets: { type: 'array', maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['ticket_key', 'reason'], properties: { ticket_key: string(100, 1), reason: string(1500, 1) } } },
    asset_issues: { type: 'array', maxItems: 12, items: { type: 'object', additionalProperties: false, required: ['asset_id', 'ticket_key', 'reason'], properties: { asset_id: string(100, 1), ticket_key: string(100, 1), reason: string(1500, 1) } } },
  } },
});

// OpenAI structured-output support varies between model families. Keep its
// wire schema to the common structural subset and enforce every size bound
// locally before a review can be used by the ticket processor.
function openAiSchema(schema) {
  return { type: schema.type,
    ...(schema.properties ? { properties: Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, openAiSchema(value)])) } : {}),
    ...(schema.items ? { items: openAiSchema(schema.items) } : {}),
    ...(schema.required ? { required: [...schema.required] } : {}),
    ...(Object.hasOwn(schema, 'additionalProperties') ? { additionalProperties: schema.additionalProperties } : {}),
  };
}
const OPENAI_OUTPUT_SCHEMAS = Object.freeze(Object.fromEntries(Object.entries(AI_OUTPUT_SCHEMAS).map(([kind, schema]) => [kind, openAiSchema(schema)])));

function options({ provider, apiKey, model }) {
  if (!Object.hasOwn(ENDPOINTS, provider)) throw fail('Choose OpenAI or Claude as the AI provider.');
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw fail('Configure an API key for the selected AI provider.', 409, { blocked: true });
  if (apiKey.length > 8192 || /\s|[\x00-\x1f\x7f-\x9f]/u.test(apiKey.trim())) throw fail('Provide a valid AI provider API key.');
  if (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(model)) throw fail('Choose a valid AI model identifier.');
  return { provider, apiKey: apiKey.trim(), model };
}
function promptText(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 12000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u.test(value)) throw fail('AI prompts must contain between 1 and 12,000 valid characters.');
  return value;
}
function resultText(value, maximum, { empty = false, multiline = true } = {}) {
  const controls = multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u : /[\x00-\x1f\x7f-\x9f]/u;
  if (typeof value !== 'string' || [...value].length > maximum || controls.test(value) || (!empty && !value.trim())) throw fail('The AI provider returned an invalid review. Review the prompts and try again.', 502);
  return value.replace(/\r\n?/gu, '\n').trim();
}
function resultList(value, maximum, maxLength, multiline = false) {
  if (!Array.isArray(value) || value.length > maximum) throw fail('The AI provider returned an invalid review. Review the prompts and try again.', 502);
  return value.map(item => resultText(item, maxLength, { multiline }));
}
/** Validate the entire object before any result can reach ticket mutations. */
export function validateAiResult(kind, input) {
  const schema = Object.hasOwn(AI_OUTPUT_SCHEMAS, kind) && AI_OUTPUT_SCHEMAS[kind];
  if (!schema) throw fail('Choose a supported AI review type.');
  if (!plain(input) || Object.keys(input).length !== schema.required.length || schema.required.some(key => !Object.hasOwn(input, key)) || Object.keys(input).some(key => !schema.required.includes(key))) throw fail('The AI provider returned an invalid review. Review the prompts and try again.', 502);
  if (kind === 'triage') return { tags: resultList(input.tags, 20, 50), asset_mentions: resultList(input.asset_mentions, 50, 200) };
  if (kind === 'reply') {
    if (typeof input.needs_information !== 'boolean') throw fail('The AI provider returned an invalid review. Review the prompts and try again.', 502);
    const questions = resultList(input.questions, 8, 1000, true), body = resultText(input.body, 8000, { empty: !input.needs_information });
    if (input.needs_information && !questions.length) throw fail('The AI provider did not provide the missing-information questions. Review the reply prompt and try again.', 502);
    return { needs_information: input.needs_information, questions, body };
  }
  if (kind === 'summary') {
    if (!Array.isArray(input.highlights) || input.highlights.length > 8) throw fail('The AI provider returned an invalid review. Review the prompts and try again.', 502);
    const highlights = input.highlights.map(item => {
      if (!plain(item) || Object.keys(item).length !== 2 || !Object.hasOwn(item, 'ticket_key') || !Object.hasOwn(item, 'text')) throw fail('The AI provider returned an invalid review. Review the prompts and try again.', 502);
      const ticket_key = resultText(item.ticket_key, 100, { multiline: false });
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(ticket_key)) throw fail('The AI provider returned invalid ticket references.', 502);
      return { ticket_key, text: resultText(item.text, 1000) };
    });
    return { summary: resultText(input.summary, 6000), highlights };
  }
  if (kind === 'related') {
    const references = (values, maximum, ids) => {
      if (!Array.isArray(values) || values.length > maximum) throw fail('The AI provider returned an invalid review. Review the prompts and try again.', 502);
      return values.map(item => {
        const fields = [...ids, 'reason'];
        if (!plain(item) || Object.keys(item).length !== fields.length || fields.some(key => !Object.hasOwn(item, key))) throw fail('The AI provider returned an invalid review. Review the prompts and try again.', 502);
        const result = {};
        for (const id of ids) {
          const value = resultText(item[id], 100, { multiline: false });
          if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value)) throw fail('The AI provider returned invalid related-ticket references.', 502);
          result[id] = value;
        }
        return { ...result, reason: resultText(item.reason, 1500) };
      });
    };
    return { recent_tickets: references(input.recent_tickets, 8, ['ticket_key']), asset_issues: references(input.asset_issues, 12, ['asset_id', 'ticket_key']) };
  }
  const article_ids = resultList(input.article_ids, 10, 100);
  if (article_ids.some(id => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(id))) throw fail('The AI provider returned invalid documentation references.', 502);
  return { summary: resultText(input.summary, 4000, { empty: true }), steps: resultList(input.steps, 12, 2000, true), article_ids };
}

function untilAborted(promise, signal) {
  if (signal.aborted) return Promise.reject(fail('The AI provider request timed out. Try again later.', 504, { retryable: true }));
  return new Promise((resolve, reject) => {
    const abort = () => reject(fail('The AI provider request timed out. Try again later.', 504, { retryable: true }));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
async function jsonResponse(response, signal) {
  if (Number(response.headers?.get?.('content-length')) > MAX_BYTES) { response.body?.cancel().catch(() => {}); throw fail('The AI provider response exceeded the size limit.', 502); }
  if (!response.body || typeof response.body.getReader !== 'function') throw fail('The AI provider returned an invalid response.', 502);
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await untilAborted(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw fail('The AI provider response exceeded the size limit.', 502);
      chunks.push(value);
    }
  } catch (error) { reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
  catch { throw fail('The AI provider returned invalid JSON.', 502); }
}

/** Fixed-provider HTTPS requests. Keys and remote response bodies never enter errors. */
export class AiProviders {
  #fetch; #timeoutMs;
  constructor({ fetchImpl = fetch, timeoutMs = 20000 } = {}) {
    if (typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) throw fail('AI request timeouts must be between 100 and 60,000 milliseconds.');
    this.#fetch = fetchImpl; this.#timeoutMs = timeoutMs;
  }
  async #request(provider, apiKey, path, body) {
    const headers = provider === 'openai' ? { Authorization: `Bearer ${apiKey}` } : { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
    let encoded;
    if (body !== undefined) {
      try { encoded = JSON.stringify(body); } catch { throw fail('The AI review context cannot be serialized.'); }
      if (Buffer.byteLength(encoded) > MAX_BYTES) throw fail('The AI review context exceeded the one-megabyte limit.');
      headers['Content-Type'] = 'application/json';
    }
    const controller = new AbortController(), signal = controller.signal;
    const deadline = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await untilAborted(this.#fetch(ENDPOINTS[provider] + path, { method: body === undefined ? 'GET' : 'POST', headers, ...(encoded === undefined ? {} : { body: encoded }), signal, redirect: 'error' }), signal);
      if (response.status < 200 || response.status > 299) {
        response.body?.cancel().catch(() => {});
        if ([401, 403].includes(response.status)) throw fail('The AI provider rejected the API key or its account permissions. Check the saved connection.', 409, { blocked: true });
        if (response.status === 429) throw fail('The AI provider rate limit was reached. Try again later.', 429, { retryable: true });
        if ([400, 404, 422].includes(response.status)) throw fail('The AI provider rejected the model or request. Check the model and prompt settings.', 409, { blocked: true });
        throw fail('The AI provider is temporarily unavailable. Try again later.', 503, { retryable: true });
      }
      return await jsonResponse(response, signal);
    } catch (error) {
      if (error?.[SAFE]) throw error;
      throw fail(signal.aborted ? 'The AI provider request timed out. Try again later.' : 'The AI provider request failed. Check the connection and try again.', signal.aborted ? 504 : 502, { retryable: true });
    } finally { clearTimeout(deadline); }
  }
  async review({ provider, apiKey, model, systemPrompt, prompt, context, kind } = {}) {
    const selected = options({ provider, apiKey, model });
    if (!Object.hasOwn(AI_OUTPUT_SCHEMAS, kind)) throw fail('Choose a supported AI review type.');
    const system = promptText(systemPrompt), instruction = promptText(prompt);
    if (!plain(context)) throw fail('Provide a valid AI review context.');
    let data;
    try { data = JSON.stringify(context); } catch { throw fail('The AI review context cannot be serialized.'); }
    const name = `assetdesk_${kind}`, schema = AI_OUTPUT_SCHEMAS[kind];
    const request = provider === 'openai'
      ? { model: selected.model, max_completion_tokens: 4096, messages: [{ role: 'system', content: system }, { role: 'user', content: instruction }, { role: 'user', content: data }], response_format: { type: 'json_schema', json_schema: { name, strict: true, schema: OPENAI_OUTPUT_SCHEMAS[kind] } } }
      : { model: selected.model, max_tokens: 4096, system, messages: [{ role: 'user', content: [{ type: 'text', text: instruction }, { type: 'text', text: data }] }], tools: [{ name, input_schema: schema }], tool_choice: { type: 'tool', name, disable_parallel_tool_use: true } };
    const response = await this.#request(selected.provider, selected.apiKey, provider === 'openai' ? 'chat/completions' : 'messages', request);
    let result;
    if (provider === 'openai') {
      const choice = response?.choices?.[0];
      if (!choice || choice.finish_reason !== 'stop' || choice.message?.refusal || typeof choice.message?.content !== 'string') throw fail('The AI provider did not complete the requested review. Review the prompts and try again.', 502);
      try { result = JSON.parse(choice.message.content); } catch { throw fail('The AI provider returned an invalid review. Review the prompts and try again.', 502); }
    } else {
      const tools = Array.isArray(response?.content) ? response.content.filter(block => plain(block) && block.type === 'tool_use') : [];
      if (response?.stop_reason !== 'tool_use' || tools.length !== 1 || tools[0].name !== name) throw fail('The AI provider did not complete the requested review. Review the prompts and try again.', 502);
      result = tools[0].input;
    }
    if (JSON.stringify(result)?.includes(selected.apiKey)) throw fail('The AI provider returned an invalid review. Review the prompts and try again.', 502);
    return validateAiResult(kind, result);
  }
  async testConnection({ provider, apiKey, model } = {}) {
    const selected = options({ provider, apiKey, model });
    const response = await this.#request(selected.provider, selected.apiKey, 'models');
    if (!plain(response) || !Array.isArray(response.data)) throw fail('The AI provider returned an invalid connection response.', 502);
    return { ok: true, provider: selected.provider };
  }
}
