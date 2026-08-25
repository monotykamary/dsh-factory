import { expect, test, type Page } from '@playwright/test'

async function dismissFirstRun(page: Page): Promise<void> {
  const continueButton = page.getByRole('button', { name: 'Continue', exact: true })
  const configureLater = page.getByRole('button', { name: 'Configure later' })
  let firstRun: 'continue' | 'configure' | undefined
  try {
    firstRun = await Promise.any([
      continueButton.waitFor({ timeout: 5_000 }).then(() => 'continue' as const),
      configureLater.waitFor({ timeout: 5_000 }).then(() => 'configure' as const),
    ])
  } catch {
    // Neither first-run dialog is part of a configured profile.
  }
  if (firstRun === 'continue') {
    await continueButton.click()
    await configureLater.waitFor()
  }
  if (firstRun !== undefined) {
    await configureLater.click()
    await configureLater.waitFor({ state: 'hidden' })
  }
}

test('Factory creates independent New Session work and presents Emerging work, rail states, Triage, and settings', async ({ page }) => {
  test.skip(process.env.DSH_FACTORY_E2E_URL === undefined, 'set DSH_FACTORY_E2E_URL to an assembled Factory web profile')
  const browserErrors: string[] = []
  page.on('console', message => { if (message.type() === 'error') browserErrors.push(message.text()) })
  page.on('pageerror', error => { browserErrors.push(error.message) })

  await page.goto('/', { waitUntil: 'networkidle' })
  await dismissFirstRun(page)
  await page.getByRole('button', { name: 'Factory' }).click()
  await expect(page.getByTestId('factory-app')).toBeVisible()
  const tabs = page.getByRole('navigation', { name: 'Factory views' })
  await expect(tabs.getByRole('button', { name: /^Agents/ })).toHaveCount(0)
  await expect(tabs.getByRole('button', { name: /^Patterns/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'New flow' })).toHaveCount(0)

  await expect(page.getByRole('button', { name: 'New task' })).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: 'Create task' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Create flow' })).toHaveCount(0)
  await expect(page.getByLabel('Flow name')).toHaveCount(0)
  await expect(page.getByLabel(/^Select FAC-/)).toHaveCount(0)

  const flowGroups = page.getByTestId('factory-app').locator('[data-flow-kind]')
  const emerging = flowGroups.filter({ hasText: 'Emerging work' })
  if (await emerging.count()) {
    await expect(flowGroups.first()).toHaveAttribute('data-flow-kind', 'inbox')
    await expect(flowGroups.first()).toContainText('Emerging work')
  }
  const railNodes = page.getByTestId('factory-app').locator('[data-segment="node"]')
  if (await railNodes.count()) {
    const states = await railNodes.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-state')))
    expect(states.every(state => ['pending', 'running', 'succeeded', 'failed'].includes(state ?? ''))).toBe(true)
    await expect(railNodes.locator('svg')).toHaveCount(await railNodes.count())
    const pendingClasses = await page.getByTestId('factory-app').locator('[data-segment="node"][data-state="pending"] svg').evaluateAll(nodes => nodes.map(node => node.getAttribute('class') ?? ''))
    expect(pendingClasses.length).toBeGreaterThan(0)
    expect(pendingClasses.every(value => /lucide-(circle|triangle|diamond|square)(?:\s|$)/u.test(value))).toBe(true)
    expect(pendingClasses.some(value => /lucide-(git-branch|corner-down-right)(?:\s|$)/u.test(value))).toBe(false)
    const mainRail = page.getByTestId('factory-app').locator('[data-segment="rail-before"][data-lane="0"]').first()
    const branchRail = page.getByTestId('factory-app').locator('[data-segment="rail-before"][data-lane="1"]').first()
    if (await mainRail.count() && await branchRail.count()) {
      const [mainColor, branchColor] = await Promise.all([
        mainRail.evaluate(element => getComputedStyle(element).backgroundColor),
        branchRail.evaluate(element => getComputedStyle(element).backgroundColor),
      ])
      expect(branchColor).toBe(mainColor)
    }
  }
  const stressedRails = flowGroups.filter({ hasText: 'Nested rail CSS stress' })
  if (await stressedRails.count()) {
    await expect(stressedRails.locator('[data-segment="node"][data-state="succeeded"]')).toHaveCount(1)
    await expect(stressedRails.locator('[data-segment="node"][data-state="running"]')).toHaveCount(1)
    await expect(stressedRails.locator('[data-segment="node"][data-state="failed"]')).toHaveCount(1)
  }

  await tabs.getByRole('button', { name: /^Triage/ }).click()
  const triage = page.getByTestId('factory-triage')
  await expect(triage.or(page.getByText('Completed task results will appear here.'))).toBeVisible()
  if (await triage.count()) {
    const resultTerm = triage.getByText('Result', { exact: true })
    const resultValue = resultTerm.locator('..').locator('dd')
    const [termBox, valueBox] = await Promise.all([resultTerm.boundingBox(), resultValue.boundingBox()])
    expect(termBox).not.toBeNull(); expect(valueBox).not.toBeNull()
    expect(Math.abs((termBox?.y ?? 0) - (valueBox?.y ?? 0))).toBeLessThanOrEqual(4)
    expect((valueBox?.x ?? 0) - ((termBox?.x ?? 0) + (termBox?.width ?? 0))).toBeLessThanOrEqual(16)
  }

  await tabs.getByRole('button', { name: /^Settings/ }).click()
  const settings = page.getByTestId('factory-settings')
  await expect(settings.getByRole('button', { name: 'Workspace task model' })).toBeVisible()
  await expect(settings.getByRole('button', { name: 'Workspace title model' })).toBeVisible()
  await expect(settings.getByLabel('Generate titles and descriptions')).toBeChecked()
  await settings.getByText('Advanced metadata prompts', { exact: true }).click()
  const titlePrompt = settings.getByLabel('Task title instruction')
  const descriptionPrompt = settings.getByLabel('Task description instruction')
  await expect(titlePrompt).toBeVisible()
  const [titlePromptBox, descriptionPromptBox] = await Promise.all([titlePrompt.boundingBox(), descriptionPrompt.boundingBox()])
  expect(titlePromptBox).not.toBeNull(); expect(descriptionPromptBox).not.toBeNull()
  expect((descriptionPromptBox?.y ?? 0) - ((titlePromptBox?.y ?? 0) + (titlePromptBox?.height ?? 0))).toBeGreaterThanOrEqual(24)
  await titlePrompt.fill('Custom title prompt')
  await descriptionPrompt.fill('Custom description prompt')
  await settings.getByRole('button', { name: 'Reset prompts' }).click()
  await expect(titlePrompt).not.toHaveValue('Custom title prompt')
  await expect(descriptionPrompt).not.toHaveValue('Custom description prompt')
  await expect(settings.getByLabel('Setup script')).toHaveCSS('resize', 'none')

  const checkout = settings.getByRole('button', { name: 'Default checkout' })
  const baseRef = settings.getByLabel('Base ref')
  const [checkoutBox, baseRefBox] = await Promise.all([checkout.boundingBox(), baseRef.boundingBox()])
  expect(checkoutBox).not.toBeNull(); expect(baseRefBox).not.toBeNull()
  expect(Math.abs((checkoutBox?.height ?? 0) - (baseRefBox?.height ?? 0))).toBeLessThanOrEqual(1)
  const settingsHeading = settings.getByRole('heading', { name: 'Workspace settings' })
  await expect(settingsHeading.locator('..').locator('svg')).toHaveCount(0)
  for (const heading of ['Models', 'Worktrees']) {
    const row = settings.getByRole('heading', { name: heading }).locator('../..')
    const icon = row.locator('svg').first()
    const [headingBox, iconBox] = await Promise.all([settings.getByRole('heading', { name: heading }).boundingBox(), icon.boundingBox()])
    expect(headingBox).not.toBeNull(); expect(iconBox).not.toBeNull()
    expect(Math.abs((headingBox?.y ?? 0) - (iconBox?.y ?? 0))).toBeLessThanOrEqual(3)
  }

  await page.getByRole('button', { name: 'New Session' }).last().click()
  await expect(page.getByTestId('factory-app')).toHaveCount(0)
  const intent = page.getByRole('button', { name: /New work intent, current/ })
  await expect(intent).toHaveAccessibleName(/current Task/)
  await intent.click()
  await expect(page.getByRole('menuitem', { name: /^Session/ })).toHaveCount(0)
  const taskChoice = page.getByRole('menuitem', { name: /^Task/ })
  expect(await taskChoice.evaluate((element) => {
    const check = element.querySelector('.lucide-check')
    const chevron = element.querySelector('.lucide-chevron-right')
    return check !== null && chevron !== null && Boolean(check.compareDocumentPosition(chevron) & Node.DOCUMENT_POSITION_FOLLOWING)
  })).toBe(true)
  await taskChoice.click()
  await expect(page.getByRole('menuitem', { name: /^Run immediately/ })).toBeVisible()
  await page.getByRole('menuitem', { name: /^Run later/ }).click()
  await expect(intent).toHaveAccessibleName(/current Task · Run later/)
  const runToken = String(Date.now())
  const intakePrompt = `E2E New Session task intake without a separate Factory modal · ${runToken}.`
  await page.locator('[data-composer-card] textarea').fill(intakePrompt)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByTestId('factory-task-card')).toBeVisible()
  const taskCard = page.getByTestId('factory-task-card')
  const firstTaskIdentifier = await taskCard.locator('header strong').last().textContent()
  const promptSection = taskCard.getByRole('heading', { name: 'Agent prompt' }).locator('../..')
  await expect(promptSection.getByText(intakePrompt, { exact: true })).toBeVisible()
  const comments = taskCard.getByTestId('factory-task-comments')
  const note = `Draft-task note stays outside the Agent queue · ${runToken}.`
  await comments.getByPlaceholder('Leave a comment…').fill(note)
  await comments.getByRole('button', { name: 'Add comment' }).click()
  const noteRow = comments.getByRole('listitem').filter({ hasText: note })
  await expect(noteRow).toBeVisible()
  await expect(noteRow.getByText('Saved note')).toBeVisible()
  await taskCard.getByRole('button', { name: 'Edit' }).click()
  const taskModel = taskCard.getByRole('button', { name: 'Model' })
  await expect(taskModel).toBeVisible()
  await expect(taskModel).not.toContainText('Inherit workspace model')
  await expect(promptSection.getByLabel('Preset')).toHaveCount(0)
  await expect(promptSection.getByLabel('Labels')).toHaveCount(0)
  const taskLabels = taskCard.getByRole('combobox', { name: 'Task labels' })
  await expect(taskLabels).toBeVisible()
  await taskLabels.click()
  const label = `e2e-${runToken}`
  await page.getByRole('searchbox', { name: 'Search or create labels' }).fill(label)
  await page.getByRole('menuitem', { name: new RegExp(`Create ${label}`) }).click()
  await expect(taskLabels).toContainText(label)
  await page.keyboard.press('Escape')
  await taskCard.getByRole('button', { name: 'Save' }).click()
  await expect(taskLabels).toHaveCount(0)
  await expect(taskCard.getByText(label, { exact: true })).toBeVisible()
  await taskCard.getByRole('button', { name: 'Edit' }).click()
  await expect(taskCard.getByRole('combobox', { name: 'Task labels' })).toBeVisible()
  await taskCard.getByRole('button', { name: `Remove ${label}` }).click()
  await taskCard.getByRole('button', { name: 'Save' }).click()
  await expect(taskCard.getByText(label, { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'New Session' }).last().click()
  const composer = page.locator('[data-composer-card] textarea')
  await expect(composer).toHaveValue('')
  const secondIntent = page.getByRole('button', { name: /New work intent, current/ })
  await secondIntent.click()
  await page.getByRole('menuitem', { name: /^Task/ }).click()
  await page.getByRole('menuitem', { name: /^Run later/ }).click()
  await composer.fill(`Independent queued task · ${runToken}.`)
  await page.getByRole('button', { name: 'Send' }).click()
  const secondTaskCard = page.getByTestId('factory-task-card')
  await expect(secondTaskCard).toBeVisible()
  const secondTaskIdentifier = await secondTaskCard.locator('header strong').last().textContent()
  expect(secondTaskIdentifier).not.toBe(firstTaskIdentifier)
  await secondTaskCard.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(secondTaskCard.getByTestId('factory-task-header-status')).toHaveText('Cancelled')
  await secondTaskCard.getByRole('button', { name: 'Delete task' }).click()
  const deletion = page.getByRole('dialog', { name: new RegExp(`Delete ${secondTaskIdentifier ?? 'FAC-'}`) })
  await deletion.getByRole('checkbox', { name: 'I understand this task has no Session history to preserve.' }).check()
  await deletion.getByRole('button', { name: 'Delete permanently' }).click()
  await expect(secondTaskCard).toHaveCount(0)
  await expect(page.getByTestId('factory-app')).toBeVisible()

  await page.getByRole('button', { name: 'New Session' }).last().click()
  await expect(composer).toHaveValue('')
  const nextIntent = page.getByRole('button', { name: /New work intent, current/ })
  await expect(nextIntent).toHaveAccessibleName(/current Task/)
  await nextIntent.click()
  await page.getByRole('menuitem', { name: /^Flow/ }).click()
  await expect(page.getByRole('menuitem', { name: /^New flow/ })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: /Loading flows/ })).toHaveCount(0)
  const existingFlow = page.getByRole('menuitem', { name: /Factory UI confidence pass/ })
  if (await existingFlow.count()) {
    await existingFlow.click()
    await expect(page.getByRole('menuitem', { name: /^Parallel branch/ })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: /^After current work/ })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: /^Finalizer/ })).toBeVisible()
    await page.getByRole('menuitem', { name: /^After current work/ }).click()
    await expect(nextIntent).toHaveAccessibleName(/Factory UI confidence pass/)
  } else {
    await page.getByRole('menuitem', { name: /^New flow/ }).click()
    await expect(nextIntent).toHaveAccessibleName(/current New flow/)
  }
  expect(browserErrors).toEqual([])
})


