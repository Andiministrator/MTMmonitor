/**
 * Matomo Tag Manager Event Monitor - Content Script
 * Manages UI overlay, event collection, and extension communication
 *
 * @description Content script running in isolated context that handles communication
 *              between injected script and extension popup, manages event collection,
 *              and provides UI overlay for MTM event debugging
 * @version 1.3
 * @author MTM Event Monitor
 */

// =============================================================================
// CONSTANTS AND CONFIGURATION
// =============================================================================

/** @const {Object} Default configuration values */
const DEFAULT_CONFIG = {
    watchMTM: true,
    watchDataLayer: false,
    autoShow: true,
    hideMTMFrame: false,
    consoleLogging: true,
    maxEvents: 1000,
    virtualizeThreshold: 100
};

/** @const {Object} Performance settings */
const PERFORMANCE = {
    MAX_EVENTS: 1000,
    VIRTUALIZE_THRESHOLD: 100,
    DUPLICATE_TIMEOUT: 2000,
    CLEANUP_INTERVAL: 5000
};

/** @const {Object} CSS class names for styling */
const CSS_CLASSES = {
    OVERLAY: 'matomo-event-overlay',
    CONFIG_PANEL: 'matomo-config-panel',
    EVENT_ITEM: 'matomo-event-item',
    HISTORICAL: 'historical',
    EXPANDED: 'expanded',
    COLLAPSED: 'collapsed'
};

// =============================================================================
// STATE MANAGEMENT
// =============================================================================

/** @type {Array<Object>} Event log storage */
let eventLog = [];

/** @type {Object} Tracks which events are expanded in UI */
let expandedStates = {};

/** @type {boolean} Controls automatic scrolling to new events */
let autoScrollEnabled = true;

/** @type {Map<string, Object>} Recent events cache for duplicate detection */
let recentEvents = new Map();

/** @type {number} Counter for suppressed duplicate events */
let suppressedDuplicates = 0;

/** @type {number} Maximum number of events to store */
let maxEvents = PERFORMANCE.MAX_EVENTS;

/** @type {number} Threshold for enabling virtualization */
let virtualizeThreshold = PERFORMANCE.VIRTUALIZE_THRESHOLD;

/** @type {boolean} Whether virtualization is currently active */
let isVirtualized = false;

/** @type {Object|null} Container info stored globally */
let globalContainerInfo = null;

/** @type {boolean} Whether console logging is enabled */
let consoleLoggingEnabled = false;

// =============================================================================
// UI STATE MANAGEMENT
// =============================================================================

/** @type {HTMLElement|null} Main overlay element */
let overlay = null;

/** @type {boolean} Whether overlay is currently visible */
let isOverlayVisible = false;

/** @type {HTMLElement|null} Configuration panel element */
let configPanel = null;

/** @type {MutationObserver|null} Observer for MTM debug frame */
let mtmFrameObserver = null;

/** @type {boolean} Whether MTM debug frame should be hidden */
let shouldHideMTMFrame = false;

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Cleans event details for comparison (removes metadata)
 * @param {Object} details - Event details object
 * @returns {Object} Cleaned object without metadata
 */
function cleanEventDetails(details) {
    if (!details || typeof details !== 'object') return details;

    const cleaned = { ...details };
    delete cleaned.__mtm_processed;
    delete cleaned._debug;
    delete cleaned.customTimestamp;
    return cleaned;
}

/**
 * Cleans up old entries from cache maps
 */
function cleanupEventCaches() {
    const now = Date.now();
    const maxAge = PERFORMANCE.DUPLICATE_TIMEOUT;

    for (const [key, eventInfo] of recentEvents.entries()) {
        if (now - eventInfo.timestamp > maxAge) {
            recentEvents.delete(key);
        }
    }
}

/**
 * Escapes HTML characters for safe display
 * @param {string} text - Text to escape
 * @returns {string} Escaped HTML string
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Gets header title with container information
 * @returns {string} Header title string
 */
function getHeaderTitle() {
    let title = 'MTM Events';

    // Use global container info if available
    if (globalContainerInfo && globalContainerInfo.length > 0) {
        const container = globalContainerInfo[0];
        if (container.environment === 'preview') {
            title = `Preview: ${title}`;
        }
        title += ` [${container.id}]`;
    } else if (eventLog.length > 0) {
        // Fallback to event-specific container info
        const lastEvent = eventLog[eventLog.length - 1];
        if (lastEvent.containerInfo && lastEvent.containerInfo.length > 0) {
            const container = lastEvent.containerInfo[0];
            if (container.environment === 'preview') {
                title = `Preview: ${title}`;
            }
            title += ` [${container.id}]`;
        }
    }

    return title;
}

// =============================================================================
// EVENT PROCESSING
// =============================================================================

/**
 * Checks if an event is an exact duplicate
 * @param {Object} newEvent - New event to check
 * @returns {boolean} True if event is a duplicate
 */
