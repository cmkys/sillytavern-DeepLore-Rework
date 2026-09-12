/** DeepLore — First-Run Setup Wizard */
import { saveSettingsDebounced } from '../../../../../../script.js';
import { escapeHtml } from '../../../../../utils.js';
import { renderExtensionTemplateAsync } from '../../../../../extensions.js';
import { callGenericPopup, POPUP_TYPE, Popup } from '../../../../../popup.js';
import { getSettings, getPrimaryVault, invalidateSettingsCache } from '../../settings.js';
import { setIndexTimestamp } from '../state.js';
import { testConnection, writeNote, writeFieldDefinitions, buildConnectionGuidanceHtml } from '../vault/obsidian-api.js';
import { buildIndex } from '../vault/vault.js';
import { serializeFieldDefinitions, DEFAULT_FIELD_DEFINITIONS } from '../fields.js';
import { parseWorldInfoJson, importEntries } from '../vault/import.js';
import { applyHtmlI18n, trf, tr } from '../i18n/i18n.js';
import { EXTENSION_REF } from '../ext-path.js';

const TOTAL_PAGES = 9;

const PRESETS = {
    small:  { scanDepth: 4,  maxEntries: 10, budget: 2048 },
    medium: { scanDepth: 6,  maxEntries: 15, budget: 3072 },
    large:  { scanDepth: 8,  maxEntries: 20, budget: 4096 },
};

let currentPage = 1;
let connectionVerified = false;
let searchMode = 'keywords';
let importResult = null;
let $wizard = null;
// SKIP/RESUME: set true the moment the user reaches Finish (applyWizardSettings). Lets the
// close handler distinguish "completed" from "dismissed via X / Esc / Finish-later" so we
// only persist a skip sentinel in the dismissed case.
let wizardFinished = false;

const WIZARD_SKIP_LS_KEY = 'dle-wizard-skipped';
const WIZARD_LAST_STEP_LS_KEY = 'dle-wizard-last-step';

/**
 * Persist that the user dismissed the wizard before finishing, plus the page they were on,
 * so init() can suppress the auto-relaunch and a manual relaunch can resume in place.
 * Mirrors the dual-write (settings + localStorage) of `_wizardCompleted` (BUG-125) so a
 * settings-save crash can't resurrect the wizard on the next load.
 */
function persistWizardSkip(lastStep) {
    try {
        const s = getSettings();
        s._wizardSkipped = true;
        s._wizardLastStep = lastStep;
        invalidateSettingsCache();
        saveSettingsDebounced();
    } catch { /* settings unavailable — LS sentinel below is the backup */ }
    try {
        localStorage.setItem(WIZARD_SKIP_LS_KEY, '1');
        localStorage.setItem(WIZARD_LAST_STEP_LS_KEY, String(lastStep));
    } catch { /* quota/denied — settings flag is authoritative */ }
}

/** Clear the skip sentinel once the wizard is completed (so a future re-run starts clean). */
function clearWizardSkip() {
    try {
        const s = getSettings();
        delete s._wizardSkipped;
        delete s._wizardLastStep;
    } catch { /* noop */ }
    try {
        localStorage.removeItem(WIZARD_SKIP_LS_KEY);
        localStorage.removeItem(WIZARD_LAST_STEP_LS_KEY);
    } catch { /* noop */ }
}

/** Resume page for a manual relaunch: last skipped step (clamped), else page 1. */
export function getWizardResumeStep() {
    let step = 0;
    try { step = parseInt(getSettings()?._wizardLastStep, 10) || 0; } catch { /* noop */ }
    if (!step) { try { step = parseInt(localStorage.getItem(WIZARD_LAST_STEP_LS_KEY) || '0', 10) || 0; } catch { /* noop */ } }
    return Math.min(TOTAL_PAGES, Math.max(1, step || 1));
}

/** @param {number} [startPage=1] 1-indexed page to start on */
export async function showSetupWizard(startPage = 1) {
    const html = await renderExtensionTemplateAsync(EXTENSION_REF, 'setup-wizard');

    currentPage = 1;
    connectionVerified = false;
    searchMode = 'keywords';
    importResult = null;
    wizardFinished = false;

    await callGenericPopup(html, POPUP_TYPE.DISPLAY, '', {
        wide: true,
        okButton: false,
        cancelButton: false,
        allowVerticalScrolling: true,
        onOpen: () => {
            $wizard = $('.dle-wizard');
            if (!$wizard.length) return;
            applyHtmlI18n($wizard[0]); // markup-bearing locale strings (data-i18n-html)
            librarianToggleWired = false;
            resetWizardState(); // BUG-340: fresh state per open

            prefillFromSettings();
            wireNavigation();
            wireWelcomeFork();
            wireConnectionTest();
            wireVaultScan();
            wireDemoVault();
            wireAiSetup();
            wirePresets();
            wireSearchMode();
            wireVaultStructure();
            wireImport();
            wireDoneActions();
            wireStepIndicator();
            wireSkip();

            if (startPage > 1 && startPage <= TOTAL_PAGES) {
                for (let i = 1; i < startPage; i++) markStepComplete(i);
                goToPage(startPage);
            } else {
                // Initial mount on page 1: announce position for SR users but don't
                // yank focus into a panel on first paint — the dialog already holds focus.
                announceProgress(1);
            }

            updateNavButtons();
        },
    });

    // SKIP/RESUME: callGenericPopup resolves once the popup closes by ANY route — Finish
    // (which sets wizardFinished), the explicit "Finish later" button, the dialog X, or Esc.
    // If we get here and the wizard wasn't finished, the user dismissed it; persist a skip
    // sentinel + last page so init() won't silently re-pop it next load and a manual relaunch
    // resumes where they left off. (The Finish-later button persists eagerly before closing,
    // so this is the catch-all for X/Esc dismissals.)
    if (!wizardFinished) persistWizardSkip(currentPage);
}

function prefillFromSettings() {
    const s = getSettings();
    const v = getPrimaryVault(s);

    // Page 2: Connection
    if (v.name) $wizard.find('#dle-wiz-vault-name').val(v.name);
    if (v.host) $wizard.find('#dle-wiz-host').val(v.host);
    if (v.port) $wizard.find('#dle-wiz-port').val(v.port);
    if (v.apiKey) $wizard.find('#dle-wiz-api-key').val(v.apiKey);
    $wizard.find('#dle-wiz-https').prop('checked', !!v.https);

    // Page 3: Tags
    $wizard.find('#dle-wiz-lorebook-tag').val(s.lorebookTag || 'lorebook');
    $wizard.find('#dle-wiz-constant-tag').val(s.constantTag || 'lorebook-always');
    $wizard.find('#dle-wiz-seed-tag').val(s.seedTag || 'lorebook-seed');
    $wizard.find('#dle-wiz-bootstrap-tag').val(s.bootstrapTag || 'lorebook-bootstrap');

    // Search mode
    if (s.aiSearchEnabled) {
        searchMode = s.aiSearchMode || 'two-stage';
        $wizard.find(`input[name="dle-wiz-search-mode"][value="${searchMode}"]`).prop('checked', true);
    }

    // Page 4: Matching
    $wizard.find('#dle-wiz-scan-depth').val(s.scanDepth);
    $wizard.find('#dle-wiz-max-entries').val(s.maxEntries);
    $wizard.find('#dle-wiz-budget').val(s.maxTokensBudget);
    $wizard.find('#dle-wiz-fuzzy').prop('checked', s.fuzzySearchEnabled);
    $wizard.find('#dle-wiz-unlimited-entries').prop('checked', !!s.unlimitedEntries);
    $wizard.find('#dle-wiz-unlimited-budget').prop('checked', !!s.unlimitedBudget);
    if (s.unlimitedEntries) $wizard.find('#dle-wiz-max-entries').prop('disabled', true);
    if (s.unlimitedBudget) $wizard.find('#dle-wiz-budget').prop('disabled', true);

    // Page 5: AI
    if (s.aiSearchConnectionMode === 'proxy') {
        $wizard.find('input[name="dle-wiz-ai-mode"][value="proxy"]').prop('checked', true);
        $wizard.find('#dle-wiz-ai-profile-fields').hide();
        $wizard.find('#dle-wiz-ai-proxy-fields').show();
    }
    if (s.aiSearchProxyUrl) $wizard.find('#dle-wiz-ai-proxy-url').val(s.aiSearchProxyUrl);
    if (s.aiSearchModel) $wizard.find('#dle-wiz-ai-model').val(s.aiSearchModel);

    // Page 6: Librarian
    if (s.librarianEnabled) $wizard.find('#dle-wiz-librarian-enabled').prop('checked', true);
    if (s.librarianSearchEnabled !== undefined) $wizard.find('#dle-wiz-librarian-search').prop('checked', s.librarianSearchEnabled);
    if (s.librarianFlagEnabled !== undefined) $wizard.find('#dle-wiz-librarian-flag').prop('checked', s.librarianFlagEnabled);
}

