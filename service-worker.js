/**
 * Matomo Tag Manager Event Monitor - Service Worker
 * Handles extension icon badge updates and click actions
 *
 * @description Background service worker for Chrome extension that manages
 *              badge counters and handles extension icon clicks to toggle overlay
 * @version 1.3
 * @author MTM Event Monitor
 */

// =============================================================================
// CONSTANTS AND CONFIGURATION
// =============================================================================

/** @const {string} Badge background color */
const BADGE_COLOR = '#e74c3c';

// =============================================================================
// STATE MANAGEMENT
// =============================================================================

/** @type {Map<number, number>} Badge counters per tab (TabId -> Event Count) */
let badgeCounters = new Map();

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Safely executes badge operations with error handling
 * @param {Function} operation - Function that receives badge API as parameter
 */
function safeBadgeOperation(operation) {
    try {
        if (chrome.action && typeof operation === 'function') {
            operation(chrome.action);
        }
    } catch (error) {
        // Silent fail - badge operations are not critical
    }
}

/**
 * Executes script to simulate keyboard shortcut for overlay toggle
 * @param {number} tabId - Tab ID to execute script in
 * @returns {Promise<void>} Promise that resolves when script is executed
 */
async function executeToggleScript(tabId) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: () => {
                const event = new KeyboardEvent('keydown', {
                    key: 'm',
                    ctrlKey: true,
                    altKey: true,
                    bubbles: true
                });
                document.dispatchEvent(event);
            }
        });
    } catch (error) {
        // Silent fail - toggle action is not critical
    }
}

// =============================================================================
// BADGE MANAGEMENT
// =============================================================================

/**
 * Updates badge for specific tab
 * @param {number} tabId - Tab ID to update badge for
 * @param {number} count - Event count to display
 */
function updateBadgeForTab(tabId, count) {
    badgeCounters.set(tabId, count);

    // Only set badge for active tab
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs.length > 0 && tabs[0].id === tabId) {
            safeBadgeOperation((badgeAPI) => {
                if (badgeAPI.setBadgeText) {
                    badgeAPI.setBadgeText({
                        text: count > 0 ? count.toString() : '',
                        tabId: tabId
                    });
                }
                if (badgeAPI.setBadgeBackgroundColor) {
                    badgeAPI.setBadgeBackgroundColor({
                        color: BADGE_COLOR,
                        tabId: tabId
                    });
                }
            });
        }
    });
}

/**
 * Clears badge for specific tab
 * @param {number} tabId - Tab ID to clear badge for
 */
function clearBadgeForTab(tabId) {
    badgeCounters.delete(tabId);
    safeBadgeOperation((badgeAPI) => {
        if (badgeAPI.setBadgeText) {
            badgeAPI.setBadgeText({
                text: '',
                tabId: tabId
            });
        }
    });
}

/**
 * Updates badge when switching tabs
 * @param {number} tabId - New active tab ID
 */
function updateBadgeForActiveTab(tabId) {
    const count = badgeCounters.get(tabId) || 0;

    safeBadgeOperation((badgeAPI) => {
        if (badgeAPI.setBadgeText) {
            badgeAPI.setBadgeText({
                text: count > 0 ? count.toString() : '',
                tabId: tabId
            });
        }

        if (count > 0 && badgeAPI.setBadgeBackgroundColor) {
            badgeAPI.setBadgeBackgroundColor({
                color: BADGE_COLOR,
                tabId: tabId
            });
        }
    });
}

/**
 * Clears all badges across all tabs
 */
function clearAllBadges() {
    chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
            safeBadgeOperation((badgeAPI) => {
                if (badgeAPI.setBadgeText) {
                    badgeAPI.setBadgeText({
                        text: '',
                        tabId: tab.id
                    });
                }
            });
        });
    });
    badgeCounters.clear();
}

// =============================================================================
// EVENT LISTENERS
// =============================================================================

/**
 * Handles extension icon clicks
 */
chrome.action.onClicked.addListener(async (tab) => {
    await executeToggleScript(tab.id);
});

/**
 * Handles messages from content scripts
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const tabId = sender.tab?.id;

    if (!tabId) {
        sendResponse({ success: false, error: 'No tab ID available' });
        return;
    }

    try {
        switch (message.type) {
            case 'updateBadge':
                updateBadgeForTab(tabId, message.count);
                sendResponse({ success: true });
                break;

            case 'clearBadge':
                clearBadgeForTab(tabId);
                sendResponse({ success: true });
                break;

            default:
                sendResponse({ success: false, error: 'Unknown message type' });
        }
    } catch (error) {
        sendResponse({ success: false, error: error.message });
    }
});

/**
 * Updates badge when tab becomes active
 */
chrome.tabs.onActivated.addListener((activeInfo) => {
    updateBadgeForActiveTab(activeInfo.tabId);
});

/**
 * Cleans up badge when tab is closed
 */
chrome.tabs.onRemoved.addListener((tabId) => {
    badgeCounters.delete(tabId);
});

/**
 * Resets badge when tab navigates to new URL
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // Reset badge when new URL is loading
    if (changeInfo.status === 'loading' && changeInfo.url) {
        clearBadgeForTab(tabId);
    }
});

// =============================================================================
// INSTALLATION AND STARTUP
// =============================================================================

/**
 * Handles extension installation and updates
 */
chrome.runtime.onInstalled.addListener((details) => {
    // Set initial badge configuration
    safeBadgeOperation((badgeAPI) => {
        if (badgeAPI.setBadgeBackgroundColor) {
            badgeAPI.setBadgeBackgroundColor({ color: BADGE_COLOR });
        }
    });

    // Clear all badges on install/update
    if (details.reason === 'install' || details.reason === 'update') {
        clearAllBadges();
    }
});

/**
 * Handles service worker startup
 */
chrome.runtime.onStartup.addListener(() => {
    // Reset badge counters and set initial configuration
    badgeCounters.clear();
    safeBadgeOperation((badgeAPI) => {
        if (badgeAPI.setBadgeBackgroundColor) {
            badgeAPI.setBadgeBackgroundColor({ color: BADGE_COLOR });
        }
    });
});