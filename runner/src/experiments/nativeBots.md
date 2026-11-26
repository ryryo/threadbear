---
id: nativeBots
name: Bots
title: Bots: assistants with settings and notes that carry across conversations
added: 2026-11-27
on: false
reminder: 56c8dda9
---

## What it does

The desktop app's Bots page lets you make an assistant with its own name, role and instructions. Give it a note from one conversation and another conversation with the same Bot can read it. Notes are pinned, editable and have change history. The Bot keeps its conversation links when the Runner restarts. Bots need an updated Runner supervisor running on the owning machine.

## Lives in

`runner/src/bots/` owns the workspace, roster and memory. `runner/src/main.ts` wires it into the Runner, and `desktop/gpui/src/bots.rs` draws the page. `runner/launch.mjs` and the Runner check `bots-format.json` before opening protected data.

## Taking it out

Turn off the experiment to stop accessing Bot controls and running Bot conversations. The notes and transcripts remain on disk. Keep the format guard and the Bot link on persisted threads until the protected data has a migration path.
