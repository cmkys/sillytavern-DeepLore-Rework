/** DeepLore — Settings UI: load, bind, stats */
import {
    saveSettingsDebounced,
    chat,
} from '../../../../../../script.js';
import { ConnectionManagerRequestService } from '../../../../shared.js';
import { escapeHtml } from '../../../../../utils.js';
import { applyHtmlI18n } from '../i18n/i18n.js';
import { callGenericPopup, POPUP_TYPE, POPUP_RESULT } from '../../../../../popup.js';
import { renderExtensionTemplateAsync } from '../../../../../extensions.js';
import { accountStorage } from '../../../../../util/AccountStorage.js';
import { EXTENSION_REF } from '../ext-path.js';
import { buildAiChatContext } from '../../core/utils.js';
import { getSettings, getPrimaryVault, PROMPT_TAG_PREFIX, settingsConstraints, invalidateSettingsCache, defaultSettings, resolveConnectionConfig } from '../../settings.js';
import { promptManager } from '../../../../../openai.js';
import { testConnection, buildConnectionGuidanceHtml } from '../vault/obsidian-api.js';
import { testProxyConnection } from '../ai/proxy-api.js';
import { testDirectConnection } from '../ai/direct-api.js';
import {
    vaultIndex,
    computeOverallStatus,
    setVaultIndex, setIndexTimestamp, setLastHealthResult,
    onIndexUpdated, onAiStatsUpdated, onCircuitStateChanged,
    librarianSessionStats, librarianChatStats,
    claudeAutoEffortBad, claudeAutoEffortDetail, onClaudeAutoEffortChanged,
    notifyDebugModeChanged,
    resetAiCircuitBreaker,
} from '../state.js';
import { ensureIndexFresh, buildIndex, buildIndexWithReuse } from '../vault/vault.js';
import {
    callViaProfile, getProfileModelHint,
    buildCandidateManifest, callAI,
} from '../ai/ai.js';
import { matchEntries } from '../pipeline/pipeline.js';
import { setupSyncPolling } from '../vault/sync.js';
import { abortWith } from '../diagnostics/interceptors.js';
import { showNotebookPopup, showBrowsePopup, showAiNotepadPopup } from './popups.js';
import {
    resolvePromptOrOverride,
    loadPrompts as loadDlePrompts,
    getPromptStatusGrid as getDlePromptStatusGrid,
} from '../prompts/prompt-store.js';
import {
    bindPromptsTabHandlers,
    renderPromptsGrid,
    buildPromptsConnection,
    bulkDeletePromptsThroughCage,
} from './prompts-tab.js';
import { DLE_PROMPTS_DEFAULT_DIR } from '../prompts/prompt-api.js';
import { runHealthCheck } from './diagnostics.js';
import { DLE_COMMANDS } from './commands-admin.js';

// BUG-120: module-scoped so re-opening the settings popup cancels any
// stale debounced rebuild from the prior instance.
let _rebuildTimer = null;

// BUG-341: drain pending prompt_list PM cleanup when PromptManager becomes
// available. Settings popup open is a reliable PM-available path since
// the popup itself interacts with PM prompts.
function drainPendingPromptListCleanup() {
    if (!promptManager) return;
    const settings = getSettings();
    if (!settings._pendingPromptListCleanup) return;
    try {
        for (const id of [`${PROMPT_TAG_PREFIX}constants`, `${PROMPT_TAG_PREFIX}lore`, 'deeplore_notebook', 'deeplore_ai_notepad']) {
            const pmEntry = promptManager.getPromptById(id);
            if (pmEntry) pmEntry.content = '';
        }
    } catch (e) { console.warn('[DLE] drainPendingPromptListCleanup failed:', e?.message); return; }
    settings._pendingPromptListCleanup = false;
    saveSettingsDebounced();
}

// ── Vault List UI ──

function renderVaultList(settings, container = null) {
    container = container || document.getElementById('dle-vault-list');
    if (!container) return;

    const vaults = settings.vaults || [];
    let html = '';

    for (let i = 0; i < vaults.length; i++) {
        const v = vaults[i];
        const useHttps = !!v.https;
        html += `<div class="dle-vault-row" data-index="${i}">
            <div class="flex-container" style="gap: 6px; align-items: center;">
                <label class="checkbox_label" style="flex: 0 0 auto;" title="Enable/disable this vault">
                    <input type="checkbox" class="dle-vault-enabled checkbox" ${v.enabled ? 'checked' : ''} />
                </label>
                <input type="text" class="dle-vault-name text_pole" placeholder="Obsidian vault name" value="${escapeHtml(v.name)}" title="Must match your Obsidian vault name exactly (used for deep links)" style="flex: 1; min-width: 80px;" aria-label="Vault name" />
                <input type="text" class="dle-vault-host text_pole" placeholder="Host" value="${escapeHtml(v.host || '127.0.0.1')}" style="flex: 0 0 100px;" aria-label="Vault host" />
                <input type="number" class="dle-vault-port text_pole" placeholder="Port" value="${v.port}" min="1" max="65535" style="flex: 0 0 80px;" aria-label="Vault port" />
                <input type="password" class="dle-vault-key text_pole" placeholder="API Key" value="${escapeHtml(v.apiKey)}" style="flex: 2; min-width: 100px;" aria-label="API key" />
                <label class="checkbox_label" style="flex: 0 0 auto;" title="Use HTTPS (port 27124). HTTP is recommended — see wiki for HTTPS setup.">
                    <input type="checkbox" class="dle-vault-https checkbox" ${useHttps ? 'checked' : ''} />
                    <span class="dle-text-sm">HTTPS</span>
                </label>
                <div class="dle-vault-test menu_button menu_button_icon" title="Test this vault" style="flex: 0 0 auto;" tabindex="0" aria-label="Test vault connection">
                    <i class="fa-solid fa-plug" aria-hidden="true"></i>
                </div>
                <div class="dle-vault-remove menu_button menu_button_icon" title="Remove this vault" style="flex: 0 0 auto;" tabindex="0" aria-label="Remove vault">
                    <i class="fa-solid fa-trash" aria-hidden="true"></i>
                </div>
            </div>
            <div class="flex-container" style="gap: 8px; align-items: center;">
                <span class="dle-vault-status dle-status dle-text-sm"></span>
                <a class="dle-vault-trust-cert dle-text-sm" href="https://${escapeHtml(v.host || '127.0.0.1')}:${v.port}" target="_blank" rel="noopener noreferrer" style="display: ${useHttps ? 'inline' : 'none'}; white-space: nowrap;" title="Open Obsidian REST API URL to trust the self-signed certificate"><i class="fa-solid fa-shield-halved"></i> Trust Certificate</a>
                <span class="dle-text-sm dle-vault-https-note" style="display: ${useHttps ? 'inline' : 'none'}; opacity: 0.7;"><i class="fa-solid fa-circle-info"></i> HTTP is recommended. For HTTPS help, see the <a href="https://github.com/coddingtonbear/obsidian-web/wiki/How-do-I-get-my-browser-trust-my-Obsidian-Local-REST-API-certificate%3F" target="_blank" rel="noopener">Local REST API author's guide</a>.</span>
            </div>
        </div>`;
    }

    container.innerHTML = html;
}

