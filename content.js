import { eventSource, event_types, saveSettingsDebounced } from "../../../../script.js";
import { extension_settings, getContext } from "../../../extensions.js";
import { callGenericPopup, POPUP_TYPE } from "../../../popup.js";
import { MacrosParser } from "../../../macros.js";

// Local module imports
import { Analyzer } from "./analyzer.js";

// Check if required dependencies are available
if (typeof MacrosParser === 'undefined') {
    console.error('[ProsePolisher] MacrosParser is not available. Macro functionality will be disabled.');
}

// 1. CONFIGURATION AND STATE
// -----------------------------------------------------------------------------
export const EXTENSION_NAME = "ProsePolisher";
const LOG_PREFIX = `[${EXTENSION_NAME}]`;
const EXTENSION_FOLDER_PATH = `scripts/extensions/third-party/${EXTENSION_NAME}`;

// --- State Variables ---
let prosePolisherAnalyzer = null;
let processedMessageIds = new Set();

// --- CONSTANTS ---
const defaultSettings = {
    // Analyzer settings
    ngramMax: 10,
    slopThreshold: 3.0,
    decayRate: 10,
    decayInterval: 10,
    patternMinCommon: 3,
    whitelist: [],
    blacklist: {},
    // Advanced analysis toggles
    maskNames: true,
    enableBigrams: false,
    allowSkipGrams: true,
    patternTypes: { prefix: true, suffix: true, middle: true },
    includeStandalonePhrases: true,
    useSignificance: true,
    significanceWeight: 0.2,
    // Performance settings
    autoAnalyze: false, // Disabled by default for performance
    analysisInterval: 50, // Messages between automatic analyses
    messageLimit: -1, // Number of recent messages to analyze (-1 for all)
};

// --- Extension State ---
function getSettings() {
    if (!extension_settings.ProsePolisher) {
        extension_settings.ProsePolisher = structuredClone(defaultSettings);
    }
    const settings = extension_settings.ProsePolisher;
    
    // Migration for any old settings
    if (settings.isStaticEnabled !== undefined) delete settings.isStaticEnabled;
    if (settings.isDynamicEnabled !== undefined) delete settings.isDynamicEnabled;
    if (settings.dynamicRules !== undefined) delete settings.dynamicRules;
    if (settings.dynamicTriggerCount !== undefined) delete settings.dynamicTriggerCount;
    if (settings.skipTriageCheck !== undefined) delete settings.skipTriageCheck;
    if (settings.regexGenerationMethod !== undefined) delete settings.regexGenerationMethod;
    if (settings.regexGeneratorRole !== undefined) delete settings.regexGeneratorRole;
    if (settings.regexTwinsCycles !== undefined) delete settings.regexTwinsCycles;
    
    // Migrate pruningCycle to decayInterval if it exists
    if (settings.pruningCycle !== undefined) {
        settings.decayInterval = settings.pruningCycle;
        delete settings.pruningCycle;
    }
    
    // Ensure new settings have defaults (migrate older settings objects)
    if (settings.decayRate === undefined) settings.decayRate = defaultSettings.decayRate;
    if (settings.decayInterval === undefined) settings.decayInterval = defaultSettings.decayInterval;
    if (settings.maskNames === undefined) settings.maskNames = defaultSettings.maskNames;
    if (settings.enableBigrams === undefined) settings.enableBigrams = defaultSettings.enableBigrams;
    if (settings.allowSkipGrams === undefined) settings.allowSkipGrams = defaultSettings.allowSkipGrams;
    if (!settings.patternTypes) settings.patternTypes = structuredClone(defaultSettings.patternTypes);
    if (settings.includeStandalonePhrases === undefined) settings.includeStandalonePhrases = defaultSettings.includeStandalonePhrases;
    if (settings.useSignificance === undefined) settings.useSignificance = defaultSettings.useSignificance;
    if (settings.significanceWeight === undefined) settings.significanceWeight = defaultSettings.significanceWeight;
    if (settings.autoAnalyze === undefined) settings.autoAnalyze = defaultSettings.autoAnalyze;
    if (settings.analysisInterval === undefined) settings.analysisInterval = defaultSettings.analysisInterval;
    if (settings.messageLimit === undefined) settings.messageLimit = defaultSettings.messageLimit;

    return settings;
}

// 2. INITIALIZATION
// -----------------------------------------------------------------------------

function loadAndApplySettings() {
    const settings = getSettings();
    
    // Apply all non-UI settings
    if (prosePolisherAnalyzer) {
        prosePolisherAnalyzer.settings = settings;
        prosePolisherAnalyzer.updateEffectiveWhitelist();
    }
    
    console.log(`${LOG_PREFIX} Settings loaded and applied:`, {
        ngramMax: settings.ngramMax,
        slopThreshold: settings.slopThreshold,
        decayRate: settings.decayRate,
        decayInterval: settings.decayInterval,
        patternMinCommon: settings.patternMinCommon,
        maskNames: settings.maskNames,
        enableBigrams: settings.enableBigrams,
        allowSkipGrams: settings.allowSkipGrams,
        patternTypes: settings.patternTypes,
        includeStandalonePhrases: settings.includeStandalonePhrases,
        useSignificance: settings.useSignificance,
        significanceWeight: settings.significanceWeight,
    });
}

