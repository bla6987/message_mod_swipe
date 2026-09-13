// Shared Node test harness: loads index.js in a vm sandbox with a fake
// SillyTavern context and a small fake DOM (elements, text nodes, selection).
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const extensionPath = path.join(__dirname, '..', 'index.js');

const ENTITY_MAP = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': '\'' };

function decodeEntities(text) {
    return text.replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENTITY_MAP[m] ?? m);
}

function escapeHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

class FakeTextNode {
    constructor(text) {
        this.nodeType = 3;
        this._text = String(text);
        this.parentElement = null;
        this.parentNode = null;
        this.isConnected = true;
        this.childNodes = [];
    }

    get textContent() { return this._text; }
    set textContent(value) { this._text = String(value); }
    get data() { return this._text; }
    get nodeValue() { return this._text; }
    get length() { return this._text.length; }
}

const SELECTOR_PART = /^(?:([a-zA-Z][\w-]*))?(#[\w-]+)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/;

function matchesSimpleSelector(element, selector) {
    const parts = String(selector).split(',').map((s) => s.trim()).filter(Boolean);
    for (const part of parts) {
        // Descendant selectors are not supported by matches(); only the last compound is checked.
        const compound = part.split(/\s+/).pop();
        const m = SELECTOR_PART.exec(compound);
        if (!m) continue;
        const [, tag, id, classes, attrs] = m;
        if (tag && element.tagName !== tag.toUpperCase()) continue;
        if (id && element.id !== id.slice(1)) continue;
        let ok = true;
        if (classes) {
            const list = element.className.split(/\s+/).filter(Boolean);
            for (const cls of classes.split('.').filter(Boolean)) {
                if (!list.includes(cls)) { ok = false; break; }
            }
        }
        if (ok && attrs) {
            for (const attr of attrs.match(/\[[^\]]+\]/g) ?? []) {
                const inner = attr.slice(1, -1);
                const eq = inner.indexOf('=');
                if (eq === -1) {
                    if (!element.hasAttribute(inner)) { ok = false; break; }
                } else {
                    const name = inner.slice(0, eq);
                    const value = inner.slice(eq + 1).replace(/^"|"$/g, '');
                    if (element.getAttribute(name) !== value) { ok = false; break; }
                }
            }
        }
        if (ok) return true;
    }
    return false;
}

class FakeElement {
    constructor(tagName = 'div') {
        this.tagName = tagName.toUpperCase();
        this.nodeType = 1;
        this.attributes = new Map();
        this.children = [];
        this.className = '';
        this.dataset = {};
        this.isConnected = true;
        this.parentElement = null;
        this.parentNode = null;
        this.style = {};
        this.offsetWidth = 0;
        this.offsetHeight = 0;
        this.isContentEditable = false;
        this.listeners = new Map();
        this._innerHTML = '';
    }

    get childNodes() { return this.children; }

    get classList() {
        const self = this;
        return {
            contains: (cls) => self.className.split(/\s+/).includes(cls),
            add: (cls) => { if (!self.classList.contains(cls)) self.className = `${self.className} ${cls}`.trim(); },
            remove: (cls) => { self.className = self.className.split(/\s+/).filter((c) => c && c !== cls).join(' '); },
        };
    }

    get innerHTML() {
        return this._innerHTML;
    }

    set innerHTML(value) {
        this._innerHTML = String(value);
        this.children = [];
        parseHtmlInto(this, this._innerHTML);
    }

    get textContent() {
        let out = '';
        const stack = [...this.children].reverse();
        const seen = new Set();
        while (stack.length) {
            const node = stack.pop();
            if (!node || seen.has(node)) continue;
            seen.add(node);
            if (node.nodeType === 3) out += node.textContent;
            else if (node.children) for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
        }
        return out;
    }

    set textContent(value) {
        this._innerHTML = escapeHtml(value);
        this.children = [];
        if (String(value) !== '') this.appendChild(new FakeTextNode(value));
    }

