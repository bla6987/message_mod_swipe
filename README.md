# Swipe-Linked User Edit

A SillyTavern UI extension that links user message edits to AI swipe variants. When you edit the most recent user message and regenerate/swipe, swiping between AI variants will automatically update the displayed user message to show the text that was associated with each variant.

## Problem

In vanilla SillyTavern, if you edit your last user message and then swipe the AI response to generate new variants, swiping back to earlier AI variants still shows the *edited* user text — not the original text that produced those older variants.

## Solution

This extension maintains an in-memory mapping between each AI variant and the user message text that was active when that variant was generated. When you swipe between AI variants, the user bubble updates accordingly. The outgoing prompt context is also patched ephemerally so that regenerations and continuations use the correct user text for the displayed variant.

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

No buttons, no config UI. It works transparently with the existing swipe arrows and hotkeys.

## Debug Mode

Open the browser console and run:

```js
SillyTavern.getContext().extensionSettings.swipe_linked_user_edit.debug = true;
```

Debug logs are prefixed with `[swipe_linked_user_edit]`.

## Known Limitations

- **Only tracks the swipes for the most recent assistant message.** Older messages are not actively managed (SillyTavern only exposes swipe controls for the latest reply).
- **Pre-existing variants** (created before the extension loaded or before the current session) will not have a mapping; the user bubble is left unchanged when swiping to them.
- **Formatting is lost** in the swapped user bubble because `textContent` is used for safe DOM updates. The underlying chat data is not modified.
- **No persistence.** Mappings live in memory only. Reloading the page or switching chats loses all associations.
- **Does not create branches or checkpoints.** This is intentionally lightweight and ephemeral.

## How It Works (internals)

1. `GENERATION_AFTER_COMMANDS` — snapshots the current last user message text.
2. `MESSAGE_RECEIVED` — stores `assistantMesId:swipeId → userText` in a Map.
3. Swipe detection (MutationObserver on assistant `.mes_text` + delegated click on `.swipe_left`/`.swipe_right`) triggers a lookup and DOM update.
4. `generate_interceptor` — ephemerally patches the last user message in the outgoing prompt array (clones only that one message object; restores on `GENERATION_ENDED`).
5. `CHAT_CHANGED` — clears all state. `MESSAGE_SENT` only clears the pending snapshot.