function isExactDuplicate(newEvent) {
    const now = Date.now();

    const cleanEvent = {
        eventName: newEvent.eventName,
        source: newEvent.source?.replace(' (historical)', ''),
        details: newEvent.details ? cleanEventDetails(newEvent.details) : null
    };

    const eventJson = JSON.stringify(cleanEvent);

    if (recentEvents.has(eventJson)) {
        const lastSeen = recentEvents.get(eventJson);
        const timeDiff = now - lastSeen.timestamp;

        if (timeDiff < PERFORMANCE.DUPLICATE_TIMEOUT) {
            const lastHadIndex = lastSeen.hadArrayIndex;
            const newHasIndex = newEvent.arrayIndex !== null && newEvent.arrayIndex !== undefined;

            if (lastHadIndex !== newHasIndex) {
                return true;
            }
        }
    }

    recentEvents.set(eventJson, {
        timestamp: now,
        hadArrayIndex: newEvent.arrayIndex !== null && newEvent.arrayIndex !== undefined
    });

    cleanupEventCaches();
    return false;
}

/**
 * Cleans up event log when it exceeds maximum size
 */
function cleanupEventLog() {
    if (eventLog.length > maxEvents) {
        const eventsToRemove = eventLog.length - maxEvents;
        const removedEvents = eventLog.splice(0, eventsToRemove);

        removedEvents.forEach(event => {
            const eventId = `event-${event.id}`;
            delete expandedStates[eventId];
        });
    }
}

/**
 * Checks if virtualization should be enabled/disabled
 */
function checkVirtualization() {
    const shouldVirtualize = eventLog.length > virtualizeThreshold;
    if (shouldVirtualize !== isVirtualized) {
        isVirtualized = shouldVirtualize;
    }
}

/**
 * Updates the badge counter in the extension icon
 */
function updateBadgeCounter() {
    const count = eventLog.length;
    chrome.runtime.sendMessage({
        type: 'updateBadge',
        count: count
    }).catch(() => {
        // Silent fail - badge update is not critical
    });
}

/**
 * Updates the duplicate counter display
 */
function updateDuplicateCounter() {
    const header = document.querySelector('.matomo-overlay-header h3');
    if (!header) return;

    const baseTitle = getHeaderTitle();
    const totalEvents = eventLog.length;
    const maxEventsInfo = maxEvents < 1000 ? ` (max ${maxEvents})` : '';
    const virtualizationInfo = isVirtualized ? ' [virtualized]' : '';
    const duplicatesInfo = suppressedDuplicates > 0 ? `, ${suppressedDuplicates} dups hidden` : '';

    header.textContent = `${baseTitle} (${totalEvents}${maxEventsInfo}${duplicatesInfo})${virtualizationInfo}`;
}

/**
 * Logs event to browser console if console logging is enabled
 * @param {Object} eventData - Event data to log
 */
function logEventToConsole(eventData) {
    if (!consoleLoggingEnabled) return;

    // Determine event display name
    let displayName = eventData.eventName;
    let nameDetails = '';

    if (eventData.eventName === 'aEvent' && eventData.details && eventData.details.aEvent) {
        displayName = eventData.details.aEvent;
        nameDetails = ' (aEvent)';
    }

    // Format timestamp nicely
    const timestamp = new Date(eventData.timestamp);
    const timeString = timestamp.toLocaleTimeString('de-DE', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        fractionalSecondDigits: 3
    });

    // Get event number (starting from 0 to match _mtm array index)
    const eventNumber = eventLog.length;

    // Create deep copies to avoid references
    const logData = {
        details: eventData.details ? JSON.parse(JSON.stringify(eventData.details)) : null,
        triggerAnalysis: eventData.triggerAnalysis ? JSON.parse(JSON.stringify(eventData.triggerAnalysis)) : null,
        containerInfo: eventData.containerInfo ? JSON.parse(JSON.stringify(eventData.containerInfo)) : null,
        currentMtmArray: eventData.currentMtmArray ? JSON.parse(JSON.stringify(eventData.currentMtmArray)) : null
    };

    // Add current event to _mtm array copy for complete view
    if (logData.currentMtmArray && eventData.rawData) {
        try {
            const currentEventCopy = JSON.parse(JSON.stringify(eventData.rawData));
            logData.currentMtmArray.push(currentEventCopy);
        } catch (error) {
            // Silent fail if rawData can't be serialized
        }
    }

    // Check if MTM Debug Mode is active
    const debugModeActive = logData.triggerAnalysis && logData.triggerAnalysis.debugMode;

    // Start collapsed group with event number and formatted timestamp
    console.groupCollapsed(`🏷️ MTM Event #${eventNumber}: ${displayName}${nameDetails} ⏰ ${timeString}`);

    console.log('📋 Event Details:', logData.details);

    if (logData.triggerAnalysis) {
        if (!debugModeActive) {
            console.log('⚠️ MTM Debug Mode not (yet) active - trigger and tag analysis unavailable');
        }

        if (logData.triggerAnalysis.triggeredTriggers.length > 0) {
            console.log('🎯 Triggered Triggers:', logData.triggerAnalysis.triggeredTriggers);
        }
        if (logData.triggerAnalysis.firedTags.length > 0) {
            // Enhanced fired tags output for console
            const tagDetails = logData.triggerAnalysis.firedTags.map(tag => {
                if (typeof tag === 'string') {
                    return tag; // Fallback for simple strings
                } else {
                    return {
                        name: tag.name,
                        trigger: tag.trigger,
                        timestamp: tag.timestamp
                    };
                }
            });
            console.log('🏷️ Fired Tags:', tagDetails);
        }
    }

    if (logData.containerInfo && logData.containerInfo.length > 0) {
        const container = logData.containerInfo[0];
        const dataLayerInfo = {
            dataLayer: container.dataLayer && container.dataLayer.values ?
                JSON.parse(JSON.stringify(container.dataLayer.values)) : null
        };

        // Use resolved variables if available
        if (container.resolvedVariables) {
            dataLayerInfo.variables = JSON.parse(JSON.stringify(container.resolvedVariables));
        } else {
            dataLayerInfo.variables = { note: 'Variable resolution not available' };
        }

        console.log(`📊 dataLayer Info (${container.id}):`, dataLayerInfo);
    }

    // Log current _mtm array state (including current event)
    if (logData.currentMtmArray && logData.currentMtmArray.length > 0) {
        console.log('📜 Current _mtm Array (including this event):', logData.currentMtmArray);
    } else {
        console.log('📜 Current _mtm Array: (empty or not available)');
    }

    console.groupEnd();
}