function bindVaultListEvents(settings, $scope = null, $addBtn = null) {
    const container = $scope || $('#dle-vault-list');

    // S1-01: clear prior bindings so repeated calls (post-scan re-render) don't stack handlers.
    container.off('.dleVault');
    if ($addBtn) $addBtn.off('.dleVault');

    // V-M5 (2026-05-22): capture the vault name at focus time so the rename
    // confirmation (below) can revert on cancel. Documented as a destructive
    // operation: renaming a vault changes the trackerKey prefix (`vaultSource:title`)
    // for every entry under it, so per-entry cooldowns, decay state, pins, blocks,
    // chat counts, and analytics for the old name no longer match anything — they
    // are effectively cleared. Option A (re-key all trackers on rename) was
    // considered and deferred as future work; this UI guard documents the trade.
    container.on('focus.dleVault', '.dle-vault-name', function () {
        $(this).data('dleOriginalName', String($(this).val()).trim());
    });

    container.on('input.dleVault', '.dle-vault-name, .dle-vault-host, .dle-vault-port, .dle-vault-key', function () {
        const row = $(this).closest('.dle-vault-row');
        const idx = parseInt(row.data('index'), 10);
        if (isNaN(idx) || !settings.vaults[idx]) return;

        if ($(this).hasClass('dle-vault-name')) {
            let newName = String($(this).val()).trim() || 'Vault';
            const otherNames = settings.vaults
                .filter((_, vi) => vi !== idx)
                .map(v => v.name.toLowerCase());
            if (otherNames.includes(newName.toLowerCase())) {
                let counter = 2;
                while (otherNames.includes(`${newName} ${counter}`.toLowerCase())) {
                    counter++;
                }
                newName = `${newName} ${counter}`;
                $(this).val(newName);
                toastr.warning(`Vault name already in use. Renamed to "${newName}".`, 'DeepLore', { timeOut: 4000 });
            }
            settings.vaults[idx].name = newName;
        } else if ($(this).hasClass('dle-vault-host')) {
            let hostVal = String($(this).val()).trim();
            // Strip protocol prefix and port suffix in case user pasted "https://host:port".
            hostVal = hostVal.replace(/^https?:\/\//, '');
            hostVal = hostVal.replace(/:\d+$/, '');
            settings.vaults[idx].host = hostVal || '127.0.0.1';
        } else if ($(this).hasClass('dle-vault-port')) {
            settings.vaults[idx].port = Math.max(1, Math.min(65535, numVal($(this).val(), 27123)));
        } else if ($(this).hasClass('dle-vault-key')) {
            settings.vaults[idx].apiKey = String($(this).val());
        }
        // Keep legacy obsidianPort/obsidianApiKey in sync with primary vault.
        const primary = getPrimaryVault(settings);
        settings.obsidianPort = primary.port;
        settings.obsidianApiKey = primary.apiKey;
        saveSettingsDebounced();
    });

    // V-M5 (2026-05-22): when the user finishes editing a vault name (blur),
    // surface a confirmation popup explaining that rename is destructive — per-
    // entry cooldowns, decay, pins, blocks, chat counts, and analytics keyed on
    // the old `vaultSource:title` no longer match anything and are effectively
    // cleared. If the user cancels, revert the name in both the input and
    // settings. The input-time validator above has already enforced uniqueness,
    // so by the time we hit this handler `settings.vaults[idx].name` is the
    // final new name and `dleOriginalName` (captured on focus) is the prior name.
    container.on('change.dleVault', '.dle-vault-name', async function () {
        const $input = $(this);
        const row = $input.closest('.dle-vault-row');
        const idx = parseInt(row.data('index'), 10);
        if (isNaN(idx) || !settings.vaults[idx]) return;
        const originalName = $input.data('dleOriginalName');
        const newName = settings.vaults[idx].name;
        // First-edit or no-op cases — nothing to confirm.
        if (originalName == null || originalName === '' || originalName === newName) {
            $input.data('dleOriginalName', newName);
            return;
        }
        const confirmed = await callGenericPopup(
            `<div class="dle-popup"><p>Rename vault from <strong>${escapeHtml(originalName)}</strong> to <strong>${escapeHtml(newName)}</strong>?</p>`
                + '<p style="margin-top: 8px;"><strong>This is destructive.</strong> Renaming a vault clears per-entry cooldowns, pin/block lists, chat counts, and analytics for that vault. Entries under the new name start with fresh state.</p>'
                + '<p style="margin-top: 8px; opacity: 0.8;">Entries themselves are not deleted — only the per-entry tracking data tied to the old vault name.</p></div>',
            POPUP_TYPE.CONFIRM,
            '',
            { okButton: 'Rename', cancelButton: 'Cancel' },
        );
        if (!confirmed) {
            // Revert both the input value and the settings field. Other tracker
            // state was never re-keyed (Option B accepts that loss only when the
            // user confirms), so there's nothing else to roll back.
            settings.vaults[idx].name = originalName;
            $input.val(originalName);
            $input.data('dleOriginalName', originalName);
            saveSettingsDebounced();
            return;
        }
        // Confirmed — record the new baseline so subsequent edits prompt again
        // (a second rename in the same session should still confirm).
        $input.data('dleOriginalName', newName);
    });

    container.on('change.dleVault', '.dle-vault-enabled', function () {
        const row = $(this).closest('.dle-vault-row');
        const idx = parseInt(row.data('index'), 10);
        if (isNaN(idx) || !settings.vaults[idx]) return;
        settings.vaults[idx].enabled = $(this).prop('checked');
        const primary = getPrimaryVault(settings);
        settings.obsidianPort = primary.port;
        settings.obsidianApiKey = primary.apiKey;
        saveSettingsDebounced();
    });

    // Auto-switch port between 27124 (HTTPS) and 27123 (HTTP) on toggle.
    container.on('change.dleVault', '.dle-vault-https', function () {
        const row = $(this).closest('.dle-vault-row');
        const idx = parseInt(row.data('index'), 10);
        if (isNaN(idx) || !settings.vaults[idx]) return;
        const useHttps = $(this).prop('checked');
        settings.vaults[idx].https = useHttps;
        const portInput = row.find('.dle-vault-port');
        const currentPort = parseInt(portInput.val(), 10);
        if (useHttps && currentPort === 27123) {
            portInput.val(27124);
            settings.vaults[idx].port = 27124;
        } else if (!useHttps && currentPort === 27124) {
            portInput.val(27123);
            settings.vaults[idx].port = 27123;
        }
        const trustLink = row.find('.dle-vault-trust-cert');
        const httpsNote = row.find('.dle-vault-https-note');
        if (useHttps) {
            const host = settings.vaults[idx].host || '127.0.0.1';
            const port = settings.vaults[idx].port;
            trustLink.attr('href', `https://${host}:${port}`).show();
            httpsNote.show();
        } else {
            trustLink.hide();
            httpsNote.hide();
        }
        saveSettingsDebounced();
    });

    container.on('click.dleVault', '.dle-vault-test', async function () {
        const $btn = $(this);
        if ($btn.hasClass('disabled')) return;
        $btn.addClass('disabled');
        const row = $btn.closest('.dle-vault-row');
        const idx = parseInt(row.data('index'), 10);
        if (isNaN(idx) || !settings.vaults[idx]) { $btn.removeClass('disabled'); return; }
        const vault = settings.vaults[idx];
        const statusEl = row.find('.dle-vault-status');
        statusEl.text('Testing...').removeClass('success failure');
        try {
            const data = await testConnection(vault.host, vault.port, vault.apiKey, !!vault.https);
            if (data.ok) {
                statusEl.text(`Connected${data.authenticated ? '' : ' (no auth)'}`).addClass('success').removeClass('failure');
                announceToSR(`Vault ${vault.name} connected successfully.`);
            } else if (data.diagnosis) {
                const shortMsg = data.diagnosis === 'cert' ? 'Certificate not trusted'
                    : data.diagnosis === 'auth' ? 'Authentication failed'
                    : 'Cannot reach Obsidian';
                statusEl.html(`${escapeHtml(shortMsg)} — <a href="#" class="dle-vault-show-guidance" style="text-decoration: underline;">see how to fix</a>`).addClass('failure').removeClass('success');
                row.find('.dle-vault-show-guidance').off('click').on('click', (e) => {
                    e.preventDefault();
                    const html = `<div class="dle-popup">${buildConnectionGuidanceHtml(data)}</div>`;
                    callGenericPopup(html, POPUP_TYPE.TEXT, 'Connection Help', {
                        wide: true, allowVerticalScrolling: true, okButton: 'Got it',
                    });
                });
                announceToSR(`Vault ${vault.name}: ${shortMsg}.`);
            } else {
                statusEl.text(`Failed: ${data.error}`).addClass('failure').removeClass('success');
                announceToSR(`Vault ${vault.name} connection failed: ${data.error}`);
            }
        } catch (err) {
            statusEl.text(`Error: ${err.message}`).addClass('failure').removeClass('success');
            announceToSR(`Vault ${vault.name} test error: ${err.message}`);
        } finally { $btn.removeClass('disabled'); }
    });

    container.on('click.dleVault', '.dle-vault-remove', async function () {
        const row = $(this).closest('.dle-vault-row');
        const idx = parseInt(row.data('index'), 10);
        if (isNaN(idx) || !settings.vaults[idx]) return;
        if (settings.vaults.length <= 1) {
            toastr.warning('At least one vault connection is required. Add another vault before removing this one.', 'DeepLore');
            return;
        }
        const vaultName = settings.vaults[idx].name || `Vault ${idx + 1}`;
        // V-M5 (2026-05-22): wrap the confirm in try/catch — if callGenericPopup
        // throws (popup util unavailable mid-teardown, popup root detached, etc.),
        // we must NOT fall through and silently remove the vault. Treat any throw
        // as "user did not confirm" and bail out.
        let confirmed;
        try {
            confirmed = await callGenericPopup(
                `Remove vault "${escapeHtml(vaultName)}"? This cannot be undone.`,
                POPUP_TYPE.CONFIRM, '', { okButton: 'Remove', cancelButton: 'Cancel' },
            );
        } catch (err) {
            console.warn('[DLE] vault-remove confirm popup failed:', err?.message);
            return;
        }
        if (!confirmed) return;
        settings.vaults.splice(idx, 1);
        const primary = getPrimaryVault(settings);
        settings.obsidianPort = primary.port;
        settings.obsidianApiKey = primary.apiKey;
        saveSettingsDebounced();
        renderVaultList(settings, container[0]);
    });

    if ($addBtn && $addBtn.length) {
        $addBtn.on('click.dleVault', function () {
            settings.vaults.push({ name: `Vault ${settings.vaults.length + 1}`, host: '127.0.0.1', port: 27123, apiKey: '', enabled: true, https: false });
            saveSettingsDebounced();
            renderVaultList(settings, container[0]);
        });
    }
}

// ── Stats Display ──

/** Announce to screen readers via ARIA live region. */
function announceToSR(message) {
    const el = document.getElementById('dle-drawer-live');
    if (el) el.textContent = message;
}

const STATUS_DISPLAY = {
    ok:       { dot: '\u{1F7E2}', label: 'OK',       title: 'All systems operational' },
    degraded: { dot: '\u{1F7E1}', label: 'Degraded',  title: 'Some vaults unreachable or health issues detected' },
    limited:  { dot: '\u{1F7E0}', label: 'Limited',   title: 'AI search temporarily paused or using stale cache' },
    offline:  { dot: '\u{1F534}', label: 'Offline',    title: 'No vaults reachable and no cached data' },
};

function updateHeaderBadge() {
    const headerBadge = document.getElementById('dle-header-badge');
    if (!headerBadge) return;

    if (vaultIndex.length > 0) {
        const status = computeOverallStatus();
        const info = STATUS_DISPLAY[status];
        headerBadge.textContent = `(${vaultIndex.length} entries | ${info.dot} ${info.label})`;
        headerBadge.title = info.title;
    } else {
        const status = computeOverallStatus();
        if (status === 'offline') {
            const info = STATUS_DISPLAY.offline;
            headerBadge.textContent = `(${info.dot} ${info.label})`;
            headerBadge.title = info.title;
        } else {
            headerBadge.textContent = '';
            headerBadge.title = '';
        }
    }
}

// ── Settings Popup ──

/** Works on detached DOM (used during popup construction before insertion). */
function populateProfileDropdownIn($container, selectId, settingsKey) {
    const select = $container.find('#' + selectId)[0];
    if (!select) return;
    const $select = $(select);
    $select.next('.dle-no-profiles-help').remove(); // Wave E: clear prior remediation (idempotent re-populate).
    const settings = getSettings();
    const currentId = settings[settingsKey];
    select.innerHTML = '<option value="">— Select a profile —</option>';
    try {
        const profiles = ConnectionManagerRequestService.getSupportedProfiles();
        if (!profiles || profiles.length === 0) {
            // Wave E (E3): empty dropdown was a dead-end. DLE routes AI through ST Connection
            // Profiles (profile-is-canonical since v2.5) — point the user at where to make one.
            $select.after(
                '<div class="dle-no-profiles-help dle-text-xs dle-muted" style="margin-top:4px;">'
                + '<i class="fa-solid fa-circle-info"></i> No connection profiles yet. DeepLore routes AI through '
                + 'SillyTavern <strong>Connection Profiles</strong> — create one in <strong>API Connections</strong> '
                + '(the plug icon, top bar) → <strong>Connection Profile</strong>, then reopen these settings.'
                + '</div>',
            );
            return;
        }
        for (const p of profiles) {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = `${p.name} (${p.api}${p.model ? ' / ' + p.model : ''})`;
            if (p.id === currentId) opt.selected = true;
            select.appendChild(opt);
        }
    } catch (err) {
        // BUG-112: log so dropdown load failures are diagnosable.
        console.debug('[DLE] Profile dropdown load failed:', err?.message);
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'Connection Manager not available';
        opt.disabled = true;
        select.appendChild(opt);
    }
}

function updatePopupModeVisibility($container, settings) {
    const aiEnabled = settings.aiSearchEnabled;
    const isProxy = settings.aiSearchConnectionMode === 'proxy';
    const isAiOnly = aiEnabled && settings.aiSearchMode === 'ai-only';
    $container.find('#dle-sp-scan-depth').closest('.flex-container').toggle(!isAiOnly);
    $container.find('#dle-sp-optimize-keys-mode').closest('.flex-container').toggleClass('dle-disabled', isAiOnly);
    $container.find('#dle-sp-case-sensitive, #dle-sp-match-whole-words, #dle-sp-recursive-scan').prop('disabled', isAiOnly);
    // v2.5: Claude prefix toggle is proxy-only and proxy mode is deprecated.
    // Force-hide regardless of legacy aiSearchConnectionMode state so users
    // migrated mid-session never see a stale checkbox flash visible.
    $container.find('#dle-sp-ai-claude-prefix').closest('.checkbox_label').hide();
    const $aiPanel = $container.find('#dle-sp-ai');
    $container.find('#dle-sp-ai-disabled-notice').toggle(!aiEnabled);
    $aiPanel.find('.dle-ai-content-wrap')
        .toggleClass('dle-blurred', !aiEnabled)
        // BUG-198: `inert` removes blurred region from tab order + a11y tree;
        // `aria-hidden` is redundant but helps older AT. Disabled inputs block typing.
        .attr('inert', !aiEnabled ? '' : null)
        .attr('aria-hidden', !aiEnabled ? 'true' : null);
    $aiPanel.find('.dle-ai-content-wrap input, .dle-ai-content-wrap select, .dle-ai-content-wrap textarea, .dle-ai-content-wrap .menu_button').prop('disabled', !aiEnabled);
    const modeVal = !aiEnabled ? 'keywords-only' : (settings.aiSearchMode === 'ai-only' ? 'ai-only' : 'two-stage');
    $container.find('#dle-sp-search-mode').val(modeVal);
}

// ── Prompt Preset System ──

/** Each tool with a configurable prompt gets an entry. */
const PROMPT_PRESET_TOOLS = {
    aiSearch:     { settingsKey: 'aiSearchSystemPrompt', textareaId: 'dle-sp-ai-system-prompt' },
    scribe:       { settingsKey: 'scribePrompt', textareaId: 'dle-sp-scribe-prompt' },
    autoSuggest:  { settingsKey: 'autoSuggestPrompt', textareaId: 'dle-sp-autosuggest-prompt' },
    optimizeKeys: { settingsKey: 'optimizeKeysPrompt', textareaId: 'dle-sp-optimize-keys-prompt' },
    librarian:    { settingsKey: 'librarianCustomSystemPrompt', textareaId: 'dle-sp-librarian-custom-prompt' },
    aiNotepad:    { settingsKey: 'aiNotepadPrompt', textareaId: 'dle-sp-ai-notepad-prompt' },
    // BUG-128: Extract mode supports save/reuse of named presets.
    aiNotepadExtract: { settingsKey: 'aiNotepadExtractPrompt', textareaId: 'dle-sp-ai-notepad-extract-prompt' },
};

function initPromptPresets($container, settings) {
    if (!settings.promptPresets) settings.promptPresets = {};

    $container.find('.dle-prompt-preset-select').each(function () {
        refreshPresetDropdown($(this), settings);
    });

    $container.on('change', '.dle-prompt-preset-select', function () {
        const $select = $(this);
        const toolKey = $select.data('tool');
        const value = $select.val();
        const tool = PROMPT_PRESET_TOOLS[toolKey];
        if (!tool) return;

        if (value === '__save__') {
            saveCurrentAsPreset($container, $select, toolKey, settings);
            return;
        }
        if (value === '__delete__') {
            deletePreset($container, $select, toolKey, settings);
            return;
        }
        if (value === '' || value === '__default__') return;

        const presets = settings.promptPresets[toolKey] || {};
        const text = presets[value];
        if (text !== undefined) {
            const $textarea = $container.find(`#${tool.textareaId}`);
            $textarea.val(text).trigger('input');
        }
    });
}

function refreshPresetDropdown($select, settings) {
    const toolKey = $select.data('tool');
    const presets = settings.promptPresets[toolKey] || {};
    const names = Object.keys(presets);

    let html = '<option value="" selected>Presets</option>';
    for (const name of names) {
        html += `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`;
    }
    html += '<option value="__save__">Save current as...</option>';
    if (names.length > 0) {
        html += '<option value="__delete__">Delete preset...</option>';
    }
    $select.html(html);
}

async function saveCurrentAsPreset($container, $select, toolKey, settings) {
    const tool = PROMPT_PRESET_TOOLS[toolKey];
    if (!tool) return;
    const $textarea = $container.find(`#${tool.textareaId}`);
    const text = $textarea.val()?.trim();
    if (!text) {
        toastr.warning('Textarea is empty — nothing to save.', 'DeepLore');
        $select.val('');
        return;
    }

    // BUG-107: capture input reference via onOpen and snapshot before DOM teardown.
    // callGenericPopup returns a boolean, not the input value.
    let nameInputRef = null;
    const name = await callGenericPopup(
        '<p>Enter a name for this preset:</p><input id="dle-preset-name-input" class="text_pole" type="text" placeholder="My preset" autofocus />',
        POPUP_TYPE.CONFIRM, '', {
            okButton: 'Save', cancelButton: 'Cancel',
            onOpen: (popup) => {
                const root = popup?.dlg || document;
                nameInputRef = root.querySelector('#dle-preset-name-input');
            },
            onClose: () => {
                if (nameInputRef) nameInputRef._snapshotValue = nameInputRef.value;
            },
        },
    );
    if (!name) { $select.val(''); return; }

    const presetName = (nameInputRef?._snapshotValue ?? nameInputRef?.value ?? '').trim();
    if (!presetName) { $select.val(''); return; }

    if (!settings.promptPresets[toolKey]) settings.promptPresets[toolKey] = {};
    settings.promptPresets[toolKey][presetName] = text;
    saveSettingsDebounced();
    refreshPresetDropdown($select, settings);
    $select.val('');
    toastr.success(`Preset "${presetName}" saved.`, 'DeepLore');
}

async function deletePreset($container, $select, toolKey, settings) {
    const presets = settings.promptPresets[toolKey] || {};
    const names = Object.keys(presets);
    if (names.length === 0) { $select.val(''); return; }

    const options = names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
    const html = `<p>Select a preset to delete:</p><select id="dle-preset-delete-select" class="text_pole">${options}</select>`;

    // BUG-AUDIT-C06: capture selected value via onOpen listener before popup
    // closes — querying getElementById after callGenericPopup resolves reads
    // from detached DOM (silent failure).
    let selectedToDelete = '';
    const confirmed = await callGenericPopup(html, POPUP_TYPE.CONFIRM, '', {
        okButton: 'Delete', cancelButton: 'Cancel',
        onOpen: () => {
            const sel = document.getElementById('dle-preset-delete-select');
            if (sel) sel.addEventListener('change', () => { selectedToDelete = sel.value; });
            if (sel?.value) selectedToDelete = sel.value;
        },
    });
    if (!confirmed) { $select.val(''); return; }

    const toDelete = selectedToDelete;
    if (toDelete && settings.promptPresets[toolKey]) {
        delete settings.promptPresets[toolKey][toDelete];
        saveSettingsDebounced();
        refreshPresetDropdown($select, settings);
        toastr.success(`Preset "${toDelete}" deleted.`, 'DeepLore');
    }
    $select.val('');
}

// ── AI Connections Accordion ──

const TOOL_CONNECTION_CONFIGS = {
    aiSearch: {
        label: 'AI Search', icon: 'brain',
        supportedModes: ['profile', 'direct', 'proxy'], isRoot: true,
        modeKey: 'aiSearchConnectionMode', profileIdKey: 'aiSearchProfileId',
        proxyUrlKey: 'aiSearchProxyUrl', modelKey: 'aiSearchModel',
        maxTokensKey: 'aiSearchMaxTokens', timeoutKey: 'aiSearchTimeout',
        apiUrlKey: 'aiSearchApiUrl', apiKeyKey: 'aiSearchApiKey',
        apiFormatKey: 'aiSearchApiFormat', apiCorsKey: 'aiSearchApiViaCorsProxy',
    },
    scribe: {
        label: 'Session Scribe', icon: 'feather-pointed',
        supportedModes: ['inherit', 'st', 'profile', 'direct', 'proxy'],
        modeKey: 'scribeConnectionMode', profileIdKey: 'scribeProfileId',
        proxyUrlKey: 'scribeProxyUrl', modelKey: 'scribeModel',
        maxTokensKey: 'scribeMaxTokens', timeoutKey: 'scribeTimeout',
        apiUrlKey: 'scribeApiUrl', apiKeyKey: 'scribeApiKey',
        apiFormatKey: 'scribeApiFormat', apiCorsKey: 'scribeApiViaCorsProxy',
    },
    autoSuggest: {
        label: 'Auto Lorebook', icon: 'wand-magic-sparkles',
        supportedModes: ['inherit', 'st', 'profile', 'direct', 'proxy'],
        modeKey: 'autoSuggestConnectionMode', profileIdKey: 'autoSuggestProfileId',
        proxyUrlKey: 'autoSuggestProxyUrl', modelKey: 'autoSuggestModel',
        maxTokensKey: 'autoSuggestMaxTokens', timeoutKey: 'autoSuggestTimeout',
        apiUrlKey: 'autoSuggestApiUrl', apiKeyKey: 'autoSuggestApiKey',
        apiFormatKey: 'autoSuggestApiFormat', apiCorsKey: 'autoSuggestApiViaCorsProxy',
    },
    aiNotepad: {
        label: 'AI Notepad', icon: 'robot',
        supportedModes: ['inherit', 'profile', 'direct', 'proxy'],
        modeKey: 'aiNotepadConnectionMode', profileIdKey: 'aiNotepadProfileId',
        proxyUrlKey: 'aiNotepadProxyUrl', modelKey: 'aiNotepadModel',
        maxTokensKey: 'aiNotepadMaxTokens', timeoutKey: 'aiNotepadTimeout',
        apiUrlKey: 'aiNotepadApiUrl', apiKeyKey: 'aiNotepadApiKey',
        apiFormatKey: 'aiNotepadApiFormat', apiCorsKey: 'aiNotepadApiViaCorsProxy',
    },
    librarian: {
        label: 'Librarian', icon: 'book-bookmark',
        supportedModes: ['inherit', 'profile', 'direct', 'proxy'],
        modeKey: 'librarianConnectionMode', profileIdKey: 'librarianProfileId',
        proxyUrlKey: 'librarianProxyUrl', modelKey: 'librarianModel',
        maxTokensKey: 'librarianSessionMaxTokens', timeoutKey: 'librarianSessionTimeout',
        apiUrlKey: 'librarianApiUrl', apiKeyKey: 'librarianApiKey',
        apiFormatKey: 'librarianApiFormat', apiCorsKey: 'librarianApiViaCorsProxy',
    },
    optimizeKeys: {
        label: 'Optimize Keys', icon: 'key',
        supportedModes: ['inherit', 'profile', 'direct', 'proxy'],
        modeKey: 'optimizeKeysConnectionMode', profileIdKey: 'optimizeKeysProfileId',
        proxyUrlKey: 'optimizeKeysProxyUrl', modelKey: 'optimizeKeysModel',
        maxTokensKey: 'optimizeKeysMaxTokens', timeoutKey: 'optimizeKeysTimeout',
        apiUrlKey: 'optimizeKeysApiUrl', apiKeyKey: 'optimizeKeysApiKey',
        apiFormatKey: 'optimizeKeysApiFormat', apiCorsKey: 'optimizeKeysApiViaCorsProxy',
    },
};

const MODE_LABELS = {
    inherit: 'Inherit from AI Search',
    st: 'SillyTavern Connection',
    profile: 'Connection Profile',
    direct: 'Direct API (URL + key)',
    proxy: 'Custom Proxy',
};

/** Driven by claudeAutoEffortBad state — see notifications in state.js. */
export function refreshClaudeEffortBanner($container) {
    const $root = $container || $('#dle-settings-popup');
    const $banner = $root.find('#dle-claude-effort-banner');
    if (!$banner.length) return;
    if (claudeAutoEffortBad && claudeAutoEffortDetail) {
        const d = claudeAutoEffortDetail;
        const featureLabel = d.feature ? ` (detected on ${escapeHtml(d.feature)})` : '';
        const msg = `Profile <b>"${escapeHtml(d.profileName || '?')}"</b> uses <b>${escapeHtml(d.modelName || '?')}</b>, but its completion preset <b>"${escapeHtml(d.presetName || '?')}"</b> has <code>reasoning_effort</code> unset or "auto". SillyTavern will reject every request with a 400 error. Fix it in <i>Connection Manager &rarr; edit preset &rarr; Reasoning Effort &rarr; Low / Medium / High</i>${featureLabel}. If this profile actually points at a proxy, switch the feature's connection mode to <b>Proxy</b> below to silence this warning.`;
        $banner.find('.dle-claude-effort-banner-text').html(msg);
        $banner.css('display', 'block');
    } else {
        $banner.css('display', 'none');
    }
}

function buildAccordionHtml($container) {
    const $section = $container.find('#dle-sp-ai-connections');
    if (!$section.length) return;

    let html = '';
    for (const [toolKey, config] of Object.entries(TOOL_CONNECTION_CONFIGS)) {
        const id = `dle-conn-${toolKey}`;
        html += `<div class="dle-conn-accordion" data-tool="${toolKey}">`;
        html += `<div class="dle-conn-accordion-header" role="button" tabindex="0" aria-expanded="false">`;
        html += `<i class="fa-solid fa-${config.icon} dle-conn-tool-icon"></i>`;
        html += `<span class="dle-conn-tool-name">${config.label}</span>`;
        html += `<span class="dle-conn-badge dle-text-xs"></span>`;
        html += `<i class="fa-solid fa-chevron-right dle-conn-chevron"></i>`;
        html += `</div>`;
        html += `<div class="dle-conn-accordion-body" style="display: none;">`;

        html += `<div class="radio_group">`;
        for (const mode of config.supportedModes) {
            // v2.5: proxy mode deprecated; skip rendering the radio so users can't
            // select it. supportedModes / MODE_LABELS / proxy-row markup kept intact
            // for rollback and so legacy proxy-mode settings still resolve cleanly.
            if (mode === 'proxy') continue;
            html += `<label title="${MODE_LABELS[mode]}"><input type="radio" name="${id}-mode" value="${mode}" /> ${MODE_LABELS[mode]}</label>`;
        }
        html += `</div>`;

        if (!config.isRoot) {
            html += `<div class="${id}-inherit-note dle-conn-inherit-note">Uses AI Search connection settings. You can still override model, max tokens, and timeout below.</div>`;
        }

        html += `<div class="${id}-profile-row flex-container" style="display: none;">`;
        html += `<div class="flex1"><label for="${id}-profile-select"><small>Connection Profile</small></label>`;
        html += `<select id="${id}-profile-select" class="text_pole"><option value="">— Select a profile —</option></select>`;
        html += `</div></div>`;

        html += `<div class="${id}-proxy-row flex-container" style="display: none;">`;
        html += `<div class="flex1"><label for="${id}-proxy-url"><small>Proxy URL</small></label>`;
        html += `<input id="${id}-proxy-url" type="text" class="text_pole" placeholder="http://localhost:42069" />`;
        html += `</div></div>`;

        // Direct API rows. Hidden unless the tool's mode is 'direct'.
        // autocomplete="off" + type=password on the key so browser password
        // managers don't offer to save it against the SillyTavern origin.
        html += `<div class="${id}-direct-row dle-conn-direct-row" style="display: none;">`;
        html += `<div class="flex-container"><div class="flex1">`;
        html += `<label for="${id}-api-url"><small>API URL</small></label>`;
        html += `<input id="${id}-api-url" type="text" class="text_pole" autocomplete="off" spellcheck="false" placeholder="https://api.openai.com/v1" />`;
        html += `<div class="dle-text-xs dle-muted" style="margin-top:4px;">Base URL or full endpoint — <code>/chat/completions</code> (or <code>/v1/messages</code>) is appended when missing.</div>`;
        html += `</div></div>`;
        html += `<div class="flex-container"><div class="flex1">`;
        html += `<label for="${id}-api-key"><small>API Key</small></label>`;
        html += `<div class="dle-conn-key-wrap" style="display:flex; gap: var(--dle-space-2); align-items:center;">`;
        html += `<input id="${id}-api-key" type="password" class="text_pole flex1" autocomplete="off" spellcheck="false" placeholder="sk-…" />`;
        html += `<button type="button" class="menu_button dle-conn-key-reveal" data-target="${id}-api-key" title="Show / hide the key" aria-label="Show or hide the API key"><i class="fa-solid fa-eye" aria-hidden="true"></i></button>`;
        html += `</div></div></div>`;
        html += `<div class="flex-container">`;
        html += `<div class="flex1"><label for="${id}-api-format"><small>API Format</small></label>`;
        html += `<select id="${id}-api-format" class="text_pole">`;
        html += `<option value="auto">Auto-detect</option>`;
        html += `<option value="openai">OpenAI-compatible (/chat/completions)</option>`;
        html += `<option value="anthropic">Anthropic (/v1/messages)</option>`;
        html += `</select></div></div>`;
        html += `<label class="checkbox_label" for="${id}-api-cors" title="Send the request through SillyTavern's server instead of the browser. Needed when the endpoint doesn't allow browser (CORS) requests. Requires enableCorsProxy: true in config.yaml.">`;
        html += `<input id="${id}-api-cors" type="checkbox" /><span>Route through SillyTavern's CORS proxy</span></label>`;
        html += `</div>`;

        html += `<div class="flex-container ${id}-model-row">`;
        html += `<div class="flex1"><label for="${id}-model"><small>Model Override</small></label>`;
        html += `<input id="${id}-model" type="text" class="text_pole" placeholder="Leave empty to use profile model" />`;
        html += `</div></div>`;

        html += `<div class="flex-container">`;
        html += `<div class="flex1"><label for="${id}-max-tokens"><small>Max Tokens</small></label>`;
        html += `<input id="${id}-max-tokens" type="number" class="text_pole" />`;
        html += `</div>`;
        html += `<div class="flex1"><label for="${id}-timeout"><small>Timeout (ms)</small></label>`;
        html += `<input id="${id}-timeout" type="number" class="text_pole" />`;
        html += `</div></div>`;

        // Test-message button — sends a one-line probe through this tool's resolved
        // connection and reports via an ST-style green/red toast (see handler).
        html += `<div class="flex-container dle-conn-test-row" style="margin-top: var(--dle-space-2); align-items: center; gap: var(--dle-space-2);">`;
        html += `<button type="button" class="menu_button dle-conn-test-btn" data-tool="${toolKey}" title="Send a one-line test message through this connection to confirm it works.">`;
        html += `<i class="fa-solid fa-paper-plane" aria-hidden="true"></i> Test message`;
        html += `</button>`;
        html += `</div>`;

        html += `</div></div>`;
    }
    $section.append(html);
}

function populateAccordions($container) {
    const settings = getSettings();
    for (const [toolKey, config] of Object.entries(TOOL_CONNECTION_CONFIGS)) {
        const id = `dle-conn-${toolKey}`;
        const $c = (sel) => $container.find(sel);
        const mode = settings[config.modeKey];

        $c(`input[name="${id}-mode"][value="${mode}"]`).prop('checked', true);
        populateProfileDropdownIn($container, `${id}-profile-select`, config.profileIdKey);
        $c(`#${id}-proxy-url`).val(settings[config.proxyUrlKey] || '');
        $c(`#${id}-api-url`).val(settings[config.apiUrlKey] || '');
        $c(`#${id}-api-key`).val(settings[config.apiKeyKey] || '');
        $c(`#${id}-api-format`).val(settings[config.apiFormatKey] || 'auto');
        $c(`#${id}-api-cors`).prop('checked', !!settings[config.apiCorsKey]);
        $c(`#${id}-model`).val(settings[config.modelKey] || '');
        $c(`#${id}-max-tokens`).val(settings[config.maxTokensKey]);
        $c(`#${id}-timeout`).val(settings[config.timeoutKey]);

        updateAccordionVisibility($container, toolKey);
        updateAccordionBadge($container, toolKey);
    }
}

function updateAccordionVisibility($container, toolKey) {
    const config = TOOL_CONNECTION_CONFIGS[toolKey];
    const settings = getSettings();
    const mode = settings[config.modeKey];
    const id = `dle-conn-${toolKey}`;

    const isProfile = mode === 'profile';
    const isProxy = mode === 'proxy';
    const isDirect = mode === 'direct';
    const isInherit = mode === 'inherit';
    const isSt = mode === 'st';

    $container.find(`.${id}-profile-row`).toggle(isProfile);
    // v2.5: proxy mode deprecated; force-hide proxy URL row regardless of legacy
    // settings state (migration nukes proxy mode, but defend the UI too).
    $container.find(`.${id}-proxy-row`).hide();
    $container.find(`.${id}-direct-row`).toggle(isDirect);
    $container.find(`.${id}-inherit-note`).toggle(isInherit);
    // Model row: hidden in 'st' mode (override unavailable), shown otherwise.
    $container.find(`.${id}-model-row`).toggle(!isSt);

    const $modelInput = $container.find(`#${id}-model`);
    const $modelLabel = $container.find(`.${id}-model-row label[for="${id}-model"] small`);
    // In direct mode the model is REQUIRED (no profile to fall back on), so the
    // label stops calling itself an "override" and says so.
    $modelLabel.text(isDirect ? 'Model (required)' : 'Model Override');
    if (isDirect) {
        $modelInput.attr('placeholder', 'gpt-4o-mini / claude-haiku-4-5-20251001');
    } else if (isProfile || (isInherit && settings.aiSearchConnectionMode === 'profile')) {
        let hint = '';
        const profileIdKey = isInherit ? 'aiSearchProfileId' : config.profileIdKey;
        try {
            const profileId = settings[profileIdKey];
            if (profileId) hint = ConnectionManagerRequestService.getProfile(profileId).model || '';
        } catch { /* noop */ }
        $modelInput.attr('placeholder', hint ? `Profile: ${hint}` : 'Leave empty to use profile model');
    } else if (isProxy || (isInherit && settings.aiSearchConnectionMode === 'proxy')) {
        $modelInput.attr('placeholder', 'claude-haiku-4-5-20251001');
    } else if (isInherit && settings.aiSearchConnectionMode === 'direct') {
        $modelInput.attr('placeholder', settings.aiSearchModel || 'Leave empty to inherit from AI Search');
    } else if (isInherit) {
        $modelInput.attr('placeholder', 'Leave empty to inherit from AI Search');
    }
}

function updateAccordionBadge($container, toolKey) {
    const config = TOOL_CONNECTION_CONFIGS[toolKey];
    const settings = getSettings();
    const mode = settings[config.modeKey];
    const $badge = $container.find(`.dle-conn-accordion[data-tool="${toolKey}"] .dle-conn-badge`);

    if (mode === 'inherit') {
        $badge.text('Inheriting from AI Search').css('opacity', '0.5');
    } else if (mode === 'st') {
        $badge.text('SillyTavern Connection').css('opacity', '0.7');
    } else if (mode === 'profile') {
        const profileId = settings[config.profileIdKey];
        if (profileId) {
            try {
                const profile = ConnectionManagerRequestService.getProfile(profileId);
                $badge.text(`Profile: ${profile.name}`).css('opacity', '0.7');
            } catch {
                $badge.text('No profile selected').css('opacity', '0.5');
            }
        } else {
            $badge.text('No profile selected').css('opacity', '0.5');
        }
    } else if (mode === 'direct') {
        const url = (settings[config.apiUrlKey] || '').trim();
        if (!url) {
            $badge.text('No API URL set').css('opacity', '0.5');
        } else {
            let host = url;
            try { const u = new URL(url); host = u.host; } catch { /* show the raw string */ }
            const missing = [];
            if (!settings[config.apiKeyKey]) missing.push('key');
            if (!settings[config.modelKey] && config.isRoot) missing.push('model');
            $badge.text(`Direct: ${host}${missing.length ? ` (no ${missing.join(' / ')})` : ''}`)
                .css('opacity', missing.length ? '0.5' : '0.7');
        }
    } else if (mode === 'proxy') {
        const url = settings[config.proxyUrlKey] || 'http://127.0.0.1:42069';
        try {
            const u = new URL(url);
            $badge.text(`Proxy: ${u.hostname}:${u.port || '80'}`).css('opacity', '0.7');
        } catch {
            $badge.text(`Proxy: ${url}`).css('opacity', '0.7');
        }
    }
}

/** Delegated on #dle-sp-ai-connections. */
function bindAccordionEvents($container) {
    const settings = getSettings();
    const $section = $container.find('#dle-sp-ai-connections');

    $section.on('click keydown', '.dle-conn-accordion-header', function (e) {
        if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        const $header = $(this);
        const expanded = $header.attr('aria-expanded') === 'true';
        $header.attr('aria-expanded', String(!expanded));
        $header.next('.dle-conn-accordion-body').slideToggle(200);
    });

    // Test-message button: probe this tool's resolved connection with a one-line prompt.
    // ST design: green toastr.success on reply, red toastr.error(message, title) on failure.
    // Uses the LIVE (settings-reflected) connection config — change handlers mutate settings
    // synchronously before the debounced save, so resolveConnectionConfig sees current UI state.
    $section.on('click', '.dle-conn-test-btn', async function (e) {
        e.preventDefault();
        e.stopPropagation();
        const $btn = $(this);
        if ($btn.prop('disabled')) return;
        const toolKey = $btn.data('tool');
        const label = TOOL_CONNECTION_CONFIGS[toolKey]?.label || toolKey;
        const orig = $btn.html();
        $btn.prop('disabled', true).html('<goo-spinner size="18" color="currentColor" aria-hidden="true"></goo-spinner> Testing…');
        try {
            const conn = resolveConnectionConfig(toolKey);
            conn.caller = `test:${toolKey}`;
            conn.skipThrottle = true;        // manual test must not consume the AI throttle window
            conn.maxTokens = 64;             // connectivity check only — keep the reply tiny
            conn.disableThinkingOnClaude = true;
            const result = await callAI(
                'You are a connection test. Reply with a single short word.',
                'Reply with exactly: OK',
                conn,
            );
            const reply = (result?.text || '').trim().replace(/\s+/g, ' ').slice(0, 80) || '(empty reply)';
            toastr.success(`${label} connection OK — replied: "${reply}"`, '', { timeOut: 5000, preventDuplicates: true });
        } catch (err) {
            toastr.error(err?.message || String(err), `${label} connection test failed`, { timeOut: 9000, preventDuplicates: true });
        } finally {
            $btn.prop('disabled', false).html(orig);
        }
    });

    $section.on('change', 'input[type="radio"]', function () {
        const $accordion = $(this).closest('.dle-conn-accordion');
        const toolKey = $accordion.data('tool');
        const config = TOOL_CONNECTION_CONFIGS[toolKey];
        settings[config.modeKey] = $(this).val();
        invalidateSettingsCache();
        saveSettingsDebounced();
        updateAccordionVisibility($container, toolKey);
        updateAccordionBadge($container, toolKey);
        // AI Search is the inheritance root — update all inheriting tools.
        if (toolKey === 'aiSearch') {
            for (const [key, cfg] of Object.entries(TOOL_CONNECTION_CONFIGS)) {
                if (!cfg.isRoot && settings[cfg.modeKey] === 'inherit') {
                    updateAccordionVisibility($container, key);
                    updateAccordionBadge($container, key);
                }
            }
            updatePopupModeVisibility($container, settings);
        }
    });

    $section.on('change', 'select[id$="-profile-select"]', function () {
        const $accordion = $(this).closest('.dle-conn-accordion');
        const toolKey = $accordion.data('tool');
        const config = TOOL_CONNECTION_CONFIGS[toolKey];
        settings[config.profileIdKey] = String($(this).val());
        invalidateSettingsCache();
        saveSettingsDebounced();
        updateAccordionBadge($container, toolKey);
        updateAccordionVisibility($container, toolKey);
    });

    $section.on('input', 'input[id$="-proxy-url"]', function () {
        const $accordion = $(this).closest('.dle-conn-accordion');
        const toolKey = $accordion.data('tool');
        const config = TOOL_CONNECTION_CONFIGS[toolKey];
        settings[config.proxyUrlKey] = String($(this).val()).trim() || 'http://127.0.0.1:42069';
        invalidateSettingsCache();
        saveSettingsDebounced();
        updateAccordionBadge($container, toolKey);
    });

    $section.on('input', 'input[id$="-api-url"]', function () {
        const $accordion = $(this).closest('.dle-conn-accordion');
        const toolKey = $accordion.data('tool');
        const config = TOOL_CONNECTION_CONFIGS[toolKey];
        settings[config.apiUrlKey] = String($(this).val()).trim();
        invalidateSettingsCache();
        saveSettingsDebounced();
        updateAccordionBadge($container, toolKey);
    });

    $section.on('input', 'input[id$="-api-key"]', function () {
        const $accordion = $(this).closest('.dle-conn-accordion');
        const toolKey = $accordion.data('tool');
        const config = TOOL_CONNECTION_CONFIGS[toolKey];
        // No .trim() of interior characters — only the stray whitespace a paste
        // picks up. Keys are opaque; mangling them produces a baffling 401.
        settings[config.apiKeyKey] = String($(this).val()).trim();
        invalidateSettingsCache();
        saveSettingsDebounced();
        updateAccordionBadge($container, toolKey);
    });

    $section.on('change', 'select[id$="-api-format"]', function () {
        const $accordion = $(this).closest('.dle-conn-accordion');
        const toolKey = $accordion.data('tool');
        const config = TOOL_CONNECTION_CONFIGS[toolKey];
        settings[config.apiFormatKey] = String($(this).val()) || 'auto';
        invalidateSettingsCache();
        saveSettingsDebounced();
    });

    $section.on('change', 'input[id$="-api-cors"]', function () {
        const $accordion = $(this).closest('.dle-conn-accordion');
        const toolKey = $accordion.data('tool');
        const config = TOOL_CONNECTION_CONFIGS[toolKey];
        settings[config.apiCorsKey] = $(this).prop('checked');
        invalidateSettingsCache();
        saveSettingsDebounced();
    });

    // Reveal toggle — flips the input type in place. The value never leaves the
    // field, so nothing is copied into the DOM as plain text.
    $section.on('click', '.dle-conn-key-reveal', function (e) {
        e.preventDefault();
        const $input = $container.find(`#${$(this).data('target')}`);
        const revealed = $input.attr('type') === 'text';
        $input.attr('type', revealed ? 'password' : 'text');
        $(this).find('i').toggleClass('fa-eye', revealed).toggleClass('fa-eye-slash', !revealed);
        $(this).attr('aria-pressed', String(!revealed));
    });

    $section.on('input', 'input[id$="-model"]', function () {
        const $accordion = $(this).closest('.dle-conn-accordion');
        const toolKey = $accordion.data('tool');
        const config = TOOL_CONNECTION_CONFIGS[toolKey];
        settings[config.modelKey] = String($(this).val()).trim();
        invalidateSettingsCache();
        saveSettingsDebounced();
        updateAccordionBadge($container, toolKey);
    });

    $section.on('input', 'input[id$="-max-tokens"]', function () {
        const $accordion = $(this).closest('.dle-conn-accordion');
        const toolKey = $accordion.data('tool');
        const config = TOOL_CONNECTION_CONFIGS[toolKey];
        settings[config.maxTokensKey] = numVal($(this).val(), defaultSettings[config.maxTokensKey]);
        invalidateSettingsCache();
        saveSettingsDebounced();
    });

    $section.on('input', 'input[id$="-timeout"]', function () {
        const $accordion = $(this).closest('.dle-conn-accordion');
        const toolKey = $accordion.data('tool');
        const config = TOOL_CONNECTION_CONFIGS[toolKey];
        settings[config.timeoutKey] = numVal($(this).val(), defaultSettings[config.timeoutKey]);
        invalidateSettingsCache();
        saveSettingsDebounced();
    });

    // BUG-320 note: the `.dle-goto-ai-connections` click handler lives inside
    // openSettingsPopup now (it needs the popup-scoped switchSettingsTab closure).
}

function updatePopupInjectionModeVisibility($container, settings) {
    const isPromptList = settings.injectionMode === 'prompt_list';
    $container.find('.dle-injection-ext-controls').toggle(!isPromptList);
    $container.find('.dle-injection-pm-name').toggle(isPromptList);
    $container.find('#dle-sp-injection-pm-info').toggle(isPromptList);
    $container.find('.dle-injection-ext-controls').find('input, select').prop('disabled', isPromptList);
}

function updatePopupIndexStats() {
    const statsEl = document.getElementById('dle-sp-index-stats');
    if (!statsEl) return;
    if (vaultIndex.length > 0) {
        const totalKeys = vaultIndex.reduce((sum, e) => sum + e.keys.length, 0);
        const constants = vaultIndex.filter(e => e.constant).length;
        const totalTokens = vaultIndex.reduce((sum, e) => sum + e.tokenEstimate, 0);
        statsEl.textContent = `${vaultIndex.length} entries (${totalKeys} keywords, ${constants} always-send, ~${totalTokens} total tokens)`;
    } else {
        statsEl.textContent = 'No index loaded.';
    }
}

export async function openSettingsPopup(navigateTo = null) {
    // BUG-341: PromptManager is now likely available — drain queued prompt_list cleanup.
    drainPendingPromptListCleanup();
    const html = await renderExtensionTemplateAsync(
        EXTENSION_REF,
        'settings-popup',
    );
    const $container = $(html);
    applyHtmlI18n($container[0]); // markup-bearing locale strings (data-i18n-html) — ST's data-i18n is textContent-only

    // ── Sidebar accordion groups (collapse state persists via accountStorage) ──
    const NAV_GROUPS_KEY = 'dle-settings-nav-groups';
    function readGroupState() {
        try { return JSON.parse(accountStorage.getItem(NAV_GROUPS_KEY) || '{}') || {}; }
        catch { return {}; }
    }
    function setGroupCollapsed($group, collapsed, persist = true) {
        $group.toggleClass('collapsed', collapsed);
        $group.find('.dle-nav-group-header').attr('aria-expanded', String(!collapsed));
        if (persist) {
            const state = readGroupState();
            state[$group.data('nav-group')] = collapsed;
            accountStorage.setItem(NAV_GROUPS_KEY, JSON.stringify(state));
        }
    }

    // Old two-tier tab tokens → flat nav tokens. Persisted last-tab values and
    // external deep links (openSettingsPopup navigateTo, data-goto-tab) may
    // still carry pre-overhaul tokens; alias them permanently (cheap, load-bearing).
    // Old SUBTAB tokens are the new tab tokens 1:1 (obsidian, ai-connections,
    // author-notebook, ai-notebook, session-scribe, auto-lorebook, graph, librarian).
    const TAB_ALIAS = {
        matching: 'search',
        ai: 'search',
        connection: 'obsidian',
        features: 'author-notebook',
    };
    function resolveTabToken(tab, subtab = null) {
        if (subtab && $container.find(`.dle-settings-tab[data-settings-tab="${subtab}"]`).length) {
            return subtab;
        }
        return TAB_ALIAS[tab] || tab;
    }

    function switchSettingsTab($tab) {
        const tab = $tab.data('settings-tab');
        $container.find('.dle-settings-tab').removeClass('active').removeAttr('aria-current');
        $tab.addClass('active').attr('aria-current', 'page');
        $container.find('.dle-settings-panel').removeClass('active').attr('hidden', '');
        // NOTE: the merged Search tab spans TWO panel blocks that share
        // data-settings-panel="search" — the attribute selector activates both.
        $container.find(`[data-settings-panel="${tab}"]`).addClass('active').removeAttr('hidden');
        // Reveal the group that owns the newly active tab.
        const $group = $tab.closest('.dle-nav-group');
        if ($group.length && $group.hasClass('collapsed')) setGroupCollapsed($group, false, false);
        // BUG-042: accountStorage for cross-browser sync.
        accountStorage.setItem('dle-last-settings-tab', tab);
        $container.find('.dle-settings-content').scrollTop(0);
    }

    // Restore saved collapse state. First run (no saved state): all collapsed —
    // pinned About is the landing panel and groups teach the IA on demand.
    {
        const rawGroupState = accountStorage.getItem(NAV_GROUPS_KEY);
        const groupState = readGroupState();
        $container.find('.dle-nav-group').each(function () {
            const collapsed = rawGroupState == null ? true : !!groupState[$(this).data('nav-group')];
            if (collapsed) setGroupCollapsed($(this), true, false);
        });
    }
    $container.on('click', '.dle-nav-group-header', function () {
        const $group = $(this).closest('.dle-nav-group');
        setGroupCollapsed($group, !$group.hasClass('collapsed'));
    });

    // BUG-042: one-shot migration from legacy localStorage to accountStorage.
    let lastTab = accountStorage.getItem('dle-last-settings-tab');
    if (!lastTab) {
        const legacy = localStorage.getItem('dle-last-settings-tab');
        if (legacy) {
            accountStorage.setItem('dle-last-settings-tab', legacy);
            localStorage.removeItem('dle-last-settings-tab');
            lastTab = legacy;
        }
    }
    // Overhaul migration: 'connection'/'features' resolve through their old
    // last-subtab keys (consumed once here; no longer written anywhere).
    if (lastTab === 'connection' || lastTab === 'features') {
        const subKey = lastTab === 'connection' ? 'dle-last-connection-subtab' : 'dle-last-features-subtab';
        const sub = accountStorage.getItem(subKey) || localStorage.getItem(subKey);
        lastTab = resolveTabToken(lastTab, sub);
    } else if (lastTab) {
        lastTab = resolveTabToken(lastTab);
    }
    if (lastTab) {
        const $lastTab = $container.find(`.dle-settings-tab[data-settings-tab="${lastTab}"]`);
        if ($lastTab.length) switchSettingsTab($lastTab);
    }

    // navigateTo: callers pre-position the popup. Runs AFTER lastTab restore so it wins.
    // Scroll + pulse is deferred to onOpen so it runs after the dialog is mounted.
    // Accepts old tokens ({ tab: 'connection', subtab: 'ai-connections' }) via the alias map.
    function applyNavigateTo() {
        if (!navigateTo) return;
        try {
            const token = resolveTabToken(navigateTo.tab, navigateTo.subtab);
            if (token) {
                const $t = $container.find(`.dle-settings-tab[data-settings-tab="${token}"]`);
                if ($t.length) switchSettingsTab($t);
            }
            if (navigateTo.toolKey) {
                const $accordion = $container.find(`.dle-conn-accordion[data-tool="${navigateTo.toolKey}"]`);
                const $header = $accordion.find('.dle-conn-accordion-header');
                if ($header.attr('aria-expanded') !== 'true') {
                    $header.attr('aria-expanded', 'true');
                    $accordion.find('.dle-conn-accordion-body').show();
                }
            }
        } catch (e) { console.warn('[DLE] applyNavigateTo failed:', e); }
    }

    // Nav API bridge for handlers wired in bindPopupEvents (different function
    // scope). Pre-overhaul code there referenced switchSettingsTab & friends as
    // free variables, which threw ReferenceError at click time — retrieve via
    // $container.data('dleNav') instead.
    $container.data('dleNav', { switchSettingsTab, resolveTabToken });

    $container.on('click', '.dle-settings-tab', function () {
        switchSettingsTab($(this));
    });

    // Plain-nav arrow keys move focus between VISIBLE tabs (filtered/collapsed
    // rows are skipped); Enter/Space activate natively (they're <button>s).
    $container.on('keydown', '.dle-settings-tab', function (e) {
        const $tabs = $container.find('.dle-settings-tab:visible');
        const idx = $tabs.index(this);
        if (idx === -1) return;
        let newIdx = idx;
        switch (e.key) {
            case 'ArrowDown': newIdx = (idx + 1) % $tabs.length; break;
            case 'ArrowUp': newIdx = (idx - 1 + $tabs.length) % $tabs.length; break;
            case 'Home': newIdx = 0; break;
            case 'End': newIdx = $tabs.length - 1; break;
            default: return;
        }
        e.preventDefault();
        $tabs.eq(newIdx).trigger('focus');
    });

    $container.find('.dle-settings-panel').not('.active').attr('hidden', '');

    // BUG-320: cross-panel "AI Connections" links (goto handler needs this closure).
    $container.on('click', '.dle-goto-ai-connections', function (e) {
        e.preventDefault();
        const $tab = $container.find('.dle-settings-tab[data-settings-tab="ai-connections"]');
        if ($tab.length) switchSettingsTab($tab);
    });

    // Merged panel: the "AI search disabled" notice link now targets the mode
    // select on the SAME panel — just make sure Search is active and pulse it.
    $container.on('click', '#dle-sp-goto-matching', function (e) {
        e.preventDefault();
        const $searchTab = $container.find('.dle-settings-tab[data-settings-tab="search"]');
        if (!$searchTab.hasClass('active')) switchSettingsTab($searchTab);
        const $modeSelect = $container.find('#dle-sp-search-mode');
        $modeSelect[0]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        $modeSelect.addClass('dle-pulse');
        setTimeout(() => $modeSelect.removeClass('dle-pulse'), 2000);
    });

    // ── Settings search: DOM-walk label index → filter tabs → jump-highlight.
    // The index is built lazily from the rendered (already localized) DOM, so
    // it localizes for free and never drifts from the actual controls. ──
    function buildSearchIndex() {
        const index = [];
        $container.find('.dle-settings-panel').each(function () {
            const token = this.getAttribute('data-settings-panel');
            $(this).find('h4, h5, label').each(function () {
                const text = (this.textContent || '').trim().toLowerCase();
                if (text.length > 1) index.push({ text, token });
            });
        });
        return index;
    }
    {
        const $searchInput = $container.find('#dle-sp-nav-search');
        const $noResults = $container.find('#dle-sp-nav-noresults');
        const $navTabs = $container.find('.dle-settings-tab');
        const $navGroups = $container.find('.dle-nav-group');
        let searchIndex = null;
        let savedGroupCollapse = null;
        const clearNavFilter = () => {
            $container.find('.dle-search-badge').remove();
            $navTabs.removeClass('dle-filtered-out');
            $navGroups.removeClass('dle-filtered-out');
            if (savedGroupCollapse) {
                // Keep the group that owns the now-active tab expanded on restore.
                // A tab clicked during a live search force-expands its group; if the
                // pre-search snapshot had it collapsed, re-collapsing here would hide
                // the active nav item while its panel stays shown.
                const activeGroupEl = $navTabs.filter('.active').closest('.dle-nav-group').get(0) || null;
                $navGroups.each(function () {
                    const was = savedGroupCollapse.get(this);
                    if (was != null && this !== activeGroupEl) setGroupCollapsed($(this), was, false);
                });
                savedGroupCollapse = null;
            }
            $noResults.removeClass('dle-visible');
        };
        $searchInput.on('keydown', function (e) {
            if (e.key === 'Escape') {
                e.stopPropagation();
                $searchInput.val('');
                clearNavFilter();
            }
        });
        $searchInput.on('input', function () {
            const q = String($searchInput.val() || '').trim().toLowerCase();
            $container.find('.dle-search-badge').remove();
            if (!q) { clearNavFilter(); return; }
            if (!searchIndex) searchIndex = buildSearchIndex();
            if (!savedGroupCollapse) {
                savedGroupCollapse = new Map();
                $navGroups.each(function () { savedGroupCollapse.set(this, $(this).hasClass('collapsed')); });
            }
            const perToken = {};
            for (const entry of searchIndex) {
                if (entry.text.includes(q)) perToken[entry.token] = (perToken[entry.token] || 0) + 1;
            }
            let anyVisible = false;
            $navTabs.each(function () {
                const token = this.getAttribute('data-settings-tab');
                const n = perToken[token] || 0;
                const selfMatch = (this.textContent || '').toLowerCase().includes(q);
                const out = !n && !selfMatch;
                $(this).toggleClass('dle-filtered-out', out);
                if (!out) anyVisible = true;
                if (n) $('<span class="dle-search-badge"></span>').text(n).appendTo(this);
            });
            $navGroups.each(function () {
                const visible = $(this).find('.dle-settings-tab:not(.dle-filtered-out)').length > 0;
                $(this).toggleClass('dle-filtered-out', !visible);
                if (visible) setGroupCollapsed($(this), false, false);
            });
            $noResults.toggleClass('dle-visible', !anyVisible);
        });
        // Jump + highlight: clicking a tab while a query is live flashes the
        // matching labels in the target panel and scrolls the first into view.
        $container.on('click', '.dle-settings-tab', function () {
            const q = String($searchInput.val() || '').trim().toLowerCase();
            if (!q) return;
            requestAnimationFrame(() => {
                let first = null;
                // .active can span two blocks (merged Search panel) — walk them all.
                $container.find('.dle-settings-panel.active').find('h4, h5, label').each(function () {
                    if ((this.textContent || '').toLowerCase().includes(q)) {
                        if (!first) first = this;
                        this.classList.remove('dle-search-hit');
                        void this.offsetWidth;
                        this.classList.add('dle-search-hit');
                    }
                });
                if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
            });
        });
    }

    $container.on('keydown', '[role="button"][tabindex="0"]', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            $(this).trigger('click');
        }
    });

    $container.on('click', '.dle-advanced-toggle', function () {
        const section = $(this).data('section');
        const $section = $container.find(`.dle-advanced-section[data-section="${section}"]`);
        const isOpen = $section.is(':visible');
        $section.slideToggle(200);
        $(this).attr('aria-expanded', String(!isOpen));
        $(this).find('.dle-advanced-icon')
            .toggleClass('fa-chevron-right', isOpen)
            .toggleClass('fa-chevron-down', !isOpen);
        const s = getSettings();
        if (!s.advancedVisible) s.advancedVisible = {};
        s.advancedVisible[section] = !isOpen;
        saveSettingsDebounced();
    });

    loadPopupSettings($container);
    bindPopupEvents($container);
    initPromptPresets($container, getSettings());

    // Render Reference tab from DLE_COMMANDS (single source of truth) + click-to-copy.
    renderReferenceTab($container);

    // Pre-position before dialog renders so user sees the right panel on first frame.
    applyNavigateTo();

    await callGenericPopup($container, POPUP_TYPE.DISPLAY, '', {
        large: true,
        wide: true,
        allowVerticalScrolling: true,
        onOpen: (popup) => {
            updatePopupIndexStats();
            // Two rAFs: first lets layout settle after dialog open,
            // second runs after slideToggle/scroll finishes painting.
            if (navigateTo?.target) {
                requestAnimationFrame(() => requestAnimationFrame(() => {
                    try {
                        const el = $container.find(`#${navigateTo.target}`)[0]
                            || $container.find(`[data-setting-id="${navigateTo.target}"]`)[0];
                        if (el) {
                            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            el.classList.add('dle-pulse');
                            setTimeout(() => el.classList.remove('dle-pulse'), 2000);
                        }
                    } catch (e) { console.warn('[DLE] navigateTo scroll/pulse failed:', e); }
                }));
            }
            // BUG-102: clicking the ::backdrop area of the <dialog> fires a click
            // on the dialog itself with target === dialog. Use the popup util
            // rather than reaching into .popup-button-close.
            const dlg = popup?.dlg || $container[0]?.closest('dialog');
            if (dlg) {
                dlg.addEventListener('click', (e) => {
                    if (e.target === dlg) {
                        saveSettingsDebounced();
                        if (popup?.completeCancelled) {
                            popup.completeCancelled();
                        } else if (popup?.complete) {
                            popup.complete(POPUP_RESULT.CANCELLED);
                        }
                    }
                });
            }
        },
    });
}