function wireNavigation() {
    $wizard.find('#dle-wiz-prev').on('click', () => {
        let target = currentPage - 1;
        // Skip AI (5) and Librarian (6) pages when keywords-only — no tool calling without AI.
        if (target === 6 && searchMode === 'keywords') target = 5;
        if (target === 5 && searchMode === 'keywords') target = 4;
        if (target >= 1) goToPage(target);
    });

    $wizard.find('#dle-wiz-next').on('click', () => {
        if (!validateCurrentPage()) return;
        markStepComplete(currentPage);
        let target = currentPage + 1;
        if (target === 5 && searchMode === 'keywords') target = 6;
        if (target === 6 && searchMode === 'keywords') target = 7;
        if (target <= TOTAL_PAGES) goToPage(target);
    });

    $wizard.find('#dle-wiz-finish').on('click', async () => {
        // #16: Finish is reachable via clickable completed step-dots or by editing the
        // API key after a successful test (which resets connectionVerified). Re-assert
        // the gate here so we never silently commit enabled=true with an unverified
        // connection. isPageValid() only guards the Page-2 → Page-3 transition.
        if (!connectionVerified) {
            const proceed = await callGenericPopup(
                tr('dle_wiz_finish_unverified_confirm', 'Your Obsidian connection has not been verified on the Connection step. DeepLore will be enabled but may not work until the connection succeeds.\n\nFinish anyway?'),
                POPUP_TYPE.CONFIRM, '', {
                    okButton: tr('dle_wiz_finish_anyway_btn', 'Finish anyway'),
                    cancelButton: tr('dle_wiz_go_back_btn', 'Go back'),
                },
            );
            if (!proceed) { goToPage(2); return; }
        }
        // Mark finished BEFORE the async work so the close handler (which runs after
        // callGenericPopup resolves) doesn't misread this as a dismissal and write a skip.
        wizardFinished = true;
        try {
            await applyWizardSettings();
        } catch (err) {
            console.error('[DLE] Wizard finish error:', err);
            toastr.warning(tr('dle_wiz_index_build_failed_toast', 'Setup saved but index build failed — it will retry on first generation.'), 'DeepLore');
        }
        // Close popup regardless — settings are already saved before buildIndex().
        closeWizardPopup();
    });
}

function goToPage(page) {
    currentPage = page;

    $wizard.find('.dle-wizard-page').removeClass('active');
    const $panel = $wizard.find(`[data-wizard-page="${page}"]`).addClass('active');

    $wizard.find('.dle-wizard-step').removeClass('active').attr('aria-selected', 'false').removeAttr('aria-current');
    $wizard.find(`.dle-wizard-step[data-step="${page}"]`).addClass('active').attr('aria-selected', 'true').attr('aria-current', 'step');

    updateNavButtons();

    if (page === 5) loadAiProfiles();
    if (page === 6) wireLibrarianToggle();
    if (page === 7) wireVaultStructurePage();
    if (page === 8) loadImportLorebooks();
    if (page === 9) buildSummary();

    // a11y (FOCUS-ON-ADVANCE): move focus to the newly-active panel so keyboard/SR users
    // land on the step content instead of being stranded on the now-hidden previous page,
    // and announce "Step N of M: <title>" via the polite live region. Focus AFTER the
    // per-page wiring above so the panel's first interactive control already exists.
    announceProgress(page);
    moveFocusToPanel($panel);
}

/** Update the screen-reader-only live region with the current step position + title. */
function announceProgress(page) {
    const $live = $wizard.find('#dle-wizard-progress-live');
    if (!$live.length) return;
    const stepLabel = $wizard.find(`.dle-wizard-step[data-step="${page}"] .dle-wizard-step-label`).text().trim();
    // ${0}=current step, ${1}=total, ${2}=step title.
    $live.text(trf('dle_wizard_progress_announce', page, TOTAL_PAGES, stepLabel));
}

/**
 * Move focus to the panel container (tabindex="-1"). preventScroll keeps the popup
 * from jumping; the panel reads its aria-labelledby step button as its accessible name.
 */
function moveFocusToPanel($panel) {
    const el = $panel && $panel.get(0);
    if (!el || typeof el.focus !== 'function') return;
    try { el.focus({ preventScroll: false }); } catch { el.focus(); }
}

function updateNavButtons() {
    const $prev = $wizard.find('#dle-wiz-prev');
    const $next = $wizard.find('#dle-wiz-next');
    const $finish = $wizard.find('#dle-wiz-finish');
    const $reason = $wizard.find('.dle-wiz-next-reason');

    $prev.toggle(currentPage > 1);

    if (currentPage === TOTAL_PAGES) {
        $next.hide();
        $finish.show();
        $reason.hide();
    } else {
        $next.show();
        $finish.hide();
        const valid = isPageValid(currentPage);
        $next.prop('disabled', !valid);
        // Surface why Next is disabled so the user knows what to fix without hunting.
        if (!valid && currentPage === 2 && !connectionVerified) {
            const reasonText = tr('dle_wiz_test_conn_to_continue', 'Test connection to continue');
            if (!$reason.length) {
                $next.before('<span class="dle-wiz-next-reason dle-text-xs dle-muted" style="margin-right:8px;">' + escapeHtml(reasonText) + '</span>');
            } else {
                $reason.text(reasonText).show();
            }
        } else {
            $reason.hide();
        }
    }
}

function validateCurrentPage() {
    if (!isPageValid(currentPage)) {
        if (currentPage === 2 && !connectionVerified) {
            $wizard.find('#dle-wiz-test-conn').addClass('dle-wizard-pulse');
            setTimeout(() => $wizard.find('#dle-wiz-test-conn').removeClass('dle-wizard-pulse'), 600);
        }
        return false;
    }
    return true;
}

function isPageValid(page) {
    switch (page) {
        case 2: return connectionVerified;
        default: return true;
    }
}

// SKIP/RESUME: explicit "Finish later" affordance. Persists the skip sentinel BEFORE
// closing so even if the close path throws, the relaunch-suppression state is already saved.
function wireSkip() {
    $wizard.find('#dle-wiz-skip').on('click', () => {
        persistWizardSkip(currentPage);
        wizardFinished = true; // already persisted skip; stop the close handler double-writing
        toastr.info(tr('dle_wizard_skip_toast', 'Setup paused. Reopen it any time with /dle-setup.'), 'DeepLore');
        closeWizardPopup();
    });
}

/** Close the wizard popup regardless of how it was constructed (shared with Finish). */
function closeWizardPopup() {
    const $popup = $wizard.closest('dialog.popup, .popup');
    const popupEl = $popup.get(0);
    const popupInstance = popupEl && Popup && typeof Popup.util?.popups !== 'undefined'
        ? Popup.util.popups.find(p => p.dlg === popupEl)
        : null;
    if (popupInstance && typeof popupInstance.completeCancelled === 'function') {
        popupInstance.completeCancelled();
    } else if (popupEl && typeof popupEl.close === 'function') {
        popupEl.close();
    } else {
        $popup.find('.popup_cross, .popup_close').trigger('click');
    }
}