// =============================================================================
// EVENT LISTENERS
// =============================================================================

/**
 * Main event listener for events from injected script
 */
document.addEventListener('matomoEventDetected', function(event) {
    chrome.storage.sync.get(DEFAULT_CONFIG, function(config) {
        // Update configuration variables
        maxEvents = config.maxEvents || PERFORMANCE.MAX_EVENTS;
        virtualizeThreshold = config.virtualizeThreshold || PERFORMANCE.VIRTUALIZE_THRESHOLD;
        consoleLoggingEnabled = config.consoleLogging || false;

        if (!config.watchMTM && !config.watchDataLayer) {
            return;
        }

        const eventData = {
            ...event.detail,
            timestamp: (event.detail && event.detail.customTimestamp) ?
                new Date(event.detail.customTimestamp).toISOString() :
                new Date().toISOString(),
            id: (event.detail && event.detail.customTimestamp) ?
                event.detail.customTimestamp + Math.random() :
                Date.now() + Math.random()
        };

        delete eventData.customTimestamp;

        // Store container info globally if available
        if (eventData.containerInfo && eventData.containerInfo.length > 0) {
            globalContainerInfo = eventData.containerInfo;
        }

        // Enhanced event name extraction
        if (!eventData.eventName) {
            if (eventData.details && eventData.details.event) {
                eventData.eventName = eventData.details.event;
            } else if (eventData.rawData && eventData.rawData.event) {
                eventData.eventName = eventData.rawData.event;
            } else if (eventData.details && eventData.details.type) {
                eventData.eventName = eventData.details.type;
            } else {
                eventData.eventName = 'Unknown';
            }
        }

        // Precise duplicate detection
        if (isExactDuplicate(eventData)) {
            suppressedDuplicates++;
            updateDuplicateCounter();
            return;
        }

        // Log to console if enabled
        logEventToConsole(eventData);

        // Add to event log
        eventLog.push(eventData);
        cleanupEventLog();
        eventLog.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        checkVirtualization();
        cleanupExpandedStates();

        // Update UI
        if (autoScrollEnabled || eventLog.length === 1) {
            if (overlay && document.getElementById('matomo-event-list')) {
                updateOverlay();
            } else {
                setTimeout(() => {
                    if (overlay && document.getElementById('matomo-event-list')) {
                        updateOverlay();
                    }
                }, 100);
            }
        }

        // Auto-show overlay if configured
        if (config.autoShow && !isOverlayVisible && eventLog.length === 1) {
            showOverlay();
        }

        updateBadgeCounter();
    });
});

/**
 * Configuration update listener
 */
document.addEventListener('mtmConfigUpdate', function(event) {
    const newConfig = event.detail;
    chrome.storage.sync.set(newConfig, function() {
        location.reload();
    });
});

// =============================================================================
// UI MANAGEMENT
// =============================================================================

/**
 * Creates the main overlay UI
 */
function createOverlay() {
    if (overlay) return;

    overlay = document.createElement('div');
    overlay.id = CSS_CLASSES.OVERLAY;

    Promise.all([
        fetch(chrome.runtime.getURL('overlay.html')).then(r => r.text()),
        fetch(chrome.runtime.getURL('config-panel.html')).then(r => r.text())
    ])
    .then(([overlayHTML, configHTML]) => {
        overlay.innerHTML = overlayHTML;

        configPanel = document.createElement('div');
        configPanel.className = CSS_CLASSES.CONFIG_PANEL;
        configPanel.innerHTML = configHTML;

        overlay.appendChild(configPanel);
        document.body.appendChild(overlay);

        setupEventListeners();
        loadConfigurationToPanel();

        chrome.storage.sync.get({ hideMTMFrame: false }, function(config) {
            updateMTMFrameButton(config.hideMTMFrame);
        });

        if (eventLog.length > 0) {
            updateOverlay();
        }
    })
    .catch(() => {
        // Silent fail - overlay creation is not critical for core functionality
    });
}

/**
 * Sets up event listeners for UI elements
 */