// Populate a per-tool "Write to Vault" <select>. Empty option means "use primary".
// Vaults appear by .name; disabled vaults are still listed (marked) so users can
// see why a previously-chosen vault is now inactive instead of silently losing it.
function populateWriteVaultSelect($el, settings, selectedName) {
    if (!$el || $el.length === 0) return;
    const vaults = settings.vaults || [];
    const opts = ['<option value="">(primary vault)</option>'];
    for (const v of vaults) {
        const name = String(v.name || '');
        if (!name) continue;
        const safe = escapeHtml(name);
        const suffix = v.enabled ? '' : ' (disabled)';
        const sel = name === selectedName ? ' selected' : '';
        opts.push(`<option value="${safe}"${sel}>${safe}${suffix}</option>`);
    }
    $el.html(opts.join(''));
    // Keep the configured value even if no <option> matches (e.g. vault renamed).
    // Empty value falls back to primary at resolveWriteVault() time.
    if (selectedName && !vaults.some(v => v.name === selectedName)) {
        $el.append(`<option value="${escapeHtml(selectedName)}" selected>${escapeHtml(selectedName)} (missing)</option>`);
    }
}

// ── Popup: Load Settings ──

function loadPopupSettings($container) {
    const settings = getSettings();
    const $c = (sel) => $container.find(sel);

    // f020: disable a gated number field at the row level so its label/help text fade with the input
    // (not just the box). Toggles .dle-control-disabled on the field's .flex1 wrapper; the input keeps
    // its own disabled attribute for interaction blocking.
    const setRowDisabled = ($input, disabled) => {
        $input.prop('disabled', disabled).closest('.flex1').toggleClass('dle-control-disabled', !!disabled);
    };

    // ── Connection ──
    $c('#dle-sp-enabled').prop('checked', settings.enabled);
    renderVaultList(settings, $c('#dle-sp-vault-list')[0]);
    $c('#dle-sp-multi-vault-conflict').val(settings.multiVaultConflictResolution);
    $c('#dle-sp-field-definitions-path').val(settings.fieldDefinitionsPath || 'DeepLore/field-definitions.yaml');

    // ── Prompts tab ──
    $c('#dle-sp-prompts-language').val(settings.aiPromptLocale || '');
    $c('#dle-sp-prompts-folder-path').val(settings.promptsFolderPath || DLE_PROMPTS_DEFAULT_DIR);
    $c('#dle-sp-tag').val(settings.lorebookTag);
    $c('#dle-sp-constant-tag').val(settings.constantTag);
    $c('#dle-sp-never-insert-tag').val(settings.neverInsertTag);
    $c('#dle-sp-seed-tag').val(settings.seedTag);
    $c('#dle-sp-bootstrap-tag').val(settings.bootstrapTag);
    $c('#dle-sp-librarian-guide-tag').val(settings.librarianGuideTag);
    $c('#dle-sp-new-chat-threshold').val(settings.newChatThreshold);

    // ── Matching ──
    // BUG-127: canonical runtime value is `keywords-only` (plural).
    const searchMode = !settings.aiSearchEnabled ? 'keywords-only'
        : (settings.aiSearchMode === 'ai-only' ? 'ai-only' : 'two-stage');
    $c('#dle-sp-search-mode').val(searchMode);
    $c('#dle-sp-scan-depth').val(settings.scanDepth);
    $c('#dle-sp-char-context-scan').prop('checked', settings.characterContextScan);
    $c('#dle-sp-fuzzy-search').prop('checked', settings.fuzzySearchEnabled);
    $c('#dle-sp-fuzzy-min-score').val(settings.fuzzySearchMinScore);
    $c('#dle-sp-fuzzy-min-score-value').text((settings.fuzzySearchMinScore || 0.5).toFixed(1));
    $c('#dle-sp-fuzzy-min-score-row').toggle(settings.fuzzySearchEnabled);
    if (settings.fuzzySearchEnabled) runFuzzyPreview();
    $c('#dle-sp-unlimited-entries').prop('checked', settings.unlimitedEntries);
    setRowDisabled($c('#dle-sp-max-entries').val(settings.maxEntries), settings.unlimitedEntries);
    $c('#dle-sp-unlimited-entries-warn').toggle(!!settings.unlimitedEntries);
    $c('#dle-sp-unlimited-budget').prop('checked', settings.unlimitedBudget);
    setRowDisabled($c('#dle-sp-token-budget').val(settings.maxTokensBudget), settings.unlimitedBudget);
    $c('#dle-sp-unlimited-budget-warn').toggle(!!settings.unlimitedBudget);
    $c('#dle-sp-optimize-keys-mode').val(settings.optimizeKeysMode);
    $c('#dle-sp-case-sensitive').prop('checked', settings.caseSensitive);
    $c('#dle-sp-match-whole-words').prop('checked', settings.matchWholeWords);
    $c('#dle-sp-recursive-scan').prop('checked', settings.recursiveScan);
    setRowDisabled($c('#dle-sp-max-recursion').val(settings.maxRecursionSteps), !settings.recursiveScan);
    $c('#dle-sp-reinjection-cooldown').val(settings.reinjectionCooldown);
    $c('#dle-sp-strip-dedup').prop('checked', settings.stripDuplicateInjections);
    setRowDisabled($c('#dle-sp-strip-lookback').val(settings.stripLookbackDepth), !settings.stripDuplicateInjections);
    $c('#dle-sp-keyword-occurrence-weighting').prop('checked', settings.keywordOccurrenceWeighting);
    $c('#dle-sp-priority-reversed').prop('checked', settings.priorityReversed);
    $c('#dle-sp-import-compress-default').prop('checked', settings.importCompressByDefault);
    $c('#dle-sp-wi-import-em-handling').val(settings.wiImportEmHandling || 'append');
    $c('#dle-sp-contextual-gating-tolerance').val(settings.contextualGatingTolerance);

    // ── Injection tab ──
    $c(`input[name="dle-sp-injection-mode"][value="${settings.injectionMode || 'extension'}"]`).prop('checked', true);
    updatePopupInjectionModeVisibility($container, settings);
    // Lore position (now a select dropdown)
    $c('#dle-sp-position').val(String(settings.injectionPosition));
    $c('#dle-sp-depth').val(settings.injectionDepth);
    $c('#dle-sp-role').val(settings.injectionRole);
    $c('#dle-sp-position').closest('.dle-injection-row').find('.dle-injection-inchat-controls').toggle(settings.injectionPosition === 1);
    // Author Notebook position (now a select dropdown)
    $c('#dle-sp-notebook-position').val(String(settings.notebookPosition));
    $c('#dle-sp-notebook-depth').val(settings.notebookDepth);
    $c('#dle-sp-notebook-role').val(settings.notebookRole);
    $c('#dle-sp-notebook-position').closest('.dle-injection-row').find('.dle-injection-inchat-controls').toggle(settings.notebookPosition === 1);
    $c('#dle-sp-ai-notepad-position').val(String(settings.aiNotepadPosition));
    $c('#dle-sp-ai-notepad-depth').val(settings.aiNotepadDepth);
    $c('#dle-sp-ai-notepad-role').val(settings.aiNotepadRole);
    $c('#dle-sp-ai-notepad-position').closest('.dle-injection-row').find('.dle-injection-inchat-controls').toggle(settings.aiNotepadPosition === 1);
    $c('#dle-sp-template').val(settings.injectionTemplate);
    $c('#dle-sp-allow-wi-scan').prop('checked', settings.allowWIScan);

    // ── AI Connections accordion ──
    buildAccordionHtml($container);
    populateAccordions($container);
    refreshClaudeEffortBanner($container);

    // ── AI Search ──
    $c('#dle-sp-ai-scan-depth').val(settings.aiSearchScanDepth);
    $c('#dle-sp-ai-system-prompt').val(settings.aiSearchSystemPrompt);
    $c('#dle-sp-ai-summary-length').val(settings.aiSearchManifestSummaryLength);
    $c('#dle-sp-ai-manifest-fields').val(Array.isArray(settings.aiManifestIncludeFields) ? settings.aiManifestIncludeFields.join(', ') : '');
    $c('#dle-sp-response-prefill-mode').val(settings.responsePrefillMode || 'off');
    $c('#dle-sp-response-prefill-seed').val(settings.responsePrefillSeed || '');
    $c('#dle-sp-ai-claude-prefix').prop('checked', settings.aiSearchClaudeCodePrefix);
    $c('#dle-sp-ai-force-user-role').prop('checked', settings.aiForceUserRole);
    $c('#dle-sp-scribe-informed-retrieval').prop('checked', settings.scribeInformedRetrieval);
    $c('#dle-sp-ai-confidence-threshold').val(settings.aiConfidenceThreshold);
    $c('#dle-sp-hierarchical-prefilter').prop('checked', settings.hierarchicalPreFilter);
    $c('#dle-sp-hierarchical-options').toggle(!!settings.hierarchicalPreFilter);
    $c('#dle-sp-hierarchical-aggressiveness').val(settings.hierarchicalAggressiveness);
    $c('#dle-sp-hierarchical-value').text(settings.hierarchicalAggressiveness);
    $c('#dle-sp-manifest-summary-mode').val(settings.manifestSummaryMode);
    $c('#dle-sp-ai-error-fallback').val(settings.aiErrorFallback);
    $c('#dle-sp-ai-empty-fallback').val(settings.aiEmptyFallback);
    $c('#dle-sp-show-sources').prop('checked', settings.showLoreSources);
    $c('#dle-sp-decay-enabled').prop('checked', settings.decayEnabled);
    $c('#dle-sp-decay-boost-threshold').val(settings.decayBoostThreshold);
    $c('#dle-sp-decay-penalty-threshold').val(settings.decayPenaltyThreshold);
    $c('#dle-sp-decay-controls').toggleClass('dle-dimmed', !settings.decayEnabled);
    $c('#dle-sp-decay-controls input').prop('disabled', !settings.decayEnabled);

    // ── Features — Graph ──
    $c('#dle-sp-graph-color-mode').val(settings.graphDefaultColorMode);
    $c('#dle-sp-graph-hover-dim-distance').val(settings.graphHoverDimDistance);
    $c('#dle-sp-graph-focus-tree-depth').val(settings.graphFocusTreeDepth);
    $c('#dle-sp-graph-show-labels').prop('checked', settings.graphShowLabels);
    $c('#dle-sp-graph-repulsion').val(settings.graphRepulsion);
    $c('#dle-sp-graph-gravity').val(settings.graphGravity);
    $c('#dle-sp-graph-damping').val(settings.graphDamping);
    $c('#dle-sp-graph-hover-falloff').val(settings.graphHoverFalloff);
    $c('#dle-sp-graph-edge-filter-alpha').val(settings.graphEdgeFilterAlpha);

    // ── Features — Librarian ──
    $c('#dle-sp-librarian-enabled').prop('checked', settings.librarianEnabled);
    $c('#dle-sp-librarian-search').prop('checked', settings.librarianSearchEnabled);
    $c('#dle-sp-librarian-flag').prop('checked', settings.librarianFlagEnabled);
    $c('#dle-sp-librarian-show-tool-calls').prop('checked', settings.librarianShowToolCalls !== false);
    $c('#dle-sp-librarian-per-message').prop('checked', settings.librarianPerMessageActivity !== false);
    $c('#dle-sp-librarian-max-searches').val(settings.librarianMaxSearches);
    $c('#dle-sp-librarian-max-results').val(settings.librarianMaxResults);
    $c('#dle-sp-librarian-token-budget').val(settings.librarianResultTokenBudget);
    $c('#dle-sp-librarian-write-folder').val(settings.librarianWriteFolder || '');
    populateWriteVaultSelect($c('#dle-sp-librarian-write-vault'), settings, settings.librarianWriteVaultId || '');
    $c('#dle-sp-librarian-auto-send').prop('checked', settings.librarianAutoSendOnGap !== false);
    $c('#dle-sp-librarian-sub').toggle(settings.librarianEnabled);
    $c('#dle-sp-librarian-manifest-max').val(settings.librarianManifestMaxChars || 8000);
    $c('#dle-sp-librarian-related-max').val(settings.librarianRelatedEntriesMaxChars || 4000);
    $c('#dle-sp-librarian-chat-context-max').val(settings.librarianChatContextMaxChars || 4000);
    $c('#dle-sp-librarian-draft-max').val(settings.librarianDraftMaxChars || 4000);
    $c('#dle-sp-librarian-max-tool-calls-per-turn').val(settings.librarianMaxToolCallsPerTurn ?? 10);
    $c('#dle-sp-librarian-max-validation-retries').val(settings.librarianMaxValidationRetries ?? 3);
    $c('#dle-sp-librarian-session-history').val(settings.librarianSessionHistoryMessages ?? 10);
    $c('#dle-sp-librarian-agentic-history').val(settings.librarianAgenticHistoryMessages ?? 40);
    $c('#dle-sp-librarian-session-tool-cap').val(settings.librarianSessionToolCallCap ?? '');
    $c(`input[name="dle-sp-librarian-prompt-mode"][value="${settings.librarianSystemPromptMode || 'default'}"]`).prop('checked', true);
    $c('#dle-sp-librarian-custom-prompt').val(settings.librarianCustomSystemPrompt || '');
    $c('#dle-sp-librarian-custom-prompt').toggle((settings.librarianSystemPromptMode || 'default') !== 'default');

    $c('#dle-sp-lib-chat-searches').text(librarianChatStats.searchCalls);
    $c('#dle-sp-lib-chat-flags').text(librarianChatStats.flagCalls);
    $c('#dle-sp-lib-chat-tokens').text(librarianChatStats.estimatedExtraTokens);
    $c('#dle-sp-lib-session-searches').text(librarianSessionStats.searchCalls);
    $c('#dle-sp-lib-session-flags').text(librarianSessionStats.flagCalls);
    $c('#dle-sp-lib-session-tokens').text(librarianSessionStats.estimatedExtraTokens);
    const allTime = settings.analyticsData?._librarian || {};
    $c('#dle-sp-lib-all-searches').text(allTime.totalGapSearches || 0);
    $c('#dle-sp-lib-all-flags').text(allTime.totalGapFlags || 0);
    $c('#dle-sp-lib-entries-written').text(`Entries written: ${allTime.totalEntriesWritten || 0}`);
    const unmet = allTime.topUnmetQueries || [];
    if (unmet.length > 0) {
        let unmetHtml = '<h5 class="dle-settings-subsection-label">Top Unmet Queries</h5><div class="dle-text-xs" style="opacity: 0.7;">';
        for (const u of unmet.slice(0, 10)) {
            unmetHtml += `<div>${escapeHtml(u.query)} (${u.count}×)</div>`;
        }
        unmetHtml += '</div>';
        $c('#dle-sp-lib-unmet-queries').html(unmetHtml);
    }

    // ── Features — Notebook ──
    $c('#dle-sp-notebook-enabled').prop('checked', settings.notebookEnabled);

    // ── Features — AI Notebook ──
    $c('#dle-sp-ai-notepad-enabled').prop('checked', settings.aiNotepadEnabled);
    const aiNbMode = settings.aiNotepadMode || 'tag';
    $c(`input[name="dle-sp-ai-notepad-mode"][value="${aiNbMode}"]`).prop('checked', true);
    $c('#dle-sp-ai-notepad-prompt').val(settings.aiNotepadPrompt || '');
    $c('#dle-sp-ai-notepad-extract-prompt').val(settings.aiNotepadExtractPrompt || '');
    $c('#dle-sp-ai-notepad-max-entries').val(settings.aiNotepadMaxEntries ?? 50);
    $c('#dle-sp-ai-notepad-fuzzy-threshold').val(settings.aiNotepadFuzzyDedupThreshold ?? 0.85);
    $c('#dle-sp-ai-notepad-mode-tag-desc').toggle(aiNbMode === 'tag');
    $c('#dle-sp-ai-notepad-mode-extract-desc').toggle(aiNbMode === 'extract');
    $c('#dle-sp-ai-notepad-tag-options').toggle(aiNbMode === 'tag');
    $c('#dle-sp-ai-notepad-extract-options').toggle(aiNbMode === 'extract');
    $c('.dle-conn-accordion[data-tool="aiNotepad"]').toggle(aiNbMode !== 'tag');

    // ── Features — Scribe ──
    $c('#dle-sp-scribe-enabled').prop('checked', settings.scribeEnabled);
    $c('#dle-sp-scribe-controls').find('input, textarea, select').prop('disabled', !settings.scribeEnabled);
    $c('#dle-sp-scribe-controls').find('.menu_button').toggleClass('disabled', !settings.scribeEnabled);
    $c('#dle-sp-scribe-interval').val(settings.scribeInterval);
    $c('#dle-sp-scribe-folder').val(settings.scribeFolder);
    populateWriteVaultSelect($c('#dle-sp-scribe-write-vault'), settings, settings.scribeWriteVaultId || '');
    $c('#dle-sp-scribe-scan-depth').val(settings.scribeScanDepth);
    $c('#dle-sp-scribe-prompt').val(settings.scribePrompt);

    // ── Features — Auto Lorebook ──
    $c('#dle-sp-autosuggest-enabled').prop('checked', settings.autoSuggestEnabled);
    $c('#dle-sp-autosuggest-controls').find('input, textarea, select').prop('disabled', !settings.autoSuggestEnabled);
    $c('#dle-sp-autosuggest-interval').val(settings.autoSuggestInterval);
    $c('#dle-sp-autosuggest-folder').val(settings.autoSuggestFolder);
    populateWriteVaultSelect($c('#dle-sp-autosuggest-write-vault'), settings, settings.autoSuggestWriteVaultId || '');
    $c('#dle-sp-autosuggest-skip-review').prop('checked', settings.autoSuggestSkipReview);
    $c('#dle-sp-autosuggest-prompt').val(settings.autoSuggestPrompt);
    $c('#dle-sp-optimize-keys-prompt').val(settings.optimizeKeysPrompt);

    // ── System ── (index stats updated in onOpen, after DOM is live)
    $c('#dle-sp-cache-ttl').val(settings.cacheTTL);
    $c('#dle-sp-sync-interval').val(settings.syncPollingInterval);
    $c('#dle-sp-index-rebuild-trigger').val(settings.indexRebuildTrigger);
    $c('#dle-sp-rebuild-gen-interval').val(settings.indexRebuildGenerationInterval);
    const showTrigger = (t) => {
        $c('#dle-sp-rebuild-trigger-ttl-desc').toggle(t === 'ttl');
        $c('#dle-sp-rebuild-trigger-gen-desc').toggle(t === 'generation');
        $c('#dle-sp-rebuild-trigger-manual-desc').toggle(t === 'manual');
        $c('#dle-sp-rebuild-gen-interval-row').toggle(t === 'generation');
    };
    showTrigger(settings.indexRebuildTrigger);
    $c('#dle-sp-show-sync-toasts').prop('checked', settings.showSyncToasts);
    $c('#dle-sp-review-tokens').val(settings.reviewResponseTokens);
    $c('#dle-sp-debug').prop('checked', settings.debugMode);

    // BUG-338: D4 rename migration — gated on persistent flag for once-only execution.
    if (settings.advancedVisible && !settings._advancedVisibleMigratedD4) {
        const renames = { sp_vaultTags: 'sp_vault_tags', sp_aiSearch: 'sp_ai_search' };
        let mutated = false;
        for (const [old, nw] of Object.entries(renames)) {
            if (old in settings.advancedVisible) {
                settings.advancedVisible[nw] = settings.advancedVisible[old];
                delete settings.advancedVisible[old];
                mutated = true;
            }
        }
        settings._advancedVisibleMigratedD4 = true;
        if (mutated) saveSettingsDebounced();
    }

    const advVisible = settings.advancedVisible || {};
    $container.find('.dle-advanced-section').each(function () {
        const section = jQuery(this).data('section');
        if (advVisible[section]) {
            jQuery(this).show();
            jQuery(this).prev('.dle-advanced-toggle')
                .find('.dle-advanced-icon').removeClass('fa-chevron-right').addClass('fa-chevron-down');
            jQuery(this).prev('.dle-advanced-toggle').attr('aria-expanded', 'true');
        }
    });

    updatePopupModeVisibility($container, settings);

    // Re-render prompts grid in case reset-defaults or another popup re-load
    // ran after a vault change. Safe to call even before bindPromptsTabHandlers
    // wires actions — grid markup updates either way.
    try {
        renderPromptsGrid($container);
    } catch (err) {
        console.warn('[DLE prompts] grid render failed:', err?.message);
    }
}