    getAttribute(name) {
        return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    setAttribute(name, value) {
        this.attributes.set(name, String(value));
    }

    hasAttribute(name) {
        return this.attributes.has(name);
    }

    removeAttribute(name) {
        this.attributes.delete(name);
    }

    appendChild(child) {
        child.parentElement = this;
        child.parentNode = this;
        child.isConnected = this.isConnected;
        this.children.push(child);
        return child;
    }

    insertBefore(child, reference) {
        const idx = this.children.indexOf(reference);
        child.parentElement = this;
        child.parentNode = this;
        child.isConnected = this.isConnected;
        if (idx === -1) this.children.push(child);
        else this.children.splice(idx, 0, child);
        return child;
    }

    replaceChildren(...children) {
        this.children = [];
        for (const child of children) this.appendChild(child);
    }

    remove() {
        this.isConnected = false;
        if (this.parentElement) {
            this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
        }
        this.parentElement = null;
        this.parentNode = null;
    }

    contains(node) {
        const stack = [this];
        const seen = new Set();
        while (stack.length) {
            const current = stack.pop();
            if (current === node) return true;
            if (!current || seen.has(current)) continue;
            seen.add(current);
            for (const child of current.children ?? []) stack.push(child);
        }
        return false;
    }

    matches(selector) {
        return matchesSimpleSelector(this, selector);
    }

    closest(selector) {
        let el = this;
        let guard = 0;
        while (el && guard++ < 1000) {
            if (el.nodeType === 1 && el.matches(selector)) return el;
            el = el.parentElement;
        }
        return null;
    }

    getBoundingClientRect() {
        return { left: 10, top: 20, right: 60, bottom: 40, width: 50, height: 20 };
    }

    addEventListener(name, handler) {
        const handlers = this.listeners.get(name) ?? [];
        handlers.push(handler);
        this.listeners.set(name, handlers);
    }

    removeEventListener(name, handler) {
        const handlers = this.listeners.get(name) ?? [];
        this.listeners.set(name, handlers.filter((candidate) => candidate !== handler));
    }

    dispatch(name, event = {}) {
        return (this.listeners.get(name) ?? []).map((handler) => handler(event));
    }

    focus() {}

    descendants() {
        const out = [];
        const stack = [...this.children].reverse();
        const seen = new Set();
        while (stack.length) {
            const node = stack.pop();
            if (!node || seen.has(node)) continue;
            seen.add(node);
            if (node.nodeType === 1) {
                out.push(node);
                for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
            }
        }
        return out;
    }

    querySelector(selector) {
        // Legacy shortcuts kept for older tests that attach these as properties.
        if (selector === '.mes_text' && this.mesText) return this.mesText;
        if (selector === '.extraMesButtons' && this.extraButtons) return this.extraButtons;
        return this.descendants().find((el) => el.matches(selector)) ?? null;
    }

    querySelectorAll(selector) {
        return this.descendants().filter((el) => el.matches(selector));
    }
}

function parseHtmlInto(root, html) {
    const tokenRe = /<\/?([a-zA-Z][\w-]*)([^>]*)>|([^<]+)/g;
    const stack = [root];
    const voidTags = new Set(['BR', 'IMG', 'HR', 'INPUT']);
    let m;
    while ((m = tokenRe.exec(html)) !== null) {
        const parent = stack[stack.length - 1];
        if (m[3] != null) {
            parent.appendChild(new FakeTextNode(decodeEntities(m[3])));
            continue;
        }
        const raw = m[0];
        const tag = m[1];
        if (raw.startsWith('</')) {
            if (stack.length > 1) stack.pop();
            continue;
        }
        const el = new FakeElement(tag);
        const attrRe = /([\w-]+)(?:="([^"]*)")?/g;
        let a;
        while ((a = attrRe.exec(m[2] ?? '')) !== null) {
            if (a[1] === 'class') el.className = a[2] ?? '';
            else if (a[1] === 'id') el.id = a[2] ?? '';
            else el.setAttribute(a[1], a[2] ?? '');
        }
        parent.appendChild(el);
        if (!voidTags.has(el.tagName) && !raw.endsWith('/>')) stack.push(el);
    }
}

class FakeEventSource {
    constructor() {
        this.listeners = new Map();
        this.emitted = [];
    }

    on(name, handler) {
        const handlers = this.listeners.get(name) ?? [];
        handlers.push(handler);
        this.listeners.set(name, handlers);
    }

