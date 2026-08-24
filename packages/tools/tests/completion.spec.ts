import type { Agent } from '@monotykamary/dsh-agent'
import { Context } from '@monotykamary/cordis'
import { CallId } from '@monotykamary/dsh-llm'
import SystemPrompt from '@monotykamary/dsh-system-prompt'
import ToolRuntime from '@monotykamary/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FACTORY_FINISH_REMINDER, installFactoryCompletionTool } from '../src/index.ts'

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

describe('factory_finish', () => {
  it('buffers one explicit report until the scheduler consumes it', async () => {
    ctx = new Context()
    new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false, persona: '' })
    new ToolRuntime(ctx, { mode: 'native' })
    const channel = installFactoryCompletionTool(ctx)
    const signal = new AbortController().signal

    const first = await ctx.tools.execute({
      callId: CallId('factory-finish-1'), name: 'factory_finish', signal,
      arguments: { outcome: 'succeeded', summary: 'Verified', details: '12 tests passed', artifacts: ['report.json'] },
    })
    expect(first).toMatchObject({ isError: false })
    expect(channel.pending()).toBe(true)

    const duplicate = await ctx.tools.execute({
      callId: CallId('factory-finish-2'), name: 'factory_finish', signal,
      arguments: { outcome: 'failed', summary: 'late override' },
    })
    expect(duplicate).toMatchObject({ isError: true })
    expect(channel.consume()).toEqual({ outcome: 'succeeded', summary: 'Verified', details: '12 tests passed', artifacts: ['report.json'] })
    expect(channel.pending()).toBe(false)

    await ctx.tools.execute({
      callId: CallId('factory-finish-3'), name: 'factory_finish', signal,
      arguments: { outcome: 'blocked', summary: 'Need credentials' },
    })
    expect(channel.consume()).toEqual({ outcome: 'blocked', summary: 'Need credentials' })
    expect(ctx.tools.get('factory_finish')?.presentCall?.({ outcome: 'blocked', summary: 'Need credentials' })).toMatchObject({ card: 'generic', kind: 'edit' })
  })

  it('injects once at a normal stop and suppresses max-token, reported, and disposed turns', async () => {
    ctx = new Context()
    new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false, persona: '' })
    new ToolRuntime(ctx, { mode: 'native' })
    const channel = installFactoryCompletionTool(ctx)
    const events: Array<Record<string, unknown>> = [{
      type: 'assistant/chunk',
      data: { turn: 1, chunk: { type: 'finish', reason: { kind: 'max-tokens' } } },
    }]
    const inject = vi.fn()
    const agent = { session: { events }, inject } as unknown as Agent

    expect(channel.remindAtStop(agent, 1)).toBe(false)
    events.splice(0, events.length, {
      type: 'assistant/chunk',
      data: { turn: 2, chunk: { type: 'finish', reason: { kind: 'stop' } } },
    })
    expect(channel.remindAtStop(agent, 2)).toBe(true)
    expect(channel.remindAtStop(agent, 2)).toBe(false)
    expect(inject).toHaveBeenCalledOnce()
    expect(inject.mock.calls[0]?.[0]).toMatchObject({
      content: [{ type: 'text', text: FACTORY_FINISH_REMINDER }],
      source: { kind: 'plugin', plugin: 'dsh-factory', form: 'notice', summary: 'Factory completion' },
    })

    await ctx.tools.execute({
      callId: CallId('factory-finish-reminded'), name: 'factory_finish',
      signal: new AbortController().signal, agent, location: { turn: 3, step: 1 },
      arguments: { outcome: 'succeeded', summary: 'Verified after reminder' },
    })
    expect(channel.peek()).toMatchObject({ outcome: 'succeeded', summary: 'Verified after reminder' })
    expect(channel.remindAtStop(agent, 3)).toBe(false)
    expect(channel.consume()).toMatchObject({ outcome: 'succeeded' })
    expect(channel.remindAtStop(agent, 3)).toBe(false)

    channel.dispose()
    expect(ctx.tools.get('factory_finish')).toBeUndefined()
    expect(channel.remindAtStop(agent, 4)).toBe(false)
  })

  it('rejects completion from the same native step or run_code root as a human question', async () => {
    ctx = new Context()
    new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false, persona: '' })
    new ToolRuntime(ctx, { mode: 'native' })
    const channel = installFactoryCompletionTool(ctx)
    const signal = new AbortController().signal
    const codeRoot = CallId('factory-code-root')
    const agent = {
      session: {
        events: [
          {
            type: 'assistant/message',
            data: {
              turn: 1, step: 2,
              message: { content: [{ type: 'tool-call', name: 'ask_user_question' }] },
            },
          },
          {
            type: 'tool/code-dispatch-start',
            data: { rootCallId: codeRoot, name: 'ask_user_question' },
          },
        ],
      },
    } as never

    const sameStep = await ctx.tools.execute({
      callId: CallId('factory-finish-same-step'), name: 'factory_finish', signal, agent,
      location: { turn: 1, step: 2 },
      arguments: { outcome: 'succeeded', summary: 'Premature native completion' },
    })
    expect(sameStep).toMatchObject({ isError: true })
    expect(JSON.stringify(sameStep.content)).toContain('later model step after ask_user_question returns')

    const sameCodeRoot = await ctx.tools.execute({
      callId: CallId('factory-finish-same-code'), rootCallId: codeRoot,
      name: 'factory_finish', signal, agent, location: { turn: 2, step: 1 },
      arguments: { outcome: 'succeeded', summary: 'Premature Code Mode completion' },
    })
    expect(sameCodeRoot).toMatchObject({ isError: true })
    expect(channel.pending()).toBe(false)

    const later = await ctx.tools.execute({
      callId: CallId('factory-finish-after-answer'), name: 'factory_finish', signal, agent,
      location: { turn: 1, step: 3 },
      arguments: { outcome: 'succeeded', summary: 'Answer applied and verified' },
    })
    expect(later).toMatchObject({ isError: false })
    expect(channel.consume()).toMatchObject({ outcome: 'succeeded', summary: 'Answer applied and verified' })
  })
})