function wireStepIndicator() {
    $wizard.find('.dle-wizard-step').on('click', function () {
        const step = parseInt($(this).data('step'));
        // Only completed or current steps are navigable.
        if ($(this).hasClass('completed') || step === currentPage) {
            goToPage(step);
        }
    });
}

function markStepComplete(step) {
    const $step = $wizard.find(`.dle-wizard-step[data-step="${step}"]`);
    $step.addClass('completed');
    $step.find('.dle-wizard-step-dot').html('<i class="fa-solid fa-check"></i>');
}

// ── Page 2: Connection Test ──

function wireConnectionTest() {
    $wizard.find('#dle-wiz-test-conn').on('click', async () => {
        const $btn = $wizard.find('#dle-wiz-test-conn');
        const $result = $wizard.find('#dle-wiz-conn-result');

        const host = $wizard.find('#dle-wiz-host').val().trim() || '127.0.0.1';
        const port = parseInt($wizard.find('#dle-wiz-port').val()) || 27123;
        const apiKey = $wizard.find('#dle-wiz-api-key').val().trim();
        const useHttps = $wizard.find('#dle-wiz-https').is(':checked');

        $btn.prop('disabled', true).html('<goo-spinner size="22" color="currentColor" aria-hidden="true"></goo-spinner> ' + tr('dle_wiz_testing', 'Testing...'));
        $result.hide();

        try {
            const result = await testConnection(host, port, apiKey, useHttps);
            if (result.certError) {
                const $trustLink = $wizard.find('#dle-wiz-trust-cert');
                $trustLink.attr('href', result.certUrl).show().off('click').on('click', (e) => {
                    e.preventDefault();
                    window.open(result.certUrl, '_blank');
                });
            }
            if (result.ok) {
                connectionVerified = true;
                $wizard.find('#dle-wiz-trust-cert').hide();
                $result
                    .html('<i class="fa-solid fa-circle-check"></i> ' + tr('dle_wiz_conn_success', 'Connected to Obsidian vault successfully'))
                    .removeClass('dle-wizard-result-error')
                    .addClass('dle-wizard-result-success')
                    .show();
                $btn.html('<i class="fa-solid fa-circle-check"></i> ' + tr('dle_wiz_connected', 'Connected')).addClass('dle-wizard-btn-verified');
            } else {
                connectionVerified = false;
                if (result.diagnosis) {
                    const guidanceHtml = `<div class="dle-popup">${buildConnectionGuidanceHtml(result)}</div>`;
                    callGenericPopup(guidanceHtml, POPUP_TYPE.TEXT, tr('dle_wiz_connection_help_title', 'Connection Help'), {
                        wide: true, allowVerticalScrolling: true, okButton: tr('dle_wiz_got_it_btn', 'Got it'),
                    });
                }
                $wizard.find('#dle-wiz-trust-cert').hide();
                // V-M4 (2026-05-22): testConnection may return `{ ok: false, diagnosis }`
                // with no `error` set. escapeHtml(undefined) renders the literal string
                // "undefined" — fall back to a diagnosis-derived string so the user
                // doesn't see "Error: undefined" in the UI.
                const errorText = result.error
                    || (result.diagnosis ? trf('dle_wiz_diagnosis_prefix', result.diagnosis) : tr('dle_wiz_unknown_error', 'Unknown error'));
                $result
                    .html(`<i class="fa-solid fa-circle-xmark"></i> ${escapeHtml(errorText)}`)
                    .removeClass('dle-wizard-result-success')
                    .addClass('dle-wizard-result-error')
                    .show();
                $btn.html('<i class="fa-solid fa-plug"></i> ' + tr('dle_setup_wizard_test_connection_btn', 'Test Connection'));
            }
        } catch (err) {
            connectionVerified = false;
            $result
                .html('<i class="fa-solid fa-circle-xmark"></i> ' + escapeHtml(trf('dle_wiz_error_prefix', err.message)))
                .removeClass('dle-wizard-result-success')
                .addClass('dle-wizard-result-error')
                .show();
            $btn.html('<i class="fa-solid fa-plug"></i> ' + tr('dle_setup_wizard_test_connection_btn', 'Test Connection'));
        }

        $btn.prop('disabled', false);
        updateNavButtons();
    });

    // Auto-switch port on HTTPS toggle — user can override.
    $wizard.find('#dle-wiz-https').on('change', function () {
        const currentPort = parseInt($wizard.find('#dle-wiz-port').val());
        if (this.checked && currentPort === 27123) {
            $wizard.find('#dle-wiz-port').val(27124);
        } else if (!this.checked && currentPort === 27124) {
            $wizard.find('#dle-wiz-port').val(27123);
        }
        connectionVerified = false;
        $wizard.find('#dle-wiz-test-conn')
            .html('<i class="fa-solid fa-plug"></i> ' + tr('dle_setup_wizard_test_connection_btn', 'Test Connection'))
            .prop('disabled', false);
    });

    $wizard.find('#dle-wiz-host, #dle-wiz-port, #dle-wiz-api-key').on('input', () => {
        connectionVerified = false;
        $wizard.find('#dle-wiz-test-conn')
            .html('<i class="fa-solid fa-plug"></i> ' + tr('dle_setup_wizard_test_connection_btn', 'Test Connection'))
            .removeClass('dle-wizard-btn-verified');
        $wizard.find('#dle-wiz-conn-result').hide();
        updateNavButtons();
    });
}

// ── Page 2: Demo Vault ──

/** Path is shown relative to ST root since the install dir varies per user. */
function getDemoVaultPath() {
    return `public/scripts/extensions/${EXTENSION_REF}/test-vault`;
}

function wireDemoVault() {
    $wizard.find('#dle-wiz-demo-toggle').on('click', () => {
        const $instructions = $wizard.find('#dle-wiz-demo-instructions');
        const $btn = $wizard.find('#dle-wiz-demo-toggle');
        const isHidden = !$instructions.is(':visible');
        $instructions.slideToggle(200);
        $btn.html(isHidden
            ? '<i class="fa-solid fa-chevron-up"></i> ' + tr('dle_wiz_hide_instructions', 'Hide instructions')
            : '<i class="fa-solid fa-folder-open"></i> ' + tr('dle_setup_wizard_demo_show_me_how_btn', 'Show me how'));
        if (isHidden) {
            $wizard.find('#dle-wiz-demo-path').text(getDemoVaultPath());
        }
    });

    $wizard.find('#dle-wiz-demo-copy').on('click', () => {
        const path = $wizard.find('#dle-wiz-demo-path').text();
        navigator.clipboard.writeText(path).then(
            () => toastr.info(tr('dle_wiz_path_copied', 'Path copied to clipboard'), 'DeepLore'),
            () => toastr.warning(tr('dle_wiz_path_copy_failed', 'Failed to copy — select and copy manually'), 'DeepLore'),
        );
    });

    $wizard.find('#dle-wiz-demo-autofill').on('click', () => {
        wizardState.demoAutofilled = true; // #67: gate demo tips on this, not a fuzzy name match
        $wizard.find('#dle-wiz-vault-name').val('Duskfrost Demo');
        $wizard.find('#dle-wiz-host').val('127.0.0.1');
        $wizard.find('#dle-wiz-port').val('27123');
        $wizard.find('#dle-wiz-https').prop('checked', false);
        connectionVerified = false;
        $wizard.find('#dle-wiz-test-conn')
            .html('<i class="fa-solid fa-plug"></i> ' + tr('dle_setup_wizard_test_connection_btn', 'Test Connection'))
            .removeClass('dle-wizard-btn-verified');
        $wizard.find('#dle-wiz-conn-result').hide();
        updateNavButtons();
        // API key is the only field the user must still enter.
        $wizard.find('#dle-wiz-api-key').val('').focus();
        toastr.info(tr('dle_wiz_demo_fields_filled', 'Connection fields filled — enter your Obsidian API key and click Test'), 'DeepLore');
    });
}

