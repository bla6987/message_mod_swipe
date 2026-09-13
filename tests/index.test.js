const assert = require('node:assert/strict');
const test = require('node:test');

const { createHarness, createMessageElement } = require('./harness');

test('a pending pencil edit remains displayed for its selected swipe', async () => {
    const chat = [
        { is_user: true, mes: 'original', send_date: 'user-1' },
        {
            is_user: false,
            mes: 'reply B',
            send_date: 'assistant-1',
            swipe_id: 1,
            swipes: ['reply A', 'reply B'],
            swipe_info: [
                { extra: { linked_user_text: 'older text' } },
                { extra: { linked_user_text: 'original' } },
            ],
            extra: { linked_user_text: 'original' },
        },
    ];
    const userElement = createMessageElement(0, { isUser: true, text: 'original' });
    const assistantElement = createMessageElement(1, { text: 'reply B' });
    const harness = createHarness(chat, [userElement, assistantElement]);
    harness.runTimers();

    chat[0].mes = 'pencil edit';
    userElement.mesText.innerHTML = 'pencil edit';
    await harness.eventSource.emit(harness.eventTypes.MESSAGE_EDITED, 0);
    await harness.eventSource.emit(harness.eventTypes.MESSAGE_UPDATED, 0);
    harness.runTimers();

    assert.equal(userElement.mesText.textContent, 'pencil edit');
    assert.equal(userElement.hasAttribute('data-swipe-linked'), false);
});

test('reload keeps canonical text visible for a latest automatic link', () => {
    const chat = [
        { is_user: true, mes: 'pencil edit', send_date: 'user-1' },
        {
            is_user: false,
            mes: 'reply B',
            send_date: 'assistant-1',
            swipe_id: 1,
            swipes: ['reply A', 'reply B'],
            swipe_info: [
                { extra: { linked_user_text: 'older text' } },
                { extra: { linked_user_text: 'pre-edit text' } },
            ],
            extra: { linked_user_text: 'pre-edit text' },
        },
    ];
    const userElement = createMessageElement(0, { isUser: true, text: 'pencil edit' });
    const assistantElement = createMessageElement(1, { text: 'reply B' });
    const harness = createHarness(chat, [userElement, assistantElement]);
    harness.runTimers();

    assert.equal(userElement.mesText.textContent, 'pencil edit');
    assert.equal(userElement.hasAttribute('data-swipe-linked'), false);
});

test('latest manual override remains authoritative in the UI', () => {
    const chat = [
        { is_user: true, mes: 'canonical', send_date: 'user-1' },
        {
            is_user: false,
            mes: 'reply',
            send_date: 'assistant-1',
            swipe_id: 0,
            swipes: ['reply'],
            swipe_info: [{
                extra: {
                    linked_user_text: 'manual override',
                    linked_user_text_manual: true,
                },
            }],
            extra: {
                linked_user_text: 'manual override',
                linked_user_text_manual: true,
            },
        },
    ];
    const userElement = createMessageElement(0, { isUser: true, text: 'canonical' });
    const assistantElement = createMessageElement(1, { text: 'reply' });
    const harness = createHarness(chat, [userElement, assistantElement]);
    harness.runTimers();

    assert.equal(userElement.mesText.textContent, 'manual override');
    assert.equal(userElement.getAttribute('data-swipe-linked'), '1');
});

