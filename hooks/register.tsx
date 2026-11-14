/**
 * Wirewolf: exactly what every Claude Code request carries, and the ways
 * to send less of it.
 *
 * Inspect — each model request as it leaves, split into system prompt, tool
 *   schemas, injected context, conversation, tool I/O and thinking; every piece
 *   readable in full; the largest blocks in history; the exact request JSON;
 *   cached vs new tokens as the API reported them.
 * Save — shorten large tool outputs, compact, defer tools behind ToolSearch,
 *   shorter tool and skill descriptions, drop repeated reminders, and whether
 *   removals apply to every project or this one.
 * Trim — remove skills, tools, MCP servers and optional prompt sections, each
 *   with a hint saying what it is.
 * Storage — the saved requests on disk, and cleaning them.
 * Estimates are chars / 4, the same method Iris uses before calibration.
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type {
  TrimCats, TrimDisk, TrimHidden, TrimItem, TrimKind, TrimMeasure, TrimSettings, TrimTab, TrimTool, TrimTurn,
  TrimUsage, TrimView,
} from '../types'

type $ = EngineInterface

const PANE = 'wirewolf'
const STORE_HIDDEN = 'hidden-v1'
const STORE_USES = 'uses-v1'
const STORE_SETTINGS = 'settings-v1'
const TABS: TrimTab[] = ['skills', 'tools', 'mcp', 'prompt']
const VIEWS: Array<{ id: TrimView; label: string }> = [
  { id: 'inspect', label: 'Inspect' },
  { id: 'save', label: 'Save' },
  { id: 'trim', label: 'Trim' },
  { id: 'storage', label: 'Storage' },
]
const EMPTY: TrimHidden = { skill: {}, tool: {}, defer: {}, server: {}, section: {} }
const DEFAULTS: TrimSettings = {
  capResults: false, capChars: 20_000, shortTools: false, shortSkills: false, dedupe: false, alertPct: 70, scope: 'global',
}
const PAGE = 12_000
/** Characters per file on disk; a read is capped at 4 MiB. */
const CHUNK = 900_000
/** Decoded requests held in memory; every request stays on disk. */
const CACHE = 4

/** Tools an agent needs for ordinary work: removing one asks for a second press. */
const CORE_TOOLS = new Set([
  'Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep', 'Skill', 'ToolSearch', 'Agent', 'Task', 'TodoWrite',
])
/** Tool outputs never shortened: Claude edits from what Read showed it. */
const NEVER_CAP = new Set(['Read', 'NotebookRead'])
/** System prompt sections that are never offered for removal. */
const CORE_SECTIONS = new Set(['intro', 'system', 'doing_tasks', 'actions', 'tools', 'tone', 'lean_body', 'bare'])

/** What the built-in tools do, in a few words. */
const TOOL_HINTS: Record<string, string> = {
  Read: 'Reads files, images and PDFs', Edit: 'Edits part of a file in place', Write: 'Creates or overwrites a file',
  Bash: 'Runs shell commands', Glob: 'Finds files by name pattern', Grep: 'Searches inside files',
  Agent: 'Starts a subagent for a side task', Task: 'Starts a subagent for a side task', TodoWrite: 'Keeps a task checklist',
  WebFetch: 'Fetches and reads a web page', WebSearch: 'Searches the web', NotebookEdit: 'Edits Jupyter notebook cells',
  Skill: 'Runs one of your installed skills', ToolSearch: 'Loads deferred tools when they are needed',
  AskUserQuestion: 'Asks you a multiple-choice question', EnterPlanMode: 'Switches into plan mode',
  ExitPlanMode: 'Presents a plan for your approval', SendMessage: 'Messages another agent or session',
  Monitor: 'Waits on a background condition', CronCreate: 'Schedules a recurring task', CronDelete: 'Removes a scheduled task',
  CronList: 'Lists scheduled tasks', TaskStop: 'Stops a background task', EnterWorktree: 'Moves work into a git worktree',
  ExitWorktree: 'Leaves a git worktree', SendUserFile: 'Sends you a file card', Artifact: 'Publishes a page on claude.ai',
  ReportFindings: 'Reports code-review findings', ScheduleWakeup: 'Paces a /loop run', SearchPlugins: 'Searches the plugin catalog',
  SuggestPluginInstall: 'Offers a plugin to install', SuggestSkills: 'Offers skills to add', ListAgents: 'Lists agents to message',
}
/** What well-known MCP servers are. */
const SERVER_HINTS: Array<[RegExp, string]> = [
  [/^Claude_Browser$/, 'Built-in browser pane of the desktop app'],
  [/^Claude_Code_iOS_Simulator$/, 'Runs and drives apps in the iOS Simulator'],
  [/^claude-in-chrome$/, 'Controls your own Chrome browser'],
  [/^visualize$/, 'Draws charts and diagrams inline in chat'],
  [/^ccd_session/, 'Desktop app: start and manage sessions'],
  [/^ccd_turn/, 'Desktop app: the task list under messages'],
  [/^ccd_/, 'Claude desktop app integration'],
  [/^terminal$/, 'Desktop app terminal panel'],
  [/^mcp-registry$/, 'Finds connectors to add'],
  [/^scheduled-tasks$/, 'Scheduled tasks'],
  [/^plugin_([^_]+)_/, 'From the $1 plugin'],
  [/^[0-9a-f]{8}-[0-9a-f]{4}-/, 'A claude.ai connector'],
]
/** What the system prompt's sections are. */
const SECTION_HINTS: Record<string, string> = {
  intro: 'Who Claude is', system: 'How the session works', doing_tasks: 'How to approach coding work',
  actions: 'When to ask before acting', tools: 'How to use the tools', tone: 'Tone and formatting',
  env_info: 'Your OS, folder and date', env_info_simple: 'Your OS, folder and date', memory: 'Your saved memory',
  output_style: 'Your output style', mcp_instructions: 'Instructions from MCP servers',
}

/** Category order, names and colors (mid-tones that read on light and dark). */
const CATS: Array<{ key: keyof TrimCats; label: string; color: string }> = [
  { key: 'system', label: 'System prompt', color: '#D97757' },
  { key: 'tools', label: 'Tool schemas', color: '#6A9BCC' },
  { key: 'context', label: 'Injected context', color: '#B08BD9' },
  { key: 'chat', label: 'Conversation', color: '#788C5D' },
  { key: 'toolio', label: 'Tool calls & results', color: '#C9A227' },
  { key: 'thinking', label: 'Thinking', color: '#8A8F98' },
]
const ACCENT: Record<TrimTab, string> = { skills: '#A78BFA', tools: '#60A5FA', mcp: '#34D399', prompt: '#FB923C' }
const NEVER = '#F59E0B'
const USED = '#10B981'

const measure = atom({ plugin: 'wirewolf', key: 'measure' } as const, null, { shape: 'measure-2' })
const turns = atom({ plugin: 'wirewolf', key: 'turns' } as const, [], { shape: 'turns-1' })
const skills = atom({ plugin: 'wirewolf', key: 'skills' } as const, [], { shape: 'skills-2' })
const sections = atom({ plugin: 'wirewolf', key: 'sections' } as const, [], { shape: 'sections-2' })
const uses = atom({ plugin: 'wirewolf', key: 'uses' } as const, {}, { shape: 'uses-1' })
const hidden = atom({ plugin: 'wirewolf', key: 'hidden' } as const, EMPTY, { shape: 'hidden-1' })
const projHidden = atom({ plugin: 'wirewolf', key: 'projHidden' } as const, EMPTY, { shape: 'hidden-1' })
const settings = atom({ plugin: 'wirewolf', key: 'settings' } as const, DEFAULTS, { shape: 'settings-1' })
const seen = atom({ plugin: 'wirewolf', key: 'seen' } as const, [], { shape: 'seen-1' })
const dirty = atom({ plugin: 'wirewolf', key: 'dirty' } as const, false)
const tab = atom({ plugin: 'wirewolf', key: 'tab' } as const, 'skills' as TrimTab)
const view = atom({ plugin: 'wirewolf', key: 'view' } as const, 'inspect' as TrimView)
const confirm = atom({ plugin: 'wirewolf', key: 'confirm' } as const, '')
const sel = atom({ plugin: 'wirewolf', key: 'sel' } as const, 0)
const open = atom({ plugin: 'wirewolf', key: 'open' } as const, ['context'], { shape: 'open-1' })
const item = atom({ plugin: 'wirewolf', key: 'item' } as const, '')
const page = atom({ plugin: 'wirewolf', key: 'page' } as const, 0)
const run = atom({ plugin: 'wirewolf', key: 'run' } as const, '')
const disk = atom({ plugin: 'wirewolf', key: 'disk' } as const, null, { shape: 'disk-1' })
const cleanAsk = atom({ plugin: 'wirewolf', key: 'cleanAsk' } as const, '')
const ctxPct = atom({ plugin: 'wirewolf', key: 'ctxPct' } as const, 0)
const savedChars = atom({ plugin: 'wirewolf', key: 'savedChars' } as const, 0)
const root = atom({ plugin: 'wirewolf', key: 'root' } as const, '')

// ── full request content: every request on disk, the latest few decoded ────

type Piece = { id: string; label: string; sub: string; tokens: number; text: string; isNew?: boolean }
type Detail = { system: Piece[]; tools: Piece[]; context: Piece[]; messages: Piece[]; heavy: Piece[]; raw: string }
const cache = new Map<number, Detail>()

function remember(id: number, d: Detail) {
  cache.delete(id)
  cache.set(id, d)
  for (const key of [...cache.keys()].slice(0, Math.max(0, cache.size - CACHE))) cache.delete(key)
}