// ── Page 1: Welcome decision-fork (choice cards) ──

/**
 * The Welcome choice cards surface the three lowest-friction first paths instead of
 * burying the demo vault behind 5 clicks on Page 2. Each card advances the wizard and
 * pre-stages the relevant page so the user lands where they intended.
 */
function wireWelcomeFork() {
    $wizard.find('.dle-wizard-choice-card').on('click', function () {
        const fork = $(this).data('fork');
        markStepComplete(1);
        switch (fork) {
            case 'demo':
                goToPage(2);
                // Expand the demo callout and pre-fill the demo connection so the only
                // thing left is pasting the API key (the demo's lowest-friction path).
                if (!$wizard.find('#dle-wiz-demo-instructions').is(':visible')) {
                    $wizard.find('#dle-wiz-demo-toggle').trigger('click');
                }
                $wizard.find('#dle-wiz-demo-autofill').trigger('click');
                break;
            case 'connect':
                goToPage(2);
                $wizard.find('#dle-wiz-host').trigger('focus');
                break;
            case 'import':
                // Import lives on Page 8. Mark the skipped intermediate steps complete so
                // the step-dots stay navigable and Prev walks back normally; connection is
                // still re-gated at Finish (#16) so this can't silently enable an unverified vault.
                for (let i = 2; i < 8; i++) markStepComplete(i);
                goToPage(8);
                $wizard.find('input[name="dle-wiz-import-method"][value="lorebook"]')
                    .prop('checked', true).trigger('change');
                break;
        }
    });
}

// ── Page 2: Scan for vaults ──

function wireVaultScan() {
    $wizard.find('#dle-wiz-scan-vaults').on('click', async function () {
        const $btn = $(this);
        if ($btn.prop('disabled')) return;
        $btn.prop('disabled', true);
        const orig = $btn.html();
        $btn.html('<goo-spinner size="22" color="currentColor" aria-hidden="true"></goo-spinner> '
            + escapeHtml(tr('dle_vaultscan_scanning', 'Scanning…')));
        try {
            const { openVaultScanPopup } = await import('./vault-scan-popup.js');
            const host = $wizard.find('#dle-wiz-host').val().trim() || '127.0.0.1';
            const apiKey = $wizard.find('#dle-wiz-api-key').val().trim();
            const portCenter = parseInt($wizard.find('#dle-wiz-port').val(), 10) || 27124;
            const picked = await openVaultScanPopup({ host, apiKey, portCenter, radius: 25 });
            if (picked) {
                // Fill the connection fields from the discovered vault; the user still
                // tests/finishes, so connectionVerified stays false until Test Connection.
                if (picked.vaultName) $wizard.find('#dle-wiz-vault-name').val(picked.vaultName);
                $wizard.find('#dle-wiz-host').val(picked.host || host);
                $wizard.find('#dle-wiz-port').val(picked.port);
                $wizard.find('#dle-wiz-https').prop('checked', picked.scheme === 'https');
                connectionVerified = false;
                $wizard.find('#dle-wiz-test-conn')
                    .html('<i class="fa-solid fa-plug"></i> ' + tr('dle_setup_wizard_test_connection_btn', 'Test Connection'))
                    .removeClass('dle-wizard-btn-verified');
                $wizard.find('#dle-wiz-conn-result').hide();
                updateNavButtons();
                toastr.info(trf('dle_vaultscan_filled_toast', `${picked.host || host}:${picked.port}`), 'DeepLore');
            }
        } catch (err) {
            console.error('[DLE] Wizard vault scan error:', err);
            toastr.error(tr('dle_vaultscan_failed_toast', 'Vault scan didn\'t find anything. Make sure Obsidian is running.'), 'DeepLore');
        } finally {
            $btn.prop('disabled', false).html(orig);
        }
    });
}

function wireSearchMode() {
    $wizard.find('input[name="dle-wiz-search-mode"]').on('change', function () {
        searchMode = $(this).val();
    });
}

function wirePresets() {
    $wizard.find('.dle-wizard-preset').on('click', function () {
        const preset = $(this).data('preset');
        const values = PRESETS[preset];
        if (!values) return;

        $wizard.find('.dle-wizard-preset').removeClass('active');
        $(this).addClass('active');

        $wizard.find('#dle-wiz-scan-depth').val(values.scanDepth);
        $wizard.find('#dle-wiz-max-entries').val(values.maxEntries);
        $wizard.find('#dle-wiz-budget').val(values.budget);

        const label = preset.charAt(0).toUpperCase() + preset.slice(1);
        // ${0}=preset label (e.g. "Medium"). English: "Configured for ${0} vault"
        $wizard.find('#dle-wiz-preset-badge')
            .html('<i class="fa-solid fa-check"></i> ' + escapeHtml(trf('dle_wiz_preset_configured', label)))
            .addClass('dle-wizard-badge-visible');

        // Presets always override unlimited toggles.
        $wizard.find('#dle-wiz-unlimited-entries').prop('checked', false);
        $wizard.find('#dle-wiz-unlimited-budget').prop('checked', false);
        $wizard.find('#dle-wiz-max-entries, #dle-wiz-budget').prop('disabled', false);
    });

    $wizard.find('#dle-wiz-unlimited-entries').on('change', function () {
        $wizard.find('#dle-wiz-max-entries').prop('disabled', this.checked);
    });
    $wizard.find('#dle-wiz-unlimited-budget').on('change', function () {
        $wizard.find('#dle-wiz-budget').prop('disabled', this.checked);
    });
}

