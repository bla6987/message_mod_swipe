(function () {
    'use strict';

    const EXTENSION_NAME = 'swipe_linked_user_edit';
    const INSTANCE_KEY = '__swipeLinkedUserEditInstance';

    if (typeof globalThis.swipeLinkedUserEditTeardown === 'function') {
        try {
            globalThis.swipeLinkedUserEditTeardown({ reason: 'reload' });
        } catch (e) {
            console.warn(`[${EXTENSION_NAME}] Failed to tear down previous instance`, e);
        }
    }

    const instanceToken = {};
    globalThis[INSTANCE_KEY] = instanceToken;

    // ─── State ────────────────────────────────────────────────────────────────────
    let activeKey = null;
    let pendingUserText = null;
    let observer = null;
    let isGenerating = false;
    let swipeDebounceTimer = null;
    let lastChatId = null;
    let hasMessageSwipedEvent = false; // True if MESSAGE_SWIPED event is available
    let generationKey = null; // Key captured at generation start for interceptor use
    let generationType = null; // Active generation type (normal/swipe/regenerate/continue/etc.)
    let didReceiveMessageForGeneration = false; // True once MESSAGE_RECEIVED arrives for current generation
    let pendingSwipeGenerationKey = null; // Previous swipe key captured before overswipe generation
    let pendingGenerationType = null; // Preserved across GENERATION_ENDED for late MESSAGE_RECEIVED
    let pendingNormalUserText = null; // Snapshot from MESSAGE_SENT used for normal-send mapping
    let pendingEditedEntry = null; // { key, text } bound to the swipe key where latest-user edit occurred
    let generationContext = null; // { type, sourceKey, sourceAssistantMesId, sourceUserText, capturedAt }
    let generationSeq = 0; // Guards delayed cleanup from previous generation lifecycles
    let swipeRenderSeq = 0; // Guards delayed swipe DOM updates from older events
    let editsButtonScanSeq = 0; // Guards chunked loaded-chat button scans
    const mesElCache = new Map(); // mesId -> Element cache for getMesElByIndex
    let lastMesElCache = { user: null, assistant: null }; // cached results for getLastMesEl
    let chatLookupCache = null; // O(1) mesid -> chat index cache for the active chat
    const eventSubscriptions = [];

    // ─── Helpers ──────────────────────────────────────────────────────────────────

    function isCurrentInstance() {
        return globalThis[INSTANCE_KEY] === instanceToken;
    }

    function getSettings() {
        const ctx = globalThis.SillyTavern?.getContext?.();
        if (!ctx) return { debug: false };
        if (!ctx.extensionSettings) ctx.extensionSettings = {};
        if (!ctx.extensionSettings[EXTENSION_NAME]) {
            ctx.extensionSettings[EXTENSION_NAME] = { debug: false };
        }
        return ctx.extensionSettings[EXTENSION_NAME];
    }

    function log(...args) {
        if (getSettings().debug) {
            console.log(`[${EXTENSION_NAME}]`, ...args);
        }
    }

    function setMapping(assistantMesId, swipeId, userText, { setActive = false, source = '', skipSave = false, confirm = false } = {}) {
        if (!Number.isFinite(assistantMesId) || !Number.isFinite(swipeId)) return null;
        if (typeof userText !== 'string') return null;

        const key = `${assistantMesId}:${swipeId}`;
        const assistantMsg = resolveAssistantMsg(assistantMesId);
        const wrote = assistantMsg ? setLinkedUserText(assistantMsg, swipeId, userText) : false;

        if (setActive) {
            activeKey = key;
        }

        if (source) {
            log(source, wrote ? 'stored linked text' : 'queued linked text', key, '->', userText.substring(0, 60));
        }

        if (confirm) confirmLinkedUserText(assistantMesId, swipeId, userText);
        if (wrote && !skipSave) requestChatSave();
        return key;
    }

    function parseMappingKey(key) {
        if (typeof key !== 'string') return null;
        const m = /^([0-9]+):([0-9]+)$/.exec(key);
        if (!m) return null;
        return { assistantMesId: Number(m[1]), swipeId: Number(m[2]) };
    }

    function resolveAssistantMsg(mesIdOrIdx) {
        const ctx = globalThis.SillyTavern?.getContext?.();
        const chat = ctx?.chat;
        if (!chat || mesIdOrIdx == null) return null;

        const chatIndex = findChatIndexByMesId(mesIdOrIdx);
        const msg = chatIndex != null ? chat[chatIndex] : null;
        return msg && !msg.is_user && !msg.is_system ? msg : null;
    }

    function getLinkedUserText(assistantMsg, swipeId = null) {
        if (!assistantMsg) return null;
        if (swipeId == null) {
            const activeText = assistantMsg.extra?.linked_user_text;
            return typeof activeText === 'string' ? activeText : null;
        }
        const swipeInfo = assistantMsg.swipe_info?.[swipeId];
        const linkedText = swipeInfo?.extra?.linked_user_text;
        if (typeof linkedText === 'string') return linkedText;
        if (swipeInfo) return null;

        const activeSwipeId = typeof assistantMsg.swipe_id === 'number' ? assistantMsg.swipe_id : 0;
        if (swipeId === activeSwipeId && typeof assistantMsg.extra?.linked_user_text === 'string') {
            return assistantMsg.extra.linked_user_text;
        }
        return null;
    }

    function setLinkedUserText(assistantMsg, swipeId, userText) {
        if (!assistantMsg || !Number.isFinite(swipeId) || typeof userText !== 'string') return false;

        let wrote = false;
        if (assistantMsg.swipe_info?.[swipeId]) {
            if (!assistantMsg.swipe_info[swipeId].extra || typeof assistantMsg.swipe_info[swipeId].extra !== 'object') {
                assistantMsg.swipe_info[swipeId].extra = {};
            }
            assistantMsg.swipe_info[swipeId].extra.linked_user_text = userText;
            wrote = true;
        }

        const activeSwipeId = typeof assistantMsg.swipe_id === 'number' ? assistantMsg.swipe_id : 0;
        if (swipeId === activeSwipeId) {
            if (!assistantMsg.extra || typeof assistantMsg.extra !== 'object') {
                assistantMsg.extra = {};
            }
            assistantMsg.extra.linked_user_text = userText;
            wrote = true;
        }

        return wrote;
    }

    function confirmLinkedUserText(assistantMesId, swipeId, userText) {
        const chatIdAtSchedule = lastChatId;
        const msgAtSchedule = resolveAssistantMsg(assistantMesId);
        const doConfirm = () => {
            if (lastChatId !== chatIdAtSchedule) return;
            const assistantMsg = resolveAssistantMsg(assistantMesId);
            if (!assistantMsg || assistantMsg !== msgAtSchedule) return;
            if (setLinkedUserText(assistantMsg, swipeId, userText)) {
                requestChatSave();
            }
        };

        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => setTimeout(doConfirm, 0));
        } else {
            setTimeout(doConfirm, 0);
        }
    }

    function hasLinkedUserText(assistantMsg, swipeId = null) {
        return typeof getLinkedUserText(assistantMsg, swipeId) === 'string';
    }

    function getLinkedTextByKey(key) {
        const parsed = parseMappingKey(key);
        if (!parsed) return null;
        return getLinkedUserText(resolveAssistantMsg(parsed.assistantMesId), parsed.swipeId);
    }

    function hasLinkedTextByKey(key) {
        return typeof getLinkedTextByKey(key) === 'string';
    }

    function requestChatSave() {
        const ctx = globalThis.SillyTavern?.getContext?.();
        try {
            if (typeof ctx?.saveChatDebounced === 'function') {
                ctx.saveChatDebounced();
            } else if (typeof ctx?.saveChat === 'function') {
                ctx.saveChat();
            }
        } catch (e) {
            console.warn(`[${EXTENSION_NAME}] Failed to request chat save`, e);
        }
    }

    function scheduleIdleTask(callback) {
        if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(callback, { timeout: 500 });
        } else {
            setTimeout(() => callback({ timeRemaining: () => 0, didTimeout: true }), 0);
        }
    }

    function adjustKeyAfterSwipeDelete(key, assistantMesId, deletedSwipeId) {
        const parsed = parseMappingKey(key);
        if (!parsed || parsed.assistantMesId !== assistantMesId) return key;
        if (parsed.swipeId === deletedSwipeId) return null;
        if (parsed.swipeId > deletedSwipeId) return `${assistantMesId}:${parsed.swipeId - 1}`;
        return key;
    }

    function extractSwipeText(entry) {
        if (typeof entry === 'string') return entry;
        if (entry == null) return null;
        if (typeof entry === 'object') {
            if (typeof entry.mes === 'string') return entry.mes;
            if (typeof entry.text === 'string') return entry.text;
            if (typeof entry.content === 'string') return entry.content;
        }
        return null;
    }

    function hasAssistantContent(msg) {
        if (!msg || msg.is_user || msg.is_system) return false;
        if (typeof msg.mes === 'string' && msg.mes.trim() !== '') return true;
        if (!Array.isArray(msg.swipes)) return false;
        return msg.swipes.some((swipe) => {
            const text = extractSwipeText(swipe);
            return typeof text === 'string' && text.trim() !== '';
        });
    }

    function formatUserMessageText(rawText, chatIndex) {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.messageFormatting === 'function') {
            const msg = ctx.chat?.[chatIndex];
            const userName = msg?.name || ctx.name1 || 'User';
            const mesId = getMesIdFromChatIndex(chatIndex);
            try {
                return ctx.messageFormatting(rawText, userName, msg?.is_system || false, true, mesId, {}, false);
            } catch (e) {
                console.warn(`[${EXTENSION_NAME}] messageFormatting error:`, e);
            }
        }
        // Fallback: escape HTML
        const div = document.createElement('div');
        div.textContent = rawText;
        return div.innerHTML;
    }

    function getUserDisplayText(msg) {
        if (!msg || !msg.is_user) return null;
        if (typeof msg.extra?.display_text === 'string') return msg.extra.display_text;
        if (typeof msg.mes === 'string') return msg.mes;
        return null;
    }

    function getUserMessageText(msg) {
        if (!msg || !msg.is_user || typeof msg.mes !== 'string') return null;
        return msg.mes;
    }

    function restoreUserBubbleFromChat(mesEl) {
        if (!mesEl) return;
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat;
        if (!chat) return;

        const mesIdRaw = mesEl.getAttribute('mesid') || mesEl.getAttribute('data-mesid') || mesEl.getAttribute('data-message-id');
        if (mesIdRaw == null) return;
        const mesId = Number(mesIdRaw);
        if (!Number.isFinite(mesId)) return;

        const chatIndex = findChatIndexByEventId(mesId);
        if (chatIndex == null) return;
        const msg = chat[chatIndex];
        if (!msg || !msg.is_user) return;

        const textEl = getMesTextEl(mesEl);
        if (!textEl) return;
        const rawText = getUserDisplayText(msg);
        if (typeof rawText !== 'string') return;

        textEl.innerHTML = formatUserMessageText(rawText, chatIndex);
    }

    function ensureMappingForAssistantMesId(assistantMesId, { setActive = true } = {}) {
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat;
        if (!chat) return null;

        const aiIdx = findChatIndexByMesId(assistantMesId);
        if (aiIdx == null) return null;
        const aiMsg = chat[aiIdx];
        if (!aiMsg || aiMsg.is_user || aiMsg.is_system) return null;

        const userIdx = getUserIndexBefore(aiIdx);
        if (userIdx == null) return null;

        // Backfill must not create persisted metadata. Only ground-truth
        // generation completion writes linked_user_text.
        const swipeId = resolveSwipeId(assistantMesId, aiMsg);
        const key = `${assistantMesId}:${swipeId}`;
        if (setActive) activeKey = key;
        return key;
    }

    globalThis.swipeLinkedUserEditDebug = function () {
        try {
            const ctx = globalThis.SillyTavern?.getContext?.();
            const chat = ctx?.chat;
            const aiIdx = chat ? getLastAssistantIndexFromChat() : null;
            const userIdx = aiIdx != null ? getUserIndexBefore(aiIdx) : null;
            const aiEl = aiIdx != null ? getMesElByIndex(getMesIdFromChatIndex(aiIdx)) : null;
            const userEl = userIdx != null ? getMesElByIndex(getMesIdFromChatIndex(userIdx)) : null;
            console.log(`[${EXTENSION_NAME}] debug`, {
                lastChatId,
                isGenerating,
                pendingUserText,
                pendingNormalUserText,
                pendingEditedEntry,
                generationContext,
                activeKey,
                linkedUserText: activeKey ? getLinkedTextByKey(activeKey) : null,
                aiIdx,
                userIdx,
                aiMsg: aiIdx != null && chat ? chat[aiIdx] : null,
                userMsg: userIdx != null && chat ? chat[userIdx] : null,
                domSwipeId: aiEl ? aiEl.getAttribute('swipeid') : null,
                aiEl,
                userEl,
            });
        } catch (e) {
            console.warn(`[${EXTENSION_NAME}] debug error`, e);
        }
    };

    // ─── DOM Selectors (resilient) ───────────────────────────────────────────────

    function invalidateChatLookupCache() {
        chatLookupCache = null;
    }

    function invalidateMesElCache() {
        mesElCache.clear();
        lastMesElCache.user = null;
        lastMesElCache.assistant = null;
        invalidateChatLookupCache();
    }

    function normalizeMessageDomId(v) {
        if (v == null) return null;
        if (typeof v === 'number') return v;
        if (typeof v === 'string') {
            const s = v.trim();
            if (s === '') return null;
            if (!Number.isNaN(Number(s)) && /^[0-9]+$/.test(s)) return Number(s);
            const m = s.match(/([0-9]+)$/);
            if (m && !Number.isNaN(Number(m[1]))) return Number(m[1]);
        }
        return null;
    }

    function getMesIdsFromElement(el) {
        if (!el) return [];
        const candidates = [
            el.getAttribute('mesid'),
            el.getAttribute('data-mesid'),
            el.getAttribute('data-message-id'),
            el.dataset?.mesid,
            el.dataset?.mesId,
            el.dataset?.messageId,
            el.id,
        ];
        const ids = [];
        for (const candidate of candidates) {
            const id = normalizeMessageDomId(candidate);
            if (id != null && !ids.includes(id)) {
                ids.push(id);
            }
        }
        return ids;
    }

    function getChatIndexForMesEl(el) {
        for (const id of getMesIdsFromElement(el)) {
            const chatIndex = findChatIndexByEventId(id);
            if (chatIndex != null) return chatIndex;
        }
        return null;
    }

    function getMesElForChatIndex(chatIndex) {
        if (chatIndex == null || chatIndex < 0) return null;

        const candidateIds = [];
        const mesId = getMesIdFromChatIndex(chatIndex);
        if (mesId != null) candidateIds.push(mesId);
        if (!candidateIds.includes(chatIndex)) candidateIds.push(chatIndex);

        for (const id of candidateIds) {
            const el = getMesElByIndex(id);
            if (el && getChatIndexForMesEl(el) === chatIndex) {
                return el;
            }
        }

        return null;
    }

    function getLastMesEl(isUser) {
        const cacheKey = isUser ? 'user' : 'assistant';
        if (lastMesElCache[cacheKey] && lastMesElCache[cacheKey].isConnected) {
            return lastMesElCache[cacheKey];
        }

        const els = document.querySelectorAll('#chat .mes[is_user]');
        if (els.length) {
            const truthy = new Set(['true', '1']);
            const falsy = new Set(['false', '0']);
            for (let i = els.length - 1; i >= 0; i--) {
                const v = (els[i].getAttribute('is_user') || '').toLowerCase();
                if (isUser ? truthy.has(v) : falsy.has(v)) {
                    lastMesElCache[cacheKey] = els[i];
                    return els[i];
                }
            }
        }

        // Fallback for ST versions that don't expose is_user on DOM nodes.
        try {
            const idx = isUser ? getLastUserIndexFromChat() : getLastAssistantIndexFromChat();
            if (idx == null) return null;
            const el = getMesElByIndex(getMesIdFromChatIndex(idx));
            lastMesElCache[cacheKey] = el;
            return el;
        } catch {
            return null;
        }
    }

    function getMesElByIndex(index) {
        if (index == null || index < 0) return null;

        // Return cached element if still in the DOM
        const cached = mesElCache.get(index);
        if (cached && cached.isConnected) return cached;

        const selectors = [
            `#chat .mes[mesid="${index}"]`,
            `#chat .mes[data-mesid="${index}"]`,
            `#chat .mes[data-message-id="${index}"]`,
            `#chat .mes#mes${index}`,
        ];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el) {
                mesElCache.set(index, el);
                return el;
            }
        }

        // Rebuild entire cache in one pass instead of scanning all elements per-miss
        const els = document.querySelectorAll('#chat .mes');
        for (let i = 0; i < els.length; i++) {
            const el = els[i];
            const ids = getMesIdsFromElement(el);
            if (ids.length) {
                mesElCache.set(ids[0], el); // first valid ID wins for this element
            }
        }
        // Try cache again after rebuild
        const rebuilt = mesElCache.get(index);
        return (rebuilt && rebuilt.isConnected) ? rebuilt : null;
    }

    function getMesTextEl(mesEl) {
        if (!mesEl) return null;
        return mesEl.querySelector('.mes_text') || null;
    }

    function getSwipeIdForAssistantDom(mesId) {
        const el = getMesElByIndex(mesId);
        if (!el) return null;
        const v = el.getAttribute('swipeid');
        if (v == null) return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    }

    function resolveSwipeId(assistantMesId, aiMsg) {
        const domSwipeId = getSwipeIdForAssistantDom(assistantMesId);
        const msgSwipeId = typeof aiMsg?.swipe_id === 'number' ? aiMsg.swipe_id : null;
        if (Number.isFinite(domSwipeId) && Number.isFinite(msgSwipeId) && domSwipeId !== msgSwipeId) {
            log('resolveSwipeId: DOM swipeid differs from chat swipe_id; using chat value', domSwipeId, msgSwipeId);
            return msgSwipeId;
        }
        if (Number.isFinite(msgSwipeId)) return msgSwipeId;
        if (Number.isFinite(domSwipeId)) return domSwipeId;
        return 0;
    }

    /**
     * Get the swipe ID from a message object.
     * Prefer swipe_id because it tracks the currently selected swipe.
     * Fall back to swipes length only when swipe_id is unavailable.
     */
    function getSwipeIdFromMsg(msg) {
        if (typeof msg?.swipe_id === 'number') {
            return Math.max(0, msg.swipe_id);
        }
        if (Array.isArray(msg?.swipes) && msg.swipes.length > 0) {
            return msg.swipes.length - 1;
        }
        return 0;
    }

    function getLastUserMesFromDom() {
        try {
            const idx = getLastUserIndexFromChat();
            if (idx != null) {
                const userEl = getMesElByIndex(getMesIdFromChatIndex(idx));
                const textEl = getMesTextEl(userEl);
                if (textEl) return textEl.textContent;
            }
        } catch {
            // ignore
        }

        const userEl = getLastMesEl(true);
        const textEl = getMesTextEl(userEl);
        if (!textEl) return null;
        return textEl.textContent;
    }

    // ─── Chat Data Readers ───────────────────────────────────────────────────────

    function getChatLookupKey(value) {
        if (value == null || value === '') return null;
        if (typeof value === 'number') {
            return Number.isFinite(value) ? String(value) : null;
        }
        if (typeof value === 'string') {
            const trimmed = value.trim();
            return trimmed === '' ? null : trimmed;
        }
        return null;
    }

    function getChatLookup() {
        const ctx = globalThis.SillyTavern?.getContext?.();
        const chat = ctx?.chat;
        if (!chat) return null;

        const chatId = ctx.chatId || null;
        if (chatLookupCache
            && chatLookupCache.chat === chat
            && chatLookupCache.chatId === chatId
            && chatLookupCache.length === chat.length) {
            return chatLookupCache;
        }

        const idToIndex = new Map();
        for (let i = chat.length - 1; i >= 0; i--) {
            const msg = chat[i];
            if (!msg) continue;
            const key = getChatLookupKey(msg.mesid ?? msg.mesId ?? msg.message_id);
            if (key != null && !idToIndex.has(key)) {
                idToIndex.set(key, i);
            }
        }

        chatLookupCache = { chat, chatId, length: chat.length, idToIndex };
        return chatLookupCache;
    }

    function getMesIdFromChatIndex(index) {
        const chat = SillyTavern.getContext().chat;
        const msg = chat && index != null ? chat[index] : null;
        if (!msg) return index;
        const mid = msg.mesid ?? msg.mesId ?? msg.message_id;
        if (typeof mid === 'number') return mid;
        if (typeof mid === 'string' && mid.trim() !== '' && !Number.isNaN(Number(mid))) return Number(mid);
        return index;
    }

    function findChatIndexByMesId(mesId) {
        const lookup = getChatLookup();
        const chat = lookup?.chat;
        if (!chat || mesId == null) return null;

        const key = getChatLookupKey(mesId);
        if (key != null && lookup.idToIndex.has(key)) {
            return lookup.idToIndex.get(key);
        }

        // If SillyTavern has no stable message ids, allow array-index fallback.
        // Do not let an old stable mesid accidentally resolve to a different
        // message that happens to occupy the same numeric array slot.
        if (typeof mesId === 'number' && mesId >= 0 && mesId < chat.length) {
            const candidate = chat[mesId];
            const candidateMid = candidate?.mesid ?? candidate?.mesId ?? candidate?.message_id;
            if (candidateMid == null || candidateMid === '') return mesId;
        }
        return null;
    }

    function findChatIndexByEventId(messageId) {
        const lookup = getChatLookup();
        const chat = lookup?.chat;
        if (!chat || messageId == null) return null;

        const chatIndex = findChatIndexByMesId(messageId);
        if (chatIndex != null) return chatIndex;

        if (typeof messageId === 'number' && messageId >= 0 && messageId < chat.length) {
            return messageId;
        }
        return null;
    }

    function getLastUserIndexFromChat() {
        const chat = SillyTavern.getContext().chat;
        if (!chat) return null;
        for (let i = chat.length - 1; i >= 0; i--) {
            if (chat[i]?.is_user) return i;
        }
        return null;
    }

    function getLastAssistantIndexFromChat() {
        const chat = SillyTavern.getContext().chat;
        if (!chat) return null;
        for (let i = chat.length - 1; i >= 0; i--) {
            const m = chat[i];
            if (m && !m.is_user && !m.is_system) return i;
        }
        return null;
    }

    function getUserIndexBefore(index) {
        const chat = SillyTavern.getContext().chat;
        if (!chat) return null;
        for (let i = index - 1; i >= 0; i--) {
            if (chat[i]?.is_user) return i;
        }
        return null;
    }

    function getLastUserMesFromChat() {
        const chat = SillyTavern.getContext().chat;
        if (!chat) return null;
        for (let i = chat.length - 1; i >= 0; i--) {
            if (chat[i]?.is_user) return getUserMessageText(chat[i]);
        }
        return null;
    }

    function getUserMesFromDomByMesId(mesId) {
        if (mesId == null) return null;
        const userEl = getMesElByIndex(mesId);
        const textEl = getMesTextEl(userEl);
        if (!textEl) return null;
        return textEl.textContent;
    }

    function getUserMesForAssistantMesId(assistantMesId) {
        if (!Number.isFinite(assistantMesId)) return null;
        const chat = SillyTavern.getContext().chat;
        if (!chat) return null;
        const assistantIdx = findChatIndexByMesId(assistantMesId);
        if (assistantIdx == null) return null;
        const userIdx = getUserIndexBefore(assistantIdx);
        if (userIdx == null) return null;
        return getUserMessageText(chat[userIdx]);
    }

    function getUserMesForKey(key) {
        const parsed = parseMappingKey(key);
        if (!parsed) return null;
        return getUserMesForAssistantMesId(parsed.assistantMesId);
    }

    function isSwipeLikeType(type) {
        return type === 'swipe' || type === 'regenerate' || type === 'continue';
    }

    function normalizeGenerationEventType(type) {
        if (typeof type !== 'string') return null;
        const normalized = type.trim().toLowerCase();
        if (!normalized) return null;
        if (normalized === 'append' || normalized === 'appendfinal') return 'continue';
        return normalized;
    }

    function resolveTrackedReceivedType(emittedType, fallbackType) {
        const normalizedEmitted = normalizeGenerationEventType(emittedType);
        if (normalizedEmitted) {
            if (normalizedEmitted === 'command' || normalizedEmitted === 'first_message' || normalizedEmitted === 'extension') {
                log('MESSAGE_RECEIVED – ignored non-generation type', normalizedEmitted);
                return null;
            }
            if (shouldTrackGenerationType(normalizedEmitted)) {
                return normalizedEmitted;
            }
            return null;
        }

        const normalizedFallback = normalizeGenerationEventType(fallbackType);
        if (!normalizedFallback) return null;
        if (!shouldTrackGenerationType(normalizedFallback)) return null;
        return normalizedFallback;
    }

    function doesAssistantExistForMesId(assistantMesId) {
        if (!Number.isFinite(assistantMesId)) return false;
        const chat = SillyTavern.getContext().chat;
        if (!chat) return false;
        const assistantIdx = findChatIndexByMesId(assistantMesId);
        if (assistantIdx == null) return false;
        const msg = chat[assistantIdx];
        return Boolean(msg && !msg.is_user && !msg.is_system);
    }

    function doesAssistantExistForKey(key) {
        const parsed = parseMappingKey(key);
        if (!parsed) return false;
        return doesAssistantExistForMesId(parsed.assistantMesId);
    }

    function captureGenerationContext(type, { capturedAt = 'after_commands', overwrite = false } = {}) {
        const normalizedType = normalizeGenerationEventType(type);

        if (!isSwipeLikeType(normalizedType)) {
            generationContext = {
                type: normalizedType,
                sourceKey: null,
                sourceAssistantMesId: null,
                sourceUserText: null,
                capturedAt,
            };
            generationKey = null;
            pendingUserText = null;
            return generationContext;
        }

        if (!overwrite && generationContext && generationContext.type === normalizedType
            && (generationContext.sourceKey || typeof generationContext.sourceUserText === 'string')) {
            generationKey = generationContext.sourceKey;
            if (typeof generationContext.sourceUserText === 'string') {
                pendingUserText = generationContext.sourceUserText;
            }
            return generationContext;
        }

        const refreshHint = parseMappingKey(activeKey)?.assistantMesId ?? generationContext?.sourceAssistantMesId ?? null;
        refreshActiveKeyFromChat(refreshHint);
        let sourceKey = activeKey;
        if (pendingEditedEntry?.key) {
            const pendingParsed = parseMappingKey(pendingEditedEntry.key);
            const activeParsed = parseMappingKey(activeKey);
            if (pendingParsed && activeParsed && pendingParsed.assistantMesId === activeParsed.assistantMesId) {
                sourceKey = pendingEditedEntry.key;
            } else if (!pendingParsed || !doesAssistantExistForMesId(pendingParsed.assistantMesId)) {
                log('captureGenerationContext – discarding stale pendingEditedEntry', pendingEditedEntry.key);
                pendingEditedEntry = null;
            }
        }
        let usedOverswipeKey = null;
        if (normalizedType === 'swipe' && (!sourceKey || !hasLinkedTextByKey(sourceKey)) && pendingSwipeGenerationKey && hasLinkedTextByKey(pendingSwipeGenerationKey)) {
            sourceKey = pendingSwipeGenerationKey;
            usedOverswipeKey = pendingSwipeGenerationKey;
            log('captureGenerationContext – using pre-overswipe key', sourceKey, 'at', capturedAt);
        }
        pendingSwipeGenerationKey = null;

        const parsed = parseMappingKey(sourceKey);
        let sourceUserText = null;
        if (pendingEditedEntry && sourceKey && pendingEditedEntry.key === sourceKey && typeof pendingEditedEntry.text === 'string') {
            sourceUserText = pendingEditedEntry.text;
        }
        if (typeof sourceUserText !== 'string' && sourceKey) {
            const mappedText = getLinkedTextByKey(sourceKey);
            if (typeof mappedText === 'string') {
                sourceUserText = mappedText;
            }
        }
        if (typeof sourceUserText !== 'string' && sourceKey) {
            sourceUserText = getUserMesForKey(sourceKey);
        }
        if (typeof sourceUserText !== 'string') {
            sourceUserText = getLastUserMesFromChat() || getLastUserMesFromDom();
        }

        generationContext = {
            type: normalizedType,
            sourceKey: sourceKey || null,
            sourceAssistantMesId: parsed ? parsed.assistantMesId : null,
            sourceUserText: typeof sourceUserText === 'string' ? sourceUserText : null,
            capturedAt,
            _usedOverswipeKey: usedOverswipeKey,
        };

        generationKey = generationContext.sourceKey;
        pendingUserText = generationContext.sourceUserText;
        return generationContext;
    }

    // ─── Capture / Store ─────────────────────────────────────────────────────────

    /**
     * Capture the visible assistant/swipe key without backfilling persisted data.
     */
    function captureCurrentState() {
        const aiIdx = getLastAssistantIndexFromChat();
        const chat = SillyTavern.getContext().chat;
        const aiMsg = aiIdx != null && chat ? chat[aiIdx] : null;
        if (!aiMsg || aiMsg.is_user || aiMsg.is_system || !hasAssistantContent(aiMsg)) {
            activeKey = null;
            return;
        }

        const assistantMesId = getMesIdFromChatIndex(aiIdx);
        const swipeId = resolveSwipeId(assistantMesId, aiMsg);
        activeKey = `${assistantMesId}:${swipeId}`;
    }

    function clearAnySwipeLinkedHighlight() {
        const highlighted = document.querySelectorAll('#chat .mes[data-swipe-linked="1"]');
        highlighted.forEach((el) => {
            restoreUserBubbleFromChat(el);
            el.removeAttribute('data-swipe-linked');
        });
    }

    function clearSwipeLinkedHighlightsExcept(exceptEl) {
        const highlighted = document.querySelectorAll('#chat .mes[data-swipe-linked="1"]');
        highlighted.forEach((el) => {
            if (el === exceptEl) return;
            restoreUserBubbleFromChat(el);
            el.removeAttribute('data-swipe-linked');
        });
    }

    function clearUserBubbleHighlightForAssistant(assistantMesId) {
        if (assistantMesId == null) {
            clearAnySwipeLinkedHighlight();
            return;
        }

        const assistantChatIndex = findChatIndexByMesId(assistantMesId);
        if (assistantChatIndex == null) {
            clearAnySwipeLinkedHighlight();
            return;
        }

        const userIndex = getUserIndexBefore(assistantChatIndex);
        if (userIndex == null) {
            clearAnySwipeLinkedHighlight();
            return;
        }

        const userEl = getMesElForChatIndex(userIndex);
        if (!userEl) {
            log('Could not resolve exact user message DOM element for index', userIndex);
            clearAnySwipeLinkedHighlight();
            return;
        }

        if (userEl.hasAttribute('data-swipe-linked')) {
            restoreUserBubbleFromChat(userEl);
        }
        userEl.removeAttribute('data-swipe-linked');
    }

    function clearUserBubbleHighlightForActiveKey() {
        if (!activeKey) {
            clearAnySwipeLinkedHighlight();
            return;
        }

        const m = /^([0-9]+):([0-9]+)$/.exec(activeKey);
        if (!m) {
            clearAnySwipeLinkedHighlight();
            return;
        }

        clearUserBubbleHighlightForAssistant(Number(m[1]));
    }

    function updateUserBubbleForActiveKey() {
        if (!activeKey) return;
        const userText = getLinkedTextByKey(activeKey);
        if (userText == null) {
            clearUserBubbleHighlightForActiveKey();
            return;
        }

        const m = /^([0-9]+):([0-9]+)$/.exec(activeKey);
        if (!m) {
            clearAnySwipeLinkedHighlight();
            return;
        }
        const assistantMesId = Number(m[1]);
        const assistantChatIndex = findChatIndexByMesId(assistantMesId);
        if (assistantChatIndex == null) {
            log('Could not resolve assistant chat index for mesid', assistantMesId);
            clearAnySwipeLinkedHighlight();
            return;
        }
        const userIndex = getUserIndexBefore(assistantChatIndex);
        if (userIndex == null) {
            clearAnySwipeLinkedHighlight();
            return;
        }

        const userEl = getMesElForChatIndex(userIndex);
        if (!userEl) {
            log('Could not resolve exact user message DOM element for index', userIndex);
            clearAnySwipeLinkedHighlight();
            return;
        }
        clearSwipeLinkedHighlightsExcept(userEl);
        const textEl = getMesTextEl(userEl);
        if (!textEl) {
            clearAnySwipeLinkedHighlight();
            return;
        }

        // Compare stored text against the canonical user message in chat data.
        // Only highlight if the text was actually modified for this swipe variant.
        const chat = SillyTavern.getContext().chat;
        const originalUserText = chat && chat[userIndex] ? getUserDisplayText(chat[userIndex]) : null;
        if (originalUserText != null && userText.trim() === originalUserText.trim()) {
            // Text wasn't modified – restore formatted DOM and don't highlight
            restoreUserBubbleFromChat(userEl);
            userEl.removeAttribute('data-swipe-linked');
            return;
        }

        if (textEl.textContent.trim() === userText.trim()) {
            userEl.setAttribute('data-swipe-linked', '1');
            return;
        }

        log('Updating user bubble to:', userText.substring(0, 60));
        textEl.innerHTML = formatUserMessageText(userText, userIndex);
        userEl.setAttribute('data-swipe-linked', '1');
    }

    function refreshActiveKeyFromChat(assistantIndexOrMesId = null) {
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat;
        if (!chat) return;

        let aiIdx = null;
        if (assistantIndexOrMesId != null) {
            aiIdx = findChatIndexByMesId(assistantIndexOrMesId);
        } else {
            aiIdx = getLastAssistantIndexFromChat();
        }
        if (aiIdx == null) return;
        const aiMsg = chat[aiIdx];
        if (!aiMsg || aiMsg.is_user || aiMsg.is_system || !hasAssistantContent(aiMsg)) {
            activeKey = null;
            return;
        }
        const assistantMesId = getMesIdFromChatIndex(aiIdx);

        const swipeId = resolveSwipeId(assistantMesId, aiMsg);
        activeKey = `${assistantMesId}:${swipeId}`;
    }

    // ─── Swipe Detection & Handling ──────────────────────────────────────────────

    function handleSwipeChange() {
        refreshActiveKeyFromChat();
        if (!activeKey) {
            clearAnySwipeLinkedHighlight();
            return;
        }
        if (!hasLinkedTextByKey(activeKey)) {
            log('No mapping for key', activeKey);
            clearUserBubbleHighlightForActiveKey();
            return;
        }
        updateUserBubbleForActiveKey();
    }

    function handleSwipeChangeForAssistant(assistantIndexOrMesId = null) {
        refreshActiveKeyFromChat(assistantIndexOrMesId);
        if (!activeKey) {
            clearAnySwipeLinkedHighlight();
            return;
        }
        if (!hasLinkedTextByKey(activeKey)) {
            log('No mapping for key', activeKey);
            clearAnySwipeLinkedHighlight();
            return;
        }
        updateUserBubbleForActiveKey();
    }

    function scheduleSwipeCheck(assistantIndexOrMesId = null) {
        if (swipeDebounceTimer) clearTimeout(swipeDebounceTimer);
        const seq = ++swipeRenderSeq;
        swipeDebounceTimer = setTimeout(() => {
            if (seq !== swipeRenderSeq) return;
            handleSwipeChangeForAssistant(assistantIndexOrMesId);
        }, 200);
    }

    function scheduleSwipeRenderAfterFrame(assistantIndexOrMesId = null, { skipWhileGenerating = false } = {}) {
        const seq = ++swipeRenderSeq;
        const renderIfCurrent = (phase) => {
            if (seq !== swipeRenderSeq) return;
            // Load-path renders (CHAT_CHANGED/init) must not fight an in-flight
            // generation. Re-check here, not just at schedule time, so a generation
            // that starts within the settled window is also skipped. The swipe/
            // receive paths leave this off because they intentionally render mid-gen.
            if (skipWhileGenerating && isGenerating) {
                log('Skipping linked user bubble render (generating)', phase);
                return;
            }
            log('Rendering linked user bubble after swipe', phase);
            handleSwipeChangeForAssistant(assistantIndexOrMesId);
        };

        requestAnimationFrame(() => {
            setTimeout(() => {
                renderIfCurrent('frame');
            }, 0);
        });

        // SillyTavern may re-render the edited user row after MESSAGE_SWIPED.
        // Re-apply once after that work settles so the marker and text stay in sync.
        setTimeout(() => {
            renderIfCurrent('settled');
        }, 250);
    }

    // ─── MutationObserver ────────────────────────────────────────────────────────

    function detachObserver() {
        if (observer) {
            observer.disconnect();
            observer = null;
        }
    }

    function attachObserver() {
        detachObserver();
        // Skip MutationObserver entirely when MESSAGE_SWIPED event is available
        // This eliminates all MutationRecord marshalling overhead during streaming
        if (hasMessageSwipedEvent) {
            log('attachObserver: skipped (MESSAGE_SWIPED event available)');
            return;
        }
        const aiIdx = getLastAssistantIndexFromChat();
        const aiEl = (aiIdx != null ? getMesElByIndex(getMesIdFromChatIndex(aiIdx)) : null) || getLastMesEl(false);
        const textEl = getMesTextEl(aiEl);
        if (!textEl) {
            log('attachObserver: no assistant text element found');
            return;
        }
        observer = new MutationObserver((mutations) => {
            // Skip characterData-only mutations during streaming (text content updates, not swipes)
            const allCharacterData = mutations.every(m => m.type === 'characterData');
            if (allCharacterData) return;
            if (!isGenerating) scheduleSwipeCheck();
        });
        observer.observe(textEl, {
            characterData: true,
            childList: true,
            subtree: true,
        });
        log('Observer attached');
    }

    // ─── Cleanup ─────────────────────────────────────────────────────────────────

    function clearState() {
        clearAnySwipeLinkedHighlight();
        activeKey = null;
        pendingUserText = null;
        pendingNormalUserText = null;
        pendingEditedEntry = null;
        generationContext = null;
        generationKey = null;
        generationType = null;
        pendingGenerationType = null;
        didReceiveMessageForGeneration = false;
        pendingSwipeGenerationKey = null;
        detachObserver();
        invalidateMesElCache();
        if (swipeDebounceTimer) {
            clearTimeout(swipeDebounceTimer);
            swipeDebounceTimer = null;
        }
        swipeRenderSeq++;
        editsButtonScanSeq++;
        log('State cleared');
    }

    // ─── Event Handlers ──────────────────────────────────────────────────────────

    function normalizeMessageIndex(arg) {
        if (typeof arg === 'number') return arg;
        if (typeof arg === 'string' && arg.trim() !== '' && !Number.isNaN(Number(arg))) return Number(arg);
        if (!arg || typeof arg !== 'object') return null;
        if (typeof arg.messageIndex === 'number') return arg.messageIndex;
        if (typeof arg.messageId === 'number') return arg.messageId;
        if (typeof arg.message_id === 'number') return arg.message_id;
        if (typeof arg.index === 'number') return arg.index;
        if (typeof arg.message_index === 'number') return arg.message_index;
        if (typeof arg.mesid === 'number') return arg.mesid;
        if (typeof arg.mesId === 'number') return arg.mesId;
        if (typeof arg.id === 'number') return arg.id;
        if (typeof arg.mesid === 'string' && arg.mesid.trim() !== '' && !Number.isNaN(Number(arg.mesid))) return Number(arg.mesid);
        if (typeof arg.mesId === 'string' && arg.mesId.trim() !== '' && !Number.isNaN(Number(arg.mesId))) return Number(arg.mesId);
        if (typeof arg.messageId === 'string' && arg.messageId.trim() !== '' && !Number.isNaN(Number(arg.messageId))) return Number(arg.messageId);
        if (typeof arg.id === 'string' && arg.id.trim() !== '' && !Number.isNaN(Number(arg.id))) return Number(arg.id);
        return null;
    }

    function shouldTrackGenerationType(type) {
        const normalized = normalizeGenerationEventType(type);
        if (!normalized) return false;
        return normalized !== 'quiet' && normalized !== 'impersonate';
    }

    function onChatChanged() {
        const ctx = SillyTavern.getContext();
        const currentId = ctx.chatId || null;
        if (currentId !== lastChatId) {
            lastChatId = currentId;
            clearState();
        }
        invalidateMesElCache();
        // Capture initial state for the new chat's last pair
        requestAnimationFrame(() => {
            captureCurrentState();
            attachObserver();
            // Reload/chat-switch may land on a non-latest swipe. Nothing fires
            // MESSAGE_SWIPED in that case, so re-render the linked user bubble
            // for the currently-selected swipe (no-op when no mapping exists).
            scheduleSwipeRenderAfterFrame(null, { skipWhileGenerating: true });
            scheduleEditsButtonsForLoadedChat();
        });
    }

    function onGenerationAfterCommands(type, _generateOptions, dryRun) {
        if (dryRun === true) return;
        if (!shouldTrackGenerationType(type)) return;

        isGenerating = true;
        generationSeq++;
        generationType = normalizeGenerationEventType(type);
        pendingGenerationType = generationType;
        didReceiveMessageForGeneration = false;

        if (generationType === 'normal') {
            captureGenerationContext(generationType, { capturedAt: 'after_commands', overwrite: true });
        } else if (!generationContext || generationContext.type !== generationType
            || (!generationContext.sourceKey && typeof generationContext.sourceUserText !== 'string')) {
            captureGenerationContext(generationType, { capturedAt: 'after_commands', overwrite: false });
        } else {
            generationKey = generationContext.sourceKey;
            if (typeof generationContext.sourceUserText === 'string') {
                pendingUserText = generationContext.sourceUserText;
            }
        }
        pendingSwipeGenerationKey = null;

        log('GENERATION_AFTER_COMMANDS – pending:', pendingUserText && pendingUserText.substring(0, 60), 'key:', generationKey, 'ctx:', generationContext);
    }

    function onGenerationStarted(type, _generateOptions, dryRun) {
        if (dryRun === true) return;
        if (!shouldTrackGenerationType(type)) return;

        isGenerating = true;
        generationSeq++;
        generationType = normalizeGenerationEventType(type) || generationType;
        pendingGenerationType = generationType;
        didReceiveMessageForGeneration = false;
        if (generationType === 'normal') {
            captureGenerationContext(generationType, { capturedAt: 'started', overwrite: true });
        } else if (!generationContext || generationContext.type !== generationType
            || (!generationContext.sourceKey && typeof generationContext.sourceUserText !== 'string')) {
            captureGenerationContext(generationType, { capturedAt: 'started', overwrite: true });
        } else {
            generationKey = generationContext.sourceKey;
            if (typeof generationContext.sourceUserText === 'string') {
                pendingUserText = generationContext.sourceUserText;
            }
        }
        log('GENERATION_STARTED – pending:', pendingUserText && pendingUserText.substring(0, 60), 'key:', generationKey, 'ctx:', generationContext);
    }

    function onMessageReceived(messageIndex, messageType) {
        messageIndex = normalizeMessageIndex(messageIndex);
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat;
        if (!chat || messageIndex == null) return;

        // Use pendingGenerationType as fallback when GENERATION_ENDED fires before
        // MESSAGE_RECEIVED (streaming path: markUIGenStopped → GENERATION_ENDED
        // can clear generating flags before MESSAGE_RECEIVED is emitted).
        const fallbackType = isGenerating ? generationType : pendingGenerationType;
        const normalizedFallbackType = normalizeGenerationEventType(fallbackType);
        let effectiveType = resolveTrackedReceivedType(messageType, normalizedFallbackType);

        // Regenerate can emit MESSAGE_RECEIVED as "normal" after deleting/replacing
        // the assistant row. In that case preserve the original swipe-like type.
        if (effectiveType === 'normal'
            && isSwipeLikeType(normalizedFallbackType)
            && generationContext
            && generationContext.type === normalizedFallbackType) {
            log('MESSAGE_RECEIVED – remapped emitted normal to', normalizedFallbackType, 'using generation context');
            effectiveType = normalizedFallbackType;
        }
        if (!effectiveType) return;

        const chatIndex = findChatIndexByEventId(messageIndex);
        if (chatIndex == null) return;

        const msg = chat[chatIndex];
        if (!msg || msg.is_user || msg.is_system) return;

        const aiMes = msg.mes;
        if (!aiMes) return;

        const contextType = normalizeGenerationEventType(generationContext?.type);
        const sourceKeyFromContext = generationContext
            && (contextType === effectiveType || (isSwipeLikeType(contextType) && isSwipeLikeType(effectiveType)))
            ? generationContext.sourceKey
            : null;
        const keyUsedForGeneration = sourceKeyFromContext || generationKey || activeKey;
        let userTextForMapping = null;
        if (effectiveType === 'normal') {
            // Prefer the text captured at MESSAGE_SENT. This avoids races where
            // assistant MESSAGE_RECEIVED arrives before chat adjacency is finalized.
            if (typeof pendingNormalUserText === 'string') {
                userTextForMapping = pendingNormalUserText;
            } else {
                // Fallback: use the user immediately before the received assistant.
                const userIdx = getUserIndexBefore(chatIndex);
                if (userIdx != null) {
                    userTextForMapping = getUserMessageText(chat[userIdx]);
                }
            }
        } else {
            if (pendingEditedEntry && keyUsedForGeneration
                && pendingEditedEntry.key === keyUsedForGeneration
                && typeof pendingEditedEntry.text === 'string') {
                userTextForMapping = pendingEditedEntry.text;
            } else if (generationContext
                && typeof generationContext.sourceUserText === 'string'
                && (!generationContext.sourceKey || generationContext.sourceKey === keyUsedForGeneration)) {
                userTextForMapping = generationContext.sourceUserText;
            } else if (typeof pendingUserText === 'string') {
                userTextForMapping = pendingUserText;
            } else if (keyUsedForGeneration) {
                const mappedText = getLinkedTextByKey(keyUsedForGeneration);
                if (typeof mappedText === 'string') {
                    userTextForMapping = mappedText;
                }
            }
            if (typeof userTextForMapping !== 'string') {
                userTextForMapping = getLastUserMesFromDom() || null;
            }
        }

        if (typeof userTextForMapping !== 'string') return;

        const assistantMesId = getMesIdFromChatIndex(chatIndex);
        const swipeId = getSwipeIdFromMsg(msg);
        const storedKey = setMapping(assistantMesId, swipeId, userTextForMapping, {
            setActive: true,
            source: 'MESSAGE_RECEIVED',
            skipSave: true,
            confirm: true,
        });
        if (!storedKey) return;
        didReceiveMessageForGeneration = true;
        pendingSwipeGenerationKey = null;
        if (effectiveType === 'normal') {
            pendingNormalUserText = null;
        } else {
            if (pendingEditedEntry && keyUsedForGeneration && pendingEditedEntry.key === keyUsedForGeneration) {
                pendingEditedEntry = null;
            }
        }
        pendingUserText = null;
        generationKey = null;
        generationContext = null;
        pendingGenerationType = null;
        requestChatSave();
        scheduleSwipeRenderAfterFrame(assistantMesId);
    }

    function onCharacterMessageRendered(messageIndex) {
        messageIndex = normalizeMessageIndex(messageIndex);
        invalidateMesElCache();
        // Reattach observer to the newest assistant message
        requestAnimationFrame(() => {
            attachObserver();
            const renderedIdx = messageIndex != null ? findChatIndexByEventId(messageIndex) : getLastAssistantIndexFromChat();
            const renderedEl = renderedIdx != null ? getMesElForChatIndex(renderedIdx) : null;
            const chat = SillyTavern.getContext().chat;
            if (renderedEl) ensureEditsButton(renderedEl, renderedIdx, chat?.[renderedIdx]);
            // Ensure the currently visible swipe (usually 0) has a mapping.
            const chatIndex = messageIndex != null ? findChatIndexByEventId(messageIndex) : null;
            if (chatIndex != null) {
                const isLatestAssistant = chatIndex === getLastAssistantIndexFromChat();
                if (isLatestAssistant) {
                    const assistantMesId = getMesIdFromChatIndex(chatIndex);
                    const activeAssistantMesId = parseMappingKey(activeKey)?.assistantMesId ?? null;
                    ensureMappingForAssistantMesId(assistantMesId, {
                        setActive: activeAssistantMesId == null || activeAssistantMesId === assistantMesId,
                    });
                }
            } else {
                const aiIdx = getLastAssistantIndexFromChat();
                if (aiIdx != null && !activeKey) ensureMappingForAssistantMesId(getMesIdFromChatIndex(aiIdx));
            }
        });
    }

    function onGenerationEnded() {
        const preserveForLateMessage = !didReceiveMessageForGeneration && shouldTrackGenerationType(pendingGenerationType);
        const seqAtEnd = generationSeq;
        const overswipeKeyToRestore = !didReceiveMessageForGeneration ? generationContext?._usedOverswipeKey : null;

        isGenerating = false;
        if (overswipeKeyToRestore && hasLinkedTextByKey(overswipeKeyToRestore)) {
            pendingSwipeGenerationKey = overswipeKeyToRestore;
        } else if (!preserveForLateMessage) {
            pendingSwipeGenerationKey = null;
        }

        if (!didReceiveMessageForGeneration && !preserveForLateMessage && pendingUserText) {
            log('GENERATION_ENDED – no MESSAGE_RECEIVED for tracked generation; skipped fallback mapping write');
        }
        if (preserveForLateMessage) {
            log('GENERATION_ENDED – preserving context for late MESSAGE_RECEIVED', pendingGenerationType, generationKey);
            setTimeout(() => {
                if (generationSeq !== seqAtEnd || isGenerating || didReceiveMessageForGeneration) return;
                pendingUserText = null;
                generationKey = null;
                generationContext = null;
                pendingGenerationType = null;
                pendingSwipeGenerationKey = null;
                log('GENERATION_ENDED – cleared stale preserved context', seqAtEnd);
            }, 5000);
        } else {
            pendingUserText = null;
            generationKey = null;
            generationContext = null;
            pendingGenerationType = null;
        }
        generationType = null;
        didReceiveMessageForGeneration = false;
    }

    function onMessageSwiped(messageIndex) {
        messageIndex = normalizeMessageIndex(messageIndex);
        const previousKey = activeKey;
        log('MESSAGE_SWIPED', messageIndex);

        // Synchronously detect overswipe BEFORE rAF, because Generate('swipe')
        // fires immediately after this emit resolves.
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat;
        const aiIdx = messageIndex != null ? findChatIndexByEventId(messageIndex) : getLastAssistantIndexFromChat();
        const aiMsg = aiIdx != null && chat ? chat[aiIdx] : null;
        const isOverswipePending = Boolean(
            aiMsg &&
            Array.isArray(aiMsg.swipes) &&
            typeof aiMsg.swipe_id === 'number' &&
            aiMsg.swipe_id >= aiMsg.swipes.length,
        );
        if (isOverswipePending && previousKey && hasLinkedTextByKey(previousKey)) {
            pendingSwipeGenerationKey = previousKey;
            log('MESSAGE_SWIPED – captured pre-overswipe key', pendingSwipeGenerationKey);
        } else if (!isGenerating) {
            pendingSwipeGenerationKey = null;
        }

        scheduleSwipeRenderAfterFrame(aiIdx != null ? getMesIdFromChatIndex(aiIdx) : null);
        // A fresh variant may have just crossed the "more than one swipe" threshold,
        // so (re)evaluate the edits button for this message.
        ensureEditsButtonForAssistant(aiIdx != null ? getMesIdFromChatIndex(aiIdx) : null);
    }

    function onMessageUpdated(messageIndex) {
        messageIndex = normalizeMessageIndex(messageIndex);
        if (isGenerating) return;
        const chat = SillyTavern.getContext().chat;
        const chatIndex = messageIndex != null ? findChatIndexByEventId(messageIndex) : null;
        const msg = chatIndex != null && chat ? chat[chatIndex] : null;
        const assistantMesId = msg && !msg.is_user && !msg.is_system ? getMesIdFromChatIndex(chatIndex) : null;
        scheduleSwipeRenderAfterFrame(assistantMesId);
    }

    function onMessageEdited(messageIndex) {
        messageIndex = normalizeMessageIndex(messageIndex);
        const chat = SillyTavern.getContext().chat;
        if (!chat || messageIndex == null) return;

        const editedIndex = findChatIndexByEventId(messageIndex);
        if (editedIndex == null || !chat[editedIndex]?.is_user) return;

        let editedText = getUserMessageText(chat[editedIndex]);
        if (typeof editedText !== 'string') {
            editedText = getUserMesFromDomByMesId(getMesIdFromChatIndex(editedIndex));
        }
        if (typeof editedText !== 'string') return;

        const assistantIndexes = [];
        for (let i = editedIndex + 1; i < chat.length; i++) {
            const msg = chat[i];
            if (!msg) continue;
            if (msg.is_user) break;
            if (!msg.is_system && hasAssistantContent(msg)) assistantIndexes.push(i);
        }

        if (!assistantIndexes.length) {
            activeKey = null;
            pendingEditedEntry = null;
            pendingNormalUserText = editedText;
            clearAnySwipeLinkedHighlight();
            log('MESSAGE_EDITED – user has no assistant in turn; updated pending normal text:', editedText.substring(0, 60));
            return;
        }

        let pairedAssistantIndex = assistantIndexes[assistantIndexes.length - 1];
        const parsedActive = parseMappingKey(activeKey);
        if (parsedActive) {
            const activeIdx = findChatIndexByMesId(parsedActive.assistantMesId);
            if (assistantIndexes.includes(activeIdx)) pairedAssistantIndex = activeIdx;
        }

        const assistantMesId = getMesIdFromChatIndex(pairedAssistantIndex);
        const swipeId = resolveSwipeId(assistantMesId, chat[pairedAssistantIndex]);
        const keyAtEdit = `${assistantMesId}:${swipeId}`;

        const lastUserIndex = getLastUserIndexFromChat();
        const isLatestUser = editedIndex === lastUserIndex;
        if (isLatestUser) {
            activeKey = keyAtEdit;
        }

        pendingEditedEntry = { key: keyAtEdit, text: editedText };
        log('MESSAGE_EDITED – pending keyed edit updated:', keyAtEdit, editedText.substring(0, 60), isLatestUser ? '(latest)' : '(non-latest)');
    }

    function onMessageDeleted(_chatLength) {
        invalidateMesElCache();
        clearAnySwipeLinkedHighlight();

        const normalizedType = normalizeGenerationEventType(generationType || pendingGenerationType || generationContext?.type);
        const preserveGenerationState = isGenerating && isSwipeLikeType(normalizedType);

        if (preserveGenerationState) {
            log('MESSAGE_DELETED – preserving in-flight swipe-like generation state', normalizedType, generationKey, generationContext);
            requestAnimationFrame(() => {
                handleSwipeChange();
            });
            return;
        }

        if (activeKey && !doesAssistantExistForKey(activeKey)) {
            activeKey = null;
        }
        if (generationKey && !doesAssistantExistForKey(generationKey)) {
            generationKey = null;
        }
        if (pendingSwipeGenerationKey && !doesAssistantExistForKey(pendingSwipeGenerationKey)) {
            pendingSwipeGenerationKey = null;
        }
        if (pendingEditedEntry && typeof pendingEditedEntry.key === 'string' && !doesAssistantExistForKey(pendingEditedEntry.key)) {
            pendingEditedEntry = null;
        }
        if (generationContext?.sourceKey && !doesAssistantExistForKey(generationContext.sourceKey)) {
            generationContext = {
                ...generationContext,
                sourceKey: null,
                sourceAssistantMesId: null,
            };
        }

        pendingNormalUserText = null;
        pendingUserText = null;
        pendingGenerationType = null;
        log('MESSAGE_DELETED – rebuilding current state');

        requestAnimationFrame(() => {
            captureCurrentState();
            const aiIdx = getLastAssistantIndexFromChat();
            if (aiIdx != null) {
                ensureMappingForAssistantMesId(getMesIdFromChatIndex(aiIdx));
            }
            handleSwipeChange();
        });
    }

    function onMessageSwipeDeleted(data) {
        if (!data || typeof data !== 'object') return;
        const { messageId, swipeId } = data;
        if (typeof messageId !== 'number' || typeof swipeId !== 'number') return;

        let assistantIdx = findChatIndexByEventId(messageId);
        const assistantMesId = assistantIdx != null ? getMesIdFromChatIndex(assistantIdx) : messageId;

        activeKey = adjustKeyAfterSwipeDelete(activeKey, assistantMesId, swipeId);
        generationKey = adjustKeyAfterSwipeDelete(generationKey, assistantMesId, swipeId);
        pendingSwipeGenerationKey = adjustKeyAfterSwipeDelete(pendingSwipeGenerationKey, assistantMesId, swipeId);

        if (pendingEditedEntry && typeof pendingEditedEntry.key === 'string') {
            const adjustedKey = adjustKeyAfterSwipeDelete(pendingEditedEntry.key, assistantMesId, swipeId);
            if (adjustedKey) {
                pendingEditedEntry = { ...pendingEditedEntry, key: adjustedKey };
            } else {
                pendingEditedEntry = null;
            }
        }

        if (generationContext?.sourceKey) {
            const adjustedKey = adjustKeyAfterSwipeDelete(generationContext.sourceKey, assistantMesId, swipeId);
            generationContext = {
                ...generationContext,
                sourceKey: adjustedKey,
                sourceAssistantMesId: adjustedKey ? generationContext.sourceAssistantMesId : null,
            };
        }

        log('MESSAGE_SWIPE_DELETED – adjusted session keys for assistant', assistantMesId, 'deleted swipe', swipeId);

        refreshActiveKeyFromChat(assistantMesId);
        if (!activeKey || !hasLinkedTextByKey(activeKey)) {
            clearUserBubbleHighlightForAssistant(assistantMesId);
            return;
        }
        updateUserBubbleForActiveKey();
    }

    function onMessageSent(messageIndex) {
        messageIndex = normalizeMessageIndex(messageIndex);
        const chat = SillyTavern.getContext().chat;
        let sentUserText = null;
        if (chat && messageIndex != null) {
            const chatIndex = findChatIndexByEventId(messageIndex);
            if (chatIndex != null) {
                const msg = chat[chatIndex];
                if (msg?.is_user) {
                    sentUserText = getUserMessageText(msg);
                }
            }
        }
        if (typeof sentUserText !== 'string') {
            sentUserText = getLastUserMesFromChat() || getLastUserMesFromDom();
        }
        pendingNormalUserText = typeof sentUserText === 'string' ? sentUserText : null;
        pendingEditedEntry = null;
        activeKey = null;
        clearAnySwipeLinkedHighlight();
        log('MESSAGE_SENT – pending normal text:', pendingNormalUserText && pendingNormalUserText.substring(0, 60));

        // Preserve mappings so follow-up assistant generations can patch historical context.
        // Just clear any pending text from an in-flight capture.
        pendingUserText = null;
        pendingSwipeGenerationKey = null;
        generationContext = null;
        generationKey = null;
        pendingGenerationType = null;
    }

    // ─── Generate Interceptor ────────────────────────────────────────────────────

    /**
     * Patch every historical user turn that sits before an assistant message parked
     * on a NON-latest swipe, replacing its outgoing text with that swipe's linked
     * user text. Used for `normal` sends, where the per-source-turn patch below does
     * not run: without this, an earlier turn the user has swiped away from would be
     * sent to the model as its latest-edited text rather than the branch's own text.
     *
     * Operates directly on the spread-copied coreChat entries (which carry
     * swipe_info/swipe_id/swipes), so no live-chat matching is needed. Only
     * non-latest swipes are touched — the latest swipe equals canonical by
     * construction, and skipping it avoids clobbering regex-processed text.
     */
    function patchHistoricalUserTurns(chat) {
        if (!Array.isArray(chat)) return;
        for (let i = 0; i < chat.length; i++) {
            const aiMsg = chat[i];
            if (!aiMsg || aiMsg.is_user || aiMsg.is_system) continue;
            const swipes = Array.isArray(aiMsg.swipes) ? aiMsg.swipes : null;
            const swipeId = getSwipeIdFromMsg(aiMsg);
            if (!swipes || swipeId >= swipes.length - 1) continue;
            const linked = getLinkedUserText(aiMsg, swipeId);
            if (typeof linked !== 'string') continue;
            let userIdx = -1;
            for (let j = i - 1; j >= 0; j--) {
                if (chat[j]?.is_user) { userIdx = j; break; }
            }
            if (userIdx === -1) continue;
            const userMsg = chat[userIdx];
            if (!userMsg || typeof userMsg !== 'object' || userMsg.mes === linked) continue;
            userMsg.mes = linked;
            log('Interceptor (normal) patched historical user idx', userIdx, 'for assistant idx', i, 'swipe', swipeId, 'to:', linked.substring(0, 60));
        }
    }

    globalThis.swipeLinkedUserEditInterceptor = async function (chat, _contextSize, _abort, _type) {
        const interceptorType = normalizeGenerationEventType(_type);
        if (interceptorType === 'normal') {
            patchHistoricalUserTurns(chat);
            return;
        }
        if (interceptorType !== 'swipe' && interceptorType !== 'regenerate' && interceptorType !== 'continue') return;

        const skipPatch = (reason, details = {}) => {
            log('Interceptor skipped', reason, details);
        };

        // Use the key captured at generation start, not current state
        // This avoids race conditions where swipe_id may have changed
        const keyToUse = generationContext?.sourceKey || generationKey || activeKey;
        if (!keyToUse) {
            skipPatch('missing_key', { type: interceptorType });
            return;
        }

        const parsedKey = parseMappingKey(keyToUse);
        if (!parsedKey) {
            skipPatch('invalid_key', { type: interceptorType, keyToUse });
            return;
        }

        let textSource = null;
        let textToPatch = null;
        if (pendingEditedEntry && pendingEditedEntry.key === keyToUse && typeof pendingEditedEntry.text === 'string') {
            textSource = 'edited';
            textToPatch = pendingEditedEntry.text;
        } else if (generationContext
            && typeof generationContext.sourceUserText === 'string'
            && (!generationContext.sourceKey || generationContext.sourceKey === keyToUse)) {
            textSource = 'context';
            textToPatch = generationContext.sourceUserText;
        } else if (typeof pendingUserText === 'string') {
            textSource = 'pending';
            textToPatch = pendingUserText;
        } else {
            const mappedText = getLinkedTextByKey(keyToUse);
            if (typeof mappedText === 'string') {
                textSource = 'mapped';
                textToPatch = mappedText;
            }
        }
        if (typeof textToPatch !== 'string') {
            skipPatch('missing_text', { type: interceptorType, keyToUse });
            return;
        }

        let userIdx = -1;
        const sourceAssistantMesId = generationContext?.sourceAssistantMesId ?? parsedKey.assistantMesId;
        const liveCtx = globalThis.SillyTavern?.getContext?.();
        const liveChat = liveCtx?.chat;
        let coreAssistantIdx = -1;

        for (let i = chat.length - 1; i >= 0; i--) {
            const msg = chat[i];
            if (!msg || msg.is_user || msg.is_system) continue;
            const mid = msg.mesid ?? msg.mesId ?? msg.message_id;
            if (mid === sourceAssistantMesId || (typeof mid === 'string' && mid === String(sourceAssistantMesId))) {
                coreAssistantIdx = i;
                break;
            }
        }

        if (coreAssistantIdx === -1 && liveChat && sourceAssistantMesId != null) {
            const liveAssistantIdx = findChatIndexByMesId(sourceAssistantMesId);
            const liveAssistant = liveAssistantIdx != null ? liveChat[liveAssistantIdx] : null;
            if (liveAssistant?.send_date) {
                for (let i = chat.length - 1; i >= 0; i--) {
                    if (chat[i]?.send_date === liveAssistant.send_date && !chat[i]?.is_user && !chat[i]?.is_system) {
                        coreAssistantIdx = i;
                        break;
                    }
                }
            }
        }

        if (coreAssistantIdx !== -1) {
            for (let i = coreAssistantIdx - 1; i >= 0; i--) {
                if (chat[i]?.is_user) {
                    userIdx = i;
                    break;
                }
            }
        }

        if (userIdx === -1 && liveChat && sourceAssistantMesId != null) {
            const liveAssistantIdx = findChatIndexByMesId(sourceAssistantMesId);
            const liveUserIdx = liveAssistantIdx != null ? getUserIndexBefore(liveAssistantIdx) : null;
            const liveUser = liveUserIdx != null ? liveChat[liveUserIdx] : null;
            if (liveUser?.send_date) {
                for (let i = chat.length - 1; i >= 0; i--) {
                    if (chat[i]?.is_user && chat[i].send_date === liveUser.send_date) {
                        userIdx = i;
                        break;
                    }
                }
            }
        }

        if (userIdx === -1) {
            for (let i = chat.length - 1; i >= 0; i--) {
                if (chat[i]?.is_user) {
                    userIdx = i;
                    break;
                }
            }
        }
        if (userIdx === -1) {
            skipPatch('target_user_not_found', { type: interceptorType, keyToUse, chatLength: Array.isArray(chat) ? chat.length : null });
            return;
        }

        log('Interceptor decision', { type: interceptorType, keyToUse, source: textSource, resolvedUserIdx: userIdx });

        const msg = chat[userIdx];
        if (!msg || typeof msg !== 'object') {
            skipPatch('target_mismatch', { type: interceptorType, keyToUse, resolvedUserIdx: userIdx });
            return;
        }

        // If already matching, skip
        if (msg.mes === textToPatch) return;

        // coreChat contains spread-copied objects (SillyTavern's Generate builds coreChat
        // via chat.filter().map(item => ({ ...item, mes: regexed }))), so this mutation
        // only affects the API call. No restoration needed.
        msg.mes = textToPatch;
        log('Interceptor patched user msg idx', userIdx, 'with key', keyToUse, 'source', textSource, 'to:', textToPatch.substring(0, 60));
    };

    // ─── "View linked edits" Button ──────────────────────────────────────────────

    const EDITS_BUTTON_CLASS = 'swipe_edits_view_button';

    function shouldShowEditsButton(msg) {
        if (!msg || msg.is_user || msg.is_system) return false;
        const hasMultipleSwipes = Array.isArray(msg.swipes) && msg.swipes.length > 1;
        const hasAnyLinked = Array.isArray(msg.swipe_info)
            && msg.swipe_info.some((si) => typeof si?.extra?.linked_user_text === 'string');
        return hasMultipleSwipes || hasAnyLinked;
    }

    /**
     * Add (or remove) the per-message "view linked edits" button on an AI message.
     * The button is only shown when there is something to show — i.e. the message
     * has more than one swipe or at least one recorded linked_user_text. Idempotent.
     */
    function ensureEditsButton(mesEl, knownChatIndex = null, knownMsg = undefined) {
        if (!mesEl || mesEl.getAttribute('is_user') === 'true' || mesEl.getAttribute('is_system') === 'true') return;
        const extraBtns = mesEl.querySelector('.extraMesButtons');
        if (!extraBtns) return;
        const chatIndex = knownChatIndex != null ? knownChatIndex : getChatIndexForMesEl(mesEl);
        const msg = knownMsg !== undefined ? knownMsg : (chatIndex != null ? SillyTavern.getContext().chat?.[chatIndex] : null);
        const existing = extraBtns.querySelector(`.${EDITS_BUTTON_CLASS}`);
        if (!msg || msg.is_user || msg.is_system) {
            if (existing) existing.remove();
            return;
        }
        if (!shouldShowEditsButton(msg)) {
            if (existing) existing.remove();
            return;
        }
        if (existing) return;
        const btn = document.createElement('div');
        btn.className = `mes_button ${EDITS_BUTTON_CLASS} fa-solid fa-clock-rotate-left`;
        btn.title = 'View linked user edits';
        btn.setAttribute('data-i18n', '[title]View linked user edits');
        extraBtns.appendChild(btn);
    }

    function ensureEditsButtonForLoadedMessage(el, chat) {
        if (!el) return;
        if (el.getAttribute('is_user') === 'true' || el.getAttribute('is_system') === 'true') {
            el.querySelector(`.${EDITS_BUTTON_CLASS}`)?.remove();
            return;
        }
        const chatIndex = getChatIndexForMesEl(el);
        const msg = chatIndex != null ? chat?.[chatIndex] : null;
        ensureEditsButton(el, chatIndex, msg);
    }

    function scheduleEditsButtonsForLoadedChat() {
        const seq = ++editsButtonScanSeq;
        scheduleIdleTask(() => {
            if (seq !== editsButtonScanSeq || !isCurrentInstance()) return;
            const chatEl = document.getElementById('chat');
            const chat = SillyTavern.getContext().chat;
            if (!chatEl || !chat) return;

            const nodes = Array.from(chatEl.querySelectorAll('.mes'));
            let index = 0;
            const processChunk = (deadline) => {
                if (seq !== editsButtonScanSeq || !isCurrentInstance()) return;
                if (SillyTavern.getContext().chat !== chat) return;

                let processed = 0;
                while (index < nodes.length) {
                    ensureEditsButtonForLoadedMessage(nodes[index], chat);
                    index++;
                    processed++;

                    const timeRemaining = typeof deadline?.timeRemaining === 'function' ? deadline.timeRemaining() : 0;
                    if (processed >= 40 && timeRemaining < 4) break;
                    if (processed >= 100) break;
                }

                if (index < nodes.length) {
                    scheduleIdleTask(processChunk);
                }
            };

            processChunk();
        });
    }

    function ensureEditsButtonForAssistant(assistantIndexOrMesId) {
        if (assistantIndexOrMesId == null) return;
        const chatIndex = findChatIndexByMesId(assistantIndexOrMesId);
        const mesEl = chatIndex != null ? getMesElForChatIndex(chatIndex) : null;
        const msg = chatIndex != null ? SillyTavern.getContext().chat?.[chatIndex] : null;
        if (mesEl) ensureEditsButton(mesEl, chatIndex, msg);
    }

    function showEditsPopup(mesEl) {
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat;
        const chatIndex = getChatIndexForMesEl(mesEl);
        const msg = chatIndex != null && chat ? chat[chatIndex] : null;
        if (!msg || msg.is_user || msg.is_system) return;

        const swipeCount = Array.isArray(msg.swipes) ? Math.max(1, msg.swipes.length) : 1;
        const activeSwipe = getSwipeIdFromMsg(msg);

        // Group swipes by their linked user text so identical edits collapse into one
        // entry that lists the swipes it applies to. Preserve first-seen order.
        const groups = [];
        const groupByText = new Map();
        const NONE = Symbol('none');
        for (let i = 0; i < swipeCount; i++) {
            const text = getLinkedUserText(msg, i);
            const key = typeof text === 'string' ? text : NONE;
            let group = groupByText.get(key);
            if (!group) {
                group = { text: typeof text === 'string' ? text : null, swipes: [] };
                groupByText.set(key, group);
                groups.push(group);
            }
            group.swipes.push(i);
        }

        const container = document.createElement('div');
        container.className = 'swipe_edits_popup';
        container.style.textAlign = 'left';
        container.style.maxHeight = '60vh';
        container.style.overflowY = 'auto';

        const heading = document.createElement('h3');
        heading.textContent = 'Linked user edits';
        heading.style.marginTop = '0';
        container.appendChild(heading);

        const sub = document.createElement('div');
        sub.style.opacity = '0.7';
        sub.style.marginBottom = '12px';
        sub.style.fontSize = '0.9em';
        sub.textContent = `${groups.length} distinct edit${groups.length === 1 ? '' : 's'} across ${swipeCount} swipe${swipeCount === 1 ? '' : 's'}. The user text below is what each AI swipe was generated from.`;
        container.appendChild(sub);

        const userIndex = getUserIndexBefore(chatIndex);
        const canonical = userIndex != null ? getUserDisplayText(chat[userIndex]) : null;

        for (const group of groups) {
            const block = document.createElement('div');
            block.style.border = '1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.15))';
            block.style.borderRadius = '8px';
            block.style.padding = '8px 10px';
            block.style.marginBottom = '10px';

            const label = document.createElement('div');
            label.style.fontSize = '0.85em';
            label.style.opacity = '0.8';
            label.style.marginBottom = '6px';
            const swipeNums = group.swipes.map((s) => {
                const oneBased = `#${s + 1}`;
                return s === activeSwipe ? `${oneBased} (current)` : oneBased;
            }).join(', ');
            const tags = [];
            if (group.swipes.includes(activeSwipe)) tags.push('current');
            if (canonical != null && group.text != null && group.text.trim() === canonical.trim()) tags.push('matches latest message');
            label.textContent = `Swipe ${swipeNums}${tags.length ? ' — ' + tags.join(', ') : ''}`;
            block.appendChild(label);

            const body = document.createElement('div');
            body.style.whiteSpace = 'pre-wrap';
            body.style.wordBreak = 'break-word';
            if (group.text == null) {
                body.style.fontStyle = 'italic';
                body.style.opacity = '0.6';
                body.textContent = 'No recorded edit (uses the latest message text).';
            } else if (group.text.trim() === '') {
                body.style.fontStyle = 'italic';
                body.style.opacity = '0.6';
                body.textContent = '(empty)';
            } else {
                body.textContent = group.text;
            }
            block.appendChild(body);
            container.appendChild(block);
        }

        if (typeof ctx.callGenericPopup === 'function' && ctx.POPUP_TYPE) {
            ctx.callGenericPopup(container, ctx.POPUP_TYPE.DISPLAY, '', { wide: true });
        } else if (typeof ctx.callPopup === 'function') {
            ctx.callPopup(container.outerHTML, 'text');
        }
    }

    // ─── Delegated Click Handler ─────────────────────────────────────────────────

    function onDocumentClick(e) {
        const target = e.target;
        if (!(target instanceof Element)) return;

        // "View linked edits" button — handled regardless of swipe-detection mode.
        const editsBtn = target.closest(`.${EDITS_BUTTON_CLASS}`);
        if (editsBtn) {
            const mesEl = editsBtn.closest('.mes');
            if (mesEl) showEditsPopup(mesEl);
            return;
        }

        // If MESSAGE_SWIPED event is available, let it handle swipe detection
        if (hasMessageSwipedEvent) return;

        const btn = target.closest('.swipe_left, .swipe_right');
        if (!btn) return;
        const mesEl = btn.closest('.mes');
        const chatIndex = mesEl ? getChatIndexForMesEl(mesEl) : null;
        const assistantIndexOrMesId = chatIndex != null ? getMesIdFromChatIndex(chatIndex) : null;
        // Allow ST to process the swipe first, then check
        requestAnimationFrame(() => scheduleSwipeCheck(assistantIndexOrMesId));
    }

    // ─── Init / Teardown ─────────────────────────────────────────────────────────

    function bindEvent(eventSource, eventName, handler) {
        if (!eventSource || !eventName || typeof handler !== 'function') return;
        eventSource.on(eventName, handler);
        eventSubscriptions.push({ eventSource, eventName, handler });
    }

    function unbindAllEvents() {
        for (const { eventSource, eventName, handler } of eventSubscriptions.splice(0, eventSubscriptions.length)) {
            try {
                if (typeof eventSource?.removeListener === 'function') {
                    eventSource.removeListener(eventName, handler);
                } else if (typeof eventSource?.off === 'function') {
                    eventSource.off(eventName, handler);
                }
            } catch (e) {
                console.warn(`[${EXTENSION_NAME}] Failed to remove listener`, eventName, e);
            }
        }
    }

    function removeAllEditsButtons() {
        document.querySelectorAll(`.${EDITS_BUTTON_CLASS}`).forEach((el) => el.remove());
    }

    function teardown() {
        unbindAllEvents();
        clearState();
        removeAllEditsButtons();
        hasMessageSwipedEvent = false;
        document.removeEventListener('click', onDocumentClick);
        document.removeEventListener('DOMContentLoaded', bootWithRuntimeBus);
        if (globalThis.swipeLinkedUserEditTeardown === teardown) {
            delete globalThis.swipeLinkedUserEditTeardown;
        }
        if (globalThis[INSTANCE_KEY] === instanceToken) {
            delete globalThis[INSTANCE_KEY];
        }
        log('Extension torn down');
    }

    globalThis.swipeLinkedUserEditTeardown = teardown;

    function init() {
        if (!isCurrentInstance()) return;
        const ctx = SillyTavern.getContext();
        const { eventSource, event_types } = ctx;

        if (!eventSource || !event_types) {
            console.error(`[${EXTENSION_NAME}] SillyTavern context missing eventSource/event_types`);
            return;
        }

        unbindAllEvents();
        document.removeEventListener('click', onDocumentClick);

        // Register event handlers
        bindEvent(eventSource, event_types.CHAT_CHANGED, onChatChanged);
        bindEvent(eventSource, event_types.GENERATION_AFTER_COMMANDS, onGenerationAfterCommands);
        if (event_types.GENERATION_STARTED) {
            bindEvent(eventSource, event_types.GENERATION_STARTED, onGenerationStarted);
        }
        bindEvent(eventSource, event_types.MESSAGE_RECEIVED, onMessageReceived);
        if (event_types.MESSAGE_UPDATED) {
            bindEvent(eventSource, event_types.MESSAGE_UPDATED, onMessageUpdated);
        }
        if (event_types.MESSAGE_EDITED) {
            bindEvent(eventSource, event_types.MESSAGE_EDITED, onMessageEdited);
        }
        bindEvent(eventSource, event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);
        bindEvent(eventSource, event_types.GENERATION_ENDED, onGenerationEnded);
        bindEvent(eventSource, event_types.GENERATION_STOPPED, onGenerationEnded);
        bindEvent(eventSource, event_types.MESSAGE_SENT, onMessageSent);
        hasMessageSwipedEvent = false;
        if (event_types.MESSAGE_SWIPED) {
            hasMessageSwipedEvent = true;
            bindEvent(eventSource, event_types.MESSAGE_SWIPED, onMessageSwiped);
        }
        if (event_types.MESSAGE_DELETED) {
            bindEvent(eventSource, event_types.MESSAGE_DELETED, onMessageDeleted);
        }
        if (event_types.MESSAGE_SWIPE_DELETED) {
            bindEvent(eventSource, event_types.MESSAGE_SWIPE_DELETED, onMessageSwipeDeleted);
        }

        // Delegated click handler for swipe buttons
        document.addEventListener('click', onDocumentClick);

        // Initial capture for already-loaded chat
        requestAnimationFrame(() => {
            if (!isCurrentInstance()) return;
            lastChatId = ctx.chatId || null;
            captureCurrentState();
            attachObserver();
            // On first load the chat may already be sitting on a non-latest swipe.
            // Render its linked user bubble (no-op when no mapping exists).
            scheduleSwipeRenderAfterFrame(null, { skipWhileGenerating: true });
            scheduleEditsButtonsForLoadedChat();
        });

        log('Extension initialized');
    }

    function boot(retries = 0) {
        if (!isCurrentInstance()) return;
        const maxRetries = 100;
        if (!globalThis.SillyTavern?.getContext) {
            if (retries < maxRetries) return setTimeout(() => boot(retries + 1), 100);
            console.error(`[${EXTENSION_NAME}] SillyTavern not available`);
            return;
        }
        const ctx = globalThis.SillyTavern.getContext();
        if (!ctx?.eventSource || !ctx?.event_types) {
            if (retries < maxRetries) return setTimeout(() => boot(retries + 1), 100);
            console.error(`[${EXTENSION_NAME}] SillyTavern context missing eventSource/event_types`);
            return;
        }
        init();
    }

    async function bootWithRuntimeBus() {
        if (!isCurrentInstance()) return;
        const runtimeBus = globalThis.STRuntimeBus;
        if (!runtimeBus?.waitForContext) {
            boot();
            return;
        }

        try {
            await runtimeBus.waitForContext({ timeoutMs: 10000 });
            if (!isCurrentInstance()) return;
            init();
        } catch (error) {
            console.warn(`[${EXTENSION_NAME}] Runtime bus context wait failed; falling back to local boot`, error);
            boot();
        }
    }

    // Run init once DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootWithRuntimeBus, { once: true });
    } else {
        bootWithRuntimeBus();
    }
})();
