import { Rows2 } from '@monotykamary/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@monotykamary/dsh-client-ui-slots'
import css from './FactoryApp.module.css'

/** Sidebar navigation row for the Factory root application. */
export function FactoryNav({ wide, activeSurface, openSurface, t }: PropsRuntime<'sidebar.navigation'> & PropsLocale<'factory'>) {
  const active = activeSurface === 'factory'
  return (
    <button
      type="button"
      className={css.navRow}
      data-active={active || undefined}
      aria-label={t('nav')}
      aria-current={active ? 'page' : undefined}
      onClick={() => { openSurface('factory') }}
    >
      <Rows2 size={17} aria-hidden="true" />
      {wide ? <span>{t('nav')}</span> : null}
    </button>
  )
}