function wireAiSetup() {
    // v2.5: proxy mode deprecated; wiring kept dormant for rollback.
    // The proxy radio is hidden in setup-wizard.html so this toggle is a no-op
    // in normal flow; left intact to revive cleanly if proxy mode comes back.
    $wizard.find('input[name="dle-wiz-ai-mode"]').on('change', function () {
        const mode = $(this).val();
        $wizard.find('#dle-wiz-ai-profile-fields').toggle(mode === 'profile');
        $wizard.find('#dle-wiz-ai-proxy-fields').toggle(mode === 'proxy');
    });

    $wizard.find('#dle-wiz-test-ai').on('click', async () => {
        const $btn = $wizard.find('#dle-wiz-test-ai');
        const $result = $wizard.find('#dle-wiz-ai-result');
        $btn.prop('disabled', true).html('<goo-spinner size="22" color="currentColor" aria-hidden="true"></goo-spinner> ' + tr('dle_wiz_testing', 'Testing...'));
        $result.hide();

        try {
            const mode = $wizard.find('input[name="dle-wiz-ai-mode"]:checked').val();
            let ok = false;
            let detail = '';
            let liveTested = false; // #15: did we actually probe the endpoint?

            if (mode === 'profile') {
                const profileId = $wizard.find('#dle-wiz-ai-profile').val();
                if (!profileId) throw new Error(tr('dle_wiz_ai_err_select_profile', 'Select a connection profile first'));
                const { ConnectionManagerRequestService } = await import('../../../../shared.js')
                    .catch(() => ({ ConnectionManagerRequestService: null }));
                if (!ConnectionManagerRequestService) throw new Error(tr('dle_wiz_ai_err_cm_unavailable', 'Connection Manager not available'));
                const profile = ConnectionManagerRequestService.getProfile(profileId);
                if (!profile) throw new Error(tr('dle_wiz_ai_err_profile_not_found', 'Selected profile not found'));
                // #15: selecting a profile is NOT a connectivity test — we send no request,
                // so we must not claim "AI connection working". A bad key/endpoint only
                // surfaces on first generation. Report honestly as "selected, not tested".
                ok = true;
                liveTested = false;
                detail = $wizard.find('#dle-wiz-ai-profile option:selected').text();
            } else {
                const proxyUrl = $wizard.find('#dle-wiz-ai-proxy-url').val().trim();
                const model = $wizard.find('#dle-wiz-ai-model').val().trim();
                if (!proxyUrl) throw new Error(tr('dle_wiz_ai_err_enter_proxy_url', 'Enter a proxy URL first'));
                if (!model) throw new Error(tr('dle_wiz_ai_err_enter_model', 'Enter a model name first (e.g. claude-haiku-4-5-20251001)'));
                const { testProxyConnection } = await import('../ai/proxy-api.js');
                const result = await testProxyConnection(proxyUrl, model);
                ok = result.ok;
                liveTested = true;
                // ${0}=model id. English: "Model: ${0}"
                detail = result.ok ? trf('dle_wiz_ai_model_detail', result.model || model) : result.error;
            }

            if (ok && liveTested) {
                // ${0}=detail (model). English: "AI connection working — ${0}"
                $result
                    .html('<i class="fa-solid fa-circle-check"></i> ' + escapeHtml(trf('dle_wiz_ai_working', detail)))
                    .removeClass('dle-wizard-result-error')
                    .addClass('dle-wizard-result-success')
                    .show();
                $btn.html('<i class="fa-solid fa-circle-check"></i> ' + tr('dle_wiz_connected', 'Connected')).addClass('dle-wizard-btn-verified');
            } else if (ok) {
                // profile selected but not live-tested — honest, neutral messaging
                // ${0}=detail (profile name). English: "Profile selected: ${0} — DLE will use it for AI search. Not live-tested here; a bad key or endpoint will surface on the first generation."
                $result
                    .html('<i class="fa-solid fa-circle-info"></i> ' + escapeHtml(trf('dle_wiz_ai_profile_selected_msg', detail)))
                    .removeClass('dle-wizard-result-error dle-wizard-result-success')
                    .show();
                $btn.html('<i class="fa-solid fa-circle-check"></i> ' + tr('dle_wiz_ai_profile_selected_btn', 'Profile selected')).addClass('dle-wizard-btn-verified');
            } else {
                $result
                    .html(`<i class="fa-solid fa-circle-xmark"></i> ${escapeHtml(detail)}`)
                    .removeClass('dle-wizard-result-success')
                    .addClass('dle-wizard-result-error')
                    .show();
                $btn.html('<i class="fa-solid fa-brain"></i> ' + tr('dle_setup_wizard_test_ai_btn', 'Test AI Connection'));
            }
        } catch (err) {
            $result
                .html(`<i class="fa-solid fa-circle-xmark"></i> ${escapeHtml(err.message)}`)
                .removeClass('dle-wizard-result-success')
                .addClass('dle-wizard-result-error')
                .show();
            $btn.html('<i class="fa-solid fa-brain"></i> ' + tr('dle_setup_wizard_test_ai_btn', 'Test AI Connection'));
        }

        $btn.prop('disabled', false);
    });
}

async function loadAiProfiles() {
    const $select = $wizard.find('#dle-wiz-ai-profile');
    $select.next('.dle-wiz-no-profiles-help').remove(); // Wave E: clear prior remediation (page revisits).
    try {
        const { ConnectionManagerRequestService } = await import('../../../../shared.js')
            .catch(() => ({ ConnectionManagerRequestService: null }));
        if (!ConnectionManagerRequestService) {
            $select.html('<option value="">' + escapeHtml(tr('dle_wiz_ai_cm_unavailable_opt', 'Connection Manager not available')) + '</option>');
            return;
        }
        const profiles = ConnectionManagerRequestService.getSupportedProfiles();
        if (!profiles || profiles.length === 0) {
            $select.html('<option value="">' + escapeHtml(tr('dle_wiz_ai_no_profiles_opt', 'No profiles configured')) + '</option>');
            // Wave E (E3): don't dead-end on an empty dropdown — tell the user how to make a profile
            // (profile-is-canonical since v2.5) and offer the keywords-only escape hatch.
            $select.after(
                '<div class="dle-wiz-no-profiles-help dle-text-xs dle-muted" style="margin-top:6px;">'
                + '<i class="fa-solid fa-circle-info"></i> '
                + tr('dle_wiz_no_profiles_help', 'DeepLore routes AI through SillyTavern <strong>Connection Profiles</strong>. Create one in <strong>API Connections</strong> (the plug icon in the top bar) → <strong>Connection Profile</strong>, then reopen this step. Or choose <strong>Keywords Only</strong> on the previous step to skip AI for now.')
                + '</div>',
            );
            return;
        }
        const s = getSettings();
        const savedId = s.aiSearchProfileId;
        const savedExists = savedId && profiles.some(p => p.id === savedId);
        let options = '<option value="">' + escapeHtml(tr('dle_wiz_ai_select_profile_opt', '— Select a profile —')) + '</option>';
        if (savedId && !savedExists) {
            // #72: the saved profile was deleted/renamed in ST — warn instead of silently
            // showing "— Select —" while a stale id lingers in settings.
            options += '<option value="" disabled>⚠ ' + escapeHtml(tr('dle_wiz_ai_stale_profile_opt', 'Previously selected profile no longer exists — choose again')) + '</option>';
        }
        for (const p of profiles) {
            const selected = p.id === savedId ? ' selected' : '';
            const label = `${p.name} (${p.api}${p.model ? ' / ' + p.model : ''})`;
            options += `<option value="${p.id}"${selected}>${escapeHtml(label)}</option>`;
        }
        $select.html(options);
    } catch (err) {
        // BUG-112: log so dropdown load failures are diagnosable.
        console.debug('[DLE] Wizard profile dropdown load failed:', err?.message);
        $select.html('<option value="">' + escapeHtml(tr('dle_wiz_ai_load_profiles_failed_opt', 'Failed to load profiles')) + '</option>');
    }
}

let librarianToggleWired = false;

function wireLibrarianToggle() {
    if (librarianToggleWired) return;
    librarianToggleWired = true;

    const $master = $wizard.find('#dle-wiz-librarian-enabled');
    const $sub = $wizard.find('#dle-wiz-librarian-sub');

    $master.on('change', function () {
        $sub.toggle(this.checked);
    });

    $sub.toggle($master.is(':checked'));
}

function wireVaultStructure() {
    // Handled on page entry via runVaultStructureCreation
}

// BUG-340: wizardState reset per open via resetWizardState() — prior-session state
// must not leak across reopens since we hang it off globalThis for debugging.
let wizardState = (globalThis.__dleWizardState = {});
function resetWizardState() {
    wizardState = (globalThis.__dleWizardState = {});
}

function wireVaultStructurePage() {
    // BUG-137: gate on actual connectionVerified flag — the (host && apiKey)
    // heuristic let users proceed without testing.
    const connVerified = connectionVerified;
    if (!connVerified) {
        $wizard.find('#dle-wiz-vault-conn-warning').show();
        $wizard.find('#dle-wiz-vault-helpers-wrap').hide();
        $wizard.find('#dle-wiz-vault-back-conn').off('click.dlewiz').on('click.dlewiz', () => goToPage(2));
        return;
    }
    $wizard.find('#dle-wiz-vault-conn-warning').hide();
    $wizard.find('#dle-wiz-vault-helpers-wrap').show();

    const s = getSettings();

    const $fieldsPath = $wizard.find('#dle-wiz-fields-path');
    if (!$fieldsPath.val()) $fieldsPath.val(s.fieldDefinitionsPath || 'DeepLore/field-definitions.yaml');
    const $sessPath = $wizard.find('#dle-wiz-sessions-path');
    if (!$sessPath.val()) $sessPath.val(s.scribeFolder || 'Sessions');

    $fieldsPath.off('blur.dlewiz').on('blur.dlewiz', () => {
        const v = $fieldsPath.val().trim();
        if (v) { getSettings().fieldDefinitionsPath = v; saveSettingsDebounced(); }
    });
    $sessPath.off('blur.dlewiz').on('blur.dlewiz', () => {
        const v = $sessPath.val().trim();
        if (v) { getSettings().scribeFolder = v; saveSettingsDebounced(); }
    });

    try {
        const yaml = serializeFieldDefinitions(DEFAULT_FIELD_DEFINITIONS);
        $wizard.find('#dle-wiz-fields-yaml').text(yaml);
    } catch { /* non-fatal */ }

    // Collapse Sessions card when Scribe disabled upstream.
    const $optDetails = $wizard.find('#dle-wiz-optional-helpers');
    if (!s.scribeEnabled) {
        $optDetails.prop('open', false);
        $wizard.find('#dle-wiz-create-sessions').prop('checked', false);
    } else {
        $optDetails.prop('open', true);
        $wizard.find('#dle-wiz-create-sessions').prop('checked', true);
    }

    // Wired idempotently — cheap rewires happen each time the page is shown.
    const $btn = $wizard.find('#dle-wiz-create-files');
    if (!$btn.data('wired')) {
        $btn.data('wired', true);
        $btn.on('click', async () => {
            $btn.prop('disabled', true).html('<goo-spinner size="22" color="currentColor" aria-hidden="true"></goo-spinner> ' + tr('dle_wiz_creating', 'Creating...'));
            await runVaultStructureCreation();
            $btn.html('<i class="fa-solid fa-circle-check"></i> ' + tr('dle_wiz_done', 'Done')).addClass('dle-wizard-btn-verified').prop('disabled', false);
        });
    }

    const $skip = $wizard.find('#dle-wiz-vault-skip');
    if (!$skip.data('wired')) {
        $skip.data('wired', true);
        $skip.on('click', () => {
            wizardState.vaultHelpers = 'skipped';
            goToPage(8);
        });
    }
}