// 3. CORE FUNCTIONALITY
// -----------------------------------------------------------------------------
function initializeAnalyzer() {
    const settings = getSettings();
    prosePolisherAnalyzer = new Analyzer(
        settings,
        callGenericPopup,
        POPUP_TYPE,
        toastr,
        saveSettingsDebounced,
    );
    
    // Register/update the slopList macro as a dynamic function returning fresh JSON each time
    const updateSlopListMacro = () => {
        if (typeof MacrosParser !== 'undefined' && MacrosParser.registerMacro) {
            try {
                // Refresh cache first; macro returns cached JSON string to avoid heavy work at expansion time
                if (prosePolisherAnalyzer && typeof prosePolisherAnalyzer.refreshSlopListCache === 'function') {
                    prosePolisherAnalyzer.refreshSlopListCache();
                }
                MacrosParser.registerMacro('slopList', () => {
                    try {
                        return prosePolisherAnalyzer?.slopListCacheString || '[]';
                    } catch (innerErr) {
                        console.error(`${LOG_PREFIX} Error generating slopList macro content:`, innerErr);
                        return '[]';
                    }
                }, 'Prose Polisher: JSON list of detected repetitive phrases/patterns');
                console.log(`${LOG_PREFIX} Registered/updated dynamic slopList macro`);
            } catch (err) {
                console.error(`${LOG_PREFIX} Failed to register slopList macro:`, err);
            }
        }
    };
    
    // Hook into analyzer to update macro when data changes
    // OPTIMIZATION: Debounce the macro update to prevent rapid updates
    const originalPerformAnalysis = prosePolisherAnalyzer.performIntermediateAnalysis.bind(prosePolisherAnalyzer);
    prosePolisherAnalyzer.performIntermediateAnalysis = function() {
        originalPerformAnalysis();
        // Use debounced update instead of immediate update
        debouncedMacroUpdate();
    };
    
    // Store reference to updateSlopListMacro for external use
    // CRITICAL: Wrap in try-catch to prevent freezing on macro errors
    prosePolisherAnalyzer.updateSlopListMacro = () => {
        if (prosePolisherAnalyzer.isUpdatingMacro) {
            return;
        }

        prosePolisherAnalyzer.isUpdatingMacro = true;
        try {
            updateSlopListMacro();
        } catch (error) {
            console.error(`${LOG_PREFIX} Error updating macro:`, error);
        } finally {
            // Ensure flag is always reset even if there's an error
            prosePolisherAnalyzer.isUpdatingMacro = false;
        }
    };
    
    // Initialize the dynamic macro (returns empty until analysis is available)
    updateSlopListMacro();
    
    console.log(`${LOG_PREFIX} Analyzer initialized.`);
}

