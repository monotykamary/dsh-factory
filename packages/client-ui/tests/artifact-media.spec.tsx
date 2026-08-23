// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  FactoryArtifactMediaId, FactoryRunId, FactoryTaskId,
  type FactoryArtifactMedia as ArtifactMedia,
} from 'dsh-factory-protocol'
import { FactoryArtifactMedia } from '../src/client/FactoryArtifactMedia.tsx'
import type { FactoryRemote } from '../src/client/factory-client.ts'

afterEach(cleanup)

const taskId = FactoryTaskId('task:artifact-media')
const runId = FactoryRunId('run:artifact-media')
const image: ArtifactMedia = {
  id: FactoryArtifactMediaId('screens/screen.png'), kind: 'image', name: 'screen.png', path: 'screens/screen.png',
  mediaType: 'image/png', bytes: 3, modifiedAt: '2026-08-24T12:00:00.000Z', version: '3:1',
}
const video: ArtifactMedia = {
  id: FactoryArtifactMediaId('walkthrough.mp4'), kind: 'video', name: 'walkthrough.mp4', path: 'walkthrough.mp4',
  mediaType: 'video/mp4', bytes: 5, modifiedAt: '2026-08-24T12:00:01.000Z', version: '5:2',
}

function api() {
  const artifactMedia = vi.fn(async () => ({ ok: true as const, value: [image, video] }))
  const artifactMediaData = vi.fn(async (request: { media: { mediaId: ArtifactMedia['id']; version: string }[] }) => ({
    ok: true as const,
    value: request.media.map(item => ({
      mediaId: item.mediaId, version: item.version,
      dataUrl: item.mediaId === image.id ? 'data:image/png;base64,cG5n' : 'data:video/mp4;base64,dmlkZW8=',
    })),
  }))
  return { face: { artifactMedia, artifactMediaData } as unknown as Pick<FactoryRemote, 'artifactMedia' | 'artifactMediaData'>, artifactMedia, artifactMediaData }
}

describe('Factory artifact media', () => {
  it('loads a revision once and carousels across image and video artifacts', async () => {
    const remote = api()
    const view = render(<FactoryArtifactMedia api={remote.face} taskId={taskId} runId={runId} refreshToken="one" surface="task" />)

    const rail = await screen.findByRole('group', { name: 'Artifact media' })
    expect(rail.querySelectorAll('img')).toHaveLength(1)
    expect(rail.querySelectorAll('video')).toHaveLength(1)
    expect(remote.artifactMediaData).toHaveBeenCalledTimes(1)

    const opener = screen.getByRole('button', { name: 'screens/screen.png' })
    opener.focus()
    fireEvent.click(opener)
    const dialog = screen.getByRole('dialog', { name: 'Artifact preview' })
    expect(dialog.getAttribute('data-presentation')).toBe('floating-media')
    expect(dialog.parentElement).toBe(document.body)
    expect(within(dialog).getByTestId('factory-media-viewer-mask')).toBeTruthy()
    expect(within(dialog).getByTestId('factory-media-viewer-controls').textContent).toBe('screens/screen.png1 of 2PreviousNext')
    expect(within(dialog).getByRole('img', { name: 'screens/screen.png' })).toBeTruthy()
    expect(screen.getByText('1 of 2')).toBeTruthy()

    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(within(dialog).getByLabelText('walkthrough.mp4', { selector: 'video' })).toBeTruthy()
    expect(screen.getByText('2 of 2')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }))
    expect(within(dialog).getByRole('img', { name: 'screens/screen.png' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Close artifact preview' }))
    expect(screen.queryByRole('dialog', { name: 'Artifact preview' })).toBeNull()
    expect(document.activeElement).toBe(opener)

    view.rerender(<FactoryArtifactMedia api={remote.face} taskId={taskId} runId={runId} refreshToken="two" surface="triage" />)
    await waitFor(() => { expect(remote.artifactMedia).toHaveBeenCalledTimes(2) })
    expect(remote.artifactMediaData).toHaveBeenCalledTimes(1)
    expect(await screen.findByTestId('factory-artifact-media')).toBeTruthy()
  })
})
