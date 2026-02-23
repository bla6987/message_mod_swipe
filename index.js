(function () {
    'use strict';

    const EXTENSION_NAME = 'swipe_linked_user_edit';

    // ─── State ────────────────────────────────────────────────────────────────────
    let activeKey = null;
    let pendingUserText = null;
    const map = new Map(); // `${assistantMesId}:${swipeId}` -> userText
    let observer = null;
    let isGenerating = false;
    let swipeDebounceTimer = null;
    let interceptorRestore = null;
    let lastChatId = null;
    let currentAssistantMesId = null; // Track current assistant for map cleanup
    let hasMessageSwipedEvent = false; // True if MESSAGE_SWIPED event is available
    let generationKey = null; // Key captured at generation start for interceptor use
    let generationType = null; // Active generation type (normal/swipe/regenerate/continue/etc.)
    let didReceiveMessageForGeneration = false; // True once MESSAGE_RECEIVED arrives for current generation
    let pendingSwipeGenerationKey = null; // Previous swipe key captured before overswipe generation
    const MAX_MAP_ENTRIES = 100; // Safety limit for map size
    const mesElCache = new Map(); // mesId -> Element cache for getMesElByIndex
    let lastMesElCache = { user: null, assistant: null }; // cached results for getLastMesEl

    /**
     * Cleanup map entries and enforce size limit.
     * Called when storing a new mapping after generation.
     * Only enforces max size limit (FIFO eviction) - don't delete entries based on
     * assistant change since user may swipe back to earlier messages.
     */
    function cleanupMapEntries(newAssistantMesId) {
        currentAssistantMesId = newAssistantMesId;

        // Enforce max size limit (FIFO eviction)
        if (map.size > MAX_MAP_ENTRIES) {
            let evicted = 0;
            const toEvict = map.size - MAX_MAP_ENTRIES;
            for (const k of map.keys()) {
                if (evicted >= toEvict) break;
                map.delete(k);
                evicted++;
            }
            log('Evicted', evicted, 'old map entries');
        }
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────────

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

    function restoreUserBubbleFromChat(mesEl) {
        if (!mesEl) return;
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat;
        if (!chat) return;

        const mesIdRaw = mesEl.getAttribute('mesid') || mesEl.getAttribute('data-mesid') || mesEl.getAttribute('data-message-id');
        if (mesIdRaw == null) return;
        const mesId = Number(mesIdRaw);
        if (!Number.isFinite(mesId)) return;

        const chatIndex = findChatIndexByMesId(mesId);
        if (chatIndex == null) return;
        const msg = chat[chatIndex];
        if (!msg || !msg.is_user) return;

        const textEl = getMesTextEl(mesEl);
        if (!textEl) return;
        const rawText = msg.extra?.display_text ?? msg.mes;
        if (typeof rawText !== 'string') return;

        textEl.innerHTML = formatUserMessageText(rawText, chatIndex);
    }

    function getOriginalUserTextFromMsg(userMsg) {
        if (!userMsg) return null;
        if (Array.isArray(userMsg.swipes) && userMsg.swipes.length) {
            for (let i = 0; i < userMsg.swipes.length; i++) {
                const t = extractSwipeText(userMsg.swipes[i]);
                if (typeof t === 'string' && t.trim() !== '') return t;
            }
        }
        return typeof userMsg.mes === 'string' ? userMsg.mes : null;
    }

    function ensureMappingForAssistantMesId(assistantMesId) {
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat;
        if (!chat) return;

        const aiIdx = findChatIndexByMesId(assistantMesId);
        if (aiIdx == null) return;
        const aiMsg = chat[aiIdx];
        if (!aiMsg || aiMsg.is_user || aiMsg.is_system) return;

        const userIdx = getUserIndexBefore(aiIdx);
        if (userIdx == null) return;
        const userMsg = chat[userIdx];

        // Always try to ensure swipe 0 has a mapping (original variant).
        const originalUserText = getOriginalUserTextFromMsg(userMsg);
        if (typeof originalUserText === 'string') {
            const key0 = `${assistantMesId}:0`;
            if (!map.has(key0)) {
                map.set(key0, originalUserText);
                log('ensureMappingForAssistantMesId – stored mapping', key0, '->', originalUserText.substring(0, 60));
            }
        }

        // Also ensure mapping for the currently selected assistant swipe.
        const swipeId = resolveSwipeId(assistantMesId, aiMsg);
        const currentUserText = typeof userMsg?.mes === 'string' ? userMsg.mes : originalUserText;
        if (typeof currentUserText === 'string' && shouldBackfillSwipeMapping(userMsg, swipeId)) {
            const key = `${assistantMesId}:${swipeId}`;
            if (!map.has(key)) {
                map.set(key, currentUserText);
                log('ensureMappingForAssistantMesId – stored mapping', key, '->', currentUserText.substring(0, 60));
            }
        }
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
                activeKey,
                mapSize: map.size,
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

    function invalidateMesElCache() {
        mesElCache.clear();
        lastMesElCache.user = null;
        lastMesElCache.assistant = null;
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

        const normalizeId = (v) => {
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
        };

        const els = document.querySelectorAll('#chat .mes');
        for (let i = els.length - 1; i >= 0; i--) {
            const el = els[i];
            const candidates = [
                el.getAttribute('mesid'),
                el.getAttribute('data-mesid'),
                el.getAttribute('data-message-id'),
                el.dataset?.mesid,
                el.dataset?.mesId,
                el.dataset?.messageId,
                el.id,
            ];
            for (const c of candidates) {
                const n = normalizeId(c);
                if (n === index) {
                    mesElCache.set(index, el);
                    return el;
                }
            }
        }
        return null;
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

    function shouldBackfillSwipeMapping(_userMsg, _swipeId) {
        // Always allow backfill for any swipeId we don't have a mapping for.
        // The existence check happens at call sites (map.has(key)).
        // Previous logic incorrectly conflated user message swipes with assistant swipe mappings.
        return true;
    }

    /**
     * Get the swipe ID from a message object.
     * Prefer swipe_id because it tracks the currently selected swipe.
     * Fall back to swipes length only when swipe_id is unavailable.
     */
    function getSwipeIdFromMsg(msg) {
        // Prefer the active swipe pointer first.
        if (typeof msg?.swipe_id === 'number') {
            if (Array.isArray(msg?.swipes) && msg.swipes.length > 0) {
                return Math.max(0, Math.min(msg.swipes.length - 1, msg.swipe_id));
            }
            return Math.max(0, msg.swipe_id);
        }
        // Fall back to the last known swipe when swipe_id is unavailable.
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
        const chat = SillyTavern.getContext().chat;
        if (!chat || mesId == null) return null;
        for (let i = chat.length - 1; i >= 0; i--) {
            const msg = chat[i];
            if (!msg) continue;
            const mid = msg.mesid ?? msg.mesId ?? msg.message_id;
            if (mid === mesId) return i;
            if (typeof mid === 'string' && String(mesId) === mid) return i;
        }
        // If it looks like an index and is in range, allow it.
        if (typeof mesId === 'number' && mesId >= 0 && mesId < chat.length) return mesId;
        return null;
    }

    function mesIdExistsInChat(mesId) {
        const chat = SillyTavern.getContext().chat;
        if (!chat || mesId == null) return false;
        for (let i = 0; i < chat.length; i++) {
            const msg = chat[i];
            if (!msg) continue;
            const mid = msg.mesid ?? msg.mesId ?? msg.message_id;
            if (mid === mesId) return true;
            if (typeof mid === 'string' && String(mesId) === mid) return true;
        }
        if (typeof mesId === 'number' && mesId >= 0 && mesId < chat.length) {
            const candidate = chat[mesId];
            return Boolean(candidate && !candidate.is_user && !candidate.is_system);
        }
        return false;
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
            if (chat[i]?.is_user) return chat[i].mes;
        }
        return null;
    }

    function getLastAssistantMesFromChat() {
        const chat = SillyTavern.getContext().chat;
        if (!chat) return null;
        for (let i = chat.length - 1; i >= 0; i--) {
            const m = chat[i];
            if (m && !m.is_user && !m.is_system) return m.mes;
        }
        return null;
    }

    // ─── Capture / Store ─────────────────────────────────────────────────────────

    /**
     * Capture the initial mapping for the current pair so that the "before-edit"
     * variant is also tracked even if no generation happened while the ext was loaded.
     */
    function captureCurrentState() {
        const userMes = getLastUserMesFromChat();
        const aiIdx = getLastAssistantIndexFromChat();
        const chat = SillyTavern.getContext().chat;
        const aiMsg = aiIdx != null && chat ? chat[aiIdx] : null;
        if (!userMes || !aiMsg) return;

        const userIdx = getUserIndexBefore(aiIdx);
        const userMsg = userIdx != null && chat ? chat[userIdx] : null;

        const assistantMesId = getMesIdFromChatIndex(aiIdx);
        const swipeId = resolveSwipeId(assistantMesId, aiMsg);
        if (shouldBackfillSwipeMapping(userMsg, swipeId)) {
            const key = `${assistantMesId}:${swipeId}`;
            if (!map.has(key)) {
                map.set(key, userMes);
                activeKey = key;
                log('captureCurrentState', key, userMes.substring(0, 60));
            }
        }

        // Also backfill original swipe 0 mapping if possible.
        const originalUserText = getOriginalUserTextFromMsg(userMsg);
        if (typeof originalUserText === 'string') {
            const key0 = `${assistantMesId}:0`;
            if (!map.has(key0)) {
                map.set(key0, originalUserText);
                log('captureCurrentState', key0, originalUserText.substring(0, 60));
            }
        }
    }

    function clearAnySwipeLinkedHighlight() {
        const highlighted = document.querySelectorAll('#chat .mes[data-swipe-linked="1"]');
        highlighted.forEach((el) => {
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

        const userEl = getMesElByIndex(getMesIdFromChatIndex(userIndex)) || getLastMesEl(true);
        if (!userEl) {
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
        const userText = map.get(activeKey);
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

        const userEl = getMesElByIndex(getMesIdFromChatIndex(userIndex)) || getLastMesEl(true);
        if (!userEl) {
            log('Could not resolve user message DOM element for index', userIndex);
            clearAnySwipeLinkedHighlight();
            return;
        }
        const textEl = getMesTextEl(userEl);
        if (!textEl) {
            clearAnySwipeLinkedHighlight();
            return;
        }

        // Compare stored text against the canonical user message in chat data.
        // Only highlight if the text was actually modified for this swipe variant.
        const chat = SillyTavern.getContext().chat;
        const originalUserText = chat && chat[userIndex] ? chat[userIndex].mes : null;
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
            if (aiIdx == null && typeof assistantIndexOrMesId === 'number' && assistantIndexOrMesId >= 0 && assistantIndexOrMesId < chat.length) {
                aiIdx = assistantIndexOrMesId;
            }
        } else {
            aiIdx = getLastAssistantIndexFromChat();
        }
        if (aiIdx == null) return;
        const aiMsg = chat[aiIdx];
        if (!aiMsg) return;
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
        if (!map.has(activeKey)) {
            log('No mapping for key', activeKey);
            clearUserBubbleHighlightForActiveKey();
            return;
        }
        updateUserBubbleForActiveKey();
    }

    function scheduleSwipeCheck() {
        if (swipeDebounceTimer) clearTimeout(swipeDebounceTimer);
        swipeDebounceTimer = setTimeout(handleSwipeChange, 200);
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
        const aiIdx = getLastAssistantIndexFromChat();
        const aiEl = (aiIdx != null ? getMesElByIndex(getMesIdFromChatIndex(aiIdx)) : null) || getLastMesEl(false);
        const textEl = getMesTextEl(aiEl);
        if (!textEl) {
            log('attachObserver: no assistant text element found');
            return;
        }
        observer = new MutationObserver((mutations) => {
            // Only use MutationObserver for swipe detection if MESSAGE_SWIPED event is unavailable
            if (hasMessageSwipedEvent) return;
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
        generationKey = null;
        generationType = null;
        didReceiveMessageForGeneration = false;
        pendingSwipeGenerationKey = null;
        map.clear();
        currentAssistantMesId = null;
        detachObserver();
        invalidateMesElCache();
        if (swipeDebounceTimer) {
            clearTimeout(swipeDebounceTimer);
            swipeDebounceTimer = null;
        }
        interceptorRestore = null;
        log('State cleared');
    }

    function restoreInterceptorPatch() {
        if (!interceptorRestore) return;
        const { chat, userIdx, originalMes } = interceptorRestore;
        try {
            // Only restore the mes property, not the entire object.
            // This is safer as it avoids overwriting other properties ST may have modified.
            if (chat && userIdx != null && userIdx >= 0 && chat[userIdx] && originalMes !== undefined) {
                chat[userIdx].mes = originalMes;
                log('Interceptor patch restored');
            }
        } catch (e) {
            console.warn(`[${EXTENSION_NAME}] restore error:`, e);
        }
        interceptorRestore = null;
    }

    // ─── Event Handlers ──────────────────────────────────────────────────────────

    function normalizeMessageIndex(arg) {
        if (typeof arg === 'number') return arg;
        if (typeof arg === 'string' && arg.trim() !== '' && !Number.isNaN(Number(arg))) return Number(arg);
        if (!arg || typeof arg !== 'object') return null;
        if (typeof arg.messageIndex === 'number') return arg.messageIndex;
        if (typeof arg.message_id === 'number') return arg.message_id;
        if (typeof arg.index === 'number') return arg.index;
        if (typeof arg.message_index === 'number') return arg.message_index;
        if (typeof arg.mesid === 'number') return arg.mesid;
        if (typeof arg.mesId === 'number') return arg.mesId;
        if (typeof arg.id === 'number') return arg.id;
        if (typeof arg.mesid === 'string' && arg.mesid.trim() !== '' && !Number.isNaN(Number(arg.mesid))) return Number(arg.mesid);
        if (typeof arg.mesId === 'string' && arg.mesId.trim() !== '' && !Number.isNaN(Number(arg.mesId))) return Number(arg.mesId);
        if (typeof arg.id === 'string' && arg.id.trim() !== '' && !Number.isNaN(Number(arg.id))) return Number(arg.id);
        return null;
    }

    function shouldTrackGenerationType(type) {
        return type !== 'quiet' && type !== 'impersonate';
    }

    function onChatChanged() {
        // Restore any pending interceptor patch before clearing state
        restoreInterceptorPatch();

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
        });
    }

    function onGenerationAfterCommands(type, _generateOptions, dryRun) {
        if (dryRun === true) return;
        if (!shouldTrackGenerationType(type)) return;

        isGenerating = true;
        generationType = typeof type === 'string' ? type : null;
        didReceiveMessageForGeneration = false;

        // Snapshot the current last user message text (may be freshly edited)
        pendingUserText = getLastUserMesFromChat() || getLastUserMesFromDom();

        // Capture the key NOW before any state changes during generation
        refreshActiveKeyFromChat();
        generationKey = activeKey;
        if (generationType === 'swipe' && (!generationKey || !map.has(generationKey)) && pendingSwipeGenerationKey && map.has(pendingSwipeGenerationKey)) {
            generationKey = pendingSwipeGenerationKey;
            log('GENERATION_AFTER_COMMANDS – using pre-overswipe key:', generationKey);
        }
        pendingSwipeGenerationKey = null;

        log('GENERATION_AFTER_COMMANDS – pending:', pendingUserText && pendingUserText.substring(0, 60), 'key:', generationKey);

        // Safety: restore after timeout if generation takes too long or events don't fire
        setTimeout(() => {
            if (interceptorRestore) {
                log('Safety timeout: restoring interceptor patch');
                restoreInterceptorPatch();
            }
        }, 60000); // 60 second safety
    }

    function onGenerationStarted(type, _generateOptions, dryRun) {
        if (dryRun === true) return;
        if (!shouldTrackGenerationType(type)) return;

        isGenerating = true;
        generationType = typeof type === 'string' ? type : generationType;
        didReceiveMessageForGeneration = false;
        if (!pendingUserText) {
            pendingUserText = getLastUserMesFromChat() || getLastUserMesFromDom();
        }
    }

    function onMessageReceived(messageIndex) {
        messageIndex = normalizeMessageIndex(messageIndex);
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat;
        if (!chat || messageIndex == null) return;

        const chatIndex = findChatIndexByMesId(messageIndex);
        if (chatIndex == null) return;

        const msg = chat[chatIndex];
        if (!msg || msg.is_user || msg.is_system) return;

        const aiMes = msg.mes;
        if (!aiMes || !pendingUserText) return;

        const assistantMesId = getMesIdFromChatIndex(chatIndex);
        // Clean up old entries before storing new mapping
        cleanupMapEntries(assistantMesId);

        const swipeId = getSwipeIdFromMsg(msg);
        const key = `${assistantMesId}:${swipeId}`;
        map.set(key, pendingUserText);
        activeKey = key;
        didReceiveMessageForGeneration = true;
        log('MESSAGE_RECEIVED – stored mapping', key, '->', pendingUserText.substring(0, 60));
    }

    function onCharacterMessageRendered(messageIndex) {
        messageIndex = normalizeMessageIndex(messageIndex);
        invalidateMesElCache();
        // Reattach observer to the newest assistant message
        requestAnimationFrame(() => {
            attachObserver();
            // Ensure the currently visible swipe (usually 0) has a mapping.
            const chatIndex = messageIndex != null ? findChatIndexByMesId(messageIndex) : null;
            if (chatIndex != null) {
                const assistantMesId = getMesIdFromChatIndex(chatIndex);
                ensureMappingForAssistantMesId(assistantMesId);
            } else {
                const aiIdx = getLastAssistantIndexFromChat();
                if (aiIdx != null) ensureMappingForAssistantMesId(getMesIdFromChatIndex(aiIdx));
            }
        });
    }

    function onGenerationEnded() {
        isGenerating = false;
        generationKey = null; // Clear the generation-specific key
        pendingSwipeGenerationKey = null;
        restoreInterceptorPatch();

        if (!didReceiveMessageForGeneration && pendingUserText) {
            log('GENERATION_ENDED – no MESSAGE_RECEIVED for tracked generation; skipped fallback mapping write');
        }
        pendingUserText = null;
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
        let aiIdx = messageIndex != null ? findChatIndexByMesId(messageIndex) : getLastAssistantIndexFromChat();
        if (aiIdx == null && typeof messageIndex === 'number' && messageIndex >= 0 && chat && messageIndex < chat.length) {
            aiIdx = messageIndex;
        }
        const aiMsg = aiIdx != null && chat ? chat[aiIdx] : null;
        const isOverswipePending = Boolean(
            aiMsg &&
            Array.isArray(aiMsg.swipes) &&
            typeof aiMsg.swipe_id === 'number' &&
            aiMsg.swipe_id >= aiMsg.swipes.length,
        );
        if (isOverswipePending && previousKey && map.has(previousKey)) {
            pendingSwipeGenerationKey = previousKey;
            log('MESSAGE_SWIPED – captured pre-overswipe key', pendingSwipeGenerationKey);
        } else if (!isGenerating) {
            pendingSwipeGenerationKey = null;
        }

        requestAnimationFrame(() => {
            if (messageIndex != null) {
                refreshActiveKeyFromChat(messageIndex);
            } else {
                refreshActiveKeyFromChat();
            }
            log('Active key after swipe', activeKey);
            if (!activeKey || !map.has(activeKey)) {
                clearUserBubbleHighlightForActiveKey();
                return;
            }
            updateUserBubbleForActiveKey();
        });
    }

    function onMessageUpdated(messageIndex) {
        messageIndex = normalizeMessageIndex(messageIndex);
        if (isGenerating) return;
        requestAnimationFrame(() => {
            refreshActiveKeyFromChat();
            if (!activeKey || !map.has(activeKey)) {
                clearUserBubbleHighlightForActiveKey();
                return;
            }
            updateUserBubbleForActiveKey();
        });
    }

    function onMessageEdited(messageIndex) {
        messageIndex = normalizeMessageIndex(messageIndex);
        // Keep pending text in sync with the latest edit.
        // Prefer chat object for raw markdown; fall back to DOM textContent.
        pendingUserText = getLastUserMesFromChat() || getLastUserMesFromDom();
        log('MESSAGE_EDITED – pending updated:', pendingUserText && pendingUserText.substring(0, 60));
    }

    function onMessageDeleted(_chatLength) {
        invalidateMesElCache();
        // MESSAGE_DELETED only provides chat.length, not which message was deleted.
        // Scan all map keys and remove any whose mesId no longer exists in chat.

        if (map.size === 0) return;

        // Extract unique mesIds from map keys (format: "mesId:swipeId")
        const trackedMesIds = new Set();
        for (const key of map.keys()) {
            const colonIdx = key.indexOf(':');
            if (colonIdx > 0) {
                const mesId = Number(key.substring(0, colonIdx));
                if (Number.isFinite(mesId)) {
                    trackedMesIds.add(mesId);
                }
            }
        }

        // Find which mesIds no longer exist
        const orphanedMesIds = [];
        for (const mesId of trackedMesIds) {
            if (!mesIdExistsInChat(mesId)) {
                orphanedMesIds.push(mesId);
            }
        }

        if (orphanedMesIds.length === 0) return;

        // Remove all mappings for orphaned mesIds
        let removed = 0;
        let activeKeyCleared = false;
        for (const mesId of orphanedMesIds) {
            const prefix = `${mesId}:`;
            for (const key of [...map.keys()]) {
                if (key.startsWith(prefix)) {
                    map.delete(key);
                    removed++;
                }
            }
            // Clear activeKey if it referenced a deleted message
            if (activeKey && activeKey.startsWith(prefix)) {
                activeKey = null;
                activeKeyCleared = true;
            }
        }

        if (activeKeyCleared) {
            clearAnySwipeLinkedHighlight();
        }

        log('MESSAGE_DELETED – removed', removed, 'mappings for', orphanedMesIds.length, 'deleted messages');
    }

    function onMessageSwipeDeleted(data) {
        if (!data || typeof data !== 'object') return;
        const { messageId, swipeId } = data;
        if (typeof messageId !== 'number' || typeof swipeId !== 'number') return;

        const assistantMesId = getMesIdFromChatIndex(messageId);
        if (assistantMesId == null) return;

        // 1. Delete the mapping for the removed swipe
        const deletedKey = `${assistantMesId}:${swipeId}`;
        map.delete(deletedKey);

        // 2. Shift all mappings above the deleted index down by 1
        const toRename = [];
        for (const key of map.keys()) {
            const m = /^(\d+):(\d+)$/.exec(key);
            if (!m) continue;
            if (Number(m[1]) === assistantMesId && Number(m[2]) > swipeId) {
                toRename.push({ oldKey: key, oldIdx: Number(m[2]) });
            }
        }
        // Sort descending so we don't collide during rename
        toRename.sort((a, b) => b.oldIdx - a.oldIdx);
        for (const { oldKey, oldIdx } of toRename) {
            const value = map.get(oldKey);
            map.delete(oldKey);
            map.set(`${assistantMesId}:${oldIdx - 1}`, value);
        }

        log('MESSAGE_SWIPE_DELETED – shifted', toRename.length, 'mappings, deleted key', deletedKey);

        // 3. Refresh active key (MESSAGE_SWIPED will also fire, but be safe)
        refreshActiveKeyFromChat();
        if (!activeKey || !map.has(activeKey)) {
            clearUserBubbleHighlightForAssistant(assistantMesId);
            return;
        }
        updateUserBubbleForActiveKey();
    }

    function onMessageSent(messageIndex) {
        messageIndex = normalizeMessageIndex(messageIndex);
        // Preserve mappings so follow-up assistant generations can patch historical context.
        // Just clear any pending text from an in-flight capture.
        pendingUserText = null;
        pendingSwipeGenerationKey = null;
    }

    // ─── Generate Interceptor ────────────────────────────────────────────────────

    globalThis.swipeLinkedUserEditInterceptor = async function (chat, _contextSize, _abort, _type) {
        if (_type !== 'swipe' && _type !== 'regenerate' && _type !== 'continue') return;

        // Restore any previous patch first
        if (interceptorRestore) restoreInterceptorPatch();

        // Use the key captured at generation start, not current state
        // This avoids race conditions where swipe_id may have changed
        const keyToUse = generationKey || activeKey;
        if (!keyToUse || !map.has(keyToUse)) return;

        const mappedText = map.get(keyToUse);
        if (!mappedText) return;

        const mappedTextStr = typeof mappedText === 'string' ? mappedText : String(mappedText);

        const m = /^([0-9]+):([0-9]+)$/.exec(keyToUse);
        if (!m) return;
        const assistantMesId = Number(m[1]);

        const getMesIdFromMsg = (msg) => {
            if (!msg) return null;
            const mid = msg.mesid ?? msg.mesId ?? msg.message_id;
            if (typeof mid === 'number') return mid;
            if (typeof mid === 'string' && mid.trim() !== '' && !Number.isNaN(Number(mid))) return Number(mid);
            return null;
        };

        // Primary path: locate the mapped assistant in the interceptor chat and take the user immediately before it.
        let assistantIdx = -1;
        for (let i = chat.length - 1; i >= 0; i--) {
            const mid = getMesIdFromMsg(chat[i]);
            if (mid === assistantMesId) {
                assistantIdx = i;
                break;
            }
        }
        let userIdx = -1;
        if (assistantIdx !== -1) {
            for (let i = assistantIdx - 1; i >= 0; i--) {
                if (chat[i]?.is_user) {
                    userIdx = i;
                    break;
                }
            }
        }

        if (userIdx === -1) {
            log('Interceptor assistant lookup miss for key', keyToUse, 'assistantMesId', assistantMesId);

            // Safe fallback: patch the user immediately before the most recent assistant.
            // This avoids rewriting a freshly-sent user message during normal generation.
            let latestAssistantIdx = -1;
            for (let i = chat.length - 1; i >= 0; i--) {
                const candidate = chat[i];
                if (candidate && !candidate.is_user && !candidate.is_system) {
                    latestAssistantIdx = i;
                    break;
                }
            }

            if (latestAssistantIdx !== -1) {
                for (let i = latestAssistantIdx - 1; i >= 0; i--) {
                    if (chat[i]?.is_user) {
                        userIdx = i;
                        log('Interceptor fallback selected user idx', userIdx, 'before assistant idx', latestAssistantIdx);
                        break;
                    }
                }
            }

            // Regenerate/swipe prompt shape can omit assistant rows entirely.
            // In that case, fall back to the last user only for regeneration-like types.
            if (userIdx === -1 && latestAssistantIdx === -1 && (_type === 'swipe' || _type === 'regenerate' || _type === 'continue')) {
                for (let i = chat.length - 1; i >= 0; i--) {
                    if (chat[i]?.is_user) {
                        userIdx = i;
                        log('Interceptor fallback selected last user idx', userIdx, 'for type', _type);
                        break;
                    }
                }
            }
        }
        if (userIdx === -1) return;

        const msg = chat[userIdx];
        // If already matching, skip
        if (msg.mes === mappedTextStr) return;

        // Store only the original mes value for restore (safer than storing whole object)
        const originalMes = msg.mes;
        interceptorRestore = { chat, userIdx, originalMes };

        // Mutate the mes property directly instead of replacing the object.
        // This is safer because if ST modifies other properties during generation,
        // we won't lose those changes when we restore.
        msg.mes = mappedTextStr;
        log('Interceptor patched user msg idx', userIdx, 'with key', keyToUse, 'to:', mappedTextStr.substring(0, 60));
    };

    // ─── Delegated Click Handler ─────────────────────────────────────────────────

    function onDocumentClick(e) {
        // If MESSAGE_SWIPED event is available, let it handle swipe detection
        if (hasMessageSwipedEvent) return;

        const target = e.target;
        if (!(target instanceof Element)) return;
        const btn = target.closest('.swipe_left, .swipe_right');
        if (!btn) return;
        // Allow ST to process the swipe first, then check
        requestAnimationFrame(() => scheduleSwipeCheck());
    }

    // ─── Init / Teardown ─────────────────────────────────────────────────────────

    function teardown() {
        clearState();
        document.removeEventListener('click', onDocumentClick);
        log('Extension torn down');
    }

    globalThis.swipeLinkedUserEditTeardown = teardown;

    function init() {
        const ctx = SillyTavern.getContext();
        const { eventSource, event_types } = ctx;

        if (!eventSource || !event_types) {
            console.error(`[${EXTENSION_NAME}] SillyTavern context missing eventSource/event_types`);
            return;
        }

        // Register event handlers
        eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
        eventSource.on(event_types.GENERATION_AFTER_COMMANDS, onGenerationAfterCommands);
        if (event_types.GENERATION_STARTED) {
            eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
        }
        eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
        if (event_types.MESSAGE_UPDATED) {
            eventSource.on(event_types.MESSAGE_UPDATED, onMessageUpdated);
        }
        if (event_types.MESSAGE_EDITED) {
            eventSource.on(event_types.MESSAGE_EDITED, onMessageEdited);
        }
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);
        eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);
        eventSource.on(event_types.GENERATION_STOPPED, onGenerationEnded);
        eventSource.on(event_types.MESSAGE_SENT, onMessageSent);
        if (event_types.MESSAGE_SWIPED) {
            hasMessageSwipedEvent = true;
            eventSource.on(event_types.MESSAGE_SWIPED, onMessageSwiped);
        }
        if (event_types.MESSAGE_DELETED) {
            eventSource.on(event_types.MESSAGE_DELETED, onMessageDeleted);
        }
        if (event_types.MESSAGE_SWIPE_DELETED) {
            eventSource.on(event_types.MESSAGE_SWIPE_DELETED, onMessageSwipeDeleted);
        }

        // Delegated click handler for swipe buttons
        document.addEventListener('click', onDocumentClick);

        // Initial capture for already-loaded chat
        requestAnimationFrame(() => {
            lastChatId = ctx.chatId || null;
            captureCurrentState();
            attachObserver();
        });

        log('Extension initialized');
    }

    function boot(retries = 0) {
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

    // Run init once DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