test('normal prompt assembly honors a pending edit on a non-latest swipe', async () => {
    const assistant = {
        is_user: false,
        mes: 'reply A',
        send_date: 'assistant-1',
        swipe_id: 0,
        swipes: ['reply A', 'reply B'],
        swipe_info: [
            { extra: { linked_user_text: 'original' } },
            { extra: { linked_user_text: 'other text' } },
        ],
        extra: { linked_user_text: 'original' },
    };
    const chat = [
        { is_user: true, mes: 'original', send_date: 'user-1' },
        assistant,
    ];
    const harness = createHarness(chat);
    harness.runTimers();

    chat[0].mes = 'pencil edit';
    await harness.eventSource.emit(harness.eventTypes.MESSAGE_EDITED, 0);
    chat.push({ is_user: true, mes: 'follow-up', send_date: 'user-2' });
    await harness.eventSource.emit(harness.eventTypes.MESSAGE_SENT, 2);
    await harness.eventSource.emit(harness.eventTypes.GENERATION_STARTED, 'normal', {}, false);
    await harness.eventSource.emit(harness.eventTypes.GENERATION_AFTER_COMMANDS, 'normal', {}, false);

    const coreChat = [
        { ...chat[0], index: 0 },
        { ...assistant, index: 1 },
        { ...chat[2], index: 2 },
    ];
    await harness.sandbox.swipeLinkedUserEditInterceptor(coreChat, 4096, () => {}, 'normal');

    assert.equal(coreChat[0].mes, 'pencil edit');
    const pendingEdit = harness.sandbox.__swipeLinkedUserEditTestHooks.getState().pendingEditedEntry;
    assert.equal(pendingEdit.key, '1:0');
    assert.equal(pendingEdit.text, 'pencil edit');

    chat.push({
        is_user: false,
        mes: 'new reply',
        send_date: 'assistant-2',
        swipe_id: 0,
        swipes: ['new reply'],
        swipe_info: [{ extra: {} }],
        extra: {},
    });
    await harness.eventSource.emit(harness.eventTypes.MESSAGE_RECEIVED, 3, 'normal');
    await harness.eventSource.emit(harness.eventTypes.GENERATION_ENDED);
    assert.equal(harness.sandbox.__swipeLinkedUserEditTestHooks.getState().pendingEditedEntry, null);
});

test('reload regenerate uses canonical text instead of a stale latest automatic link', async () => {
    const assistant = {
        is_user: false,
        mes: 'reply B',
        send_date: 'assistant-1',
        swipe_id: 1,
        swipes: ['reply A', 'reply B'],
        swipe_info: [
            { extra: { linked_user_text: 'older text' } },
            { extra: { linked_user_text: 'pre-reload text' } },
        ],
        extra: { linked_user_text: 'pre-reload text' },
    };
    const chat = [
        { is_user: true, mes: 'canonical edit after response', send_date: 'user-1' },
        assistant,
    ];
    const harness = createHarness(chat);
    harness.runTimers();

    await harness.eventSource.emit(harness.eventTypes.GENERATION_STARTED, 'regenerate', {}, false);
    await harness.eventSource.emit(harness.eventTypes.GENERATION_AFTER_COMMANDS, 'regenerate', {}, false);

    const coreChat = [{ ...chat[0], index: 0 }];
    await harness.sandbox.swipeLinkedUserEditInterceptor(coreChat, 4096, () => {}, 'regenerate');

    assert.equal(coreChat[0].mes, 'canonical edit after response');
    assert.equal(
        harness.sandbox.__swipeLinkedUserEditTestHooks.getState().generationContext.sourceUserText,
        'canonical edit after response',
    );
});

test('multiple historical pencil edits are all applied to one normal prompt', async () => {
    const firstAssistant = {
        is_user: false,
        mes: 'first reply A',
        send_date: 'assistant-1',
        swipe_id: 0,
        swipes: ['first reply A', 'first reply B'],
        swipe_info: [
            { extra: { linked_user_text: 'first original' } },
            { extra: { linked_user_text: 'first other' } },
        ],
        extra: { linked_user_text: 'first original' },
    };
    const secondAssistant = {
        is_user: false,
        mes: 'second reply A',
        send_date: 'assistant-2',
        swipe_id: 0,
        swipes: ['second reply A', 'second reply B'],
        swipe_info: [
            { extra: { linked_user_text: 'second original' } },
            { extra: { linked_user_text: 'second other' } },
        ],
        extra: { linked_user_text: 'second original' },
    };
    const chat = [
        { is_user: true, mes: 'first original', send_date: 'user-1' },
        firstAssistant,
        { is_user: true, mes: 'second original', send_date: 'user-2' },
        secondAssistant,
    ];
    const harness = createHarness(chat);
    harness.runTimers();

    chat[0].mes = 'first pencil edit';
    await harness.eventSource.emit(harness.eventTypes.MESSAGE_EDITED, 0);
    chat[2].mes = 'second pencil edit';
    await harness.eventSource.emit(harness.eventTypes.MESSAGE_EDITED, 2);

    chat.push({ is_user: true, mes: 'follow-up', send_date: 'user-3' });
    await harness.eventSource.emit(harness.eventTypes.MESSAGE_SENT, 4);
    await harness.eventSource.emit(harness.eventTypes.GENERATION_STARTED, 'normal', {}, false);
    await harness.eventSource.emit(harness.eventTypes.GENERATION_AFTER_COMMANDS, 'normal', {}, false);

    const coreChat = chat.map((message, index) => ({ ...message, index }));
    await harness.sandbox.swipeLinkedUserEditInterceptor(coreChat, 4096, () => {}, 'normal');

    assert.equal(coreChat[0].mes, 'first pencil edit');
    assert.equal(coreChat[2].mes, 'second pencil edit');
    assert.equal(
        harness.sandbox.__swipeLinkedUserEditTestHooks.getState().pendingEditedEntries.map((entry) => entry.key).join(','),
        '1:0,3:0',
    );
});

