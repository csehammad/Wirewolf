import { expect, test } from 'claude-code/testing'

import { capText, decompose, parseListing, serverHint, toolHint } from './register'

const PANE = {
  plugin: 'wirewolf',
  component: 'Pane',
  requestId: 'wirewolf',
  props: {
    title: 'Wirewolf',
    isFocused: false,
    bodyColumns: 90,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const LISTING = [
  'The following skills are available for use with the Skill tool:',
  '',
  '- pdf: Read, merge and split PDF files. Use whenever a .pdf is involved.',
  '- slack-gif-creator: Animated GIFs for Slack. Constraints, validation tools and animation concepts.',
  '  A second line of description.',
  '- commit: Write a commit message.',
].join('\n')

/** A request as the http.fetch hook measures it (a test's fetch is not the engine's). */
const MEASURE = {
  at: 1,
  total: 3150,
  system: 2000,
  messages: 50,
  tools: [
    { name: 'Read', tokens: 110, server: null, deferred: false },
    { name: 'NotebookEdit', tokens: 1010, server: null, deferred: false },
    { name: 'mcp__canva__create', tokens: 210, server: 'canva', deferred: true },
  ],
}
const TURN = {
  id: 1, at: 1, model: 'claude-opus-5-5', total: 3150,
  cats: { system: 2000, tools: 1120, context: 0, chat: 30, toolio: 0, thinking: 0 },
  msgs: 1, newMsgs: 1, newTokens: 30, toolCount: 3, deferred: 1, kind: 'prompt' as const,
}

const SEEDED: Record<string, unknown> = { measure: MEASURE, turns: [TURN] }
const SHAPES: Record<string, string> = { measure: 'measure-2', turns: 'turns-1' }

test('splits a request into system, tools, injected context, conversation and tool I/O', () => {
  const req = {
    system: [{ type: 'text', text: 'S'.repeat(400), cache_control: { type: 'ephemeral' } }],
    tools: [
      { name: 'Read', description: 'read files', input_schema: { type: 'object' } },
      { name: 'mcp__x__y', description: 'later', input_schema: { type: 'object' }, defer_loading: true },
    ],
    messages: [
      { role: 'user', content: [{ type: 'text', text: '<system-reminder>The following skills are available: …</system-reminder>' }, { type: 'text', text: 'hello there' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.ts' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'R'.repeat(200) }] },
    ],
  }
  const d = decompose(req, 1)
  expect(d.cats.system).toBe(100)
  expect(d.cats.context).toBeGreaterThan(0)
  expect(d.cats.toolio).toBeGreaterThan(50)
  expect(d.cats.chat).toBe(3)
  expect(d.deferred).toBe(1)
  expect(d.context[0]?.label).toBe('Skill listing')
  expect(d.messages.map(m => m.isNew)).toEqual([false, true, true])
  expect(d.newMsgs).toBe(2)
  expect(d.kind).toBe('loop')
  expect(d.system[0]?.sub).toContain('cache breakpoint')
})

test('drops a skill and a tool the person removes', async ($, on) => {
  const store = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'wirewolf' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/w/app' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent: 42 }, rateLimits: [] } }))
  on('env.get', () => ({ value: '/home/u' }))
  on('fs.list', () => ({ value: [] }))
  on('prompt.attachment', (_, e) => ({ text: e.text }))
  on('state.get', (_, e, next) =>
    e.key in SEEDED ? { value: { value: { shape: SHAPES[e.key], value: SEEDED[e.key] }, version: 1 } } : next(e),
  )

  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const first = await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: { kind: 'engine' } })
  expect(first.text).toContain('slack-gif-creator')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /3\.1k/ })).toBeTruthy()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'view:trim' })
  await ui.press({ key: 'rm:skill:slack-gif-creator' })
  await ui.press({ key: 'tab:tools' })
  await ui.press({ key: 'rm:tool:NotebookEdit' })
  await ui.unmount()

  const after = await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: { kind: 'engine' } })
  expect(after.text).not.toContain('slack-gif-creator')
  expect(after.text).not.toContain('A second line of description.')
  expect(after.text).toContain('- pdf:')
  expect(after.text).toContain('- commit:')

  const saved = store.get('hidden-v1') as { tool: Record<string, number>; skill: Record<string, number> }
  expect(Object.keys(saved.tool)).toEqual(['NotebookEdit'])
  expect(Object.keys(saved.skill)).toEqual(['slack-gif-creator'])
})