function setupEventListeners() {
    const closeBtn = document.getElementById('matomo-close-btn');
    const clearBtn = document.getElementById('matomo-clear-btn');
    const autoscrollBtn = document.getElementById('matomo-autoscroll-btn');
    const configBtn = document.getElementById('matomo-config-btn');
    const applyBtn = document.getElementById('applyConfig');
    const mtmFrameBtn = document.getElementById('matomo-mtm-frame-btn');

    if (closeBtn) closeBtn.addEventListener('click', hideOverlay);
    if (clearBtn) clearBtn.addEventListener('click', clearEvents);
    if (autoscrollBtn) autoscrollBtn.addEventListener('click', toggleAutoScroll);
    if (mtmFrameBtn) mtmFrameBtn.addEventListener('click', toggleMTMFrameManually);
    if (applyBtn) applyBtn.addEventListener('click', applyConfiguration);

    if (configBtn) {
        configBtn.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            toggleConfigPanel();
        });
    }

    // Event delegation for dynamic toggle buttons
    overlay.addEventListener('click', function(e) {
        if (e.target.closest('.matomo-details-toggle') || e.target.closest('.matomo')) {
            const button = e.target.closest('.matomo-details-toggle') || e.target.closest('.matomo');
            const eventId = button.getAttribute('data-event-id');
            if (eventId) {
                e.preventDefault();
                e.stopPropagation();
                toggleEventDetails(eventId);
            }
        }
    });

    // Click outside config panel to close
    document.addEventListener('click', function(e) {
        if (configPanel && configPanel.classList.contains('visible')) {
            const configBtn = document.getElementById('matomo-config-btn');
            if (!configPanel.contains(e.target) && (!configBtn || !configBtn.contains(e.target))) {
                hideConfigPanel();
            }
        }
    });

    // Make overlay draggable
    const header = overlay.querySelector('.matomo-overlay-header');
    if (header) {
        makeDraggable(overlay, header);
    }
}

/**
 * Shows/hides the configuration panel
 */
function toggleConfigPanel() {
    if (!configPanel) return;

    if (configPanel.classList.contains('visible')) {
        hideConfigPanel();
    } else {
        showConfigPanel();
    }
}

/**
 * Shows the configuration panel
 */
function showConfigPanel() {
    if (configPanel) {
        configPanel.classList.add('visible');
        configPanel.style.display = 'block';
        configPanel.style.position = 'fixed';
        configPanel.style.top = '80px';
        configPanel.style.right = '40px';
        configPanel.style.zIndex = '2147483650';
        configPanel.style.borderTop = '2px solid #e74c3c';

        loadConfigurationToPanel();
    }
}

/**
 * Hides the configuration panel
 */
function hideConfigPanel() {
    if (configPanel) {
        configPanel.classList.remove('visible');
        configPanel.style.display = 'none';
    }
}

/**
 * Loads current configuration into the config panel
 */
function loadConfigurationToPanel() {
    chrome.storage.sync.get(DEFAULT_CONFIG, function(items) {
        const watchMTM = document.getElementById('watchMTM');
        const watchDataLayer = document.getElementById('watchDataLayer');
        const autoShow = document.getElementById('autoShow');
        const hideMTMFrame = document.getElementById('hideMTMFrame');
        const consoleLogging = document.getElementById('consoleLogging');

        if (watchMTM) watchMTM.checked = items.watchMTM;
        if (watchDataLayer) watchDataLayer.checked = items.watchDataLayer;
        if (autoShow) autoShow.checked = items.autoShow;
        if (hideMTMFrame) hideMTMFrame.checked = items.hideMTMFrame;
        if (consoleLogging) consoleLogging.checked = items.consoleLogging;
    });
}

/**
 * Applies configuration changes
 */
function applyConfiguration() {
    const config = {
        watchMTM: document.getElementById('watchMTM')?.checked ?? DEFAULT_CONFIG.watchMTM,
        watchDataLayer: document.getElementById('watchDataLayer')?.checked ?? DEFAULT_CONFIG.watchDataLayer,
        autoShow: document.getElementById('autoShow')?.checked ?? DEFAULT_CONFIG.autoShow,
        hideMTMFrame: document.getElementById('hideMTMFrame')?.checked ?? DEFAULT_CONFIG.hideMTMFrame,
        consoleLogging: document.getElementById('consoleLogging')?.checked ?? DEFAULT_CONFIG.consoleLogging
    };

    chrome.storage.sync.set(config, function() {
        location.reload();
    });
}

// =============================================================================
// MTM DEBUG FRAME MANAGEMENT
// =============================================================================

/**
 * Toggles MTM debug frame visibility manually
 */
function toggleMTMFrameManually() {
    chrome.storage.sync.get({ hideMTMFrame: false }, function(config) {
        const newHideState = !config.hideMTMFrame;

        chrome.storage.sync.set({ hideMTMFrame: newHideState }, function() {
            setupMTMFrameHiding(newHideState);
            updateMTMFrameButton(newHideState);
        });
    });
}

/**
 * Updates MTM frame button appearance
 * @param {boolean} isHidden - Whether frame is hidden
 */
function updateMTMFrameButton(isHidden) {
    const mtmFrameBtn = document.getElementById('matomo-mtm-frame-btn');
    if (mtmFrameBtn) {
        mtmFrameBtn.textContent = isHidden ? '👁️' : '🙈';
        mtmFrameBtn.title = isHidden ? 'Show MTM Debug Frame' : 'Hide MTM Debug Frame';
        mtmFrameBtn.classList.toggle('hidden-state', isHidden);
    }
}

