import { fileURLToPath } from 'node:url';

/**
 * @typedef {{
 *   id: string, name?: string, isDefault?: boolean,
 *   policy?: {state?: string},
 *   supportedReasoningEfforts?: string[], defaultReasoningEffort?: string,
 *   billing?: {tokenPrices?: {maxPromptTokens?: number, contextMax?: number,
 *     longContext?: {maxPromptTokens?: number, contextMax?: number}}},
 *   capabilities?: {limits?: Record<string, number>}
 * }} NativeModel
 */

export const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export const textContent = (text) => ({ type: 'content', content: { type: 'text', text } });
const positive = (value) => Number.isFinite(value) && value > 0;
const compactTokenCount = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });

/**
 * Only metadata with two distinct, positive prompt budgets establishes tier support.
 * @param {NativeModel | undefined} model
 */
export function contextChoices(model) {
  const prices = model?.billing?.tokenPrices;
  const normal = prices?.maxPromptTokens ?? prices?.contextMax;
  const long = prices?.longContext?.maxPromptTokens ?? prices?.longContext?.contextMax;
  const hasBudget = model?.id !== 'auto' && positive(normal);
  const choice = (value, name, budget) => ({
    value,
    name: hasBudget ? `${name} (${compactTokenCount.format(budget)})` : name,
    ...(hasBudget ? { description: `${budget.toLocaleString('en-US')} input tokens` } : {}),
  });
  return [
    choice('default', 'Default', normal),
    ...(hasBudget && positive(long) && long > normal ? [choice('long_context', 'Long context', long)] : []),
  ];
}

/** @param {NativeModel | undefined} model */
export function reasoningChoices(model) {
  return Array.isArray(model?.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts.filter((value) => typeof value === 'string')
    : [];
}

/** Publish each model's capabilities for clients selecting before a session exists. */
export function modelConfigOptions(model) {
  return [
    {
      id: 'context_window',
      type: 'select',
      category: 'context_window',
      currentValue: 'default',
      options: contextChoices(model),
    },
    {
      id: 'reasoning_effort',
      type: 'select',
      category: 'thought_level',
      currentValue: 'default',
      options: [
        { value: 'default', name: 'Default' },
        ...reasoningChoices(model).map((value) => ({ value, name: value })),
      ],
    },
  ];
}

export function configOptions(session, models) {
  const model = models.find((entry) => entry.id === session.model.modelId);
  const select = (id, name, category, currentValue, options) => ({
    id,
    name,
    category,
    type: 'select',
    currentValue,
    options,
  });
  const efforts = reasoningChoices(model);
  const selectedEffort = efforts.includes(session.model.reasoningEffort)
    ? session.model.reasoningEffort
    : efforts.includes(model?.defaultReasoningEffort)
      ? model.defaultReasoningEffort
      : 'default';
  return [
    select(
      'model',
      'Model',
      'model',
      session.model.modelId,
      models.map((entry) => ({
        value: entry.id,
        name: entry.name ?? entry.id,
        _meta: { 'aionui/model-config': modelConfigOptions(entry) },
      }))
    ),
    // Always publish a single default on unsupported models: AionCore merges options by ID.
    select(
      'context_window',
      'Context window',
      'context_window',
      session.model.contextTier ?? 'default',
      contextChoices(model)
    ),
    select('reasoning_effort', 'Reasoning effort', 'thought_level', selectedEffort, [
      ...(selectedEffort === 'default' ? [{ value: 'default', name: 'Default' }] : []),
      ...efforts.map((value) => ({ value, name: value })),
    ]),
    select(
      'mode',
      'Mode',
      'mode',
      session.mode,
      ['interactive', 'plan', 'autopilot'].map((value) => ({ value, name: value }))
    ),
    select('allow_all', 'Allow all permissions', 'permission', session.permission === 'allow-all' ? 'true' : 'false', [
      { value: 'false', name: 'Ask for permission' },
      { value: 'true', name: 'Allow all' },
    ]),
  ];
}

/** Translate ACP resources without silently dropping unsupported input or reading files ourselves. */
export function promptInput(blocks) {
  const text = [];
  const attachments = [];
  for (const block of blocks) {
    if (block.type === 'text') text.push(block.text);
    else if (block.type === 'resource' && typeof block.resource?.text === 'string') {
      text.push(`<resource uri=${JSON.stringify(block.resource.uri)}>\n${block.resource.text}\n</resource>`);
    } else if (block.type === 'resource_link' && typeof block.uri === 'string' && block.uri.startsWith('file:')) {
      attachments.push({ type: 'file', path: fileURLToPath(block.uri), displayName: block.name });
    } else throw new Error(`Unsupported prompt content: ${block.type}; use text or a local file resource`);
  }
  if (!text.length && !attachments.length) throw new Error('Prompt must not be empty');
  return { prompt: text.join('\n'), ...(attachments.length ? { attachments } : {}) };
}

export function mcpConfig(servers) {
  const result = Object.create(null);
  for (const server of servers) {
    if (!server.name || Object.hasOwn(result, server.name))
      throw new Error('MCP server names must be unique and nonempty');
    if (!server.type || server.type === 'stdio') {
      if (typeof server.command !== 'string' || !Array.isArray(server.args))
        throw new Error('Invalid stdio MCP server');
      result[server.name] = {
        type: 'stdio',
        command: server.command,
        args: server.args,
        env: Object.fromEntries((server.env ?? []).map(({ name, value }) => [name, value])),
        tools: ['*'],
      };
    } else if (server.type === 'http' || server.type === 'sse') {
      result[server.name] = {
        type: server.type,
        url: server.url,
        headers: Object.fromEntries((server.headers ?? []).map(({ name, value }) => [name, value])),
        tools: ['*'],
      };
    } else throw new Error(`Unsupported MCP transport: ${server.type}`);
  }
  return result;
}

/** Keep final native tool content, including task_complete summaries, renderable by AionUI. */
export function toolOutput(value) {
  if (typeof value === 'string') return [textContent(value)];
  if (!record(value)) return value == null ? [] : [textContent(JSON.stringify(value))];
  const content = [];
  if (typeof value.content === 'string') content.push(textContent(value.content));
  else if (Array.isArray(value.content)) {
    for (const block of value.content) {
      if (block.type === 'text' && typeof block.text === 'string') content.push(textContent(block.text));
    }
  }
  if (!content.length) content.push(textContent(JSON.stringify(value)));
  return content;
}