// ── Popup: Bind Events ──

/** Returns fallback only for truly non-numeric input — preserves 0 as a valid value. */
function numVal(raw, fallback) {
    const n = Number(raw);
    return Number.isNaN(n) ? fallback : n;
}

/**
 * Clamp a number input's value to its own min/max (f021).
 * The HTML min/max attrs only constrain the spinner arrows, not keyboard entry —
 * a user can type 9999 into a max=100 field and it would otherwise persist silently.
 * Reads the element's min/max and returns the clamped number; an in-range typed
 * value is left unchanged. NaN → fallback (preserves 0 as valid via numVal).
 * Step is intentionally NOT snapped here: the browser spinner arrows already honor
 * the step attribute, and snapping to a min-based grid would corrupt valid typed
 * values whose default/grid misalign (e.g. graphGravity min 0.1, step 0.5, default
 * 11.0 → grid lacks 11.0, so 11 would be rewritten to 11.1). See gotchas (SUI-1).
 * Returns the same numeric value numVal would for in-range input, so callers that
 * already store numVal($el.val(), fb) get identical results when nothing was out of range.
 */
function clampInput(el, fallback) {
    const n = numVal(el?.value, fallback);
    let v = n;
    const min = el?.min !== '' && el?.min != null ? Number(el.min) : null;
    const max = el?.max !== '' && el?.max != null ? Number(el.max) : null;
    if (min != null && Number.isFinite(min)) v = Math.max(min, v);
    if (max != null && Number.isFinite(max)) v = Math.min(max, v);
    // Never emit a non-finite value: a NaN fallback (or NaN clamp via Math.max/min
    // when v is NaN and a bound is finite) would otherwise stringify to "NaN" and
    // persist. Prefer a finite bound, else 0.
    if (!Number.isFinite(v)) v = Number.isFinite(min) ? min : Number.isFinite(max) ? max : 0;
    return v;
}