/**
 * Sets up MTM debug frame hiding/showing
 * @param {boolean} hide - Whether to hide the frame
 */
function setupMTMFrameHiding(hide) {
    shouldHideMTMFrame = hide;

    hideMTMFrameIfExists();

    if (hide) {
        startMTMFrameObserver();
    } else {
        stopMTMFrameObserver();
        showMTMFrameIfExists();
    }
}

/**
 * Hides MTM debug frame if it exists
 * @returns {boolean} True if frame was found and hidden
 */
function hideMTMFrameIfExists() {
    const mtmFrame = document.getElementById('mtmDebugFrame') ||
                     document.querySelector('iframe.mtmStickyBottom') ||
                     document.querySelector('iframe[id*="mtm"]') ||
                     document.querySelector('iframe[src*="about:blank"]');

    if (mtmFrame && shouldHideMTMFrame) {
        mtmFrame.style.setProperty('height', '0px', 'important');
        mtmFrame.style.setProperty('display', 'none', 'important');
        return true;
    }
    return false;
}

/**
 * Shows MTM debug frame if it exists
 */
function showMTMFrameIfExists() {
    const mtmFrame = document.getElementById('mtmDebugFrame') ||
                     document.querySelector('iframe.mtmStickyBottom');

    if (mtmFrame) {
        mtmFrame.style.removeProperty('display');
        mtmFrame.style.setProperty('height', '33vh', 'important');
    }
}

/**
 * Starts observing for MTM debug frame creation
 */
function startMTMFrameObserver() {
    if (mtmFrameObserver) return;

    mtmFrameObserver = new MutationObserver(function(mutations) {
        mutations.forEach(function(mutation) {
            mutation.addedNodes.forEach(function(node) {
                if (node.nodeName === 'IFRAME' &&
                    (node.id === 'mtmDebugFrame' ||
                     node.className?.includes('mtmStickyBottom') ||
                     node.src === 'about:blank')) {
                    setTimeout(() => hideMTMFrameIfExists(), 100);
                }
            });
        });
    });

    mtmFrameObserver.observe(document.body, {
        childList: true,
        subtree: true
    });
}

/**
 * Stops observing for MTM debug frame creation
 */
function stopMTMFrameObserver() {
    if (mtmFrameObserver) {
        mtmFrameObserver.disconnect();
        mtmFrameObserver = null;
    }
}

// =============================================================================
// EVENT DISPLAY AND FORMATTING
// =============================================================================

/**
 * Formats JSON data for display with syntax highlighting
 * @param {any} obj - Object to format
 * @returns {string} Formatted HTML string
 */
function formatJSON(obj) {
    function cleanObject(obj) {
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
            const cleaned = {};
            for (const [key, value] of Object.entries(obj)) {
                if (key !== '__mtm_processed') {
                    cleaned[key] = value;
                }
            }
            return cleaned;
        }
        return obj;
    }

    const cleanedObj = cleanObject(obj);

    function formatValue(value, indent = 0) {
        const spaces = '  '.repeat(indent);

        if (value === null) {
            return '<span class="json-null">null</span>';
        }

        if (typeof value === 'string') {
            return `<span class="json-string">"${escapeHtml(value)}"</span>`;
        }

        if (typeof value === 'number') {
            return `<span class="json-number">${value}</span>`;
        }

        if (typeof value === 'boolean') {
            return `<span class="json-boolean">${value}</span>`;
        }

        if (Array.isArray(value)) {
            if (value.length === 0) return '<span class="json-bracket">[]</span>';

            const items = value.map(item =>
                `${spaces}  ${formatValue(item, indent + 1)}`
            ).join(',\n');

            return `<span class="json-bracket">[</span>\n${items}\n${spaces}<span class="json-bracket">]</span>`;
        }

        if (typeof value === 'object') {
            const keys = Object.keys(value);
            if (keys.length === 0) return '<span class="json-bracket">{}</span>';

            const items = keys.map(key =>
                `${spaces}  <span class="json-key">"${escapeHtml(key)}"</span><span class="json-colon">:</span> ${formatValue(value[key], indent + 1)}`
            ).join(',\n');

            return `<span class="json-bracket">{</span>\n${items}\n${spaces}<span class="json-bracket">}</span>`;
        }

        return escapeHtml(String(value));
    }

    return formatValue(cleanedObj);
}

/**
 * Renders events list (with virtualization support)
 * @returns {string} HTML string for events list
 */
function renderEvents() {
    const allEvents = eventLog.slice().reverse(); // Newest first

    let eventsHtml = '';
    let containerInfoHtml = '';

    if (!isVirtualized) {
        eventsHtml = allEvents.map((event, index) => renderEventHTML(event, index, allEvents.length)).join('');
    } else {
        const visibleEvents = allEvents.slice(0, 50);
        const hiddenCount = allEvents.length - visibleEvents.length;

        eventsHtml = visibleEvents.map((event, index) => renderEventHTML(event, index, allEvents.length)).join('');

        if (hiddenCount > 0) {
            eventsHtml += `
                <div class="matomo-virtualization-info">
                    <div class="virtualization-message">
                        📊 ${hiddenCount} more events hidden (virtualization active)
                        <br><small>Use Clear function or increase virtualization limit in settings</small>
                    </div>
                </div>
            `;
        }
    }

    // Add container info at the bottom (only once)
    if (globalContainerInfo && globalContainerInfo.length > 0) {
        const container = globalContainerInfo[0];
        containerInfoHtml = `
            <div class="container-info-footer">
                <div class="container-stats-footer">
                    📦 Container ${container.id}: ${container.triggers?.length || 0} triggers, ${container.tags?.length || 0} tags available
                    ${container.environment ? ` (${container.environment})` : ''}
                </div>
            </div>
        `;
    }

    return eventsHtml + containerInfoHtml;
}