test('a core tool needs a second press', async ($, on) => {
  const store = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'wirewolf' } }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/w/app' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent: 42 }, rateLimits: [] } }))
  on('env.get', () => ({ value: '/home/u' }))
  on('fs.list', () => ({ value: [] }))
  on('state.get', (_, e, next) =>
    e.key in SEEDED ? { value: { value: { shape: SHAPES[e.key], value: SEEDED[e.key] }, version: 1 } } : next(e),
  )

  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'view:trim' })
  await ui.press({ key: 'tab:tools' })
  const removed = () => Object.keys((store.get('hidden-v1') as { tool?: Record<string, number> } | undefined)?.tool ?? {})
  await ui.press({ key: 'rm:tool:Read' })
  expect(removed()).toEqual([])
  expect((await ui.find({ type: 'Button', key: 'rm:tool:Read' }))?.text).toBe('Confirm')
  await ui.press({ key: 'rm:tool:Read' })
  expect(removed()).toEqual(['Read'])
  await ui.unmount()
})

test('storage shows disk use and cleaning asks twice, then removes only older sessions', async ($, on) => {
  const ran: string[][] = []
  on('store.get', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'wirewolf' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/w/app' }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent: 42 }, rateLimits: [] } }))
  on('env.get', () => ({ value: '/home/u' }))
  on('ui.toast', () => ({ value: undefined }))
  on('state.get', (_, e, next) => (e.key === 'run' ? { value: { value: '2026-11-14T10-00-00-000Z', version: 1 } } : next(e)))
  on('fs.list', (_, e) => ({
    value: e.path?.endsWith('/requests')
      ? [
          { name: '2026-11-14T10-00-00-000Z', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
          { name: '2026-11-13T09-00-00-000Z', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
          { name: 'notes.txt', kind: 'file', size: 9, mtimeMs: 0, isLink: false },
        ]
      : [{ name: '1.0.json', kind: 'file', size: 3 * 1024 * 1024, mtimeMs: 0, isLink: false }],
  }))
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'view:storage' })
  expect(await ui.find({ type: 'Text', text: /6\.0 MB/ })).toBeTruthy()

  await ui.press({ key: 'clean:older' })
  expect(ran).toEqual([])
  expect((await ui.find({ type: 'Button', key: 'clean:older' }))?.text).toContain('Confirm')
  await ui.press({ key: 'clean:older' })
  expect(ran).toEqual([['rm', '-rf', '--', '/home/u/.claude/wirewolf/requests/2026-11-13T09-00-00-000Z']])
  await ui.unmount()
})

test('draws in a narrow pane on every surface, all three views', async ($, on) => {
  on('store.get', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'wirewolf' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/w/app' }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent: 42 }, rateLimits: [] } }))
  on('env.get', () => ({ value: '/home/u' }))
  on('fs.list', () => ({ value: [] }))
  on('state.get', (_, e, next) =>
    e.key in SEEDED ? { value: { value: { shape: SHAPES[e.key], value: SEEDED[e.key] }, version: 1 } } : next(e),
  )
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    for (const bodyColumns of [28, 44, 120]) {
      const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns }, surface })
      expect(await ui.find({ type: 'Text', text: /3\.1k/ })).toBeTruthy()
      await ui.press({ key: 'view:trim' })
      await ui.press({ key: 'tab:tools' })
      expect(await ui.find({ type: 'Button', key: 'rm:tool:NotebookEdit' })).toBeTruthy()
      await ui.press({ key: 'view:storage' })
      expect(await ui.find({ type: 'Button', key: 'clean:older' })).toBeTruthy()
      await ui.press({ key: 'view:save' })
      expect(await ui.find({ type: 'Button', key: 'compact-now' })).toBeTruthy()
      expect(await ui.find({ type: 'Button', key: 'cap-toggle' })).toBeTruthy()
      await ui.press({ key: 'view:inspect' })
      await ui.unmount()
    }
  }
})

test('inspect: tinted sections open, a row opens its content inline, on desktop and terminal', async ($, on) => {
  const body = JSON.stringify({
    model: 'claude-opus-5-5',
    system: [{ type: 'text', text: 'You are Claude Code.' }],
    tools: [{ name: 'Read', description: 'read', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  })
  const turn = { ...TURN, id: 7, chunks: 1 }
  on('store.get', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'wirewolf' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/w/app' }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent: 42 }, rateLimits: [] } }))
  on('env.get', () => ({ value: '/home/u' }))
  on('fs.list', () => ({ value: [] }))
  on('fs.read', () => ({ value: body }))
  on('state.get', (_, e, next) =>
    e.key === 'turns' ? { value: { value: { shape: 'turns-1', value: [turn] }, version: 1 } }
      : e.key === 'run' ? { value: { value: 'r', version: 1 } } : next(e),
  )
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'open:system' })
    expect(await ui.find({ type: 'Button', key: 'item:sys:0' })).toBeTruthy()
    await ui.press({ key: 'item:sys:0' })
    expect(await ui.find({ type: 'Button', key: 'close-viewer' })).toBeTruthy()
    await ui.press({ key: 'close-viewer' })
    expect(await ui.find({ type: 'Button', key: 'close-viewer' })).toBeFalsy()
    await ui.press({ key: 'item:raw' })
    expect(await ui.find({ type: 'Button', key: 'close-viewer' })).toBeTruthy()
    await ui.press({ key: 'close-viewer' })
    await ui.press({ key: 'open:system' })
    await ui.unmount()
  }
})