/**
 * Toy demo for the fuzzy strictness slider — no vault connection needed.
 * Uses real BM25 (same k1/b/tokenizer as bm25.js) against a hardcoded
 * mini-corpus so users can see how the threshold controls which entries pass.
 */
const FUZZY_TOY_CORPUS = [
    { title: 'Velmira the Blade',    content: 'A retired assassin who once served the shadow court. Now sells guild secrets to the highest bidder from a hidden safehouse.' },
    { title: 'The Hollow Fang',      content: 'A secretive assassin guild operating from the sewers beneath the capital. Members use shadow magic to vanish after completing a contract.' },
    { title: 'Nightveil District',   content: 'The shadow quarter of the capital where thieves and smugglers gather. Home to several guild halls and black market dealers.' },
    { title: 'Merchant Guild Prices', content: 'The official guild price list for trade across the realm. Establishes taxation and merchant protections for all five kingdoms.' },
    { title: 'Sunforge Cathedral',   content: 'A grand cathedral of golden spires dedicated to the sun goddess. Priests perform healing rituals. A shadow falls across the altar each equinox.' },
    { title: 'Starfall Academy',     content: 'A prestigious school for young mages perched on a cliffside. Students study elemental magic and arcane theory in ancient towers.' },
];
const FUZZY_TOY_QUERY = 'shadow assassin guild';
let _fuzzyToyScores = null;

/** Compute once, reuse on slider changes. */
function getFuzzyToyScores() {
    if (_fuzzyToyScores) return _fuzzyToyScores;
    const k1 = 1.5, b = 0.75;
    const tokenize = t => t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 2);
    const docs = FUZZY_TOY_CORPUS.map(e => {
        const tokens = tokenize(`${e.title} ${e.content}`);
        const tf = new Map();
        for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
        return { title: e.title, tf, len: tokens.length };
    });
    const N = docs.length;
    const avgDl = docs.reduce((s, d) => s + d.len, 0) / N;
    const df = new Map();
    for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    const idf = new Map();
    for (const [t, f] of df) idf.set(t, Math.log((N - f + 0.5) / (f + 0.5) + 1));
    const queryTerms = new Set(tokenize(FUZZY_TOY_QUERY));
    _fuzzyToyScores = docs.map(d => {
        let score = 0;
        const matchedWords = [];
        for (const term of queryTerms) {
            const termIdf = idf.get(term);
            if (!termIdf) continue;
            const tf = d.tf.get(term) || 0;
            if (tf === 0) continue;
            score += termIdf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * d.len / avgDl));
            matchedWords.push(term);
        }
        return { title: d.title, score, matchedWords };
    }).sort((a, b) => b.score - a.score);
    return _fuzzyToyScores;
}

function runFuzzyPreview() {
    const $results = $('#dle-sp-fuzzy-preview-results');
    if (!$results.length) return;

    const minScore = getSettings().fuzzySearchMinScore || 0.5;
    const scores = getFuzzyToyScores();

    let html = '<div style="margin-bottom:4px;">';
    html += '<span class="dle-text-xs"><i class="fa-solid fa-flask" style="color:var(--dle-info,#2196f3);"></i> <strong>How this works</strong>';
    html += ' <span class="dle-muted">— sample data, not your vault</span></span></div>';
    html += `<div style="margin-bottom:6px;"><span class="dle-text-xs dle-muted">If a chat message said </span><span class="dle-text-xs"><strong>"${FUZZY_TOY_QUERY}"</strong></span><span class="dle-text-xs dle-muted">, these entries would be checked:</span></div>`;

    html += '<table style="width:100%;border-collapse:collapse;">';
    html += '<tr style="border-bottom:1px solid var(--dle-border,#444);"><th style="text-align:left;padding:2px 4px;"><span class="dle-text-xs">Entry</span></th><th style="text-align:left;padding:2px 4px;"><span class="dle-text-xs">Words matched</span></th><th style="text-align:right;padding:2px 4px;"><span class="dle-text-xs">Score</span></th><th style="text-align:center;padding:2px 4px;"></th></tr>';
    for (const e of scores) {
        const passes = e.score >= minScore;
        const icon = passes ? '✓' : '✗';
        const iconColor = passes ? 'var(--dle-success,#4caf50)' : 'var(--dle-error,#f44336)';
        const wordsHtml = e.matchedWords.length > 0
            ? e.matchedWords.map(w => `<span style="color:var(--dle-info,#2196f3);">${escapeHtml(w)}</span>`).join(', ')
            : '<span class="dle-muted">—</span>';
        html += `<tr style="opacity:${passes ? 1 : 0.5};">`;
        html += `<td style="padding:2px 4px;"><span class="dle-text-xs">${escapeHtml(e.title)}</span></td>`;
        html += `<td style="padding:2px 4px;"><span class="dle-text-xs">${wordsHtml}</span></td>`;
        html += `<td style="text-align:right;padding:2px 4px;"><span class="dle-text-xs dle-muted">${e.score.toFixed(2)}</span></td>`;
        html += `<td style="text-align:center;padding:2px 4px;color:${iconColor};font-weight:bold;"><span class="dle-text-xs">${icon}</span></td>`;
        html += '</tr>';
    }
    html += '</table>';
    $results.html(html);
}

