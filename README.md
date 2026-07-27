# Swipe-Linked User Edit

A SillyTavern UI extension that links user message edits to AI swipe variants. When you edit the most recent user message and regenerate/swipe, swiping between AI variants will automatically update the displayed user message to show the text that was associated with each variant.

## Problem

In vanilla SillyTavern, if you edit your last user message and then swipe the AI response to generate new variants, swiping back to earlier AI variants still shows the *edited* user text — not the original text that produced those older variants.

## Solution

This extension stores the user message text that was active for each AI swipe variant in SillyTavern's per-swipe metadata. When you swipe between AI variants, the user bubble updates accordingly. The outgoing prompt context is also patched ephemerally so that regenerations and continuations use the correct user text for the displayed variant.

## Install

> **Note on naming:** this repo is `message_mod_swipe`, but the extension's
> internal namespace and settings key are `swipe_linked_user_edit`. The
> installed folder name is arbitrary — SillyTavern reads `manifest.json`, not
> the folder name — so the examples below use `message_mod_swipe` to match the
> repo. You may rename the folder to `swipe_linked_user_edit` if you prefer; it
> makes no functional difference.

### Per-user install

Copy or symlink this folder into:

```
data/<user-handle>/extensions/third-party/message_mod_swipe/
```

### Global install (all users)

Copy or symlink into:

```
public/scripts/extensions/third-party/message_mod_swipe/
```

Then enable the extension in **Extensions > Manage Extensions** within SillyTavern.

## Usage

1. Send a user message and receive an AI response.
2. Edit the user message text (click the pencil icon on your message bubble, change text, confirm).
3. Regenerate or swipe right to get a new AI variant.
4. Swipe left/right between AI variants — the user bubble updates to show the text associated with each variant.
5. When you send the next message, the prompt context includes the correct user text for the currently displayed AI variant.

It works transparently with the existing swipe arrows and hotkeys — no config UI.
If you pencil-edit the message again after generating the latest swipe, that
new canonical edit remains displayed and is used on the next normal send until
you regenerate. Earlier selected swipes continue to use their linked text.

### View linked edits

AI messages that have more than one swipe (or any recorded edit) get a small
history icon (⟲) in the message actions menu (the `…` button). Click it to open
a popup listing the user text each swipe was generated from, grouping identical
edits together and marking the swipe you're currently viewing.

### Manually control what gets sent

The same popup lets you override the linked text, so you can fix a typo or
choose exactly which user text goes out with the next generation. Each group of
swipes offers:

- **Edit text… / Set text…** — edit the linked user text in place (e.g. correct
  a spelling error). The corrected text is what those swipes send to the model.
- **Use latest message text** — replace the group's linked text with the user
  message's current (pencil-edited) text. Shown when the two differ.
- **Unlink** — remove the linked text entirely, so those swipes always send the
  latest message text.
- **Send this for current swipe** — copy another group's text onto the swipe you
  are currently viewing, making it the text sent in the current context.

Manual overrides are marked "manually set" in the popup and are authoritative:
unlike automatic links, they are honored on normal sends even when the message
sits on its latest (or only) swipe. Regenerating a swipe replaces the override
with a fresh automatic link.

## Debug Mode

Open the browser console and run:

```js
SillyTavern.getContext().extensionSettings.swipe_linked_user_edit.debug = true;
```

Debug logs are prefixed with `[swipe_linked_user_edit]`.

## Testing

Run the focused lifecycle regression suite with Node.js:

```sh
npm test
```

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
6. Manual overrides — the "Linked user edits" popup writes `linked_user_text` alongside a `linked_user_text_manual` flag. Flagged links are honored by the normal-send patcher even on the latest/only swipe; automatic writes (generation completion) clear the flag.
7. `CHAT_CHANGED` — clears session-only lifecycle state. Persisted `swipe_info[].extra.linked_user_text` values remain in chat data and survive reloads, chat switches, and branching.
