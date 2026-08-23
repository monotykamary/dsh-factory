import type { Context, Service } from '@monotykamary/cordis'

declare module '@monotykamary/dsh-typert-protocol' {
  const LOOKUP_HOST: unique symbol
  const LOOKUP_WIRE: unique symbol
  const CONTEXT_WIRE: unique symbol

  export interface TypertLookup<Host, Wire> { readonly [LOOKUP_HOST]: Host; readonly [LOOKUP_WIRE]: Wire }
  export interface TypertContext<Wire> { readonly [CONTEXT_WIRE]: Wire }
  export interface TypertLookupMap {}
  export interface TypertContextMap {}
  export interface TypertRemoteMap {}
  export interface TypertRemoteNamespaceMap {}

  /** External-workspace marker declaration; runtime resolves the platform package. */
  export function Remote<This extends object, Args extends unknown[], Result>(
    value: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ): void
  /** External-workspace named Remote marker declaration. */
  export function Remote(name: string): <This extends object, Args extends unknown[], Result>(
    value: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ) => void

  /** External-workspace service marker; runtime behavior comes from the linked platform package. */
  export class TypertRemoteService extends Service {
    constructor(ctx: Context, service: string, options?: { namespace?: string })
  }
}