// ── pure helpers ───────────────────────────────────────────────────────────

const est = (s: string) => Math.ceil(s.length / 4)
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)))
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s)
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
const time = (ms: number) => new Date(ms).toTimeString().slice(0, 8)
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '0%')
const mb = (b: number) => (b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(2)} GB` : b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB` : `${Math.max(0, Math.round(b / 1024))} KB`)
/** The server part of an MCP tool name, as the tool name spells it. */
const norm = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_')
const firstSentence = (s: string, n = 90) => clip(oneLine(s).split(/(?<=[.!?])\s/)[0] ?? '', n)

function serverOf(tool: string): string | null {
  if (!tool.startsWith('mcp__')) return null
  const rest = tool.slice(5)
  const i = rest.indexOf('__')
  return i > 0 ? rest.slice(0, i) : null
}

export function toolHint(name: string, description: string): string {
  return TOOL_HINTS[name] ?? (firstSentence(description) || 'No description')
}

export function serverHint(server: string, toolNames: string[]): string {
  for (const [re, text] of SERVER_HINTS) {
    const m = re.exec(server)
    if (m) {
      const base = text.replace('$1', m[1] ?? '')
      return re.source.startsWith('^[0-9a-f]') ? `${base}: ${toolNames.slice(0, 3).join(', ')}` : base
    }
  }
  return toolNames.length ? `Tools: ${toolNames.slice(0, 3).join(', ')}${toolNames.length > 3 ? '…' : ''}` : 'MCP server'
}

/** Shortens one text to `cap` characters: its start and end, with a note in the middle. */
export function capText(text: string, cap: number): { text: string; cut: number } {
  if (text.length <= cap) return { text, cut: 0 }
  const head = Math.floor(cap * 0.6)
  const tail = cap - head
  const cut = text.length - cap
  return {
    text: `${text.slice(0, head)}\n\n[wirewolf: ${cut.toLocaleString()} characters trimmed from the middle of this output to save context. Re-run with a narrower command or range to see them.]\n\n${text.slice(-tail)}`,
    cut,
  }
}

/** Shortens the text of a tool_result block; other blocks pass unchanged. */
function capBlock<B>(b: B, cap: number, onCut: (n: number) => void): B {
  const block = b as Record<string, unknown>
  if (block.type !== 'tool_result') return b
  const c = block.content
  if (typeof c === 'string') {
    const r = capText(c, cap)
    if (!r.cut) return b
    onCut(r.cut)
    return { ...block, content: r.text } as B
  }
  if (Array.isArray(c)) {
    let changed = false
    const content = c.map(x => {
      const part = x as Record<string, unknown>
      if (part.type !== 'text' || typeof part.text !== 'string') return x
      const r = capText(part.text, cap)
      if (!r.cut) return x
      changed = true
      onCut(r.cut)
      return { ...part, text: r.text }
    })
    return changed ? ({ ...block, content } as B) : b
  }
  return b
}

function hash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return `${s.length}:${(h >>> 0).toString(36)}`
}

function withHidden(v0: unknown): TrimHidden {
  const v = (v0 && typeof v0 === 'object' ? v0 : {}) as Partial<TrimHidden>
  return {
    skill: v.skill ?? {}, tool: v.tool ?? {}, defer: v.defer ?? {}, server: v.server ?? {}, section: v.section ?? {},
  }
}

function mergeHidden(a: TrimHidden, b: TrimHidden): TrimHidden {
  return {
    skill: { ...a.skill, ...b.skill }, tool: { ...a.tool, ...b.tool }, defer: { ...a.defer, ...b.defer },
    server: { ...a.server, ...b.server }, section: { ...a.section, ...b.section },
  }
}

function withSettings(v0: unknown): TrimSettings {
  return { ...DEFAULTS, ...((v0 && typeof v0 === 'object' ? v0 : {}) as Partial<TrimSettings>) }
}

type Entry = { name: string; lines: string[] }

/** Splits the skill listing into its framing and one entry per `- name: …` line. */
export function parseListing(text: string) {
  const head: string[] = []
  const entries: Entry[] = []
  for (const line of text.split('\n')) {
    const m = /^- ([^\s:][^:]*?):(\s|$)/.exec(line)
    if (m) entries.push({ name: m[1] ?? '', lines: [line] })
    else if (entries.length) entries[entries.length - 1]?.lines.push(line)
    else head.push(line)
  }
  return { head, entries }
}

/** One skill entry cut to its first sentence. */
function shortEntry(x: Entry): string[] {
  const body = oneLine(x.lines.join(' ').replace(/^- [^:]+:\s*/, ''))
  return [`- ${x.name}: ${firstSentence(body, 140)}`]
}

/** A long tool description cut to its first paragraph. */
function shortDescription(text: string): string {
  if (text.length <= 800) return text
  const first = text.split(/\n\s*\n/)[0] ?? text
  return clip(first, 600)
}

type Block = Record<string, unknown>

function blockText(b: Block): string {
  if (typeof b.text === 'string') return b.text
  if (typeof b.thinking === 'string') return b.thinking
  if (b.type === 'tool_use') return JSON.stringify(b.input ?? {}, null, 2)
  if (b.type === 'tool_result') {
    const c = b.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) return c.map(x => blockText(x as Block)).join('\n')
    return ''
  }
  if (b.type === 'image' || b.type === 'document') return `[${String(b.type)}]`
  return JSON.stringify(b)
}

function contextLabel(text: string): string {
  const body = oneLine(text.replace(/<\/?system-reminder>/g, ''))
  if (/skills are available/i.test(body)) return 'Skill listing'
  if (/claudeMd|CLAUDE\.md|# claudeMd/i.test(body)) return 'CLAUDE.md / memory'
  if (/deferred tools|ToolSearch/i.test(body)) return 'Deferred tools list'
  if (/MCP Server Instructions/i.test(body)) return 'MCP server instructions'
  return clip(body, 60) || 'System reminder'
}

/** Breaks one request into its parts, every part with its exact text. */
export function decompose(req: Record<string, unknown>, prevMsgs: number) {
  const cats: TrimCats = { system: 0, tools: 0, context: 0, chat: 0, toolio: 0, thinking: 0 }
  const system: Piece[] = []
  const sys = req.system
  const sysBlocks: Block[] = typeof sys === 'string' ? [{ type: 'text', text: sys }] : Array.isArray(sys) ? (sys as Block[]) : []
  sysBlocks.forEach((b, i) => {
    const text = blockText(b)
    const tokens = est(text)
    cats.system += tokens
    system.push({
      id: `sys:${i}`, label: `System block ${i + 1}`, tokens, text,
      sub: `${b.cache_control ? 'cache breakpoint · ' : ''}${clip(oneLine(text), 80)}`,
    })
  })

  const rawTools = Array.isArray(req.tools) ? (req.tools as Block[]) : []
  const tools: Piece[] = []
  const trimTools: TrimTool[] = []
  let deferred = 0
  for (const t of rawTools) {
    const name = String(t.name ?? '')
    const desc = String(t.description ?? '')
    const tokens = est(JSON.stringify(t))
    const isDeferred = t.defer_loading === true
    if (isDeferred) deferred++
    else cats.tools += tokens
    const hint = toolHint(name, desc)
    trimTools.push({ name, tokens, server: serverOf(name), deferred: isDeferred, hint })
    tools.push({
      id: `tool:${name}`, label: name, tokens: isDeferred ? 0 : tokens, text: JSON.stringify(t, null, 2),
      sub: isDeferred ? `deferred · ${hint}` : hint,
    })
  }
  tools.sort((a, b) => b.tokens - a.tokens)

  const msgs = Array.isArray(req.messages) ? (req.messages as Block[]) : []
  const fresh = msgs.length >= prevMsgs ? prevMsgs : 0
  const context: Piece[] = []
  const messages: Piece[] = []
  const heavy: Piece[] = []
  const toolNames = new Map<string, string>()
  let newTokens = 0
  msgs.forEach((m, i) => {
    const role = String(m.role ?? '?')
    const isNew = i >= fresh
    const blocks: Block[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? (m.content as Block[]) : []
    const own: string[] = []
    let ownTokens = 0
    const kinds = new Set<string>()
    blocks.forEach((b, j) => {
      const text = blockText(b)
      const tokens = est(text)
      if (isNew) newTokens += tokens
      if (b.type === 'text' && /^\s*<system-reminder>/.test(text)) {
        cats.context += tokens
        context.push({ id: `ctx:${i}:${j}`, label: contextLabel(text), sub: `in message #${i + 1}`, tokens, text, isNew })
        return
      }
      if (b.type === 'tool_use') toolNames.set(String(b.id ?? ''), String(b.name ?? 'tool'))
      if (b.type === 'tool_use' || b.type === 'tool_result') cats.toolio += tokens
      else if (b.type === 'thinking' || b.type === 'redacted_thinking') cats.thinking += tokens
      else cats.chat += tokens
      kinds.add(b.type === 'tool_use' ? `call ${String(b.name ?? '')}` : String(b.type ?? 'text'))
      own.push(b.type === 'tool_use' ? `▶ ${String(b.name ?? '')}\n${text}` : b.type === 'tool_result' ? `◀ result\n${text}` : text)
      ownTokens += tokens
      const label = b.type === 'tool_result' ? `${toolNames.get(String(b.tool_use_id ?? '')) ?? 'tool'} result`
        : b.type === 'tool_use' ? `${String(b.name ?? 'tool')} call`
          : b.type === 'thinking' || b.type === 'redacted_thinking' ? 'thinking' : `${role} text`
      heavy.push({ id: `heavy:${i}:${j}`, label, sub: `message #${i + 1} · ${clip(oneLine(text), 60)}`, tokens, text, isNew })
    })
    if (!own.length) return
    messages.push({
      id: `msg:${i}`, label: `#${i + 1} ${role}`, tokens: ownTokens, text: own.join('\n\n'), isNew,
      sub: `${[...kinds].join(', ')} · ${clip(oneLine(own.join(' ')), 70)}`,
    })
  })
  heavy.sort((a, b) => b.tokens - a.tokens)

  const last = msgs[msgs.length - 1]
  const lastBlocks = last && Array.isArray(last.content) ? (last.content as Block[]) : []
  const isPrompt = last?.role === 'user' && !lastBlocks.some(b => b.type === 'tool_result')

  return {
    cats, system, tools, context, messages, heavy: heavy.slice(0, 15), trimTools, deferred, newTokens,
    msgCount: msgs.length, newMsgs: msgs.length - fresh, kind: (isPrompt ? 'prompt' : 'loop') as TrimTurn['kind'],
  }
}

type Row = TrimItem & { used: number; removable: boolean; deferred?: boolean; tools?: number }

function serverRows(m: TrimMeasure | null, u: Record<string, number>): Row[] {
  const by = new Map<string, Row & { names: string[] }>()
  for (const t of m?.tools ?? []) {
    if (!t.server) continue
    const r = by.get(t.server) ?? { name: t.server, tokens: 0, used: 0, removable: true, tools: 0, deferred: true, names: [] }
    r.tokens += t.deferred ? 0 : t.tokens
    r.used += u[t.name] ?? 0
    r.tools = (r.tools ?? 0) + 1
    r.deferred = r.deferred && t.deferred
    r.names.push(t.name.slice(`mcp__${t.server}__`.length))
    by.set(t.server, r)
  }
  return [...by.values()]
    .map(({ names, ...r }) => ({ ...r, hint: serverHint(r.name, names) }))
    .sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name))
}