test('Factory uses progressive mobile disclosure without horizontal overflow', async ({ page }) => {
  test.skip(process.env.DSH_FACTORY_E2E_URL === undefined, 'set DSH_FACTORY_E2E_URL to an assembled Factory web profile')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/', { waitUntil: 'networkidle' })
  await dismissFirstRun(page)
  await page.getByRole('button', { name: 'Open sidebar' }).click()
  await dismissFirstRun(page)
  await page.getByRole('button', { name: 'Factory', exact: true }).click()
  await page.keyboard.press('Escape')

  const app = page.getByTestId('factory-app')
  await expect(app).toBeVisible()
  const drawerToggle = page.getByRole('button', { name: 'Open sidebar' })
  const factoryHeading = app.getByRole('heading', { name: 'Factory' })
  const [drawerBox, headingBox] = await Promise.all([drawerToggle.boundingBox(), factoryHeading.boundingBox()])
  expect(drawerBox).not.toBeNull(); expect(headingBox).not.toBeNull()
  const drawerCenter = (drawerBox?.y ?? 0) + (drawerBox?.height ?? 0) / 2
  const headingCenter = (headingBox?.y ?? 0) + (headingBox?.height ?? 0) / 2
  expect(Math.abs(drawerCenter - headingCenter)).toBeLessThanOrEqual(2)
  await expect(factoryHeading.locator('..').locator('svg')).toHaveCount(0)
  const groups = app.locator('[data-flow-kind]')
  if (await groups.count()) await expect(groups.first()).toHaveAttribute('data-flow-kind', 'inbox')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  const tabs = app.getByRole('navigation', { name: 'Factory views' })
  await tabs.getByRole('button', { name: /^Triage/ }).click()
  const triage = page.getByTestId('factory-triage')
  const detail = triage.locator('aside')
  await expect(detail).toBeHidden()
  const firstResult = triage.getByRole('button', { name: /Daily workspace health review/ }).first()
  await firstResult.click()
  await expect(triage.getByRole('button', { name: 'Back to results' })).toBeVisible()
  await expect(firstResult).toBeHidden()
  const term = triage.getByText('Result', { exact: true })
  const value = term.locator('..').locator('dd')
  const [termBox, valueBox] = await Promise.all([term.boundingBox(), value.boundingBox()])
  expect(termBox).not.toBeNull(); expect(valueBox).not.toBeNull()
  expect(Math.abs((termBox?.y ?? 0) - (valueBox?.y ?? 0))).toBeLessThanOrEqual(4)
  await triage.getByRole('button', { name: 'Back to results' }).click()
  await expect(firstResult).toBeVisible()

  await tabs.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByTestId('factory-settings')
  await expect(settings.getByRole('heading', { name: 'Workspace settings' }).locator('..').locator('svg')).toHaveCount(0)
  await expect(settings.getByRole('heading', { name: 'Models' }).locator('../..').locator('svg')).toHaveCount(1)
  await expect(settings.getByRole('heading', { name: 'Worktrees' }).locator('../..').locator('svg')).toHaveCount(1)

  await tabs.getByRole('button', { name: 'Work', exact: true }).click()
  await app.locator('[data-testid^="factory-task-"]').first().locator('button').last().click()
  const card = page.getByTestId('factory-task-card')
  await expect(card.getByTestId('factory-task-comments')).toBeVisible()
  await expect(card.getByTestId('factory-task-header-status')).toBeHidden()
  const editAction = card.getByRole('button', { name: 'Edit' })
  await expect(editAction).toHaveCSS('border-top-width', '0px')
  await expect(editAction).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await editAction.click()
  await expect(card.getByRole('button', { name: 'Model' })).not.toContainText('Inherit workspace model')
  await expect(card.getByLabel('Preset')).toHaveCount(0)
  const labels = card.getByRole('combobox', { name: 'Task labels' })
  await labels.scrollIntoViewIfNeeded()
  await expect(labels).toBeVisible()
  await labels.click()
  await page.getByRole('searchbox', { name: 'Search or create labels' }).fill('mobile-created-label')
  await expect(page.getByRole('menuitem', { name: /Create mobile-created-label/ })).toBeVisible()
  await page.keyboard.press('Escape')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})