    removeListener(name, handler) {
        const handlers = this.listeners.get(name) ?? [];
        this.listeners.set(name, handlers.filter((candidate) => candidate !== handler));
    }

    async emit(name, ...args) {
        this.emitted.push({ name, args });
        for (const handler of this.listeners.get(name) ?? []) {
            await handler(...args);
        }
    }

    listenerCount(name) {
        return (this.listeners.get(name) ?? []).length;
    }
}

/**
 * Deterministic stand-in for SillyTavern's messageFormatting used by the
 * selection-deletion tests: a tiny Markdown subset plus `{{macro}}` → `MACRO`
 * to emulate content that the source text does not contain.
 */
function markdownFormatting(text) {
    if (typeof text !== 'string' || text === '') return '';
    const inline = (s) => s
        .replace(/\{\{[^}]+\}\}/g, 'MACRO')
        .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
        .replace(/~~([^~]+)~~/g, '<del>$1</del>')
        .replace(/!\[([^\]]*)\]\(([^)]*)\)/g, '<img alt="$1" src="$2">')
        .replace(/\[([^\]]+)\]\(([^)]*)\)/g, '<a href="$2">$1</a>');
    return text.trim().split(/\n{2,}/).map((p) => `<p>${inline(p).replace(/\n/g, '<br>\n')}</p>`).join('\n');
}

function createMessageElement(messageId, { isUser = false, isSystem = false, text = '', html = null } = {}) {
    const element = new FakeElement();
    element.className = 'mes';
    element.setAttribute('mesid', messageId);
    element.setAttribute('is_user', String(isUser));
    element.setAttribute('is_system', String(isSystem));
    const mesBlock = new FakeElement();
    mesBlock.className = 'mes_block';
    element.appendChild(mesBlock);
    const mesButtons = new FakeElement();
    mesButtons.className = 'mes_buttons';
    mesBlock.appendChild(mesButtons);
    element.extraButtons = new FakeElement();
    element.extraButtons.className = 'extraMesButtons';
    mesButtons.appendChild(element.extraButtons);
    const editButton = new FakeElement();
    editButton.className = 'mes_button mes_edit fa-solid fa-pencil';
    mesButtons.appendChild(editButton);
    element.mesButtons = mesButtons;
    element.mesText = new FakeElement();
    element.mesText.className = 'mes_text';
    mesBlock.appendChild(element.mesText);
    if (html != null) {
        element.mesText.innerHTML = html;
    } else {
        element.mesText.textContent = text;
        element.mesText.innerHTML = text;
    }
    return element;
}

function collectTextNodes(el) {
    const out = [];
    const stack = [...el.children].reverse();
    while (stack.length) {
        const node = stack.pop();
        if (node.nodeType === 3) out.push(node);
        else for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
    }
    return out;
}