function bindPopupEvents($container) {
    const settings = getSettings();
    const $c = (sel) => $container.find(sel);

    // f020: row-level disable (label + input fade together). Mirrors the helper in loadPopupSettings.
    const setRowDisabled = ($input, disabled) => {
        $input.prop('disabled', disabled).closest('.flex1').toggleClass('dle-control-disabled', !!disabled);
    };

    // BUG-120: _rebuildTimer module-scoped so new popup cancels stale timer.
    const debouncedRebuild = () => { clearTimeout(_rebuildTimer); _rebuildTimer = setTimeout(() => buildIndexWithReuse(), 500); };

    $container.on('change input', 'input, select, textarea', () => invalidateSettingsCache());

    // f021: clamp typed-in number values to the input's own min/max/step. The HTML
    // attrs only constrain the spinner arrows, so a user can keyboard 9999 into a
    // max=100 field and it would persist silently. On commit (change = blur/Enter),
    // correct the displayed value and re-dispatch `input` so the field's own handler
    // stores the clamped number. Flash so the auto-correction is visible, not silent.
    $container.on('change', 'input[type="number"]', function () {
        const el = this;
        if (el.value === '') return; // empty handled by each field's fallback
        const clamped = clampInput(el, numVal(el.value, 0));
        if (clamped === numVal(el.value, NaN)) return; // already in range — no-op
        el.value = String(clamped);
        // Re-run the field's own input handler so settings pick up the clamped value.
        $(el).trigger('input');
        const $el = $(el);
        $el.addClass('dle-input-clamped');
        setTimeout(() => $el.removeClass('dle-input-clamped'), 500);
    });

    // ── Connection ──
    $c('#dle-sp-enabled').on('change', function () {
        settings.enabled = $(this).prop('checked');
        saveSettingsDebounced();
        setupSyncPolling(buildIndexWithReuse, buildIndexWithReuse);
        $('#dle-enabled').prop('checked', settings.enabled);
    });

    bindVaultListEvents(settings, $c('#dle-sp-vault-list'), $c('#dle-sp-add-vault'));
    $c('#dle-sp-multi-vault-conflict').on('change', function () { settings.multiVaultConflictResolution = String($(this).val()); saveSettingsDebounced(); });
    $c('#dle-sp-field-definitions-path').on('change', function () { settings.fieldDefinitionsPath = String($(this).val()).trim() || 'DeepLore/field-definitions.yaml'; saveSettingsDebounced(); });
    $c('#dle-sp-edit-fields-btn').on('click', async () => {
        // BUG-138: await so post-await errors surface to the catch.
        const { openRuleBuilder } = await import('./rule-builder.js');
        await openRuleBuilder();
    });

    // ── Prompts tab handlers ─────────────────────────────────────────────────
    bindPromptsTabHandlers($container, settings);

    $c('#dle-sp-export-diagnostics').on('click', async function () {
        const $btn = $(this);
        const $label = $btn.find('#dle-sp-export-diagnostics-label');
        const origLabel = $label.text();
        if ($btn.prop('disabled')) return;
        $btn.prop('disabled', true).addClass('disabled');
        $label.text('Processing...');
        try {
            const { triggerDiagnosticDownload } = await import('../diagnostics/ui.js');
            const { scrubStats } = await triggerDiagnosticDownload();
            $label.text('Done');

            const statParts = [];
            if (scrubStats.ips > 0) statParts.push(`${scrubStats.ips} IPs`);
            if (scrubStats.ipv6s > 0) statParts.push(`${scrubStats.ipv6s} IPv6`);
            if (scrubStats.hosts > 0) statParts.push(`${scrubStats.hosts} hostnames`);
            if (scrubStats.emails > 0) statParts.push(`${scrubStats.emails} emails`);
            if (scrubStats.userPaths > 0) statParts.push(`${scrubStats.userPaths} user paths`);
            if (scrubStats.titles > 0) statParts.push(`${scrubStats.titles} titles`);
            if (scrubStats.sensitiveFields > 0) statParts.push(`${scrubStats.sensitiveFields} sensitive fields`);
            if (scrubStats.bearerTokens > 0) statParts.push(`${scrubStats.bearerTokens} bearer tokens`);
            if (scrubStats.openaiKeys > 0) statParts.push(`${scrubStats.openaiKeys} API keys`);
            if (scrubStats.longTokens > 0) statParts.push(`${scrubStats.longTokens} long tokens`);
            const statsHtml = statParts.length > 0
                ? `<p style="margin: 8px 0; padding: 8px 12px; background: var(--SmartThemeBlurTintColor); border-radius: 6px; font-size: 0.9em;"><strong>Anonymized:</strong> ${statParts.join(', ')}. Profile names, vault names, and character names were partially masked.</p>`
                : '<p style="margin: 8px 0; padding: 8px 12px; background: var(--SmartThemeBlurTintColor); border-radius: 6px; font-size: 0.9em;"><em>No sensitive data patterns detected.</em> Profile names, vault names, and character names were still partially masked as a precaution.</p>';

            await callGenericPopup(
                `<div class="dle-diag-done">
                    <h3>2 files downloaded</h3>
                    <p><strong><code>dle-diagnostics-*.md</code></strong> — Anonymized report, safe to share on GitHub issues.
                    Drop it into a flagship LLM (Claude, GPT-5, Gemini) for self-diagnosis.</p>
                    <p><strong><code>dle-connections-reference-*.md</code></strong> — Your real connection data (profile names,
                    URLs, models). <strong>Do NOT share this file.</strong> It's for your own reference when reading the anonymized report.</p>
                    ${statsHtml}
                    <p><strong>Please verify the diagnostic file before sharing.</strong>
                    The format is plain markdown around a base64 blob — any LLM can audit it:</p>
                    <p><em>"Decode the base64 blob in this DLE diagnostic report and tell me
                    everything personally identifiable that's still in it."</em></p>
                    <p>If you find anything we missed, that's a bug — please open an issue.</p>
                    <p style="margin-top: 14px;">
                        <a href="https://github.com/pixelnull/sillytavern-DeepLore/issues/new"
                           target="_blank" rel="noopener noreferrer"
                           class="menu_button menu_button_icon">
                            <i class="fa-solid fa-up-right-from-square"></i>
                            <span>Open New Issue on GitHub</span>
                        </a>
                    </p>
                </div>`,
                POPUP_TYPE.TEXT, '', { wide: false, large: false, allowVerticalScrolling: true }
            );
        } catch (err) {
            console.error('[DLE] Diagnostic export failed:', err);
            const msg = String(err?.message || '');
            const hint = msg.includes('CompressionStream') || msg.includes('CompressionStream')
                ? 'Your browser may not support gzip compression. Try a recent Chrome, Firefox, or Safari.'
                : msg.includes('SecurityError') || msg.includes('NotAllowed')
                    ? 'Browser blocked the file download. Check pop-up blocker or security settings.'
                    : 'Try /dle-diagnostics in chat instead, or check browser console (F12) for details.';
            try { toastr.error(`Diagnostic export failed. ${hint}`, 'DeepLore', { timeOut: 10000 }); } catch {}
        } finally {
            $btn.prop('disabled', false).removeClass('disabled');
            // Restore label after a beat so the user sees "Done" briefly.
            setTimeout(() => { try { $label.text(origLabel); } catch {} }, 4000);
        }
    });

    // Load icon.svg as inline SVG so currentColor works with themes.
    // Fills BOTH the About mascot and the header-strip brand mark.
    fetch(new URL('../../icon.svg', import.meta.url).href)
        .then(r => r.ok ? r.text() : '')
        .then(svg => {
            if (!svg) return;
            const mascot = $c('#dle-sp-mascot')[0];
            if (mascot) mascot.innerHTML = svg;
            const brand = $c('#dle-sp-brand-logo')[0];
            if (brand) brand.innerHTML = svg;
        })
        .catch(() => {});

    // Easter egg — companion character cards.
    $c('#dle-sp-mascot').on('click', async function () {
        const basePath = new URL('../../assets/companions/', import.meta.url).href;
        const companions = [
            { file: 'Kara-Emily-Gren-STChar.png', name: 'Kara Emily Gren', desc: 'Forensic researcher. Was. The boundary between study and practice became more a matter of preference.' },
            { file: 'Nott-STChar.png', name: 'Nott', desc: 'Norse goddess of night. Pale, tattooed, wrapped in black that drinks light rather than catching it.' },
            { file: 'Emma-STChar.png', name: 'Emma', desc: 'Your Librarian. Copper-red hair, hazel-green eyes, assessing whether what you just said is worth writing down.' },
        ];
        const rows = companions.map(c =>
            `<div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid var(--SmartThemeBorderColor);">
                <div style="flex:1;">
                    <strong>${escapeHtml(c.name)}</strong>
                    <div class="dle-text-xs dle-muted" style="margin-top:2px;">${escapeHtml(c.desc)}</div>
                </div>
                <a href="${basePath}${c.file}" download="${c.file}" class="menu_button menu_button_icon" style="text-decoration:none;white-space:nowrap;flex-shrink:0;">
                    <i class="fa-solid fa-download" aria-hidden="true"></i>
                </a>
            </div>`
        ).join('');
        await callGenericPopup(
            `<div style="text-align:center;margin-bottom:12px;">
                <h3 style="margin:0 0 4px;">The Companions</h3>
                <span class="dle-text-xs dle-muted">SillyTavern character cards — import them and say hello.</span>
            </div>
            <div>${rows}</div>`,
            POPUP_TYPE.TEXT, '', { wide: false, large: false, allowVerticalScrolling: true }
        );
    });

    $c('#dle-sp-scan-vaults').on('click', async function () {
        const $btn = $(this);
        if ($btn.prop('disabled')) return;
        $btn.prop('disabled', true).addClass('disabled');
        try {
            const { openVaultScanPopup } = await import('./vault-scan-popup.js');
            const first = (settings.vaults || []).find(v => v.enabled) || (settings.vaults || [])[0] || {};
            const picked = await openVaultScanPopup({
                host: first.host || '127.0.0.1',
                apiKey: first.apiKey || '',
                portCenter: first.port || 27124,
                radius: 25,
            });
            if (picked) {
                settings.vaults = settings.vaults || [];
                settings.vaults.push({
                    name: picked.vaultName || `Vault ${picked.port}`,
                    host: picked.host,
                    port: picked.port,
                    apiKey: first.apiKey || '',
                    https: picked.scheme === 'https',
                    enabled: true,
                });
                saveSettingsDebounced();
                bindVaultListEvents(settings, $c('#dle-sp-vault-list'), $c('#dle-sp-add-vault'));
                toastr.success(`Added ${picked.vaultName} (${picked.host}:${picked.port}) — fill in the API key if needed.`, 'DeepLore');
            }
        } catch (err) {
            console.error('[DLE] Vault scan error:', err);
            toastr.error('Vault scan didn\'t find anything. Make sure Obsidian is running.', 'DeepLore');
        } finally {
            $btn.prop('disabled', false).removeClass('disabled');
        }
    });

    $c('#dle-sp-test-connection').on('click', async function () {
        const $btn = $(this);
        if ($btn.prop('disabled')) return;
        $btn.prop('disabled', true).addClass('disabled');
        const statusEl = $c('#dle-sp-connection-status');
        statusEl.text('Testing...').removeClass('success failure');
        try {
            const enabledVaults = (settings.vaults || []).filter(v => v.enabled);
            if (enabledVaults.length === 0) throw new Error('No enabled vaults configured.');
            const results = [];
            for (const vault of enabledVaults) {
                try {
                    const data = await testConnection(vault.host, vault.port, vault.apiKey, !!vault.https);
                    results.push({ name: vault.name, ok: data.ok, auth: data.authenticated, error: data.error, certError: data.certError });
                } catch (err) { results.push({ name: vault.name, ok: false, error: err.message }); }
            }
            const allOk = results.every(r => r.ok);
            const summary = results.map(r => `${r.name}: ${r.ok ? (r.auth ? 'OK' : 'OK (no auth)') : 'FAIL'}`).join(', ');
            statusEl.text(summary).toggleClass('success', allOk).toggleClass('failure', !allOk);
        } catch (err) { statusEl.text(`Error: ${err.message}`).addClass('failure').removeClass('success'); }
        finally { $btn.prop('disabled', false).removeClass('disabled'); }
    });

    $c('#dle-sp-tag').on('input', function () { settings.lorebookTag = String($(this).val()).trim() || 'lorebook'; saveSettingsDebounced(); debouncedRebuild(); });
    $c('#dle-sp-constant-tag').on('input', function () { settings.constantTag = String($(this).val()).trim() || 'lorebook-always'; saveSettingsDebounced(); debouncedRebuild(); });
    $c('#dle-sp-never-insert-tag').on('input', function () { settings.neverInsertTag = String($(this).val()).trim() || 'lorebook-never'; saveSettingsDebounced(); debouncedRebuild(); });
    $c('#dle-sp-seed-tag').on('input', function () { settings.seedTag = String($(this).val()).trim() || 'lorebook-seed'; saveSettingsDebounced(); debouncedRebuild(); });
    $c('#dle-sp-bootstrap-tag').on('input', function () { settings.bootstrapTag = String($(this).val()).trim() || 'lorebook-bootstrap'; saveSettingsDebounced(); debouncedRebuild(); });
    $c('#dle-sp-librarian-guide-tag').on('input', function () { settings.librarianGuideTag = String($(this).val()).trim() || 'lorebook-guide'; saveSettingsDebounced(); debouncedRebuild(); });
    $c('#dle-sp-new-chat-threshold').on('input', function () { settings.newChatThreshold = numVal($(this).val(), 3); saveSettingsDebounced(); });

    // ── Matching ──
    let _syncingSearchMode = false;
    $c('#dle-sp-search-mode').on('change', function () {
        if (_syncingSearchMode) return;
        _syncingSearchMode = true;
        const mode = $(this).val();
        settings.aiSearchEnabled = mode !== 'keywords-only';
        settings.aiSearchMode = mode === 'ai-only' ? 'ai-only' : 'two-stage';
        saveSettingsDebounced();
        updatePopupModeVisibility($container, settings);
        _syncingSearchMode = false;
    });
    $c('#dle-sp-scan-depth').on('input', function () { settings.scanDepth = numVal($(this).val(), 4); saveSettingsDebounced(); });
    $c('#dle-sp-char-context-scan').on('change', function () { settings.characterContextScan = $(this).is(':checked'); saveSettingsDebounced(); });
    $c('#dle-sp-fuzzy-search').on('change', function () { settings.fuzzySearchEnabled = $(this).is(':checked'); $c('#dle-sp-fuzzy-min-score-row').toggle(settings.fuzzySearchEnabled); saveSettingsDebounced(); buildIndexWithReuse(); });
    $c('#dle-sp-fuzzy-min-score').on('input', function () {
        const v = parseFloat($(this).val());
        settings.fuzzySearchMinScore = v;
        $c('#dle-sp-fuzzy-min-score-value').text(v.toFixed(1));
        saveSettingsDebounced();
        runFuzzyPreview();
    });
    $c('#dle-sp-unlimited-entries').on('change', function () { settings.unlimitedEntries = $(this).prop('checked'); setRowDisabled($c('#dle-sp-max-entries'), settings.unlimitedEntries); $c('#dle-sp-unlimited-entries-warn').toggle(settings.unlimitedEntries); saveSettingsDebounced(); });
    $c('#dle-sp-max-entries').on('input', function () { settings.maxEntries = numVal($(this).val(), 10); saveSettingsDebounced(); });
    $c('#dle-sp-unlimited-budget').on('change', function () { settings.unlimitedBudget = $(this).prop('checked'); setRowDisabled($c('#dle-sp-token-budget'), settings.unlimitedBudget); $c('#dle-sp-unlimited-budget-warn').toggle(settings.unlimitedBudget); saveSettingsDebounced(); });
    $c('#dle-sp-token-budget').on('input', function () { settings.maxTokensBudget = numVal($(this).val(), 3072); saveSettingsDebounced(); });
    $c('#dle-sp-optimize-keys-mode').on('change', function () { settings.optimizeKeysMode = String($(this).val()); saveSettingsDebounced(); });
    $c('#dle-sp-case-sensitive').on('change', function () { settings.caseSensitive = $(this).prop('checked'); saveSettingsDebounced(); });
    $c('#dle-sp-match-whole-words').on('change', function () { settings.matchWholeWords = $(this).prop('checked'); saveSettingsDebounced(); });
    $c('#dle-sp-recursive-scan').on('change', function () { settings.recursiveScan = $(this).prop('checked'); setRowDisabled($c('#dle-sp-max-recursion'), !settings.recursiveScan); saveSettingsDebounced(); });
    $c('#dle-sp-max-recursion').on('input', function () { settings.maxRecursionSteps = numVal($(this).val(), 3); saveSettingsDebounced(); });
    $c('#dle-sp-reinjection-cooldown').on('input', function () { settings.reinjectionCooldown = numVal($(this).val(), 0); saveSettingsDebounced(); });
    $c('#dle-sp-strip-dedup').on('change', function () { settings.stripDuplicateInjections = $(this).prop('checked'); setRowDisabled($c('#dle-sp-strip-lookback'), !settings.stripDuplicateInjections); saveSettingsDebounced(); });
    $c('#dle-sp-strip-lookback').on('input', function () { settings.stripLookbackDepth = numVal($(this).val(), 2); saveSettingsDebounced(); });
    $c('#dle-sp-keyword-occurrence-weighting').on('change', function () { settings.keywordOccurrenceWeighting = $(this).prop('checked'); saveSettingsDebounced(); });
    $c('#dle-sp-priority-reversed').on('change', function () { settings.priorityReversed = $(this).prop('checked'); saveSettingsDebounced(); });
    $c('#dle-sp-import-compress-default').on('change', function () { settings.importCompressByDefault = $(this).prop('checked'); saveSettingsDebounced(); });
    $c('#dle-sp-wi-import-em-handling').on('change', function () {
        const v = String($(this).val());
        settings.wiImportEmHandling = v === 'skip' ? 'skip' : 'append';
        saveSettingsDebounced();
    });
    $c('#dle-sp-contextual-gating-tolerance').on('change', function () { settings.contextualGatingTolerance = String($(this).val()); saveSettingsDebounced(); });

    // ── Injection tab ──
    $c('input[name="dle-sp-injection-mode"]').on('change', function () {
        const oldMode = settings.injectionMode;
        settings.injectionMode = String($(this).val());
        // H16: clean up stale PM entries when switching out of prompt_list mode.
        if (oldMode === 'prompt_list' && settings.injectionMode !== 'prompt_list') {
            if (promptManager) {
                drainPendingPromptListCleanup();
            } else {
                // BUG-341: PM not ready — queue cleanup for next time it's available.
                settings._pendingPromptListCleanup = true;
            }
        }
        updatePopupInjectionModeVisibility($container, settings);
        saveSettingsDebounced();
    });

    function wirePositionSelect(selectId, depthId, roleId, posKey, depthKey, roleKey) {
        $c(selectId).on('change', function () {
            settings[posKey] = Number($(this).val());
            $(this).closest('.dle-injection-row').find('.dle-injection-inchat-controls').toggle(settings[posKey] === 1);
            saveSettingsDebounced();
        });
        $c(depthId).on('input', function () { settings[depthKey] = numVal($(this).val(), 4); saveSettingsDebounced(); });
        $c(roleId).on('change', function () { settings[roleKey] = numVal($(this).val(), 0); saveSettingsDebounced(); });
    }
    wirePositionSelect('#dle-sp-position', '#dle-sp-depth', '#dle-sp-role', 'injectionPosition', 'injectionDepth', 'injectionRole');
    wirePositionSelect('#dle-sp-notebook-position', '#dle-sp-notebook-depth', '#dle-sp-notebook-role', 'notebookPosition', 'notebookDepth', 'notebookRole');
    wirePositionSelect('#dle-sp-ai-notepad-position', '#dle-sp-ai-notepad-depth', '#dle-sp-ai-notepad-role', 'aiNotepadPosition', 'aiNotepadDepth', 'aiNotepadRole');

    $c('#dle-sp-template').on('input', function () { settings.injectionTemplate = String($(this).val()); saveSettingsDebounced(); });
    $c('#dle-sp-allow-wi-scan').on('change', function () { settings.allowWIScan = $(this).prop('checked'); saveSettingsDebounced(); });

    // BUG-320: cross-tab links with target scroll/highlight. Old two-tier
    // data-goto-tab/data-goto-subtab pairs resolve through the alias map.
    // Nav fns come from the dleNav bridge — this runs in bindPopupEvents scope.
    $container.on('click', '.dle-goto-tab-link', function (e) {
        e.preventDefault();
        const nav = $container.data('dleNav');
        if (!nav) return;
        const token = nav.resolveTabToken($(this).data('goto-tab'), $(this).data('goto-subtab'));
        const targetId = $(this).data('goto-target');

        const $targetTab = $container.find(`.dle-settings-tab[data-settings-tab="${token}"]`);
        if ($targetTab.length) nav.switchSettingsTab($targetTab);

        if (targetId) {
            requestAnimationFrame(() => {
                const el = $container.find(`#${targetId}`)[0] || $container.find(`[data-setting-id="${targetId}"]`)[0];
                if (el) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    el.classList.add('dle-pulse');
                    setTimeout(() => el.classList.remove('dle-pulse'), 2000);
                }
            });
        }
    });

    // ── AI Connections accordion ──
    bindAccordionEvents($container);

    // ── AI Search ──
    $c('#dle-sp-ai-scan-depth').on('input', function () { settings.aiSearchScanDepth = numVal($(this).val(), 4); saveSettingsDebounced(); });
    $c('#dle-sp-ai-system-prompt').on('input', function () { settings.aiSearchSystemPrompt = String($(this).val()); saveSettingsDebounced(); });
    $c('#dle-sp-ai-summary-length').on('input', function () { settings.aiSearchManifestSummaryLength = numVal($(this).val(), 600); saveSettingsDebounced(); });
    $c('#dle-sp-ai-manifest-fields').on('input', function () {
        const raw = String($(this).val() || '');
        settings.aiManifestIncludeFields = raw.split(',').map(s => s.trim()).filter(Boolean);
        saveSettingsDebounced();
    });
    $c('#dle-sp-response-prefill-mode').on('change', function () { settings.responsePrefillMode = String($(this).val()); saveSettingsDebounced(); });
    $c('#dle-sp-response-prefill-seed').on('input', function () { settings.responsePrefillSeed = String($(this).val()); saveSettingsDebounced(); });
    $c('#dle-sp-ai-claude-prefix').on('change', function () { settings.aiSearchClaudeCodePrefix = $(this).prop('checked'); saveSettingsDebounced(); });
    $c('#dle-sp-ai-force-user-role').on('change', function () { settings.aiForceUserRole = $(this).prop('checked'); saveSettingsDebounced(); });
    $c('#dle-sp-scribe-informed-retrieval').on('change', function () { settings.scribeInformedRetrieval = $(this).prop('checked'); saveSettingsDebounced(); });
    $c('#dle-sp-ai-confidence-threshold').on('change', function () { settings.aiConfidenceThreshold = String($(this).val()); saveSettingsDebounced(); });
    $c('#dle-sp-hierarchical-prefilter').on('change', function () { settings.hierarchicalPreFilter = $(this).prop('checked'); $c('#dle-sp-hierarchical-options').toggle(settings.hierarchicalPreFilter); saveSettingsDebounced(); });
    $c('#dle-sp-hierarchical-aggressiveness').on('input', function () { const v = parseFloat($(this).val()); settings.hierarchicalAggressiveness = v; $c('#dle-sp-hierarchical-value').text(v.toFixed(1)); saveSettingsDebounced(); });
    $c('#dle-sp-manifest-summary-mode').on('change', function () { settings.manifestSummaryMode = String($(this).val()); saveSettingsDebounced(); });
    $c('#dle-sp-ai-error-fallback').on('change', function () { settings.aiErrorFallback = String($(this).val()); saveSettingsDebounced(); });
    $c('#dle-sp-ai-empty-fallback').on('change', function () { settings.aiEmptyFallback = String($(this).val()); saveSettingsDebounced(); });
    $c('#dle-sp-show-sources').on('change', function () { settings.showLoreSources = $(this).prop('checked'); saveSettingsDebounced(); });
    $c('#dle-sp-decay-enabled').on('change', function () { settings.decayEnabled = $(this).prop('checked'); saveSettingsDebounced(); $c('#dle-sp-decay-controls').toggleClass('dle-dimmed', !settings.decayEnabled); $c('#dle-sp-decay-controls input').prop('disabled', !settings.decayEnabled); });
    $c('#dle-sp-decay-boost-threshold').on('input', function () { settings.decayBoostThreshold = numVal($(this).val(), 5); saveSettingsDebounced(); });
    $c('#dle-sp-decay-penalty-threshold').on('input', function () { settings.decayPenaltyThreshold = numVal($(this).val(), 2); saveSettingsDebounced(); });

    // ── Graph settings ──
    $c('#dle-sp-graph-color-mode').on('change', function () { settings.graphDefaultColorMode = String($(this).val()); saveSettingsDebounced(); });
    $c('#dle-sp-graph-hover-dim-distance').on('input', function () { settings.graphHoverDimDistance = numVal($(this).val(), 2); saveSettingsDebounced(); });
    // BUG-L4: fallback matches default (2)
    $c('#dle-sp-graph-focus-tree-depth').on('input', function () { settings.graphFocusTreeDepth = numVal($(this).val(), 2); saveSettingsDebounced(); });
    $c('#dle-sp-graph-show-labels').on('change', function () { settings.graphShowLabels = $(this).prop('checked'); saveSettingsDebounced(); });
    $c('#dle-sp-graph-repulsion').on('input', function () { const v = parseFloat($(this).val()); settings.graphRepulsion = isNaN(v) ? 0.3 : v; saveSettingsDebounced(); });
    $c('#dle-sp-graph-gravity').on('input', function () { const v = parseFloat($(this).val()); settings.graphGravity = isNaN(v) ? 11.0 : v; saveSettingsDebounced(); });
    $c('#dle-sp-graph-damping').on('input', function () { const v = parseFloat($(this).val()); settings.graphDamping = isNaN(v) ? 0.50 : v; saveSettingsDebounced(); });
    // BUG-AUDIT-14: isNaN check instead of || so 0 is valid.
    // Audit S1-04: previous fallback 0.9 exceeded the constraint max 0.85 — use the actual default.
    $c('#dle-sp-graph-hover-falloff').on('input', function () { const v = parseFloat($(this).val()); settings.graphHoverFalloff = isNaN(v) ? 0.55 : v; saveSettingsDebounced(); });
    $c('#dle-sp-graph-edge-filter-alpha').on('input', function () { settings.graphEdgeFilterAlpha = parseFloat($(this).val()) || 0.05; saveSettingsDebounced(); });

    // ── Librarian settings ──
    $c('#dle-sp-librarian-tour').on('click', function () {
        import('../librarian/librarian-review.js')
            .then(m => m.openLibrarianPopup(null, { mode: 'guide-adhoc' }))
            .catch(err => console.warn('[DLE] Library Tour open failed:', err));
    });
    $c('#dle-sp-librarian-enabled').on('change', function () {
        const enabled = $(this).prop('checked');
        settings.librarianEnabled = enabled;
        $c('#dle-sp-librarian-sub').toggle(enabled);
        saveSettingsDebounced();
        if (enabled) {
            const config = resolveConnectionConfig('librarian');
            const missingProfile = config.mode === 'profile' && !config.profileId;
            const missingDirect = config.mode === 'direct' && (!config.apiUrl || !config.model);
            if (missingProfile || missingDirect) {
                toastr.warning(
                    missingDirect
                        ? 'Librarian is set to Direct API but is missing an API URL or model. Opening settings...'
                        : 'Librarian needs an AI connection profile. Opening settings...',
                    'DeepLore', { timeOut: 6000 });
                requestAnimationFrame(() => {
                    const nav = $container.data('dleNav');
                    const $tab = $container.find('.dle-settings-tab[data-settings-tab="ai-connections"]');
                    if ($tab.length && nav) nav.switchSettingsTab($tab);
                    requestAnimationFrame(() => {
                        const el = $container.find('[data-tool-key="librarian"]')[0];
                        if (el) {
                            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            el.classList.add('dle-pulse');
                            setTimeout(() => el.classList.remove('dle-pulse'), 2000);
                        }
                    });
                });
            }
            toastr.info('Librarian requires "Enable function calling" in SillyTavern\'s AI Response Configuration.', 'DeepLore', { timeOut: 8000 });
        }
        // One-time: unregister stale ToolManager tools left by pre-agentic-loop versions.
        if (!enabled) {
            import('../../../../../../scripts/tool-calling.js')
                .then(({ ToolManager }) => {
                    if (ToolManager?.unregisterFunctionTool) {
                        ToolManager.unregisterFunctionTool('dle_search_lore');
                        ToolManager.unregisterFunctionTool('dle_flag_lore');
                    }
                })
                .catch(() => { /* tools may not exist — safe to ignore */ });
        }
        import('../librarian/visibility.js').then(m => m.applyLibrarianVisibility(enabled)).catch(err => console.warn('[DLE] Librarian visibility error:', err));
    });
    $c('#dle-sp-librarian-search').on('change', async function () {
        const wasEnabled = !!settings.librarianSearchEnabled;
        const nowEnabled = $(this).prop('checked');
        settings.librarianSearchEnabled = nowEnabled;
        saveSettingsDebounced();
        // BUG-373: rebuild BM25 on false→true flip (was cleared to null when disabled).
        if (!wasEnabled && nowEnabled) {
            try {
                const state = await import('../state.js');
                const { buildBM25Index } = await import('../vault/bm25.js');
                if (state.vaultIndex && state.vaultIndex.length) {
                    state.setFuzzySearchIndex(buildBM25Index(state.vaultIndex));
                }
            } catch (err) {
                console.warn('[DLE] BM25 rebuild on enable failed:', err);
                // The toggle lied — Librarian search is enabled but fuzzy index is null.
                // Surface so the user knows they must refresh.
                try {
                    toastr.warning(
                        `Librarian search enabled, but fuzzy-index rebuild failed: ${err?.message || 'unknown error'}. Run /dle-refresh.`,
                        'DeepLore',
                        { timeOut: 10000 },
                    );
                } catch { /* toastr unavailable */ }
            }
        }
    });
    $c('#dle-sp-librarian-flag').on('change', function () { settings.librarianFlagEnabled = $(this).prop('checked'); saveSettingsDebounced(); });
    $c('#dle-sp-librarian-show-tool-calls').on('change', function () { settings.librarianShowToolCalls = $(this).prop('checked'); saveSettingsDebounced(); });
    $c('#dle-sp-librarian-per-message').on('change', function () { settings.librarianPerMessageActivity = $(this).prop('checked'); saveSettingsDebounced(); });
    $c('#dle-sp-librarian-max-searches').on('input', function () { settings.librarianMaxSearches = numVal($(this).val(), 2); saveSettingsDebounced(); });
    $c('#dle-sp-librarian-max-results').on('input', function () { settings.librarianMaxResults = numVal($(this).val(), 5); saveSettingsDebounced(); });
    $c('#dle-sp-librarian-token-budget').on('input', function () { settings.librarianResultTokenBudget = numVal($(this).val(), 1500); saveSettingsDebounced(); });
    $c('#dle-sp-librarian-write-folder').on('input', function () { settings.librarianWriteFolder = $(this).val().trim(); saveSettingsDebounced(); });
    $c('#dle-sp-librarian-write-vault').on('change', function () { settings.librarianWriteVaultId = String($(this).val() || ''); saveSettingsDebounced(); });
    $c('#dle-sp-librarian-auto-send').on('change', function () { settings.librarianAutoSendOnGap = $(this).prop('checked'); saveSettingsDebounced(); });
    $c('#dle-sp-librarian-manifest-max').on('input', function () { settings.librarianManifestMaxChars = numVal($(this).val(), 8000); saveSettingsDebounced(); });
    $c('#dle-sp-librarian-related-max').on('input', function () { settings.librarianRelatedEntriesMaxChars = numVal($(this).val(), 4000); saveSettingsDebounced(); });
    $c('#dle-sp-librarian-chat-context-max').on('input', function () { settings.librarianChatContextMaxChars = numVal($(this).val(), 4000); saveSettingsDebounced(); });
    $c('#dle-sp-librarian-draft-max').on('input', function () { settings.librarianDraftMaxChars = numVal($(this).val(), 4000); saveSettingsDebounced(); });
    $c('#dle-sp-librarian-max-tool-calls-per-turn').on('input', function () {
        settings.librarianMaxToolCallsPerTurn = Math.max(1, Math.min(50, numVal($(this).val(), 10)));
        saveSettingsDebounced();
    });
    $c('#dle-sp-librarian-max-validation-retries').on('input', function () {
        settings.librarianMaxValidationRetries = Math.max(0, Math.min(10, numVal($(this).val(), 3)));
        saveSettingsDebounced();
    });
    $c('#dle-sp-librarian-session-history').on('input', function () {
        settings.librarianSessionHistoryMessages = Math.max(5, Math.min(100, numVal($(this).val(), 10)));
        saveSettingsDebounced();
    });
    $c('#dle-sp-librarian-agentic-history').on('input', function () {
        settings.librarianAgenticHistoryMessages = Math.max(10, Math.min(200, numVal($(this).val(), 40)));
        saveSettingsDebounced();
    });
    $c('#dle-sp-librarian-session-tool-cap').on('input', function () {
        const raw = String($(this).val()).trim();
        if (raw === '') { settings.librarianSessionToolCallCap = null; }
        else {
            const n = Math.max(0, Math.min(1000, Number(raw)));
            settings.librarianSessionToolCallCap = Number.isFinite(n) ? n : null;
        }
        saveSettingsDebounced();
    });
    $c('input[name="dle-sp-librarian-prompt-mode"]').on('change', function () {
        settings.librarianSystemPromptMode = $(this).val();
        $c('#dle-sp-librarian-custom-prompt').toggle(settings.librarianSystemPromptMode !== 'default');
        saveSettingsDebounced();
    });
    $c('#dle-sp-librarian-custom-prompt').on('input', function () { settings.librarianCustomSystemPrompt = $(this).val(); saveSettingsDebounced(); });

    // M6 (2026-05-22): per-popup AbortController for the Test Connection button.
    // Second click while a probe is in flight CANCELS instead of being ignored.
    let _testAiAbortCtrl = null;
    $c('#dle-sp-test-ai').on('click', async function () {
        const $btn = $(this);
        // Second click while in-flight = cancel.
        if (_testAiAbortCtrl) {
            try { abortWith(_testAiAbortCtrl, 'settings:test_ai_cancel'); } catch { /* noop */ }
            _testAiAbortCtrl = null;
            return;
        }
        _testAiAbortCtrl = new AbortController();
        const ctrl = _testAiAbortCtrl;
        $btn.addClass('dle-testing');
        const statusEl = $c('#dle-sp-ai-status');
        statusEl.text('Testing... (click again to cancel)').removeClass('success failure');
        try {
            if (settings.aiSearchConnectionMode === 'profile') {
                if (!settings.aiSearchProfileId) throw new Error('No connection profile selected');
                await callViaProfile('You are a test assistant. Respond with exactly: {"ok": true}', 'Test. Respond: {"ok": true}', 64, settings.aiSearchTimeout);
                const m = getProfileModelHint(); statusEl.text(`Connected${m ? ' (' + m + ')' : ''}`).addClass('success').removeClass('failure');
            } else if (settings.aiSearchConnectionMode === 'direct') {
                if (!settings.aiSearchApiUrl) throw new Error('Direct API mode requires an API URL');
                if (!settings.aiSearchModel) throw new Error('Direct API mode requires a model name');
                const data = await testDirectConnection({
                    apiUrl: settings.aiSearchApiUrl,
                    apiKey: settings.aiSearchApiKey,
                    model: settings.aiSearchModel,
                    format: settings.aiSearchApiFormat,
                    viaCorsProxy: settings.aiSearchApiViaCorsProxy,
                    timeout: settings.aiSearchTimeout,
                    signal: ctrl.signal,
                });
                if (data.aborted) { statusEl.text('Cancelled').removeClass('success failure'); }
                else { statusEl.text(data.ok ? `Connected (${settings.aiSearchModel})` : `Failed: ${data.error}`).toggleClass('success', data.ok).toggleClass('failure', !data.ok); }
            } else {
                if (!settings.aiSearchModel) throw new Error('Proxy mode requires a model name');
                const data = await testProxyConnection(settings.aiSearchProxyUrl, settings.aiSearchModel, ctrl.signal);
                if (data.aborted) { statusEl.text('Cancelled').removeClass('success failure'); }
                else { statusEl.text(data.ok ? 'Connected' : `Failed: ${data.error}`).toggleClass('success', data.ok).toggleClass('failure', !data.ok); }
            }
        } catch (err) {
            if (ctrl.signal.aborted || err?.userAborted) { statusEl.text('Cancelled').removeClass('success failure'); }
            else { statusEl.text(`Error: ${err.message}`).addClass('failure').removeClass('success'); }
        }
        finally { if (_testAiAbortCtrl === ctrl) _testAiAbortCtrl = null; $btn.removeClass('dle-testing'); }
    });

    $c('#dle-sp-preview-ai').on('click', async function () {
        if (!chat || chat.length === 0) { toastr.info('No active chat.', 'DeepLore'); return; }
        await ensureIndexFresh();
        if (vaultIndex.length === 0) { toastr.info('No entries indexed.', 'DeepLore'); return; }
        let candidateManifest, candidateHeader, modeLabel;
        if (settings.aiSearchMode === 'ai-only') { const r = buildCandidateManifest(vaultIndex); candidateManifest = r.manifest; candidateHeader = r.header; modeLabel = 'AI-only (full vault)'; }
        else { const kr = matchEntries(chat); const nc = kr.matched.filter(e => !e.constant); if (nc.length === 0) { toastr.warning('No entries matched the current chat. Try /dle-simulate for details.', 'DeepLore'); return; } const r = buildCandidateManifest(kr.matched); candidateManifest = r.manifest; candidateHeader = r.header; modeLabel = `Two-stage (${nc.length} candidates)`; }
        const chatContext = buildAiChatContext(chat, settings.aiSearchScanDepth);
        const maxE = settings.unlimitedEntries ? 'as many as are relevant' : String(settings.maxEntries);
        // Preview-only AI search prompt (Settings popup). Same fallback chain
        // as the live path in src/ai/ai.js — user override → vault override
        // → compiled-in EN dict.
        let sp = resolvePromptOrOverride('AI_SEARCH_SYSTEM_PROMPT', settings.aiSearchSystemPrompt);
        if (settings.aiSearchClaudeCodePrefix && settings.aiSearchConnectionMode === 'proxy' && !sp.startsWith('You are Claude Code')) sp = 'You are Claude Code. ' + sp;
        sp = sp.replace(/\{\{maxEntries\}\}/g, maxE);
        const hdr = candidateHeader ? `## Manifest Info\n${candidateHeader}\n\n` : '';
        const um = `${hdr}## Recent Chat\n${chatContext}\n\n## Candidate Lore Entries\n${candidateManifest}\n\nSelect the relevant entries as a JSON array.`;
        callGenericPopup(`<div class="dle-popup"><h3>Mode: ${escapeHtml(modeLabel)}</h3><h3>System Prompt</h3><div class="dle-preview dle-preview--short" style="margin-bottom:15px">${escapeHtml(sp)}</div><h3>User Message</h3><div class="dle-preview dle-preview--tall">${escapeHtml(um)}</div></div>`, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true });
    });

    // ── Features — Notebook ──
    $c('#dle-sp-notebook-enabled').on('change', function () {
        settings.notebookEnabled = $(this).prop('checked'); saveSettingsDebounced();
    });
    $c('#dle-sp-open-notebook').on('click', function () { if (!settings.notebookEnabled) { toastr.warning('Enable the Author Notebook checkbox above to use this feature.', 'DeepLore'); return; } showNotebookPopup(); });

    // ── Features — AI Notebook ──
    $c('#dle-sp-ai-notepad-enabled').on('change', function () {
        settings.aiNotepadEnabled = $(this).prop('checked'); saveSettingsDebounced();
    });
    $c('#dle-sp-ai-notepad-prompt').on('input', function () { settings.aiNotepadPrompt = $(this).val(); saveSettingsDebounced(); });
    $c('#dle-sp-ai-notepad-extract-prompt').on('input', function () { settings.aiNotepadExtractPrompt = $(this).val(); saveSettingsDebounced(); });
    $c('#dle-sp-ai-notepad-max-entries').on('input', function () {
        const raw = String($(this).val()).trim();
        // Empty input → fall back to default 50 instead of silently storing 0
        // (Number('') === 0). 0 is still allowed as an explicit "no limit" choice.
        const n = raw === '' ? 50 : Math.max(0, Math.min(1000, numVal(raw, 50)));
        settings.aiNotepadMaxEntries = n; saveSettingsDebounced();
    });
    $c('#dle-sp-ai-notepad-fuzzy-threshold').on('input', function () {
        const raw = String($(this).val()).trim();
        let v = raw === '' ? 0.85 : Number(raw);
        // Refuse non-positive / non-finite values — threshold 0 would merge
        // everything on Deduplicate click. Lower bound 0.1 prevents accidental data-wipe.
        if (!Number.isFinite(v) || v <= 0) v = 0.85;
        v = Math.max(0.1, Math.min(1, v));
        settings.aiNotepadFuzzyDedupThreshold = v; saveSettingsDebounced();
    });
    $c('input[name="dle-sp-ai-notepad-mode"]').on('change', function () {
        settings.aiNotepadMode = $(this).val(); saveSettingsDebounced();
        const isTag = settings.aiNotepadMode === 'tag';
        $c('#dle-sp-ai-notepad-mode-tag-desc').toggle(isTag);
        $c('#dle-sp-ai-notepad-mode-extract-desc').toggle(!isTag);
        $c('#dle-sp-ai-notepad-tag-options').toggle(isTag);
        $c('#dle-sp-ai-notepad-extract-options').toggle(!isTag);
        // Tag mode never calls AI — hide its connection accordion.
        $c('.dle-conn-accordion[data-tool="aiNotepad"]').toggle(!isTag);
    });
    $c('#dle-sp-open-ai-notepad').on('click', function () { if (!settings.aiNotepadEnabled) { toastr.warning('Enable the AI Notepad checkbox above to use this feature.', 'DeepLore'); return; } showAiNotepadPopup(); });

    // ── Features — Scribe ──
    $c('#dle-sp-scribe-enabled').on('change', function () {
        settings.scribeEnabled = $(this).prop('checked'); saveSettingsDebounced();
        $c('#dle-sp-scribe-controls').find('input, textarea, select').prop('disabled', !settings.scribeEnabled);
        $c('#dle-sp-scribe-controls').find('.menu_button').toggleClass('disabled', !settings.scribeEnabled);
    });
    $c('#dle-sp-scribe-interval').on('input', function () { settings.scribeInterval = numVal($(this).val(), 5); saveSettingsDebounced(); });
    $c('#dle-sp-scribe-folder').on('input', function () { settings.scribeFolder = String($(this).val()).trim() || 'Sessions'; saveSettingsDebounced(); });
    $c('#dle-sp-scribe-write-vault').on('change', function () { settings.scribeWriteVaultId = String($(this).val() || ''); saveSettingsDebounced(); });
    $c('#dle-sp-scribe-prompt').on('input', function () { settings.scribePrompt = String($(this).val()); saveSettingsDebounced(); });
    $c('#dle-sp-scribe-scan-depth').on('input', function () { settings.scribeScanDepth = numVal($(this).val(), 20); saveSettingsDebounced(); });

    // ── Features — Auto Lorebook ──
    $c('#dle-sp-autosuggest-enabled').on('change', function () {
        settings.autoSuggestEnabled = $(this).prop('checked'); saveSettingsDebounced();
        $c('#dle-sp-autosuggest-controls').find('input, textarea, select').prop('disabled', !settings.autoSuggestEnabled);
    });
    $c('#dle-sp-autosuggest-interval').on('input', function () { settings.autoSuggestInterval = numVal($(this).val(), 10); saveSettingsDebounced(); });
    $c('#dle-sp-autosuggest-folder').on('input', function () { settings.autoSuggestFolder = String($(this).val()).trim(); saveSettingsDebounced(); });
    $c('#dle-sp-autosuggest-write-vault').on('change', function () { settings.autoSuggestWriteVaultId = String($(this).val() || ''); saveSettingsDebounced(); });
    $c('#dle-sp-autosuggest-skip-review').on('change', function () { settings.autoSuggestSkipReview = $(this).prop('checked'); saveSettingsDebounced(); });
    $c('#dle-sp-autosuggest-prompt').on('input', function () { settings.autoSuggestPrompt = String($(this).val()); saveSettingsDebounced(); });
    $c('#dle-sp-optimize-keys-prompt').on('input', function () { settings.optimizeKeysPrompt = String($(this).val()); saveSettingsDebounced(); });

    // ── System ──
    $c('#dle-sp-refresh').on('click', async function () {
        const $btn = $(this), $icon = $btn.find('i');
        // Wave I: hide the rotate glyph, show a goo-spinner while re-indexing.
        $btn.prop('disabled', true); $icon.hide(); $btn.append('<goo-spinner class="dle-btn-goo" size="22" color="currentColor" aria-hidden="true"></goo-spinner>');
        try { setVaultIndex([]); setIndexTimestamp(0); await buildIndex(); toastr.success(`Indexed ${vaultIndex.length} entries.`, 'DeepLore'); updatePopupIndexStats(); }
        catch (err) { console.warn('[DLE] Refresh index failed:', err); toastr.error('Couldn\'t refresh your lore. Check your Obsidian connection.', 'DeepLore'); }
        finally { $btn.prop('disabled', false); $btn.find('.dle-btn-goo').remove(); $icon.show(); }
    });
    $c('#dle-sp-browse-entries').on('click', () => showBrowsePopup());
    $c('#dle-sp-test-match').on('click', () => toastr.info('Use /dle-simulate in chat for a full match test.', 'DeepLore'));
    $c('#dle-sp-cache-ttl').on('input', function () { settings.cacheTTL = numVal($(this).val(), 300); saveSettingsDebounced(); });
    $c('#dle-sp-sync-interval').on('input', function () { settings.syncPollingInterval = numVal($(this).val(), 0); saveSettingsDebounced(); setupSyncPolling(buildIndexWithReuse, buildIndexWithReuse); });
    $c('#dle-sp-index-rebuild-trigger').on('change', function () {
        settings.indexRebuildTrigger = String($(this).val());
        $c('#dle-sp-rebuild-trigger-ttl-desc').toggle(settings.indexRebuildTrigger === 'ttl');
        $c('#dle-sp-rebuild-trigger-gen-desc').toggle(settings.indexRebuildTrigger === 'generation');
        $c('#dle-sp-rebuild-trigger-manual-desc').toggle(settings.indexRebuildTrigger === 'manual');
        $c('#dle-sp-rebuild-gen-interval-row').toggle(settings.indexRebuildTrigger === 'generation');
        saveSettingsDebounced();
    });
    $c('#dle-sp-rebuild-gen-interval').on('input', function () { settings.indexRebuildGenerationInterval = numVal($(this).val(), 10); saveSettingsDebounced(); });
    $c('#dle-sp-show-sync-toasts').on('change', function () { settings.showSyncToasts = $(this).prop('checked'); saveSettingsDebounced(); });
    $c('#dle-sp-review-tokens').on('input', function () { settings.reviewResponseTokens = numVal($(this).val(), 0); saveSettingsDebounced(); });
    $c('#dle-sp-debug').on('change', function () { settings.debugMode = $(this).prop('checked'); saveSettingsDebounced(); notifyDebugModeChanged(); });

    $c('#dle-sp-rerun-wizard').on('click', async function () {
        const { showSetupWizard } = await import('./setup-wizard.js');
        await showSetupWizard();
    });

    $c('#dle-sp-reset-defaults').on('click', async function () {
        const confirmed = await callGenericPopup(
            '<div style="text-align:center;"><p><strong>Reset all DeepLore settings to defaults?</strong></p><p>This cannot be undone. Your vault connections and AI connection profiles will be preserved.</p></div>',
            POPUP_TYPE.CONFIRM, '', { okButton: 'Reset', cancelButton: 'Cancel' },
        );
        if (!confirmed) return;

        // BUG-AUDIT-H21: preserve user-created data (promptPresets, analyticsData)
        // alongside connections — wiping them on "reset settings" would be data loss.
        const savedPromptPresets = JSON.parse(JSON.stringify(settings.promptPresets || {}));
        const savedAnalyticsData = JSON.parse(JSON.stringify(settings.analyticsData || {}));
        const savedVaults = JSON.parse(JSON.stringify(settings.vaults || []));
        const savedPort = settings.obsidianPort;
        const savedKey = settings.obsidianApiKey;
        // Direct API fields (ApiUrl/ApiKey/ApiFormat/ApiViaCorsProxy) ride along with
        // mode/profile/model — losing a pasted endpoint + key on a settings reset is
        // the same data loss as losing a profile binding.
        const savedConnections = {};
        for (const t of ['aiSearch', 'scribe', 'autoSuggest', 'librarian', 'aiNotepad', 'optimizeKeys']) {
            for (const suffix of ['ConnectionMode', 'ProfileId', 'ProxyUrl', 'Model', 'ApiUrl', 'ApiKey', 'ApiFormat', 'ApiViaCorsProxy']) {
                savedConnections[t + suffix] = settings[t + suffix];
            }
        }

        for (const [key, value] of Object.entries(defaultSettings)) {
            settings[key] = (typeof value === 'object' && value !== null)
                ? JSON.parse(JSON.stringify(value))
                : value;
        }

        settings.vaults = savedVaults;
        settings.promptPresets = savedPromptPresets;
        settings.analyticsData = savedAnalyticsData;
        settings.obsidianPort = savedPort;
        settings.obsidianApiKey = savedKey;
        settings._vaultsMigrated = true;
        Object.assign(settings, savedConnections);

        invalidateSettingsCache();
        saveSettingsDebounced();

        // Q10b — vault prompt overrides are user-owned files, not extension
        // settings. Settings reset leaves them untouched by default. If any
        // exist, offer a second confirm to also bulk-delete them through the
        // six-layer cage (mirrors the Prompts tab "Reset All Prompts" button).
        const connection = buildPromptsConnection(settings);
        if (connection) {
            try { await loadDlePrompts(settings.aiPromptLocale, connection); } catch { /* non-fatal */ }
            const overrideKeys = getDlePromptStatusGrid().filter(r => r.source === 'vault').map(r => r.key);
            if (overrideKeys.length > 0) {
                const alsoClear = await callGenericPopup(
                    `<div style="text-align:center;"><p><strong>Also delete ${overrideKeys.length} customized prompt file(s) from your vault?</strong></p><p>Prompt files live in your Obsidian vault, not extension settings, so they survive Reset All Settings. Delete them too?</p><p>Each delete will pass through the six-layer safety cage.</p></div>`,
                    POPUP_TYPE.CONFIRM, '', { okButton: 'Delete prompt files', cancelButton: 'Keep prompt files' },
                );
                if (alsoClear) {
                    const { deleted, failures } = await bulkDeletePromptsThroughCage(connection, overrideKeys);
                    try { await loadDlePrompts(settings.aiPromptLocale, connection); } catch { /* non-fatal */ }
                    if (failures.length === 0) {
                        toastr.success(`Deleted ${deleted} prompt file(s).`, 'DeepLore');
                    } else {
                        toastr.warning(`Deleted ${deleted}, ${failures.length} failed. Check console.`, 'DeepLore');
                        console.warn('[DLE prompts] reset-settings prompt cleanup failures:', failures);
                    }
                }
            }
        }

        loadPopupSettings($container);
        toastr.success('All settings reset to defaults. Connections preserved.', 'DeepLore');
    });

    // PR #28.1 — Settings-side Reset AI Breaker.
    $c('#dle-sp-reset-ai-breaker').on('click', async function () {
        const confirmed = await callGenericPopup(
            '<div style="text-align:center;"><p><strong>Reset AI breaker?</strong></p><p>Pending cooldown will be discarded. Next AI call attempts immediately.</p></div>',
            POPUP_TYPE.CONFIRM, '', { okButton: 'Reset', cancelButton: 'Cancel' },
        );
        if (!confirmed) return;
        const result = resetAiCircuitBreaker();
        if (result.wasOpen) {
            toastr.success(result.hadPendingCooldown ? 'AI breaker reset — pending cooldown discarded.' : 'AI breaker reset.', 'DeepLore');
        } else {
            toastr.info('AI breaker was already closed.', 'DeepLore');
        }
    });

    const clampMap = {
        'dle-sp-scan-depth': 'scanDepth', 'dle-sp-max-entries': 'maxEntries', 'dle-sp-token-budget': 'maxTokensBudget',
        'dle-sp-depth': 'injectionDepth', 'dle-sp-notebook-depth': 'notebookDepth', 'dle-sp-max-recursion': 'maxRecursionSteps',
        'dle-sp-cache-ttl': 'cacheTTL', 'dle-sp-review-tokens': 'reviewResponseTokens',
        'dle-sp-ai-max-tokens': 'aiSearchMaxTokens', 'dle-sp-ai-timeout': 'aiSearchTimeout',
        'dle-sp-ai-scan-depth': 'aiSearchScanDepth', 'dle-sp-ai-summary-length': 'aiSearchManifestSummaryLength',
        'dle-sp-scribe-interval': 'scribeInterval', 'dle-sp-scribe-max-tokens': 'scribeMaxTokens',
        'dle-sp-scribe-timeout': 'scribeTimeout', 'dle-sp-scribe-scan-depth': 'scribeScanDepth',
        'dle-sp-new-chat-threshold': 'newChatThreshold', 'dle-sp-sync-interval': 'syncPollingInterval',
        'dle-sp-reinjection-cooldown': 'reinjectionCooldown', 'dle-sp-strip-lookback': 'stripLookbackDepth',
        'dle-sp-autosuggest-interval': 'autoSuggestInterval', 'dle-sp-autosuggest-max-tokens': 'autoSuggestMaxTokens', 'dle-sp-autosuggest-timeout': 'autoSuggestTimeout',
        'dle-sp-decay-boost-threshold': 'decayBoostThreshold', 'dle-sp-decay-penalty-threshold': 'decayPenaltyThreshold',
        'dle-sp-graph-repulsion': 'graphRepulsion',
        'dle-sp-graph-gravity': 'graphGravity', 'dle-sp-graph-damping': 'graphDamping',
        'dle-sp-graph-hover-dim-distance': 'graphHoverDimDistance', 'dle-sp-graph-hover-falloff': 'graphHoverFalloff',
        'dle-sp-graph-focus-tree-depth': 'graphFocusTreeDepth', 'dle-sp-graph-edge-filter-alpha': 'graphEdgeFilterAlpha',
        'dle-sp-fuzzy-min-score': 'fuzzySearchMinScore', 'dle-sp-rebuild-gen-interval': 'indexRebuildGenerationInterval',
    };
    for (const [inputId, settingName] of Object.entries(clampMap)) {
        $c(`#${inputId}`).on('blur', function () {
            const constraints = settingsConstraints[settingName];
            if (!constraints) return;
            const val = Number($(this).val());
            if (Number.isNaN(val)) {
                $(this).val(constraints.min);
                settings[settingName] = constraints.min;
                saveSettingsDebounced();
                return;
            }
            const clamped = Math.max(constraints.min, Math.min(constraints.max, val));
            if (val !== clamped) { $(this).val(clamped); settings[settingName] = clamped; saveSettingsDebounced(); }
        });
    }
}

