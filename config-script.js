/**
 * Matomo Tag Manager Event Monitor - Configuration Script
 * Bridge script for configuration loading and main script injection
 *
 * @description Lightweight bridge script that receives configuration from content script
 *              and loads the main injected script with proper configuration in page context
 * @version 1.4
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
         try {
             // Check if we're on a restricted site
             const restrictedDomains = [
                 'accounts.google.com',
                 'meet.google.com',
                 'chrome.google.com',
                 'chromewebstore.google.com'
             ];

             const currentDomain = window.location.hostname;
             if (restrictedDomains.some(domain => currentDomain.includes(domain))) {
                 console.log('MTM Monitor: Skipping injection on restricted domain:', currentDomain);
                 return;
             }

             const mainScript = document.createElement('script');

             // Handle Trusted Types CSP if present
             if (window.trustedTypes && window.trustedTypes.createPolicy) {
                 try {
                     // Try to create a policy for our script URLs
                     let policy;
                     try {
                         policy = window.trustedTypes.createPolicy('mtm-monitor-script', {
                             createScriptURL: (url) => {
                                 // Only allow our extension URLs
                                 if (url.startsWith('chrome-extension://')) {
                                     return url;
                                 }
                                 throw new Error('Invalid script URL');
                             }
                         });
                     } catch (policyError) {
                         // Policy might already exist, try to get it
                         policy = window.trustedTypes.getPolicyByName('mtm-monitor-script');
                         if (!policy) {
                             throw policyError;
                         }
                     }

                     mainScript.src = policy.createScriptURL(scriptUrl);
                 } catch (trustedTypesError) {
                     console.log('MTM Monitor: Cannot inject due to Trusted Types CSP:', trustedTypesError.message);
                     return;
                 }
             } else {
                 // Standard assignment for sites without Trusted Types
                 mainScript.src = scriptUrl;
             }

             // Set up event handlers
             mainScript.onload = function() {
                 console.log('MTM Monitor: Injected script loaded successfully');
                 this.remove();
             };

             mainScript.onerror = function(error) {
                 console.log('MTM Monitor: Script injection failed:', error);
                 this.remove();
             };

             // Inject the script
             const target = document.head || document.documentElement;
             if (target) {
                 target.appendChild(mainScript);
             } else {
                 console.log('MTM Monitor: Cannot find injection target (head/documentElement)');
             }

         } catch (error) {
             console.log('MTM Monitor: Script injection blocked by CSP or other security policy:', error.message);
         }
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