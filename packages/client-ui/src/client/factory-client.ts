import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClientContext } from '@monotykamary/dsh-client-runtime/client'
import type { IApiClient, ModelProviderGroup } from '@monotykamary/dsh-api-remotes/client'
import type { RemoteResult } from '@monotykamary/dsh-typert-protocol'
import type { FactorySnapshot } from 'dsh-factory-protocol'
import type {} from 'dsh-factory-domain/remote'

/** Generated Factory Remote namespace. */
export type FactoryRemote = ClientContext['remote']['factory']

/** Concrete model choice used by project and prompt selectors. */
export interface FactoryModelChoice {
  id: string
  label: string
  provider: string
  model: string
}

/** Load the host-scoped model catalog and retain the selected fallback route even when unadvertised. */
export function useFactoryModels(api: IApiClient['llm'], fallbackModel: string | undefined) {
  const [choices, setChoices] = useState<readonly FactoryModelChoice[]>([])
  const [modelError, setModelError] = useState<string>()
  useEffect(() => {
    let current = true
    void api.models({}).then((response: Awaited<ReturnType<IApiClient['llm']['models']>>) => {
      if (!current) return
      if (!response.result.ok) throw new Error(response.result.error.message)
      const values: FactoryModelChoice[] = response.result.value.groups.flatMap((group: ModelProviderGroup) => group.models.map((model: ModelProviderGroup['models'][number]) => ({
        id: `${group.id}:${model.id}`, label: `${model.name} · ${group.name}`, provider: group.id, model: model.id,
      })))
      if (fallbackModel !== undefined && !values.some((value: FactoryModelChoice) => value.id === fallbackModel)) {
        const boundary = fallbackModel.indexOf(':')
        values.unshift({
          id: fallbackModel, label: fallbackModel,
          provider: boundary <= 0 ? '' : fallbackModel.slice(0, boundary),
          model: boundary <= 0 ? fallbackModel : fallbackModel.slice(boundary + 1),
        })
      }
      setChoices(values)
      setModelError(undefined)
    }).catch((failure: unknown) => {
      if (current) setModelError(failure instanceof Error ? failure.message : String(failure))
    })
    return () => { current = false }
  }, [api, fallbackModel])
  return { choices, modelError }
}

/** Unwrap a generated Remote result into UI success/failure control flow. */
export function remoteValue<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/** Polling Remote projection with mutation-driven replacement. */
export function useFactory(api: FactoryRemote) {
  const [snapshot, setSnapshot] = useState<FactorySnapshot>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const mounted = useRef(true)
  const pending = useRef<Promise<void>>()

  const refresh = useCallback((): Promise<void> => {
    if (pending.current !== undefined) return pending.current
    const task = api.snapshot().then(remoteValue).then((value) => {
      if (!mounted.current) return
      setSnapshot(value)
      setError(undefined)
    }, (failure: unknown) => {
      if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure))
    }).finally(() => {
      pending.current = undefined
      if (mounted.current) setLoading(false)
    })
    pending.current = task
    return task
  }, [api])

  useEffect(() => {
    mounted.current = true
    void refresh()
    const timer = window.setInterval(() => { if (!document.hidden) void refresh() }, 2_000)
    return () => { mounted.current = false; window.clearInterval(timer) }
  }, [refresh])

  const mutate = useCallback(async (operation: () => Promise<RemoteResult<FactorySnapshot>>): Promise<FactorySnapshot> => {
    try {
      const value = remoteValue(await operation())
      if (mounted.current) { setSnapshot(value); setError(undefined) }
      return value
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure)
      if (mounted.current) setError(message)
      throw failure
    }
  }, [])

  return { snapshot, error, loading, refresh, mutate }
}