// 4. UI FUNCTIONS
// -----------------------------------------------------------------------------
function setupUI() {
    const settings = getSettings();
    const settingsHtml = `
    <div class="prose-polisher-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Prose Polisher</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="prose-polisher-container">
                    <h3>Slop Detection Settings</h3>
                    <div class="prose-polisher-settings-group">
                        <div class="range-block">
                            <label for="pp-ngram-max" title="Maximum phrase length to analyze - longer phrases may be more meaningful but require more processing">
                                <span>Max N-gram Size</span>
                            </label>
                            <div class="alignitemscenter flex-container flexFlowColumn flexBasis30p flexGrow flexShrink gap0">
                                <input type="range" id="pp-ngram-max" class="neo-range-slider" min="3" max="15" value="${settings.ngramMax}" step="1">
                                <input type="number" id="pp-ngram-max-counter" class="neo-range-input" min="3" max="15" value="${settings.ngramMax}" step="1">
                            </div>
                        </div>
                        <div class="range-block">
                            <label for="pp-slop-threshold" title="Score threshold for flagging phrases as repetitive slop - lower values catch more phrases">
                                <span>Slop Threshold</span>
                            </label>
                            <div class="alignitemscenter flex-container flexFlowColumn flexBasis30p flexGrow flexShrink gap0">
                                <input type="range" id="pp-slop-threshold" class="neo-range-slider" min="1" max="10" value="${settings.slopThreshold}" step="0.1">
                                <input type="number" id="pp-slop-threshold-counter" class="neo-range-input" min="1" max="10" value="${settings.slopThreshold}" step="0.1">
                            </div>
                        </div>
                        <div class="range-block">
                            <label for="pp-decay-rate" title="Percentage by which old phrase scores decay (0-50%)">
                                <span>Score Decay Rate (%)</span>
                            </label>
                            <div class="alignitemscenter flex-container flexFlowColumn flexBasis30p flexGrow flexShrink gap0">
                                <input type="range" id="pp-decay-rate" class="neo-range-slider" min="0" max="50" value="${settings.decayRate}" step="5">
                                <input type="number" id="pp-decay-rate-counter" class="neo-range-input" min="0" max="50" value="${settings.decayRate}" step="5">
                            </div>
                        </div>
                        <div class="range-block">
                            <label for="pp-decay-interval" title="Number of messages between each decay application">
                                <span>Decay Interval (messages)</span>
                            </label>
                            <div class="alignitemscenter flex-container flexFlowColumn flexBasis30p flexGrow flexShrink gap0">
                                <input type="range" id="pp-decay-interval" class="neo-range-slider" min="5" max="50" value="${settings.decayInterval}" step="5">
                                <input type="number" id="pp-decay-interval-counter" class="neo-range-input" min="5" max="50" value="${settings.decayInterval}" step="5">
                            </div>
                        </div>
                        <div class="range-block">
                            <label for="pp-pattern-min-common" title="Minimum common words needed to merge similar phrases into patterns">
                                <span>Pattern Min Common Words</span>
                            </label>
                            <div class="alignitemscenter flex-container flexFlowColumn flexBasis30p flexGrow flexShrink gap0">
                                <input type="range" id="pp-pattern-min-common" class="neo-range-slider" min="2" max="5" value="${settings.patternMinCommon}" step="1">
                                <input type="number" id="pp-pattern-min-common-counter" class="neo-range-input" min="2" max="5" value="${settings.patternMinCommon}" step="1">
                            </div>
                        </div>
                    </div>
                    
                    <h3>Performance Settings</h3>
                    <div class="prose-polisher-settings-group">
                        <label class="checkbox_label" for="pp-auto-analyze">
                            <input type="checkbox" id="pp-auto-analyze" ${settings.autoAnalyze ? 'checked' : ''}>
                            <span>Auto-analyze messages (may cause lag)</span>
                        </label>
                        <div class="range-block" id="pp-analysis-interval-container" style="${!settings.autoAnalyze ? 'display: none;' : ''}">
                            <label for="pp-analysis-interval" title="Number of messages between automatic analyses">
                                <span>Analysis Interval</span>
                            </label>
                            <div class="alignitemscenter flex-container flexFlowColumn flexBasis30p flexGrow flexShrink gap0">
                                <input type="range" id="pp-analysis-interval" class="neo-range-slider" min="10" max="100" value="${settings.analysisInterval}" step="10">
                                <input type="number" id="pp-analysis-interval-counter" class="neo-range-input" min="10" max="100" value="${settings.analysisInterval}" step="10">
                            </div>
                        </div>
                        <div class="range-block">
                            <label for="pp-message-limit" title="Number of recent messages to analyze (-1 for all messages)">
                                <span>Message Limit</span>
                            </label>
                            <div class="alignitemscenter flex-container flexFlowColumn flexBasis30p flexGrow flexShrink gap0">
                                <input type="range" id="pp-message-limit" class="neo-range-slider" min="-1" max="200" value="${settings.messageLimit}" step="10">
                                <input type="number" id="pp-message-limit-counter" class="neo-range-input" min="-1" max="1000" value="${settings.messageLimit}" step="1">
                            </div>
                            <small style="display: block; margin-top: 5px; opacity: 0.8;">Set to -1 to analyze entire chat history, or specify a number to only analyze the last N messages</small>
                        </div>
                    </div>
                    
                    <h3>Analysis Tools</h3>
                    <div class="flex-container flexGap10">
                        <button id="pp-analyze-chat" class="menu_button w-auto gap5px">
                            <i class="fa-solid fa-magnifying-glass-chart"></i>
                            <span>Analyze Chat History</span>
                        </button>
                        <button id="pp-view-frequency" class="menu_button w-auto gap5px">
                            <i class="fa-solid fa-chart-line"></i>
                            <span>View Frequency Data</span>
                        </button>
                        <button id="pp-clear-frequency" class="menu_button w-auto gap5px">
                            <i class="fa-solid fa-trash-can"></i>
                            <span>Clear Frequency Data</span>
                        </button>
                    </div>
                    
                    <h3>List Management</h3>
                    <div class="flex-container flexGap10">
                        <button id="pp-whitelist-manager" class="menu_button w-auto gap5px">
                            <i class="fa-solid fa-shield-check"></i>
                            <span>Whitelist Manager</span>
                        </button>
                        <button id="pp-blacklist-manager" class="menu_button w-auto gap5px">
                            <i class="fa-solid fa-ban"></i>
                            <span>Blacklist Manager</span>
                        </button>
                    </div>
                    
                    <div class="margin-bot-10px">
                        <small>
                            <b>How it works:</b> Analyzes AI messages for repetitive phrases ("slop"), detects patterns in similar phrases, and saves results to <code>{{slopList}}</code> macro for use in prompts.
                        </small>
                    </div>
            </div>
        </div>
    </div>`;
    
    $('#extensions_settings').append(settingsHtml);
    
    // Event listeners for settings with validation and real-time feedback
    // OPTIMIZATION: Debounce setting changes to prevent rapid updates
    let settingUpdateTimeout;
    const debouncedSettingUpdate = (callback) => {
        clearTimeout(settingUpdateTimeout);
        settingUpdateTimeout = setTimeout(callback, 300);
    };

    $('#pp-ngram-max').on('input', function() {
        const value = parseInt($(this).val());
        $('#pp-ngram-max-counter').val(value);
        debouncedSettingUpdate(() => {
            const settings = getSettings();
            if (value >= 3 && value <= 15) {
                settings.ngramMax = value;
                saveSettingsDebounced();
                if (prosePolisherAnalyzer) {
                    prosePolisherAnalyzer.settings = settings;
                    prosePolisherAnalyzer.updateEffectiveWhitelist();
                }
                console.log(`${LOG_PREFIX} Updated ngramMax setting to ${value}`);
            }
        });
    });
    
    $('#pp-ngram-max-counter').on('input', function() {
        const value = parseInt($(this).val());
        $('#pp-ngram-max').val(value);
        debouncedSettingUpdate(() => {
            const settings = getSettings();
            if (value >= 3 && value <= 15) {
                settings.ngramMax = value;
                saveSettingsDebounced();
                if (prosePolisherAnalyzer) {
                    prosePolisherAnalyzer.settings = settings;
                    prosePolisherAnalyzer.updateEffectiveWhitelist();
                }
                console.log(`${LOG_PREFIX} Updated ngramMax setting to ${value}`);
            }
        });
    });
    
    $('#pp-slop-threshold').on('input', function() {
        const value = parseFloat($(this).val());
        $('#pp-slop-threshold-counter').val(value);
        debouncedSettingUpdate(() => {
            const settings = getSettings();
            if (value >= 1 && value <= 10) {
                settings.slopThreshold = value;
                saveSettingsDebounced();
                if (prosePolisherAnalyzer) {
                    prosePolisherAnalyzer.settings = settings;
                }
                console.log(`${LOG_PREFIX} Updated slopThreshold setting to ${value}`);
            }
        });
    });
    
    $('#pp-slop-threshold-counter').on('input', function() {
        const value = parseFloat($(this).val());
        $('#pp-slop-threshold').val(value);
        debouncedSettingUpdate(() => {
            const settings = getSettings();
            if (value >= 1 && value <= 10) {
                settings.slopThreshold = value;
                saveSettingsDebounced();
                if (prosePolisherAnalyzer) {
                    prosePolisherAnalyzer.settings = settings;
                }
                console.log(`${LOG_PREFIX} Updated slopThreshold setting to ${value}`);
            }
        });
    });
    
    $('#pp-decay-rate').on('input', function() {
        const value = parseInt($(this).val());
        $('#pp-decay-rate-counter').val(value);
        debouncedSettingUpdate(() => {
            const settings = getSettings();
            if (value >= 0 && value <= 50) {
                settings.decayRate = value;
                saveSettingsDebounced();
                if (prosePolisherAnalyzer) {
                    prosePolisherAnalyzer.settings = settings;
                }
                console.log(`${LOG_PREFIX} Updated decayRate setting to ${value}`);
            }
        });
    });
    
    $('#pp-decay-rate-counter').on('input', function() {
        const value = parseInt($(this).val());
        $('#pp-decay-rate').val(value);
        debouncedSettingUpdate(() => {
            const settings = getSettings();
            if (value >= 0 && value <= 50) {
                settings.decayRate = value;
                saveSettingsDebounced();
                if (prosePolisherAnalyzer) {
                    prosePolisherAnalyzer.settings = settings;
                }
                console.log(`${LOG_PREFIX} Updated decayRate setting to ${value}`);
            }
        });
    });
    
    $('#pp-decay-interval').on('input', function() {
        const value = parseInt($(this).val());
        $('#pp-decay-interval-counter').val(value);
        debouncedSettingUpdate(() => {
            const settings = getSettings();
            if (value >= 5 && value <= 50) {
                settings.decayInterval = value;
                saveSettingsDebounced();
                if (prosePolisherAnalyzer) {
                    prosePolisherAnalyzer.settings = settings;
                }
                console.log(`${LOG_PREFIX} Updated decayInterval setting to ${value}`);
            }
        });
    });
    
    $('#pp-decay-interval-counter').on('input', function() {
        const value = parseInt($(this).val());
        $('#pp-decay-interval').val(value);
        debouncedSettingUpdate(() => {
            const settings = getSettings();
            if (value >= 5 && value <= 50) {
                settings.decayInterval = value;
                saveSettingsDebounced();
                if (prosePolisherAnalyzer) {
                    prosePolisherAnalyzer.settings = settings;
                }
                console.log(`${LOG_PREFIX} Updated decayInterval setting to ${value}`);
            }
        });
    });
    
    $('#pp-pattern-min-common').on('input', function() {
        const value = parseInt($(this).val());
        $('#pp-pattern-min-common-counter').val(value);
        debouncedSettingUpdate(() => {
            const settings = getSettings();
            if (value >= 2 && value <= 5) {
                settings.patternMinCommon = value;
                saveSettingsDebounced();
                if (prosePolisherAnalyzer) {
                    prosePolisherAnalyzer.settings = settings;
                }
                console.log(`${LOG_PREFIX} Updated patternMinCommon setting to ${value}`);
            }
        });
    });

    // Advanced analysis toggles UI
    // Inject controls after existing Performance Settings block
    const advancedHtml = `
        <h3>Advanced Analysis</h3>
        <div class="prose-polisher-settings-group">
            <label class="checkbox_label" for="pp-mask-names">
                <input type="checkbox" id="pp-mask-names" ${getSettings().maskNames ? 'checked' : ''}>
                <span>Mask names/whitelist as placeholders</span>
            </label>
            <label class="checkbox_label" for="pp-enable-bigrams">
                <input type="checkbox" id="pp-enable-bigrams" ${getSettings().enableBigrams ? 'checked' : ''}>
                <span>Enable bigram tics (significance-weighted)</span>
            </label>
            <label class="checkbox_label" for="pp-allow-skipgrams">
                <input type="checkbox" id="pp-allow-skipgrams" ${getSettings().allowSkipGrams ? 'checked' : ''}>
                <span>Allow skip-gram modifiers when matching</span>
            </label>
            <label class="checkbox_label" for="pp-use-significance">
                <input type="checkbox" id="pp-use-significance" ${getSettings().useSignificance ? 'checked' : ''}>
                <span>Use significance weighting (PMI)</span>
            </label>
            <div class="range-block">
                <label for="pp-significance-weight" title="Weight of significance signal in final score">
                    <span>Significance Weight</span>
                </label>
                <div class="alignitemscenter flex-container flexFlowColumn flexBasis30p flexGrow flexShrink gap0">
                    <input type="range" id="pp-significance-weight" class="neo-range-slider" min="0" max="0.6" value="${getSettings().significanceWeight}" step="0.05">
                    <input type="number" id="pp-significance-weight-counter" class="neo-range-input" min="0" max="0.6" value="${getSettings().significanceWeight}" step="0.05">
                </div>
            </div>
            <div class="flex-container flexGap10">
                <div>
                    <strong>Pattern Types:</strong>
                </div>
                <label class="checkbox_label" for="pp-pattern-prefix">
                    <input type="checkbox" id="pp-pattern-prefix" ${getSettings().patternTypes?.prefix ? 'checked' : ''}>
                    <span>Prefix</span>
                </label>
                <label class="checkbox_label" for="pp-pattern-suffix">
                    <input type="checkbox" id="pp-pattern-suffix" ${getSettings().patternTypes?.suffix ? 'checked' : ''}>
                    <span>Suffix</span>
                </label>
                <label class="checkbox_label" for="pp-pattern-middle">
                    <input type="checkbox" id="pp-pattern-middle" ${getSettings().patternTypes?.middle ? 'checked' : ''}>
                    <span>Middle slot</span>
                </label>
            </div>
            <label class="checkbox_label" for="pp-include-standalone">
                <input type="checkbox" id="pp-include-standalone" ${getSettings().includeStandalonePhrases ? 'checked' : ''}>
                <span>Include standalone phrases (stricter threshold)</span>
            </label>
        </div>`;
    $(advancedHtml).insertAfter($('#extensions_settings .prose-polisher-settings-group').last());

    $('#pp-mask-names').on('change', function() {
        const settings = getSettings();
        settings.maskNames = $(this).prop('checked');
        saveSettingsDebounced();
        if (prosePolisherAnalyzer) prosePolisherAnalyzer.settings = settings;
        console.log(`${LOG_PREFIX} Updated maskNames to ${settings.maskNames}`);
    });

    $('#pp-enable-bigrams').on('change', function() {
        const settings = getSettings();
        settings.enableBigrams = $(this).prop('checked');
        saveSettingsDebounced();
        if (prosePolisherAnalyzer) prosePolisherAnalyzer.settings = settings;
        console.log(`${LOG_PREFIX} Updated enableBigrams to ${settings.enableBigrams}`);
    });

    $('#pp-allow-skipgrams').on('change', function() {
        const settings = getSettings();
        settings.allowSkipGrams = $(this).prop('checked');
        saveSettingsDebounced();
        if (prosePolisherAnalyzer) prosePolisherAnalyzer.settings = settings;
        console.log(`${LOG_PREFIX} Updated allowSkipGrams to ${settings.allowSkipGrams}`);
    });

    $('#pp-use-significance').on('change', function() {
        const settings = getSettings();
        settings.useSignificance = $(this).prop('checked');
        saveSettingsDebounced();
        if (prosePolisherAnalyzer) prosePolisherAnalyzer.settings = settings;
        console.log(`${LOG_PREFIX} Updated useSignificance to ${settings.useSignificance}`);
    });

    $('#pp-significance-weight, #pp-significance-weight-counter').on('input', function() {
        const slider = $('#pp-significance-weight');
        const input = $('#pp-significance-weight-counter');
        const value = parseFloat($(this).val());
        slider.val(value);
        input.val(value);
        const settings = getSettings();
        settings.significanceWeight = Math.max(0, Math.min(0.6, value));
        saveSettingsDebounced();
        if (prosePolisherAnalyzer) prosePolisherAnalyzer.settings = settings;
        console.log(`${LOG_PREFIX} Updated significanceWeight to ${settings.significanceWeight}`);
    });

    $('#pp-pattern-prefix, #pp-pattern-suffix, #pp-pattern-middle').on('change', function() {
        const settings = getSettings();
        settings.patternTypes = settings.patternTypes || { prefix: true, suffix: true, middle: true };
        settings.patternTypes.prefix = $('#pp-pattern-prefix').prop('checked');
        settings.patternTypes.suffix = $('#pp-pattern-suffix').prop('checked');
        settings.patternTypes.middle = $('#pp-pattern-middle').prop('checked');
        saveSettingsDebounced();
        if (prosePolisherAnalyzer) prosePolisherAnalyzer.settings = settings;
        console.log(`${LOG_PREFIX} Updated patternTypes to`, settings.patternTypes);
    });

    $('#pp-include-standalone').on('change', function() {
        const settings = getSettings();
        settings.includeStandalonePhrases = $(this).prop('checked');
        saveSettingsDebounced();
        if (prosePolisherAnalyzer) prosePolisherAnalyzer.settings = settings;
        console.log(`${LOG_PREFIX} Updated includeStandalonePhrases to ${settings.includeStandalonePhrases}`);
    });

    $('#pp-pattern-min-common-counter').on('input', function() {
        const value = parseInt($(this).val());
        $('#pp-pattern-min-common').val(value);
        debouncedSettingUpdate(() => {
            const settings = getSettings();
            if (value >= 2 && value <= 5) {
                settings.patternMinCommon = value;
                saveSettingsDebounced();
                if (prosePolisherAnalyzer) {
                    prosePolisherAnalyzer.settings = settings;
                }
                console.log(`${LOG_PREFIX} Updated patternMinCommon setting to ${value}`);
            }
        });
    });
    
    // Auto-analyze checkbox handler
    $('#pp-auto-analyze').on('change', function() {
        const settings = getSettings();
        settings.autoAnalyze = $(this).prop('checked');
        saveSettingsDebounced();
        
        // Toggle interval controls visibility
        $('#pp-analysis-interval-container').toggle(settings.autoAnalyze);
        
        // Set up or remove event listeners based on setting
        if (settings.autoAnalyze) {
            setupAutoAnalysisListeners();
            console.log(`${LOG_PREFIX} Auto-analysis enabled`);
        } else {
            removeAutoAnalysisListeners();
            console.log(`${LOG_PREFIX} Auto-analysis disabled`);
        }
    });
    
    // Analysis interval handlers
    $('#pp-analysis-interval').on('input', function() {
        const value = parseInt($(this).val());
        $('#pp-analysis-interval-counter').val(value);
        debouncedSettingUpdate(() => {
            const settings = getSettings();
            if (value >= 10 && value <= 100) {
                settings.analysisInterval = value;
                saveSettingsDebounced();
                console.log(`${LOG_PREFIX} Updated analysisInterval to ${value}`);
            }
        });
    });
    
    $('#pp-analysis-interval-counter').on('input', function() {
        const value = parseInt($(this).val());
        $('#pp-analysis-interval').val(value);
        debouncedSettingUpdate(() => {
            const settings = getSettings();
            if (value >= 10 && value <= 100) {
                settings.analysisInterval = value;
                saveSettingsDebounced();
                console.log(`${LOG_PREFIX} Updated analysisInterval to ${value}`);
            }
        });
    });
    
    // Message limit handlers
    $('#pp-message-limit').on('input', function() {
        const value = parseInt($(this).val());
        $('#pp-message-limit-counter').val(value);
        debouncedSettingUpdate(() => {
            const settings = getSettings();
            if (value >= -1) {
                settings.messageLimit = value;
                saveSettingsDebounced();
                console.log(`${LOG_PREFIX} Updated messageLimit to ${value}`);
            }
        });
    });
    
    $('#pp-message-limit-counter').on('input', function() {
        const value = parseInt($(this).val());
        // Clamp slider to max 200 for reasonable range
        $('#pp-message-limit').val(Math.min(value, 200));
        debouncedSettingUpdate(() => {
            const settings = getSettings();
            if (value >= -1) {
                settings.messageLimit = value;
                saveSettingsDebounced();
                console.log(`${LOG_PREFIX} Updated messageLimit to ${value}`);
            }
        });
    });
    
    // Action buttons
    $('#pp-analyze-chat').on('click', async () => {
        if (prosePolisherAnalyzer) {
            await prosePolisherAnalyzer.manualAnalyzeChatHistory();
            // Macro update is handled inside manualAnalyzeChatHistory
        }
    });
    
    $('#pp-view-frequency').on('click', () => {
        if (prosePolisherAnalyzer) {
            prosePolisherAnalyzer.showFrequencyLeaderboard();
        }
    });
    
    $('#pp-clear-frequency').on('click', () => {
        if (prosePolisherAnalyzer) {
            prosePolisherAnalyzer.clearFrequencyData();
            // Ensure macro remains registered dynamically (will return [] until data exists)
            prosePolisherAnalyzer.updateSlopListMacro?.();
        }
    });
    
    $('#pp-whitelist-manager').on('click', () => {
        if (prosePolisherAnalyzer) {
            prosePolisherAnalyzer.showWhitelistManager();
        }
    });
    
    $('#pp-blacklist-manager').on('click', () => {
        if (prosePolisherAnalyzer) {
            prosePolisherAnalyzer.showBlacklistManager();
        }
    });
    
    // Load current settings into UI - values already set in HTML template
    // No need to set again since we use settings values directly in template
}