async function runVaultStructureCreation() {
    const host = $wizard.find('#dle-wiz-host').val().trim() || '127.0.0.1';
    const port = parseInt($wizard.find('#dle-wiz-port').val()) || 27123;
    const apiKey = $wizard.find('#dle-wiz-api-key').val().trim();
    const useHttps = $wizard.find('#dle-wiz-https').is(':checked');

    const outcome = { fields: 'skipped', sessions: 'skipped' };

    const createFields = $wizard.find('#dle-wiz-create-fields').is(':checked');
    if (createFields) {
        try {
            const yaml = serializeFieldDefinitions(DEFAULT_FIELD_DEFINITIONS);
            const path = ($wizard.find('#dle-wiz-fields-path').val().trim()) || 'DeepLore/field-definitions.yaml';
            getSettings().fieldDefinitionsPath = path;
            saveSettingsDebounced();
            await writeFieldDefinitions(host, port, apiKey, path, yaml, useHttps);
            outcome.fields = 'created';
        } catch (err) {
            outcome.fields = 'failed';
            outcome.fieldsError = err.message;
        }
    }

    const createSessions = $wizard.find('#dle-wiz-create-sessions').is(':checked');
    if (createSessions) {
        try {
            const folder = ($wizard.find('#dle-wiz-sessions-path').val().trim()) || 'Sessions';
            getSettings().scribeFolder = folder;
            saveSettingsDebounced();
            await writeNote(host, port, apiKey, `${folder}/.gitkeep`, '# Session Scribe\nThis folder is used by DeepLore Session Scribe.\n', useHttps);
            outcome.sessions = 'created';
        } catch (err) {
            outcome.sessions = 'failed';
            outcome.sessionsError = err.message;
        }
    }

    const $result = $wizard.find('#dle-wiz-vault-result');
    const lines = [];
    const labels = {
        created: tr('dle_wiz_outcome_created', 'Created'),
        skipped: tr('dle_wiz_outcome_skipped', 'Skipped'),
        failed: tr('dle_wiz_outcome_failed', 'Failed'),
        exists: tr('dle_wiz_outcome_exists', 'Already present'),
    };
    lines.push(`<div><strong>${escapeHtml(tr('dle_wiz_field_defs_label', 'Field definitions:'))}</strong> ${labels[outcome.fields]}${outcome.fieldsError ? ` &mdash; ${escapeHtml(outcome.fieldsError)}` : ''}</div>`);
    lines.push(`<div><strong>${escapeHtml(tr('dle_wiz_sessions_folder_label', 'Sessions folder:'))}</strong> ${labels[outcome.sessions]}${outcome.sessionsError ? ` &mdash; ${escapeHtml(outcome.sessionsError)}` : ''}</div>`);
    const anyFailed = outcome.fields === 'failed' || outcome.sessions === 'failed';
    const anyDone = outcome.fields === 'created' || outcome.sessions === 'created';
    $result
        .html(lines.join(''))
        .removeClass('dle-wizard-result-success dle-wizard-result-error')
        .addClass(anyFailed ? 'dle-wizard-result-error' : 'dle-wizard-result-success')
        .show();

    wizardState.vaultHelpers = anyFailed ? 'partial' : (anyDone ? 'done' : 'skipped');
    // BUG-139: per-feature outcomes so summary doesn't conflate them.
    wizardState.fieldsOutcome = outcome.fields;
    wizardState.sessionsOutcome = outcome.sessions;
}

let importJsonData = '';

