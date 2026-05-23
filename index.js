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
    const MAX_MAP_ENTRIES = 100; // Safety limit for map size
    const mesElCache = new Map(); // mesId -> Element cache for getMesElByIndex
    let lastMesElCache = { user: null, assistant: null }; // cached results for getLastMesEl
    const eventSubscriptions = [];

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

    function setMapping(assistantMesId, swipeId, userText, { setActive = false, source = '' } = {}) {
        if (!Number.isFinite(assistantMesId) || !Number.isFinite(swipeId)) return null;
        if (typeof userText !== 'string') return null;

        const key = `${assistantMesId}:${swipeId}`;
        map.set(key, userText);

        let evicted = 0;
        while (map.size > MAX_MAP_ENTRIES) {
            const oldestKey = map.keys().next().value;
            if (typeof oldestKey !== 'string') break;
            map.delete(oldestKey);
            if (activeKey === oldestKey && !setActive) {
                activeKey = null;
            }
            evicted++;
        }

        if (setActive) {
            activeKey = map.has(key) ? key : null;
        }

        if (source) {
            log(source, 'stored mapping', key, '->', userText.substring(0, 60));
        }
        if (evicted > 0) {
            log('setMapping evicted', evicted, 'old map entries');
        }

        return key;
    }

    function parseMappingKey(key) {
        if (typeof key !== 'string') return null;
        const m = /^([0-9]+):([0-9]+)$/.exec(key);
        if (!m) return null;
        return { assistantMesId: Number(m[1]), swipeId: Number(m[2]) };
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
                setMapping(assistantMesId, 0, originalUserText, { source: 'ensureMappingForAssistantMesId' });
            }
        }

        // Also ensure mapping for the currently selected assistant swipe.
        const swipeId = resolveSwipeId(assistantMesId, aiMsg);
        const currentUserText = typeof userMsg?.mes === 'string' ? userMsg.mes : originalUserText;
        if (typeof currentUserText === 'string' && shouldBackfillSwipeMapping(userMsg, swipeId)) {
            const key = `${assistantMesId}:${swipeId}`;
            if (!map.has(key)) {
                setMapping(assistantMesId, swipeId, currentUserText, { setActive: true, source: 'ensureMappingForAssistantMesId' });
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
                pendingNormalUserText,
                pendingEditedEntry,
                generationContext,
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
            const chatIndex = findChatIndexByMesId(id);
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
        return typeof chat[userIdx]?.mes === 'string' ? chat[userIdx].mes : null;
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

    function pruneMappingsForDeletedAssistants() {
        let pruned = 0;
        for (const key of Array.from(map.keys())) {
            const parsed = parseMappingKey(key);
            if (!parsed || !doesAssistantExistForMesId(parsed.assistantMesId)) {
                map.delete(key);
                pruned++;
            }
        }
        if (pruned > 0) {
            log('pruned stale mappings:', pruned);
        }
        return pruned;
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

        refreshActiveKeyFromChat();
        let sourceKey = activeKey;
        if (normalizedType === 'swipe' && (!sourceKey || !map.has(sourceKey)) && pendingSwipeGenerationKey && map.has(pendingSwipeGenerationKey)) {
            sourceKey = pendingSwipeGenerationKey;
            log('captureGenerationContext – using pre-overswipe key', sourceKey, 'at', capturedAt);
        }
        pendingSwipeGenerationKey = null;

        const parsed = parseMappingKey(sourceKey);
        let sourceUserText = null;
        if (pendingEditedEntry && sourceKey && pendingEditedEntry.key === sourceKey && typeof pendingEditedEntry.text === 'string') {
            sourceUserText = pendingEditedEntry.text;
        }
        if (typeof sourceUserText !== 'string' && sourceKey) {
            const mappedText = map.get(sourceKey);
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
        };

        generationKey = generationContext.sourceKey;
        pendingUserText = generationContext.sourceUserText;
        return generationContext;
    }

    // ─── Capture / Store ─────────────────────────────────────────────────────────

    /**
     * Capture the initial mapping for the current pair so that the "before-edit"
     * variant is also tracked even if no generation happened while the ext was loaded.
     */
    function captureCurrentState() {
        const aiIdx = getLastAssistantIndexFromChat();
        const chat = SillyTavern.getContext().chat;
        const aiMsg = aiIdx != null && chat ? chat[aiIdx] : null;
        const userIdx = getUserIndexBefore(aiIdx);
        const userMsg = userIdx != null && chat ? chat[userIdx] : null;
        const userMes = typeof userMsg?.mes === 'string' ? userMsg.mes : null;
        if (typeof userMes !== 'string' || !aiMsg) return;

        const assistantMesId = getMesIdFromChatIndex(aiIdx);
        const swipeId = resolveSwipeId(assistantMesId, aiMsg);
        const key = `${assistantMesId}:${swipeId}`;
        activeKey = key;
        if (shouldBackfillSwipeMapping(userMsg, swipeId)) {
            if (!map.has(key)) {
                setMapping(assistantMesId, swipeId, userMes, { setActive: true, source: 'captureCurrentState' });
            }
        }

        // Also backfill original swipe 0 mapping if possible.
        const originalUserText = getOriginalUserTextFromMsg(userMsg);
        if (typeof originalUserText === 'string') {
            const key0 = `${assistantMesId}:0`;
            if (!map.has(key0)) {
                setMapping(assistantMesId, 0, originalUserText, { source: 'captureCurrentState' });
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

        const userEl = getMesElForChatIndex(userIndex);
        if (!userEl) {
            log('Could not resolve exact user message DOM element for index', userIndex);
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
        map.clear();
        detachObserver();
        invalidateMesElCache();
        if (swipeDebounceTimer) {
            clearTimeout(swipeDebounceTimer);
            swipeDebounceTimer = null;
        }
        log('State cleared');
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
        });
    }

    function onGenerationAfterCommands(type, _generateOptions, dryRun) {
        if (dryRun === true) return;
        if (!shouldTrackGenerationType(type)) return;

        isGenerating = true;
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
        generationType = normalizeGenerationEventType(type) || generationType;
        pendingGenerationType = generationType;
        didReceiveMessageForGeneration = false;
        if (generationType === 'normal') {
            captureGenerationContext(generationType, { capturedAt: 'started', overwrite: true });
        } else {
            captureGenerationContext(generationType, { capturedAt: 'started', overwrite: true });
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

        const chatIndex = findChatIndexByMesId(messageIndex);
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
                if (userIdx != null && typeof chat[userIdx]?.mes === 'string') {
                    userTextForMapping = chat[userIdx].mes;
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
                const mappedText = map.get(keyUsedForGeneration);
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
        });
        if (!storedKey) return;
        didReceiveMessageForGeneration = true;
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
        const preserveForLateMessage = !didReceiveMessageForGeneration && shouldTrackGenerationType(pendingGenerationType);

        isGenerating = false;
        pendingSwipeGenerationKey = null;

        if (!didReceiveMessageForGeneration && !preserveForLateMessage && pendingUserText) {
            log('GENERATION_ENDED – no MESSAGE_RECEIVED for tracked generation; skipped fallback mapping write');
        }
        if (preserveForLateMessage) {
            log('GENERATION_ENDED – preserving context for late MESSAGE_RECEIVED', pendingGenerationType, generationKey);
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
        const chat = SillyTavern.getContext().chat;
        if (!chat || messageIndex == null) return;

        const editedIndex = findChatIndexByMesId(messageIndex);
        const lastUserIndex = getLastUserIndexFromChat();
        if (editedIndex == null || lastUserIndex == null) return;
        if (editedIndex !== lastUserIndex || !chat[editedIndex]?.is_user) {
            return; // Track only latest user/assistant turn pair.
        }

        refreshActiveKeyFromChat();
        const keyAtEdit = activeKey;
        if (!keyAtEdit) {
            log('MESSAGE_EDITED – no active key, skipped keyed edit capture');
            return;
        }

        let editedText = typeof chat[editedIndex]?.mes === 'string' ? chat[editedIndex].mes : null;
        if (typeof editedText !== 'string') {
            editedText = getUserMesFromDomByMesId(getMesIdFromChatIndex(editedIndex));
        }
        if (typeof editedText !== 'string') return;

        pendingEditedEntry = { key: keyAtEdit, text: editedText };
        log('MESSAGE_EDITED – pending keyed edit updated:', keyAtEdit, editedText.substring(0, 60));
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

        const pruned = pruneMappingsForDeletedAssistants();

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
        log('MESSAGE_DELETED – pruned stale mappings and rebuilding current state', pruned);

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

        const assistantMesId = getMesIdFromChatIndex(messageId);
        if (assistantMesId == null) return;

        // 1. Delete the mapping for the removed swipe
        const deletedKey = `${assistantMesId}:${swipeId}`;
        map.delete(deletedKey);

        if (pendingEditedEntry && typeof pendingEditedEntry.key === 'string') {
            const parsed = parseMappingKey(pendingEditedEntry.key);
            if (parsed && parsed.assistantMesId === assistantMesId) {
                if (parsed.swipeId === swipeId) {
                    pendingEditedEntry = null;
                } else if (parsed.swipeId > swipeId) {
                    pendingEditedEntry = {
                        key: `${assistantMesId}:${parsed.swipeId - 1}`,
                        text: pendingEditedEntry.text,
                    };
                }
            }
        }

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
            if (typeof value === 'string') {
                setMapping(assistantMesId, oldIdx - 1, value, { source: 'MESSAGE_SWIPE_DELETED' });
            }
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
        const chat = SillyTavern.getContext().chat;
        let sentUserText = null;
        if (chat && messageIndex != null) {
            const chatIndex = findChatIndexByMesId(messageIndex);
            if (chatIndex != null) {
                const msg = chat[chatIndex];
                if (msg?.is_user && typeof msg.mes === 'string') {
                    sentUserText = msg.mes;
                }
            }
        }
        if (typeof sentUserText !== 'string') {
            sentUserText = getLastUserMesFromChat() || getLastUserMesFromDom();
        }
        pendingNormalUserText = typeof sentUserText === 'string' ? sentUserText : null;
        pendingEditedEntry = null;
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

    globalThis.swipeLinkedUserEditInterceptor = async function (chat, _contextSize, _abort, _type) {
        const interceptorType = normalizeGenerationEventType(_type);
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

        // Validate key belongs to the current assistant message for types that
        // keep the assistant row in place (swipe/continue). Regenerate can
        // delete the source assistant before interceptors run.
        const keyAssistantMesId = parsedKey.assistantMesId;
        const lastAiIdx = getLastAssistantIndexFromChat();
        const lastAiMesId = lastAiIdx != null ? getMesIdFromChatIndex(lastAiIdx) : null;
        const requireAssistantMatch = interceptorType === 'swipe' || interceptorType === 'continue';
        if (requireAssistantMatch) {
            if (lastAiMesId != null && keyAssistantMesId !== lastAiMesId) {
                log('Interceptor: key assistant', keyAssistantMesId, 'does not match last assistant', lastAiMesId, '— skipping patch');
                return;
            }
        } else if (interceptorType === 'regenerate' && lastAiMesId != null && keyAssistantMesId !== lastAiMesId) {
            log('Interceptor: allowing regenerate key assistant mismatch', keyAssistantMesId, lastAiMesId);
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
            const mappedText = map.get(keyToUse);
            if (typeof mappedText === 'string') {
                textSource = 'mapped';
                textToPatch = mappedText;
            }
        }
        if (typeof textToPatch !== 'string') {
            skipPatch('missing_text', { type: interceptorType, keyToUse });
            return;
        }

        // For swipe-like prompt shapes, always patch the latest user row in interceptor chat.
        let userIdx = -1;
        for (let i = chat.length - 1; i >= 0; i--) {
            if (chat[i]?.is_user) {
                userIdx = i;
                break;
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

    function teardown() {
        unbindAllEvents();
        clearState();
        hasMessageSwipedEvent = false;
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

    async function bootWithRuntimeBus() {
        const runtimeBus = globalThis.STRuntimeBus;
        if (!runtimeBus?.waitForContext) {
            boot();
            return;
        }

        try {
            await runtimeBus.waitForContext({ timeoutMs: 10000 });
            init();
        } catch (error) {
            console.warn(`[${EXTENSION_NAME}] Runtime bus context wait failed; falling back to local boot`, error);
            boot();
        }
    }

    // Run init once DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootWithRuntimeBus);
    } else {
        bootWithRuntimeBus();
    }
})();
