const assert = require('node:assert/strict');
const test = require('node:test');

const {
    FakeElement,
    FakeTextNode,
    createHarness,
    createMessageElement,
    markdownFormatting,
} = require('./harness');

const DEBOUNCE_MS = 150;

async function flush() {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

function assistantMessage(mes, overrides = {}) {
    return {
        is_user: false,
        mes,
        send_date: 'assistant-1',
        swipe_id: 0,
        swipes: [mes],
        swipe_info: [{ extra: {} }],
        extra: {},
        ...overrides,
    };
}

function renderedElement(messageId, msg, { isUser = false } = {}) {
    return createMessageElement(messageId, { isUser, html: markdownFormatting(msg.mes) });
}

function buildHarness(chat, elements) {
    const harness = createHarness(chat, elements, { messageFormatting: markdownFormatting });
    harness.runTimers();
    harness.eventSource.emitted.length = 0;
    return harness;
}

function menuButton(harness) {
    const menu = harness.hooks().getDeleteMenu();
    assert.ok(menu, 'delete menu should be shown');
    const button = menu.querySelector('.swipe_delete_selection_button');
    assert.ok(button, 'delete button should exist');
    return button;
}

async function showMenuForSelection(harness) {
    harness.dispatchDocumentEvent('selectionchange');
    harness.runTimers(DEBOUNCE_MS);
    return menuButton(harness);
}

async function pressDelete(harness) {
    const button = await showMenuForSelection(harness);
    const event = { preventDefault: () => { event.prevented = true; }, stopPropagation: () => {}, prevented: false };
    button.dispatch('pointerdown', event);
    assert.equal(event.prevented, true, 'pointerdown default should be prevented so the selection survives');
    await flush();
}

async function pressUndo(harness, element) {
    const button = element.querySelector('.swipe_delete_undo_button');
    assert.ok(button, 'undo button should be present');
    harness.dispatchDocumentEvent('click', { target: button });
    await flush();
}

function emittedNames(harness) {
    return harness.eventSource.emitted.map((entry) => entry.name);
}

test('ordinary text-node selection deletes from the assistant source in SillyTavern edit order', async () => {
    const assistant = assistantMessage('The quick brown fox jumps');
    const chat = [{ is_user: true, mes: 'hi', send_date: 'user-1' }, assistant];
    const userElement = createMessageElement(0, { isUser: true, text: 'hi' });
    const assistantElement = renderedElement(1, assistant);
    const harness = buildHarness(chat, [userElement, assistantElement]);

    harness.selectRenderedText(assistantElement.mesText, 'quick ');
    await pressDelete(harness);

    assert.equal(assistant.mes, 'The brown fox jumps');
    assert.equal(assistant.swipes[0], 'The brown fox jumps');
    assert.deepEqual(emittedNames(harness), ['message_edited', 'message_updated']);
    assert.equal(harness.eventSource.emitted[0].args[0], 1);
    assert.equal(harness.calls.saveChat, 1);
    assert.equal(harness.context.chatMetadata.tainted, true);
    assert.equal(assistantElement.mesText.textContent, 'The brown fox jumps');
    assert.equal(harness.hooks().getDeleteMenu(), null, 'menu removed after the action');
    assert.equal(harness.calls.removeAllRanges, 1, 'selection cleared after the action');
    assert.equal(harness.hooks().getDeletionHistory().length, 1);
    assert.ok(assistantElement.querySelector('.swipe_delete_undo_button'));
});

test('double-click style element-node endpoints are mapped through child offsets', async () => {
    const assistant = assistantMessage('Hello **bold** world');
    const chat = [{ is_user: true, mes: 'hi', send_date: 'user-1' }, assistant];
    const assistantElement = renderedElement(1, assistant);
    const harness = buildHarness(chat, [createMessageElement(0, { isUser: true, text: 'hi' }), assistantElement]);

    const paragraph = assistantElement.mesText.childNodes[0];
    assert.equal(paragraph.tagName, 'P');
    // Element container, child offsets: from before the first text node to before <strong>.
    harness.setSelectionRange({
        startContainer: paragraph,
        startOffset: 0,
        endContainer: paragraph,
        endOffset: 1,
        text: 'Hello ',
        mesTextEl: assistantElement.mesText,
    });
    await pressDelete(harness);

    assert.equal(assistant.mes, '**bold** world');
    assert.equal(assistantElement.mesText.textContent, 'bold world');
});

test('the correct occurrence is removed when identical text repeats', async () => {
    const assistant = assistantMessage('the cat sat on the mat with the cat');
    const chat = [{ is_user: true, mes: 'hi', send_date: 'user-1' }, assistant];
    const assistantElement = renderedElement(1, assistant);
    const harness = buildHarness(chat, [createMessageElement(0, { isUser: true, text: 'hi' }), assistantElement]);

    harness.selectRenderedText(assistantElement.mesText, 'the cat', { occurrence: 1 });
    await pressDelete(harness);

    assert.equal(assistant.mes, 'the cat sat on the mat with ');
});

test('full and partial bold/italic deletions keep the Markdown valid', async () => {
    const cases = [
        { source: 'Say **bold** now', select: 'bold', expected: 'Say  now' },
        { source: 'Say *it* now', select: 'it', expected: 'Say  now' },
        { source: 'Say ~~gone~~ now', select: 'gone', expected: 'Say  now' },
        { source: 'Say **bold text** now', select: 'bold', expected: 'Say **text** now' },
        { source: 'Say **bold text** now', select: 'text', expected: 'Say **bold** now' },
        { source: 'Say **abcdef** now', select: 'cd', expected: 'Say **abef** now' },
        { source: '**bold** and more', select: 'bold and', expected: ' more' },
    ];
    for (const { source, select, expected } of cases) {
        const assistant = assistantMessage(source);
        const chat = [{ is_user: true, mes: 'hi', send_date: 'user-1' }, assistant];
        const assistantElement = renderedElement(1, assistant);
        const harness = buildHarness(chat, [createMessageElement(0, { isUser: true, text: 'hi' }), assistantElement]);
        harness.selectRenderedText(assistantElement.mesText, select);
        await pressDelete(harness);
        assert.equal(assistant.mes, expected, `deleting "${select}" from "${source}"`);
        assert.ok(!assistant.mes.includes('****'), 'no empty bold left behind');
    }
});

test('deleting an entire link label removes the whole link construct', async () => {
    const cases = [
        { source: 'See [the docs](https://example.com/docs) now', select: 'the docs', expected: 'See  now' },
        { source: 'See [the docs](https://example.com/docs) now', select: 'See the docs', expected: ' now' },
        { source: 'See [the docs](https://example.com/docs) now', select: 'docs now', expected: 'See [the ](https://example.com/docs)' },
    ];
    for (const { source, select, expected } of cases) {
        const assistant = assistantMessage(source);
        const chat = [{ is_user: true, mes: 'hi', send_date: 'user-1' }, assistant];
        const assistantElement = renderedElement(1, assistant);
        const harness = buildHarness(chat, [createMessageElement(0, { isUser: true, text: 'hi' }), assistantElement]);
        harness.selectRenderedText(assistantElement.mesText, select);
        await pressDelete(harness);
        assert.equal(assistant.mes, expected, `deleting "${select}" from "${source}"`);
        assert.ok(!assistant.mes.includes('[]('), 'no empty link label left behind');
    }
});

test('macro-expanded or otherwise unmappable content is refused without changes', async () => {
    const assistant = assistantMessage('Hello {{user}} friend');
    const chat = [{ is_user: true, mes: 'hi', send_date: 'user-1' }, assistant];
    const assistantElement = renderedElement(1, assistant);
    const harness = buildHarness(chat, [createMessageElement(0, { isUser: true, text: 'hi' }), assistantElement]);
    assert.equal(assistantElement.mesText.textContent, 'Hello MACRO friend');

    harness.selectRenderedText(assistantElement.mesText, 'MACRO');
    await pressDelete(harness);

    assert.equal(assistant.mes, 'Hello {{user}} friend');
    assert.deepEqual(emittedNames(harness), []);
    assert.equal(harness.calls.saveChat, 0);
    assert.equal(harness.toasts.warning.length, 1);
    assert.equal(harness.hooks().getDeletionHistory().length, 0);

    // A bubble whose DOM was produced by something other than messageFormatting(source)
    // (e.g. a translation) fails the baseline check and is refused too.
    const translated = assistantMessage('original words here');
    const translatedElement = createMessageElement(1, { html: markdownFormatting('translated words here') });
    const harness2 = buildHarness([{ is_user: true, mes: 'hi', send_date: 'user-1' }, translated], [createMessageElement(0, { isUser: true, text: 'hi' }), translatedElement]);
    harness2.selectRenderedText(translatedElement.mesText, 'words');
    await pressDelete(harness2);
    assert.equal(translated.mes, 'original words here');
    assert.equal(harness2.calls.saveChat, 0);
    assert.equal(harness2.toasts.warning.length, 1);
});

test('canonical user-message deletion updates msg.mes and is captured as a pending edit', async () => {
    const user = { is_user: true, mes: 'please write a **long** story', send_date: 'user-1' };
    const assistant = assistantMessage('Once upon a time', { swipes: ['Once upon a time', 'Alt'], swipe_info: [{ extra: {} }, { extra: {} }] });
    const chat = [user, assistant];
    const userElement = renderedElement(0, user, { isUser: true });
    const harness = buildHarness(chat, [userElement, renderedElement(1, assistant)]);

    harness.selectRenderedText(userElement.mesText, 'long');
    await pressDelete(harness);

    assert.equal(user.mes, 'please write a  story');
    assert.equal(assistant.mes, 'Once upon a time');
    assert.deepEqual(emittedNames(harness), ['message_edited', 'message_updated']);
    const pending = harness.hooks().getState().pendingEditedEntry;
    assert.equal(pending.key, '1:0');
    assert.equal(pending.text, 'please write a  story');
    assert.equal(userElement.mesText.textContent, 'please write a  story');
});

test('historical swipe-linked user bubble edits only the linked text as a manual override', async () => {
    const user = { is_user: true, mes: 'canonical text', send_date: 'user-1' };
    const assistant = assistantMessage('reply A', {
        swipe_id: 0,
        swipes: ['reply A', 'reply B'],
        swipe_info: [
            { extra: { linked_user_text: 'older linked text' } },
            { extra: { linked_user_text: 'canonical text' } },
        ],
        extra: { linked_user_text: 'older linked text' },
    });
    const chat = [user, assistant];
    const userElement = renderedElement(0, user, { isUser: true });
    const harness = buildHarness(chat, [userElement, renderedElement(1, assistant)]);
    assert.equal(userElement.getAttribute('data-swipe-linked'), '1');
    assert.equal(userElement.mesText.textContent, 'older linked text');

    harness.selectRenderedText(userElement.mesText, 'older ');
    await pressDelete(harness);

    assert.equal(user.mes, 'canonical text', 'canonical text untouched');
    assert.equal(assistant.swipe_info[0].extra.linked_user_text, 'linked text');
    assert.equal(assistant.swipe_info[0].extra.linked_user_text_manual, true);
    assert.equal(assistant.extra.linked_user_text, 'linked text');
    assert.equal(assistant.swipe_info[1].extra.linked_user_text, 'canonical text');
    assert.deepEqual(emittedNames(harness), [], 'no canonical MESSAGE_EDITED for a linked-only edit');
    assert.equal(harness.calls.saveChat, 1);
    assert.equal(userElement.mesText.textContent, 'linked text');
    assert.equal(userElement.getAttribute('data-swipe-linked'), '1');
});

test('assistant active-swipe deletion updates mes and the active swipes[] entry only', async () => {
    const assistant = assistantMessage('second reply text', {
        swipe_id: 1,
        swipes: ['first reply', 'second reply text'],
        swipe_info: [{ extra: { linked_user_text: 'a' } }, { extra: { linked_user_text: 'b' }, send_date: 'x' }],
        extra: { linked_user_text: 'b', api: 'openai' },
    });
    const chat = [{ is_user: true, mes: 'hi', send_date: 'user-1' }, assistant];
    const assistantElement = renderedElement(1, assistant);
    const harness = buildHarness(chat, [createMessageElement(0, { isUser: true, text: 'hi' }), assistantElement]);
    const swipeInfoBefore = JSON.stringify(assistant.swipe_info);

    harness.selectRenderedText(assistantElement.mesText, ' text');
    await pressDelete(harness);

    assert.equal(assistant.mes, 'second reply');
    assert.equal(assistant.swipes[1], 'second reply');
    assert.equal(assistant.swipes[0], 'first reply');
    assert.equal(JSON.stringify(assistant.swipe_info), swipeInfoBefore);
    assert.deepEqual(assistant.extra, { linked_user_text: 'b', api: 'openai' });
});

test('a failing save rolls back data, DOM, and session state', async () => {
    const user = { is_user: true, mes: 'keep this text', send_date: 'user-1' };
    const assistant = assistantMessage('reply');
    const chat = [user, assistant];
    const userElement = renderedElement(0, user, { isUser: true });
    const harness = buildHarness(chat, [userElement, renderedElement(1, assistant)]);
    harness.context.saveChat = async () => { throw new Error('disk full'); };
    const htmlBefore = userElement.mesText.innerHTML;

    harness.selectRenderedText(userElement.mesText, 'this ');
    await pressDelete(harness);

    assert.equal(user.mes, 'keep this text');
    assert.equal(userElement.mesText.innerHTML, htmlBefore);
    assert.equal(userElement.mesText.textContent, 'keep this text');
    assert.equal(harness.hooks().getState().pendingEditedEntry, null, 'pending edit captured during MESSAGE_EDITED was rolled back');
    assert.equal(harness.toasts.error.length, 1);
    assert.equal(harness.hooks().getDeletionHistory().length, 0);
    assert.equal(harness.hooks().getState().deletionInFlight, false);
    assert.equal(harness.hooks().getDeleteMenu(), null);

    // Linked-only edits roll back the linked text the same way.
    const linkedUser = { is_user: true, mes: 'canonical', send_date: 'user-1' };
    const linkedAssistant = assistantMessage('reply A', {
        swipes: ['reply A', 'reply B'],
        swipe_info: [{ extra: { linked_user_text: 'older linked' } }, { extra: { linked_user_text: 'canonical' } }],
        extra: { linked_user_text: 'older linked' },
    });
    const linkedElement = renderedElement(0, linkedUser, { isUser: true });
    const harness2 = buildHarness([linkedUser, linkedAssistant], [linkedElement, renderedElement(1, linkedAssistant)]);
    harness2.context.saveChat = async () => { throw new Error('disk full'); };
    harness2.selectRenderedText(linkedElement.mesText, 'older ');
    await pressDelete(harness2);
    assert.equal(linkedAssistant.swipe_info[0].extra.linked_user_text, 'older linked');
    assert.equal(linkedAssistant.swipe_info[0].extra.linked_user_text_manual, undefined);
    assert.equal(linkedElement.mesText.textContent, 'older linked');
    assert.equal(harness2.toasts.error.length, 1);
});

test('undo restores the exact target for canonical, linked, and assistant deletions', async () => {
    // Canonical user message.
    const user = { is_user: true, mes: 'alpha beta gamma', send_date: 'user-1' };
    const assistant = assistantMessage('reply one two');
    const chat = [user, assistant];
    const userElement = renderedElement(0, user, { isUser: true });
    const assistantElement = renderedElement(1, assistant);
    const harness = buildHarness(chat, [userElement, assistantElement]);

    harness.selectRenderedText(userElement.mesText, 'beta ');
    await pressDelete(harness);
    assert.equal(user.mes, 'alpha gamma');
    harness.eventSource.emitted.length = 0;
    await pressUndo(harness, userElement);
    assert.equal(user.mes, 'alpha beta gamma');
    assert.equal(userElement.mesText.textContent, 'alpha beta gamma');
    assert.deepEqual(emittedNames(harness), ['message_edited', 'message_updated']);
    assert.equal(harness.calls.saveChat, 2);
    assert.equal(harness.hooks().getDeletionHistory().length, 0);
    assert.equal(userElement.querySelector('.swipe_delete_undo_button'), null);

    // Assistant active swipe.
    harness.selectRenderedText(assistantElement.mesText, ' two');
    await pressDelete(harness);
    assert.equal(assistant.mes, 'reply one');
    assert.equal(assistant.swipes[0], 'reply one');
    await pressUndo(harness, assistantElement);
    assert.equal(assistant.mes, 'reply one two');
    assert.equal(assistant.swipes[0], 'reply one two');
    assert.equal(harness.calls.saveChat, 4);

    // Stale entry: the message changed by other means after the deletion.
    harness.selectRenderedText(assistantElement.mesText, 'one ');
    await pressDelete(harness);
    assert.equal(assistant.mes, 'reply two');
    assistant.mes = 'edited elsewhere';
    assistant.swipes[0] = 'edited elsewhere';
    await pressUndo(harness, assistantElement);
    assert.equal(assistant.mes, 'edited elsewhere', 'stale undo must not clobber a later edit');
    assert.equal(harness.hooks().getDeletionHistory().length, 0);
    assert.equal(harness.toasts.warning.length, 1);

    // Linked text.
    const linkedUser = { is_user: true, mes: 'canonical text', send_date: 'user-1' };
    const linkedAssistant = assistantMessage('reply A', {
        swipes: ['reply A', 'reply B'],
        swipe_info: [{ extra: { linked_user_text: 'older linked text' } }, { extra: { linked_user_text: 'canonical text' } }],
        extra: { linked_user_text: 'older linked text' },
    });
    const linkedElement = renderedElement(0, linkedUser, { isUser: true });
    const harness2 = buildHarness([linkedUser, linkedAssistant], [linkedElement, renderedElement(1, linkedAssistant)]);
    harness2.selectRenderedText(linkedElement.mesText, 'older ');
    await pressDelete(harness2);
    assert.equal(linkedAssistant.swipe_info[0].extra.linked_user_text, 'linked text');
    await pressUndo(harness2, linkedElement);
    assert.equal(linkedAssistant.swipe_info[0].extra.linked_user_text, 'older linked text');
    assert.equal(linkedAssistant.swipe_info[0].extra.linked_user_text_manual, undefined, 'automatic link restored without the manual flag');
    assert.equal(linkedAssistant.extra.linked_user_text, 'older linked text');
    assert.equal(linkedUser.mes, 'canonical text');
    assert.equal(linkedElement.mesText.textContent, 'older linked text');
    assert.equal(linkedElement.getAttribute('data-swipe-linked'), '1');
    assert.deepEqual(emittedNames(harness2), []);
    assert.equal(harness2.calls.saveChat, 2);
});

test('undo history is bounded to 15 entries', async () => {
    const assistant = assistantMessage('a'.repeat(40));
    const chat = [{ is_user: true, mes: 'hi', send_date: 'user-1' }, assistant];
    const assistantElement = renderedElement(1, assistant);
    const harness = buildHarness(chat, [createMessageElement(0, { isUser: true, text: 'hi' }), assistantElement]);
    for (let i = 0; i < 17; i++) {
        harness.selectRenderedText(assistantElement.mesText, 'a');
        await pressDelete(harness);
    }
    assert.equal(assistant.mes, 'a'.repeat(23));
    assert.equal(harness.hooks().getDeletionHistory().length, 15);
});

test('debounce, selection loss, chat change, and teardown clean up the menu', async () => {
    const assistant = assistantMessage('some text here');
    const chat = [{ is_user: true, mes: 'hi', send_date: 'user-1' }, assistant];
    const assistantElement = renderedElement(1, assistant);
    const harness = buildHarness(chat, [createMessageElement(0, { isUser: true, text: 'hi' }), assistantElement]);

    // Two rapid selectionchange events → one pending debounce timer.
    harness.selectRenderedText(assistantElement.mesText, 'text');
    harness.dispatchDocumentEvent('selectionchange');
    harness.dispatchDocumentEvent('selectionchange');
    const pending = [...harness.timers.values()].filter((timer) => timer.delay === DEBOUNCE_MS);
    assert.equal(pending.length, 1, 'superseded debounce timer is cancelled');
    harness.runTimers(DEBOUNCE_MS);
    assert.ok(harness.hooks().getDeleteMenu());
    assert.ok(harness.document.body.querySelector('.swipe_delete_selection_menu'));

    // Selection cleared before the timer fires → no menu.
    harness.dispatchDocumentEvent('selectionchange');
    harness.clearSelection();
    harness.runTimers(DEBOUNCE_MS);
    assert.equal(harness.hooks().getDeleteMenu(), null);

    // Outside pointerdown removes the menu; pointerdown inside keeps it.
    harness.selectRenderedText(assistantElement.mesText, 'text');
    await showMenuForSelection(harness);
    harness.dispatchDocumentEvent('pointerdown', { target: menuButton(harness) });
    assert.ok(harness.hooks().getDeleteMenu());
    harness.dispatchDocumentEvent('pointerdown', { target: assistantElement });
    assert.equal(harness.hooks().getDeleteMenu(), null);

    // Selections inside the native editor or a textarea never show the menu.
    const editor = new FakeElement('textarea');
    editor.className = 'edit_textarea';
    editor.id = 'curEditTextarea';
    assistantElement.mesText.appendChild(editor);
    harness.selectRenderedText(assistantElement.mesText, 'text');
    harness.dispatchDocumentEvent('selectionchange');
    harness.runTimers(DEBOUNCE_MS);
    assert.equal(harness.hooks().getDeleteMenu(), null);
    editor.remove();

    // Chat change removes the menu and clears the undo history.
    harness.selectRenderedText(assistantElement.mesText, 'text');
    await pressDelete(harness);
    assert.equal(harness.hooks().getDeletionHistory().length, 1);
    harness.selectRenderedText(assistantElement.mesText, 'some');
    await showMenuForSelection(harness);
    harness.context.chatId = 'another-chat';
    await harness.eventSource.emit(harness.eventTypes.CHAT_CHANGED);
    assert.equal(harness.hooks().getDeleteMenu(), null);
    assert.equal(harness.hooks().getDeletionHistory().length, 0);
    assert.equal(assistantElement.querySelector('.swipe_delete_undo_button'), null);

    // Teardown removes listeners, timers, and the menu.
    harness.selectRenderedText(assistantElement.mesText, 'some');
    harness.dispatchDocumentEvent('selectionchange');
    harness.hooks().teardown();
    assert.equal(harness.document.listeners.get('selectionchange').length, 0);
    assert.equal(harness.document.listeners.get('pointerdown').length, 0);
    assert.equal(harness.chatElement.listeners.get('scroll').length, 0);
    assert.equal([...harness.timers.values()].filter((timer) => timer.delay === DEBOUNCE_MS).length, 0);
    assert.equal(harness.hooks().getDeleteMenu(), null);
});

test('system messages and transformed displays never get a delete button', async () => {
    const system = { is_user: false, is_system: true, mes: 'system note', send_date: 'sys' };
    const shown = assistantMessage('real source', { extra: { display_text: 'shown instead' } });
    const chat = [system, shown];
    const systemElement = createMessageElement(0, { isSystem: true, html: markdownFormatting(system.mes) });
    const shownElement = createMessageElement(1, { html: markdownFormatting('shown instead') });
    const harness = buildHarness(chat, [systemElement, shownElement]);

    harness.selectRenderedText(systemElement.mesText, 'note');
    harness.dispatchDocumentEvent('selectionchange');
    harness.runTimers(DEBOUNCE_MS);
    assert.equal(harness.hooks().getDeleteMenu(), null);

    harness.selectRenderedText(shownElement.mesText, 'shown');
    harness.dispatchDocumentEvent('selectionchange');
    harness.runTimers(DEBOUNCE_MS);
    assert.equal(harness.hooks().getDeleteMenu(), null);
});

test('traversal always terminates on cyclic or oversized DOM trees', () => {
    const harness = buildHarness([], []);
    const { collectTextLayout, resolveBoundaryOffset } = harness.hooks();

    const a = new FakeElement('div');
    const b = new FakeElement('span');
    a.children = [b];
    b.children = [a];
    b.parentElement = a;
    a.parentElement = b;
    assert.equal(collectTextLayout(a), null, 'cyclic tree is refused');

    const big = new FakeElement('div');
    for (let i = 0; i < 50; i++) big.appendChild(new FakeTextNode('x'));
    assert.equal(collectTextLayout(big, 10), null, 'node cap is enforced');
    const layout = collectTextLayout(big);
    assert.equal(layout.text, 'x'.repeat(50));

    const style = new FakeElement('style');
    style.appendChild(new FakeTextNode('.hidden{}'));
    const root = new FakeElement('div');
    root.appendChild(new FakeTextNode('ab'));
    root.appendChild(style);
    root.appendChild(new FakeTextNode('cd'));
    const withStyle = collectTextLayout(root);
    assert.equal(withStyle.text, 'abcd', 'non-rendered subtrees do not contribute text');
    assert.equal(resolveBoundaryOffset(withStyle, root, 3), 4);
    assert.equal(resolveBoundaryOffset(withStyle, root.childNodes[2], 1), 3);
    assert.equal(resolveBoundaryOffset(withStyle, new FakeTextNode('zz'), 0), null, 'detached node');
});

test('mapping primitives refuse ambiguous or non-syntax mismatches', () => {
    const harness = buildHarness([], []);
    const { alignRenderedToSource, adjustSpanForMarkdown, computeDeletionSpan } = harness.hooks();

    const aligned = alignRenderedToSource('bold and', '**bold** and', 0, 8);
    assert.equal(JSON.stringify(aligned.segments), JSON.stringify([{ start: 2, end: 12 }]), 'pure-syntax gap folded');
    const split = alignRenderedToSource('See the docs now', 'See [the docs](https://x) now', 8, 16);
    assert.equal(JSON.stringify(split.segments), JSON.stringify([{ start: 9, end: 13 }, { start: 25, end: 29 }]), 'link target kept');
    assert.equal(alignRenderedToSource('MACRO x', '{{user}} x', 0, 5), null, 'non-syntax mismatch aborts');
    assert.deepEqual({ ...adjustSpanForMarkdown('a **b** c', 4, 5) }, { start: 2, end: 7 });
    assert.deepEqual({ ...adjustSpanForMarkdown('[label](u) x', 1, 6) }, { start: 0, end: 10 });
    assert.equal(adjustSpanForMarkdown('abc', 2, 1), null);

    const identity = (text) => text;
    const repeated = computeDeletionSpan({ source: 'aa aa', layoutText: 'aa aa', selStart: 3, selEnd: 5, renderToText: identity });
    assert.equal(repeated.newText, 'aa ');
    assert.equal(repeated.start, 3);
    assert.equal(
        computeDeletionSpan({ source: 'x y', layoutText: 'x y', selStart: 1, selEnd: 2, renderToText: identity }).error,
        'whitespace_selection',
    );
    assert.equal(
        computeDeletionSpan({ source: 'abc', layoutText: 'abc', selStart: 2, selEnd: 9, renderToText: identity }).error,
        'invalid_selection',
    );
    assert.equal(
        computeDeletionSpan({ source: 'abc', layoutText: 'xyz', selStart: 0, selEnd: 1, renderToText: identity }).error,
        'display_mismatch',
    );
});

test('hidden URL occurrences cannot redirect deletion to a different formatted occurrence', async () => {
    const source = '[x](x)**x**x';
    for (const [occurrence, expected] of [[0, '**x**x'], [1, '[x](x)x'], [2, '[x](x)**x**']]) {
        const assistant = assistantMessage(source);
        const element = renderedElement(0, assistant);
        const harness = buildHarness([assistant], [element]);
        harness.selectRenderedText(element.mesText, 'x', { occurrence });
        await pressDelete(harness);
        assert.equal(assistant.mes, expected, `rendered occurrence ${occurrence}`);
        assert.equal(harness.toasts.warning.length, 0);
    }
});

test('macro output matching literal source text is refused instead of deleting the literal', async () => {
    const assistant = assistantMessage('{{user}}MACRO');
    const element = renderedElement(0, assistant);
    const harness = buildHarness([assistant], [element]);
    harness.selectRenderedText(element.mesText, 'MACRO');
    await pressDelete(harness);
    assert.equal(assistant.mes, '{{user}}MACRO');
    assert.equal(harness.calls.saveChat, 0);
    assert.equal(harness.toasts.warning.length, 1);
});

test('changed or cleared selections cannot execute a cached menu before debounce', async () => {
    for (const change of ['clear', 'move', 'source', 'swipe', 'editor']) {
        const assistant = assistantMessage('some text here', { swipes: ['some text here', 'some text here'] });
        const element = renderedElement(0, assistant);
        const harness = buildHarness([assistant], [element]);
        harness.selectRenderedText(element.mesText, 'text ');
        const button = await showMenuForSelection(harness);
        if (change === 'clear') harness.clearSelection();
        if (change === 'move') harness.selectRenderedText(element.mesText, 'some ');
        if (change === 'source') assistant.mes = 'some newer text here';
        if (change === 'swipe') assistant.swipe_id = 1;
        if (change === 'editor') element.mesText.setAttribute('contenteditable', 'true');
        const before = assistant.mes;
        harness.dispatchDocumentEvent('selectionchange');
        button.dispatch('pointerdown', { preventDefault() {}, stopPropagation() {} });
        await flush();
        assert.equal(assistant.mes, before, change);
        assert.equal(harness.calls.saveChat, 0, change);
        assert.equal(harness.hooks().getDeletionHistory().length, 0, change);
        assert.equal(harness.hooks().getDeleteMenu(), null, change);
    }
});

async function deleteSwipe(harness, assistant, messageId, swipeId) {
    const active = assistant.swipe_id;
    assistant.swipes.splice(swipeId, 1);
    assistant.swipe_info.splice(swipeId, 1);
    assistant.swipe_id = swipeId < active ? active - 1 : Math.min(active, assistant.swipes.length - 1);
    assistant.mes = assistant.swipes[assistant.swipe_id];
    await harness.eventSource.emit(harness.eventTypes.MESSAGE_SWIPE_DELETED, {
        messageId, swipeId, newSwipeId: assistant.swipe_id,
    });
}

test('deleting the edited assistant swipe discards undo even if the replacement has identical text', async () => {
    const assistant = assistantMessage('hello remove', {
        swipes: ['hello remove', 'hello '], swipe_info: [{ extra: {} }, { extra: {} }],
    });
    const element = renderedElement(0, assistant);
    const harness = buildHarness([assistant], [element]);
    harness.selectRenderedText(element.mesText, 'remove');
    await pressDelete(harness);
    await deleteSwipe(harness, assistant, 0, 0);
    assert.equal(harness.hooks().getDeletionHistory().length, 0);
    assert.equal(await harness.hooks().undoDeletionForMessage(element), false);
    assert.deepEqual(assistant.swipes, ['hello ']);
});

test('deleting an earlier swipe shifts assistant undo to the surviving target', async () => {
    const assistant = assistantMessage('hello remove', {
        swipe_id: 1, swipes: ['other', 'hello remove'], swipe_info: [{ extra: {} }, { extra: {} }],
    });
    const element = renderedElement(0, assistant);
    const harness = buildHarness([assistant], [element]);
    harness.selectRenderedText(element.mesText, 'remove');
    await pressDelete(harness);
    await deleteSwipe(harness, assistant, 0, 0);
    assert.equal(harness.hooks().getDeletionHistory()[0].swipeId, 0);
    await pressUndo(harness, element);
    assert.deepEqual(assistant.swipes, ['hello remove']);
    assert.equal(assistant.mes, 'hello remove');
});

test('linked undo is removed with its swipe and follows surviving swipes when indexes shift', async () => {
    for (const removedSwipe of [0, 1]) {
        const user = { is_user: true, mes: 'canonical', send_date: 'user-1' };
        const assistant = assistantMessage('reply', {
            swipe_id: 1, swipes: ['first', 'reply', 'last'],
            swipe_info: [
                { extra: { linked_user_text: 'first prompt' } },
                { extra: { linked_user_text: 'older linked' } },
                { extra: { linked_user_text: 'linked', linked_user_text_manual: true } },
            ], extra: { linked_user_text: 'older linked' },
        });
        const element = renderedElement(0, user, { isUser: true });
        const harness = buildHarness([user, assistant], [element, renderedElement(1, assistant)]);
        harness.selectRenderedText(element.mesText, 'older ');
        await pressDelete(harness);
        await deleteSwipe(harness, assistant, 1, removedSwipe);
        if (removedSwipe === 1) {
            assert.equal(harness.hooks().getDeletionHistory().length, 0);
            assert.equal(await harness.hooks().undoDeletionForMessage(element), false);
            assert.equal(assistant.swipe_info[1].extra.linked_user_text, 'linked');
        } else {
            assert.equal(harness.hooks().getDeletionHistory()[0].swipeId, 0);
            await pressUndo(harness, element);
            assert.equal(assistant.swipe_info[0].extra.linked_user_text, 'older linked');
            assert.equal(assistant.swipe_info[1].extra.linked_user_text, 'linked');
        }
        assert.equal(user.mes, 'canonical');
    }
});

test('a save that resolves without writing is detected by readback and rolled back', async () => {
    for (const kind of ['assistant', 'canonical', 'linked']) {
        const user = { is_user: true, mes: 'canonical remove', send_date: 'user-1' };
        const assistant = assistantMessage('reply remove', kind === 'linked' ? {
            swipes: ['reply remove', 'last'],
            swipe_info: [{ extra: { linked_user_text: 'linked remove' } }, { extra: {} }],
            extra: { linked_user_text: 'linked remove' },
        } : {});
        const userElement = renderedElement(0, user, { isUser: true });
        const assistantElement = renderedElement(1, assistant);
        const harness = buildHarness([user, assistant], [userElement, assistantElement]);
        const before = JSON.stringify(harness.context.chat);
        const element = kind === 'assistant' ? assistantElement : userElement;
        const htmlBefore = element.mesText.innerHTML;
        // Models the native API catching a network/disk error (or timing out).
        harness.context.saveChat = async () => { harness.calls.saveChat++; };
        harness.selectRenderedText(element.mesText, 'remove');
        await pressDelete(harness);
        assert.equal(JSON.stringify(harness.context.chat), before, kind);
        assert.equal(element.mesText.innerHTML, htmlBefore, kind);
        assert.equal(harness.context.chatMetadata.tainted, undefined, kind);
        assert.equal(harness.calls.reads.length, 1, kind);
        assert.equal(harness.calls.saveChat, 1, 'linked writes must not launch a second background save');
        assert.equal(harness.toasts.error.length, 1, kind);
        assert.equal(harness.hooks().getDeletionHistory().length, 0, kind);
        assert.equal(harness.hooks().getState().pendingEditedEntries.length, 0, kind);
    }
});

test('native character and group readback routes confirm persisted delete and undo', async () => {
    for (const groupId of [undefined, 'group-1']) {
        const assistant = assistantMessage('hello remove');
        const element = renderedElement(0, assistant);
        const harness = buildHarness([assistant], [element]);
        harness.context.groupId = groupId;
        harness.selectRenderedText(element.mesText, 'remove');
        await pressDelete(harness);
        assert.equal(harness.storage.chat[1].mes, 'hello ');
        assert.equal(harness.calls.reads[0].url, groupId ? '/api/chats/group/get' : '/api/chats/get');
        assert.deepEqual(JSON.parse(harness.calls.reads[0].body), groupId
            ? { id: 'test-chat' }
            : { ch_name: 'Bot', file_name: 'test-chat', avatar_url: 'bot.png' });
        assert.equal(harness.calls.reads[0].headers['X-CSRF-Token'], 'test');
        await pressUndo(harness, element);
        assert.equal(harness.storage.chat[1].mes, 'hello remove');
        assert.equal(harness.calls.reads.length, 2);
    }
});

test('failed readback or unavailable persistence restores locally and never records a successful delete', async () => {
    for (const failure of ['network', 'http', 'missing-file', 'missing-api']) {
        const assistant = assistantMessage('hello remove');
        const element = renderedElement(0, assistant);
        const harness = buildHarness([assistant], [element]);
        if (failure === 'network') harness.sandbox.fetch = async () => { throw new Error('offline'); };
        if (failure === 'http') harness.sandbox.fetch = async () => ({ ok: false, status: 500 });
        if (failure === 'missing-file') harness.sandbox.fetch = async () => ({ ok: true, json: async () => ({}) });
        if (failure === 'missing-api') delete harness.context.saveChat;
        harness.selectRenderedText(element.mesText, 'remove');
        await pressDelete(harness);
        assert.equal(assistant.mes, 'hello remove', failure);
        assert.equal(assistant.swipes[0], 'hello remove', failure);
        assert.equal(harness.hooks().getDeletionHistory().length, 0, failure);
        assert.equal(harness.toasts.error.length, 1, failure);
        assert.match(harness.toasts.error[0].text, /restored locally/);
    }
});

test('a swallowed undo save failure retains both the deletion and its undo entry', async () => {
    const assistant = assistantMessage('hello remove');
    const element = renderedElement(0, assistant);
    const harness = buildHarness([assistant], [element]);
    harness.selectRenderedText(element.mesText, 'remove');
    await pressDelete(harness);
    harness.context.saveChat = async () => {};
    await pressUndo(harness, element);
    assert.equal(assistant.mes, 'hello ');
    assert.equal(element.mesText.textContent, 'hello');
    assert.equal(harness.hooks().getDeletionHistory().length, 1);
    assert.equal(harness.toasts.error.length, 1);
});

test('render failure restores the canonical snapshot before any save', async () => {
    const user = { is_user: true, mes: 'keep this text', send_date: 'user-1' };
    const element = renderedElement(0, user, { isUser: true });
    const harness = buildHarness([user], [element]);
    const before = element.mesText.innerHTML;
    harness.context.updateMessageBlock = () => { throw new Error('render failed'); };
    harness.selectRenderedText(element.mesText, 'this ');
    await pressDelete(harness);
    assert.equal(user.mes, 'keep this text');
    assert.equal(element.mesText.innerHTML, before);
    assert.equal(harness.calls.saveChat, 0);
    assert.equal(harness.hooks().getState().pendingNormalUserText, null);
    assert.equal(harness.context.chatMetadata.tainted, undefined);
    assert.equal(harness.toasts.error.length, 1);
});

test('chat change during an awaited edit stops saving and cannot restore old session state into the new chat', async () => {
    const user = { is_user: true, mes: 'keep this text', send_date: 'user-1' };
    const assistant = assistantMessage('reply');
    const element = renderedElement(0, user, { isUser: true });
    const harness = buildHarness([user, assistant], [element, renderedElement(1, assistant)]);
    harness.eventSource.on(harness.eventTypes.MESSAGE_EDITED, async () => {
        harness.context.chat = [];
        harness.context.chatId = 'other-chat';
        await harness.eventSource.emit(harness.eventTypes.CHAT_CHANGED);
    });
    harness.selectRenderedText(element.mesText, 'this ');
    await pressDelete(harness);
    assert.equal(user.mes, 'keep this text');
    assert.equal(harness.calls.saveChat, 0);
    assert.equal(harness.calls.reads.length, 0);
    assert.equal(harness.hooks().getDeletionHistory().length, 0);
    assert.equal(harness.hooks().getState().pendingEditedEntries.length, 0);
    assert.equal(harness.hooks().getState().activeKey, null);
});

test('native lifecycle renders before saving and verifies only after save completion', async () => {
    const assistant = assistantMessage('hello remove');
    const element = renderedElement(0, assistant);
    const harness = buildHarness([assistant], [element]);
    const order = [];
    harness.eventSource.on(harness.eventTypes.MESSAGE_EDITED, () => {
        assert.equal(assistant.mes, 'hello ');
        assert.equal(assistant.swipes[0], 'hello ');
        order.push('edited');
    });
    harness.context.updateMessageBlock = () => {
        order.push('render');
        element.mesText.innerHTML = markdownFormatting(assistant.mes);
    };
    harness.eventSource.on(harness.eventTypes.MESSAGE_UPDATED, () => order.push('updated'));
    const save = harness.context.saveChat;
    harness.context.saveChat = async () => { order.push('save'); await save(); order.push('saved'); };
    const read = harness.sandbox.fetch;
    harness.sandbox.fetch = async (...args) => { order.push('verify'); return read(...args); };
    harness.selectRenderedText(element.mesText, 'remove');
    await pressDelete(harness);
    assert.deepEqual(order, ['edited', 'render', 'updated', 'save', 'saved', 'verify']);
});
