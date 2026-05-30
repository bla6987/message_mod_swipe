# Swipe-Linked User Edit

A SillyTavern UI extension that links user message edits to AI swipe variants. When you edit the most recent user message and regenerate/swipe, swiping between AI variants will automatically update the displayed user message to show the text that was associated with each variant.

## Problem

In vanilla SillyTavern, if you edit your last user message and then swipe the AI response to generate new variants, swiping back to earlier AI variants still shows the *edited* user text — not the original text that produced those older variants.

## Solution

This extension stores the user message text that was active for each AI swipe variant in SillyTavern's per-swipe metadata. When you swipe between AI variants, the user bubble updates accordingly. The outgoing prompt context is also patched ephemerally so that regenerations and continuations use the correct user text for the displayed variant.

## Install

### Per-user install

Copy or symlink this folder into:

```
data/<user-handle>/extensions/third-party/swipe_linked_user_edit/
```

### Global install (all users)

Copy or symlink into:

```
public/scripts/extensions/third-party/swipe_linked_user_edit/
```

Then enable the extension in **Extensions > Manage Extensions** within SillyTavern.

## Usage

1. Send a user message and receive an AI response.
2. Edit the user message text (click the pencil icon on your message bubble, change text, confirm).
3. Regenerate or swipe right to get a new AI variant.
4. Swipe left/right between AI variants — the user bubble updates to show the text associated with each variant.
5. When you send the next message, the prompt context includes the correct user text for the currently displayed AI variant.

It works transparently with the existing swipe arrows and hotkeys — no config UI.

### View linked edits

AI messages that have more than one swipe (or any recorded edit) get a small
history icon (⟲) in the message actions menu (the `…` button). Click it to open
a popup listing the user text each swipe was generated from, grouping identical
edits together and marking the swipe you're currently viewing.

## Debug Mode

Open the browser console and run:

```js
SillyTavern.getContext().extensionSettings.swipe_linked_user_edit.debug = true;
```

Debug logs are prefixed with `[swipe_linked_user_edit]`.

## Known Limitations

- **Swipe UI availability depends on SillyTavern.** The extension can persist metadata for generated swipes, but SillyTavern may only expose swipe controls for selected/latest replies depending on context.
- **Pre-existing variants** (created before the extension loaded or before the current session) will not have a mapping; the user bubble is left unchanged when swiping to them.
- **Display-only bubble swap.** The extension re-renders the visible user bubble where possible, but does not modify the original user message text in chat data.
- **Does not create branches or checkpoints.** The extension only stores lightweight per-swipe metadata on existing messages.

## How It Works (internals)

1. `GENERATION_AFTER_COMMANDS` — snapshots user text for regeneration-like flows (`swipe`/`regenerate`/`continue`) before prompt assembly.
2. `MESSAGE_SENT` + `MESSAGE_RECEIVED` — for `normal` sends, captures the just-sent user text at `MESSAGE_SENT` and writes it at `MESSAGE_RECEIVED`.
3. Per-swipe persistence — generated variants store `linked_user_text` on `swipe_info[swipeId].extra`, with the active swipe mirrored to `msg.extra.linked_user_text` for SillyTavern's swipe sync.
4. Swipe detection (SillyTavern's `MESSAGE_SWIPED` event, with DOM fallback) reads that per-swipe metadata and updates the displayed user bubble when a linked text exists.
5. `generate_interceptor` — ephemerally patches `msg.mes` on the selected user message in the outgoing prompt array. Patch precedence is `edited > generation-start snapshot > linked swipe text` to avoid race-dependent stale prompts.
6. `CHAT_CHANGED` — clears session-only lifecycle state. Persisted `swipe_info[].extra.linked_user_text` values remain in chat data and survive reloads, chat switches, and branching.