/**
 * Renders HTML for a single event
 * @param {Object} event - Event data
 * @param {number} index - Event index
 * @param {number} totalLength - Total number of events
 * @returns {string} HTML string for event
 */
function renderEventHTML(event, index, totalLength) {
    let displayName = event.eventName || 'Unknown';
    let originalName = '';

    if (event.eventName === 'aEvent' && event.details && event.details.aEvent) {
        displayName = event.details.aEvent;
        originalName = ' <span class="original-name">(aEvent)</span>';
    }

    const eventId = `event-${event.id}`;
    const isExpanded = expandedStates[eventId] || false;
    const isHistorical = event.isHistorical || false;
    const eventNumber = totalLength - 1 - index;

    const tags = event.firedTags || [];
    const tagsHtml = tags.length > 0 ? `
        <div class="matomo-event-tags">
            <strong>Tags:</strong> ${tags.map(tag => `<span class="tag-item">${tag}</span>`).join(', ')}
        </div>
    ` : '';

    const sourceInfo = getEventSourceInfo(event);
    const sourceBadge = sourceInfo.show ? `<span class="event-source-badge ${sourceInfo.class}" title="${sourceInfo.tooltip}">${sourceInfo.label}</span>` : '';

    const arrayIndexText = event.arrayIndex !== null && event.arrayIndex !== undefined ? ` [${event.arrayIndex}]` : '';

    // Generate trigger analysis HTML
    const triggerAnalysisHtml = generateTriggerAnalysisHtml(event);

    // Generate trigger badge for the header (positioned next to time)
    const triggerBadge = generateTriggerBadge(event);

    return `
        <div class="matomo-event-item ${isHistorical ? 'historical' : ''}">
            <div class="matomo-event-header">
                <div class="matomo-event-name">
                    ${event.details || event.triggerAnalysis ? `<span class="matomo-details-toggle matomo inline-toggle" data-event-id="${eventId}">
                        <span class="toggle-icon">${isExpanded ? '▼' : '▶'}</span>
                    </span>` : ''}
                    <span class="matomo-event-number ${isHistorical ? 'historical' : ''}">${eventNumber}</span>
                    ${sourceBadge}
                    ${displayName}${originalName}
                    ${arrayIndexText ? `<span class="array-index">${arrayIndexText}</span>` : ''}
                </div>
                <div class="matomo-event-meta">
                    ${triggerBadge}
                    <span class="matomo-event-time matomo">${new Date(event.timestamp).toLocaleTimeString()}</span>
                </div>
            </div>
            ${tagsHtml}
            ${(event.details || event.triggerAnalysis) ? `
                <div id="${eventId}" class="matomo-event-details ${isExpanded ? '' : 'collapsed'}">
                    ${triggerAnalysisHtml}
                    ${event.details ? `
                        <div class="event-details-section">
                            <h5>📋 Event Details:</h5>
                            <pre class="json-formatter matomo">${formatJSON(event.details)}</pre>
                        </div>
                    ` : ''}
                </div>
            ` : ''}
        </div>
    `;
}

/**
 * Generates trigger analysis HTML for an event
 * @param {Object} event - Event data
 * @returns {string} HTML string for trigger analysis
 */