function wireImport() {
    $wizard.find('input[name="dle-wiz-import-method"]').on('change', function () {
        const method = $(this).val();
        $wizard.find('#dle-wiz-import-lb-fields').toggle(method === 'lorebook');
        $wizard.find('#dle-wiz-import-file-fields').toggle(method === 'file');
        $wizard.find('#dle-wiz-import-paste-fields').toggle(method === 'paste');
        $wizard.find('#dle-wiz-import-folder-row').toggle(method !== 'skip');
        $wizard.find('#dle-wiz-import-action').toggle(method !== 'skip');
        $wizard.find('#dle-wiz-import-result').hide();
        importJsonData = '';
    });

    $wizard.find('#dle-wiz-import-browse').on('click', () => {
        $wizard.find('#dle-wiz-import-file')[0]?.click();
    });
    $wizard.find('#dle-wiz-import-file').on('change', function () {
        const file = this.files?.[0];
        if (!file) return;
        $wizard.find('#dle-wiz-import-file-name').text(file.name);
        const reader = new FileReader();
        reader.onload = () => { importJsonData = /** @type {string} */ (reader.result); };
        reader.onerror = () => { toastr.error(tr('dle_wiz_import_read_file_failed', 'Failed to read file.'), 'DeepLore'); };
        reader.readAsText(file);
    });

    $wizard.find('#dle-wiz-import-lorebook').on('change', async function () {
        const name = $(this).val();
        if (!name) { importJsonData = ''; return; }
        try {
            const { loadWorldInfo } = await import('../../../../../world-info.js');
            const data = await loadWorldInfo(name);
            if (!data) {
                // ${0}=lorebook name. English: 'Failed to load lorebook "${0}".'
                toastr.error(trf('dle_wiz_import_load_lorebook_failed', name), 'DeepLore');
                return;
            }
            importJsonData = JSON.stringify(data, null, 2);
        } catch (err) {
            console.error('[DLE] Wizard loadWorldInfo error:', err);
            toastr.error(tr('dle_wiz_import_load_lorebook_error', 'Couldn\'t load that lorebook. Try a different one or paste the JSON directly.'), 'DeepLore');
        }
    });

    $wizard.find('#dle-wiz-import-btn').on('click', async function () {
        const $btn = $(this);
        const $result = $wizard.find('#dle-wiz-import-result');
        const method = $wizard.find('input[name="dle-wiz-import-method"]:checked').val();

        let jsonText = '';
        if (method === 'paste') {
            jsonText = $wizard.find('#dle-wiz-import-json').val()?.trim() || '';
        } else {
            jsonText = importJsonData;
        }

        if (!jsonText) {
            toastr.warning(tr('dle_wiz_import_no_data', 'No data to import. Select a lorebook, upload a file, or paste JSON first.'), 'DeepLore');
            return;
        }

        let entries, source;
        try {
            ({ entries, source } = parseWorldInfoJson(jsonText));
        } catch (err) {
            $result.html(`<i class="fa-solid fa-circle-xmark"></i> ${escapeHtml(err.message)}`)
                .removeClass('dle-wizard-result-success').addClass('dle-wizard-result-error').show();
            return;
        }

        if (!entries || entries.length === 0) {
            $result.html('<i class="fa-solid fa-circle-info"></i> ' + tr('dle_wiz_import_no_entries', 'No entries found in the provided data.'))
                .removeClass('dle-wizard-result-success dle-wizard-result-error').show();
            return;
        }

        const folder = $wizard.find('#dle-wiz-import-folder').val()?.trim() || '';

        $btn.prop('disabled', true).html('<goo-spinner size="22" color="currentColor" aria-hidden="true"></goo-spinner> ' + tr('dle_wiz_importing', 'Importing…'));
        // ${0}=done, ${1}=total. English: "Importing ${0}/${1}…"
        $result.html('<goo-spinner size="22" color="currentColor" aria-hidden="true"></goo-spinner> ' + escapeHtml(trf('dle_wiz_importing_progress', 0, entries.length)))
            .removeClass('dle-wizard-result-success dle-wizard-result-error').show();

        // #14: pass the wizard's live connection — on first run nothing is saved yet,
        // so importEntries' default getPrimaryVault() would hit the empty/default vault (401).
        const wizVault = {
            host: $wizard.find('#dle-wiz-host').val().trim() || '127.0.0.1',
            port: parseInt($wizard.find('#dle-wiz-port').val(), 10) || 27123,
            apiKey: $wizard.find('#dle-wiz-api-key').val().trim(),
            https: $wizard.find('#dle-wiz-https').is(':checked'),
        };

        try {
            const result = await importEntries(entries, folder, (done, total) => {
                // ${0}=done, ${1}=total. English: "Importing ${0}/${1}…"
                $result.html('<goo-spinner size="22" color="currentColor" aria-hidden="true"></goo-spinner> ' + escapeHtml(trf('dle_wiz_importing_progress', done, total)));
            }, { vault: wizVault });

            importResult = result;
            // ${0}=renamed count. English: " (${0} renamed to avoid overwrite)"
            const renamedNote = result.renamed > 0 ? trf('dle_wiz_import_renamed_note', result.renamed) : '';
            if (result.failed > 0) {
                // source pre-escaped (rendered via .html); translated template carries no markup so trf output is not re-escaped.
                // ${0}=imported, ${1}=total, ${2}=source, ${3}=renamedNote, ${4}=failed.
                // English: 'Imported ${0}/${1} from "${2}"${3}. ${4} failed.'
                $result.html('<i class="fa-solid fa-triangle-exclamation"></i> ' + trf('dle_wiz_import_result_failed', result.imported, entries.length, escapeHtml(source), renamedNote, result.failed))
                    .addClass('dle-wizard-result-error').removeClass('dle-wizard-result-success').show();
            } else {
                // ${0}=imported, ${1}=source, ${2}=renamedNote. English: 'Imported ${0} entries from "${1}"${2}'
                $result.html('<i class="fa-solid fa-circle-check"></i> ' + trf('dle_wiz_import_result_success', result.imported, escapeHtml(source), renamedNote))
                    .addClass('dle-wizard-result-success').removeClass('dle-wizard-result-error').show();
            }
            // L-23: re-enable on success too (catch branch already does) so a user can
            // import a second lorebook/file in the same wizard session without the button
            // staying permanently disabled.
            $btn.html('<i class="fa-solid fa-circle-check"></i> ' + tr('dle_wiz_import_complete_btn', 'Import Complete')).prop('disabled', false);
        } catch (err) {
            // ${0}=error message. English: "Import error: ${0}"
            $result.html('<i class="fa-solid fa-circle-xmark"></i> ' + escapeHtml(trf('dle_wiz_import_error', err.message)))
                .addClass('dle-wizard-result-error').removeClass('dle-wizard-result-success').show();
            $btn.html('<i class="fa-solid fa-file-import"></i> ' + tr('dle_setup_wizard_import_entries_btn', 'Import Entries')).prop('disabled', false);
        }
    });
}

async function loadImportLorebooks() {
    const $select = $wizard.find('#dle-wiz-import-lorebook');
    try {
        const { world_names } = await import('../../../../../world-info.js');
        if (!Array.isArray(world_names) || world_names.length === 0) {
            $select.html('<option value="">' + escapeHtml(tr('dle_wiz_import_no_lorebooks_opt', 'No lorebooks available')) + '</option>');
            return;
        }
        let options = '<option value="">' + escapeHtml(tr('dle_wiz_import_select_lorebook_opt', '— Select a lorebook —')) + '</option>';
        for (const name of world_names) {
            options += `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`;
        }
        $select.html(options);
    } catch (err) {
        // BUG-112: log so dropdown load failures are diagnosable.
        console.debug('[DLE] Wizard lorebook dropdown load failed:', err?.message);
        $select.html('<option value="">' + escapeHtml(tr('dle_wiz_import_load_lorebooks_failed_opt', 'Failed to load lorebooks')) + '</option>');
    }
}

function buildSummary() {
    const $summary = $wizard.find('#dle-wiz-summary');
    const vaultName = $wizard.find('#dle-wiz-vault-name').val().trim() || tr('dle_wiz_summary_default_vault', 'Primary');
    const host = $wizard.find('#dle-wiz-host').val().trim() || '127.0.0.1';
    const port = $wizard.find('#dle-wiz-port').val() || '27123';

    const modeLabels = {
        keywords: tr('dle_wiz_summary_mode_keywords', 'Keywords Only'),
        'two-stage': tr('dle_wiz_summary_mode_two_stage', 'Two-Stage (keywords + AI)'),
        'ai-only': tr('dle_wiz_summary_mode_ai_only', 'AI Only'),
    };
    const modeLabel = modeLabels[searchMode] || searchMode;

    const maxEntries = $wizard.find('#dle-wiz-max-entries').val();
    const budget = $wizard.find('#dle-wiz-budget').val();

    const scanDepth = parseInt($wizard.find('#dle-wiz-scan-depth').val());
    let presetLabel = tr('dle_wiz_summary_preset_custom', 'Custom');
    for (const [name, vals] of Object.entries(PRESETS)) {
        if (vals.scanDepth === scanDepth && vals.maxEntries === parseInt(maxEntries) && vals.budget === parseInt(budget)) {
            presetLabel = name.charAt(0).toUpperCase() + name.slice(1);
            break;
        }
    }

    // BUG-139: per-feature outcomes, not the conflated compound state.
    const fieldsCreated = wizardState.fieldsOutcome === 'created' || wizardState.fieldsOutcome === 'exists';
    const sessionsCreated = wizardState.sessionsOutcome === 'created' || wizardState.sessionsOutcome === 'exists';

    // Summary lines: markup-bearing templates carry their own <strong>; interpolated
    // values are pre-escaped and substituted raw (interpolate() does not escape), so the
    // trf output is NOT re-escaped — byte-identical to the prior template-literal render.
    const items = [
        // ${0}=vaultName, ${1}=host, ${2}=port. English: 'Vault connected: <strong>${0}</strong> on ${1}:${2}'
        '<i class="fa-solid fa-circle-check"></i> ' + trf('dle_wiz_summary_vault_connected', escapeHtml(vaultName), escapeHtml(host), escapeHtml(port)),
        // ${0}=mode label. English: 'Search mode: <strong>${0}</strong>'
        '<i class="fa-solid fa-circle-check"></i> ' + trf('dle_wiz_summary_search_mode', escapeHtml(modeLabel)),
        // ${0}=preset label, ${1}=max entries, ${2}=budget. English: 'Matching: <strong>${0} preset</strong> (${1} entries, ${2} token budget)'
        '<i class="fa-solid fa-circle-check"></i> ' + trf('dle_wiz_summary_matching', escapeHtml(presetLabel), maxEntries, budget),
    ];

    if (fieldsCreated) items.push('<i class="fa-solid fa-circle-check"></i> ' + tr('dle_wiz_summary_fields_created', 'Field definitions created'));
    if (sessionsCreated) items.push('<i class="fa-solid fa-circle-check"></i> ' + tr('dle_wiz_summary_sessions_created', 'Sessions folder created'));
    if (importResult && importResult.imported > 0) {
        // ${0}=imported count, ${1}=failed suffix. English: 'Imported <strong>${0}</strong> entries${1}'
        const failedSuffix = importResult.failed > 0 ? trf('dle_wiz_summary_import_failed_suffix', importResult.failed) : '';
        items.push('<i class="fa-solid fa-circle-check"></i> ' + trf('dle_wiz_summary_imported', importResult.imported, failedSuffix));
    }

    // #67: gate on the explicit autofill flag (+ the real demo vault name) so a user who
    // names a real vault "Demo World" doesn't get Duskfrost-specific tips.
    const vaultNameLower = vaultName.toLowerCase();
    if (wizardState.demoAutofilled || vaultNameLower.includes('duskfrost')) {
        items.push('<i class="fa-solid fa-flask"></i> ' + tr('dle_wiz_summary_demo_detected', '<strong>Demo vault detected!</strong> Try mentioning "Duskfrost" or "Bellsummit" in chat to see lore injection.'));
        items.push('<i class="fa-solid fa-lightbulb"></i> ' + tr('dle_wiz_summary_tip_health', 'Run <code>/dle-health</code> to see the health check (edge-case entries will flag intentional warnings)'));
        items.push('<i class="fa-solid fa-lightbulb"></i> ' + tr('dle_wiz_summary_tip_graph', 'Run <code>/dle-graph</code> to see the full relationship graph'));
    }

    $summary.html(items.map((item, i) => `<div class="dle-wizard-summary-item" style="animation-delay: ${i * 120}ms">${item}</div>`).join(''));
}