// Prompts tab — extracted to `src/ui/prompts-tab.js`. See that module for the
// language dropdown, folder path, Export / Reload / Reset-All buttons, the
// status grid, and the per-row action handlers.

// ── Load Settings UI (stub — extension panel is gutted) ──

// Track every state-observer unsubscriber so teardown can release them.
// Without this, re-init via the _dleInitialized guard accumulates duplicate handlers.
let _settingsUiUnsubs = [];

export function loadSettingsUI() {
    if (_settingsUiUnsubs.length > 0) teardownSettingsUI();

    const settings = getSettings();
    $('#dle-enabled').prop('checked', settings.enabled);
    updateStubStatus();

    _settingsUiUnsubs.push(onIndexUpdated(() => {
        updateStubStatus();
        setTimeout(() => {
            try {
                const health = runHealthCheck();
                setLastHealthResult(health);
            } catch { /* noop */ }
        }, 0);
    }));
    _settingsUiUnsubs.push(onAiStatsUpdated(() => updateStubStatus()));
    _settingsUiUnsubs.push(onCircuitStateChanged(() => { updateStubStatus(); updateHeaderBadge(); }));
    _settingsUiUnsubs.push(onClaudeAutoEffortChanged(() => {
        const $popup = $('#dle-settings-popup');
        if ($popup.length) refreshClaudeEffortBanner($popup);
    }));
}