test('pending historical edit survives an intermediary tool response and recursive generation', async () => {
    const sourceAssistant = {
        is_user: false,
        mes: 'old reply A',
        send_date: 'assistant-1',
        swipe_id: 0,
        swipes: ['old reply A', 'old reply B'],
        swipe_info: [
            { extra: { linked_user_text: 'original' } },
            { extra: { linked_user_text: 'other' } },
        ],
        extra: { linked_user_text: 'original' },
    };
    const chat = [
        { is_user: true, mes: 'original', send_date: 'user-1' },
        sourceAssistant,
    ];
    const harness = createHarness(chat);
    harness.runTimers();

    chat[0].mes = 'pencil edit';
    await harness.eventSource.emit(harness.eventTypes.MESSAGE_EDITED, 0);
    chat.push({ is_user: true, mes: 'follow-up', send_date: 'user-2' });
    await harness.eventSource.emit(harness.eventTypes.MESSAGE_SENT, 2);
    await harness.eventSource.emit(harness.eventTypes.GENERATION_STARTED, 'normal', {}, false);
    await harness.eventSource.emit(harness.eventTypes.GENERATION_AFTER_COMMANDS, 'normal', {}, false);

    const firstCoreChat = chat.map((message, index) => ({ ...message, index }));
    await harness.sandbox.swipeLinkedUserEditInterceptor(firstCoreChat, 4096, () => {}, 'normal');
    assert.equal(firstCoreChat[0].mes, 'pencil edit');

    chat.push({
        is_user: false,
        mes: 'I will call a tool.',
        send_date: 'assistant-tool',
        swipe_id: 0,
        swipes: ['I will call a tool.'],
        swipe_info: [{ extra: {} }],
        extra: { tool_invocations: [{ id: 'tool-1' }] },
    });
    await harness.eventSource.emit(harness.eventTypes.MESSAGE_RECEIVED, 3, 'normal');
    assert.equal(
        harness.sandbox.__swipeLinkedUserEditTestHooks.getState().pendingEditedEntry.text,
        'pencil edit',
    );

    await harness.eventSource.emit(harness.eventTypes.GENERATION_STARTED, 'normal', {}, false);
    await harness.eventSource.emit(harness.eventTypes.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
    const recursiveCoreChat = chat.map((message, index) => ({ ...message, index }));
    await harness.sandbox.swipeLinkedUserEditInterceptor(recursiveCoreChat, 4096, () => {}, 'normal');
    assert.equal(recursiveCoreChat[0].mes, 'pencil edit');

    chat.push({
        is_user: false,
        mes: 'Final answer.',
        send_date: 'assistant-final',
        swipe_id: 0,
        swipes: ['Final answer.'],
        swipe_info: [{ extra: {} }],
        extra: {},
    });
    await harness.eventSource.emit(harness.eventTypes.MESSAGE_RECEIVED, 4, 'normal');
    assert.equal(
        harness.sandbox.__swipeLinkedUserEditTestHooks.getState().pendingEditedEntry.text,
        'pencil edit',
    );
    await harness.eventSource.emit(harness.eventTypes.GENERATION_ENDED);
    assert.equal(harness.sandbox.__swipeLinkedUserEditTestHooks.getState().pendingEditedEntry, null);
});

test('post-command watchdog clears aborted state but preserves active generation UI', async () => {
    const abortedHarness = createHarness([]);
    abortedHarness.runTimers();
    await abortedHarness.eventSource.emit(abortedHarness.eventTypes.GENERATION_STARTED, 'normal', {}, false);
    await abortedHarness.eventSource.emit(abortedHarness.eventTypes.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
    abortedHarness.runTimers(30000);
    assert.equal(abortedHarness.sandbox.__swipeLinkedUserEditTestHooks.getState().isGenerating, false);
    assert.equal(abortedHarness.sandbox.__swipeLinkedUserEditTestHooks.getState().generationContext, null);

    const activeHarness = createHarness([]);
    activeHarness.runTimers();
    await activeHarness.eventSource.emit(activeHarness.eventTypes.GENERATION_STARTED, 'normal', {}, false);
    await activeHarness.eventSource.emit(activeHarness.eventTypes.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
    activeHarness.document.body.dataset.generating = 'true';
    activeHarness.runTimers(30000);
    assert.equal(activeHarness.sandbox.__swipeLinkedUserEditTestHooks.getState().isGenerating, true);
});

test('manual stop before a normal response does not consume the pending edit', async () => {
    const sourceAssistant = {
        is_user: false,
        mes: 'old reply',
        send_date: 'assistant-1',
        swipe_id: 0,
        swipes: ['old reply', 'alternate'],
        swipe_info: [
            { extra: { linked_user_text: 'original' } },
            { extra: { linked_user_text: 'alternate text' } },
        ],
        extra: { linked_user_text: 'original' },
    };
    const chat = [
        { is_user: true, mes: 'original', send_date: 'user-1' },
        sourceAssistant,
    ];
    const harness = createHarness(chat);
    harness.runTimers();

    chat[0].mes = 'pencil edit';
    await harness.eventSource.emit(harness.eventTypes.MESSAGE_EDITED, 0);
    chat.push({ is_user: true, mes: 'follow-up', send_date: 'user-2' });
    await harness.eventSource.emit(harness.eventTypes.MESSAGE_SENT, 2);
    await harness.eventSource.emit(harness.eventTypes.GENERATION_STARTED, 'normal', {}, false);
    await harness.eventSource.emit(harness.eventTypes.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
    const stoppedNormalCoreChat = chat.map((message, index) => ({ ...message, index }));
    await harness.sandbox.swipeLinkedUserEditInterceptor(stoppedNormalCoreChat, 4096, () => {}, 'normal');

    const placeholder = {
        is_user: false,
        mes: '...',
        send_date: 'assistant-2',
        swipe_id: 0,
        swipes: ['...'],
        swipe_info: [{ extra: {} }],
        extra: {},
    };
    chat.push(placeholder);
    harness.context.streamingProcessor = {
        result: '',
        timeToFirstToken: null,
        isFinished: true,
        isStopped: false,
        abortController: { signal: { aborted: true } },
    };
    await harness.eventSource.emit(harness.eventTypes.GENERATION_ENDED);
    await harness.eventSource.emit(harness.eventTypes.GENERATION_STOPPED);
    await harness.eventSource.emit(harness.eventTypes.MESSAGE_RECEIVED, 3, 'normal');

    const state = harness.sandbox.__swipeLinkedUserEditTestHooks.getState();
    assert.equal(state.generationWasStopped, true);
    assert.equal(state.pendingEditedEntry.text, 'pencil edit');
    assert.equal(placeholder.swipe_info[0].extra.linked_user_text, undefined);
});

test('zero-token stopped continuation does not rewrite provenance', async () => {
    const assistant = {
        is_user: false,
        mes: 'existing reply',
        send_date: 'assistant-1',
        swipe_id: 0,
        swipes: ['existing reply'],
        swipe_info: [{ extra: { linked_user_text: 'original' } }],
        extra: { linked_user_text: 'original' },
    };
    const chat = [
        { is_user: true, mes: 'original', send_date: 'user-1' },
        assistant,
    ];
    const harness = createHarness(chat);
    harness.runTimers();

    chat[0].mes = 'pencil edit';
    await harness.eventSource.emit(harness.eventTypes.MESSAGE_EDITED, 0);
    await harness.eventSource.emit(harness.eventTypes.GENERATION_STARTED, 'continue', {}, false);
    await harness.eventSource.emit(harness.eventTypes.GENERATION_AFTER_COMMANDS, 'continue', {}, false);
    const stoppedContinueCoreChat = chat.map((message, index) => ({ ...message, index }));
    await harness.sandbox.swipeLinkedUserEditInterceptor(stoppedContinueCoreChat, 4096, () => {}, 'continue');
    harness.context.streamingProcessor = {
        result: '',
        timeToFirstToken: null,
        isFinished: true,
        isStopped: false,
        abortController: { signal: { aborted: true } },
    };
    await harness.eventSource.emit(harness.eventTypes.GENERATION_ENDED);
    await harness.eventSource.emit(harness.eventTypes.GENERATION_STOPPED);
    await harness.eventSource.emit(harness.eventTypes.MESSAGE_RECEIVED, 1, 'continue');

    const state = harness.sandbox.__swipeLinkedUserEditTestHooks.getState();
    assert.equal(state.pendingEditedEntry.text, 'pencil edit');
    assert.equal(assistant.swipe_info[0].extra.linked_user_text, 'original');
});

test('stopped continuation with partial output still records provenance', async () => {
    const assistant = {
        is_user: false,
        mes: 'existing reply plus partial output',
        send_date: 'assistant-1',
        swipe_id: 0,
        swipes: ['existing reply plus partial output'],
        swipe_info: [{ extra: { linked_user_text: 'original' } }],
        extra: { linked_user_text: 'original' },
    };
    const chat = [
        { is_user: true, mes: 'original', send_date: 'user-1' },
        assistant,
    ];
    const harness = createHarness(chat);
    harness.runTimers();

    chat[0].mes = 'pencil edit';
    await harness.eventSource.emit(harness.eventTypes.MESSAGE_EDITED, 0);
    await harness.eventSource.emit(harness.eventTypes.GENERATION_STARTED, 'continue', {}, false);
    await harness.eventSource.emit(harness.eventTypes.GENERATION_AFTER_COMMANDS, 'continue', {}, false);
    const partialContinueCoreChat = chat.map((message, index) => ({ ...message, index }));
    await harness.sandbox.swipeLinkedUserEditInterceptor(partialContinueCoreChat, 4096, () => {}, 'continue');
    harness.context.streamingProcessor = {
        result: ' plus partial output',
        timeToFirstToken: 25,
        isFinished: true,
        isStopped: false,
        abortController: { signal: { aborted: true } },
    };
    await harness.eventSource.emit(harness.eventTypes.GENERATION_ENDED);
    await harness.eventSource.emit(harness.eventTypes.GENERATION_STOPPED);
    await harness.eventSource.emit(harness.eventTypes.MESSAGE_RECEIVED, 1, 'continue');

    const state = harness.sandbox.__swipeLinkedUserEditTestHooks.getState();
    assert.equal(state.pendingEditedEntry, null);
    assert.equal(state.generationWasStopped, false);
    assert.equal(assistant.swipe_info[0].extra.linked_user_text, 'pencil edit');
});

test('pre-token streaming error placeholder is not treated as a response', async () => {
    const chat = [
        { is_user: true, mes: 'user text', send_date: 'user-1' },
    ];
    const harness = createHarness(chat);
    harness.runTimers();
    await harness.eventSource.emit(harness.eventTypes.MESSAGE_SENT, 0);
    await harness.eventSource.emit(harness.eventTypes.GENERATION_STARTED, 'normal', {}, false);
    await harness.eventSource.emit(harness.eventTypes.GENERATION_AFTER_COMMANDS, 'normal', {}, false);

    const placeholder = {
        is_user: false,
        mes: '...',
        send_date: 'assistant-1',
        swipe_id: 0,
        swipes: ['...'],
        swipe_info: [{ extra: {} }],
        extra: {},
    };
    chat.push(placeholder);
    harness.context.streamingProcessor = {
        result: '',
        timeToFirstToken: null,
        isFinished: false,
        isStopped: true,
        abortController: { signal: { aborted: true } },
    };
    await harness.eventSource.emit(harness.eventTypes.GENERATION_ENDED);
    await harness.eventSource.emit(harness.eventTypes.MESSAGE_RECEIVED, 1, 'normal');

    assert.equal(placeholder.swipe_info[0].extra.linked_user_text, undefined);
    assert.equal(harness.sandbox.__swipeLinkedUserEditTestHooks.getState().pendingGenerationType, 'normal');
});

test('older messages loaded later receive the linked-edits button', async () => {
    const chat = [
        { is_user: true, mes: 'user', send_date: 'user-1' },
        {
            is_user: false,
            mes: 'reply',
            send_date: 'assistant-1',
            swipe_id: 0,
            swipes: ['reply', 'alternate'],
            swipe_info: [{ extra: {} }, { extra: {} }],
            extra: {},
        },
    ];
    const userElement = createMessageElement(0, { isUser: true, text: 'user' });
    const harness = createHarness(chat, [userElement]);
    harness.runTimers();
    assert.equal(harness.eventSource.listenerCount(harness.eventTypes.MORE_MESSAGES_LOADED), 1);

    const olderAssistant = createMessageElement(1, { text: 'reply' });
    harness.messageElements.push(olderAssistant);
    await harness.eventSource.emit(harness.eventTypes.MORE_MESSAGES_LOADED);

    const button = olderAssistant.extraButtons.querySelector('.swipe_edits_view_button');
    assert.ok(button);
    assert.match(button.className, /fa-clock-rotate-left/);
});