function wireDoneActions() {
    $wizard.on('click', '.dle-wizard-done-btn', function () {
        const action = $(this).data('action');
        const popup = $wizard.closest('.popup');
        if (popup.length) popup.find('.popup_ok, .popup_close').trigger('click');

        setTimeout(() => {
            switch (action) {
                case 'health': executeCommand('/dle-health'); break;
                case 'graph': executeCommand('/dle-graph'); break;
                case 'browse': executeCommand('/dle-browse'); break;
                case 'settings':
                    import('./settings-ui.js').then(m => m.openSettingsPopup?.()).catch(() => {});
                    break;
                case 'meet-emma':
                    import('../librarian/librarian-review.js')
                        .then(m => m.openLibrarianPopup(null, { mode: 'guide-firstrun' }))
                        .catch(err => console.warn('[DLE] Meet Emma open failed:', err));
                    break;
            }
        }, 300);
    });
}

async function applyWizardSettings() {
    const settings = getSettings();

    const vaultName = $wizard.find('#dle-wiz-vault-name').val().trim() || 'Primary';
    // Normalize: strip an accidentally-pasted scheme/trailing slash so a pasted
    // "http://127.0.0.1/" isn't persisted verbatim. Full host-format + SSRF checks
    // still run in validateObsidianHost at request time.
    const host = ($wizard.find('#dle-wiz-host').val().trim() || '127.0.0.1')
        .replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    // Clamp to a valid TCP port range (parseInt||default already handles blank/non-numeric).
    const port = Math.min(65535, Math.max(1, parseInt($wizard.find('#dle-wiz-port').val(), 10) || 27123));
    const apiKey = $wizard.find('#dle-wiz-api-key').val().trim();
    const useHttps = $wizard.find('#dle-wiz-https').is(':checked');

    settings.enabled = true;
    // BUG-106: update primary vault in place — overwriting the array would
    // silently destroy existing multi-vault configurations.
    const newVault = { name: vaultName, host, port, apiKey, https: useHttps, enabled: true };
    if (!settings.vaults || settings.vaults.length === 0) {
        settings.vaults = [newVault];
    } else {
        // #39: prefill reads getPrimaryVault() (first ENABLED vault, not necessarily
        // index 0). Write back to the SAME slot the user was shown so a multi-vault
        // re-run doesn't edit a different vault than the one prefilled.
        const primary = getPrimaryVault(settings);
        const idx = settings.vaults.indexOf(primary);
        Object.assign(settings.vaults[idx >= 0 ? idx : 0], newVault);
    }

    settings.lorebookTag = $wizard.find('#dle-wiz-lorebook-tag').val().trim() || 'lorebook';
    settings.constantTag = $wizard.find('#dle-wiz-constant-tag').val().trim() || 'lorebook-always';
    settings.seedTag = $wizard.find('#dle-wiz-seed-tag').val().trim() || 'lorebook-seed';
    settings.bootstrapTag = $wizard.find('#dle-wiz-bootstrap-tag').val().trim() || 'lorebook-bootstrap';

    settings.aiSearchEnabled = searchMode !== 'keywords';
    if (searchMode !== 'keywords') settings.aiSearchMode = searchMode;

    settings.scanDepth = parseInt($wizard.find('#dle-wiz-scan-depth').val()) || 6;
    settings.maxEntries = parseInt($wizard.find('#dle-wiz-max-entries').val()) || 15;
    settings.maxTokensBudget = parseInt($wizard.find('#dle-wiz-budget').val()) || 3072;
    settings.unlimitedEntries = $wizard.find('#dle-wiz-unlimited-entries').is(':checked');
    settings.unlimitedBudget = $wizard.find('#dle-wiz-unlimited-budget').is(':checked');
    settings.fuzzySearchEnabled = $wizard.find('#dle-wiz-fuzzy').is(':checked');

    if (searchMode !== 'keywords') {
        const aiMode = $wizard.find('input[name="dle-wiz-ai-mode"]:checked').val();
        const wizardProfileId = $wizard.find('#dle-wiz-ai-profile').val() || '';
        // The wizard only offers profile mode, so a user already on Direct API
        // (configured in DLE Settings → Setup → AI Connections) who re-runs the
        // wizard would be silently switched back to an empty profile binding and
        // lose AI search until they noticed. Only take the wizard's answer when
        // they actually picked a profile here; otherwise leave their connection
        // alone.
        const keepDirect = settings.aiSearchConnectionMode === 'direct' && !wizardProfileId;
        if (!keepDirect) {
            settings.aiSearchConnectionMode = aiMode || 'profile';
            if (aiMode === 'profile') {
                settings.aiSearchProfileId = wizardProfileId;
            } else {
                settings.aiSearchProxyUrl = $wizard.find('#dle-wiz-ai-proxy-url').val().trim() || 'http://127.0.0.1:42069';
                settings.aiSearchModel = $wizard.find('#dle-wiz-ai-model').val().trim() || '';
            }
        }
    }

    settings.librarianEnabled = $wizard.find('#dle-wiz-librarian-enabled').is(':checked');
    settings.librarianSearchEnabled = $wizard.find('#dle-wiz-librarian-search').is(':checked');
    settings.librarianFlagEnabled = $wizard.find('#dle-wiz-librarian-flag').is(':checked');

    // BUG-125: localStorage sentinel guards against saveSettingsDebounced
    // crashing before flush — without it, wizard re-triggers on next load.
    settings._wizardCompleted = true;
    try { localStorage.setItem('dle-wizard-completed', '1'); } catch { /* noop */ }
    // SKIP/RESUME: completion supersedes any prior skip — drop the skip sentinel so a
    // re-run starts on page 1 and init() reads a clean "completed" truth.
    clearWizardSkip();

    invalidateSettingsCache();
    saveSettingsDebounced();

    setIndexTimestamp(0);
    await buildIndex();
}

function executeCommand(cmd) {
    const ctx = typeof SillyTavern !== 'undefined' && SillyTavern.getContext ? SillyTavern.getContext() : null;
    if (ctx?.executeSlashCommands) {
        ctx.executeSlashCommands(cmd).catch(err => console.error('[DLE] Wizard command error:', cmd, err));
    }
}

