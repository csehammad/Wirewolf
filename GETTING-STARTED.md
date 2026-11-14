# Getting started with Wirewolf

Wirewolf shows what Claude Code sends to the model on every request and gives you ways to send less. It runs as a pane beside the chat in the Claude desktop app, and inline in the terminal.

Every message you send also re-sends the system prompt, every tool schema, the skill listing, and the whole conversation so far. On a long session that is often over 150k tokens per request. Wirewolf measures each part, shows the exact text, and lets you trim it.

---

## 1. Install

At the prompt of a Claude Code terminal session:

```
/plugin install wirewolf --marketplace csehammad/Wirewolf
```

From a shell:

```bash
claude plugin marketplace add csehammad/Wirewolf
claude plugin install wirewolf@wirewolf
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins** → **Add marketplace** with `csehammad/Wirewolf`, then **Add plugin**.

Then, in Claude Code:

```
/reload-plugins
```

**Where it works:** Claude Code. Best in the desktop app's **Code** tab, and also in the terminal and VS Code. It needs a build with mods (hooks modules), which the desktop app and recent CLI builds have. It doesn't work in regular Claude chat.

---

## 2. Your first five minutes

1. **Send any message.** Wirewolf measures each request as Claude Code sends it, so the pane stays empty until one goes out.
2. **Open the pane** with `/wirewolf`. In the desktop app it also opens by itself when a session starts.
3. **Read the summary at the top.** It shows the size of your latest request, a coloured bar of where the tokens go, and a Part / Tokens / Share table.
4. **Open Inspect → Messages** and click a row. The exact text that was sent opens right under it.
5. **Open Trim → MCP.** Servers marked **never** cost tokens on every request but have never been used. Press **Remove** on the ones you don't need.
6. **Run `/clear`.** Removals apply from the next fresh conversation, so the prompt cache isn't broken in the middle of a thread.

---

## 3. The four views

### Inspect: what was sent

| Part | What it is |
|---|---|
| **System prompt** | Claude Code's instructions, block by block. Cache breakpoints are marked. |
| **Tool schemas** | Every tool's full definition. Deferred tools cost about nothing until they are loaded. |
| **Injected context** | Hidden reminders added to messages: the skill listing, CLAUDE.md, the deferred-tool list, and others. |
| **Messages** | Every message in the conversation. Rows sent for the first time in this request are marked **NEW**. |
| **Largest in history** | The 15 biggest blocks in the conversation, such as a long Bash output or a big file read. |

- **Pick any request** from the **Request** dropdown. Small background calls (titles, summaries) are labelled *background*.
- **Read the exact payload** with **View exact request JSON**, byte for byte.
- **See the billing view.** The **As billed** table shows what the API reported: tokens read from the prompt cache (charged at about a tenth of the normal rate), written to the cache, new input, and output.

### Save: ways to send less

Every switch starts **off**.

| Setting | What it does | When to use it |
|---|---|---|
| **Compact** | Summarises older messages into a recap, the same as `/compact`. Usually cuts history by 70–90%. | When the meter is high. |
| **Shorten large tool outputs** | Keeps the start and end of any tool result over the size you pick (5k–50k characters), with a note in the middle. You still see the full output; Claude reads the short one. **Read is never shortened.** | Long sessions with big command outputs or logs. Start at 20k. |
| **Warn when the context is over** | Shows a warning in the line above the prompt at 50%, 70% or 85%. | Leave it at 70%. |
| **Defer all MCP tools** | Moves MCP tool schemas behind ToolSearch; they load only when Claude asks for one. | Almost always a safe, large saving. |
| **Defer optional built-in tools** | The same for built-in tools other than Read, Edit, Write, Bash, Glob, Grep and the like. | When you rarely use notebooks, scheduling, worktrees and so on. |
| **Shorter tool descriptions** | Keeps the first paragraph of long descriptions. Core tools are untouched. | Only if you need every token: Claude may use those tools less well. |
| **Shorter skill descriptions** | Each skill keeps its first sentence and stays available. | When you have many skills installed. |
| **Drop repeated reminders** | CLAUDE.md and memory reminders already sent in this thread aren't sent again. They come back after a compaction or `/clear`. | Safe to turn on. |
| **Where removals apply** | **All projects**, or **This project** only. | Use **This project** for project-specific servers, such as the iOS Simulator. |

### Trim: remove what you don't use

- **Tabs:** **Skills**, **Tools**, **MCP** and **Prompt** (optional system prompt sections).
- **Rows:** each shows the name, a grey hint saying what it is, its tokens per request, and how often it has been used since install (**never** in amber).
- **Remove all never-used** clears a whole tab in one press.
- **Defer** (tools only) keeps the tool but loads it on demand.
- **Core tools** (Read, Edit, Bash and the like) ask for a second press: **Remove** becomes **Confirm**.
- **Removed** lists everything you took out, with **Restore** per item and **Restore all**.

> Use counts start when you install the plugin, so at first everything shows **never**. Give it a few sessions before using **Remove all never-used** on skills you rely on.

### Storage: saved requests

- **What's saved:** every request is kept on disk, so you can inspect any of them later, even after a reload.
- **Usage:** this view shows how much space this session and older sessions take.
- **Cleanup:** **Clean older sessions** and **Clean everything** both ask twice.

Requests are saved in `~/.claude/wirewolf/requests/`. They hold everything Claude saw, including file contents, unencrypted. Clean them regularly.

---

## 4. Commands

```
/wirewolf               open the pane
/wirewolf report        text summary of the last request
/wirewolf save          open the Save view
/wirewolf skills        open a Trim tab (also: tools, mcp, prompt)
/wirewolf restore       put back every removed skill, tool, server and section
/wirewolf reset         restore + switches off + forget usage counts
/wirewolf reset all     reset + delete every saved request
/wirewolf clean         delete saved requests from older sessions
/wirewolf clean all     delete every saved request
/wirewolf help          this list
```

---

## 5. Recommended setup

If you just want the savings without reading everything:

1. **Save** → **Defer all MCP tools**.
2. **Save** → turn on **Drop repeated reminders**.
3. **Save** → turn on **Shorten large tool outputs** at **20k**.
4. After a few sessions: **Trim → Skills** → **Remove all never-used**.
5. Run `/clear`.

Watch the line above the prompt: when it warns that the context is filling up, press **Save → Compact**.

---

## 6. Troubleshooting

| Problem | Fix |
|---|---|
| The pane looks old after an update | `/reload-plugins`, then `/wirewolf` |
| The Skills tab is empty | The skill listing is sent only at the start of a conversation: `/clear`, then send a message |
| A removal didn't take effect | Run `/clear`, or start a new session |
| "Saved content could not be read" | That request's files were deleted (Clean, or `rm -rf ~/.claude/wirewolf`). Its totals stay. |
| The summary shows a tiny request | That was a background call. Pick your request from the dropdown; the default is your latest real one. |
| Something broke after trimming | `/wirewolf reset`, then `/clear` |

---

## 7. Uninstall

```bash
claude plugin uninstall wirewolf@wirewolf
rm -rf ~/.claude/wirewolf
```

The plugin never edits your settings files. Everything it removes, it removes while it runs, so uninstalling puts all of it back.

---

## How it works

Wirewolf is a Claude Code mod, a hooks module that runs inside Claude Code:

- **Measuring:** it reads each outgoing model request, without changing it.
- **Skills and tools:** it filters the skill listing and the tool list.
- **Deferring:** it marks tools deferred.
- **MCP servers:** it holds back the ones you removed at session start.
- **Tool outputs:** it shortens large results before they are stored in the conversation.

Token figures are estimates at about 4 characters per token. The **As billed** table is the API's own count.

It grew out of [Iris](https://github.com/csehammad/iris-control-plane), which measures Claude Code context through a local proxy.
