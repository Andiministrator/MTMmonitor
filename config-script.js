/**
 * Matomo Tag Manager Event Monitor - Configuration Script
 * Bridge script for configuration loading and main script injection
 *
 * @description Lightweight bridge script that receives configuration from content script
 *              and loads the main injected script with proper configuration in page context
 * @version 1.3
 * @author MTM Event Monitor
 */
(function() {
    'use strict';

    // =============================================================================
    // UTILITY FUNCTIONS
    // =============================================================================

    /**
     * Loads the main injected script with configuration
     * @param {string} scriptUrl - URL of the script to load
     * @param {Object} config - Configuration object
     */
    function loadMainScript(scriptUrl, config) {
        const mainScript = document.createElement('script');
        mainScript.src = scriptUrl;

        mainScript.onload = function() {
            this.remove();
        };

        mainScript.onerror = function() {
            this.remove();
        };

        (document.head || document.documentElement).appendChild(mainScript);
    }

    // =============================================================================
    // EVENT LISTENERS
    // =============================================================================

    /**
     * Listens for configuration from content script and loads main script
     */
    document.addEventListener('mtmConfigReady', function(event) {
        const config = event.detail.config;
        const scriptUrl = event.detail.injectedScriptUrl;

        // Set global configuration for injected script
        window.MTM_MONITOR_CONFIG = config;

        // Load main script with provided URL
        loadMainScript(scriptUrl, config);
    });

})();