// 5. EVENT HANDLERS
// -----------------------------------------------------------------------------

// Auto-analysis event handlers (only attached when enabled)
let messageReceivedHandler = null;
let messageSwipedHandler = null;
let generationStartedHandler = null;

function setupAutoAnalysisListeners() {
    const settings = getSettings();
    
    if (!settings.autoAnalyze) return;
    
    // Create handlers if they don't exist
    if (!messageReceivedHandler) {
        messageReceivedHandler = (messageId) => handleIncomingMessage(messageId);
    }
    if (!messageSwipedHandler) {
        messageSwipedHandler = (messageId) => handleIncomingMessage(messageId);
    }
    if (!generationStartedHandler) {
        generationStartedHandler = async (type, options, dryRun) => {
            if (dryRun) return;
            if (prosePolisherAnalyzer && !prosePolisherAnalyzer.isAnalyzingHistory) {
                await performSilentChatAnalysis();
                console.log(`${LOG_PREFIX} Updated slop analysis before generation`);
            }
        };
    }
    
    // Attach listeners
    eventSource.on(event_types.MESSAGE_RECEIVED, messageReceivedHandler);
    eventSource.on(event_types.MESSAGE_SWIPED, messageSwipedHandler);
    eventSource.on(event_types.GENERATION_STARTED, generationStartedHandler);
}

