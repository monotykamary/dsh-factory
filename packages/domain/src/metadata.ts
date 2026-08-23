import type { Context } from '@monotykamary/cordis'
import { DEFAULT_FACTORY_DESCRIPTION_PROMPT, DEFAULT_FACTORY_TITLE_PROMPT } from 'dsh-factory-protocol'
import { BlockAssembler, createUserMessage, deepFreeze } from '@monotykamary/dsh-llm'
import type { FinishReason, GenerateOptions, Message } from '@monotykamary/dsh-llm'

/** Exact model request retained before Factory metadata generation begins. */
export interface FactoryMetadataRequest {
  route: { provider: string; model: string }
  system: string
  input: string
  messages: Message[]
  maxTokens: number
}

/** Bounded generated title and description plus the provider's exact text. */
export interface FactoryGeneratedMetadata {
  title: string
  description: string
  output: string
}

/** Byte limits applied to generated and deterministic fallback metadata. */
export interface FactoryMetadataLimits {
  maxInputBytes: number
  maxTitleBytes: number
  maxDescriptionBytes: number
  timeoutMs: number
}

/** Normalize whitespace and truncate without splitting a UTF-8 code point. */
export function boundFactoryMetadataText(value: string, maxBytes: number): string {
  const normalized = value.replaceAll(/\s+/gu, ' ').trim()
  let result = ''
  for (const character of normalized) {
    if (Buffer.byteLength(result + character, 'utf8') > maxBytes) break
    result += character
  }
  return result.trim()
}

/** Derive immediate non-empty metadata without a model request. */
export function fallbackFactoryMetadata(prompt: string, limits: Pick<FactoryMetadataLimits, 'maxTitleBytes' | 'maxDescriptionBytes'>): { title: string; description: string } {
  const normalized = prompt.replaceAll(/\s+/gu, ' ').trim()
  const firstSentence = normalized.split(/(?<=[.!?。！？])\s/u, 1)[0] ?? normalized
  return {
    title: boundFactoryMetadataText(firstSentence, limits.maxTitleBytes) || 'New task',
    description: boundFactoryMetadataText(normalized, limits.maxDescriptionBytes),
  }
}

/** Build the exact logged auxiliary request used for task metadata. */
export function factoryMetadataRequest(
  prompt: string,
  route: { provider: string; model: string },
  maxTokens: number,
  instructions: { title?: string; description?: string } = {},
): FactoryMetadataRequest {
  const system = [
    'Create metadata for an AI coding task from the supplied user prompt.',
    `Title instruction: ${instructions.title ?? DEFAULT_FACTORY_TITLE_PROMPT}`,
    `Description instruction: ${instructions.description ?? DEFAULT_FACTORY_DESCRIPTION_PROMPT}`,
    'Return only strict JSON with exactly two string fields: {"title":"...","description":"..."}.',
    'Do not include Markdown, code fences, explanations, or additional fields.',
  ].join('\n')
  const input = `Generate task metadata from this JSON string:\n${JSON.stringify(prompt)}`
  const messages: Message[] = [createUserMessage({
    content: [{ type: 'text', text: input }],
    source: { kind: 'plugin', plugin: 'dsh-factory' },
  })]
  return { route, system, input, messages, maxTokens }
}

function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'stop': return undefined
    case 'error':
    case 'aborted': return Object.assign(new Error(finish.failure.message), { code: finish.failure.code })
    case 'max-tokens': return new Error('Factory metadata output reached its token limit')
    case 'tool-calls': return new Error('Factory metadata model unexpectedly requested a tool')
    default: return new Error(`Factory metadata model returned unsupported finish reason ${JSON.stringify((finish as { kind?: unknown }).kind)}`)
  }
}

/** Execute one already-logged metadata request through the shared LLM runtime. */
export async function generateFactoryMetadata(
  ctx: Context,
  request: FactoryMetadataRequest,
  limits: FactoryMetadataLimits,
): Promise<FactoryGeneratedMetadata> {
  if (Buffer.byteLength(request.input, 'utf8') > limits.maxInputBytes) {
    throw new Error(`Factory metadata input exceeds ${String(limits.maxInputBytes)} bytes`)
  }
  const signal = AbortSignal.timeout(limits.timeoutMs)
  const options: GenerateOptions = deepFreeze({
    provider: request.route.provider,
    model: request.route.model,
    messages: request.messages,
    system: request.system,
    maxTokens: request.maxTokens,
    purpose: 'session-title',
    signal,
  })
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(options)) {
    signal.throwIfAborted()
    assembler.push(chunk)
  }
  signal.throwIfAborted()
  const terminalError = finishError(assembler.finish)
  if (terminalError !== undefined) throw terminalError
  const blocks = assembler.blocks()
  if (blocks.some(block => block.type === 'tool-call')) throw new Error('Factory metadata output must contain JSON text only')
  const output = blocks
    .filter((block): block is Extract<(typeof blocks)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join(' ')
    .trim()
  let parsed: unknown
  try { parsed = JSON.parse(output) }
  catch { throw new Error('Factory metadata model returned invalid JSON') }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Factory metadata model returned a non-object')
  const record = parsed as Record<string, unknown>
  if (Object.keys(record).some(key => key !== 'title' && key !== 'description')
    || typeof record.title !== 'string' || typeof record.description !== 'string') {
    throw new Error('Factory metadata model must return only title and description strings')
  }
  const title = boundFactoryMetadataText(record.title, limits.maxTitleBytes)
  const description = boundFactoryMetadataText(record.description, limits.maxDescriptionBytes)
  if (title === '') throw new Error('Factory metadata model returned an empty title')
  return { title, description, output }
}