function generateTriggerAnalysisHtml(event) {
    if (!event.triggerAnalysis) {
        return '';
    }

    const analysis = event.triggerAnalysis;
    let html = '<div class="trigger-analysis-section">';

    // Debug Mode Warning (no container stats)
    if (!analysis.debugMode) {
        html += `
            <div class="debug-mode-warning">
                <strong>⚠️ MTM Debug Mode not active</strong><br>
                <small>Enable with: <code>window.MatomoTagManager.enableDebugMode()</code></small>
            </div>
        `;
    }

    // Always show triggers and tags if available, regardless of debug mode
    if (analysis.debugMode || analysis.triggeredTriggers.length > 0 || analysis.firedTags.length > 0) {
        // Triggered Triggers (without container stats)
        if (analysis.triggeredTriggers.length > 0) {
            html += '<div class="triggered-triggers">';
            html += '<h5>🎯 Triggered Triggers:</h5>';

            analysis.triggeredTriggers.forEach(trigger => {
                html += `
                    <div class="trigger-item">
                        <div class="trigger-header">
                            <strong>${escapeHtml(trigger.name)}</strong>
                            <span class="trigger-type">(${trigger.type})</span>
                        </div>
                        <div class="trigger-conditions">
                            ${trigger.matchedConditions.map(cond => `
                                <div class="condition ${cond.matched ? 'matched' : 'not-matched'}">
                                    <span class="condition-variable">${escapeHtml(cond.variable)}</span>:
                                    "<span class="condition-value">${escapeHtml(String(cond.actual))}</span>"
                                    <span class="condition-operator">${cond.comparison}</span>
                                    "<span class="condition-expected">${escapeHtml(String(cond.expected))}</span>"
                                    <span class="condition-result">${cond.matched ? '✅' : '❌'}</span>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                `;
            });

            html += '</div>';
        }

        // Fired Tags - enhanced with time and trigger info
        if (analysis.firedTags.length > 0) {
            html += '<div class="fired-tags">';
            html += '<h5>🏷️ Fired Tags:</h5>';
            html += '<div class="tag-list">';

            analysis.firedTags.forEach(tag => {
                // Handle both string and object formats
                if (typeof tag === 'string') {
                    // Fallback for simple string format
                    html += `
                        <div class="tag-entry">
                            <span class="tag-name">${escapeHtml(tag)}</span>
                            <span class="tag-details">Legacy format - no timing info</span>
                        </div>
                    `;
                } else {
                    // Enhanced object format with timing and trigger info
                    html += `
                        <div class="tag-entry">
                            <span class="tag-name">${escapeHtml(tag.name || 'Unknown Tag')}</span>
                            <span class="tag-details">
                                ⏰ ${tag.timestamp || 'No timestamp'} | 🎯 ${escapeHtml(tag.trigger || 'Unknown trigger')}
                            </span>
                        </div>
                    `;
                }
            });

            html += '</div></div>';
        }

        // No Results
        if (analysis.triggeredTriggers.length === 0 && analysis.firedTags.length === 0) {
            html += '<div class="no-triggers">💤 No triggers or tags detected for this event</div>';
        }
    }

    html += '</div>';
    return html;
}

/**
 * Generates trigger badge for the event header
 * @param {Object} event - Event data
 * @returns {string} HTML string for trigger badge
 */
function generateTriggerBadge(event) {
    if (!event.triggerAnalysis) {
        return '';
    }

    const analysis = event.triggerAnalysis;

    if (!analysis.debugMode) {
        return '<span class="trigger-badge debug-off" title="MTM Debug Mode not active">🔍</span>';
    }

    const triggerCount = analysis.triggeredTriggers.length;
    const tagCount = analysis.firedTags.length;

    // Only show badge if there are triggers or tags
    if (triggerCount === 0 && tagCount === 0) {
        return '';
    }

    let badgeText = '';
    let badgeClass = 'trigger-badge active';
    let title = '';

    if (triggerCount > 0 && tagCount > 0) {
        badgeText = `🎯${triggerCount} 🏷️${tagCount}`;
        title = `${triggerCount} trigger(s) fired ${tagCount} tag(s)`;
    } else if (triggerCount > 0) {
        badgeText = `🎯${triggerCount}`;
        title = `${triggerCount} trigger(s) fired (no tags)`;
    } else if (tagCount > 0) {
        badgeText = `🏷️${tagCount}`;
        title = `${tagCount} tag(s) fired`;
    }

    return `<span class="${badgeClass}" title="${title}">${badgeText}</span>`;
}

/**
 * Gets event source information for badge display
 * @param {Object} event - Event data
 * @returns {Object} Source info object
 */
function getEventSourceInfo(event) {
    const source = event.source || '';
    const isHistorical = event.isHistorical || false;

    if (source.includes('_mtm.push')) {
        return { show: false };
    } else if (source.includes('dataLayer')) {
        if (isHistorical) {
            return {
                label: 'DL-SCAN',
                class: 'source-dl-historical',
                tooltip: 'Event read from existing dataLayer (initial scan)',
                show: true
            };
        } else {
            return {
                label: 'DL-LIVE',
                class: 'source-dl-live',
                tooltip: 'Event intercepted via dataLayer.push() proxy',
                show: true
            };
        }
    } else {
        return {
            label: 'OTHER',
            class: 'source-other',
            tooltip: `Event source: ${source}`,
            show: true
        };
    }
}

/**
 * Updates the main overlay display
 */
function updateOverlay() {
    if (!overlay) {
        createOverlay();
        return;
    }

    const eventListEl = document.getElementById('matomo-event-list');
    if (!eventListEl) {
        return;
    }

    eventListEl.innerHTML = renderEvents();

    updateAutoScrollButton();
    updateDuplicateCounter();

    if (autoScrollEnabled && eventLog.length > 0) {
        eventListEl.scrollTop = 0;
    }
}

/**
 * Toggles event details visibility
 * @param {string} eventId - Event element ID
 */
function toggleEventDetails(eventId) {
    const detailsEl = document.getElementById(eventId);

    if (detailsEl) {
        detailsEl.classList.toggle('collapsed');

        const toggleBtn = document.querySelector(`[data-event-id="${eventId}"] .toggle-icon`);
        if (toggleBtn) {
            const isCollapsed = detailsEl.classList.contains('collapsed');
            toggleBtn.textContent = isCollapsed ? '▶' : '▼';
        }

        expandedStates[eventId] = !detailsEl.classList.contains('collapsed');
    }
}

/**
 * Cleans up old expanded states
 */
function cleanupExpandedStates() {
    const currentEventIds = new Set();
    eventLog.slice(-20).forEach(event => {
        currentEventIds.add(`event-${event.id}`);
    });

    Object.keys(expandedStates).forEach(eventId => {
        if (!currentEventIds.has(eventId)) {
            delete expandedStates[eventId];
        }
    });
}

// =============================================================================
// OVERLAY CONTROL FUNCTIONS
// =============================================================================

/**
 * Shows the overlay
 */
function showOverlay() {
    if (!overlay) createOverlay();
    overlay.style.display = 'block';
    isOverlayVisible = true;
}

/**
 * Hides the overlay
 */
function hideOverlay() {
    if (overlay) {
        overlay.style.display = 'none';
        isOverlayVisible = false;
        hideConfigPanel();
    }
}

/**
 * Toggles auto-scroll functionality
 */
function toggleAutoScroll() {
    autoScrollEnabled = !autoScrollEnabled;
    updateAutoScrollButton();
}

/**
 * Clears all events from the log
 */
function clearEvents() {
    eventLog = [];
    expandedStates = {};
    recentEvents.clear();
    suppressedDuplicates = 0;
    isVirtualized = false;
    updateOverlay();
    updateBadgeCounter();

    chrome.runtime.sendMessage({
        type: 'clearBadge'
    }).catch(() => {
        // Silent fail - badge clear is not critical
    });
}

/**
 * Updates auto-scroll button appearance
 */
function updateAutoScrollButton() {
    const btn = document.getElementById('matomo-autoscroll-btn');
    if (btn) {
        if (autoScrollEnabled) {
            btn.textContent = '🔄';
            btn.className = 'auto-scroll-btn active';
            btn.title = 'Auto-scroll is active (click to pause)';
        } else {
            btn.textContent = '⏸️';
            btn.className = 'auto-scroll-btn paused';
            btn.title = 'Auto-scroll is paused (click to activate)';
        }
    }
}

/**
 * Makes an element draggable
 * @param {HTMLElement} element - Element to make draggable
 * @param {HTMLElement} handle - Handle element for dragging
 */
function makeDraggable(element, handle) {
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;

    handle.onmousedown = dragMouseDown;

    function dragMouseDown(e) {
        e = e || window.event;
        e.preventDefault();
        pos3 = e.clientX;
        pos4 = e.clientY;
        document.onmouseup = closeDragElement;
        document.onmousemove = elementDrag;
    }

    function elementDrag(e) {
        e = e || window.event;
        e.preventDefault();
        pos1 = pos3 - e.clientX;
        pos2 = pos4 - e.clientY;
        pos3 = e.clientX;
        pos4 = e.clientY;
        element.style.top = (element.offsetTop - pos2) + "px";
        element.style.left = (element.offsetLeft - pos1) + "px";
    }

    function closeDragElement() {
        document.onmouseup = null;
        document.onmousemove = null;
    }
}

// =============================================================================
// KEYBOARD SHORTCUTS
// =============================================================================

/**
 * Handles keyboard shortcuts
 */
document.addEventListener('keydown', function(e) {
    // Toggle overlay
    if (e.ctrlKey && e.altKey && e.key === 'm') {
        e.preventDefault();
        if (isOverlayVisible) {
            hideOverlay();
        } else {
            showOverlay();
        }
    }

    // Scroll to bottom
    if (e.ctrlKey && e.altKey && e.key === 'b' && isOverlayVisible) {
        e.preventDefault();
        const eventListEl = document.getElementById('matomo-event-list');
        if (eventListEl) {
            eventListEl.scrollTop = eventListEl.scrollHeight;
        }
    }

    // Scroll to top
    if (e.ctrlKey && e.altKey && e.key === 't' && isOverlayVisible) {
        e.preventDefault();
        const eventListEl = document.getElementById('matomo-event-list');
        if (eventListEl) {
            eventListEl.scrollTop = 0;
        }
    }
});

// =============================================================================
// INITIALIZATION
// =============================================================================

/**
 * Initializes the content script
 */
function initializeContentScript() {
    chrome.storage.sync.get(DEFAULT_CONFIG, function(config) {
        // Load configuration script first
        const configScript = document.createElement('script');
        configScript.src = chrome.runtime.getURL('config-script.js');
        configScript.onload = function() {
            this.remove();

            // Send configuration and script URL via event
            const event = new CustomEvent('mtmConfigReady', {
                detail: {
                    config: config,
                    injectedScriptUrl: chrome.runtime.getURL('injected-script.js')
                },
                bubbles: true
            });
            document.dispatchEvent(event);
        };
        configScript.onerror = function() {
            this.remove();
        };

        (document.head || document.documentElement).appendChild(configScript);
    });

    // Set up MTM frame hiding on load
    chrome.storage.sync.get({ hideMTMFrame: false }, function(config) {
        if (config.hideMTMFrame) {
            setupMTMFrameHiding(true);
        }
    });
}

// =============================================================================
// EVENT LISTENERS SETUP
// =============================================================================

// Auto-show on first event
document.addEventListener('matomoEventDetected', function() {
    chrome.storage.sync.get({ autoShow: true }, function(config) {
        if (config.autoShow && !isOverlayVisible) {
            showOverlay();
        }
    });
}, { once: true });

// Clear events listener
document.addEventListener('matomoClearEvents', function() {
    clearEvents();
});

// Mark as loaded
window.matomoMonitorLoaded = true;

// Initialize
initializeContentScript();