function removeAutoAnalysisListeners() {
    // Remove listeners if they exist
    if (messageReceivedHandler) {
        eventSource.off(event_types.MESSAGE_RECEIVED, messageReceivedHandler);
    }
    if (messageSwipedHandler) {
        eventSource.off(event_types.MESSAGE_SWIPED, messageSwipedHandler);
    }
    if (generationStartedHandler) {
        eventSource.off(event_types.GENERATION_STARTED, generationStartedHandler);
    }
}

// Debounced function to update macro to prevent excessive updates
let macroUpdateTimeout;
const debouncedMacroUpdate = () => {
    if (macroUpdateTimeout) {
        clearTimeout(macroUpdateTimeout);
    }
    macroUpdateTimeout = setTimeout(() => {
        if (prosePolisherAnalyzer && prosePolisherAnalyzer.updateSlopListMacro) {
            prosePolisherAnalyzer.updateSlopListMacro();
        }
    }, 5000); // OPTIMIZATION: Increased debounce to 5 seconds to reduce freezing
};

async function handleIncomingMessage(messageId) {
    if (!prosePolisherAnalyzer) return;
    
    const context = getContext();
    if (!context || !context.chat || !messageId) return;
    
    const messageIndex = parseInt(messageId);
    if (isNaN(messageIndex) || messageIndex < 0 || messageIndex >= context.chat.length) return;
    
    const message = context.chat[messageIndex];
    if (!message || !message.mes || message.is_user) return;
    
    // Skip if already processed
    const uniqueId = `${messageIndex}_${message.swipe_id || 0}`;
    if (processedMessageIds.has(uniqueId)) return;
    
    processedMessageIds.add(uniqueId);
    
    // Analyze the message
    prosePolisherAnalyzer.analyzeAndTrackFrequency(message.mes);
    prosePolisherAnalyzer.incrementProcessedMessages();
    
    // Apply decay to old phrase scores periodically
    // OPTIMIZATION: Run decay check less frequently to reduce overhead
    if (prosePolisherAnalyzer.totalAiMessagesProcessed % 30 === 0) {
        prosePolisherAnalyzer.pruneOldNgrams(); // This now only applies decay, no pruning
    }
    
    // Use configurable analysis interval
    const settings = getSettings();
    const analysisInterval = settings.analysisInterval || 50;
    if (prosePolisherAnalyzer.totalAiMessagesProcessed % analysisInterval === 0) {
        prosePolisherAnalyzer.performIntermediateAnalysis();
    }
    
    // Debounced macro update
    debouncedMacroUpdate();
}

