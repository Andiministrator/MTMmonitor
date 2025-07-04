/**
 * Matomo Tag Manager Event Monitor - Injected Script
 * Monitors MTM events and dataLayer in the main page context
 *
 * @description Core monitoring script that intercepts _mtm array pushes and dataLayer events
 *              for Matomo Tag Manager debugging. Runs in the main page context to access
 *              window objects directly.
 * @version 1.4
 * @author MTM Event Monitor
 */
(function() {
    'use strict';

    // =============================================================================
    // CONSTANTS AND CONFIGURATION
    // =============================================================================

    /** @const {boolean} Enable debug logging (development only) */
    const ENABLE_DEBUG_LOGS = false;

    /** @const {Object} Time intervals in milliseconds */
    const INTERVALS = {
        ARRAY_CHECK: 200,           // Check for array changes
        CACHE_CLEANUP: 5000,        // Cleanup processed events cache
        HISTORICAL_OFFSET: 5000     // Historical event timestamp offset
    };

    /** @const {Object} Cache timeouts in milliseconds */
    const CACHE_TIMEOUTS = {
        GLOBAL_EVENTS: 1000,        // Global duplicate detection
        RECENT_EVENTS: 2000         // Recent events tracking
    };

    /** @const {Array<string>} MTM object names to monitor */
    const MTM_OBJECTS = ['_mtm', 'mtm', '_paq_mtm'];

    /** @const {Array<string>} MTM push methods to intercept */
    const MTM_METHODS = ['push', 'track', 'trackEvent'];

    /** @const {Array<string>} Fields that contain trigger information */
    const TRIGGER_FIELDS = [
        'triggerName', 'mtm.triggerName', 'trigger', 'mtm.trigger',
        'gtm.trigger', '_trigger', 'triggerType', 'triggerID',
        'clickElement', 'formElement', 'elementId', 'elementClass',
        'elementText', 'elementUrl', 'linkUrl'
    ];

    /** @const {Array<string>} Fields that contain tag information */
    const TAG_FIELDS = ['tags', 'firedTags', 'mtm.tags', 'gtm.tags'];

    // =============================================================================
    // STATE MANAGEMENT
    // =============================================================================

    /** @type {boolean} Whether initial scan of existing arrays is completed */
    let initialScanCompleted = false;

    /** @type {Map<string, number>} Global processed events cache (signature -> timestamp) */
    let globalProcessedEvents = new Map();

    /** @type {Object} Configuration loaded from extension storage or global object */
    let CONFIG = window.MTM_MONITOR_CONFIG || {
        watchDataLayer: false,
        watchMTM: true,
        autoShow: true
    };

    // =============================================================================
    // UTILITY FUNCTIONS
    // =============================================================================

    /**
     * Logs debug message if debug mode is enabled
     * @param {string} message - The message to log
     * @param {...any} args - Additional arguments to log
     */
    function debugLog(message, ...args) {
        if (ENABLE_DEBUG_LOGS) {
            console.log(`MTMevents: ${message}`, ...args);
        }
    }

    /**
     * Gets nested property value from object using dot notation
     * @param {Object} obj - Object to search in
     * @param {string} path - Dot-separated path (e.g., 'mtm.triggerName')
     * @returns {any} The value at the path or null if not found
     */
    function getNestedValue(obj, path) {
        return path.split('.').reduce((current, key) => {
            return current && current[key] !== undefined ? current[key] : null;
        }, obj);
    }

    /**
     * Cleans up old entries from cache maps
     * @param {Map} cache - The cache map to clean
     * @param {number} maxAge - Maximum age in milliseconds
     */
    function cleanupCache(cache, maxAge) {
        const now = Date.now();
        for (const [key, timestamp] of cache.entries()) {
            if (now - timestamp > maxAge) {
                cache.delete(key);
            }
        }
    }

    /**
     * Creates a clean object for event comparison (removes metadata)
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

    // =============================================================================
    // EVENT DETECTION AND ANALYSIS
    // =============================================================================

    /**
     * Extracts fired tags from event data
     * @param {any} data - Event data
     * @returns {Array<string>} Array of fired tags
     */
    function extractFiredTags(data) {
        let firedTags = [];

        // Check tag fields
        for (const field of TAG_FIELDS) {
            const value = getNestedValue(data, field);
            if (Array.isArray(value)) {
                firedTags = value;
                break;
            }
        }

        // Check individual tag name fields
        if (data && typeof data === 'object') {
            if (data.tagName) firedTags.push(data.tagName);
            if (data['mtm.tagName']) firedTags.push(data['mtm.tagName']);
        }

        return firedTags;
    }

    /**
     * Gets MTM container information if available
     * @returns {Array<Object>} Array of container information objects
     */
    function getMTMContainerInfo() {
        if (typeof window.MatomoTagManager !== 'undefined' && window.MatomoTagManager.containers) {
            return window.MatomoTagManager.containers.map(container => ({
                id: container.id,
                versionName: container.versionName,
                revision: container.revision,
                environment: container.environment,
                debugMode: container.triggers && container.tags,
                triggers: container.triggers || [],
                tags: container.tags || [],
                variables: container.variables || [],
                dataLayer: container.dataLayer || []
            }));
        }
        return [];
    }

    // =============================================================================
    // EVENT PROCESSING AND DISPATCHING
    // =============================================================================

    /**
     * Dispatches a Matomo event with timestamp
     * @param {Object} eventData - Event data to dispatch
     * @param {number} timestamp - Event timestamp
     */
    function dispatchMatomoEventWithTimestamp(eventData, timestamp) {
        if (!eventData) {
            debugLog('Event data is null/undefined, skipping');
            return;
        }

        // Clean and serialize event data
        let cleanedEventData;
        try {
            cleanedEventData = JSON.parse(JSON.stringify(eventData, (key, value) => {
                if (value instanceof Event) {
                    return {
                        event: value.event || value.type,
                        type: value.type,
                        isTrusted: value.isTrusted,
                        timeStamp: value.timeStamp,
                        __isSerializedEvent: true
                    };
                }
                return typeof value === 'function' ? undefined : value;
            }));
        } catch (error) {
            debugLog('Serialization failed:', error);
            cleanedEventData = {
                source: eventData.source || 'unknown',
                eventName: eventData.eventName || 'unknown',
                details: typeof eventData.details === 'object' ? { serialized: 'true' } : eventData.details
            };
        }

        // Add current _mtm array state for console logging
        if (typeof window._mtm !== 'undefined' && Array.isArray(window._mtm)) {
            try {
                cleanedEventData.currentMtmArray = JSON.parse(JSON.stringify(window._mtm));
            } catch (error) {
                debugLog('Error copying _mtm array:', error);
            }
        }

        // Global duplicate detection
        if (isGlobalDuplicate(cleanedEventData)) {
            debugLog('Global duplicate detected, skipping');
            return;
        }

        // Mark as processed
        markEventAsProcessed(cleanedEventData);

        debugLog('Dispatching event:', cleanedEventData, new Date(timestamp));

        const event = new CustomEvent('matomoEventDetected', {
            detail: {
                ...cleanedEventData,
                customTimestamp: timestamp
            },
            bubbles: true
        });

        document.dispatchEvent(event);
    }

    /**
     * Dispatches a Matomo event with current timestamp
     * @param {Object} eventData - Event data to dispatch
     */
    function dispatchMatomoEvent(eventData) {
        dispatchMatomoEventWithTimestamp(eventData, Date.now());
    }

    /**
     * Checks if event is a global duplicate
     * @param {Object} eventData - Event data to check
     * @returns {boolean} True if duplicate
     */
    function isGlobalDuplicate(eventData) {
        const cleanEventForComparison = {
            eventName: eventData.eventName || 'unknown',
            source: eventData.source?.replace(' (historical)', '') || 'unknown',
            details: eventData.details ? cleanEventDetails(eventData.details) : null
        };

        const eventSignature = JSON.stringify(cleanEventForComparison);
        debugLog('Event signature created:', eventSignature);

        if (globalProcessedEvents.has(eventSignature)) {
            const lastSeen = globalProcessedEvents.get(eventSignature);
            const timeDiff = Date.now() - lastSeen;

            if (timeDiff < CACHE_TIMEOUTS.GLOBAL_EVENTS) {
                debugLog('JSON-based global duplicate detected, skipping:', timeDiff, 'ms');
                return true;
            }
        }

        return false;
    }

    /**
     * Marks event as processed in global cache
     * @param {Object} eventData - Event data to mark
     */
    function markEventAsProcessed(eventData) {
        const cleanEventForComparison = {
            eventName: eventData.eventName || 'unknown',
            source: eventData.source?.replace(' (historical)', '') || 'unknown',
            details: eventData.details ? cleanEventDetails(eventData.details) : null
        };

        const eventSignature = JSON.stringify(cleanEventForComparison);
        globalProcessedEvents.set(eventSignature, Date.now());

        // Cleanup old entries
        cleanupCache(globalProcessedEvents, CACHE_TIMEOUTS.GLOBAL_EVENTS);
    }

    // =============================================================================
    // MTM ARRAY MONITORING
    // =============================================================================

    /**
     * Intercepts MTM object push methods
     */
    function interceptMTMPush() {
        MTM_OBJECTS.forEach(objName => {
            if (typeof window[objName] !== 'undefined' && window[objName]) {
                debugLog(`${objName} object found:`, window[objName]);

                MTM_METHODS.forEach(method => {
                    if (typeof window[objName][method] === 'function') {
                        const originalMethod = window[objName][method];

                        window[objName][method] = function(...args) {
                            debugLog(`${objName}.${method} called with:`, args);
                            analyzeMTMPush(objName, method, args);
                            return originalMethod.apply(this, args);
                        };

                        debugLog(`${objName}.${method} intercepted`);
                    }
                });
            }
        });
    }

    /**
     * Intercepts window._mtm direct pushes
     */
    function interceptWindowMTM() {
        if (!CONFIG.watchMTM) {
            debugLog('_mtm monitoring disabled');
            return;
        }

        if (typeof window._mtm === 'undefined') {
            window._mtm = [];
            debugLog('_mtm array created');
        }

        if (Array.isArray(window._mtm)) {
            let lastKnownLength = window._mtm.length;
            const originalPush = window._mtm.push;

            window._mtm.push = function(...args) {
                debugLog('_mtm.push called with:', args);

                args.forEach((data, argIndex) => {
                    if (data && typeof data === 'object' && data.__mtm_processed) {
                        debugLog('_mtm event already processed, skipping:', data);
                        return;
                    }

                    const currentArrayIndex = lastKnownLength + argIndex;
                    analyzeMTMDirectPush('_mtm', data, currentArrayIndex);
                });

                const result = originalPush.apply(this, args);
                lastKnownLength = this.length;
                return result;
            };

            // Periodic check for array length changes
            const checkArrayChanges = () => {
                if (window._mtm && window._mtm.length !== lastKnownLength) {
                    debugLog(`_mtm array length changed: ${lastKnownLength} -> ${window._mtm.length}`);

                    for (let i = lastKnownLength; i < window._mtm.length; i++) {
                        const entry = window._mtm[i];
                        debugLog(`Processing new _mtm entry [${i}]:`, entry);

                        if (entry && typeof entry === 'object' && entry.__mtm_processed) {
                            debugLog(`_mtm[${i}] already processed, skipping`);
                            continue;
                        }

                        analyzeMTMDirectPush('_mtm', entry, i);

                        if (entry && typeof entry === 'object') {
                            entry.__mtm_processed = true;
                            debugLog(`_mtm[${i}] marked as processed`);
                        }
                    }

                    lastKnownLength = window._mtm.length;
                }
            };

            setInterval(checkArrayChanges, INTERVALS.ARRAY_CHECK);
            debugLog('_mtm.push intercepted and periodic check started');
        }
    }

    /**
     * Analyzes MTM push method calls
     * @param {string} objectName - Name of the MTM object
     * @param {string} method - Method name that was called
     * @param {Array} args - Arguments passed to the method
     */
    function analyzeMTMPush(objectName, method, args) {
        debugLog(`Analyzing ${objectName}.${method}:`, args);

        args.forEach(data => {
            let eventData = {
                source: `${objectName}.${method}`,
                objectName: objectName,
                method: method,
                rawData: data
            };

            if (Array.isArray(data)) {
                eventData.eventName = data[0] || 'Unknown MTM Event';
                eventData.details = {
                    action: data[0],
                    parameters: data.slice(1)
                };
            } else if (data && typeof data === 'object') {
                eventData.eventName = data.event || data.eventName || 'MTM Object Event';
                eventData.details = data;
            } else {
                eventData.eventName = String(data);
                eventData.details = { value: data };
            }

            // Process with delay for consistent timing
            setTimeout(() => {
                // Add trigger analysis and container info
                addTriggerAnalysis(eventData);
                addContainerInfoDelayed(eventData);

                dispatchMatomoEvent(eventData);
            }, 50);
        });
    }

    /**
     * Analyzes direct MTM pushes
     * @param {string} objectName - Name of the MTM object
     * @param {any} data - Data that was pushed
     * @param {number|null} arrayIndex - Index in the array
     */
    function analyzeMTMDirectPush(objectName, data, arrayIndex = null) {
        debugLog(`Analyzing ${objectName} direct push:`, data,
            arrayIndex !== null ? `[Index: ${arrayIndex}]` : '');

        if (data && typeof data === 'object' && data.__mtm_processed) {
            debugLog('Event already marked as processed, skipping:', data);
            return;
        }

        const eventData = createMTMEventData(objectName, data, arrayIndex);

        // Process everything with a small delay to ensure MTM has processed the event
        setTimeout(() => {
            debugLog('Processing event after MTM processing delay...');

            // Add trigger analysis and container info after MTM processing
            addTriggerAnalysis(eventData);
            addContainerInfoDelayed(eventData);

            // Single dispatch with complete data
            dispatchMatomoEvent(eventData);
        }, 50);

        // Mark as processed immediately
        if (data && typeof data === 'object') {
            data.__mtm_processed = true;
            debugLog('_mtm event marked as processed:', data);
        }
    }

    /**
     * Creates event data object for MTM events
     * @param {string} objectName - Name of the MTM object
     * @param {any} data - Event data
     * @param {number|null} arrayIndex - Array index
     * @returns {Object} Event data object
     */
    function createMTMEventData(objectName, data, arrayIndex) {
        let eventData = {
            source: `${objectName}.push`,
            objectName: objectName,
            rawData: data,
            arrayIndex: arrayIndex
        };

        if (Array.isArray(data)) {
            eventData.eventName = data[0] || 'MTM Array Event';
            eventData.details = {
                action: data[0],
                parameters: data.slice(1)
            };
        } else if (data && typeof data === 'object') {
            eventData.eventName = data.event || data.eventName || 'MTM Direct Object';
            eventData.details = data;
        } else {
            eventData.eventName = 'MTM Direct Value';
            eventData.details = { value: data };
        }

        return eventData;
    }

    // =============================================================================
    // DATA LAYER MONITORING
    // =============================================================================

    /**
     * Intercepts dataLayer for MTM events
     */
    function interceptDataLayer() {
        if (!CONFIG.watchDataLayer) {
            debugLog('dataLayer monitoring disabled');
            return;
        }

        if (typeof window.dataLayer === 'undefined') {
            window.dataLayer = [];
            debugLog('dataLayer created');
        }

        if (Array.isArray(window.dataLayer)) {
            let lastKnownLength = window.dataLayer.length;
            const originalPush = window.dataLayer.push;

            window.dataLayer.push = function(...args) {
                debugLog('dataLayer.push called with:', args);

                args.forEach((data, argIndex) => {
                    if (data && typeof data === 'object' && data.__mtm_processed) {
                        debugLog('dataLayer event already processed, skipping:', data);
                        return;
                    }

                    analyzeMTMDataLayerEvent(data);
                });

                const result = originalPush.apply(this, args);
                lastKnownLength = this.length;
                return result;
            };

            // Periodic check for array length changes
            const checkDataLayerChanges = () => {
                if (window.dataLayer && window.dataLayer.length !== lastKnownLength) {
                    debugLog(`dataLayer array length changed: ${lastKnownLength} -> ${window.dataLayer.length}`);

                    for (let i = lastKnownLength; i < window.dataLayer.length; i++) {
                        const entry = window.dataLayer[i];
                        debugLog(`Processing new dataLayer entry [${i}]:`, entry);

                        if (entry && typeof entry === 'object' && entry.__mtm_processed) {
                            debugLog(`dataLayer[${i}] already processed, skipping`);
                            continue;
                        }

                        analyzeMTMDataLayerEvent(entry);

                        if (entry && typeof entry === 'object') {
                            entry.__mtm_processed = true;
                            debugLog(`dataLayer[${i}] marked as processed`);
                        }
                    }

                    lastKnownLength = window.dataLayer.length;
                }
            };

            setInterval(checkDataLayerChanges, INTERVALS.ARRAY_CHECK);
            debugLog('dataLayer.push intercepted and periodic check started');
        }
    }

    /**
     * Analyzes MTM events from dataLayer
     * @param {any} data - DataLayer event data
     */
    function analyzeMTMDataLayerEvent(data) {
        debugLog('analyzeMTMDataLayerEvent called with:', data);

        // Handle Arguments object
        if (data && typeof data === 'object' && data.length !== undefined && !Array.isArray(data)) {
            debugLog('Arguments object detected, converting...');
            const args = Array.from(data);
            if (args.length > 0 && typeof args[0] === 'object') {
                data = args[0];
            } else {
                debugLog('Cannot process Arguments:', args);
                return;
            }
        }

        if (!data || typeof data !== 'object') {
            debugLog('Event is not an object, skipping:', typeof data);
            return;
        }

        if (data.__mtm_processed) {
            debugLog('DataLayer event already processed, skipping:', data);
            return;
        }

        const isMTMEvent = (
            (data.event && (
                data.event.startsWith('mtm.') ||
                data.event === 'mtm' ||
                data.event.includes('CustomEvent') ||
                data['mtm.customEvent']
            )) ||
            data.hasOwnProperty('mtm') ||
            (data.hasOwnProperty('aMTMts') && data.hasOwnProperty('aMTMparams'))
        );

        debugLog('Event name:', JSON.parse(JSON.stringify(data.event)));

        if (isMTMEvent) {
            debugLog('MTM DataLayer event detected:', data);

            const firedTags = extractFiredTags(data);
            const eventData = createDataLayerEventData(data, firedTags);

            // Process with delay for consistent timing
            setTimeout(() => {
                // Add trigger analysis and container info
                addTriggerAnalysis(eventData);
                addContainerInfoDelayed(eventData);

                debugLog('Dispatching DataLayer event:', eventData);
                dispatchMatomoEvent(eventData);
            }, 50);

            data.__mtm_processed = true;
            debugLog('DataLayer event marked as processed:', data);
        } else {
            debugLog('Event is not an MTM event, skipping:', data.event);
        }
    }

    /**
     * Creates event data object for dataLayer events
     * @param {Object} data - DataLayer event data
     * @param {Array} firedTags - Extracted fired tags
     * @returns {Object} Event data object
     */
    function createDataLayerEventData(data, firedTags) {
        let eventData = {
            source: 'dataLayer',
            rawData: data,
            firedTags: firedTags
        };

        if (data.event === 'mtm.CustomEvent' || data['mtm.customEvent']) {
            eventData.eventName = data.eventName || data['mtm.customEventName'] || data.event || 'MTM Custom Event';
            eventData.details = {
                eventCategory: data.eventCategory,
                eventAction: data.eventAction,
                eventLabel: data.eventLabel,
                eventValue: data.eventValue,
                customEventName: data['mtm.customEventName'],
                ...data
            };
        } else if (data.event && data.event.startsWith('mtm.')) {
            eventData.eventName = data.event;
            eventData.details = { ...data };
        } else {
            eventData.eventName = data.event || data.eventName || data.type || 'MTM Event';
            eventData.details = { ...data };
        }

        return eventData;
    }

    // =============================================================================
    // TRIGGER ANALYSIS
    // =============================================================================

    /**
     * Adds trigger analysis to event data
     * @param {Object} eventData - Event data to enhance
     */
    function addTriggerAnalysis(eventData) {
        let analysisResult = {
            triggeredTriggers: [],
            firedTags: [],
            debugMode: false,
            totalTriggers: 0,
            totalTags: 0
        };

        // Access live MTM container directly for most current state
        if (typeof window.MatomoTagManager === 'undefined' ||
            !window.MatomoTagManager.containers ||
            window.MatomoTagManager.containers.length === 0) {
            eventData.triggerAnalysis = analysisResult;
            return;
        }

        const container = window.MatomoTagManager.containers[0];
        analysisResult.debugMode = container.triggers && container.tags;
        analysisResult.totalTriggers = container.triggers ? container.triggers.length : 0;
        analysisResult.totalTags = container.tags ? container.tags.length : 0;

        if (!analysisResult.debugMode) {
            eventData.triggerAnalysis = analysisResult;
            return;
        }

        // Extract event information for matching
        const eventInfo = extractEventInformation(eventData);

        // Get current timestamp for tag firing
        const currentTime = new Date().toLocaleTimeString('de-DE', {
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            fractionalSecondDigits: 3
        });

        // Analyze triggers using native methods
        container.triggers.forEach(trigger => {
            if (doesTriggerMatch(trigger, eventInfo)) {
                const triggerInfo = {
                    id: trigger.id,
                    name: trigger.name,
                    type: trigger.type,
                    conditions: trigger.conditions || [],
                    matchedConditions: getMatchedConditions(trigger, eventInfo)
                };

                analysisResult.triggeredTriggers.push(triggerInfo);

                // Use native getReferencedTags() method if available
                try {
                    if (typeof trigger.getReferencedTags === 'function') {
                        const referencedTags = trigger.getReferencedTags();
                        debugLog(`Trigger ${trigger.name} getReferencedTags():`, referencedTags);

                        if (Array.isArray(referencedTags)) {
                            referencedTags.forEach(tag => {
                                const tagObject = {
                                    name: tag.name || 'Unknown Tag',
                                    trigger: trigger.name,
                                    timestamp: currentTime
                                };
                                debugLog(`Adding tag object:`, tagObject);
                                analysisResult.firedTags.push(tagObject);
                            });
                        }
                    } else {
                        debugLog(`Trigger ${trigger.name}: getReferencedTags method not available, using fallback`);
                        // Fallback to manual method
                        if (trigger.referencedTags) {
                            trigger.referencedTags.forEach(tag => {
                                if (tag.fireTriggerIds && tag.fireTriggerIds.includes(trigger.id)) {
                                    const tagObject = {
                                        name: tag.name || 'Unknown Tag',
                                        trigger: trigger.name,
                                        timestamp: currentTime
                                    };
                                    debugLog(`Adding tag object (fallback):`, tagObject);
                                    analysisResult.firedTags.push(tagObject);
                                }
                            });
                        }
                    }
                } catch (error) {
                    debugLog('Error getting referenced tags:', error);
                }
            }
        });

        debugLog('Final firedTags array:', analysisResult.firedTags);

        eventData.triggerAnalysis = analysisResult;
        eventData.hasTriggeredTriggers = analysisResult.triggeredTriggers.length > 0;
        eventData.hasFiredTags = analysisResult.firedTags.length > 0;
    }

    /**
     * Extracts event information for trigger matching
     * @param {Object} eventData - Original event data
     * @returns {Object} Structured event information
     */
    function extractEventInformation(eventData) {
        let eventInfo = {
            eventName: null,
            dataLayerData: {},
            source: eventData.source || '',
            originalData: eventData
        };

        // Extract event name
        if (eventData.eventName) {
            eventInfo.eventName = eventData.eventName;
        }

        // Extract DataLayer data with enhanced timer recognition
        if (eventData.details) {
            // Copy all properties
            Object.keys(eventData.details).forEach(key => {
                if (key !== '__mtm_processed' && key !== '_debug') {
                    eventInfo.dataLayerData[key] = eventData.details[key];
                }
            });

            // Special handling for aEvent
            if (eventData.details.aEvent) {
                eventInfo.dataLayerData.aEvent = eventData.details.aEvent;
                eventInfo.eventName = eventData.details.aEvent;
            }

            // Timer event handling
            if (eventData.details.timer) {
                eventInfo.dataLayerData.timer = eventData.details.timer;
                if (eventData.details.timer.time !== undefined) {
                    eventInfo.dataLayerData['timer.time'] = eventData.details.timer.time;
                }
            }

            // Check in aMTMparams
            if (eventData.details.aMTMparams && typeof eventData.details.aMTMparams === 'object') {
                Object.keys(eventData.details.aMTMparams).forEach(key => {
                    if (key !== '__mtm_processed' && eventInfo.dataLayerData[key] === undefined) {
                        eventInfo.dataLayerData[key] = eventData.details.aMTMparams[key];
                    }
                });

                // Timer from aMTMparams
                if (eventData.details.aMTMparams.timer) {
                    eventInfo.dataLayerData.timer = eventData.details.aMTMparams.timer;
                    if (eventData.details.aMTMparams.timer.time !== undefined) {
                        eventInfo.dataLayerData['timer.time'] = eventData.details.aMTMparams.timer.time;
                    }
                }
            }

            // Array-based parameters (for _mtm.push(['aEvent', 'timer', {...}]))
            if (eventData.details.action === 'aEvent' && eventData.details.parameters) {
                const params = eventData.details.parameters;
                if (Array.isArray(params) && params.length >= 2) {
                    eventInfo.dataLayerData.aEvent = params[0];
                    if (params[1] && typeof params[1] === 'object') {
                        Object.assign(eventInfo.dataLayerData, params[1]);

                        // Timer-specific handling
                        if (params[1].timer && params[1].timer.time !== undefined) {
                            eventInfo.dataLayerData['timer.time'] = params[1].timer.time;
                        }
                    }
                }
            }
        }

        // rawData as additional source
        if (eventData.rawData && typeof eventData.rawData === 'object') {
            Object.keys(eventData.rawData).forEach(key => {
                if (key !== '__mtm_processed' && eventInfo.dataLayerData[key] === undefined) {
                    eventInfo.dataLayerData[key] = eventData.rawData[key];
                }
            });

            // Timer from rawData
            if (eventData.rawData.timer && eventData.rawData.timer.time !== undefined) {
                eventInfo.dataLayerData['timer.time'] = eventData.rawData.timer.time;
            }
        }

        debugLog('Extracted event info for trigger matching:', eventInfo);
        return eventInfo;
    }

    /**
     * Checks if a trigger matches an event
     * @param {Object} trigger - MTM Trigger object
     * @param {Object} eventInfo - Extracted event information
     * @returns {boolean} True if trigger matches
     */
    function doesTriggerMatch(trigger, eventInfo) {
        if (!trigger.conditions || trigger.conditions.length === 0) {
            return false;
        }

        // Check all trigger conditions with enhanced logic
        const conditionResults = trigger.conditions.map(condition => {
            return evaluateCondition(condition, eventInfo);
        });

        // For timer events: Special handling
        if (eventInfo.eventName === 'timer' || eventInfo.dataLayerData.aEvent === 'timer') {
            const hasTimerCondition = trigger.conditions.some(cond =>
                cond.actual && cond.actual.type === 'DataLayer' &&
                cond.actual.parameters && cond.actual.parameters.dataLayerName === 'aEvent' &&
                cond.expected === 'timer'
            );

            if (hasTimerCondition) {
                return conditionResults.every(result => result);
            }
        }

        // Standard: All conditions must be met
        return conditionResults.every(result => result);
    }

    /**
     * Evaluates a single trigger condition
     * @param {Object} condition - Trigger condition
     * @param {Object} eventInfo - Event information
     * @returns {boolean} True if condition is met
     */
    function evaluateCondition(condition, eventInfo) {
        const actualValue = getVariableValue(condition.actual, eventInfo);
        const expectedValue = condition.expected;
        const comparison = condition.comparison;

        debugLog(`Evaluating condition: "${actualValue}" ${comparison} "${expectedValue}" (types: ${typeof actualValue}, ${typeof expectedValue})`);

        switch (comparison) {
            case 'equals':
                // Enhanced: Numeric and string comparisons
                if (typeof actualValue === 'number' && !isNaN(Number(expectedValue))) {
                    return actualValue === Number(expectedValue);
                }
                return String(actualValue) === String(expectedValue);
            case 'notEquals':
                if (typeof actualValue === 'number' && !isNaN(Number(expectedValue))) {
                    return actualValue !== Number(expectedValue);
                }
                return String(actualValue) !== String(expectedValue);
            case 'contains':
                return String(actualValue).includes(String(expectedValue));
            case 'notContains':
                return !String(actualValue).includes(String(expectedValue));
            case 'startsWith':
                return String(actualValue).startsWith(String(expectedValue));
            case 'endsWith':
                return String(actualValue).endsWith(String(expectedValue));
            case 'matchesRegex':
                try {
                    const regex = new RegExp(expectedValue);
                    return regex.test(String(actualValue));
                } catch (e) {
                    return false;
                }
            case 'greaterThan':
                return Number(actualValue) > Number(expectedValue);
            case 'lessThan':
                return Number(actualValue) < Number(expectedValue);
            case 'greaterThanOrEqualTo':
                return Number(actualValue) >= Number(expectedValue);
            case 'lessThanOrEqualTo':
                return Number(actualValue) <= Number(expectedValue);
            default:
                debugLog(`Unknown comparison operator: ${comparison}`);
                return false;
        }
    }

    /**
     * Gets the value of a variable
     * @param {Object} variable - Variable definition
     * @param {Object} eventInfo - Event information
     * @returns {any} Variable value
     */
    function getVariableValue(variable, eventInfo) {
        if (!variable) return null;

        switch (variable.type) {
            case 'DataLayer':
                const dataLayerName = variable.parameters?.dataLayerName;
                if (dataLayerName) {
                    // Enhanced: Support for nested properties (e.g. "timer.time")
                    const value = getNestedDataLayerValue(dataLayerName, eventInfo);
                    if (value !== null && value !== undefined) {
                        debugLog(`Found DataLayer variable ${dataLayerName}:`, value);
                        return value;
                    }

                    debugLog(`DataLayer variable ${dataLayerName} not found, using default:`, variable.defaultValue);
                }
                return variable.defaultValue || null;

            case 'PageUrl':
                return window.location.href;

            case 'CustomJsFunction':
                return variable.defaultValue || null;

            default:
                debugLog(`Unknown variable type: ${variable.type}`);
                return variable.defaultValue || null;
        }
    }

    /**
     * Gets nested DataLayer values with dot notation
     * @param {string} dataLayerName - Variable name (e.g. "timer.time")
     * @param {Object} eventInfo - Event information
     * @returns {any} Variable value or null
     */
    function getNestedDataLayerValue(dataLayerName, eventInfo) {
        // Check first in event data
        if (eventInfo.dataLayerData.hasOwnProperty(dataLayerName)) {
            return eventInfo.dataLayerData[dataLayerName];
        }

        // For nested properties (e.g. "timer.time")
        if (dataLayerName.includes('.')) {
            const value = getNestedValue(eventInfo.dataLayerData, dataLayerName);
            if (value !== null && value !== undefined) {
                return value;
            }
        }

        // Fallback: Check in global dataLayer
        if (typeof window.dataLayer !== 'undefined') {
            for (let i = window.dataLayer.length - 1; i >= 0; i--) {
                const entry = window.dataLayer[i];
                if (!entry) continue;

                // Direct property
                if (entry.hasOwnProperty(dataLayerName)) {
                    return entry[dataLayerName];
                }

                // Nested property
                if (dataLayerName.includes('.')) {
                    const value = getNestedValue(entry, dataLayerName);
                    if (value !== null && value !== undefined) {
                        return value;
                    }
                }
            }
        }

        return null;
    }

    /**
     * Gets the matched conditions of a trigger
     * @param {Object} trigger - MTM Trigger
     * @param {Object} eventInfo - Event information
     * @returns {Array} Array of matched conditions
     */
    function getMatchedConditions(trigger, eventInfo) {
        if (!trigger.conditions) return [];

        return trigger.conditions.map(condition => {
            const actualValue = getVariableValue(condition.actual, eventInfo);
            const isMatched = evaluateCondition(condition, eventInfo);

            return {
                variable: condition.actual?.name || condition.actual?.parameters?.dataLayerName || 'Unknown Variable',
                variableType: condition.actual?.type || 'Unknown',
                dataLayerName: condition.actual?.parameters?.dataLayerName || null,
                comparison: condition.comparison,
                expected: condition.expected,
                actual: actualValue,
                matched: isMatched
            };
        });
    }

    /**
     * Adds container information to event data with current event context (delayed)
     * @param {Object} eventData - Event data to enhance
     */
    function addContainerInfoDelayed(eventData) {
        const containerInfo = getMTMContainerInfo();
        if (containerInfo.length > 0) {
            debugLog('Resolving variables after MTM event processing...');

            // Add resolved variables using .get() method with updated context
            if (typeof window.MatomoTagManager !== 'undefined' &&
                window.MatomoTagManager.containers &&
                window.MatomoTagManager.containers.length > 0) {

                const liveContainer = window.MatomoTagManager.containers[0];

                if (liveContainer.variables && Array.isArray(liveContainer.variables)) {
                    containerInfo[0].resolvedVariables = {};

                    liveContainer.variables.forEach((variable, index) => {
                        if (variable && variable.name) {
                            // Filter out Matomo configuration variables
                            if (variable.name.toLowerCase().includes('matomo') ||
                                variable.name.toLowerCase().includes('_matomo') ||
                                (variable.parameters && variable.parameters.dataLayerName &&
                                 variable.parameters.dataLayerName.toLowerCase().includes('matomo'))) {
                                return; // Skip Matomo config variables
                            }

                            let currentValue = 'undefined';

                            try {
                                if (typeof variable.get === 'function') {
                                    currentValue = variable.get();
                                    debugLog(`Variable ${variable.name} resolved to: ${currentValue} (after event)`);
                                } else {
                                    currentValue = 'get() method not available';
                                }
                            } catch (error) {
                                currentValue = `Error: ${error.message}`;
                                debugLog(`Variable ${variable.name}: Error - ${error.message}`);
                            }

                            containerInfo[0].resolvedVariables[variable.name] = {
                                currentValue: currentValue,
                                defaultValue: variable.defaultValue || null,
                                dataLayerName: variable.parameters?.dataLayerName || null,
                                type: variable.type
                            };
                        }
                    });
                }
            }

            eventData.containerInfo = containerInfo;
        }
    }

    /**
     * Adds trigger analysis to event data (delayed)
     * @param {Object} eventData - Event data to enhance
     */
    function addTriggerAnalysisDelayed(eventData) {
        let analysisResult = {
            triggeredTriggers: [],
            firedTags: [],
            debugMode: false,
            totalTriggers: 0,
            totalTags: 0
        };

        // Access live MTM container directly for most current state
        if (typeof window.MatomoTagManager === 'undefined' ||
            !window.MatomoTagManager.containers ||
            window.MatomoTagManager.containers.length === 0) {
            eventData.triggerAnalysis = analysisResult;
            return;
        }

        const container = window.MatomoTagManager.containers[0];
        analysisResult.debugMode = container.triggers && container.tags;
        analysisResult.totalTriggers = container.triggers ? container.triggers.length : 0;
        analysisResult.totalTags = container.tags ? container.tags.length : 0;

        if (!analysisResult.debugMode) {
            eventData.triggerAnalysis = analysisResult;
            return;
        }

        // Extract event information for matching
        const eventInfo = extractEventInformation(eventData);

        // Get current timestamp for tag firing
        const currentTime = new Date().toLocaleTimeString('de-DE', {
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            fractionalSecondDigits: 3
        });

        // Analyze triggers using native methods
        container.triggers.forEach(trigger => {
            if (doesTriggerMatch(trigger, eventInfo)) {
                const triggerInfo = {
                    id: trigger.id,
                    name: trigger.name,
                    type: trigger.type,
                    conditions: trigger.conditions || [],
                    matchedConditions: getMatchedConditions(trigger, eventInfo)
                };

                analysisResult.triggeredTriggers.push(triggerInfo);

                // Use native getReferencedTags() method if available
                try {
                    if (typeof trigger.getReferencedTags === 'function') {
                        const referencedTags = trigger.getReferencedTags();
                        debugLog(`Trigger ${trigger.name} getReferencedTags():`, referencedTags);

                        if (Array.isArray(referencedTags)) {
                            referencedTags.forEach(tag => {
                                const tagObject = {
                                    name: tag.name || 'Unknown Tag',
                                    trigger: trigger.name,
                                    timestamp: currentTime
                                };
                                debugLog(`Adding tag object:`, tagObject);
                                analysisResult.firedTags.push(tagObject);
                            });
                        }
                    } else {
                        debugLog(`Trigger ${trigger.name}: getReferencedTags method not available, using fallback`);
                        // Fallback to manual method
                        if (trigger.referencedTags) {
                            trigger.referencedTags.forEach(tag => {
                                if (tag.fireTriggerIds && tag.fireTriggerIds.includes(trigger.id)) {
                                    const tagObject = {
                                        name: tag.name || 'Unknown Tag',
                                        trigger: trigger.name,
                                        timestamp: currentTime
                                    };
                                    debugLog(`Adding tag object (fallback):`, tagObject);
                                    analysisResult.firedTags.push(tagObject);
                                }
                            });
                        }
                    }
                } catch (error) {
                    debugLog('Error getting referenced tags:', error);
                }
            }
        });

        debugLog('Final firedTags array:', analysisResult.firedTags);

        eventData.triggerAnalysis = analysisResult;
        eventData.hasTriggeredTriggers = analysisResult.triggeredTriggers.length > 0;
        eventData.hasFiredTags = analysisResult.firedTags.length > 0;
    }

    // =============================================================================
    // INITIAL ARRAY SCANNING
    // =============================================================================

    /**
     * Monitors existing MTM arrays and dataLayer on page load
     */
    function monitorExistingArrays() {
        debugLog('=== Checking existing arrays ===');

        const wasInitialScan = !initialScanCompleted;

        // Check existing _mtm entries
        if (CONFIG.watchMTM && window._mtm && Array.isArray(window._mtm)) {
            debugLog('Existing _mtm entries found:', window._mtm.length);
            debugLog('_mtm content:', window._mtm);

            window._mtm.forEach((entry, index) => {
                debugLog(`_mtm[${index}]:`, entry, 'Type:', typeof entry, 'Processed:', entry?.__mtm_processed);

                if (entry && typeof entry === 'object' && entry.__mtm_processed) {
                    debugLog(`_mtm[${index}] already processed, skipping`);
                    return;
                }

                const historicalTimestamp = Date.now() - (window._mtm.length - index) * INTERVALS.HISTORICAL_OFFSET;
                analyzeMTMDirectPushWithTimestamp('_mtm', entry, historicalTimestamp, wasInitialScan, index);

                if (entry && typeof entry === 'object') {
                    entry.__mtm_processed = true;
                    debugLog(`_mtm[${index}] marked as processed`);
                } else {
                    debugLog(`_mtm[${index}] is ${typeof entry}, cannot mark as processed`);
                }
            });
        }

        // Check existing dataLayer entries for MTM events
        if (CONFIG.watchDataLayer && window.dataLayer && Array.isArray(window.dataLayer)) {
            debugLog('Checking existing dataLayer entries for MTM events:', window.dataLayer.length);

            const mtmEvents = window.dataLayer.filter(entry => {
                if (!entry || typeof entry !== 'object') return false;

                return entry.event && (
                    entry.event.startsWith('mtm.') ||
                    entry.event === 'mtm' ||
                    entry.event.includes('CustomEvent') ||
                    entry['mtm.customEvent'] ||
                    entry.hasOwnProperty('mtm')
                );
            });

            debugLog('MTM events found in existing dataLayer:', mtmEvents.length);
            if (mtmEvents.length > 0) {
                debugLog('dataLayer MTM events:', mtmEvents);
            }

            mtmEvents.forEach((entry, index) => {
                debugLog(`dataLayer MTM[${index}]:`, entry, 'Processed:', entry.__mtm_processed);

                if (entry.__mtm_processed) {
                    debugLog(`dataLayer MTM[${index}] already processed, skipping`);
                    return;
                }

                const historicalTimestamp = Date.now() - (mtmEvents.length - index) * 3000;
                analyzeMTMDataLayerEventWithTimestamp(entry, historicalTimestamp, wasInitialScan);

                entry.__mtm_processed = true;
                debugLog(`dataLayer MTM[${index}] marked as processed`);
            });
        }

        if (wasInitialScan) {
            initialScanCompleted = true;
            debugLog('=== Initial scan completed ===');
        }
    }

    /**
     * Analyzes MTM DirectPush with custom timestamp
     * @param {string} objectName - Name of the MTM object
     * @param {any} data - Event data
     * @param {number} timestamp - Custom timestamp
     * @param {boolean} isHistorical - Whether this is a historical event
     * @param {number|null} arrayIndex - Array index
     */
    function analyzeMTMDirectPushWithTimestamp(objectName, data, timestamp, isHistorical = false, arrayIndex = null) {
        debugLog(`Analyzing ${objectName} ${isHistorical ? 'historical' : 'direct'} push:`, data,
            arrayIndex !== null ? `[Index: ${arrayIndex}]` : '');

        const firedTags = extractFiredTags(data);

        let eventData = {
            source: `${objectName}.push${isHistorical ? ' (historical)' : ''}`,
            objectName: objectName,
            rawData: data,
            firedTags: firedTags,
            isHistorical: isHistorical,
            arrayIndex: arrayIndex,
            sourceType: isHistorical ? 'initial-scan' : 'live-proxy',
            detectionMethod: isHistorical ? 'array-read' : 'proxy-intercept'
        };

        const debugInfo = {
            sourceType: eventData.sourceType,
            detectionMethod: eventData.detectionMethod,
            arrayIndex: arrayIndex,
            isHistorical: isHistorical
        };

        if (Array.isArray(data)) {
            eventData.eventName = data[0] || 'MTM Array Event';
            eventData.details = {
                action: data[0],
                parameters: data.slice(1),
                _debug: debugInfo
            };
        } else if (data && typeof data === 'object') {
            eventData.eventName = data.event || data.eventName || 'MTM Direct Object';
            eventData.details = {
                ...data,
                _debug: debugInfo
            };
        } else {
            eventData.eventName = 'MTM Direct Value';
            eventData.details = {
                value: data,
                _debug: debugInfo
            };
        }

        // Add trigger analysis and container info for historical events too
        addTriggerAnalysis(eventData);
        addContainerInfo(eventData);

        debugLog('Event data with trigger analysis:', eventData);
        dispatchMatomoEventWithTimestamp(eventData, timestamp);
    }

    /**
     * Adds container information to event data (immediate version)
     * @param {Object} eventData - Event data to enhance
     */
     function addContainerInfo(eventData) {
         const containerInfo = getMTMContainerInfo();
         if (containerInfo.length > 0) {
             eventData.containerInfo = containerInfo;
             debugLog('Container info added to event:', containerInfo);
         }
     }

    /**
     * Analyzes MTM DataLayer event with custom timestamp
     * @param {Object} data - DataLayer event data
     * @param {number} timestamp - Custom timestamp
     * @param {boolean} isHistorical - Whether this is a historical event
     */
    function analyzeMTMDataLayerEventWithTimestamp(data, timestamp, isHistorical = false) {
        debugLog(`MTM DataLayer event ${isHistorical ? 'historical' : ''} detected:`, data);

        const firedTags = extractFiredTags(data);

        let eventData = {
            source: `dataLayer${isHistorical ? ' (historical)' : ''}`,
            rawData: data,
            firedTags: firedTags,
            isHistorical: isHistorical,
            sourceType: isHistorical ? 'initial-scan' : 'live-proxy',
            detectionMethod: isHistorical ? 'array-read' : 'proxy-intercept'
        };

        const debugInfo = {
            sourceType: eventData.sourceType,
            detectionMethod: eventData.detectionMethod,
            isHistorical: isHistorical
        };

        if (data.event === 'mtm.CustomEvent' || data['mtm.customEvent']) {
            eventData.eventName = data.eventName || data['mtm.customEventName'] || data.event || 'MTM Custom Event';
            eventData.details = {
                eventCategory: data.eventCategory,
                eventAction: data.eventAction,
                eventLabel: data.eventLabel,
                eventValue: data.eventValue,
                customEventName: data['mtm.customEventName'],
                ...data,
                _debug: debugInfo
            };
        } else if (data.event && data.event.startsWith('mtm.')) {
            eventData.eventName = data.event;
            eventData.details = {
                ...data,
                _debug: debugInfo
            };
        } else {
            eventData.eventName = data.event || data.eventName || data.type || 'MTM Event';
            eventData.details = {
                ...data,
                _debug: debugInfo
            };
        }

        // Add trigger analysis and container info
        addTriggerAnalysis(eventData);
        addContainerInfo(eventData);

        debugLog('DataLayer event data with source info:', eventData);
        dispatchMatomoEventWithTimestamp(eventData, timestamp);
    }

    // =============================================================================
    // CONFIGURATION AND INITIALIZATION
    // =============================================================================

    /**
     * Automatically enables MTM Debug Mode if available
     */
     function autoEnableMTMDebugMode() {
         debugLog('Attempting to auto-enable MTM Debug Mode...');

         const enableDebugMode = () => {
             if (typeof window.MatomoTagManager !== 'undefined' &&
                 typeof window.MatomoTagManager.enableDebugMode === 'function') {

                 try {
                     window.MatomoTagManager.enableDebugMode();
                     debugLog('MTM Debug Mode automatically enabled');

                     // Dispatch event to notify content script
                     const event = new CustomEvent('mtmDebugModeEnabled', {
                         detail: { success: true },
                         bubbles: true
                     });
                     document.dispatchEvent(event);

                     return true;
                 } catch (error) {
                     debugLog('Error enabling MTM Debug Mode:', error);

                     // Dispatch error event
                     const event = new CustomEvent('mtmDebugModeEnabled', {
                         detail: { success: false, error: error.message },
                         bubbles: true
                     });
                     document.dispatchEvent(event);

                     return false;
                 }
             }
             return false;
         };

         // Try immediately
         if (enableDebugMode()) {
             return;
         }

         // If not available, wait and retry
         let attempts = 0;
         const maxAttempts = 20; // 10 seconds max

         const checkInterval = setInterval(() => {
             attempts++;

             if (enableDebugMode() || attempts >= maxAttempts) {
                 clearInterval(checkInterval);
                 if (attempts >= maxAttempts) {
                     debugLog('MTM Debug Mode auto-enable: Max attempts reached, MTM might not be available');

                     // Dispatch timeout event
                     const event = new CustomEvent('mtmDebugModeEnabled', {
                         detail: { success: false, error: 'timeout' },
                         bubbles: true
                     });
                     document.dispatchEvent(event);
                 }
             }
         }, 500);
     }

    /**
     * Handles configuration updates
     */
    function handleConfigurationUpdate() {
        // Listen for configuration via PostMessage (fallback)
        window.addEventListener('message', function(event) {
            if (event.data && event.data.type === 'MTM_CONFIG') {
                debugLog('Configuration received via PostMessage:', event.data.config);
                CONFIG = event.data.config;
                init();
            }
        });

        // Listen for configuration changes
        document.addEventListener('mtmConfigUpdate', function(event) {
            const newConfig = event.detail;
            debugLog('Configuration being updated:', newConfig);
            CONFIG = newConfig;

            // Restart extension after config change
            setTimeout(() => {
                location.reload();
            }, 500);
        });
    }

    /**
     * Sets up periodic monitoring for dynamically created arrays
     */
    function setupPeriodicMonitoring() {
        setInterval(() => {
            // Check MTM objects
            MTM_OBJECTS.forEach(objName => {
                if (typeof window[objName] !== 'undefined' &&
                    Array.isArray(window[objName]) &&
                    !window[objName].push.__intercepted) {

                    debugLog(`${objName} newly created, re-intercepting...`);

                    const originalPush = window[objName].push;
                    window[objName].push = function(...args) {
                        debugLog(`${objName}.push called with:`, args);
                        args.forEach(data => analyzeMTMDirectPush(objName, data));
                        return originalPush.apply(this, args);
                    };
                    window[objName].push.__intercepted = true;
                }
            });

            // Check dataLayer
            if (typeof window.dataLayer !== 'undefined' && !window.dataLayer.push.__intercepted) {
                debugLog('dataLayer newly created, re-intercepting...');
                interceptDataLayer();
                window.dataLayer.push.__intercepted = true;
            }
        }, 1000);
    }

    /**
     * Main initialization function
     */
    function init() {
        debugLog('Initializing Matomo Tag Manager Event Monitor...');

        // Auto-enable debug mode
        autoEnableMTMDebugMode();

        // Monitor existing arrays immediately
        monitorExistingArrays();

        // Set up interceptors based on configuration
        if (CONFIG.watchMTM) {
            interceptMTMPush();
            interceptWindowMTM();
        }

        if (CONFIG.watchDataLayer) {
            interceptDataLayer();
        }

        // Set up periodic monitoring
        setupPeriodicMonitoring();

        debugLog('Matomo Tag Manager Event Monitor initialized');
    }

    // =============================================================================
    // STARTUP
    // =============================================================================

    // Handle configuration updates
    handleConfigurationUpdate();

    // Start immediately or wait for DOM
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();