test('large tool outputs keep their start and end, with a note', () => {
  const text = 'A'.repeat(600) + 'MIDDLE' + 'Z'.repeat(600)
  const r = capText(text, 500)
  expect(r.cut).toBe(text.length - 500)
  expect(r.text.startsWith('A'.repeat(300))).toBe(true)
  expect(r.text.endsWith('Z'.repeat(200))).toBe(true)
  expect(r.text).toContain('characters trimmed')
  expect(r.text).not.toContain('MIDDLE')
  expect(capText('short', 500)).toEqual({ text: 'short', cut: 0 })
})

test('hints say what tools, servers and skills are', () => {
  expect(toolHint('Bash', 'whatever')).toBe('Runs shell commands')
  expect(toolHint('Custom', 'Does a thing. And more detail here.')).toBe('Does a thing.')
  expect(serverHint('Claude_Browser', [])).toContain('browser')
  expect(serverHint('plugin_data_bigquery', ['query'])).toBe('From the data plugin')
  expect(serverHint('1a59c906-04da-521d-bda7-7f71b9f9e01c', ['batch', 'guide'])).toContain('batch, guide')
  expect(serverHint('weird', ['a', 'b'])).toBe('Tools: a, b')
  expect(parseListing(LISTING).entries.map(x => x.name)).toEqual(['pdf', 'slack-gif-creator', 'commit'])
})

test('Save: switches persist, shorter skills apply, repeated reminders drop, removals can stay in one project', async ($, on) => {
  const store = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'wirewolf' } }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/w/app' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent: 42 }, rateLimits: [] } }))
  on('env.get', () => ({ value: '/home/u' }))
  on('fs.list', () => ({ value: [] }))
  on('prompt.attachment', (_, e) => ({ text: e.text }))
  on('state.get', (_, e, next) =>
    e.key in SEEDED ? { value: { value: { shape: SHAPES[e.key], value: SEEDED[e.key] }, version: 1 } } : next(e),
  )
  await $.session.start({ cwd: '/w/app', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'view:save' })
  expect(await ui.find({ type: 'Text', text: /42%/ })).toBeTruthy()
  await ui.press({ key: 'cap-toggle' })
  await ui.press({ key: 'short-skills' })
  await ui.press({ key: 'dedupe' })
  await ui.press({ key: 'scope:project' })
  const saved = store.get('settings-v1') as Record<string, unknown>
  expect(saved.capResults).toBe(true)
  expect(saved.shortSkills).toBe(true)
  expect(saved.dedupe).toBe(true)
  expect(saved.scope).toBe('project')

  // shorter skill descriptions: one line, first sentence
  const listing = await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: { kind: 'engine' } })
  expect(listing.text).toContain('- pdf: Read, merge and split PDF files.')
  expect(listing.text).not.toContain('Use whenever')
  expect(listing.text).not.toContain('A second line of description.')

  // a repeated memory reminder is dropped the second time
  const mem = { type: 'nested_memory', text: '# CLAUDE.md\nbe brief', origin: { kind: 'engine' as const } }
  expect((await $.prompt.attachment(mem)).text).toContain('be brief')
  expect((await $.prompt.attachment(mem)).text).toBeNull()

  // a removal now lands in this project's list only
  await ui.press({ key: 'view:trim' })
  await ui.press({ key: 'tab:tools' })
  await ui.press({ key: 'rm:tool:NotebookEdit' })
  expect(Object.keys((store.get('hidden-v1@/w/app') as { tool: Record<string, number> }).tool)).toEqual(['NotebookEdit'])
  expect(store.get('hidden-v1')).toBeUndefined()

  // defer all MCP from the Save view
  await ui.press({ key: 'view:save' })
  await ui.press({ key: 'defer-builtin' })
  expect(Object.keys((store.get('hidden-v1@/w/app') as { defer: Record<string, number> }).defer)).toEqual([])
  await ui.unmount()
})
