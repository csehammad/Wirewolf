/** What a removed or deferred item is, and how to put it back. */
export type TrimKind = 'skill' | 'tool' | 'defer' | 'server' | 'section'

/** Removed items by kind: name → tokens it cost when it was removed. */
export type TrimHidden = Record<TrimKind, Record<string, number>>

/** A named part of a request, with a one-line explanation of what it is. */
export type TrimItem = { name: string; tokens: number; hint?: string }

export type TrimTool = TrimItem & { server: string | null; deferred: boolean }

/** One measured request, estimated at chars / 4 as Iris does. */
export type TrimMeasure = {
  at: number
  total: number
  system: number
  messages: number
  tools: TrimTool[]
}

/** Where a request's tokens go. */
export type TrimCats = {
  system: number
  tools: number
  context: number
  chat: number
  toolio: number
  thinking: number
}

/** What the API reported for a request: the billing view. */
export type TrimUsage = { input: number; cacheRead: number; cacheWrite: number; output: number }

/** One model request as sent, summarized. */
export type TrimTurn = {
  id: number
  at: number
  model: string
  total: number
  cats: TrimCats
  msgs: number
  newMsgs: number
  newTokens: number
  toolCount: number
  deferred: number
  kind: 'prompt' | 'loop'
  /** Files the full request is saved in, on disk. */
  chunks?: number
  usage?: TrimUsage
}

/** The switches on the Save view. */
export type TrimSettings = {
  capResults: boolean
  capChars: number
  shortTools: boolean
  shortSkills: boolean
  dedupe: boolean
  alertPct: number
  scope: 'global' | 'project'
}

export type TrimTab = 'skills' | 'tools' | 'mcp' | 'prompt'
export type TrimView = 'inspect' | 'save' | 'trim' | 'storage'

/** Saved requests on disk. */
export type TrimDisk = { at: number; bytes: number; files: number; sessions: number; currentBytes: number; currentFiles: number }

declare module 'claude-code' {
  interface PluginState {
    'wirewolf': {
      measure: Shaped<TrimMeasure | null>
      turns: Shaped<TrimTurn[]>
      skills: Shaped<TrimItem[]>
      sections: Shaped<TrimItem[]>
      uses: Shaped<Record<string, number>>
      hidden: Shaped<TrimHidden>
      projHidden: Shaped<TrimHidden>
      settings: Shaped<TrimSettings>
      seen: Shaped<string[]>
      dirty: boolean
      tab: TrimTab
      view: TrimView
      confirm: string
      sel: number
      open: Shaped<string[]>
      item: string
      page: number
      run: string
      disk: Shaped<TrimDisk | null>
      cleanAsk: string
      ctxPct: number
      savedChars: number
      root: string
    }
  }
}
