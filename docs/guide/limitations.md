---
description: What silykat does not do yet. Claude Code channels in preview, one agent so far, no team mode, and a few cases in VS Code.
section: reference
order: 5
---

# Limitations

silykat is young. Here is what it does not do yet, and how to work around it.

## Claude Code is the only agent, for now

silykat is built for any coding agent: its storage, its command line and its sessions do not depend on Claude. But only Claude Code is supported today. Other agents, such as Codex, are planned.

## Channels are a Claude Code preview

The channel is what brings your comments to Claude on their own. Channels are a Claude Code research preview:

- the launch flag may change;
- Claude Code warns you at each launch;
- on a Team or Enterprise plan, an admin must enable channels.

Without the channel, your comments wait until you type `/silykat:review`.

## The Claude Code panel of VS Code

The Claude Code panel inside VS Code cannot be launched with a channel. Use Claude Code in a terminal, or type `/silykat:review` in the panel.

## One person, one machine

silykat is made for you and your agent, on your machine. There is no team mode: comments are not shared with other people, and retros read the conversations of the machine where they ran.

## In VS Code

- **Files outside the open folders** have no git features: no comments on a diff, no following a rename.
- **During a rebase**, threads follow the branch being rebased, but commenting is not supported yet.

## Other editors

Cursor, VSCodium and Windsurf can install silykat from Open VSX, but they are not tested yet. See [Install](./install.md#other-editors-based-on-vs-code).

## Retros

- Retros are run by Claude Code for now.
- The time announced before a retro is a rough estimate, to be refined on real retros.
- A retro reads back only the conversations Claude Code still keeps (30 days by default).

Found something else? [Open an issue](https://github.com/silykat/silykat/issues).