function rowsFor(
  t: TrimTab, m: TrimMeasure | null, sk: TrimItem[], sec: TrimItem[], u: Record<string, number>, hid: TrimHidden,
): Row[] {
  if (t === 'skills') {
    return sk.filter(s => !hid.skill[s.name])
      .map(s => ({ ...s, used: u[`skill:${s.name}`] ?? 0, removable: true }))
      .sort((a, b) => b.tokens - a.tokens)
  }
  if (t === 'tools') {
    return (m?.tools ?? []).filter(x => !x.server && !hid.tool[x.name])
      .map(x => ({ name: x.name, hint: x.hint, tokens: x.deferred ? 0 : x.tokens, used: u[x.name] ?? 0, removable: true, deferred: x.deferred }))
      .sort((a, b) => b.tokens - a.tokens)
  }
  if (t === 'mcp') return serverRows(m, u).filter(r => !hid.server[r.name])
  return sec.filter(s => !hid.section[s.name])
    .map(s => ({ ...s, used: 1, removable: !CORE_SECTIONS.has(s.name) }))
    .sort((a, b) => b.tokens - a.tokens)
}

const KIND: Record<TrimTab, TrimKind> = { skills: 'skill', tools: 'tool', mcp: 'server', prompt: 'section' }

function unusedRows(t: TrimTab, rows: Row[]) {
  return rows.filter(r => r.removable && r.used === 0 && r.tokens > 0 && !(t === 'tools' && CORE_TOOLS.has(r.name)))
}