function renderReferenceTab($container) {
    const $grid = $container.find('.dle-cmd-grid');
    if (!$grid.length) return;

    // Partition DLE_COMMANDS into columns by `sep` markers. First section gets a
    // generic label; the rest pick up the sep's `label`/`i18nKey` fields.
    const cols = [];
    let cur = { label: 'All Commands', i18nKey: 'dle_cmd_section_all', items: [] };
    for (const c of DLE_COMMANDS) {
        if (c.sep) {
            if (cur.items.length) cols.push(cur);
            cur = { label: c.label || 'Commands', i18nKey: c.i18nKey || '', items: [] };
        } else {
            cur.items.push(c);
        }
    }
    if (cur.items.length) cols.push(cur);

    // Each row/header carries data-i18n so ST's locale MutationObserver translates
    // it on DOM insert; the English `label`/`desc` is the in-place fallback.
    let html = '';
    for (const col of cols) {
        html += '<div class="dle-cmd-grid-col">';
        const headerI18n = col.i18nKey ? ` data-i18n="${escapeHtml(col.i18nKey)}"` : '';
        html += `<span class="dle-cmd-grid-header"${headerI18n}>${escapeHtml(col.label)}</span>`;
        for (const c of col.items) {
            const descI18n = c.i18nKey ? ` data-i18n="${escapeHtml(c.i18nKey)}"` : '';
            html += `<div class="dle-cmd-row dle-cmd-row-copyable" data-cmd="${escapeHtml(c.cmd)}" tabindex="0" role="button" title="Click to copy ${escapeHtml(c.cmd)}"><code>${escapeHtml(c.cmd)}</code><span${descI18n}>${escapeHtml(c.desc)}</span></div>`;
        }
        html += '</div>';
    }
    $grid.html(html);

    // Click / Enter / Space copies the command to clipboard.
    $grid.on('click keydown', '.dle-cmd-row-copyable', async function (e) {
        if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
        if (e.type === 'keydown') e.preventDefault();
        const cmd = $(this).data('cmd');
        if (!cmd) return;
        try {
            await navigator.clipboard.writeText(cmd);
            toastr.success(`Copied ${cmd}`, 'DeepLore', { timeOut: 1500 });
        } catch {
            // Clipboard API unavailable (insecure context) — fall back to selection.
            const range = document.createRange();
            range.selectNodeContents(this);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        }
    });
}

export function teardownSettingsUI() {
    for (const unsub of _settingsUiUnsubs) {
        try { unsub(); } catch { /* best-effort cleanup */ }
    }
    _settingsUiUnsubs = [];
}

function updateStubStatus() {
    const count = vaultIndex.length;
    const status = computeOverallStatus();
    const info = STATUS_DISPLAY[status];
    const el = document.getElementById('dle-stub-status');
    if (el) {
        el.textContent = count > 0
            ? `${count} entries | ${info.dot} ${info.label}`
            : (status === 'offline' ? `${info.dot} ${info.label}` : '');
    }
    updateHeaderBadge();
}

// ── Bind Settings Events (stub — extension panel is gutted) ──

export function bindSettingsEvents(buildIndexFn) {
    const settings = getSettings();

    $('#dle-enabled').on('change', function () {
        settings.enabled = $(this).prop('checked');
        saveSettingsDebounced();
        setupSyncPolling(buildIndexFn, buildIndexWithReuse);
    });

    $('#dle-open-settings').on('click', () => openSettingsPopup());
    $('#dle-open-settings').on('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSettingsPopup(); }
    });
}