// Silent version of chat history analysis for pre-generation
async function performSilentChatAnalysis() {
    if (!prosePolisherAnalyzer) return;

    const context = getContext();
    if (!context || !context.chat) return;

    // Check if we have enough AI messages to analyze
    const aiMessageCount = context.chat.filter(msg => !msg.is_user && msg.mes).length;
    if (aiMessageCount === 0) {
        console.log(`${LOG_PREFIX} Silent analysis skipped - no AI messages in chat history.`);
        // Clear data to ensure macro returns empty
        prosePolisherAnalyzer.ngramFrequencies.clear();
        prosePolisherAnalyzer.slopCandidates.clear();
        prosePolisherAnalyzer.analyzedLeaderboardData = { merged: {}, remaining: {} };
        prosePolisherAnalyzer.messageCounterForTrigger = 0;
        prosePolisherAnalyzer.totalAiMessagesProcessed = 0;
        prosePolisherAnalyzer.lastAnalysisMessageCount = 0;
        if (prosePolisherAnalyzer.unigramCounts) prosePolisherAnalyzer.unigramCounts.clear();
        if (prosePolisherAnalyzer.bigramCounts) prosePolisherAnalyzer.bigramCounts.clear();
        prosePolisherAnalyzer.totalUnigrams = 0;
        prosePolisherAnalyzer.totalBigrams = 0;
        if (prosePolisherAnalyzer.updateSlopListMacro) {
            prosePolisherAnalyzer.updateSlopListMacro();
        }
        return;
    }

    if (aiMessageCount < 5) {
        console.log(`${LOG_PREFIX} Performing silent analysis on limited data set (${aiMessageCount} AI messages). Results may be noisy.`);
    }

        try {
            // Clear existing data
            prosePolisherAnalyzer.ngramFrequencies.clear();
            prosePolisherAnalyzer.slopCandidates.clear();
            prosePolisherAnalyzer.totalAiMessagesProcessed = 0;
            prosePolisherAnalyzer.lastAnalysisMessageCount = 0; // Reset analysis tracking
            if (prosePolisherAnalyzer.unigramCounts) prosePolisherAnalyzer.unigramCounts.clear();
            if (prosePolisherAnalyzer.bigramCounts) prosePolisherAnalyzer.bigramCounts.clear();
            prosePolisherAnalyzer.totalUnigrams = 0;
            prosePolisherAnalyzer.totalBigrams = 0;
            if (prosePolisherAnalyzer.aliasKeyToBaseKey) prosePolisherAnalyzer.aliasKeyToBaseKey.clear();
            prosePolisherAnalyzer.pmiRunningMean = 0;
            prosePolisherAnalyzer.pmiCount = 0;
        
        let chatMessages = context.chat;
        
        // Apply message limit if configured
        const settings = getSettings();
        const messageLimit = settings.messageLimit || -1;
        if (messageLimit > 0) {
            // Get only the last N messages
            chatMessages = chatMessages.slice(-messageLimit);
            console.log(`${LOG_PREFIX} Silent analysis limited to last ${messageLimit} messages`);
        }
        
        let aiMessagesAnalyzed = 0;
        
        // Process AI messages in chat history
        for (const message of chatMessages) {
            if (message.is_user || !message.mes || typeof message.mes !== 'string') {
                continue;
            }
            prosePolisherAnalyzer.analyzeAndTrackFrequency(message.mes);
            aiMessagesAnalyzed++;
            prosePolisherAnalyzer.totalAiMessagesProcessed++;
        }
        
        // Apply decay before pattern analysis
        prosePolisherAnalyzer.pruneOldNgrams();
        
        // Perform pattern analysis
        prosePolisherAnalyzer.performIntermediateAnalysis();
        
        // Update macro
        if (prosePolisherAnalyzer.updateSlopListMacro) {
            prosePolisherAnalyzer.updateSlopListMacro();
        }
        
        console.log(`${LOG_PREFIX} Silent analysis complete. Analyzed ${aiMessagesAnalyzed} AI messages.`);
    } catch (error) {
        console.error(`${LOG_PREFIX} Error during silent chat analysis:`, error);
    }
}