/** A stacked bar of where the request's tokens go, as an SVG image. */
function barSvg(cats: TrimCats, total: number): string {
  const W = 600
  const H = 18
  let x = 0
  const parts = CATS.map(c => {
    const w = total ? (cats[c.key] / total) * W : 0
    const rect = w > 0
      ? `<rect x="${x.toFixed(2)}" y="0" width="${Math.max(w - 1.5, 0.5).toFixed(2)}" height="${H}" fill="${c.color}"><title>${c.label}: ${k(cats[c.key])} (${pct(cats[c.key], total)})</title></rect>`
      : ''
    x += w
    return rect
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><defs><clipPath id="r"><rect width="${W}" height="${H}" rx="6"/></clipPath></defs><g clip-path="url(#r)"><rect width="${W}" height="${H}" fill="#8A8F98" opacity="0.15"/>${parts}</g></svg>`
}

/** A rounded meter, 0..1, in one color. */
function meterSvg(value: number, color: string): string {
  const w = Math.max(0, Math.min(1, value)) * 600
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 10" preserveAspectRatio="none"><defs><clipPath id="g"><rect width="600" height="10" rx="5"/></clipPath></defs><g clip-path="url(#g)"><rect width="600" height="10" fill="#94A3B8" opacity="0.3"/><rect width="${w.toFixed(1)}" height="10" fill="${color}"/></g></svg>`
}

// ── effects through $ (top-level functions only) ───────────────────────────

async function loadSettings($: $): Promise<TrimSettings> {
  return withSettings(await $.store.get(STORE_SETTINGS))
}

async function setSetting($: $, patch: Partial<TrimSettings>) {
  const nextSettings = { ...(await loadSettings($)), ...patch }
  await $.store.set(STORE_SETTINGS, nextSettings)
  await update($, settings, () => nextSettings)
  if ('shortTools' in patch || 'shortSkills' in patch) await update($, dirty, () => true)
}

async function projectKey($: $): Promise<string> {
  let r = await read($, root)
  if (!r) {
    r = await $.session.root()
    await update($, root, () => r)
  }
  return `${STORE_HIDDEN}@${r}`
}

/** Removals for this session: every project's, plus this project's own. */
async function loadHidden($: $): Promise<TrimHidden> {
  const g = withHidden(await $.store.get(STORE_HIDDEN))
  const p = withHidden(await $.store.get(await projectKey($)))
  return mergeHidden(g, p)
}

async function refreshHidden($: $) {
  const p = withHidden(await $.store.get(await projectKey($)))
  const merged = await loadHidden($)
  await update($, hidden, () => merged)
  await update($, projHidden, () => p)
  await update($, dirty, () => true)
  await update($, confirm, () => '')
  $.ui.invalidate('tool.list')
}

/** Writes removals to every project, or to this one, as the Save view says. */
async function setHidden($: $, fn: (v: TrimHidden) => TrimHidden) {
  const s = await loadSettings($)
  const key = s.scope === 'project' ? await projectKey($) : STORE_HIDDEN
  await $.store.set(key, fn(withHidden(await $.store.get(key))))
  await refreshHidden($)
}

async function hide($: $, kind: TrimKind, name: string, tokens: number) {
  await setHidden($, v => ({ ...v, [kind]: { ...v[kind], [name]: tokens } }))
}

async function hideMany($: $, kind: TrimKind, rows: Array<{ name: string; tokens: number }>) {
  if (!rows.length) return
  await setHidden($, v => ({ ...v, [kind]: { ...v[kind], ...Object.fromEntries(rows.map(r => [r.name, r.tokens])) } }))
}

/** Restores from every project and from this one. */
async function restore($: $, kind: TrimKind, name: string) {
  for (const key of [STORE_HIDDEN, await projectKey($)]) {
    const v = withHidden(await $.store.get(key))
    const { [name]: _gone, ...rest } = v[kind]
    await $.store.set(key, { ...v, [kind]: rest })
  }
  await refreshHidden($)
}

async function restoreKinds($: $, kinds: TrimKind[]) {
  for (const key of [STORE_HIDDEN, await projectKey($)]) {
    const v = withHidden(await $.store.get(key))
    await $.store.set(key, { ...v, ...Object.fromEntries(kinds.map(x => [x, {}])) })
  }
  await refreshHidden($)
}

async function restoreAll($: $) {
  await restoreKinds($, ['skill', 'tool', 'defer', 'server', 'section'])
}

/** Presses a Remove: core tools take a second press. */
async function pressRemove($: $, kind: TrimKind, name: string, tokens: number) {
  const key = `${kind}:${name}`
  if (kind === 'tool' && CORE_TOOLS.has(name) && (await read($, confirm)) !== key) {
    await update($, confirm, () => key)
    return
  }
  await hide($, kind, name, tokens)
}

async function trimUnused($: $, t: TrimTab) {
  const rows = rowsFor(t, await read($, measure), await read($, skills), await read($, sections), await read($, uses), await read($, hidden))
  await hideMany($, KIND[t], unusedRows(t, rows))
}

/** Defers a group of tools behind ToolSearch. */
async function deferGroup($: $, group: 'mcp' | 'builtin') {
  const m = await read($, measure)
  const hid = await read($, hidden)
  const pick = (m?.tools ?? []).filter(t => !t.deferred && !hid.defer[t.name] && !hid.tool[t.name]
    && (group === 'mcp' ? !!t.server : !t.server && !CORE_TOOLS.has(t.name)))
  await hideMany($, 'defer', pick)
}

async function countUse($: $, name: string) {
  const all = ((await $.store.get(STORE_USES)) ?? {}) as Record<string, number>
  const nextAll = { ...all, [name]: (all[name] ?? 0) + 1 }
  await $.store.set(STORE_USES, nextAll)
  await update($, uses, () => nextAll)
}

async function addSaved($: $, chars: number) {
  await update($, savedChars, n => n + chars)
}

async function toggleOpen($: $, key: string) {
  await update($, open, list => (list.includes(key) ? list.filter(x => x !== key) : [...list, key]))
}

async function showItem($: $, id: string) {
  await update($, item, () => id)
  await update($, page, () => 0)
}

async function selectTurn($: $, id: number) {
  await update($, sel, () => id)
  await update($, item, () => '')
}

async function readContext($: $) {
  try {
    const { context } = await $.session.usage()
    await update($, ctxPct, () => Math.round(context.percent ?? 0))
  } catch {
    // the host keeps no figures
  }
}

async function compactNow($: $) {
  try {
    const r = await $.session.compact()
    if ('skip' in r && r.skip) $.ui.toast(`Compaction skipped: ${r.skip}`)
    else $.ui.toast('Conversation compacted.')
  } catch {
    $.ui.toast('Compaction runs between turns. Try again when Claude has finished.')
  }
  await readContext($)
}

/** Puts what the API reported on the request it answers. */
async function recordUsage($: $, u: TrimUsage) {
  await update($, turns, list => {
    const i = [...list].reverse().findIndex(x => x.toolCount > 0 && !x.usage)
    if (i < 0) return list
    const at = list.length - 1 - i
    return list.map((x, j) => (j === at ? { ...x, usage: u } : x))
  })
}

/** This session's folder of saved requests. */
async function requestDir($: $): Promise<string> {
  let key = await read($, run)
  if (!key) {
    key = new Date().toISOString().replace(/[:.]/g, '-')
    await update($, run, () => key)
  }
  return `${await requestRoot($)}/${key}`
}

async function requestRoot($: $): Promise<string> {
  const home = (await $.env.get('HOME')) ?? '.'
  return `${home}/.claude/wirewolf/requests`
}

/** Sizes of every saved session folder. */
async function measureDisk($: $) {
  const base = await requestRoot($)
  const current = await read($, run)
  const out: TrimDisk = { at: Date.now(), bytes: 0, files: 0, sessions: 0, currentBytes: 0, currentFiles: 0 }
  let dirs: Array<{ name: string; kind: string }> = []
  try {
    dirs = await $.fs.list(base)
  } catch {
    dirs = []
  }
  for (const d of dirs) {
    if (d.kind !== 'dir') continue
    out.sessions++
    let files: Array<{ kind: string; size: number }> = []
    try {
      files = await $.fs.list(`${base}/${d.name}`)
    } catch {
      files = []
    }
    for (const f of files) {
      if (f.kind !== 'file') continue
      out.bytes += f.size
      out.files++
      if (d.name === current) {
        out.currentBytes += f.size
        out.currentFiles++
      }
    }
  }
  await update($, disk, () => out)
}

/** Deletes saved requests: every other session's, or all of them. Asks twice. */
async function pressClean($: $, scope: 'older' | 'all') {
  if ((await read($, cleanAsk)) !== scope) {
    await update($, cleanAsk, () => scope)
    return
  }
  await update($, cleanAsk, () => '')
  const base = await requestRoot($)
  const current = await read($, run)
  let dirs: Array<{ name: string; kind: string }> = []
  try {
    dirs = await $.fs.list(base)
  } catch {
    dirs = []
  }
  const targets = dirs
    .filter(d => d.kind === 'dir' && /^[0-9T-]+Z$/.test(d.name) && (scope === 'all' || d.name !== current))
    .map(d => `${base}/${d.name}`)
  if (targets.length) await $.process.run(['rm', '-rf', '--', ...targets], { timeoutMs: 60_000 })
  if (scope === 'all') {
    cache.clear()
    await update($, turns, list => list.map(x => ({ ...x, chunks: 0 })))
  }
  await measureDisk($)
  $.ui.toast(scope === 'all' ? 'All saved requests deleted.' : 'Older sessions deleted.')
}

/** The full content of one request: from memory, else from its files on disk. */
async function loadDetail($: $, t: TrimTurn, prevMsgs: number): Promise<Detail | null> {
  const hit = cache.get(t.id)
  if (hit) return hit
  if (!t.chunks) return null
  try {
    const dir = await requestDir($)
    let body = ''
    for (let i = 0; i < t.chunks; i++) body += await $.fs.read(`${dir}/${t.id}.${i}.json`)
    const req = JSON.parse(body) as Record<string, unknown>
    const d = decompose(req, prevMsgs)
    const detail: Detail = { system: d.system, tools: d.tools, context: d.context, messages: d.messages, heavy: d.heavy, raw: JSON.stringify(req, null, 2) }
    remember(t.id, detail)
    return detail
  } catch {
    return null
  }
}

/** Reads one outgoing model request; never changes it. */
async function measureRequest($: $, body: string) {
  let req: Record<string, unknown>
  try {
    req = JSON.parse(body)
  } catch {
    return
  }
  if (!Array.isArray(req.messages)) return
  const before = await read($, turns)
  const prev = before[before.length - 1]
  const d = decompose(req, prev?.msgs ?? 0)
  const total = Object.values(d.cats).reduce((a, b) => a + b, 0)
  const id = (prev?.id ?? 0) + 1
  const turn: TrimTurn = {
    id, at: Date.now(), model: String(req.model ?? '?'), total, cats: d.cats,
    msgs: d.msgCount, newMsgs: d.newMsgs, newTokens: d.newTokens,
    toolCount: d.trimTools.length, deferred: d.deferred, kind: d.kind,
  }
  remember(id, { system: d.system, tools: d.tools, context: d.context, messages: d.messages, heavy: d.heavy, raw: JSON.stringify(req, null, 2) })
  const dir = await requestDir($)
  let parts = Math.max(1, Math.ceil(body.length / CHUNK))
  try {
    for (let i = 0; i < parts; i++) await $.fs.write(`${dir}/${id}.${i}.json`, body.slice(i * CHUNK, (i + 1) * CHUNK))
  } catch {
    parts = 0 // kept in memory only
  }
  await update($, turns, list => [...list, { ...turn, chunks: parts }])
  void measureDisk($)
  if (d.trimTools.length) {
    const m: TrimMeasure = { at: turn.at, total, system: d.cats.system, messages: total - d.cats.system - d.cats.tools, tools: d.trimTools }
    await update($, measure, () => m)
  }
}

function openPane($: $) {
  return $.ui.open({ id: PANE, title: 'Wirewolf' })
}

async function report($: $): Promise<string> {
  const list = await read($, turns)
  const t = list.filter(x => x.toolCount > 0).slice(-1)[0] ?? list.slice(-1)[0]
  const m = await read($, measure)
  const sk = await read($, skills)
  const u = await read($, uses)
  const hid = await read($, hidden)
  if (!t || !m) return 'No request measured yet. Send a message, then run /wirewolf report again.'
  const lines = CATS.map(c => `  ${c.label.padEnd(22)} ${k(t.cats[c.key]).padStart(7)}  ${pct(t.cats[c.key], t.total).padStart(4)}`)
  const unusedSkills = sk.filter(s => !hid.skill[s.name] && !u[`skill:${s.name}`])
  const unusedTools = m.tools.filter(x => !x.deferred && !x.server && !u[x.name] && !CORE_TOOLS.has(x.name) && !hid.tool[x.name])
  return [
    `Request #${t.id} · ${t.model} · ≈${k(t.total)} tokens · ${t.msgs} messages (+${t.newMsgs} new, ${k(t.newTokens)})`,
    ...lines,
    t.usage ? `  API: cached ${k(t.usage.cacheRead)} · new ${k(t.usage.input)} · cache write ${k(t.usage.cacheWrite)} · output ${k(t.usage.output)}` : '',
    `Unused: ${unusedSkills.length} skills (${k(unusedSkills.reduce((a, s) => a + s.tokens, 0))}) · ${unusedTools.length} tools (${k(unusedTools.reduce((a, x) => a + x.tokens, 0))})`,
    'Open /wirewolf to inspect every piece, or the Save tab for ways to send less.',
  ].filter(Boolean).join('\n')
}

// ── register ───────────────────────────────────────────────────────────────

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await update($, root, () => '')
    const s = await loadSettings($)
    await update($, settings, () => s)
    await refreshHidden($)
    await update($, dirty, () => false)
    const all = ((await $.store.get(STORE_USES)) ?? {}) as Record<string, number>
    await update($, uses, () => all)
    if (!(await read($, run))) await update($, run, () => new Date().toISOString().replace(/[:.]/g, '-'))
    await $.command.register({
      name: 'wirewolf',
      description: 'Wirewolf: see everything each request sends, and send less of it',
      argumentHint: '[report|save|restore|reset|reset all|clean|clean all|inspect|skills|tools|mcp|prompt|help]',
    })
    void measureDisk($)
    void readContext($)
    if (e.surface === 'desktop') void openPane($)
    return started
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await update($, seen, () => [])
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (!('skip' in r && r.skip)) await update($, seen, () => [])
    return r
  })

  // ── measuring ────────────────────────────────────────────────────────────

  on('http.fetch', ($, e, next) => {
    const body = e.init?.body
    if (next.origin.plugin === 'engine' && typeof body === 'string' && /\/v1\/messages(\?|$)/.test(e.url)) {
      void measureRequest($, body)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const u = result.usage
    if (u) {
      void recordUsage($, {
        input: u.input_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens, output: u.output_tokens,
      })
      void readContext($)
    }
    return result
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined) {
      void countUse($, String(e.tool))
      if (e.tool === 'Skill') void countUse($, `skill:${String((e as { skill?: unknown }).skill ?? '')}`)
    }
    return ran
  })

  // ── shortening large tool outputs before Claude reads them ───────────────

  on('session.append', async ($, e, next) => {
    if (e.door !== 'tool-result' || e.origin.kind !== 'tool' || NEVER_CAP.has(e.origin.tool)) return next(e)
    const s = await loadSettings($)
    if (!s.capResults) return next(e)
    let cut = 0
    const content = e.message.content.map(b => capBlock(b, s.capChars, n => { cut += n }))
    if (!cut) return next(e)
    void addSaved($, cut)
    return next({ ...e, message: { ...e.message, content } })
  }).catch(($, e, next) => next(e))

  // ── applying what was removed or shortened ───────────────────────────────

  on('prompt.attachment', { type: 'skill_listing' }, async ($, e, next) => {
    const { head, entries } = parseListing(e.text)
    if (!entries.length) return next(e)
    await update($, skills, () => entries.map(x => ({
      name: x.name,
      tokens: est(x.lines.join('\n')),
      hint: firstSentence(x.lines.join(' ').replace(/^- [^:]+:\s*/, '')),
    })))
    const hid = await loadHidden($)
    const s = await loadSettings($)
    const kept = entries.filter(x => !hid.skill[x.name])
    if (kept.length === entries.length && !s.shortSkills) return next(e)
    return next({ ...e, text: [...head, ...kept.flatMap(x => (s.shortSkills ? shortEntry(x) : x.lines))].join('\n') })
  }).catch(($, e, next) => next(e))

  on('prompt.attachment', async ($, e, next) => {
    if (e.origin.kind !== 'engine' || !/memory|instructions|claude/i.test(e.type)) return next(e)
    const s = await loadSettings($)
    if (!s.dedupe) return next(e)
    const key = hash(`${e.type}\n${e.text}`)
    const list = await read($, seen)
    if (list.includes(key)) {
      void addSaved($, e.text.length)
      return { text: null }
    }
    await update($, seen, l => [...l, key].slice(-500))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.compose', async ($, e, next) => {
    const out = await next(e)
    await update($, sections, () => out.sections.map(s => ({
      name: s.id, tokens: est(s.text), hint: SECTION_HINTS[s.id] ?? firstSentence(s.text.replace(/^#+\s*/, ''), 60),
    })))
    const hid = await loadHidden($)
    const keep = out.sections.filter(s => CORE_SECTIONS.has(s.id) || !hid.section[s.id])
    return keep.length === out.sections.length ? out : { ...out, sections: keep }
  }).catch(($, e, next) => next(e))

  on('tool.list', async ($, e, next) => {
    const got = await next(e)
    if (got.deny !== undefined) return got
    const hid = await loadHidden($)
    return {
      value: got.value.filter(t => {
        const server = serverOf(t.name)
        return !hid.tool[t.name] && !(server && hid.server[server])
      }),
    }
  }).catch(($, e, next) => next(e))

  on('tool.describe', async ($, e, next) => {
    const hid = await loadHidden($)
    const s = await loadSettings($)
    const isDeferred = !!hid.defer[e.tool]
    const isShort = s.shortTools && !CORE_TOOLS.has(e.tool)
    if (!isDeferred && !isShort) return next(e)
    const got = await next(e)
    return {
      ...got,
      ...(isShort ? { description: shortDescription(got.description) } : {}),
      ...(isDeferred ? { isDeferred: true } : {}),
    }
  }).catch(($, e, next) => next(e))

  on('mcp.connect', async ($, e, next) => {
    if (next.origin.plugin !== 'engine') return next(e)
    const hid = await loadHidden($)
    if (!hid.server[norm(e.server)]) return next(e)
    return {
      value: { isConnected: false, reason: 'disabled', message: 'Removed by Wirewolf. /wirewolf mcp to restore.' } as const,
    }
  }).catch(($, e, next) => next(e))

  // ── /wirewolf ────────────────────────────────────────────────────────────────

  on('command.run', { command: 'wirewolf' }, async ($, e) => {
    const [sub = '', arg = ''] = e.args.trim().toLowerCase().split(/\s+/)
    if (sub === 'report') return { text: await report($) }
    if (sub === 'help') {
      return {
        text: [
          '/wirewolf               open the Wirewolf pane',
          '/wirewolf report        size of the last request, by part',
          '/wirewolf save          open the ways to send less',
          '/wirewolf skills        open a Trim tab (also: tools, mcp, prompt)',
          '/wirewolf restore       put back every removed skill, tool, server and section',
          '/wirewolf reset         restore + switches off + forget usage counts',
          '/wirewolf reset all     reset + delete every saved request on disk',
          '/wirewolf clean [all]   delete saved requests (older sessions, or all)',
          'Removals and restores take effect after /clear or in a new session.',
        ].join('\n'),
      }
    }
    if (sub === 'restore') {
      await restoreAll($)
      return { text: 'Everything restored. Run /clear (or start a new session) to send the full context again.' }
    }
    if (sub === 'clean') {
      const scope = arg === 'all' ? 'all' : 'older'
      await update($, cleanAsk, () => scope)
      await pressClean($, scope)
      const du = await read($, disk)
      return { text: `${scope === 'all' ? 'Deleted every saved request.' : 'Deleted older sessions.'} On disk now: ${du ? mb(du.bytes) : '0 KB'}.` }
    }
    if (sub === 'reset') {
      await restoreAll($)
      await $.store.set(STORE_USES, {})
      await update($, uses, () => ({}))
      await $.store.set(STORE_SETTINGS, DEFAULTS)
      await update($, settings, () => DEFAULTS)
      await update($, seen, () => [])
      await update($, savedChars, () => 0)
      await update($, view, () => 'inspect' as TrimView)
      await update($, tab, () => 'skills' as TrimTab)
      await update($, open, () => ['context'])
      await update($, item, () => '')
      await update($, page, () => 0)
      await update($, confirm, () => '')
      await update($, cleanAsk, () => '')
      if (arg === 'all') {
        await update($, cleanAsk, () => 'all')
        await pressClean($, 'all')
      }
      return {
        text: `Reset: everything restored, switches off, usage counts cleared${arg === 'all' ? ', saved requests deleted' : ''}. Run /clear to send the full context again.`,
      }
    }
    if (sub === 'inspect' || sub === 'save' || sub === 'storage') await update($, view, () => sub as TrimView)
    if ((TABS as string[]).includes(sub)) {
      await update($, view, () => 'trim' as TrimView)
      await update($, tab, () => sub as TrimTab)
    }
    const { isPlaced } = await openPane($)
    return { text: isPlaced ? 'Wirewolf pane opened.' : await report($) }
  })

  // ── the pane ─────────────────────────────────────────────────────────────

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Svg = 'Svg' in els ? els.Svg : null
    const Code = 'Code' in els ? els.Code : null
    const Select = 'Select' in els ? els.Select : null

    // Everything is sized from the room the pane really has.
    const width = Math.max(24, e.props.bodyColumns)
    const isNarrow = width < 58
    const isTiny = width < 40
    const NUM = 7
    const USE = isNarrow ? 0 : 9
    const ACT = isTiny ? 12 : 22
    const rich = e.surface === 'desktop'
    const tint = (hex: string, a: number) => {
      if (!rich) return undefined
      const n = parseInt(hex.slice(1), 16)
      return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
    }

    const all = await read($, turns)
    const selected = await read($, sel)
    const mains = all.filter(x => x.toolCount > 0)
    const latestMain = mains[mains.length - 1] ?? all[all.length - 1]
    const t = all.find(x => x.id === selected) ?? latestMain
    const isLatest = !t || t.id === latestMain?.id
    const currentView = await read($, view)
    const hid = await read($, hidden)
    const isDirty = await read($, dirty)
    const du = await read($, disk)
    const removed = Object.values(hid).reduce((a, g) => a + Object.values(g).reduce((x, y) => x + y, 0), 0)

    // ── building blocks ────────────────────────────────────────────────────

    const RULE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 1" preserveAspectRatio="none"><rect width="600" height="1" fill="#94A3B8" opacity="0.45"/></svg>'
    const rule = (key: string) => (Svg
      ? <Svg key={key} source={RULE} alt="separator" height={1} />
      : <Text key={key} dimColor wrap="truncate-end">{'─'.repeat(width)}</Text>)
    const heading = (label: string, right?: RenderChildren) => (
      <Box flexDirection="row" justifyContent="space-between" alignItems="center">
        <Text size="caption" weight="semibold" dimColor>{label.toUpperCase()}</Text>
        {right ?? null}
      </Box>
    )
    const grow = (children: RenderChildren) => (
      <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">{children}</Box>
    )
    const fixed = (w: number, children: RenderChildren) => (w > 0
      ? <Box width={w} flexShrink={0} justifyContent="flex-end">{children}</Box>
      : null)
    const th = (label: string) => <Text size="caption" dimColor>{label}</Text>
    const num = (n: number, color?: string) => <Text size="footnote" tabular color={color}>{k(n)}</Text>

    // ── summary ────────────────────────────────────────────────────────────

    const summary = t
      ? (
        <Box flexDirection="column" gap={1}>
          {heading(isLatest ? 'Latest request' : t.toolCount === 0 ? `Background call #${t.id}` : `Request #${t.id}`, (
            <Text size="caption" dimColor wrap="truncate-end">
              #{t.id} · {time(t.at)}{isNarrow ? '' : ` · ${t.kind === 'prompt' ? 'your prompt' : 'tool loop'}`}
            </Text>
          ))}
          <Text wrap="truncate-end">
            <Text size="heading" weight="bold">≈{k(t.total)}</Text>
            <Text size="footnote" dimColor> tokens · {t.msgs} msgs · </Text>
            <Text size="footnote" color="warning">+{k(t.newTokens)} new</Text>
            {isNarrow ? '' : <Text size="footnote" dimColor> · {clip(t.model, 24)}</Text>}
          </Text>
          {Svg ? <Svg source={barSvg(t.cats, t.total)} alt="Where this request's tokens go" height={10} isInteractive /> : null}
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1}>
              {grow(th('Part'))}
              {fixed(NUM, th('Tokens'))}
              {fixed(6, th('Share'))}
            </Box>
            {rule('r-parts')}
            {CATS.filter(c => t.cats[c.key] > 0).map(c => (
              <Box key={`cat:${c.key}`} flexDirection="row" gap={1}>
                {grow(<Text size="footnote" wrap="truncate-end"><Text color={c.color}>●</Text> {c.label}</Text>)}
                {fixed(NUM, num(t.cats[c.key]))}
                {fixed(6, <Text size="footnote" tabular dimColor>{pct(t.cats[c.key], t.total)}</Text>)}
              </Box>
            ))}
            {t.usage && (
              <Box flexDirection="column" marginTop={1}>
                <Box flexDirection="row" gap={1}>
                  {grow(th('As billed (reported by the API)'))}
                  {fixed(NUM, th('Tokens'))}
                  {fixed(6, th('Cost'))}
                </Box>
                {rule('r-usage')}
                {[
                  { label: 'Read from cache', n: t.usage.cacheRead, cost: '×0.1', color: USED },
                  { label: 'Written to cache', n: t.usage.cacheWrite, cost: '×1.25', color: NEVER },
                  { label: 'New input', n: t.usage.input, cost: '×1', color: undefined },
                  { label: 'Output', n: t.usage.output, cost: 'out', color: undefined },
                ].map(r => (
                  <Box key={`u:${r.label}`} flexDirection="row" gap={1}>
                    {grow(<Text size="footnote" wrap="truncate-end"><Text color={r.color}>●</Text> {r.label}</Text>)}
                    {fixed(NUM, num(r.n))}
                    {fixed(6, <Text size="caption" dimColor>{r.cost}</Text>)}
                  </Box>
                ))}
              </Box>
            )}
          </Box>
        </Box>
      )
      : <Text size="footnote" dimColor>Send a message. Every request Claude Code makes will appear here, piece by piece.</Text>

    if (e.props.placement === 'widget') {
      return (
        <Box flexDirection="column">
          {t ? <Text weight="bold">≈{k(t.total)} <Text size="caption" dimColor>tokens</Text></Text> : <Text size="footnote" dimColor>No request yet</Text>}
          {t && Svg ? <Svg source={barSvg(t.cats, t.total)} alt="Token mix" height={8} /> : null}
          {removed ? <Text size="caption" color="success">{k(removed)} trimmed</Text> : null}
        </Box>
      )
    }

    const nav = (
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        {VIEWS.map(v => (
          <Button key={`view:${v.id}`} variant={currentView === v.id ? 'primary' : 'secondary'}
            label={!isNarrow && v.id === 'storage' && du ? `${v.label} · ${mb(du.bytes)}` : v.label}
            onPress={() => void update($, view, () => v.id)} />
        ))}
      </Box>
    )

    let body: RenderChildren = null

    if (currentView === 'inspect') {
      // ── Inspect ──────────────────────────────────────────────────────────
      const prevMsgs = t ? all[all.findIndex(x => x.id === t.id) - 1]?.msgs ?? 0 : 0
      const d = t ? await loadDetail($, t, prevMsgs) : null
      const opened = await read($, open)
      const shown = await read($, item)
      const pg = await read($, page)

      const picker = all.length > 1 && Select
        ? (
          <Select key="turn" label="Request" value={String(t?.id ?? '')}
            options={[...all].reverse().map(x => ({
              value: String(x.id),
              label: isNarrow
                ? `#${x.id} · ${k(x.total)}`
                : `#${x.id} · ${time(x.at)} · ${k(x.total)}${x.toolCount === 0 ? ' · background' : x.kind === 'prompt' ? ' · prompt' : ' · tool loop'}`,
            }))}
            onSelect={v => void selectTurn($, Number(v))} />
        )
        : null

      const viewerFor = (p: Piece, color: string) => {
        const pages = Math.max(1, Math.ceil(p.text.length / PAGE))
        const at = Math.min(pg, pages - 1)
        const chunk = p.text.slice(at * PAGE, (at + 1) * PAGE)
        return (
          <Box key={`viewer:${p.id}`} flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
            <Box flexDirection="row" gap={1} alignItems="center">
              {grow(<Text size="caption" dimColor wrap="truncate-end">{k(p.tokens)} tokens · {p.text.length.toLocaleString()} chars{pages > 1 ? ` · page ${at + 1} of ${pages}` : ''}</Text>)}
              {pages > 1 && <Button key="pg-prev" label="‹" onPress={() => void update($, page, n => Math.max(0, n - 1))} />}
              {pages > 1 && <Button key="pg-next" label="›" onPress={() => void update($, page, n => Math.min(pages - 1, n + 1))} />}
              <Button key="close-viewer" label="Close" role="dismiss" onPress={() => void update($, item, () => '')} />
            </Box>
            {Code
              ? <Code source={chunk || ' '} language={p.id === 'raw' || p.id.startsWith('tool:') ? 'json' : 'markdown'} wrap="wrap" />
              : <Text size="footnote">{chunk}</Text>}
          </Box>
        )
      }

      const section = (key: string, title: string, list: Piece[], color: string, note?: string) => {
        const isOpen = opened.includes(key)
        const tokens = list.reduce((a, p) => a + p.tokens, 0)
        const newCount = list.filter(p => p.isNew).length
        return (
          <Box key={`sec:${key}`} flexDirection="column">
            <Box key={`hdr:${key}`} flexDirection="row" gap={1} alignItems="center" paddingX={1}
              backgroundColor={tint(color, isOpen ? 0.2 : 0.12)} hover={rich ? { backgroundColor: tint(color, 0.28) } : undefined}>
              {grow(
                <Button key={`open:${key}`} plain onPress={() => void toggleOpen($, key)}>
                  <Text color={color}>{isOpen ? '▾' : '▸'}</Text> <Text size="footnote" weight="semibold">{title}</Text>
                  <Text size="caption" dimColor>  {note ?? `${list.length} ${list.length === 1 ? 'item' : 'items'}`}{newCount ? ` · ${newCount} new` : ''}</Text>
                </Button>,
              )}
              {fixed(NUM, <Text size="footnote" tabular weight="semibold">{k(tokens)}</Text>)}
            </Box>
            {isOpen && (
              <Box flexDirection="column" paddingLeft={rich ? 1 : 2} backgroundColor={tint(color, 0.05)}>
                {list.length === 0 && <Text size="caption" dimColor>nothing in this request</Text>}
                {list.map(p => {
                  const isShown = shown === p.id
                  return (
                    <Box key={`wrap:${p.id}`} flexDirection="column">
                      <Box key={`row:${p.id}`} flexDirection="row" gap={1} alignItems="center" paddingRight={1}
                        backgroundColor={isShown ? tint(color, 0.18) : undefined}
                        hover={rich ? { backgroundColor: tint('#94A3B8', 0.2) } : undefined}>
                        {grow(
                          <Button key={`item:${p.id}`} plain onPress={() => void (isShown ? update($, item, () => '') : showItem($, p.id))}>
                            <Text size="footnote" weight={isShown ? 'semibold' : 'regular'}>{clip(p.label, isNarrow ? width - NUM - 12 : 30)}</Text>
                            {p.isNew ? <Text size="caption" color="warning">  NEW</Text> : ''}
                            {isNarrow ? '' : <Text size="caption" dimColor>  {clip(p.sub, Math.max(8, width - NUM - 46))}</Text>}
                          </Button>,
                        )}
                        {fixed(NUM, <Text size="footnote" tabular dimColor>{k(p.tokens)}</Text>)}
                        <Text dimColor>{isShown ? '⌄' : '›'}</Text>
                      </Box>
                      {isShown ? viewerFor(p, color) : null}
                    </Box>
                  )
                })}
              </Box>
            )}
          </Box>
        )
      }

      const raw = d && shown === 'raw' ? viewerFor({ id: 'raw', label: 'Exact request JSON', sub: '', tokens: est(d.raw), text: d.raw }, '#94A3B8') : null

      body = !t
        ? null
        : !d
          ? <Text size="footnote" dimColor>This request's saved content could not be read. Its totals are above.</Text>
          : (
            <Box flexDirection="column" gap={1}>
              {picker}
              <Box flexDirection="column" gap={0}>
                <Box flexDirection="row" gap={1} paddingX={1}>
                  {grow(<Text size="caption" dimColor wrap="truncate-end">WHAT THIS REQUEST SENT{isNarrow ? '' : ' · click a row to read it'}</Text>)}
                  {fixed(NUM, th('Tokens'))}
                </Box>
                {section('system', 'System prompt', d.system, '#D97757')}
                {section('tools', 'Tool schemas', d.tools, '#6A9BCC')}
                {section('context', 'Injected context', d.context, '#B08BD9')}
                {section('messages', 'Messages', d.messages, '#788C5D')}
                {section('heavy', 'Largest in history', d.heavy, '#C9A227', `top ${d.heavy.length} blocks`)}
              </Box>
              <Box flexDirection="row">
                <Button key="item:raw" label={shown === 'raw' ? 'Hide request JSON' : 'View exact request JSON'}
                  onPress={() => void (shown === 'raw' ? update($, item, () => '') : showItem($, 'raw'))} />
              </Box>
              {raw}
            </Box>
          )
    } else if (currentView === 'save') {
      // ── Save ─────────────────────────────────────────────────────────────
      const s = await read($, settings)
      const p = await read($, ctxPct)
      const saved = await read($, savedChars)
      const m = await read($, measure)
      const projectRoot = await read($, root)
      const history = t ? t.cats.chat + t.cats.toolio + t.cats.thinking + t.cats.context : 0
      const mcpLive = (m?.tools ?? []).filter(x => x.server && !x.deferred && !hid.defer[x.name] && !hid.tool[x.name])
      const builtinLive = (m?.tools ?? []).filter(x => !x.server && !x.deferred && !CORE_TOOLS.has(x.name) && !hid.defer[x.name] && !hid.tool[x.name])
      const longTools = (m?.tools ?? []).filter(x => !x.deferred && !CORE_TOOLS.has(x.name) && x.tokens > 200)
      const sum = (xs: Array<{ tokens: number }>) => xs.reduce((a, x) => a + x.tokens, 0)
      const isHot = s.alertPct > 0 && p >= s.alertPct

      const toggle = (key: string, isOn: boolean, onPress: () => void) => (
        <Button key={key} variant={isOn ? 'primary' : 'secondary'} label={isOn ? 'On' : 'Off'} onPress={onPress} />
      )
      const setting = (key: string, title: string, hint: string, control: RenderChildren, gain?: string) => (
        <Box key={`set:${key}`} flexDirection={isNarrow ? 'column' : 'row'} gap={1} alignItems={isNarrow ? 'flex-start' : 'center'} paddingY={0}>
          {grow(
            <Box flexDirection="column">
              <Text size="footnote" weight="semibold" wrap="truncate-end">{title}{gain ? <Text size="caption" color={USED}>  {gain}</Text> : ''}</Text>
              <Text size="caption" dimColor>{hint}</Text>
            </Box>,
          )}
          <Box flexDirection="row" gap={1} flexShrink={0} alignItems="center">{control}</Box>
        </Box>
      )
      const group = (key: string, title: string, children: RenderChildren) => (
        <Box key={`grp:${key}`} flexDirection="column" gap={1}>
          {heading(title)}
          {rule(`r-${key}`)}
          {children}
        </Box>
      )

      body = (
        <Box flexDirection="column" gap={1}>
          {group('history', 'Conversation history', (
            <Box flexDirection="column" gap={1}>
              <Box flexDirection="column">
                <Text size="footnote" wrap="truncate-end">
                  <Text weight="semibold" color={isHot ? NEVER : undefined}>{p}%</Text> of the context window
                  <Text size="caption" dimColor> · history ≈{k(history)}{t ? ` of ${k(t.total)}` : ''}</Text>
                </Text>
                {Svg ? <Svg source={meterSvg(p / 100, isHot ? NEVER : '#60A5FA')} alt="Context window used" height={8} /> : null}
              </Box>
              {setting('compact', 'Compact now', 'Summarises older messages into a short recap. Usually cuts history by 70–90%.',
                <Button key="compact-now" variant={isHot ? 'primary' : 'secondary'} label="Compact" onPress={() => void compactNow($)} />)}
              {setting('cap', 'Shorten large tool outputs',
                `Keeps the start and end of any tool result over ${k(s.capChars)} characters. You still see it all; Claude reads the short one. Read is never shortened.`,
                <Box flexDirection="row" gap={1} alignItems="center">
                  {s.capResults && Select
                    ? <Select key="cap-size" value={String(s.capChars)}
                      options={[5_000, 10_000, 20_000, 50_000].map(n => ({ value: String(n), label: `${k(n)} chars` }))}
                      onSelect={v => void setSetting($, { capChars: Number(v) })} />
                    : null}
                  {toggle('cap-toggle', s.capResults, () => void setSetting($, { capResults: !s.capResults }))}
                </Box>,
                saved ? `${k(saved / 4)} saved` : undefined)}
              {setting('alert', 'Warn when the context is over',
                'Shows a warning in the line above the prompt, with a nudge to compact.',
                Select
                  ? <Select key="alert" value={String(s.alertPct)}
                    options={[0, 50, 70, 85].map(n => ({ value: String(n), label: n ? `${n}%` : 'Never' }))}
                    onSelect={v => void setSetting($, { alertPct: Number(v) })} />
                  : <Text size="footnote">{s.alertPct ? `${s.alertPct}%` : 'Never'}</Text>)}
            </Box>
          ))}

          {group('schemas', 'Tool schemas', (
            <Box flexDirection="column" gap={1}>
              {setting('defer-mcp', 'Defer all MCP tools',
                `${mcpLive.length} tools wait behind ToolSearch and load only when Claude asks for them.`,
                <Button key="defer-mcp" label="Defer all" variant="secondary" onPress={() => void deferGroup($, 'mcp')} />,
                mcpLive.length ? `save ≈${k(sum(mcpLive))}` : undefined)}
              {setting('defer-builtin', 'Defer optional built-in tools',
                `${builtinLive.length} built-in tools other than Read, Edit, Write, Bash, Glob, Grep and the like.`,
                <Button key="defer-builtin" label="Defer all" variant="secondary" onPress={() => void deferGroup($, 'builtin')} />,
                builtinLive.length ? `save ≈${k(sum(builtinLive))}` : undefined)}
              {setting('short-tools', 'Shorter tool descriptions',
                'Keeps the first paragraph of long descriptions (core tools untouched). Claude may use these tools less well.',
                toggle('short-tools', s.shortTools, () => void setSetting($, { shortTools: !s.shortTools })),
                longTools.length ? `${longTools.length} long ones` : undefined)}
            </Box>
          ))}

          {group('extras', 'Skills & reminders', (
            <Box flexDirection="column" gap={1}>
              {setting('short-skills', 'Shorter skill descriptions',
                'Each skill keeps its first sentence. Skills stay available.',
                toggle('short-skills', s.shortSkills, () => void setSetting($, { shortSkills: !s.shortSkills })))}
              {setting('dedupe', 'Drop repeated reminders',
                'CLAUDE.md and memory reminders already sent in this thread are not sent again. They come back after a compaction.',
                toggle('dedupe', s.dedupe, () => void setSetting($, { dedupe: !s.dedupe })))}
            </Box>
          ))}

          {group('profile', 'Where removals apply', (
            setting('scope', 'New removals apply to',
              s.scope === 'project' ? `Only ${clip(projectRoot.split('/').pop() || 'this project', 30)}. Other projects keep everything.` : 'Every project on this machine.',
              <Box flexDirection="row" gap={1} alignItems="center">
                <Button key="scope:global" variant={s.scope === 'global' ? 'primary' : 'secondary'} label="All projects"
                  onPress={() => void setSetting($, { scope: 'global' })} />
                <Button key="scope:project" variant={s.scope === 'project' ? 'primary' : 'secondary'} label="This project"
                  onPress={() => void setSetting($, { scope: 'project' })} />
              </Box>)
          ))}
          {isDirty && <Text size="caption" color="warning">Removals, deferrals and shorter descriptions apply after /clear or in a new session.</Text>}
        </Box>
      )
    } else if (currentView === 'storage') {
      // ── Storage ──────────────────────────────────────────────────────────
      const ask = await read($, cleanAsk)
      const older = du ? du.bytes - du.currentBytes : 0
      const olderSessions = du ? Math.max(0, du.sessions - (du.currentFiles ? 1 : 0)) : 0
      const share = du && du.bytes ? du.currentBytes / du.bytes : 0
      body = (
        <Box flexDirection="column" gap={1}>
          {heading('Saved requests on disk', <Button key="disk:refresh" plain label="↻ Refresh" onPress={() => void measureDisk($)} />)}
          <Text><Text size="heading" weight="bold">{du ? mb(du.bytes) : '—'}</Text><Text size="footnote" dimColor> in {du?.files ?? 0} files</Text></Text>
          {Svg && du && du.bytes > 0 ? <Svg source={meterSvg(share, '#60A5FA')} alt="This session versus older sessions" height={10} /> : null}
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1}>
              {grow(th('Where'))}
              {fixed(10, th('Size'))}
              {fixed(isNarrow ? 0 : 12, th('Contains'))}
            </Box>
            {rule('r-disk')}
            <Box flexDirection="row" gap={1}>
              {grow(<Text size="footnote"><Text color="#60A5FA">●</Text> This session</Text>)}
              {fixed(10, <Text size="footnote" tabular>{du ? mb(du.currentBytes) : '—'}</Text>)}
              {fixed(isNarrow ? 0 : 12, <Text size="footnote" dimColor>{du?.currentFiles ?? 0} files</Text>)}
            </Box>
            <Box flexDirection="row" gap={1}>
              {grow(<Text size="footnote"><Text color="#94A3B8">●</Text> Older sessions</Text>)}
              {fixed(10, <Text size="footnote" tabular>{du ? mb(older) : '—'}</Text>)}
              {fixed(isNarrow ? 0 : 12, <Text size="footnote" dimColor>{olderSessions} sessions</Text>)}
            </Box>
            {rule('r-disk-end')}
          </Box>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Button key="clean:older" variant={ask === 'older' ? 'primary' : 'secondary'}
              label={ask === 'older' ? `Confirm: delete ${mb(older)}` : 'Clean older sessions'}
              onPress={() => void pressClean($, 'older')} />
            <Button key="clean:all" variant={ask === 'all' ? 'primary' : 'secondary'}
              label={ask === 'all' ? `Confirm: delete all ${du ? mb(du.bytes) : ''}` : 'Clean everything'}
              onPress={() => void pressClean($, 'all')} />
          </Box>
          {ask ? <Text size="caption" color="warning">This can't be undone. Press again to confirm.</Text> : null}
          <Text size="caption" dimColor wrap="truncate-middle">~/.claude/wirewolf/requests · full request bodies, unencrypted</Text>
        </Box>
      )
    } else {
      // ── Trim ─────────────────────────────────────────────────────────────
      const m = await read($, measure)
      const sk = await read($, skills)
      const sec = await read($, sections)
      const u = await read($, uses)
      const ph = await read($, projHidden)
      const current = await read($, tab)
      const asking = await read($, confirm)
      const accent = ACCENT[current]
      const rows = rowsFor(current, m, sk, sec, u, hid)
      const unused = unusedRows(current, rows)
      const kind = KIND[current]
      const gone = [
        ...Object.entries(hid[kind]).map(([n, tok]) => ({ n, tok, kd: kind })),
        ...(current === 'tools' ? Object.entries(hid.defer).map(([n, tok]) => ({ n, tok, kd: 'defer' as TrimKind })) : []),
      ].sort((x, y) => y.tok - x.tok)
      const live = rows.reduce((a2, r) => a2 + r.tokens, 0)
      const neverTok = unused.reduce((a2, r) => a2 + r.tokens, 0)
      const usedTok = live - neverTok
      const goneTok = gone.reduce((a2, g) => a2 + g.tok, 0)
      const isPrompt = current === 'prompt'
      const nameRoom = Math.max(8, Math.floor((width - NUM - (isPrompt ? 0 : USE) - ACT - 6) * 0.9))
      const tabCount = (x: TrimTab) => rowsFor(x, m, sk, sec, u, hid).length
      const empty =
        current === 'skills' ? 'The skill listing arrives with the first message of a session: /clear, then send one.'
          : isPrompt ? 'Sections show up with the next request.'
            : 'Send a message to measure the tools it carries.'
      const tot = usedTok + neverTok + goneTok || 1
      const w1 = (usedTok / tot) * 600
      const w2 = (neverTok / tot) * 600
      const mixSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 10" preserveAspectRatio="none"><defs><clipPath id="m"><rect width="600" height="10" rx="5"/></clipPath><pattern id="h" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="3" height="6" fill="#94A3B8" opacity="0.5"/></pattern></defs><g clip-path="url(#m)"><rect width="600" height="10" fill="url(#h)"/><rect width="${w1.toFixed(1)}" height="10" fill="${accent}"><title>used ${k(usedTok)}</title></rect><rect x="${w1.toFixed(1)}" width="${w2.toFixed(1)}" height="10" fill="${NEVER}"><title>never used ${k(neverTok)}</title></rect></g></svg>`

      body = (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column" gap={0}>
            <Box flexDirection="row" gap={0} flexWrap="wrap">
              {TABS.map(x => {
                const isOn = x === current
                const name = x === 'mcp' ? 'MCP' : x.charAt(0).toUpperCase() + x.slice(1)
                const bar = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 3" preserveAspectRatio="none"><rect width="100" height="3" rx="1.5" fill="${isOn ? ACCENT[x] : 'transparent'}"/></svg>`
                return (
                  <Box key={`tabbox:${x}`} flexDirection="column" paddingX={1}
                    hover={rich ? { backgroundColor: 'rgba(148, 163, 184, 0.15)' } : undefined}>
                    <Button key={`tab:${x}`} plain onPress={() => void update($, tab, () => x)}>
                      <Text size="footnote" weight={isOn ? 'semibold' : 'regular'} color={isOn ? ACCENT[x] : undefined} dimColor={!isOn}>{name}</Text>
                      <Text size="caption" dimColor> {tabCount(x)}</Text>
                    </Button>
                    {Svg ? <Svg source={bar} alt={isOn ? `${name} selected` : name} height={3} /> : <Text color={ACCENT[x]}>{isOn ? '━━━━' : '    '}</Text>}
                  </Box>
                )
              })}
            </Box>
            {rule('r-tabs')}
          </Box>
          <Box flexDirection="column" gap={1}>
            <Text wrap="truncate-end">
              <Text size="heading" weight="bold" color={isPrompt ? accent : neverTok ? NEVER : USED}>{k(isPrompt ? live : neverTok)}</Text>
              <Text size="footnote" dimColor> {isPrompt ? 'tokens in sections' : 'tokens never used'}</Text>
              {goneTok ? <Text size="footnote" color={USED}>  ✓ {k(goneTok)} saved</Text> : ''}
            </Text>
            {Svg && !isPrompt ? <Svg source={mixSvg} alt="Used, never used and removed" height={10} isInteractive /> : null}
            {!isPrompt && unused.length > 0 && (
              <Button key="trim-unused" variant="primary"
                label={isNarrow ? `Remove ${unused.length} unused` : `Remove all ${unused.length} never-used · save ${k(neverTok)}`}
                onPress={() => void trimUnused($, current)} />
            )}
            {isDirty && <Text size="caption" color="warning">Changes apply after /clear or in a new session.</Text>}
          </Box>

          <Box flexDirection="column">
            <Box flexDirection="row" gap={1}>
              {grow(th(isPrompt ? 'Section' : current === 'mcp' ? 'Server' : current === 'tools' ? 'Tool' : 'Skill'))}
              {fixed(NUM, th('Tokens'))}
              {isPrompt ? null : fixed(USE, th('Used'))}
              {fixed(ACT, th(''))}
            </Box>
            {rule('r-rows')}
            {rows.length === 0 && <Text size="footnote" dimColor>{empty}</Text>}
            {rows.map(r => {
              const key = `${kind}:${r.name}`
              const isCore = kind === 'tool' && CORE_TOOLS.has(r.name)
              const isNever = !isPrompt && r.used === 0
              return (
                <Box key={`row:${key}`} flexDirection="row" gap={1} alignItems="center" paddingY={0}
                  hover={rich ? { backgroundColor: 'rgba(148, 163, 184, 0.12)' } : undefined}>
                  {grow(
                    <Box flexDirection="column">
                      <Text size="footnote" wrap="truncate-end" dimColor={!r.removable}>
                        <Text color={isNever ? NEVER : accent}>▍</Text>{clip(r.name, nameRoom)}
                        {nameRoom - r.name.length < 9 ? '' : isCore ? <Text size="caption" dimColor> core</Text>
                          : r.deferred ? <Text size="caption" dimColor> deferred</Text>
                            : r.tools ? <Text size="caption" dimColor> {r.tools} {r.tools === 1 ? 'tool' : 'tools'}</Text> : ''}
                      </Text>
                      {!isTiny && r.hint ? <Text size="caption" dimColor wrap="truncate-end">  {clip(r.hint, nameRoom + 6)}</Text> : null}
                    </Box>,
                  )}
                  {fixed(NUM, num(r.tokens))}
                  {isPrompt ? null : fixed(USE, isNever
                    ? <Text size="caption" color={NEVER}>never</Text>
                    : <Text size="caption" color={USED}>{r.used}×</Text>)}
                  {fixed(ACT, (
                    <Box flexDirection="row" gap={1}>
                      {!isTiny && kind === 'tool' && !r.deferred && !isCore && (
                        <Button key={`defer:${r.name}`} label="Defer" onPress={() => void hide($, 'defer', r.name, r.tokens)} />
                      )}
                      {r.removable && (
                        <Button key={`rm:${key}`} variant={asking === key ? 'primary' : 'secondary'} label={asking === key ? 'Confirm' : 'Remove'}
                          onPress={() => void pressRemove($, kind, r.name, r.tokens)} />
                      )}
                    </Box>
                  ))}
                </Box>
              )
            })}
            {rule('r-rows-end')}
            <Box flexDirection="row" gap={1}>
              {grow(<Text size="caption" dimColor>{rows.length} listed</Text>)}
              {fixed(NUM, <Text size="footnote" tabular weight="semibold">{k(live)}</Text>)}
              {isPrompt ? null : fixed(USE, null)}
              {fixed(ACT, null)}
            </Box>
          </Box>

          {gone.length > 0 && (
            <Box flexDirection="column">
              {heading(`Removed · ${gone.length}`, (
                <Button key={`restore-all:${kind}`} label="Restore all"
                  onPress={() => void restoreKinds($, current === 'tools' ? [kind, 'defer'] : [kind])} />
              ))}
              {rule('r-gone')}
              {gone.map(g => (
                <Box key={`gone:${g.kd}:${g.n}`} flexDirection="row" gap={1} alignItems="center">
                  {grow(
                    <Text size="footnote" dimColor wrap="truncate-end">
                      <Text strikethrough>{g.n}</Text>{g.kd === 'defer' ? ' · deferred' : ''}{ph[g.kd][g.n] !== undefined ? ' · this project' : ''}
                    </Text>,
                  )}
                  {fixed(NUM, <Text size="footnote" tabular dimColor>{k(g.tok)}</Text>)}
                  {fixed(ACT, <Button key={`restore:${g.kd}:${g.n}`} label="Restore" onPress={() => void restore($, g.kd, g.n)} />)}
                </Box>
              ))}
              {rule('r-gone-end')}
            </Box>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {summary}
        {rule('r-top')}
        {nav}
        {body}
      </Box>
    )
  })

  // ── the line above the prompt ────────────────────────────────────────────

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, turns)
    const t = list.filter(x => x.toolCount > 0).slice(-1)[0] ?? list.slice(-1)[0]
    if (!t) return next(e)
    const isDirty = await read($, dirty)
    const p = await read($, ctxPct)
    const s = await read($, settings)
    const { Text } = $.ui.resolve(e)
    if (s.alertPct > 0 && p >= s.alertPct) {
      return (
        <Text>
          <Text color="warning">⚠ Context {p}% full</Text>
          <Text dimColor> · history ≈{k(t.cats.chat + t.cats.toolio + t.cats.thinking + t.cats.context)} · run /compact or Save → Compact in /wirewolf</Text>
        </Text>
      )
    }
    return (
      <Text dimColor>
        Last request ≈{k(t.total)} · system {k(t.cats.system)} · tools {k(t.cats.tools)} · context {k(t.cats.context)}
        {t.usage ? ` · cached ${pct(t.usage.cacheRead, t.usage.cacheRead + t.usage.input + t.usage.cacheWrite)}` : ''}
        {isDirty ? ' · /clear to apply trims' : ' · /wirewolf'}
      </Text>
    )
  })
}