function createHarness(chat, messageElements = [], options = {}) {
    const eventSource = new FakeEventSource();
    const eventTypes = {
        CHAT_CHANGED: 'chat_changed',
        GENERATION_AFTER_COMMANDS: 'generation_after_commands',
        GENERATION_STARTED: 'generation_started',
        MESSAGE_RECEIVED: 'message_received',
        MESSAGE_UPDATED: 'message_updated',
        MESSAGE_EDITED: 'message_edited',
        CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
        GENERATION_ENDED: 'generation_ended',
        GENERATION_STOPPED: 'generation_stopped',
        MESSAGE_SENT: 'message_sent',
        MESSAGE_SWIPED: 'message_swiped',
        MESSAGE_DELETED: 'message_deleted',
        MESSAGE_SWIPE_DELETED: 'message_swipe_deleted',
        MORE_MESSAGES_LOADED: 'more_messages_loaded',
    };
    const timers = new Map();
    let nextTimerId = 1;
    const calls = { saveChat: 0, removeAllRanges: 0, reads: [] };
    const storage = { chat: JSON.parse(JSON.stringify([{ chat_metadata: {} }, ...chat])) };
    const toasts = { warning: [], error: [], info: [] };

    const chatElement = new FakeElement();
    chatElement.id = 'chat';
    chatElement.children = messageElements;
    for (const element of messageElements) {
        element.parentElement = chatElement;
        element.parentNode = chatElement;
    }
    const body = new FakeElement('body');
    const documentListeners = new Map();
    const selectionState = { range: null };
    const selection = {
        get rangeCount() { return selectionState.range ? 1 : 0; },
        get isCollapsed() { return !selectionState.range; },
        getRangeAt(index) {
            if (!selectionState.range || index !== 0) throw new Error('IndexSizeError');
            return selectionState.range;
        },
        toString() { return selectionState.range ? selectionState.range.toString() : ''; },
        removeAllRanges() {
            calls.removeAllRanges++;
            selectionState.range = null;
        },
    };

    const document = {
        readyState: 'complete',
        body,
        documentElement: body,
        activeElement: null,
        listeners: documentListeners,
        addEventListener(name, handler) {
            const handlers = documentListeners.get(name) ?? [];
            handlers.push(handler);
            documentListeners.set(name, handlers);
        },
        removeEventListener(name, handler) {
            const handlers = documentListeners.get(name) ?? [];
            documentListeners.set(name, handlers.filter((candidate) => candidate !== handler));
        },
        getSelection: () => selection,
        createElement: (tagName) => new FakeElement(tagName),
        getElementById: (id) => id === 'chat' ? chatElement : null,
        querySelector(selector) {
            const match = selector.match(/#chat \.mes(?:\[mesid|data-mesid|data-message-id)=\"([0-9]+)\"\]/);
            if (match) {
                return messageElements.find((element) => element.getAttribute('mesid') === match[1]) ?? null;
            }
            const idMatch = selector.match(/#chat \.mes#mes([0-9]+)/);
            if (idMatch) {
                return messageElements.find((element) => element.getAttribute('mesid') === idMatch[1]) ?? null;
            }
            return null;
        },
        querySelectorAll(selector) {
            if (selector === '#chat .mes') return messageElements;
            if (selector === '#chat .mes[is_user]') return messageElements.filter((element) => element.hasAttribute('is_user'));
            if (selector === '#chat .mes[data-swipe-linked="1"]') {
                return messageElements.filter((element) => element.getAttribute('data-swipe-linked') === '1');
            }
            const roots = [...messageElements, body];
            return roots.flatMap((root) => root.descendants()).filter((el) => el.matches(selector));
        },
    };
    const context = {
        chat,
        chatId: 'test-chat',
        characterId: 0,
        characters: [{ name: 'Bot', avatar: 'bot.png', chat: 'test-chat' }],
        getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'test' }),
        eventSource,
        event_types: eventTypes,
        eventTypes,
        extensionSettings: {},
        messageFormatting: options.messageFormatting ?? ((text) => text),
        saveChatDebounced() {},
        async saveChat() {
            calls.saveChat++;
            storage.chat = JSON.parse(JSON.stringify([{ chat_metadata: context.chatMetadata }, ...context.chat]));
        },
        streamingProcessor: null,
        name1: 'User',
        name2: 'Bot',
        chatMetadata: {},
        ...(options.context ?? {}),
    };
    const sandbox = {
        console,
        AbortSignal,
        fetch: async (url, init) => {
            calls.reads.push({ url, ...init });
            return { ok: true, json: async () => JSON.parse(JSON.stringify(storage.chat)) };
        },
        document,
        Element: FakeElement,
        HTMLElement: FakeElement,
        MutationObserver: class {
            observe() {}
            disconnect() {}
        },
        SillyTavern: { getContext: () => context },
        toastr: {
            warning: (text, title) => toasts.warning.push({ text, title }),
            error: (text, title) => toasts.error.push({ text, title }),
            info: (text, title) => toasts.info.push({ text, title }),
        },
        innerWidth: 1200,
        innerHeight: 800,
        requestAnimationFrame: (callback) => {
            callback();
            return 1;
        },
        requestIdleCallback: (callback) => callback({ timeRemaining: () => 50, didTimeout: false }),
        setTimeout(callback, delay = 0) {
            const id = nextTimerId++;
            timers.set(id, { callback, delay });
            return id;
        },
        clearTimeout(id) {
            timers.delete(id);
        },
    };
    sandbox.globalThis = sandbox;

    const hooks = `
        globalThis.__swipeLinkedUserEditTestHooks = {
            getState: () => ({
                activeKey,
                pendingEditedEntry: Array.from(pendingEditedEntries.values()).at(-1) ?? null,
                pendingEditedEntries: Array.from(pendingEditedEntries.values()),
                pendingNormalUserText,
                pendingEditKeysUsedForGeneration: Array.from(pendingEditKeysUsedForGeneration),
                isGenerating,
                generationContext,
                pendingGenerationType,
                generationWasStopped,
                deletionInFlight,
            }),
            computeDeletionSpan,
            collectTextLayout,
            resolveBoundaryOffset,
            alignRenderedToSource,
            adjustSpanForMarkdown,
            resolveDeletionTarget,
            processSelectionForDelete,
            executeSelectionDelete,
            undoDeletionForMessage,
            getDeletionHistory: () => deletionHistory,
            getDeleteMenu: () => deleteMenuEl,
            teardown,
        };
    `;
    const source = fs.readFileSync(extensionPath, 'utf8').replace(/\n\}\)\(\);\s*$/, `\n${hooks}\n})();`);
    const script = new vm.Script(source, {
        filename: extensionPath,
        importModuleDynamically: () => Promise.reject(new Error('Prompt helpers intentionally unavailable in unit tests')),
    });
    script.runInNewContext(sandbox);

    function runTimers(delay = null) {
        const matching = [...timers.entries()]
            .filter(([, timer]) => delay == null || timer.delay === delay)
            .sort(([left], [right]) => left - right);
        for (const [id, timer] of matching) {
            if (!timers.delete(id)) continue;
            timer.callback();
        }
    }

    function makeRange({ startContainer, startOffset, endContainer, endOffset, text, mesTextEl }) {
        const range = {
            startContainer,
            startOffset,
            endContainer,
            endOffset,
            collapsed: false,
            commonAncestorContainer: mesTextEl ?? startContainer,
            toString: () => text,
            cloneRange() { return { ...range }; },
            getBoundingClientRect: () => ({ left: 100, top: 200, right: 180, bottom: 220, width: 80, height: 20 }),
        };
        return range;
    }

    /** Select `text` (the n-th rendered occurrence) inside a .mes_text using text-node endpoints. */
    function selectRenderedText(mesTextEl, text, { occurrence = 0 } = {}) {
        const nodes = collectTextNodes(mesTextEl);
        const full = nodes.map((n) => n.textContent).join('');
        let from = 0;
        let index = -1;
        for (let i = 0; i <= occurrence; i++) {
            index = full.indexOf(text, from);
            if (index === -1) throw new Error(`text "${text}" occurrence ${occurrence} not found in "${full}"`);
            from = index + 1;
        }
        const locate = (offset, preferEnd) => {
            let acc = 0;
            for (const node of nodes) {
                const len = node.textContent.length;
                if (offset < acc + len || (preferEnd && offset === acc + len)) return { node, offset: offset - acc };
                acc += len;
            }
            const last = nodes[nodes.length - 1];
            return { node: last, offset: last.textContent.length };
        };
        const start = locate(index, false);
        const end = locate(index + text.length, true);
        selectionState.range = makeRange({
            startContainer: start.node,
            startOffset: start.offset,
            endContainer: end.node,
            endOffset: end.offset,
            text,
            mesTextEl,
        });
        return selectionState.range;
    }

    function setSelectionRange(rangeInit) {
        selectionState.range = makeRange(rangeInit);
        return selectionState.range;
    }

    function clearSelection() {
        selectionState.range = null;
    }

    function dispatchDocumentEvent(name, event = {}) {
        return (documentListeners.get(name) ?? []).map((handler) => handler(event));
    }

    return {
        calls,
        chatElement,
        clearSelection,
        context,
        dispatchDocumentEvent,
        document,
        eventSource,
        eventTypes,
        messageElements,
        runTimers,
        sandbox,
        storage,
        selectRenderedText,
        setSelectionRange,
        timers,
        toasts,
        hooks: () => sandbox.__swipeLinkedUserEditTestHooks,
    };
}

module.exports = {
    FakeElement,
    FakeEventSource,
    FakeTextNode,
    collectTextNodes,
    createHarness,
    createMessageElement,
    markdownFormatting,
};
