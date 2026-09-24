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

    // Tag globals this instance owns with its instance token so teardown only
    // removes the ones it created. Without this, a partial disable/reload could
    // leave stale functions behind, or tear down a newer instance's globals.
    function exposeOwnedGlobal(name, value) {
        if (value != null) value[INSTANCE_KEY] = instanceToken;
        globalThis[name] = value;
        return value;
    }

    function deleteOwnedGlobal(name) {
        if (globalThis[name]?.[INSTANCE_KEY] === instanceToken) {
            delete globalThis[name];
        }
    }

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
    const pendingEditedEntries = new Map(); // key -> { key, text }, one unconsumed pencil edit per swipe
    const pendingEditKeysUsedForGeneration = new Set(); // retained across recursive tool-generation calls
    let pendingEditCleanupRequested = false; // successful receipt seen; clear used edits when the chain finishes
    let generationContext = null; // { type, sourceKey, sourceAssistantMesId, sourceUserText, capturedAt }
    let generationSeq = 0; // Guards delayed cleanup from previous generation lifecycles
    let swipeRenderSeq = 0; // Guards delayed swipe DOM updates from older events
    let editsButtonScanSeq = 0; // Guards chunked loaded-chat button scans
    const mesElCache = new Map(); // mesId -> Element cache for getMesElByIndex
    let lastMesElCache = { user: null, assistant: null }; // cached results for getLastMesEl
    let generationWatchdogTimer = null; // clears isGenerating if a started generation never progresses
    let lateMessageCleanupTimer = null; // clears context preserved for post-END MESSAGE_RECEIVED ordering
    let generationWasStopped = false; // explicit cancellation tombstone until the next generation starts
    const GENERATION_START_WATCHDOG_MS = 10000; // grace period before treating a stuck generation as aborted
    const GENERATION_AFTER_COMMANDS_WATCHDOG_MS = 30000; // covers later core aborts before generation UI activates
    let stPromptHelpers; // undefined = not tried, null = unavailable, object = SillyTavern prompt-processing fns
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

    function getPendingEditedEntry(key) {
        if (typeof key !== 'string') return null;
        const entry = pendingEditedEntries.get(key);
        return entry && typeof entry.text === 'string' ? entry : null;
    }

    function setPendingEditedEntry(key, text) {
        if (typeof key !== 'string' || typeof text !== 'string') return null;
        // Refresh insertion order so same-assistant fallback uses the newest edit.
        pendingEditedEntries.delete(key);
        const entry = { key, text };
        pendingEditedEntries.set(key, entry);
        return entry;
    }

    function deletePendingEditedEntry(key) {
        if (typeof key !== 'string') return false;
        pendingEditKeysUsedForGeneration.delete(key);
        return pendingEditedEntries.delete(key);
    }

    function markPendingEditUsed(key) {
        if (getPendingEditedEntry(key)) {
            pendingEditKeysUsedForGeneration.add(key);
        }
    }

    /**
     * A pencil edit holds the swipe that was on screen when it was made only
     * until the user browses to another existing variant. Otherwise swiping away
     * and back (e.g. after branching onto an older swipe) would keep showing and
     * sending the edit for a reply that was generated from the earlier text. The
     * edit remains the canonical message text, which the latest swipe and the
     * next regeneration still use.
     */
    function releasePendingEditsForOtherSwipes(assistantMesId, swipeId) {
        for (const entry of Array.from(pendingEditedEntries.values())) {
            const parsed = parseMappingKey(entry.key);
            if (!parsed || parsed.assistantMesId !== assistantMesId || parsed.swipeId === swipeId) continue;
            deletePendingEditedEntry(entry.key);
            log('Released pending edit after swiping away from', entry.key);
        }
    }

    function clearConsumedPendingEdits() {
        let persisted = false;
        for (const key of pendingEditKeysUsedForGeneration) {
            if (persistConsumedEditInHistory(key)) persisted = true;
            pendingEditedEntries.delete(key);
        }
        pendingEditKeysUsedForGeneration.clear();
        pendingEditCleanupRequested = false;
        if (persisted) {
            requestChatSave();
            scheduleSwipeRenderAfterFrame(null);
        }
    }

    /**
     * A consumed edit on the latest reply moves to the swipe generated from it.
     * But when the edited swipe stays selected in history (the user continued
     * from it, or edited an earlier turn), dropping the session-only edit would
     * silently revert the next prompt to that swipe's old link. Pin the edit as
     * the swipe's manual override instead, so it keeps being sent and shown.
     */
    function persistConsumedEditInHistory(key) {
        const entry = getPendingEditedEntry(key);
        const parsed = parseMappingKey(key);
        if (!entry || !parsed) return false;
        const chat = SillyTavern.getContext().chat;
        const assistantIndex = findChatIndexByMesId(parsed.assistantMesId);
        const assistantMsg = assistantIndex != null ? chat?.[assistantIndex] : null;
        if (!assistantMsg || assistantMsg.is_user || assistantMsg.is_system) return false;
        if (assistantIndex === getLastAssistantIndexFromChat()) return false;
        if (getSwipeIdFromMsg(assistantMsg) !== parsed.swipeId) return false;

        const withoutEdit = resolveSelectedSwipeUserText(assistantMsg, null);
        const userIndex = getTurnUserIndex(assistantIndex);
        const sentWithoutEdit = withoutEdit
            ? withoutEdit.text
            : (userIndex != null ? getUserMessageText(chat[userIndex]) : null);
        if (sentWithoutEdit === entry.text) return false;
        if (!setLinkedUserText(assistantMsg, parsed.swipeId, entry.text, { manual: true })) return false;
        ensureEditsButtonForAssistant(parsed.assistantMesId);
        log('Pinned consumed edit on historical swipe', key, '->', entry.text.substring(0, 60));
        return true;
    }

    function abandonPendingEditCleanup() {
        pendingEditKeysUsedForGeneration.clear();
        pendingEditCleanupRequested = false;
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

        const activeSwipeId = typeof assistantMsg.swipe_id === 'number' ? assistantMsg.swipe_id : 0;
        if (swipeId == null) swipeId = activeSwipeId;

        // Per-swipe metadata is authoritative.
        const linkedText = assistantMsg.swipe_info?.[swipeId]?.extra?.linked_user_text;
        if (typeof linkedText === 'string') return linkedText;

        // Only fall back to the mirrored msg.extra value for a never-swiped
        // message (no swipe_info array at all) and only for the active swipe.
        // Once a swipe_info array exists it is the source of truth, so a leftover
        // msg.extra value from a different swipe can't masquerade as this one's.
        if (!Array.isArray(assistantMsg.swipe_info) && swipeId === activeSwipeId) {
            const activeText = assistantMsg.extra?.linked_user_text;
            return typeof activeText === 'string' ? activeText : null;
        }
        return null;
    }

    function setLinkedUserText(assistantMsg, swipeId, userText, { manual = false } = {}) {
        if (!assistantMsg || !Number.isFinite(swipeId) || typeof userText !== 'string') return false;

        // Manual (user-initiated) overrides are flagged so the normal-send patcher
        // honors them even on the latest swipe, where automatic links are assumed
        // to match the canonical text and are skipped. Automatic writes clear the
        // flag because they replace whatever the user had pinned.
        const applyFlag = (extraObj) => {
            if (manual) {
                extraObj.linked_user_text_manual = true;
            } else {
                delete extraObj.linked_user_text_manual;
            }
        };

        let wrote = false;
        // When a swipe_info array exists it is authoritative for reads
        // (getLinkedUserText), so ensure the per-swipe entry exists and carries
        // the text — otherwise the write would land only in msg.extra below and
        // be ignored on read. Do NOT fabricate the array for a never-swiped
        // message: that path is served by the msg.extra fallback and creating
        // swipe_info early could disturb SillyTavern's own swipe bookkeeping.
        if (Array.isArray(assistantMsg.swipe_info)) {
            if (!assistantMsg.swipe_info[swipeId] || typeof assistantMsg.swipe_info[swipeId] !== 'object') {
                assistantMsg.swipe_info[swipeId] = {};
            }
            if (!assistantMsg.swipe_info[swipeId].extra || typeof assistantMsg.swipe_info[swipeId].extra !== 'object') {
                assistantMsg.swipe_info[swipeId].extra = {};
            }
            assistantMsg.swipe_info[swipeId].extra.linked_user_text = userText;
            applyFlag(assistantMsg.swipe_info[swipeId].extra);
            wrote = true;
        }

        const activeSwipeId = typeof assistantMsg.swipe_id === 'number' ? assistantMsg.swipe_id : 0;
        if (swipeId === activeSwipeId) {
            if (!assistantMsg.extra || typeof assistantMsg.extra !== 'object') {
                assistantMsg.extra = {};
            }
            assistantMsg.extra.linked_user_text = userText;
            applyFlag(assistantMsg.extra);
            wrote = true;
        }

        return wrote;
    }

    function isManualLinkedUserText(assistantMsg, swipeId) {
        if (!assistantMsg) return false;
        const activeSwipeId = typeof assistantMsg.swipe_id === 'number' ? assistantMsg.swipe_id : 0;
        if (swipeId == null) swipeId = activeSwipeId;
        // Mirror getLinkedUserText's read precedence: per-swipe metadata is
        // authoritative; msg.extra only serves never-swiped messages.
        const swipeExtra = Array.isArray(assistantMsg.swipe_info) ? assistantMsg.swipe_info[swipeId]?.extra : null;
        if (swipeExtra && typeof swipeExtra.linked_user_text === 'string') {
            return swipeExtra.linked_user_text_manual === true;
        }
        if (!Array.isArray(assistantMsg.swipe_info) && swipeId === activeSwipeId) {
            return assistantMsg.extra?.linked_user_text_manual === true;
        }
        return false;
    }

    function deleteLinkedUserText(assistantMsg, swipeId) {
        if (!assistantMsg || !Number.isFinite(swipeId)) return false;
        let removed = false;
        const swipeExtra = Array.isArray(assistantMsg.swipe_info) ? assistantMsg.swipe_info[swipeId]?.extra : null;
        if (swipeExtra && typeof swipeExtra.linked_user_text === 'string') {
            delete swipeExtra.linked_user_text;
            delete swipeExtra.linked_user_text_manual;
            removed = true;
        }
        const activeSwipeId = typeof assistantMsg.swipe_id === 'number' ? assistantMsg.swipe_id : 0;
        if (swipeId === activeSwipeId && typeof assistantMsg.extra?.linked_user_text === 'string') {
            delete assistantMsg.extra.linked_user_text;
            delete assistantMsg.extra.linked_user_text_manual;
            removed = true;
        }
        return removed;
    }

    /**
     * User-initiated override of the linked text for a set of swipes on one
     * assistant message. `text` is the new linked user text; `null` unlinks the
     * swipes so they fall back to the canonical (latest-edited) message text.
     * Stale session intents (pendingEditedEntries) for the affected keys are
     * dropped so the manual choice is what the next generation actually uses.
     */
    function applyManualLinkedText(assistantMesId, swipeIds, text, { save = true, scheduleRender = true } = {}) {
        const assistantMsg = resolveAssistantMsg(assistantMesId);
        if (!assistantMsg || !Array.isArray(swipeIds)) return false;
        let changed = false;
        for (const swipeId of swipeIds) {
            if (!Number.isFinite(swipeId)) continue;
            if (typeof text === 'string') {
                if (setLinkedUserText(assistantMsg, swipeId, text, { manual: true })) changed = true;
            } else if (deleteLinkedUserText(assistantMsg, swipeId)) {
                changed = true;
            }
            deletePendingEditedEntry(`${assistantMesId}:${swipeId}`);
        }
        if (changed) {
            if (save) requestChatSave();
            ensureEditsButtonForAssistant(assistantMesId);
            if (scheduleRender) scheduleSwipeRenderAfterFrame(assistantMesId);
            log('Manual linked-text override for assistant', assistantMesId, 'swipes', swipeIds,
                text == null ? '(unlinked)' : `-> ${text.substring(0, 60)}`);
        }
        return changed;
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

    /**
     * Record the same linked user text on sibling swipes generated in the SAME
     * batch as the active one (streaming multi-swipe / "generate alternatives"),
     * which SillyTavern appends before MESSAGE_RECEIVED. Siblings are matched by a
     * shared swipe_info.send_date so variants from earlier edits/generations — which
     * legitimately have their own (or no) linked text — are never overwritten.
     */
    function backfillBatchSwipeMappings(assistantMsg, assistantMesId, activeSwipeId, userText) {
        if (!assistantMsg || typeof userText !== 'string') return;
        const swipes = assistantMsg.swipes;
        const swipeInfo = assistantMsg.swipe_info;
        if (!Array.isArray(swipes) || swipes.length <= 1 || !Array.isArray(swipeInfo)) return;
        const activeDate = swipeInfo[activeSwipeId]?.send_date ?? assistantMsg.send_date;
        if (activeDate == null) return;
        let wroteAny = false;
        for (let i = 0; i < swipes.length; i++) {
            if (i === activeSwipeId) continue;
            const info = swipeInfo[i];
            if (!info || info.send_date !== activeDate) continue; // different generation — leave it
            if (typeof info.extra?.linked_user_text === 'string') continue; // already mapped
            if (setLinkedUserText(assistantMsg, i, userText)) wroteAny = true;
        }
        if (wroteAny) {
            requestChatSave();
            log('Backfilled linked text for batch swipe alternatives of assistant', assistantMesId);
        }
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

        const chatIndex = findChatIndexByDomId(mesId);
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

    exposeOwnedGlobal('swipeLinkedUserEditDebug', function () {
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
                pendingEditedEntries: Array.from(pendingEditedEntries.values()),
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
    });

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

    function findChatIndexByDomId(domId) {
        // DOM-derived ids must resolve via the stable mesid mapping only.
        // findChatIndexByMesId keeps a *guarded* array-index fallback for
        // SillyTavern builds without stable ids, but never resolves a stale id
        // onto a row that already carries a different stable id. Avoid the
        // event-style fallback here, which would blindly treat any in-range
        // number as an array index and could target the wrong message.
        return findChatIndexByMesId(domId);
    }

    function getChatIndexForMesEl(el) {
        for (const id of getMesIdsFromElement(el)) {
            const chatIndex = findChatIndexByDomId(id);
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

        // Return cached element only if it is still in the DOM AND still carries
        // this index. A message move (messageEditMove) swaps mesids on existing
        // nodes without an event we handle, so a still-connected cached node can
        // now belong to a different index — re-validate before trusting it.
        const cached = mesElCache.get(index);
        if (cached && cached.isConnected && getMesIdsFromElement(cached).includes(index)) return cached;
        if (cached) mesElCache.delete(index);

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

    /**
     * Resolve the text that should be used when generating from a selected swipe.
     * A pending pencil edit wins. For the latest automatic swipe, canonical chat
     * text wins over persisted metadata because the session-only edit marker may
     * have been lost to a reload. Older swipes and manual overrides remain linked.
     */
    function getPreferredUserTextForKey(key) {
        const pending = getPendingEditedEntry(key);
        if (pending) return { text: pending.text, source: 'edited' };

        const parsed = parseMappingKey(key);
        const assistantMsg = parsed ? resolveAssistantMsg(parsed.assistantMesId) : null;
        if (assistantMsg && parsed) {
            const swipes = Array.isArray(assistantMsg.swipes) ? assistantMsg.swipes : null;
            const isLatestOrOnlySwipe = !swipes || parsed.swipeId >= swipes.length - 1;
            if (isLatestOrOnlySwipe && !isManualLinkedUserText(assistantMsg, parsed.swipeId)) {
                const canonicalText = getUserMesForKey(key);
                if (typeof canonicalText === 'string') {
                    return { text: canonicalText, source: 'canonical' };
                }
            }
        }

        const mappedText = getLinkedTextByKey(key);
        if (typeof mappedText === 'string') return { text: mappedText, source: 'mapped' };

        const canonicalText = getUserMesForKey(key);
        if (typeof canonicalText === 'string') return { text: canonicalText, source: 'canonical' };
        return { text: null, source: null };
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
        const activeParsed = parseMappingKey(activeKey);
        const exactPending = getPendingEditedEntry(activeKey);
        if (exactPending) {
            sourceKey = exactPending.key;
        } else if (activeParsed) {
            // Preserve the old same-assistant behavior while allowing edits on
            // independent turns to coexist. The newest edit for this assistant wins.
            const sameAssistantEntries = Array.from(pendingEditedEntries.values()).filter((entry) => {
                const parsed = parseMappingKey(entry.key);
                return parsed?.assistantMesId === activeParsed.assistantMesId;
            });
            if (sameAssistantEntries.length) {
                sourceKey = sameAssistantEntries[sameAssistantEntries.length - 1].key;
            }
        }
        for (const entry of Array.from(pendingEditedEntries.values())) {
            const pendingParsed = parseMappingKey(entry.key);
            if (!pendingParsed || !doesAssistantExistForMesId(pendingParsed.assistantMesId)) {
                log('captureGenerationContext – discarding stale pending edit', entry.key);
                deletePendingEditedEntry(entry.key);
            }
        }
        let usedOverswipeKey = null;
        if (normalizedType === 'swipe' && pendingSwipeGenerationKey && hasLinkedTextByKey(pendingSwipeGenerationKey)) {
            // The explicitly captured overswipe key must win whenever the current
            // sourceKey is unusable OR points at a different assistant than the
            // one that was swiped. This stops a stale-but-valid activeKey (e.g.
            // still pointing at the latest assistant) from beating a prior
            // message's swipe. Same-assistant precedence (e.g. a pending edit on
            // the swiped message) is preserved by the original guard.
            const sourceParsed = parseMappingKey(sourceKey);
            const pendingParsed = parseMappingKey(pendingSwipeGenerationKey);
            const differentAssistant = !sourceParsed || !pendingParsed
                || sourceParsed.assistantMesId !== pendingParsed.assistantMesId;
            if (!sourceKey || !hasLinkedTextByKey(sourceKey) || differentAssistant) {
                sourceKey = pendingSwipeGenerationKey;
                activeKey = pendingSwipeGenerationKey;
                usedOverswipeKey = pendingSwipeGenerationKey;
                log('captureGenerationContext – using pre-overswipe key', sourceKey, 'at', capturedAt);
            }
        }
        pendingSwipeGenerationKey = null;

        const parsed = parseMappingKey(sourceKey);
        let sourceUserText = sourceKey ? getPreferredUserTextForKey(sourceKey).text : null;
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

    /**
     * The user text an assistant reply's SELECTED swipe makes its turn send: a
     * pending pencil edit, else a manual override or a non-latest swipe's link.
     * Automatic links on the latest swipe are not authoritative — the user may
     * have pencil-edited the canonical message after that response, and the
     * session-only edit marker is lost on reload — so they (and unlinked
     * swipes) return null, meaning "the canonical message text". The bubble
     * display and every prompt path share this rule so they cannot disagree.
     */
    function resolveSelectedSwipeUserText(aiMsg, pendingEdit) {
        const swipeId = getSwipeIdFromMsg(aiMsg);
        if (pendingEdit) return { text: pendingEdit.text, source: 'edited', swipeId, pendingEdit };
        const swipes = Array.isArray(aiMsg.swipes) ? aiMsg.swipes : null;
        const isLatestOrOnlySwipe = !swipes || swipeId >= swipes.length - 1;
        const manual = isManualLinkedUserText(aiMsg, swipeId);
        if (isLatestOrOnlySwipe && !manual) return null;
        const linked = getLinkedUserText(aiMsg, swipeId);
        if (typeof linked !== 'string') return null;
        return { text: linked, source: manual ? 'manual' : 'linked', swipeId };
    }

    /**
     * Chat index of the user message whose turn the assistant at
     * `assistantIndex` belongs to. Hidden (is_system) messages are skipped,
     * matching the prompt, which leaves them out entirely.
     */
    function getTurnUserIndex(assistantIndex) {
        const chat = SillyTavern.getContext().chat;
        if (!chat) return null;
        for (let i = assistantIndex - 1; i >= 0; i--) {
            if (chat[i]?.is_user && !chat[i].is_system) return i;
        }
        return null;
    }

    /**
     * Resolve what the user message at `userIndex` sends (and so shows) from
     * the replies in its turn. The last qualifying reply wins, matching the
     * forward order in which the interceptor patches. Null = canonical text.
     */
    function resolveTurnUserText(userIndex) {
        const chat = SillyTavern.getContext().chat;
        const userMsg = chat?.[userIndex];
        if (!userMsg?.is_user || userMsg.is_system) return null;
        let resolved = null;
        for (let i = userIndex + 1; i < chat.length; i++) {
            const msg = chat[i];
            if (!msg) continue;
            if (msg.is_user && !msg.is_system) break;
            if (msg.is_user || msg.is_system) continue;
            const pending = getPendingEditedEntry(`${getMesIdFromChatIndex(i)}:${getSwipeIdFromMsg(msg)}`);
            const candidate = resolveSelectedSwipeUserText(msg, pending);
            if (candidate) resolved = { ...candidate, assistantIndex: i };
        }
        return resolved;
    }

    // textEl -> { text, html } of the last linked render, so repeated syncs skip
    // identical work but notice SillyTavern re-rendering the row underneath.
    const linkedBubbleRenders = new WeakMap();

    function renderUserBubble(userIndex, resolved) {
        const msg = SillyTavern.getContext().chat?.[userIndex];
        const userEl = getMesElForChatIndex(userIndex);
        if (!msg?.is_user || !userEl) return;

        const text = resolved?.text;
        const canonical = getUserDisplayText(msg);
        if (typeof text !== 'string' || (canonical != null && text.trim() === canonical.trim())) {
            if (userEl.hasAttribute('data-swipe-linked')) {
                restoreUserBubbleFromChat(userEl);
                userEl.removeAttribute('data-swipe-linked');
            }
            return;
        }

        const textEl = getMesTextEl(userEl);
        if (!textEl) return;
        const last = linkedBubbleRenders.get(textEl);
        if (userEl.getAttribute('data-swipe-linked') === '1' && last?.text === text && last.html === textEl.innerHTML) return;
        log('Updating user bubble', userIndex, 'to:', text.substring(0, 60));
        textEl.innerHTML = formatUserMessageText(text, userIndex);
        linkedBubbleRenders.set(textEl, { text, html: textEl.innerHTML });
        userEl.setAttribute('data-swipe-linked', '1');
    }

    /**
     * Bring every rendered user bubble in line with what the prompt sends.
     * Only the few turns that resolve to a linked text (plus currently marked
     * bubbles) touch the DOM, so this stays cheap on long chats.
     */
    function syncAllUserBubbles() {
        const chat = SillyTavern.getContext().chat;
        if (!chat) return;
        const wanted = new Map();
        for (let i = 0; i < chat.length; i++) {
            if (!chat[i]?.is_user || chat[i].is_system) continue;
            const resolved = resolveTurnUserText(i);
            if (resolved) wanted.set(i, resolved);
        }
        document.querySelectorAll('#chat .mes[data-swipe-linked="1"]').forEach((el) => {
            const chatIndex = getChatIndexForMesEl(el);
            if (chatIndex != null && wanted.has(chatIndex)) return;
            restoreUserBubbleFromChat(el);
            el.removeAttribute('data-swipe-linked');
        });
        for (const [userIndex, resolved] of wanted) {
            renderUserBubble(userIndex, resolved);
        }
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
        handleSwipeChangeForAssistant(null);
    }

    function handleSwipeChangeForAssistant(assistantIndexOrMesId = null) {
        // Only the latest reply can be swiped, regenerated or continued, so only
        // it may move the generation source. Older replies (popup overrides,
        // linked-text deletions) just re-render.
        const lastIdx = getLastAssistantIndexFromChat();
        const targetIdx = assistantIndexOrMesId != null ? findChatIndexByMesId(assistantIndexOrMesId) : lastIdx;
        if (targetIdx != null && targetIdx === lastIdx) {
            refreshActiveKeyFromChat(getMesIdFromChatIndex(targetIdx));
        }
        syncAllUserBubbles();
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
        pendingEditedEntries.clear();
        abandonPendingEditCleanup();
        generationContext = null;
        generationKey = null;
        generationType = null;
        pendingGenerationType = null;
        didReceiveMessageForGeneration = false;
        pendingSwipeGenerationKey = null;
        // Drop any in-flight generation state. Without this, switching chats
        // mid-generation leaves isGenerating stuck true, which suppresses later
        // skipWhileGenerating renders; bumping the seq cancels delayed cleanups.
        isGenerating = false;
        generationSeq++;
        if (generationWatchdogTimer) {
            clearTimeout(generationWatchdogTimer);
            generationWatchdogTimer = null;
        }
        if (lateMessageCleanupTimer) {
            clearTimeout(lateMessageCleanupTimer);
            lateMessageCleanupTimer = null;
        }
        generationWasStopped = false;
        detachObserver();
        invalidateMesElCache();
        if (swipeDebounceTimer) {
            clearTimeout(swipeDebounceTimer);
            swipeDebounceTimer = null;
        }
        swipeRenderSeq++;
        editsButtonScanSeq++;
        // Selection deletion: the menu and undo stack are chat-local.
        cancelDeleteSelectionTimer();
        removeDeleteMenu();
        clearDeletionHistory();
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
        removeDeleteMenu();
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

        const wasGenerating = isGenerating;
        if (!wasGenerating) abandonPendingEditCleanup();
        generationWasStopped = false;
        isGenerating = true;
        generationSeq++;
        generationType = normalizeGenerationEventType(type);
        pendingGenerationType = generationType;
        didReceiveMessageForGeneration = false;
        removeDeleteMenu();

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
        scheduleGenerationAfterCommandsWatchdog();
    }

    function onGenerationStarted(type, _generateOptions, dryRun) {
        if (dryRun === true) return;
        if (!shouldTrackGenerationType(type)) return;

        const wasGenerating = isGenerating;
        if (!wasGenerating) abandonPendingEditCleanup();
        generationWasStopped = false;
        if (lateMessageCleanupTimer) {
            clearTimeout(lateMessageCleanupTimer);
            lateMessageCleanupTimer = null;
        }
        isGenerating = true;
        generationSeq++;
        generationType = normalizeGenerationEventType(type) || generationType;
        removeDeleteMenu();
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
        scheduleGenerationStartWatchdog();
    }

    // SillyTavern fires GENERATION_STARTED even for sends later aborted by a slash
    // command, and that abort path (unblockGeneration) emits no generation-ended
    // event — so the isGenerating flag set above would never clear. Every path that
    // actually proceeds bumps generationSeq (GENERATION_AFTER_COMMANDS) or replaces
    // state; if the seq is unchanged after a grace period the generation never
    // progressed, so clear the stuck flag. A false positive on a slow-but-real
    // command self-corrects, since AFTER_COMMANDS re-sets isGenerating.
    function scheduleGenerationStartWatchdog() {
        if (generationWatchdogTimer) clearTimeout(generationWatchdogTimer);
        const seqAtStart = generationSeq;
        generationWatchdogTimer = setTimeout(() => {
            generationWatchdogTimer = null;
            if (generationSeq === seqAtStart && isGenerating) {
                isGenerating = false;
                log('GENERATION_STARTED watchdog – generation never progressed; cleared stuck isGenerating');
            }
        }, GENERATION_START_WATCHDOG_MS);
    }

    function hasActiveGenerationUi() {
        if (document.body?.dataset?.generating === 'true') return true;
        const processor = globalThis.SillyTavern?.getContext?.()?.streamingProcessor;
        return Boolean(processor && processor.isFinished !== true);
    }

    // SillyTavern also has early-return paths after GENERATION_AFTER_COMMANDS
    // (unsupported streaming, Horde rejection, failed ping, no backend). Those
    // call unblockGeneration without emitting GENERATION_ENDED/STOPPED. The start
    // watchdog is deliberately invalidated once AFTER_COMMANDS fires, so arm a
    // second, longer watchdog for this phase. A real request has activated
    // SillyTavern's generation UI by then and must not be cleared.
    function scheduleGenerationAfterCommandsWatchdog() {
        if (generationWatchdogTimer) clearTimeout(generationWatchdogTimer);
        const seqAtSchedule = generationSeq;
        generationWatchdogTimer = setTimeout(() => {
            generationWatchdogTimer = null;
            if (generationSeq !== seqAtSchedule || !isGenerating) return;
            if (hasActiveGenerationUi()) {
                log('GENERATION_AFTER_COMMANDS watchdog – generation UI still active; leaving state intact');
                return;
            }
            isGenerating = false;
            pendingUserText = null;
            generationKey = null;
            generationContext = null;
            generationType = null;
            pendingGenerationType = null;
            pendingSwipeGenerationKey = null;
            didReceiveMessageForGeneration = false;
            abandonPendingEditCleanup();
            log('GENERATION_AFTER_COMMANDS watchdog – cleared aborted generation state');
        }, GENERATION_AFTER_COMMANDS_WATCHDOG_MS);
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

        const streamingProcessor = ctx.streamingProcessor;
        const streamWasInterrupted = Boolean(
            generationWasStopped
            || streamingProcessor?.isStopped
            || streamingProcessor?.abortController?.signal?.aborted
        );
        const streamProducedOutput = Boolean(
            streamingProcessor
            && (
                streamingProcessor.timeToFirstToken != null
                || (typeof streamingProcessor.result === 'string' && streamingProcessor.result.length > 0)
            )
        );
        if (streamWasInterrupted && !streamProducedOutput) {
            log('MESSAGE_RECEIVED – ignored zero-token stopped/failed generation', {
                messageIndex,
                effectiveType,
                messageText: typeof msg.mes === 'string' ? msg.mes.substring(0, 20) : null,
            });
            return;
        }

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
            const pendingEdit = getPendingEditedEntry(keyUsedForGeneration);
            if (pendingEdit) {
                userTextForMapping = pendingEdit.text;
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
        pendingEditCleanupRequested = pendingEditKeysUsedForGeneration.size > 0;
        pendingSwipeGenerationKey = null;
        // Streaming can append several swipe alternatives in one generation before
        // MESSAGE_RECEIVED, all from the same user text. Backfill the siblings so
        // swiping to a batch alternative still resolves a linked bubble.
        backfillBatchSwipeMappings(msg, assistantMesId, swipeId, userTextForMapping);
        if (effectiveType === 'normal') {
            pendingNormalUserText = null;
        }
        pendingUserText = null;
        generationKey = null;
        generationContext = null;
        pendingGenerationType = null;
        generationWasStopped = false;
        requestChatSave();
        scheduleSwipeRenderAfterFrame(assistantMesId);
        // Streaming finalization emits GENERATION_ENDED before MESSAGE_RECEIVED.
        // In that ordering the successful receipt is the end of the tool chain.
        if (!isGenerating && pendingEditCleanupRequested) {
            clearConsumedPendingEdits();
        }
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
        if (generationWatchdogTimer) {
            clearTimeout(generationWatchdogTimer);
            generationWatchdogTimer = null;
        }
        const preserveForLateMessage = !didReceiveMessageForGeneration && shouldTrackGenerationType(pendingGenerationType);
        const seqAtEnd = generationSeq;
        const overswipeKeyToRestore = !didReceiveMessageForGeneration ? generationContext?._usedOverswipeKey : null;

        isGenerating = false;
        if (didReceiveMessageForGeneration && pendingEditCleanupRequested) {
            clearConsumedPendingEdits();
        }
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
            if (lateMessageCleanupTimer) clearTimeout(lateMessageCleanupTimer);
            lateMessageCleanupTimer = setTimeout(() => {
                lateMessageCleanupTimer = null;
                if (generationSeq !== seqAtEnd || isGenerating || didReceiveMessageForGeneration) return;
                pendingUserText = null;
                generationKey = null;
                generationContext = null;
                pendingGenerationType = null;
                pendingSwipeGenerationKey = null;
                abandonPendingEditCleanup();
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

    function onGenerationStopped() {
        generationWasStopped = true;
        onGenerationEnded();
        log('GENERATION_STOPPED – retaining pending edit but rejecting zero-token receipts');
    }

    function onMessageSwiped(messageIndex) {
        messageIndex = normalizeMessageIndex(messageIndex);
        log('MESSAGE_SWIPED', messageIndex);

        // Synchronously detect overswipe BEFORE rAF, because Generate('swipe')
        // fires immediately after this emit resolves.
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat;

        // Resolve the assistant that was actually swiped. Do NOT fall back to the
        // last assistant for an explicit swipe event — an unresolvable payload
        // must be a no-op rather than silently act on the latest message (which
        // is how a prior-message swipe could be mistaken for a latest-message one).
        const aiIdx = messageIndex != null ? findChatIndexByEventId(messageIndex) : null;
        const aiMsg = aiIdx != null && chat ? chat[aiIdx] : null;
        if (!aiMsg || aiMsg.is_user || aiMsg.is_system) {
            log('MESSAGE_SWIPED – could not resolve swiped assistant; ignoring', messageIndex);
            return;
        }

        const assistantMesId = getMesIdFromChatIndex(aiIdx);
        const isOverswipePending = Boolean(
            Array.isArray(aiMsg.swipes) &&
            typeof aiMsg.swipe_id === 'number' &&
            aiMsg.swipe_id >= aiMsg.swipes.length,
        );
        if (isOverswipePending) {
            // The overswipe generates from the last existing swipe of THIS
            // assistant — not from whatever activeKey happens to be globally,
            // which may point at a different (e.g. the latest) message.
            const sourceSwipeId = Math.max(0, aiMsg.swipes.length - 1);
            const sourceKey = `${assistantMesId}:${sourceSwipeId}`;

            // Make the swiped assistant the active source immediately, so a
            // generation that fires before the deferred render runs can't read a
            // stale activeKey that points at a different message.
            activeKey = sourceKey;

            if (hasLinkedTextByKey(sourceKey)) {
                pendingSwipeGenerationKey = sourceKey;
                log('MESSAGE_SWIPED – captured pre-overswipe key', pendingSwipeGenerationKey);
            } else if (!isGenerating) {
                pendingSwipeGenerationKey = null;
            }
        } else {
            // Ordinary swipe between existing variants: sync activeKey to the
            // swiped assistant's current swipe right away for the same reason.
            const swipeId = resolveSwipeId(assistantMesId, aiMsg);
            activeKey = `${assistantMesId}:${swipeId}`;
            if (!isGenerating) {
                pendingSwipeGenerationKey = null;
                releasePendingEditsForOtherSwipes(assistantMesId, swipeId);
            }
        }

        scheduleSwipeRenderAfterFrame(assistantMesId);
        // A fresh variant may have just crossed the "more than one swipe" threshold,
        // so (re)evaluate the edits button for this message.
        ensureEditsButtonForAssistant(assistantMesId);
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
            pendingNormalUserText = editedText;
            syncAllUserBubbles();
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

        setPendingEditedEntry(keyAtEdit, editedText);
        log('MESSAGE_EDITED – pending keyed edit updated:', keyAtEdit, editedText.substring(0, 60), isLatestUser ? '(latest)' : '(non-latest)');
    }

    function onMessageDeleted(_chatLength) {
        invalidateMesElCache();
        removeDeleteMenu();
        pruneDeletionHistory();

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
        for (const entry of Array.from(pendingEditedEntries.values())) {
            if (!doesAssistantExistForKey(entry.key)) {
                deletePendingEditedEntry(entry.key);
            }
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
        const messageId = normalizeMessageIndex(
            data.messageId ?? data.message_id ?? data.mesid ?? data.mesId ?? data.index,
        );
        const swipeId = Number(data.swipeId ?? data.swipe_id);
        if (messageId == null || !Number.isFinite(swipeId)) return;

        let assistantIdx = findChatIndexByEventId(messageId);
        const assistantMesId = assistantIdx != null ? getMesIdFromChatIndex(assistantIdx) : messageId;

        activeKey = adjustKeyAfterSwipeDelete(activeKey, assistantMesId, swipeId);
        generationKey = adjustKeyAfterSwipeDelete(generationKey, assistantMesId, swipeId);
        pendingSwipeGenerationKey = adjustKeyAfterSwipeDelete(pendingSwipeGenerationKey, assistantMesId, swipeId);

        const adjustedPendingEntries = [];
        for (const entry of pendingEditedEntries.values()) {
            const adjustedKey = adjustKeyAfterSwipeDelete(entry.key, assistantMesId, swipeId);
            if (adjustedKey) adjustedPendingEntries.push({ ...entry, key: adjustedKey });
        }
        pendingEditedEntries.clear();
        for (const entry of adjustedPendingEntries) {
            pendingEditedEntries.set(entry.key, entry);
        }
        const adjustedUsedKeys = [];
        for (const key of pendingEditKeysUsedForGeneration) {
            const adjustedKey = adjustKeyAfterSwipeDelete(key, assistantMesId, swipeId);
            if (adjustedKey) adjustedUsedKeys.push(adjustedKey);
        }
        pendingEditKeysUsedForGeneration.clear();
        for (const key of adjustedUsedKeys) {
            pendingEditKeysUsedForGeneration.add(key);
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
        removeDeleteMenu();
        for (let i = deletionHistory.length - 1; i >= 0; i--) {
            const entry = deletionHistory[i];
            const targetMesId = entry.kind === 'linked' ? entry.assistantMesId : entry.mesId;
            if (targetMesId !== assistantMesId || entry.swipeId == null) continue;
            if (entry.swipeId === swipeId) deletionHistory.splice(i, 1);
            else if (entry.swipeId > swipeId) entry.swipeId--;
        }
        pruneDeletionHistory();

        handleSwipeChangeForAssistant(assistantMesId);
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
        abandonPendingEditCleanup();
        activeKey = null;
        // The replies above keep their selected swipes, so earlier bubbles keep
        // showing what the prompt will send for them.
        syncAllUserBubbles();
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

    // SillyTavern builds each coreChat entry as `[fileContent +] USER_INPUT-regex(mes)
    // [+ titles]` BEFORE extension interceptors run. Swapping in raw linked text would
    // drop that prompt-time regex output, prepended file contents, and appended
    // file/media titles. These helpers re-apply the same pipeline using SillyTavern's
    // own functions, loaded lazily by absolute URL (stable across install locations).
    // If they can't be loaded we fall back to patching the raw text (previous behavior).
    async function loadPromptHelpers() {
        if (stPromptHelpers !== undefined) return stPromptHelpers;
        try {
            const [regexMod, chatsMod] = await Promise.all([
                import('/scripts/extensions/regex/engine.js'),
                import('/scripts/chats.js'),
            ]);
            const getRegexedString = regexMod?.getRegexedString;
            const regexPlacement = regexMod?.regex_placement;
            const appendFileContent = chatsMod?.appendFileContent;
            if (typeof getRegexedString === 'function'
                && regexPlacement && regexPlacement.USER_INPUT != null
                && typeof appendFileContent === 'function') {
                stPromptHelpers = { getRegexedString, regexPlacement, appendFileContent };
            } else {
                stPromptHelpers = null;
            }
        } catch {
            stPromptHelpers = null;
        }
        if (!stPromptHelpers) {
            log('Prompt preprocessing helpers unavailable; linked text will be patched raw');
        }
        return stPromptHelpers;
    }

    /**
     * Rebuild a coreChat user entry's `mes` from replacement text exactly as
     * SillyTavern's Generate() would (USER_INPUT regex, prepended file content,
     * appended titles), so a linked-text swap keeps the same prompt-time processing.
     * `coreChatItem` is the spread-copied entry (carries `extra` and `index`);
     * `coreChat` is the array passed to the interceptor. Falls back to the raw text.
     */
    async function reprocessUserTextForPrompt(coreChat, coreChatItem, text, interceptorType) {
        if (typeof text !== 'string') return text;
        const helpers = await loadPromptHelpers();
        if (!helpers) return text;
        try {
            const isContinue = interceptorType === 'continue';
            const index = typeof coreChatItem.index === 'number'
                ? coreChatItem.index
                : coreChat.indexOf(coreChatItem);
            const depth = coreChat.length - index - (isContinue ? 2 : 1);
            let processed = helpers.getRegexedString(text, helpers.regexPlacement.USER_INPUT, { isPrompt: true, depth });
            const extra = coreChatItem.extra;
            if (extra && typeof extra === 'object') {
                // Pass an isolated extra clone: appendFileContent writes fileLength,
                // and coreChat entries share extra by reference with the live chat.
                processed = await helpers.appendFileContent({ extra: { ...extra } }, processed);
                const titles = [];
                if (extra.append_title && extra.title) titles.push(extra.title);
                if (Array.isArray(extra.media)) {
                    for (const mediaItem of extra.media) {
                        if (mediaItem?.title && mediaItem?.append_title) titles.push(mediaItem.title);
                    }
                }
                if (titles.length > 0) processed = `${processed}\n\n${titles.join('\n\n')}`;
            }
            return processed;
        } catch (e) {
            log('Failed to reprocess linked text; patching raw', e?.message);
            return text;
        }
    }

    function findPendingEditForCoreAssistant(aiMsg, swipeId) {
        const coreMesId = aiMsg?.mesid ?? aiMsg?.mesId ?? aiMsg?.message_id;
        const entries = Array.from(pendingEditedEntries.values()).reverse();
        for (const entry of entries) {
            const parsed = parseMappingKey(entry.key);
            if (!parsed || parsed.swipeId !== swipeId) continue;
            if (coreMesId === parsed.assistantMesId
                || (typeof coreMesId === 'string' && coreMesId === String(parsed.assistantMesId))) {
                return entry;
            }
            const liveAssistant = resolveAssistantMsg(parsed.assistantMesId);
            if (liveAssistant && aiMsg?.send_date != null && aiMsg.send_date === liveAssistant.send_date) {
                return entry;
            }
        }
        return null;
    }

    /**
     * Patch every historical user turn whose reply sits on a swipe that sends
     * something other than the canonical text (see resolveSelectedSwipeUserText):
     * a pending edit, a manual override, or a non-latest swipe's link. Without
     * this, an earlier turn the user has swiped away from would be sent as its
     * latest-edited text rather than the branch's own text. Runs for every
     * generation type (quiet/impersonate prompts must see the same history the
     * chat shows); swipe-like types then re-patch their source turn. Only
     * tracked generations consume a pending edit.
     *
     * Operates directly on the spread-copied coreChat entries (which carry
     * swipe_info/swipe_id/swipes), so no live-chat matching is needed. The
     * replacement text is re-run through SillyTavern's prompt preprocessing so
     * it matches the surrounding entries.
     */
    async function patchHistoricalUserTurns(chat, interceptorType) {
        if (!Array.isArray(chat)) return;
        for (let i = 0; i < chat.length; i++) {
            const aiMsg = chat[i];
            if (!aiMsg || aiMsg.is_user || aiMsg.is_system) continue;
            const swipeId = getSwipeIdFromMsg(aiMsg);
            const pendingEdit = findPendingEditForCoreAssistant(aiMsg, swipeId);
            const resolved = resolveSelectedSwipeUserText(aiMsg, pendingEdit);
            if (!resolved) continue;
            const linked = resolved.text;
            let userIdx = -1;
            for (let j = i - 1; j >= 0; j--) {
                if (chat[j]?.is_user) { userIdx = j; break; }
            }
            if (userIdx === -1) continue;
            const userMsg = chat[userIdx];
            if (!userMsg || typeof userMsg !== 'object') continue;
            if (pendingEdit && shouldTrackGenerationType(interceptorType)) markPendingEditUsed(pendingEdit.key);
            const processed = await reprocessUserTextForPrompt(chat, userMsg, linked, interceptorType);
            if (userMsg.mes === processed) continue;
            userMsg.mes = processed;
            log(`Interceptor (${interceptorType}) patched historical user idx`, userIdx, 'for assistant idx', i, 'swipe', swipeId, 'to:', linked.substring(0, 60));
        }
    }

    exposeOwnedGlobal('swipeLinkedUserEditInterceptor', async function (chat, _contextSize, _abort, _type) {
        const interceptorType = normalizeGenerationEventType(_type);
        // Earlier turns must read the same whatever produces the next reply;
        // swipe-like types then patch their source turn below, which wins.
        await patchHistoricalUserTurns(chat, interceptorType);
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
        const pendingEdit = getPendingEditedEntry(keyToUse);
        if (pendingEdit) {
            textSource = 'edited';
            textToPatch = pendingEdit.text;
        } else if (generationContext
            && typeof generationContext.sourceUserText === 'string'
            && (!generationContext.sourceKey || generationContext.sourceKey === keyToUse)) {
            textSource = 'context';
            textToPatch = generationContext.sourceUserText;
        } else if (typeof pendingUserText === 'string') {
            textSource = 'pending';
            textToPatch = pendingUserText;
        } else {
            const preferred = getPreferredUserTextForKey(keyToUse);
            if (typeof preferred.text === 'string') {
                textSource = preferred.source;
                textToPatch = preferred.text;
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

        if (pendingEdit) markPendingEditUsed(pendingEdit.key);

        // Re-run SillyTavern's prompt-time preprocessing (regex / file content /
        // titles) on the replacement text so the swap doesn't drop it.
        const processedText = await reprocessUserTextForPrompt(chat, msg, textToPatch, interceptorType);

        // If already matching, skip
        if (msg.mes === processedText) return;

        // coreChat contains spread-copied objects (SillyTavern's Generate builds coreChat
        // via chat.filter().map(item => ({ ...item, mes: regexed }))), so this mutation
        // only affects the API call. No restoration needed.
        msg.mes = processedText;
        log('Interceptor patched user msg idx', userIdx, 'with key', keyToUse, 'source', textSource, 'to:', processedText.substring(0, 60));
    });

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

    function onMoreMessagesLoaded() {
        invalidateMesElCache();
        scheduleEditsButtonsForLoadedChat();
        // Older rows arrive rendered with their canonical text.
        scheduleSwipeRenderAfterFrame(null, { skipWhileGenerating: true });
    }

    function ensureEditsButtonForAssistant(assistantIndexOrMesId) {
        if (assistantIndexOrMesId == null) return;
        const chatIndex = findChatIndexByMesId(assistantIndexOrMesId);
        const mesEl = chatIndex != null ? getMesElForChatIndex(chatIndex) : null;
        const msg = chatIndex != null ? SillyTavern.getContext().chat?.[chatIndex] : null;
        if (mesEl) ensureEditsButton(mesEl, chatIndex, msg);
    }

    function computeSwipeEditGroups(msg) {
        const swipeCount = Array.isArray(msg.swipes) ? Math.max(1, msg.swipes.length) : 1;

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
        return { groups, swipeCount };
    }

    function makePopupActionButton(label, title, onClick) {
        const btn = document.createElement('div');
        btn.className = 'menu_button swipe_edits_action';
        btn.textContent = label;
        btn.title = title;
        btn.addEventListener('click', onClick);
        return btn;
    }

    function showEditsPopup(mesEl) {
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat;
        const chatIndex = getChatIndexForMesEl(mesEl);
        const msg = chatIndex != null && chat ? chat[chatIndex] : null;
        if (!msg || msg.is_user || msg.is_system) return;

        const assistantMesId = getMesIdFromChatIndex(chatIndex);
        // The fallback popup path serializes to HTML, which drops listeners —
        // only offer the manual controls when the live-DOM popup is available.
        const interactive = typeof ctx.callGenericPopup === 'function' && Boolean(ctx.POPUP_TYPE);

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
        container.appendChild(sub);

        const groupsWrap = document.createElement('div');
        container.appendChild(groupsWrap);

        const applyAndRerender = (swipeIds, text) => {
            applyManualLinkedText(assistantMesId, swipeIds, text);
            renderGroups();
        };

        const renderTextEditor = (body, actions, group, initialText) => {
            const editor = document.createElement('textarea');
            editor.className = 'text_pole swipe_edits_editor';
            editor.value = initialText;
            editor.rows = Math.min(8, Math.max(3, initialText.split('\n').length + 1));
            body.replaceChildren(editor);

            const editorActions = document.createElement('div');
            editorActions.className = 'swipe_edits_actions';
            editorActions.appendChild(makePopupActionButton('Save', 'Save this text as the linked user text for these swipes', () => {
                applyAndRerender(group.swipes, editor.value);
            }));
            editorActions.appendChild(makePopupActionButton('Cancel', 'Discard changes', () => renderGroups()));
            actions.replaceChildren(editorActions);
            editor.focus();
        };

        function renderGroups() {
            const liveMsg = resolveAssistantMsg(assistantMesId);
            if (!liveMsg) {
                groupsWrap.replaceChildren();
                sub.textContent = 'Message no longer exists.';
                return;
            }
            const { groups, swipeCount } = computeSwipeEditGroups(liveMsg);
            const activeSwipe = getSwipeIdFromMsg(liveMsg);
            const userIndex = getUserIndexBefore(findChatIndexByMesId(assistantMesId));
            const canonical = userIndex != null ? getUserDisplayText(ctx.chat[userIndex]) : null;

            sub.textContent = `${groups.length} distinct edit${groups.length === 1 ? '' : 's'} across ${swipeCount} swipe${swipeCount === 1 ? '' : 's'}. `
                + 'The user text below is what each AI swipe was generated from'
                + (interactive ? ' — and what is sent to the model while that swipe is selected. Use the buttons to change it.' : '.');

            groupsWrap.replaceChildren();
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
                if (group.swipes.some((s) => isManualLinkedUserText(liveMsg, s))) tags.push('manually set');
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

                if (interactive) {
                    const actions = document.createElement('div');
                    actions.className = 'swipe_edits_actions';

                    actions.appendChild(makePopupActionButton(
                        group.text == null ? 'Set text…' : 'Edit text…',
                        'Manually set the user text sent to the model for these swipes (e.g. fix a typo)',
                        () => renderTextEditor(body, actions, group, group.text ?? canonical ?? ''),
                    ));

                    if (group.text != null && canonical != null && group.text.trim() !== canonical.trim()) {
                        actions.appendChild(makePopupActionButton(
                            'Use latest message text',
                            'Replace the linked text for these swipes with the user message’s current (edited) text',
                            () => applyAndRerender(group.swipes, canonical),
                        ));
                    }

                    if (group.text != null) {
                        actions.appendChild(makePopupActionButton(
                            'Unlink',
                            'Remove the linked text so these swipes always send the latest message text',
                            () => applyAndRerender(group.swipes, null),
                        ));
                    }

                    if (group.text != null && !group.swipes.includes(activeSwipe)) {
                        actions.appendChild(makePopupActionButton(
                            'Send this for current swipe',
                            'Make this text what the current swipe sends to the model',
                            () => applyAndRerender([activeSwipe], group.text),
                        ));
                    }

                    block.appendChild(actions);
                }
                groupsWrap.appendChild(block);
            }
        }

        renderGroups();

        if (interactive) {
            ctx.callGenericPopup(container, ctx.POPUP_TYPE.DISPLAY, '', { wide: true });
        } else if (typeof ctx.callPopup === 'function') {
            ctx.callPopup(container.outerHTML, 'text');
        }
    }

    // ─── Delete Selection ────────────────────────────────────────────────────────
    //
    // Select text inside one message bubble, press the compact "Delete" button
    // that appears next to the selection, and the selected text is removed from
    // the message's *source*. The rendered selection is mapped back to source
    // conservatively: every candidate span is re-rendered through
    // messageFormatting and must reproduce the expected text, otherwise nothing
    // is changed. Canonical user / assistant edits follow SillyTavern's own
    // messageEditDone order (mutate → MESSAGE_EDITED → render → MESSAGE_UPDATED →
    // saveChat). A user bubble that currently shows a swipe-linked text is edited
    // through the manual linked-text override instead, leaving msg.mes untouched.

    const DELETE_MENU_CLASS = 'swipe_delete_selection_menu';
    const DELETE_BUTTON_CLASS = 'swipe_delete_selection_button';
    const DELETE_UNDO_BUTTON_CLASS = 'swipe_delete_undo_button';
    const DELETE_HISTORY_LIMIT = 15;
    const DELETE_MAX_LAYOUT_NODES = 20000;
    const DELETE_SELECTION_DEBOUNCE_MS = 150;
    const DELETE_SKIPPED_TAGS = new Set(['STYLE', 'SCRIPT', 'TEMPLATE', 'NOSCRIPT']);
    const DELETE_MD_SYNTAX_CHARS = new Set(['*', '_', '~', '`', '[', ']', '(', ')', '!', '#', '>', '|', '-', '+', '\\']);
    // Longest run first so "**" is never mistaken for two "*" runs.
    const DELETE_MD_RUNS = ['***', '**', '*', '___', '__', '_', '~~', '```', '`'];
    const DELETE_BLOCKED_SELECTOR = 'textarea, input, [contenteditable], .edit_textarea, #curEditTextarea, .popup, dialog, .ctx-menu';

    let deleteMenuEl = null;
    let deleteSelectionTimer = null;
    let deleteSelectionSeq = 0;
    let deletionInFlight = false;
    let pendingDeleteSelection = null; // { range, mesTextEl, mesEl } captured when the menu was shown
    let deleteChatScrollEl = null;
    const deletionHistory = []; // bounded undo stack, newest last

    function notifyDeleteWarning(text) {
        log('Delete selection –', text);
        try {
            if (typeof globalThis.toastr?.warning === 'function') globalThis.toastr.warning(text, 'Delete selection');
        } catch { /* toast is best-effort */ }
    }

    function notifyDeleteError(text) {
        console.warn(`[${EXTENSION_NAME}] Delete selection –`, text);
        try {
            if (typeof globalThis.toastr?.error === 'function') globalThis.toastr.error(text, 'Delete selection');
        } catch { /* toast is best-effort */ }
    }

    function getDomSelection() {
        try {
            if (typeof document.getSelection === 'function') return document.getSelection();
            if (typeof globalThis.getSelection === 'function') return globalThis.getSelection();
        } catch { /* ignore */ }
        return null;
    }

    function closestElementFromNode(node, selector) {
        if (!node) return null;
        const el = node.nodeType === 1 ? node : node.parentElement;
        if (!el || typeof el.closest !== 'function') return null;
        try {
            return el.closest(selector);
        } catch {
            return null;
        }
    }

    function isWhitespaceChar(ch) {
        return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v' || ch === ' ';
    }

    function normalizeRenderedText(text) {
        return String(text ?? '').replace(/\s+/g, ' ').trim();
    }

    /**
     * Walk `rootEl` iteratively and record, for every node, the offset into the
     * concatenated text of its subtree entry and exit. Explicit stack + visited
     * set + node cap: a cyclic or absurdly large tree yields `null` (refuse)
     * instead of a hang. Non-rendered subtrees (style/script/template) are
     * skipped so their text can't shift the offsets.
     */
    function collectTextLayout(rootEl, maxNodes = DELETE_MAX_LAYOUT_NODES) {
        if (!rootEl || typeof rootEl !== 'object') return null;
        const positions = new Map();
        const visited = new Set();
        const parts = [];
        let offset = 0;
        let visitedCount = 0;
        const stack = [{ node: rootEl, exit: false }];
        while (stack.length) {
            const frame = stack.pop();
            const node = frame.node;
            if (frame.exit) {
                const entry = positions.get(node);
                if (entry) entry.exit = offset;
                continue;
            }
            if (!node || typeof node !== 'object') continue;
            if (visited.has(node)) return null; // cycle
            visited.add(node);
            if (++visitedCount > maxNodes) return null;

            if (node.nodeType === 3) {
                const text = typeof node.textContent === 'string' ? node.textContent
                    : (typeof node.data === 'string' ? node.data : '');
                positions.set(node, { enter: offset, exit: offset + text.length, length: text.length });
                parts.push(text);
                offset += text.length;
                continue;
            }
            positions.set(node, { enter: offset, exit: offset, length: 0 });
            if (node.nodeType !== 1 && node !== rootEl) continue; // comments etc. carry no text
            const tag = typeof node.tagName === 'string' ? node.tagName.toUpperCase() : '';
            if (node !== rootEl && DELETE_SKIPPED_TAGS.has(tag)) continue;
            stack.push({ node, exit: true });
            const children = node.childNodes;
            const childCount = children && typeof children.length === 'number' ? children.length : 0;
            for (let i = childCount - 1; i >= 0; i--) stack.push({ node: children[i], exit: false });
        }
        return { text: parts.join(''), positions };
    }

    /**
     * Turn a Range endpoint (container + offset) into an offset in layout.text.
     * Handles text containers (character offset) and element containers (child
     * index, as produced by double/triple-click selections). Unknown containers
     * (detached, outside the message) yield `null`.
     */
    function resolveBoundaryOffset(layout, container, offset) {
        if (!layout || !container || !layout.positions.has(container)) return null;
        const entry = layout.positions.get(container);
        if (!Number.isInteger(offset) || offset < 0) return null;
        const numericOffset = offset;
        if (container.nodeType === 3) {
            return numericOffset <= entry.length ? entry.enter + numericOffset : null;
        }
        const children = container.childNodes;
        const childCount = children && typeof children.length === 'number' ? children.length : 0;
        if (numericOffset > childCount) return null;
        if (numericOffset === childCount) return entry.exit;
        const childEntry = layout.positions.get(children[Math.max(0, numericOffset)]);
        return childEntry ? childEntry.enter : null;
    }

    function isPureMarkdownSyntax(text) {
        if (!text) return false;
        for (const ch of text) {
            if (!DELETE_MD_SYNTAX_CHARS.has(ch) && !isWhitespaceChar(ch)) return false;
        }
        return true;
    }

    /**
     * End of the unrendered source construct starting at `s` (link target, HTML
     * tag, single Markdown syntax or whitespace character), or null when the
     * character at `s` must be rendered.
     */
    function skippableSourceEnd(source, s) {
        const sc = source[s];
        if (sc === ']' && source[s + 1] === '(') {
            const close = source.indexOf(')', s + 2);
            if (close !== -1) return close + 1;
        }
        if (sc === '<') {
            const close = source.indexOf('>', s + 1);
            if (close !== -1) return close + 1;
        }
        if (DELETE_MD_SYNTAX_CHARS.has(sc) || isWhitespaceChar(sc)) return s + 1;
        return null;
    }

    /**
     * Single forward pass aligning rendered text to source text. Only markdown
     * syntax characters, link targets, HTML tags and whitespace may be skipped in
     * the source; any other mismatch aborts (`null`) instead of guessing. Each
     * iteration advances at least one index, so it always terminates.
     *
     * Returns the source segments that produced rendered[selStart, selEnd). Gaps
     * between matched characters that are pure markdown syntax (the `**` between
     * two selected words) are folded into the segment; gaps with real content
     * (a link target, an HTML tag) are kept, so deleting "docs now" out of
     * "[the docs](url) now" leaves "[the](url)".
     *
     * Also returned for buildDelimiterPreservingText: `matched` (source indexes
     * of the selected characters) and `skips`, the unrendered constructs from
     * the previous rendered character up to the next one after the selection
     * (`[beforeStart, afterEnd)` is covered by `matched` and `skips` exactly).
     */
    function alignRenderedToSource(rendered, source, selStart, selEnd) {
        if (typeof rendered !== 'string' || typeof source !== 'string') return null;
        if (!Number.isInteger(selStart) || !Number.isInteger(selEnd)) return null;
        if (selStart < 0 || selEnd > rendered.length || selStart >= selEnd) return null;
        let r = 0;
        let s = 0;
        let beforeStart = -1;
        const matched = []; // source indexes of the characters rendered inside the selection
        const skips = [];
        while (r < selEnd && s < source.length) {
            if (r >= selStart && beforeStart < 0) beforeStart = s;
            if (rendered[r] === source[s]) {
                if (r >= selStart) matched.push(s);
                r++;
                s++;
                continue;
            }
            // Showdown renders "..." as a single "…".
            if (rendered[r] === '\u2026' && source.startsWith('...', s)) {
                if (r >= selStart) matched.push(s, s + 1, s + 2);
                r++;
                s += 3;
                continue;
            }
            const next = skippableSourceEnd(source, s);
            if (next != null) {
                if (r >= selStart) skips.push({ start: s, end: next });
                s = next;
                continue;
            }
            if (isWhitespaceChar(rendered[r])) {
                r++;
                continue;
            }
            return null;
        }
        if (r < selEnd || !matched.length) return null;
        // Unrendered syntax between the selection and the next rendered character
        // (a closing `*` right after the selected text, a link target, ...).
        while (s < source.length && (r >= rendered.length || rendered[r] !== source[s])) {
            const next = skippableSourceEnd(source, s);
            if (next == null) break;
            skips.push({ start: s, end: next });
            s = next;
        }
        const afterEnd = s;

        const segments = [];
        let segStart = matched[0];
        let segEnd = matched[0] + 1;
        for (let i = 1; i < matched.length; i++) {
            const idx = matched[i];
            if (idx === segEnd || isPureMarkdownSyntax(source.slice(segEnd, idx))) {
                segEnd = idx + 1;
                continue;
            }
            segments.push({ start: segStart, end: segEnd });
            segStart = idx;
            segEnd = idx + 1;
        }
        segments.push({ start: segStart, end: segEnd });
        return {
            start: segments[0].start,
            end: segments[segments.length - 1].end,
            segments,
            matched,
            skips,
            beforeStart: Math.max(0, beforeStart),
            afterEnd,
        };
    }

    function findRunBefore(source, index) {
        for (const run of DELETE_MD_RUNS) {
            const from = index - run.length;
            if (from < 0) continue;
            if (source.slice(from, index) !== run) continue;
            if (from > 0 && source[from - 1] === run[0]) continue;
            return run;
        }
        return null;
    }

    function findRunAfter(source, index) {
        for (const run of DELETE_MD_RUNS) {
            if (source.slice(index, index + run.length) !== run) continue;
            if (source[index + run.length] === run[0]) continue;
            return run;
        }
        return null;
    }

    function countStandaloneRuns(text, run) {
        let count = 0;
        let i = 0;
        while (i < text.length) {
            if (text.startsWith(run, i) && (i === 0 || text[i - 1] !== run[0]) && text[i + run.length] !== run[0]) {
                count++;
                i += run.length;
            } else {
                i++;
            }
        }
        return count;
    }

    function findClosingBracket(source, openIndex, openChar, closeChar) {
        let depth = 0;
        for (let i = openIndex; i < source.length; i++) {
            const ch = source[i];
            if (ch === openChar) depth++;
            else if (ch === closeChar) {
                depth--;
                if (depth === 0) return i;
            } else if (ch === '\n' && openChar === '(') {
                return -1; // a link target never spans lines
            }
        }
        return -1;
    }

    /**
     * Widen a source span so that removing it leaves well-formed Markdown:
     * deleting all of `**bold**` takes the delimiters too, deleting a whole link
     * label takes the whole `[label](url)`, and partial deletions next to a
     * delimiter don't leave `** text**`. Returns null for invalid input.
     */
    function adjustSpanForMarkdown(source, start, end) {
        if (typeof source !== 'string' || !Number.isInteger(start) || !Number.isInteger(end)) return null;
        if (start < 0 || end > source.length || start >= end) return null;

        // Emphasis / strike / code runs.
        const applyRunRules = () => {
            const before = findRunBefore(source, start);
            const after = findRunAfter(source, end);
            if (before && after && before === after) {
                start -= before.length;
                end += after.length;
                return true;
            }
            const inner = source.slice(start, end);
            if (before && countStandaloneRuns(inner, before) === 1) {
                start -= before.length; // opener outside, closer inside → take the opener too
                return true;
            }
            if (after && countStandaloneRuns(inner, after) === 1) {
                end += after.length; // opener inside, closer outside → take the closer too
                return true;
            }
            let changed = false;
            if (before && (source[end] === ' ' || source[end] === '\t')) {
                let e = end;
                while (e < source.length && (source[e] === ' ' || source[e] === '\t')) e++;
                end = e;
                changed = true;
            }
            if (after && (source[start - 1] === ' ' || source[start - 1] === '\t')) {
                let s = start;
                while (s > 0 && (source[s - 1] === ' ' || source[s - 1] === '\t')) s--;
                start = s;
                changed = true;
            }
            return changed;
        };
        if (applyRunRules()) {
            // Whitespace trimming may have emptied the emphasis: re-check once.
            const before = findRunBefore(source, start);
            const after = findRunAfter(source, end);
            if (before && after && before === after) {
                start -= before.length;
                end += after.length;
            }
        }

        // Links and images.
        const labelOpen = source[start - 1] === '[' ? (source[start - 2] === '!' ? start - 2 : start - 1) : -1;
        const tailOpener = source[end] === ']' && (source[end + 1] === '(' || source[end + 1] === '[') ? source[end + 1] : null;
        if (labelOpen !== -1 && tailOpener) {
            const close = findClosingBracket(source, end + 1, tailOpener, tailOpener === '(' ? ')' : ']');
            if (close !== -1) {
                start = labelOpen;
                end = close + 1;
            }
        } else if (labelOpen !== -1) {
            const inner = source.slice(start, end);
            if (inner.includes('](') || inner.includes('][')) start = labelOpen;
        } else if (tailOpener) {
            const inner = source.slice(start, end);
            if (inner.includes('[')) {
                const close = findClosingBracket(source, end + 1, tailOpener, tailOpener === '(' ? ')' : ']');
                if (close !== -1) end = close + 1;
            }
        }

        if (start < 0 || end > source.length || start >= end) return null;
        return { start, end };
    }

    const DELETE_HTML_VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

    function isPunctuationChar(ch) {
        return typeof ch === 'string' && ch !== '' && /[\p{P}\p{S}]/u.test(ch);
    }

    /**
     * Pairing role of an unrendered syntax token, judged in the original source.
     * Emphasis and code runs use CommonMark's flanking rules (string edges count
     * as whitespace); `open`/`close` mark runs that can only open or only close.
     * Both kinds drop whitespace just inside their delimiters, which is why
     * buildDelimiterPreservingText moves whitespace across them.
     */
    function classifySyntaxToken(source, start, end) {
        const text = source.slice(start, end);
        const token = { start, end, text, pairKey: null, canOpen: false, canClose: false, role: 'other' };
        const ch = text[0];
        if ((ch === '*' || ch === '_' || ch === '~' || ch === '`') && [...text].every((c) => c === ch)) {
            const prev = start > 0 ? source[start - 1] : ' ';
            const next = end < source.length ? source[end] : ' ';
            token.canOpen = !isWhitespaceChar(next) && (!isPunctuationChar(next) || isWhitespaceChar(prev) || isPunctuationChar(prev));
            token.canClose = !isWhitespaceChar(prev) && (!isPunctuationChar(prev) || isWhitespaceChar(next) || isPunctuationChar(next));
            token.pairKey = `${ch === '`' ? 'code' : 'emphasis'}:${text}`;
            if (token.canOpen !== token.canClose) token.role = token.canOpen ? 'open' : 'close';
            return token;
        }
        if (text === '[' || text === '![') {
            token.canOpen = true;
            token.pairKey = 'link';
            return token;
        }
        if (text.startsWith('](')) {
            token.canClose = true;
            token.pairKey = 'link';
            return token;
        }
        const closeTag = /^<\/([a-z][\w-]*)\s*>$/i.exec(text);
        if (closeTag) {
            token.canClose = true;
            token.pairKey = `html:${closeTag[1].toLowerCase()}`;
            return token;
        }
        const openTag = /^<([a-z][\w-]*)\b[^>]*>$/i.exec(text);
        if (openTag && !text.endsWith('/>') && !DELETE_HTML_VOID_TAGS.has(openTag[1].toLowerCase())) {
            token.canOpen = true;
            token.pairKey = `html:${openTag[1].toLowerCase()}`;
        }
        return token;
    }

    /**
     * Alternative deletion for selections that cross formatting boundaries,
     * e.g. from inside `*action*` into the following "dialogue". Deletes only
     * the selected characters and the whitespace between them, keeps the
     * Markdown syntax that formats surviving text, removes syntax pairs whose
     * content is now empty (`**`, `[](url)`), and moves whitespace across kept
     * emphasis delimiters so a closer is not left after a space (`*a *`) nor an
     * opener before one (`* a*`). Returns the new source, or null.
     */
    function buildDelimiterPreservingText(source, aligned) {
        const { matched, skips, beforeStart, afterEnd } = aligned ?? {};
        if (typeof source !== 'string' || !Array.isArray(matched) || !matched.length || !Array.isArray(skips)) return null;
        const first = matched[0];
        const last = matched[matched.length - 1];
        if (!Number.isInteger(beforeStart) || !Number.isInteger(afterEnd) || beforeStart > first || afterEnd <= last) return null;
        const matchedSet = new Set(matched);
        const skipByStart = new Map(skips.map((skip) => [skip.start, skip]));

        const pieces = [];
        for (let i = beforeStart; i < afterEnd;) {
            if (matchedSet.has(i)) {
                pieces.push({ kind: 'content', start: i, end: i + 1 });
                i++;
                continue;
            }
            const skip = skipByStart.get(i);
            if (!skip || skip.end <= i) return null;
            const text = source.slice(i, skip.end);
            const zone = i < first ? 'before' : (i > last ? 'after' : 'inside');
            if (text.length === 1 && isWhitespaceChar(text)) {
                pieces.push({ kind: 'ws', start: i, end: skip.end, text, zone });
            } else {
                const prev = pieces[pieces.length - 1];
                const mergesRun = prev?.kind === 'syntax' && prev.end === i && text.length === 1
                    && ((prev.text[0] === text && '*_~`'.includes(text)) || (prev.text === '!' && text === '['));
                if (mergesRun) {
                    prev.end = skip.end;
                    prev.text += text;
                } else {
                    pieces.push({ kind: 'syntax', start: i, end: skip.end, text, zone });
                }
            }
            i = skip.end;
        }

        // Pair syntax whose content was entirely deleted. Nothing between two
        // syntax pieces survives, so an opener directly followed (through other
        // syntax) by its closer now formats nothing.
        const stack = [];
        for (let i = 0; i < pieces.length; i++) {
            const piece = pieces[i];
            if (piece.kind !== 'syntax') continue;
            if (piece.text === '\\' && pieces[i + 1]?.kind === 'content') {
                piece.remove = true; // escape of a deleted character
                continue;
            }
            const token = classifySyntaxToken(source, piece.start, piece.end);
            piece.token = token;
            const top = stack[stack.length - 1];
            if (token.canClose && top && top.token.pairKey === token.pairKey) {
                stack.pop();
                top.remove = true;
                piece.remove = true;
            } else if (token.canOpen) {
                stack.push(piece);
            }
        }

        const seq = [];
        let prefixStart = beforeStart;
        while (prefixStart > 0 && isWhitespaceChar(source[prefixStart - 1])) prefixStart--;
        if (prefixStart < beforeStart) seq.push({ kind: 'ws', text: source.slice(prefixStart, beforeStart) });
        for (const piece of pieces) {
            if (piece.kind === 'content' || piece.remove) continue;
            if (piece.kind === 'ws') {
                if (piece.zone !== 'inside') seq.push({ kind: 'ws', text: piece.text });
                continue;
            }
            seq.push({ kind: 'syntax', text: piece.text, role: piece.token?.role ?? 'other' });
        }
        let suffixEnd = afterEnd;
        while (suffixEnd < source.length && isWhitespaceChar(source[suffixEnd])) suffixEnd++;
        if (suffixEnd > afterEnd) seq.push({ kind: 'ws', text: source.slice(afterEnd, suffixEnd) });

        // Closers move left and openers move right past whitespace; each swap
        // strictly advances one of them, and the guard bounds the loop anyway.
        let changed = true;
        for (let guard = 0; changed && guard <= seq.length * seq.length; guard++) {
            changed = false;
            for (let i = 0; i < seq.length - 1; i++) {
                const a = seq[i];
                const b = seq[i + 1];
                if ((a.kind === 'ws' && b.role === 'close') || (a.role === 'open' && b.kind === 'ws')) {
                    seq[i] = b;
                    seq[i + 1] = a;
                    changed = true;
                }
            }
        }
        // Moving whitespace can leave two runs side by side ("Say  **text**").
        // Keep line breaks, which render as markup, but collapse plain spaces.
        const joined = [];
        for (const piece of seq) {
            const prev = joined[joined.length - 1];
            if (piece.kind === 'ws' && prev?.kind === 'ws') {
                if (prev.text.includes('\n') || piece.text.includes('\n')) prev.text += piece.text;
                else if (piece.text.length > prev.text.length) prev.text = piece.text;
                continue;
            }
            joined.push({ ...piece });
        }
        return source.slice(0, prefixStart) + joined.map((piece) => piece.text).join('') + source.slice(suffixEnd);
    }

    function countNonWhitespace(text) {
        let count = 0;
        for (const ch of text) if (!/\s/.test(ch)) count++;
        return count;
    }

    /** Normalizes a renderer result (plain text, or `{ text, signature }`). */
    function readRenderOutput(output) {
        if (typeof output === 'string') return { text: output, signature: null };
        if (!output || typeof output.text !== 'string') return null;
        return { text: output.text, signature: Array.isArray(output.signature) ? output.signature : null };
    }

    /** Source span covering every change between `source` and `newText`. */
    function changedSpan(source, newText) {
        let start = 0;
        while (start < source.length && start < newText.length && source[start] === newText[start]) start++;
        let end = source.length;
        let newEnd = newText.length;
        while (end > start && newEnd > start && source[end - 1] === newText[newEnd - 1]) {
            end--;
            newEnd--;
        }
        return { start, end };
    }

    /**
     * Map one rendered selection to a source edit. The span proposed by the
     * alignment is first checked with boundary markers, then each candidate
     * edit is accepted only if it re-renders to exactly the expected text.
     */
    function mapDeletionSelection({ source, layoutText, selStart, selEnd, renderToText, baselineSignature = null }) {
        const expected = normalizeRenderedText(layoutText.slice(0, selStart) + layoutText.slice(selEnd));
        let expectedSignature = null;
        if (Array.isArray(baselineSignature)) {
            const k1 = countNonWhitespace(layoutText.slice(0, selStart));
            const k2 = k1 + countNonWhitespace(layoutText.slice(selStart, selEnd));
            expectedSignature = [...baselineSignature.slice(0, k1), ...baselineSignature.slice(k2)];
        }
        // 'formatting' when the surviving text renders exactly as before, 'text'
        // when only its characters match (e.g. a leftover `*` became a list
        // bullet), null when the candidate is wrong.
        const checkCandidate = (newText) => {
            if (typeof newText !== 'string' || newText === source) return null;
            let got;
            try {
                got = readRenderOutput(renderToText(newText));
            } catch {
                return null;
            }
            if (!got || normalizeRenderedText(got.text) !== expected) return null;
            if (!expectedSignature || !got.signature) return 'formatting';
            const same = got.signature.length === expectedSignature.length
                && got.signature.every((path, i) => path === expectedSignature[i]);
            return same ? 'formatting' : 'text';
        };

        const widenedCandidate = (candidate) => {
            const rawSegments = Array.isArray(candidate.segments) && candidate.segments.length
                ? candidate.segments
                : [{ start: candidate.start, end: candidate.end }];
            const adjusted = [];
            for (const segment of rawSegments) {
                const widened = adjustSpanForMarkdown(source, segment.start, segment.end);
                if (!widened) return null;
                adjusted.push(widened);
            }
            adjusted.sort((a, b) => a.start - b.start);
            const merged = [];
            for (const segment of adjusted) {
                const last = merged[merged.length - 1];
                if (last && segment.start <= last.end) last.end = Math.max(last.end, segment.end);
                else merged.push({ start: segment.start, end: segment.end });
            }
            let newText = '';
            let cursor = 0;
            for (const segment of merged) {
                if (!Number.isInteger(segment.start) || !Number.isInteger(segment.end)) return null;
                if (segment.start < cursor || segment.end > source.length || segment.start >= segment.end) return null;
                newText += source.slice(cursor, segment.start);
                cursor = segment.end;
            }
            newText += source.slice(cursor);
            return { start: merged[0].start, end: merged[merged.length - 1].end, segments: merged, newText };
        };

        const aligned = alignRenderedToSource(layoutText, source, selStart, selEnd);
        if (!aligned) return { error: 'unmappable' };
        // Word markers can glue onto an adjacent `_x_` and stop it rendering as
        // emphasis, so invisible non-word markers get a second chance. Either
        // pair rendering in place proves the position.
        const markerPairs = [
            ['SWIPEDELETESTARTBOUNDARY', 'SWIPEDELETEENDBOUNDARY'],
            ['\u2063\u2064\u2063', '\u2064\u2063\u2064'],
        ];
        // A marker between `\` and the character it escapes would unescape it.
        const escape = aligned.skips.find((skip) => skip.end === aligned.start && skip.end - skip.start === 1
            && source[skip.start] === '\\');
        const markStart = escape ? escape.start : aligned.start;
        let verifiedPosition = false;
        for (const [startMarker, endMarker] of markerPairs) {
            if ([startMarker, endMarker].some((marker) => source.includes(marker) || layoutText.includes(marker))) continue;
            const markedSource = source.slice(0, markStart) + startMarker
                + source.slice(markStart, aligned.end) + endMarker + source.slice(aligned.end);
            const markedExpected = layoutText.slice(0, selStart) + startMarker
                + layoutText.slice(selStart, selEnd) + endMarker + layoutText.slice(selEnd);
            try {
                const marked = readRenderOutput(renderToText(markedSource));
                if (marked && normalizeRenderedText(marked.text) === normalizeRenderedText(markedExpected)) {
                    verifiedPosition = true;
                    break;
                }
            } catch {
                return { error: 'render_failed' };
            }
        }
        if (!verifiedPosition) return { error: 'ambiguous' };

        // Widening deletes whole Markdown constructs and yields the cleanest
        // source; it cannot handle a selection that crosses a formatting
        // boundary, which the delimiter-preserving edit handles instead. A
        // candidate that keeps the surviving formatting wins; one that only
        // matches the text is the last resort.
        const candidates = [
            () => widenedCandidate(aligned),
            () => {
                const preserved = buildDelimiterPreservingText(source, aligned);
                if (typeof preserved !== 'string') return null;
                const span = changedSpan(source, preserved);
                return { ...span, segments: [span], newText: preserved };
            },
        ];
        let textOnly = null;
        for (const build of candidates) {
            const candidate = build();
            if (!candidate) continue;
            const quality = checkCandidate(candidate.newText);
            if (quality === 'formatting') return candidate;
            if (quality === 'text' && !textOnly) textOnly = candidate;
        }
        return textOnly ?? { error: 'unmappable' };
    }

    /**
     * Map a rendered selection [selStart, selEnd) of layoutText to a span of
     * `source` and return the resulting text. `renderToText(source)` must produce
     * the rendered plain text for any source string (the same pipeline that
     * produced the bubble). Alignment only proposes a span: temporary boundary
     * markers must render at the selected positions before that span is trusted.
     * Comparing the final plain text alone cannot distinguish repeated text.
     * `renderToText` may also return `{ text, signature }` (see
     * formattingSignature) to prefer edits that keep the surviving formatting.
     */
    function computeDeletionSpan({ source, layoutText, selStart, selEnd, renderToText }) {
        if (typeof source !== 'string' || typeof layoutText !== 'string') return { error: 'invalid_input' };
        if (typeof renderToText !== 'function') return { error: 'no_renderer' };
        if (!Number.isInteger(selStart) || !Number.isInteger(selEnd)) return { error: 'invalid_selection' };
        if (selStart < 0 || selEnd > layoutText.length || selStart >= selEnd) return { error: 'invalid_selection' };
        const selText = layoutText.slice(selStart, selEnd);
        if (selText.trim() === '') return { error: 'whitespace_selection' };

        let baseline;
        try {
            baseline = readRenderOutput(renderToText(source));
        } catch (e) {
            log('computeDeletionSpan – baseline render failed', e?.message);
            return { error: 'render_failed' };
        }
        if (!baseline || normalizeRenderedText(baseline.text) !== normalizeRenderedText(layoutText)) {
            return { error: 'display_mismatch' };
        }
        const baselineSignature = baseline.signature?.length === countNonWhitespace(baseline.text) ? baseline.signature : null;

        const result = mapDeletionSelection({ source, layoutText, selStart, selEnd, renderToText, baselineSignature });
        if (!result.error) return result;
        // A selection that starts or ends on a line or paragraph break (e.g. a
        // triple-clicked paragraph) puts a boundary marker next to a break the
        // renderer turns into markup, so retry without that edge whitespace.
        let trimmedStart = selStart;
        while (trimmedStart < selEnd && isWhitespaceChar(layoutText[trimmedStart])) trimmedStart++;
        if (!layoutText.slice(selStart, trimmedStart).includes('\n')) trimmedStart = selStart;
        let trimmedEnd = selEnd;
        while (trimmedEnd > trimmedStart && isWhitespaceChar(layoutText[trimmedEnd - 1])) trimmedEnd--;
        if (!layoutText.slice(trimmedEnd, selEnd).includes('\n')) trimmedEnd = selEnd;
        if (trimmedStart === selStart && trimmedEnd === selEnd) return result;
        const retry = mapDeletionSelection({
            source, layoutText, selStart: trimmedStart, selEnd: trimmedEnd, renderToText, baselineSignature,
        });
        return retry.error ? result : retry;
    }

    function describeDeletionError(code) {
        switch (code) {
            case 'whitespace_selection':
                return 'Select some text to delete.';
            case 'display_mismatch':
                return 'The displayed text differs from the message source (macro, translation or display-only transformation); nothing was changed.';
            case 'ambiguous':
                return 'The selection matches several places in the message source; nothing was changed.';
            case 'render_failed':
                return 'Could not render the message for verification; nothing was changed.';
            default:
                return 'The selection could not be mapped to the message source; nothing was changed.';
        }
    }

    function formatMessageHtml(source, target) {
        const ctx = globalThis.SillyTavern?.getContext?.();
        const msg = target?.msg;
        if (typeof ctx?.messageFormatting === 'function') {
            const name = msg?.name || (msg?.is_user ? ctx.name1 : ctx.name2) || '';
            try {
                const html = ctx.messageFormatting(source, name, Boolean(msg?.is_system), Boolean(msg?.is_user), target.mesId, {}, false);
                return typeof html === 'string' ? html : '';
            } catch (e) {
                console.warn(`[${EXTENSION_NAME}] messageFormatting error:`, e);
            }
        }
        const div = document.createElement('div');
        div.textContent = source;
        return div.innerHTML;
    }

    // Paragraphs and quote wrappers do not count as formatting: a deletion may
    // legitimately merge two paragraphs or leave a quotation mark unpaired.
    const DELETE_SIGNATURE_IGNORED_TAGS = new Set(['P', 'Q', 'BR']);

    /**
     * Formatting context of every non-whitespace character of `rootEl`'s text
     * (the em/strong/a/code/... elements around it), in text order. Bounded like
     * collectTextLayout; null when the tree is too large.
     */
    function formattingSignature(rootEl, maxNodes = DELETE_MAX_LAYOUT_NODES) {
        const signature = [];
        const stack = [{ node: rootEl, path: '' }];
        let visitedCount = 0;
        while (stack.length) {
            const { node, path } = stack.pop();
            if (!node || typeof node !== 'object') continue;
            if (++visitedCount > maxNodes) return null;
            if (node.nodeType === 3) {
                const text = typeof node.textContent === 'string' ? node.textContent : '';
                for (const ch of text) if (!/\s/.test(ch)) signature.push(path);
                continue;
            }
            if (node.nodeType !== 1) continue;
            const tag = typeof node.tagName === 'string' ? node.tagName.toUpperCase() : '';
            if (node !== rootEl && DELETE_SKIPPED_TAGS.has(tag)) continue;
            const childPath = node === rootEl || DELETE_SIGNATURE_IGNORED_TAGS.has(tag) ? path : `${path}/${tag}`;
            const children = node.childNodes;
            const childCount = children && typeof children.length === 'number' ? children.length : 0;
            for (let i = childCount - 1; i >= 0; i--) stack.push({ node: children[i], path: childPath });
        }
        return signature;
    }

    /**
     * Rendered plain text and formatting signature for `source` via the same
     * pipeline SillyTavern used for the bubble.
     */
    function renderSourceForDeletion(source, target) {
        if (typeof source !== 'string') return null;
        const scratch = document.createElement('div');
        scratch.innerHTML = formatMessageHtml(source, target);
        if (typeof scratch.querySelectorAll === 'function') {
            for (const tag of ['style', 'script', 'template', 'noscript']) {
                const nodes = scratch.querySelectorAll(tag);
                if (nodes && typeof nodes.forEach === 'function') nodes.forEach((el) => el.remove());
            }
        }
        return {
            text: typeof scratch.textContent === 'string' ? scratch.textContent : '',
            signature: formattingSignature(scratch),
        };
    }

    /**
     * Decide what a deletion inside `mesEl` edits:
     *  - assistant: msg.mes (+ the active swipes[] entry)
     *  - canonical: a user message's msg.mes
     *  - linked:    the linked user text of the assistant swipe currently shown in
     *               this user bubble (data-swipe-linked="1"); msg.mes is untouched
     * Returns null when the bubble must not be edited (system messages, bubbles
     * showing a transformed display_text, or unresolvable linked state).
     */
    function resolveDeletionTarget(mesEl) {
        const ctx = globalThis.SillyTavern?.getContext?.();
        const chat = ctx?.chat;
        if (!chat || !mesEl) return null;
        const chatIndex = getChatIndexForMesEl(mesEl);
        if (chatIndex == null) return null;
        const msg = chat[chatIndex];
        if (!msg || msg.is_system) return null;
        const mesId = getMesIdFromChatIndex(chatIndex);
        const textEl = getMesTextEl(mesEl);
        if (!textEl) return null;
        const base = { chatIndex, mesId, msg, mesEl, textEl };

        if (!msg.is_user) {
            if (typeof msg.extra?.display_text === 'string') return null;
            if (typeof msg.mes !== 'string') return null;
            return { ...base, kind: 'assistant', source: msg.mes };
        }

        if (mesEl.getAttribute('data-swipe-linked') === '1') {
            // Edit the swipe link that decided this bubble (the same rule that
            // rendered it and that the prompt uses).
            const resolved = resolveTurnUserText(chatIndex);
            if (!resolved || resolved.source === 'edited') return null;
            const aiMsg = chat[resolved.assistantIndex];
            const assistantMesId = getMesIdFromChatIndex(resolved.assistantIndex);
            return { ...base, kind: 'linked', source: resolved.text, aiMsg, assistantMesId, swipeId: resolved.swipeId };
        }

        if (typeof msg.extra?.display_text === 'string') return null;
        if (typeof msg.mes !== 'string') return null;
        return { ...base, kind: 'canonical', source: msg.mes };
    }

    // ── Selection detection & menu ──

    function getSelectionInfo() {
        const selection = getDomSelection();
        if (!selection || !(selection.rangeCount > 0) || selection.isCollapsed) return null;
        let range;
        try {
            range = selection.getRangeAt(0);
        } catch {
            return null;
        }
        if (!range || range.collapsed) return null;
        let text;
        try {
            text = String(range.toString());
        } catch {
            return null;
        }
        if (text.trim() === '') return null;
        const startMesText = closestElementFromNode(range.startContainer, '.mes_text');
        const endMesText = closestElementFromNode(range.endContainer, '.mes_text');
        if (!startMesText || startMesText !== endMesText || !startMesText.isConnected) return null;
        const mesEl = startMesText.closest('.mes');
        if (!mesEl || !mesEl.closest('#chat')) return null;
        return { selection, range, mesTextEl: startMesText, mesEl };
    }

    function isSelectionExcluded(info, allowInFlight = false) {
        // Exclusion is decided from the Range itself, not document.activeElement:
        // SillyTavern keeps focus on the send box most of the time (and touch or
        // keyboard selections don't move it), so an activeElement check would hide
        // the button for perfectly valid chat selections. Selections inside a
        // textarea/contenteditable never resolve to a .mes_text text node anyway,
        // and the native editor is caught via its .edit_textarea below.
        if (closestElementFromNode(info.range.startContainer, DELETE_BLOCKED_SELECTOR)) return true;
        if (closestElementFromNode(info.range.endContainer, DELETE_BLOCKED_SELECTOR)) return true;
        if (info.mesTextEl.querySelector('.edit_textarea, #curEditTextarea')) return true;
        if (deletionInFlight && !allowInFlight) return true;
        if (isGenerating || hasActiveGenerationUi()) return true;
        return false;
    }

    function processSelectionForDelete() {
        const info = getSelectionInfo();
        if (!info || isSelectionExcluded(info)) {
            removeDeleteMenu();
            return false;
        }
        const target = resolveDeletionTarget(info.mesEl);
        if (!target || target.textEl !== info.mesTextEl) {
            removeDeleteMenu();
            return false;
        }
        let range = info.range;
        try {
            if (typeof info.range.cloneRange === 'function') range = info.range.cloneRange();
        } catch { /* keep the live range */ }
        pendingDeleteSelection = {
            range, mesTextEl: info.mesTextEl, mesEl: info.mesEl,
            chatId: lastChatId, msg: target.msg, source: target.source, kind: target.kind,
            aiMsg: target.aiMsg, swipeId: target.swipeId ?? target.msg.swipe_id,
            startContainer: range.startContainer, startOffset: range.startOffset,
            endContainer: range.endContainer, endOffset: range.endOffset,
        };
        showDeleteMenu(range);
        return true;
    }

    function ensureDeleteMenuEl() {
        if (deleteMenuEl && deleteMenuEl.isConnected) return deleteMenuEl;
        const menu = document.createElement('div');
        menu.className = DELETE_MENU_CLASS;
        const button = document.createElement('div');
        button.className = `menu_button ${DELETE_BUTTON_CLASS}`;
        button.textContent = 'Delete';
        button.title = 'Delete the selected text from this message';
        // pointerdown (not click) so the selection survives the press and touch
        // devices don't deliver a second, synthesized mouse activation.
        button.addEventListener('pointerdown', onDeleteMenuPointerDown);
        menu.appendChild(button);
        const host = document.body || document.documentElement;
        if (!host) return null;
        host.appendChild(menu);
        deleteMenuEl = menu;
        return menu;
    }

    function showDeleteMenu(range) {
        if (!ensureDeleteMenuEl()) return;
        positionDeleteMenu(range);
    }

    function positionDeleteMenu(range = pendingDeleteSelection?.range) {
        if (!deleteMenuEl || !range || typeof range.getBoundingClientRect !== 'function') return;
        let rect;
        try {
            rect = range.getBoundingClientRect();
        } catch {
            return;
        }
        if (!rect) return;
        const viewportWidth = Number(globalThis.innerWidth) || 0;
        const viewportHeight = Number(globalThis.innerHeight) || 0;
        const menuWidth = Number(deleteMenuEl.offsetWidth) || 0;
        const menuHeight = Number(deleteMenuEl.offsetHeight) || 0;
        let left = Number(rect.left) || 0;
        let top = (Number(rect.bottom) || 0) + 6;
        if (viewportWidth && left + menuWidth > viewportWidth) left = viewportWidth - menuWidth - 4;
        if (viewportHeight && top + menuHeight > viewportHeight) top = (Number(rect.top) || 0) - menuHeight - 6;
        deleteMenuEl.style.left = `${Math.max(0, left)}px`;
        deleteMenuEl.style.top = `${Math.max(0, top)}px`;
    }

    function removeDeleteMenu() {
        if (deleteMenuEl) {
            try {
                deleteMenuEl.remove();
            } catch { /* ignore */ }
            deleteMenuEl = null;
        }
        pendingDeleteSelection = null;
    }

    function cancelDeleteSelectionTimer() {
        if (deleteSelectionTimer) {
            clearTimeout(deleteSelectionTimer);
            deleteSelectionTimer = null;
        }
        deleteSelectionSeq++;
    }

    function onSelectionChange() {
        if (deleteSelectionTimer) clearTimeout(deleteSelectionTimer);
        const seq = ++deleteSelectionSeq;
        deleteSelectionTimer = setTimeout(() => {
            deleteSelectionTimer = null;
            if (seq !== deleteSelectionSeq || !isCurrentInstance() || deletionInFlight) return;
            try {
                processSelectionForDelete();
            } catch (e) {
                console.warn(`[${EXTENSION_NAME}] selection processing failed`, e);
                removeDeleteMenu();
            }
        }, DELETE_SELECTION_DEBOUNCE_MS);
    }

    function onDocumentPointerDown(e) {
        if (!deleteMenuEl) return;
        const target = e?.target;
        if (target && typeof deleteMenuEl.contains === 'function' && deleteMenuEl.contains(target)) return;
        removeDeleteMenu();
    }

    function onChatScroll() {
        if (deleteMenuEl) positionDeleteMenu();
    }

    function onDeleteMenuPointerDown(e) {
        if (e) {
            if (typeof e.preventDefault === 'function') e.preventDefault();
            if (typeof e.stopPropagation === 'function') e.stopPropagation();
        }
        if (deletionInFlight) return;
        const pending = pendingDeleteSelection;
        if (!pending) {
            removeDeleteMenu();
            return;
        }
        void executeSelectionDelete(pending);
    }

    function installDeleteSelectionListeners() {
        document.addEventListener('selectionchange', onSelectionChange);
        document.addEventListener('pointerdown', onDocumentPointerDown, true);
        const chatEl = typeof document.getElementById === 'function' ? document.getElementById('chat') : null;
        if (chatEl && typeof chatEl.addEventListener === 'function') {
            chatEl.addEventListener('scroll', onChatScroll, { passive: true });
            deleteChatScrollEl = chatEl;
        }
    }

    function uninstallDeleteSelectionListeners() {
        document.removeEventListener('selectionchange', onSelectionChange);
        document.removeEventListener('pointerdown', onDocumentPointerDown, true);
        if (deleteChatScrollEl && typeof deleteChatScrollEl.removeEventListener === 'function') {
            deleteChatScrollEl.removeEventListener('scroll', onChatScroll);
        }
        deleteChatScrollEl = null;
    }

    // ── Applying the edit ──

    function snapshotDeletionState(target) {
        const { msg, textEl, mesEl } = target;
        const ctx = globalThis.SillyTavern?.getContext?.();
        const swipeId = typeof msg.swipe_id === 'number' ? msg.swipe_id : null;
        const hasSwipeEntry = swipeId != null && Array.isArray(msg.swipes) && swipeId >= 0 && swipeId < msg.swipes.length;
        return {
            mes: msg.mes,
            swipeId,
            hasSwipeEntry,
            swipeEntry: hasSwipeEntry ? msg.swipes[swipeId] : undefined,
            innerHTML: textEl.innerHTML,
            linkedAttr: mesEl.getAttribute('data-swipe-linked'),
            pendingEntries: new Map(pendingEditedEntries),
            pendingNormalUserText,
            chat: ctx?.chat,
            chatId: ctx?.chatId,
            metadata: ctx?.chatMetadata,
            hadTainted: Object.hasOwn(ctx?.chatMetadata ?? {}, 'tainted'),
            tainted: ctx?.chatMetadata?.tainted,
            activeKey,
            linked: target.kind === 'linked'
                ? { text: getLinkedUserText(target.aiMsg, target.swipeId), manual: isManualLinkedUserText(target.aiMsg, target.swipeId) }
                : null,
        };
    }

    function writeLinkedTextState(assistantMsg, swipeId, state) {
        if (!assistantMsg || !Number.isFinite(swipeId)) return false;
        if (state && typeof state.text === 'string') {
            return setLinkedUserText(assistantMsg, swipeId, state.text, { manual: state.manual === true });
        }
        return deleteLinkedUserText(assistantMsg, swipeId);
    }

    function restoreDeletionState(target, snapshot) {
        const { msg, textEl, mesEl } = target;
        msg.mes = snapshot.mes;
        if (snapshot.hasSwipeEntry && Array.isArray(msg.swipes)) msg.swipes[snapshot.swipeId] = snapshot.swipeEntry;
        if (snapshot.linked) writeLinkedTextState(target.aiMsg, target.swipeId, snapshot.linked);
        const ctx = globalThis.SillyTavern?.getContext?.();
        if (ctx?.chat === snapshot.chat && ctx?.chatId === snapshot.chatId) {
            pendingEditedEntries.clear();
            for (const [key, entry] of snapshot.pendingEntries) pendingEditedEntries.set(key, entry);
            pendingNormalUserText = snapshot.pendingNormalUserText;
            activeKey = snapshot.activeKey;
        }
        if (snapshot.metadata) {
            if (snapshot.hadTainted) snapshot.metadata.tainted = snapshot.tainted;
            else delete snapshot.metadata.tainted;
        }
        try {
            textEl.innerHTML = snapshot.innerHTML;
        } catch { /* ignore */ }
        if (snapshot.linkedAttr == null) mesEl.removeAttribute('data-swipe-linked');
        else mesEl.setAttribute('data-swipe-linked', snapshot.linkedAttr);
    }

    async function emitMessageLifecycleEvent(ctx, eventKey, mesId) {
        const eventName = ctx?.event_types?.[eventKey] ?? ctx?.eventTypes?.[eventKey];
        if (!eventName || typeof ctx?.eventSource?.emit !== 'function') return;
        await ctx.eventSource.emit(eventName, mesId);
    }

    function assertDeletionChatCurrent(ctx) {
        const current = globalThis.SillyTavern?.getContext?.();
        if (!isCurrentInstance() || current?.chat !== ctx?.chat || current?.chatId !== ctx?.chatId
            || current?.groupId !== ctx?.groupId || current?.characterId !== ctx?.characterId) {
            throw new Error('The chat changed during the edit');
        }
    }

    async function persistChatNow(ctx) {
        assertDeletionChatCurrent(ctx);
        if (typeof ctx?.saveChat !== 'function' || typeof ctx?.getRequestHeaders !== 'function'
            || typeof globalThis.fetch !== 'function' || !ctx.chatId) {
            throw new Error('Verified chat saving is unavailable');
        }
        const isGroup = Boolean(ctx.groupId);
        const character = ctx.characters?.[ctx.characterId];
        if (!isGroup && !character?.avatar) throw new Error('Cannot identify the chat file');
        // Use the native save API (including its integrity checks and save lock).
        // It resolves even on some failures, so verify the exact serialized chat
        // through the same read endpoints SillyTavern uses to load it.
        const expected = JSON.stringify(ctx.chat);
        const body = isGroup ? { id: ctx.chatId }
            : { ch_name: character.name, file_name: ctx.chatId, avatar_url: character.avatar };
        await ctx.saveChat();
        assertDeletionChatCurrent(ctx);
        const response = await globalThis.fetch(isGroup ? '/api/chats/group/get' : '/api/chats/get', {
            method: 'POST', cache: 'no-store', headers: ctx.getRequestHeaders(),
            body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new Error(`Could not verify chat save (${response.status})`);
        const saved = await response.json();
        assertDeletionChatCurrent(ctx);
        if (!Array.isArray(saved) || !saved[0]?.chat_metadata || JSON.stringify(saved.slice(1)) !== expected) {
            throw new Error('Saved chat does not contain the expected edit');
        }
    }

    function renderMessageTextAfterEdit(target) {
        const ctx = globalThis.SillyTavern?.getContext?.();
        const { msg, mesId, textEl } = target;
        if (typeof ctx?.updateMessageBlock === 'function') {
            ctx.updateMessageBlock(mesId, msg);
            return;
        }
        textEl.innerHTML = formatMessageHtml(typeof msg.mes === 'string' ? msg.mes : '', target);
    }

    function pushDeletionHistory(entry) {
        deletionHistory.push(entry);
        while (deletionHistory.length > DELETE_HISTORY_LIMIT) deletionHistory.shift();
        updateUndoButtons();
    }

    /**
     * Canonical user / assistant edit in SillyTavern's messageEditDone order.
     * Any failure restores the snapshot (data, session state, DOM).
     */
    async function applyCanonicalTextChange(target, newText, { record = true } = {}) {
        const ctx = { ...globalThis.SillyTavern?.getContext?.() };
        const { msg, mesId } = target;
        const snapshot = snapshotDeletionState(target);
        try {
            msg.mes = newText;
            if (snapshot.hasSwipeEntry) msg.swipes[snapshot.swipeId] = newText;
            if (ctx?.chatMetadata && typeof ctx.chatMetadata === 'object') ctx.chatMetadata.tainted = true;
            await emitMessageLifecycleEvent(ctx, 'MESSAGE_EDITED', mesId);
            assertDeletionChatCurrent(ctx);
            renderMessageTextAfterEdit(target);
            await emitMessageLifecycleEvent(ctx, 'MESSAGE_UPDATED', mesId);
            await persistChatNow(ctx);
        } catch (e) {
            restoreDeletionState(target, snapshot);
            console.warn(`[${EXTENSION_NAME}] Delete selection failed; previous message state restored`, e);
            notifyDeleteError('Saving could not be confirmed. The message was restored locally; reload to check the saved chat.');
            return false;
        }
        if (record) {
            pushDeletionHistory({
                chatId: lastChatId,
                kind: target.kind,
                mesId,
                msg,
                swipeId: snapshot.hasSwipeEntry ? snapshot.swipeId : null,
                before: { mes: snapshot.mes, swipeEntry: snapshot.swipeEntry },
                after: { mes: msg.mes, swipeEntry: snapshot.hasSwipeEntry ? msg.swipes[snapshot.swipeId] : undefined },
            });
        }
        log('Delete selection – updated', target.kind, 'message', mesId, '->', String(msg.mes).substring(0, 60));
        return true;
    }

    /**
     * Linked-text-only edit: writes the linked user text of one assistant swipe
     * through the existing manual override path (no MESSAGE_EDITED, msg.mes is
     * untouched) and re-renders the bubble through the normal swipe render path.
     */
    async function applyLinkedTextChange(target, state, { record = true } = {}) {
        const ctx = { ...globalThis.SillyTavern?.getContext?.() };
        const { aiMsg, assistantMesId, swipeId, mesId } = target;
        const snapshot = snapshotDeletionState(target);
        const key = `${assistantMesId}:${swipeId}`;
        try {
            let wrote;
            if (state && typeof state.text === 'string' && state.manual === true) {
                wrote = applyManualLinkedText(assistantMesId, [swipeId], state.text, { save: false, scheduleRender: false });
            } else {
                // Undo of an automatic link (or an unlink): same bookkeeping as the
                // manual path, but without the manual flag.
                wrote = writeLinkedTextState(aiMsg, swipeId, state);
                deletePendingEditedEntry(key);
                if (wrote) {
                    ensureEditsButtonForAssistant(assistantMesId);
                }
            }
            if (!wrote) throw new Error(`linked text write failed for ${key}`);
            handleSwipeChangeForAssistant(assistantMesId);
            await persistChatNow(ctx);
        } catch (e) {
            restoreDeletionState(target, snapshot);
            try {
                assertDeletionChatCurrent(ctx);
                handleSwipeChangeForAssistant(assistantMesId);
            } catch { /* DOM was already restored from the snapshot */ }
            console.warn(`[${EXTENSION_NAME}] Delete selection failed; previous linked text restored`, e);
            notifyDeleteError('Saving could not be confirmed. The linked text was restored locally; reload to check the saved chat.');
            return false;
        }
        if (record) {
            pushDeletionHistory({
                chatId: lastChatId,
                kind: 'linked',
                mesId,
                msg: target.msg,
                aiMsg,
                assistantMesId,
                swipeId,
                before: { linked: snapshot.linked },
                after: { linked: { text: getLinkedUserText(aiMsg, swipeId), manual: isManualLinkedUserText(aiMsg, swipeId) } },
            });
        }
        log('Delete selection – updated linked text', key, '->', state?.text == null ? '(unlinked)' : state.text.substring(0, 60));
        return true;
    }

    async function executeSelectionDelete(pending = pendingDeleteSelection) {
        if (deletionInFlight) return false;
        deletionInFlight = true;
        try {
            const range = pending?.range;
            const mesTextEl = pending?.mesTextEl;
            const mesEl = pending?.mesEl;
            if (!range || !mesTextEl || !mesEl || !mesTextEl.isConnected || !mesEl.isConnected) return false;
            const live = getSelectionInfo();
            if (!live || isSelectionExcluded(live, true) || pending.chatId !== lastChatId
                || live.mesTextEl !== mesTextEl || live.mesEl !== mesEl
                || live.range.startContainer !== pending.startContainer || live.range.startOffset !== pending.startOffset
                || live.range.endContainer !== pending.endContainer || live.range.endOffset !== pending.endOffset) {
                notifyDeleteWarning('The selection changed; select the text again.');
                return false;
            }
            if (isGenerating || hasActiveGenerationUi()) {
                notifyDeleteWarning('Wait for the current generation to finish.');
                return false;
            }
            const target = resolveDeletionTarget(mesEl);
            if (!target || target.textEl !== mesTextEl || target.msg !== pending.msg
                || target.source !== pending.source || target.kind !== pending.kind || target.aiMsg !== pending.aiMsg
                || (target.swipeId ?? target.msg.swipe_id) !== pending.swipeId) {
                notifyDeleteWarning('This message can no longer be edited here.');
                return false;
            }
            const layout = collectTextLayout(mesTextEl);
            if (!layout) {
                notifyDeleteWarning('This message is too complex to map safely; nothing was changed.');
                return false;
            }
            const selStart = resolveBoundaryOffset(layout, live.range.startContainer, live.range.startOffset);
            const selEnd = resolveBoundaryOffset(layout, live.range.endContainer, live.range.endOffset);
            if (selStart == null || selEnd == null || selEnd <= selStart) {
                notifyDeleteWarning('The selection is no longer available.');
                return false;
            }
            const span = computeDeletionSpan({
                source: target.source,
                layoutText: layout.text,
                selStart,
                selEnd,
                renderToText: (text) => renderSourceForDeletion(text, target),
            });
            if (!span || span.error) {
                notifyDeleteWarning(describeDeletionError(span?.error));
                return false;
            }
            if (target.kind === 'linked') {
                return await applyLinkedTextChange(target, { text: span.newText, manual: true });
            }
            return await applyCanonicalTextChange(target, span.newText);
        } catch (e) {
            console.warn(`[${EXTENSION_NAME}] Delete selection failed`, e);
            notifyDeleteError('Deleting the selection failed; nothing was changed.');
            return false;
        } finally {
            removeDeleteMenu();
            try {
                const selection = getDomSelection();
                if (selection && typeof selection.removeAllRanges === 'function') selection.removeAllRanges();
            } catch { /* ignore */ }
            deletionInFlight = false;
        }
    }

    // ── Undo ──

    function isDeletionEntryAlive(entry) {
        if (!entry || entry.chatId !== lastChatId) return false;
        const chat = globalThis.SillyTavern?.getContext?.()?.chat;
        if (!chat) return false;
        const chatIndex = findChatIndexByMesId(entry.mesId);
        if (chatIndex == null || chat[chatIndex] !== entry.msg) return false;
        if (entry.kind === 'linked') {
            const aiMsg = resolveAssistantMsg(entry.assistantMesId);
            if (!aiMsg || aiMsg !== entry.aiMsg) return false;
            const swipeCount = Array.isArray(aiMsg.swipes) ? Math.max(1, aiMsg.swipes.length) : 1;
            return entry.swipeId >= 0 && entry.swipeId < swipeCount;
        }
        if (entry.swipeId != null) {
            return Array.isArray(entry.msg.swipes) && entry.swipeId < entry.msg.swipes.length;
        }
        return true;
    }

    function pruneDeletionHistory() {
        for (let i = deletionHistory.length - 1; i >= 0; i--) {
            if (!isDeletionEntryAlive(deletionHistory[i])) deletionHistory.splice(i, 1);
        }
        updateUndoButtons();
    }

    function clearDeletionHistory() {
        deletionHistory.length = 0;
        updateUndoButtons();
    }

    function findDeletionEntryIndexForMesId(mesId) {
        for (let i = deletionHistory.length - 1; i >= 0; i--) {
            const entry = deletionHistory[i];
            if (entry.mesId === mesId && entry.chatId === lastChatId) return i;
        }
        return -1;
    }

    function ensureUndoButton(mesEl, show) {
        if (!mesEl) return;
        const host = mesEl.querySelector('.mes_buttons') || mesEl.querySelector('.extraMesButtons');
        if (!host) return;
        const existing = mesEl.querySelector(`.${DELETE_UNDO_BUTTON_CLASS}`);
        if (!show) {
            if (existing) existing.remove();
            return;
        }
        if (existing) return;
        const btn = document.createElement('div');
        btn.className = `mes_button ${DELETE_UNDO_BUTTON_CLASS} fa-solid fa-rotate-left interactable`;
        btn.title = 'Undo selection delete';
        btn.setAttribute('data-i18n', '[title]Undo selection delete');
        const editBtn = host.querySelector('.mes_edit');
        if (editBtn && typeof host.insertBefore === 'function') host.insertBefore(btn, editBtn);
        else host.appendChild(btn);
    }

    function updateUndoButtons() {
        const wanted = new Set();
        for (const entry of deletionHistory) {
            if (entry.chatId === lastChatId) wanted.add(entry.mesId);
        }
        document.querySelectorAll(`.${DELETE_UNDO_BUTTON_CLASS}`).forEach((btn) => {
            const mesEl = typeof btn.closest === 'function' ? btn.closest('.mes') : null;
            const chatIndex = mesEl ? getChatIndexForMesEl(mesEl) : null;
            const mesId = chatIndex != null ? getMesIdFromChatIndex(chatIndex) : null;
            if (mesId == null || !wanted.has(mesId)) btn.remove();
        });
        for (const mesId of wanted) {
            const chatIndex = findChatIndexByMesId(mesId);
            const mesEl = chatIndex != null ? getMesElForChatIndex(chatIndex) : null;
            if (mesEl) ensureUndoButton(mesEl, true);
        }
    }

    function removeAllUndoButtons() {
        document.querySelectorAll(`.${DELETE_UNDO_BUTTON_CLASS}`).forEach((el) => el.remove());
    }

    /**
     * Undo the newest recorded deletion on this message. The entry must still
     * describe the live state (same message object, same swipe, text unchanged
     * since the deletion); otherwise it is dropped rather than applied blindly.
     */
    async function undoDeletionForMessage(mesEl) {
        if (deletionInFlight) return false;
        const chatIndex = getChatIndexForMesEl(mesEl);
        if (chatIndex == null) return false;
        const mesId = getMesIdFromChatIndex(chatIndex);
        pruneDeletionHistory();
        const index = findDeletionEntryIndexForMesId(mesId);
        if (index === -1) return false;
        const entry = deletionHistory[index];
        deletionInFlight = true;
        try {
            const msg = entry.msg;
            const textEl = getMesTextEl(mesEl);
            if (!textEl) return false;
            const base = { chatIndex, mesId, msg, mesEl, textEl };
            if (entry.kind === 'linked') {
                const current = getLinkedUserText(entry.aiMsg, entry.swipeId);
                if (current !== entry.after.linked.text) {
                    deletionHistory.splice(index, 1);
                    notifyDeleteWarning('The linked text changed since that deletion; undo skipped.');
                    return false;
                }
                deletionHistory.splice(index, 1);
                const target = { ...base, kind: 'linked', source: current, aiMsg: entry.aiMsg, assistantMesId: entry.assistantMesId, swipeId: entry.swipeId };
                const ok = await applyLinkedTextChange(target, entry.before.linked, { record: false });
                if (!ok) deletionHistory.splice(index, 0, entry);
                return ok;
            }
            if (entry.swipeId != null && msg.swipe_id !== entry.swipeId) {
                notifyDeleteWarning('Swipe back to the edited variant to undo that deletion.');
                return false;
            }
            if (msg.mes !== entry.after.mes) {
                deletionHistory.splice(index, 1);
                notifyDeleteWarning('The message changed since that deletion; undo skipped.');
                return false;
            }
            deletionHistory.splice(index, 1);
            const target = { ...base, kind: entry.kind, source: msg.mes };
            const ok = await applyCanonicalTextChange(target, entry.before.mes, { record: false });
            if (!ok) deletionHistory.splice(index, 0, entry);
            return ok;
        } catch (e) {
            console.warn(`[${EXTENSION_NAME}] Undo failed`, e);
            notifyDeleteError('Undo failed.');
            return false;
        } finally {
            deletionInFlight = false;
            updateUndoButtons();
        }
    }

    function teardownDeleteSelection() {
        uninstallDeleteSelectionListeners();
        cancelDeleteSelectionTimer();
        removeDeleteMenu();
        deletionHistory.length = 0;
        removeAllUndoButtons();
        deletionInFlight = false;
    }

    // ─── Delegated Click Handler ─────────────────────────────────────────────────

    function onDocumentClick(e) {
        const target = e.target;
        if (!(target instanceof Element)) return;

        // "Undo selection delete" button.
        const undoBtn = target.closest(`.${DELETE_UNDO_BUTTON_CLASS}`);
        if (undoBtn) {
            const undoMesEl = undoBtn.closest('.mes');
            if (undoMesEl) void undoDeletionForMessage(undoMesEl);
            return;
        }

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
        teardownDeleteSelection();
        hasMessageSwipedEvent = false;
        document.removeEventListener('click', onDocumentClick);
        document.removeEventListener('DOMContentLoaded', bootWithRuntimeBus);
        deleteOwnedGlobal('swipeLinkedUserEditInterceptor');
        deleteOwnedGlobal('swipeLinkedUserEditDebug');
        deleteOwnedGlobal('swipeLinkedUserEditTeardown');
        if (globalThis[INSTANCE_KEY] === instanceToken) {
            delete globalThis[INSTANCE_KEY];
        }
        log('Extension torn down');
    }

    exposeOwnedGlobal('swipeLinkedUserEditTeardown', teardown);

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
        uninstallDeleteSelectionListeners();

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
        bindEvent(eventSource, event_types.GENERATION_STOPPED, onGenerationStopped);
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
        if (event_types.MORE_MESSAGES_LOADED) {
            bindEvent(eventSource, event_types.MORE_MESSAGES_LOADED, onMoreMessagesLoaded);
        }

        // Delegated click handler for swipe buttons
        document.addEventListener('click', onDocumentClick);
        // Selection-based "Delete" menu (selectionchange / outside pointerdown / chat scroll)
        installDeleteSelectionListeners();

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
