import { useEffect, useMemo, useRef, useState } from 'react'
import { Bot, Button, GitBranch, Settings } from '@monotykamary/dsh-client-ui-primitives'
import type { WorkspaceView } from '@monotykamary/dsh-client-runtime/client'
import {
  DEFAULT_FACTORY_DESCRIPTION_PROMPT, DEFAULT_FACTORY_TITLE_PROMPT,
  type FactoryProjectSettings, type FactorySnapshot, type FactoryUpdateProjectRequest,
} from 'dsh-factory-protocol'
import type { FactoryModelChoice } from './factory-client.ts'
import { FactoryModelSelect } from './FactoryModelSelect.tsx'
import { FactorySelectMenu } from './FactorySelectMenu.tsx'
import css from './FactoryApp.module.css'

/** Per-workspace model, title, and worktree settings inherited by Factory work. */
export function FactorySettings({ snapshot, workspaces, choices, modelError, initialPath, onSave }: {
  snapshot: FactorySnapshot
  workspaces: readonly WorkspaceView[]
  choices: readonly FactoryModelChoice[]
  modelError?: string | undefined
  initialPath?: string | undefined
  onSave: (request: FactoryUpdateProjectRequest) => Promise<void>
}) {
  const rows = useMemo(() => {
    const values = workspaces.map(workspace => ({ path: workspace.path, title: workspace.title }))
    for (const project of snapshot.document.projects) if (!values.some(value => value.path === project.mainPath)) values.push({ path: project.mainPath, title: project.title })
    return values
  }, [snapshot.document.projects, workspaces])
  const [path, setPath] = useState(initialPath ?? rows[0]?.path ?? '')
  const project = snapshot.document.projects.find(candidate => candidate.mainPath === path)
  const effectiveModel = project?.settings.model ?? snapshot.defaultModel
  const storedTitleModel = project?.settings.titleModel ?? effectiveModel
  const storedAutoTitle = project?.settings.autoTitle ?? true
  const storedTitlePrompt = project?.settings.titlePrompt ?? DEFAULT_FACTORY_TITLE_PROMPT
  const storedDescriptionPrompt = project?.settings.descriptionPrompt ?? DEFAULT_FACTORY_DESCRIPTION_PROMPT
  const storedLane = project?.settings.lane.mode ?? 'isolated'
  const storedBaseRef = project?.settings.lane.baseRef ?? ''
  const storedSetupCommand = project?.settings.setupCommand ?? ''
  const [model, setModel] = useState(effectiveModel)
  const [titleModel, setTitleModel] = useState(project?.settings.titleModel ?? effectiveModel)
  const [autoTitle, setAutoTitle] = useState(project?.settings.autoTitle ?? true)
  const [titlePrompt, setTitlePrompt] = useState(project?.settings.titlePrompt ?? DEFAULT_FACTORY_TITLE_PROMPT)
  const [descriptionPrompt, setDescriptionPrompt] = useState(project?.settings.descriptionPrompt ?? DEFAULT_FACTORY_DESCRIPTION_PROMPT)
  const [lane, setLane] = useState<'current' | 'isolated'>(project?.settings.lane.mode ?? 'isolated')
  const [baseRef, setBaseRef] = useState(project?.settings.lane.baseRef ?? '')
  const [setupCommand, setSetupCommand] = useState(project?.settings.setupCommand ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  // Apply a caller-targeted workspace once per new value so polling cannot
  // slam the workspace choice back while the draft is being edited.
  const appliedInitialPath = useRef<string>()
  useEffect(() => {
    if (initialPath === undefined || appliedInitialPath.current === initialPath) return
    if (!rows.some(row => row.path === initialPath)) return
    appliedInitialPath.current = initialPath
    setPath(initialPath)
  }, [initialPath, rows])

  // Reseed the draft only when the persisted settings content actually
  // changes; a polling refresh returns an equal seed and leaves edits intact.
  const seed = JSON.stringify([
    effectiveModel, storedTitleModel, storedAutoTitle, storedTitlePrompt,
    storedDescriptionPrompt, storedLane, storedBaseRef, storedSetupCommand,
  ])
  useEffect(() => {
    setModel(effectiveModel)
    setTitleModel(storedTitleModel)
    setAutoTitle(storedAutoTitle)
    setTitlePrompt(storedTitlePrompt)
    setDescriptionPrompt(storedDescriptionPrompt)
    setLane(storedLane)
    setBaseRef(storedBaseRef)
    setSetupCommand(storedSetupCommand)
    setError(undefined)
  }, [path, seed])

  const save = async (): Promise<void> => {
    if (path === '' || model === '' || titleModel === '') return
    const settings: FactoryProjectSettings = {
      model, titleModel, autoTitle,
      ...(titlePrompt.trim() === DEFAULT_FACTORY_TITLE_PROMPT ? {} : { titlePrompt: titlePrompt.trim() }),
      ...(descriptionPrompt.trim() === DEFAULT_FACTORY_DESCRIPTION_PROMPT ? {} : { descriptionPrompt: descriptionPrompt.trim() }),
      lane: { mode: lane, ...(lane === 'isolated' && baseRef.trim() !== '' ? { baseRef: baseRef.trim() } : {}) },
      ...(setupCommand.trim() === '' ? {} : { setupCommand: setupCommand.trim() }),
    }
    setBusy(true); setError(undefined)
    try { await onSave({ projectPath: path, settings, expectedRevision: snapshot.revision }) }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setBusy(false) }
  }

  if (rows.length === 0) return <div className={css.emptyState}><Settings size={30} /><span>Add a workspace before configuring Factory.</span></div>

  return (
    <div className={css.settingsPage} data-testid="factory-settings">
      <header className={css.settingsHeader}>
        <div><h2>Workspace settings</h2><p>Future and unresolved tasks use these workspace defaults.</p></div>
        <Button variant="primary" size="sm" disabled={busy || path === '' || model === '' || titleModel === ''} onClick={() => { void save() }}>{busy ? '…' : 'Save settings'}</Button>
      </header>
      <FactorySelectMenu
        value={path || undefined}
        items={rows.map(row => ({ id: row.path, label: `${row.title} — ${row.path}`, icon: <GitBranch size={13} /> }))}
        placeholder="Choose workspace"
        ariaLabel="Settings workspace"
        onSelect={setPath}
      />
      <section className={css.settingsSection}>
        <div className={css.settingsSectionTitle}><Bot size={15} /><div><h3>Models</h3><p>Tasks use the workspace model unless they name another model.</p></div></div>
        <div className={css.settingsGrid}>
          <label><span>Task model</span><FactoryModelSelect value={model} choices={choices} ariaLabel="Workspace task model" onChange={setModel} /></label>
          <label><span>Title model</span><FactoryModelSelect value={titleModel} choices={choices} ariaLabel="Workspace title model" onChange={setTitleModel} /></label>
        </div>
        <label className={css.settingsToggle}><input type="checkbox" checked={autoTitle} onChange={event => { setAutoTitle(event.target.checked) }} /><span><strong>Generate titles and descriptions</strong><small>Opt out to use an immediate prompt-derived fallback you can edit later.</small></span></label>
        <details className={css.settingsAdvanced}>
          <summary>Advanced metadata prompts</summary>
          <div className={css.settingsAdvancedBody}>
            <p>Customize the instructions sent to the title model. Output still uses strict title and description fields.</p>
            <label><span>Task title instruction</span><textarea aria-label="Task title instruction" value={titlePrompt} onChange={event => { setTitlePrompt(event.target.value) }} /></label>
            <label><span>Task description instruction</span><textarea aria-label="Task description instruction" value={descriptionPrompt} onChange={event => { setDescriptionPrompt(event.target.value) }} /></label>
            <div className={css.settingsAdvancedActions}><Button variant="outline" size="sm" disabled={titlePrompt === DEFAULT_FACTORY_TITLE_PROMPT && descriptionPrompt === DEFAULT_FACTORY_DESCRIPTION_PROMPT} onClick={() => { setTitlePrompt(DEFAULT_FACTORY_TITLE_PROMPT); setDescriptionPrompt(DEFAULT_FACTORY_DESCRIPTION_PROMPT) }}>Reset prompts</Button></div>
          </div>
        </details>
        {modelError === undefined ? null : <div className={css.settingsNotice}>Model catalog unavailable: {modelError}</div>}
      </section>
      <section className={css.settingsSection}>
        <div className={css.settingsSectionTitle}><GitBranch size={15} /><div><h3>Worktrees</h3><p>Checkout and setup policy is stored once for this workspace.</p></div></div>
        <div className={css.settingsGrid}>
          <label><span>Default checkout</span><FactorySelectMenu value={lane} items={[{ id: 'isolated', label: 'Isolated worktree', icon: <GitBranch size={13} /> }, { id: 'current', label: 'Current checkout', icon: <GitBranch size={13} /> }]} placeholder="Checkout" ariaLabel="Default checkout" onSelect={value => { setLane(value as 'current' | 'isolated') }} /></label>
          <label><span>Base ref</span><input value={baseRef} disabled={lane !== 'isolated'} onChange={event => { setBaseRef(event.target.value) }} placeholder="Workspace default branch" /></label>
        </div>
        <label><span>Setup script</span><textarea value={setupCommand} onChange={event => { setSetupCommand(event.target.value) }} placeholder="pnpm install" /></label>
        <p className={css.settingsHint}>The setup script runs as the first command in each newly allocated Factory checkout.</p>
      </section>
      {error === undefined ? null : <div className={css.formError} role="alert">{error}</div>}
    </div>
  )
}