// Export functions for use by other extensions (e.g., final-response-processor)
window.ProsePolisher = window.ProsePolisher || {};
window.ProsePolisher.performSilentAnalysis = performSilentChatAnalysis;
window.ProsePolisher.getSlopList = () => {
    if (prosePolisherAnalyzer) {
        return prosePolisherAnalyzer.getSlopList();
    }
    return [];
};
window.ProsePolisher.updateAnalysis = async () => {
    if (prosePolisherAnalyzer) {
        await performSilentChatAnalysis();
    }
};

// 6. MAIN INITIALIZATION
// -----------------------------------------------------------------------------
jQuery(async () => {
    try {
        console.log(`${LOG_PREFIX} Starting extension initialization...`);
        
        loadAndApplySettings();
        initializeAnalyzer();
        setupUI();
        
        // Only set up auto-analysis if enabled in settings
        const settings = getSettings();
        if (settings.autoAnalyze) {
            setupAutoAnalysisListeners();
            console.log(`${LOG_PREFIX} Auto-analysis enabled on startup`);
        } else {
            console.log(`${LOG_PREFIX} Auto-analysis disabled - use manual analysis button`);
        }
        
        eventSource.on(event_types.CHAT_CHANGED, () => {
            processedMessageIds.clear();
            if (prosePolisherAnalyzer) {
                prosePolisherAnalyzer.clearFrequencyData();
                // Ensure macro remains registered dynamically (returns [] until new data)
                prosePolisherAnalyzer.updateSlopListMacro?.();
                console.log(`${LOG_PREFIX} Chat changed, cleared data and reset macro`);
            }
        });
        
        // NOTE: Auto-analysis before generation is now controlled by the autoAnalyze setting
        // to prevent lag. The final-response-processor extension can still trigger
        // analysis manually via window.ProsePolisher.performSilentAnalysis()
        
        console.log(`${LOG_PREFIX} Extension loaded and initialized successfully.`);
    } catch (error) {
        console.error(`${LOG_PREFIX} Failed to initialize extension:`, error);
        toastr.error('Failed to initialize Prose Polisher extension. Check console for details.');
    }
});
