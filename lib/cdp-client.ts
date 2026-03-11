/**
 * Chrome DevTools Protocol Client
 * Direct CDP connection to Oculus Browser, bypassing Chromedriver
 */

import WebSocket from 'ws';
import type { AppiumLogger } from '@appium/types';

export interface CDPCommand {
    id: number;
    method: string;
    params?: Record<string, any>;
}

export interface CDPResponse {
    id: number;
    result?: any;
    error?: {
        code: number;
        message: string;
    };
}

export interface CDPEvent {
    method: string;
    params?: Record<string, any>;
}

export interface CDPPage {
    id: string;
    type: string;
    title: string;
    url: string;
    webSocketDebuggerUrl: string;
    description?: string;
    devtoolsFrontendUrl?: string;
}

export class CDPClient {
    private ws: WebSocket | null = null;
    private messageId = 0;
    private pendingCommands: Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }> = new Map();
    private eventHandlers: Map<string, Set<(params: any) => void>> = new Map();
    private logger: AppiumLogger;
    private localPort: number;
    private connected = false;
    private elementCache: Map<string, number | string> = new Map(); // Maps elementId -> nodeId or objectId
    private elementIdCounter = 0;

    constructor(localPort: number, logger: AppiumLogger) {
        this.localPort = localPort;
        this.logger = logger;
    }

    /**
     * Connect to CDP WebSocket endpoint
     */
    async connect(wsUrl: string): Promise<void> {
        this.logger.info(`[CDP] Connecting to: ${wsUrl}`);

        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(wsUrl);

            this.ws.on('open', () => {
                this.connected = true;
                this.logger.info('[CDP] WebSocket connection established');
                resolve();
            });

            this.ws.on('message', (data: WebSocket.Data) => {
                this._handleMessage(data.toString());
            });

            this.ws.on('error', (error) => {
                this.logger.error(`[CDP] WebSocket error: ${error.message}`);
                reject(error);
            });

            this.ws.on('close', () => {
                this.connected = false;
                this.logger.info('[CDP] WebSocket connection closed');
            });
        });
    }

    /**
     * Handle incoming CDP messages
     */
    private _handleMessage(data: string): void {
        try {
            const message = JSON.parse(data);

            // Response to a command
            if ('id' in message && this.pendingCommands.has(message.id)) {
                const { resolve, reject } = this.pendingCommands.get(message.id)!;
                this.pendingCommands.delete(message.id);

                if (message.error) {
                    reject(new Error(`CDP Error: ${message.error.message}`));
                } else {
                    resolve(message.result || {});
                }
            }
            // Event notification
            else if ('method' in message) {
                const handlers = this.eventHandlers.get(message.method);
                if (handlers) {
                    for (const handler of handlers) {
                        handler(message.params || {});
                    }
                }
            }
        } catch (error) {
            this.logger.error(`[CDP] Failed to parse message: ${error}`);
        }
    }

    /**
     * Send CDP command and wait for response
     */
    async sendCommand(method: string, params?: Record<string, any>): Promise<any> {
        if (!this.ws || !this.connected) {
            throw new Error('CDP WebSocket not connected');
        }

        this.messageId++;
        const id = this.messageId;

        const command: CDPCommand = { id, method };
        if (params) {
            command.params = params;
        }

        return new Promise((resolve, reject) => {
            this.pendingCommands.set(id, { resolve, reject });

            this.ws!.send(JSON.stringify(command), (error) => {
                if (error) {
                    this.pendingCommands.delete(id);
                    reject(error);
                }
            });

            // Timeout after 30 seconds
            setTimeout(() => {
                if (this.pendingCommands.has(id)) {
                    this.pendingCommands.delete(id);
                    reject(new Error(`CDP command timeout: ${method}`));
                }
            }, 30000);
        });
    }

    /**
     * Subscribe to CDP events
     */
    on(event: string, handler: (params: any) => void): void {
        if (!this.eventHandlers.has(event)) {
            this.eventHandlers.set(event, new Set());
        }
        this.eventHandlers.get(event)!.add(handler);
    }

    /**
     * Unsubscribe from CDP events
     */
    off(event: string, handler: (params: any) => void): void {
        const handlers = this.eventHandlers.get(event);
        if (handlers) {
            handlers.delete(handler);
        }
    }

    /**
     * Navigate to URL
     */
    async navigate(url: string): Promise<void> {
        this.logger.info(`[CDP] Navigating to: ${url}`);
        await this.sendCommand('Page.navigate', { url });
    }

    /**
     * Execute JavaScript
     */
    async executeScript(script: string, awaitPromise = false): Promise<any> {
        const result = await this.sendCommand('Runtime.evaluate', {
            expression: script,
            returnByValue: true,
            awaitPromise,
        });

        if (result.exceptionDetails) {
            throw new Error(`Script execution failed: ${JSON.stringify(result.exceptionDetails)}`);
        }

        return result.result?.value;
    }

    /**
     * Execute JavaScript with arguments.
     * Wraps the script to make 'arguments' available.
     * WebDriver element references are resolved to actual DOM objects via objectId.
     */
    async executeScriptWithArgs(script: string, args: any[] = []): Promise<any> {
        const W3C_WEB_ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';
        const LEGACY_ELEMENT_KEY = 'ELEMENT';

        const getElementId = (arg: any): string | null => {
            if (arg && typeof arg === 'object') {
                if (arg[W3C_WEB_ELEMENT_KEY]) return arg[W3C_WEB_ELEMENT_KEY];
                if (arg[LEGACY_ELEMENT_KEY]) return arg[LEGACY_ELEMENT_KEY];
            }
            return null;
        };

        const hasElementArg = args.some(a => getElementId(a) !== null);

        if (!hasElementArg) {
            // Fast path: no DOM elements — just inline JSON args
            const safeArgs = JSON.stringify(args);
            const expression = `(function() { var arguments = ${safeArgs}; ${script} })()`;
            return await this.executeScript(expression);
        }

        // Slow path: resolve element references to real CDP objectIds so the DOM node is passed
        // as an actual object (not a plain JS object) to the script.
        const cdpArguments: Array<{ value?: any; objectId?: string }> = [];

        for (let i = 0; i < args.length; i++) {
            const elementId = getElementId(args[i]);
            if (elementId !== null) {
                const cachedValue = this.elementCache.get(elementId);
                if (!cachedValue) {
                    throw new Error(`Element not found in cache: ${elementId}`);
                }
                let objectId: string;
                if (typeof cachedValue === 'string') {
                    objectId = cachedValue;
                } else {
                    const resolved = await this.sendCommand('DOM.resolveNode', { nodeId: cachedValue });
                    if (!resolved?.object?.objectId) {
                        throw new Error(`Failed to resolve element node to object: ${elementId}`);
                    }
                    objectId = resolved.object.objectId;
                    this.elementCache.set(elementId, objectId);
                }
                cdpArguments.push({ objectId });
            } else {
                cdpArguments.push({ value: args[i] });
            }
        }

        // Use document as the "this" context for Runtime.callFunctionOn
        const docResult = await this.sendCommand('Runtime.evaluate', {
            expression: 'document',
            returnByValue: false,
        });
        const docObjectId: string = docResult.result?.objectId;
        if (!docObjectId) {
            throw new Error('Failed to get document objectId for script execution');
        }

        // Build function that exposes positional params as 'arguments'
        const paramNames = args.map((_, i) => `__arg${i}`).join(', ');
        const argumentsSetup = `var arguments = [${args.map((_, i) => `__arg${i}`).join(', ')}];`;
        const functionDeclaration = `function(${paramNames}) { ${argumentsSetup} ${script} }`;

        const callResult = await this.sendCommand('Runtime.callFunctionOn', {
            objectId: docObjectId,
            functionDeclaration,
            arguments: cdpArguments,
            returnByValue: true,
            awaitPromise: false,
        });

        if (callResult.exceptionDetails) {
            throw new Error(`Script execution failed: ${JSON.stringify(callResult.exceptionDetails)}`);
        }

        return callResult.result?.value;
    }

    /**
     * Get page title
     */
    async getTitle(): Promise<string> {
        return await this.executeScript('document.title');
    }

    /**
     * Get page URL
     */
    async getUrl(): Promise<string> {
        return await this.executeScript('document.location.href');
    }

    /**
     * Get page source
     */
    async getPageSource(): Promise<string> {
        return await this.executeScript('document.documentElement.outerHTML');
    }

    /**
     * Get window rectangle dimensions
     * Returns CSS logical pixel dimensions (not scaled by DPR).
     * WebDriver protocol coordinates are always in logical pixels.
     */
    async getWindowRect(): Promise<{ x: number; y: number; width: number; height: number }> {
        const rect = await this.executeScript(`({
            x: 0,
            y: 0,
            width: Math.round(window.innerWidth),
            height: Math.round(window.innerHeight)
        })`);
        return rect;
    }

    /**
     * Build DOM-based element tree with coordinates
     * Returns XML structure compatible with Appium page source
     * Coordinates account for scroll position and device pixel ratio
     */
    async getDOMElementTree(): Promise<string> {
        // Enable DOM domain and get the full document
        await this.sendCommand('DOM.enable');
        const doc = await this.sendCommand('DOM.getDocument', { depth: -1, pierce: true });

        // Clear element cache before building new tree
        this.elementCache.clear();
        this.elementIdCounter = 0;

        // Get scroll position via JavaScript
        const scrollAndDpr = await this.executeScript(`({
            scrollX: window.scrollX || window.pageXOffset || 0,
            scrollY: window.scrollY || window.pageYOffset || 0,
            dpr: window.devicePixelRatio || 1
        })`);

        const buildNode = async (node: any, depth = 0): Promise<string> => {
            if (depth > 50 || !node || node.nodeType !== 1) return ''; // Only process element nodes

            const nodeId = node.nodeId;
            const tagName = (node.nodeName || '').toLowerCase();

            // Skip script, style, and other non-visual elements
            if (['script', 'style', 'noscript', 'meta', 'link', 'title'].includes(tagName)) {
                return '';
            }

            // Generate and cache element ID
            const elementId = this.generateElementId();
            this.elementCache.set(elementId, nodeId);

            // Get element's bounding box
            let bounds = { left: 0, top: 0, right: 0, bottom: 0 };
            try {
                const boxModel = await this.sendCommand('DOM.getBoxModel', { nodeId });
                if (boxModel && boxModel.model && boxModel.model.border) {
                    const border = boxModel.model.border;
                    // border is an array of 8 numbers: [x1, y1, x2, y2, x3, y3, x4, y4]
                    const left = Math.min(border[0], border[6]);
                    const top = Math.min(border[1], border[3]);
                    const right = Math.max(border[2], border[4]);
                    const bottom = Math.max(border[5], border[7]);

                    // Apply scroll offset (no DPR scaling - stay in logical CSS pixels)
                    bounds = {
                        left: Math.round(left + scrollAndDpr.scrollX),
                        top: Math.round(top + scrollAndDpr.scrollY),
                        right: Math.round(right + scrollAndDpr.scrollX),
                        bottom: Math.round(bottom + scrollAndDpr.scrollY)
                    };
                }
            } catch (e) {
                // Element might not have a box model (display: none, etc.)
            }

            // Get attributes
            const attributes = node.attributes || [];
            const attrMap: any = {};
            for (let i = 0; i < attributes.length; i += 2) {
                const attrName = attributes[i];
                // Skip any elementId-related attributes from the DOM as we generate our own
                // This includes elementId, elementid, data-element-id, etc.
                if (!attrName || attrName.toLowerCase().includes('elementid')) {
                    continue;
                }
                attrMap[attrName] = attributes[i + 1] || '';
            }

            const className = attrMap.class || '';
            const id = attrMap.id || '';
            const ariaLabel = attrMap['aria-label'] || attrMap.title || '';
            const type = attrMap.type || '';

            // Get text content for this node
            let text = '';
            // For input, textarea, and select elements, get the value property
            if (['input', 'textarea', 'select'].includes(tagName)) {
                try {
                    const { object } = await this.sendCommand('DOM.resolveNode', { nodeId });
                    if (object && object.objectId) {
                        const valueResult = await this.sendCommand('Runtime.callFunctionOn', {
                            objectId: object.objectId,
                            functionDeclaration: 'function() { return this.value !== undefined ? this.value : ""; }',
                            returnByValue: true
                        });
                        text = valueResult?.result?.value || '';
                    }
                } catch (e) {
                    // If getting value fails, leave empty
                }
            } else {
                // For other elements, get text node content
                if (node.children) {
                    for (const child of node.children) {
                        if (child.nodeType === 3) { // Text node
                            text += (child.nodeValue || '');
                        }
                    }
                }
            }
            text = text.substring(0, 100).replace(/"/g, '&quot;').replace(/\n/g, ' ').trim();

            const width = bounds.right - bounds.left;
            const height = bounds.bottom - bounds.top;

            const xmlAttrs = [
                `class="${className}"`,
                `resource-id="${id}"`,
                `text="${text}"`,
                `content-desc="${ariaLabel}"`,
                `checkable="${type === 'checkbox' || type === 'radio'}"`,
                `checked="false"`,
                `clickable="${['button', 'a', 'input'].includes(tagName)}"`,
                `enabled="true"`,
                `focusable="${attrMap.tabindex !== undefined}"`,
                `focused="false"`,
                `scrollable="false"`,
                `selected="false"`,
                `displayed="${width > 0 && height > 0}"`,
                `bounds="[${bounds.left},${bounds.top}][${bounds.right},${bounds.bottom}]"`,
                `x="${bounds.left}"`,
                `y="${bounds.top}"`,
                `width="${width}"`,
                `height="${height}"`
            ].join(' ');

            // Process children
            let childrenXml = '';
            if (node.children) {
                for (const child of node.children) {
                    childrenXml += await buildNode(child, depth + 1);
                }
            }

            return `<${tagName} ${xmlAttrs}>${childrenXml}</${tagName}>`;
        };

        // Find body node
        let bodyNode = null;
        const findBody = (node: any): any => {
            if (node.nodeName === 'BODY') return node;
            if (node.children) {
                for (const child of node.children) {
                    const result = findBody(child);
                    if (result) return result;
                }
            }
            return null;
        };

        bodyNode = findBody(doc.root);
        if (!bodyNode) {
            return '<?xml version=\'1.0\' encoding=\'UTF-8\' standalone=\'yes\' ?>\n<hierarchy rotation="0">\n</hierarchy>';
        }

        const bodyXml = await buildNode(bodyNode);
        return `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>\n<hierarchy rotation="0">\n${bodyXml}\n</hierarchy>`;
    }

    /**
     * Generate a WebDriver-compatible element ID
     */
    private generateElementId(): string {
        this.elementIdCounter++;
        return `cdp-element-${this.elementIdCounter}`;
    }

    /**
     * Store element in cache and return WebDriver element object
     */
    private async cacheElement(nodeId: number): Promise<any> {
        const elementId = this.generateElementId();

        // Resolve nodeId to objectId to prevent staleness
        const result = await this.sendCommand('DOM.resolveNode', { nodeId });
        if (result && result.object && result.object.objectId) {
            this.elementCache.set(elementId, result.object.objectId);
        } else {
            // Fallback: store nodeId if resolution fails
            this.elementCache.set(elementId, nodeId);
        }

        return {
            'ELEMENT': elementId,
            'element-6066-11e4-a52e-4f735466cecf': elementId
        };
    }

    /**
     * Get objectId from element ID
     */
    getObjectId(elementId: string): string | number | undefined {
        return this.elementCache.get(elementId);
    }

    /**
     * Get nodeId from element ID (deprecated, use getObjectId)
     */
    getNodeId(elementId: string): number | undefined {
        const cached = this.elementCache.get(elementId);
        // If it's a string objectId, we can't return it as nodeId
        return typeof cached === 'number' ? cached : undefined;
    }

    /**
     * Find element using CDP DOM.querySelector
     */
    async findElementByStrategy(strategy: string, selector: string): Promise<any> {
        // Enable DOM domain if not already enabled
        await this.sendCommand('DOM.enable');

        // Get document root
        const { root } = await this.sendCommand('DOM.getDocument', { depth: 0 });

        let nodeId: number;

        if (strategy === 'css selector' || strategy === 'tag name') {
            // Tag names can be used directly as CSS selectors
            // Use DOM.querySelector for CSS selectors and tag names
            const result = await this.sendCommand('DOM.querySelector', {
                nodeId: root.nodeId,
                selector: selector
            });
            nodeId = result.nodeId;
        } else if (strategy === 'id') {
            // Find by ID attribute using CSS selector
            const result = await this.sendCommand('DOM.querySelector', {
                nodeId: root.nodeId,
                selector: `#${selector}`
            });
            nodeId = result.nodeId;
        } else if (strategy === 'class name') {
            // In web context, class name should find by CSS class
            // Note: Unlike Android's compound class names, web uses single class selector
            // If selector contains spaces, only use the first class
            const className = selector.split(' ')[0];
            const result = await this.sendCommand('DOM.querySelector', {
                nodeId: root.nodeId,
                selector: `.${className}`
            });
            nodeId = result.nodeId;
        } else if (strategy === 'xpath') {
            // Translate Android-specific attributes to HTML equivalents
            let translatedSelector = selector.replace(/@resource-id=/g, '@id=');

            // For content-desc, check both aria-label and title since web elements use both
            // Convert [@content-desc="value"] to [@aria-label="value" or @title="value"]
            translatedSelector = translatedSelector.replace(
                /@content-desc\s*=\s*"([^"]*)"/g,
                '(@aria-label="$1" or @title="$1")'
            );
            translatedSelector = translatedSelector.replace(
                /@content-desc\s*=\s*'([^']*)'/g,
                "(@aria-label='$1' or @title='$1')"
            );

            // For text attribute (Android-specific), convert to text() function (web standard)
            // Convert [@text="value"] to [text()="value"] — matches //a[text()="value"] form
            translatedSelector = translatedSelector.replace(
                /@text\s*=\s*"([^"]*)"/g,
                'text()="$1"'
            );
            translatedSelector = translatedSelector.replace(
                /@text\s*=\s*'([^']*)'/g,
                "text()='$1'"
            );

            this.logger.info(`[CDP] Original XPath: ${selector}`);
            this.logger.info(`[CDP] Translated XPath: ${translatedSelector}`);

            // Use DOM.performSearch for XPath queries
            const searchResult = await this.sendCommand('DOM.performSearch', {
                query: translatedSelector,
                includeUserAgentShadowDOM: true
            });

            this.logger.info(`[CDP] XPath search result count: ${searchResult.resultCount || 0}`);

            if (!searchResult.resultCount || searchResult.resultCount === 0) {
                throw new Error(`Element not found: ${selector}`);
            }

            // Get all search results to find the best match
            const { nodeIds } = await this.sendCommand('DOM.getSearchResults', {
                searchId: searchResult.searchId,
                fromIndex: 0,
                toIndex: Math.min(searchResult.resultCount, 10) // Limit to first 10 for performance
            });

            // Discard the search results
            await this.sendCommand('DOM.discardSearchResults', {
                searchId: searchResult.searchId
            });

            if (!nodeIds || nodeIds.length === 0) {
                throw new Error(`Element not found: ${selector}`);
            }

            // For input/textarea/select elements, prefer the one with a non-empty value
            let selectedNodeId: number | undefined;
            if (selector.includes('input') || selector.includes('textarea') || selector.includes('select')) {
                for (const candidateNodeId of nodeIds) {
                    try {
                        const { object } = await this.sendCommand('DOM.resolveNode', {
                            nodeId: candidateNodeId
                        });

                        // Check if this element has a non-empty value
                        const valueResult = await this.sendCommand('Runtime.callFunctionOn', {
                            objectId: object.objectId,
                            functionDeclaration: 'function() { return this.value || ""; }',
                            returnByValue: true
                        });

                        const value = valueResult?.result?.value || '';
                        this.logger.info(`[CDP] Checking element at index ${nodeIds.indexOf(candidateNodeId)}, value: "${value}"`);

                        if (value) {
                            // Found an element with a value, use it
                            this.logger.info(`[CDP] Using element with non-empty value`);
                            selectedNodeId = candidateNodeId;
                            break;
                        }
                    } catch (e) {
                        // Continue to next candidate
                        this.logger.debug(`[CDP] Error checking candidate element: ${e}`);
                    }
                }
            }

            // If no element with value found, or not an input element, use the first one
            nodeId = selectedNodeId ?? nodeIds[0];
        } else {
            throw new Error(`Unsupported locator strategy: ${strategy}`);
        }

        if (!nodeId || nodeId === 0) {
            throw new Error(`Element not found: ${selector}`);
        }

        return await this.cacheElement(nodeId);
    }

    /**
     * Find multiple elements using CDP
     */
    async findElementsByStrategy(strategy: string, selector: string): Promise<any[]> {
        await this.sendCommand('DOM.enable');
        const { root } = await this.sendCommand('DOM.getDocument', { depth: 0 });

        let nodeIds: number[] = [];

        if (strategy === 'css selector') {
            const result = await this.sendCommand('DOM.querySelectorAll', {
                nodeId: root.nodeId,
                selector: selector
            });
            nodeIds = result.nodeIds || [];
        } else if (strategy === 'tag name') {
            // Treat tag name as CSS selector
            const result = await this.sendCommand('DOM.querySelectorAll', {
                nodeId: root.nodeId,
                selector: selector
            });
            nodeIds = result.nodeIds || [];
        } else if (strategy === 'id') {
            // Find by ID attribute using CSS selector
            const result = await this.sendCommand('DOM.querySelectorAll', {
                nodeId: root.nodeId,
                selector: `#${selector}`
            });
            nodeIds = result.nodeIds || [];
        } else if (strategy === 'xpath') {
            // Translate Android-specific attributes to HTML equivalents
            let translatedSelector = selector.replace(/@resource-id=/g, '@id=');

            // For content-desc, check both aria-label and title since web elements use both
            // Convert [@content-desc="value"] to [@aria-label="value" or @title="value"]
            translatedSelector = translatedSelector.replace(
                /@content-desc\s*=\s*"([^"]*)"/g,
                '(@aria-label="$1" or @title="$1")'
            );
            translatedSelector = translatedSelector.replace(
                /@content-desc\s*=\s*'([^']*)'/g,
                "(@aria-label='$1' or @title='$1')"
            );

            // For text attribute (Android-specific), convert to text() function (web standard)
            // Convert [@text="value"] to [text()="value"] — matches //a[text()="value"] form
            translatedSelector = translatedSelector.replace(
                /@text\s*=\s*"([^"]*)"/g,
                'text()="$1"'
            );
            translatedSelector = translatedSelector.replace(
                /@text\s*=\s*'([^']*)'/g,
                "text()='$1'"
            );

            this.logger.info(`[CDP] Original XPath: ${selector}`);
            this.logger.info(`[CDP] Translated XPath for findElements: ${translatedSelector}`);

            // Use DOM.performSearch for consistent XPath handling
            const searchResult = await this.sendCommand('DOM.performSearch', {
                query: translatedSelector,
                includeUserAgentShadowDOM: true
            });

            this.logger.info(`[CDP] XPath search result count: ${searchResult.resultCount || 0}`);

            if (searchResult.resultCount && searchResult.resultCount > 0) {
                // Get all search results
                const { nodeIds: searchNodeIds } = await this.sendCommand('DOM.getSearchResults', {
                    searchId: searchResult.searchId,
                    fromIndex: 0,
                    toIndex: searchResult.resultCount
                });

                // Discard the search results
                await this.sendCommand('DOM.discardSearchResults', {
                    searchId: searchResult.searchId
                });

                if (searchNodeIds && searchNodeIds.length > 0) {
                    nodeIds = searchNodeIds;
                }
            }
        } else {
            throw new Error(`Unsupported locator strategy: ${strategy}`);
        }

        const elements: any[] = [];
        for (const nodeId of nodeIds.filter(id => id !== 0)) {
            elements.push(await this.cacheElement(nodeId));
        }
        return elements;
    }

    /**
     * Get element attribute using cached element
     */
    async getElementAttribute(elementId: string, attributeName: string): Promise<string | null> {
        const cachedValue = this.elementCache.get(elementId);
        if (!cachedValue) {
            throw new Error(`Element not found in cache: ${elementId}`);
        }

        // Special handling for 'text' and 'value' - these should return the property value, not the attribute
        // For input/textarea elements, the value property reflects current content, not the initial HTML attribute
        if (attributeName === 'text' || attributeName === 'value') {
            let objectId: string;

            // If cached as nodeId (number), resolve to objectId
            if (typeof cachedValue === 'number') {
                const result = await this.sendCommand('DOM.resolveNode', { nodeId: cachedValue });
                if (!result || !result.object || !result.object.objectId) {
                    throw new Error('Failed to resolve element');
                }
                objectId = result.object.objectId;
            } else {
                objectId = cachedValue;
            }

            // Use Runtime.callFunctionOn to get the property value
            const propResult = await this.sendCommand('Runtime.callFunctionOn', {
                objectId: objectId,
                functionDeclaration: attributeName === 'text'
                    ? 'function() { return this.value || this.textContent || this.innerText || ""; }'
                    : 'function() { return this.value !== undefined ? this.value : this.getAttribute("value") || ""; }',
                returnByValue: true
            });

            if (propResult.exceptionDetails) {
                this.logger.error(`[CDP] Failed to get ${attributeName}: ${JSON.stringify(propResult.exceptionDetails)}`);
                return null;
            }

            return String(propResult.result?.value || '');
        }

        // For other attributes, use DOM.getAttributes
        let nodeId: number;

        // If cached as objectId (string), resolve to nodeId
        if (typeof cachedValue === 'string') {
            const { node } = await this.sendCommand('DOM.describeNode', { objectId: cachedValue });
            nodeId = node.nodeId;
        } else {
            nodeId = cachedValue;
        }

        const { attributes } = await this.sendCommand('DOM.getAttributes', { nodeId });

        // Attributes come as [name1, value1, name2, value2, ...]
        for (let i = 0; i < attributes.length; i += 2) {
            if (attributes[i] === attributeName) {
                return attributes[i + 1];
            }
        }

        return null;
    }

    /**
     * Get element text using cached element
     */
    async getElementText(elementId: string): Promise<string> {
        this.logger.debug(`[CDP] Getting text for element: ${elementId}`);
        const cachedValue = this.elementCache.get(elementId);
        if (!cachedValue) {
            this.logger.error(`[CDP] Element not found in cache: ${elementId}`);
            throw new Error(`Element not found in cache: ${elementId}`);
        }

        this.logger.debug(`[CDP] Cached value type: ${typeof cachedValue}, value: ${cachedValue}`);
        let objectId: string;

        // If cached as nodeId (number), resolve to objectId
        if (typeof cachedValue === 'number') {
            const result = await this.sendCommand('DOM.resolveNode', { nodeId: cachedValue });
            if (!result || !result.object || !result.object.objectId) {
                this.logger.warn(`[CDP] Failed to resolve nodeId ${cachedValue} to objectId`);
                return '';
            }
            objectId = result.object.objectId;
            this.logger.debug(`[CDP] Resolved nodeId ${cachedValue} to objectId ${objectId}`);
        } else {
            objectId = cachedValue;
        }

        // Use Runtime.callFunctionOn to get text from the element
        // For input/textarea/select, use 'value' property; for others use textContent
        this.logger.debug(`[CDP] Getting text/value from objectId: ${objectId}`);
        const textResult = await this.sendCommand('Runtime.callFunctionOn', {
            objectId: objectId,
            functionDeclaration: 'function() { return this.value !== undefined ? this.value : (this.textContent || this.innerText || ""); }',
            returnByValue: true
        });

        if (textResult.exceptionDetails) {
            this.logger.error(`[CDP] Failed to get text: ${JSON.stringify(textResult.exceptionDetails)}`);
            throw new Error(`Failed to get element text: ${JSON.stringify(textResult.exceptionDetails)}`);
        }

        const text = textResult.result?.value || '';
        this.logger.debug(`[CDP] Element text: "${text}"`);
        return text;
    }

    /**
     * Click element using cached element
     */
    async clickElement(elementId: string): Promise<void> {
        const cachedValue = this.elementCache.get(elementId);
        if (!cachedValue) {
            throw new Error(`Element not found in cache: ${elementId}`);
        }

        let objectId: string;

        // If cached as nodeId (number), resolve to objectId
        if (typeof cachedValue === 'number') {
            const result = await this.sendCommand('DOM.resolveNode', { nodeId: cachedValue });
            if (!result || !result.object || !result.object.objectId) {
                throw new Error('Failed to resolve element');
            }
            objectId = result.object.objectId;
        } else {
            objectId = cachedValue;
        }

        // Use Runtime.callFunctionOn to click the element
        const clickResult = await this.sendCommand('Runtime.callFunctionOn', {
            objectId: objectId,
            functionDeclaration: 'function() { this.click(); }',
            returnByValue: false
        });

        if (clickResult.exceptionDetails) {
            throw new Error(`Failed to click element: ${JSON.stringify(clickResult.exceptionDetails)}`);
        }
    }

    /**
     * Get element rect (bounds) using cached element
     */
    async getElementRect(elementId: string): Promise<{ x: number; y: number; width: number; height: number }> {
        const cachedValue = this.elementCache.get(elementId);
        if (!cachedValue) {
            throw new Error(`Element not found in cache: ${elementId}`);
        }

        let objectId: string;

        // If cached as nodeId (number), resolve to objectId
        if (typeof cachedValue === 'number') {
            const result = await this.sendCommand('DOM.resolveNode', { nodeId: cachedValue });
            if (!result || !result.object || !result.object.objectId) {
                throw new Error('Failed to resolve element');
            }
            objectId = result.object.objectId;
        } else {
            objectId = cachedValue;
        }

        // Use Runtime.callFunctionOn to get element bounds
        const rectResult = await this.sendCommand('Runtime.callFunctionOn', {
            objectId: objectId,
            functionDeclaration: `function() {
                const rect = this.getBoundingClientRect();
                return {
                    x: Math.round(rect.left + window.scrollX),
                    y: Math.round(rect.top + window.scrollY),
                    width: Math.round(rect.width),
                    height: Math.round(rect.height)
                };
            }`,
            returnByValue: true
        });

        if (rectResult.exceptionDetails) {
            throw new Error(`Failed to get element rect: ${JSON.stringify(rectResult.exceptionDetails)}`);
        }

        return rectResult.result?.value || { x: 0, y: 0, width: 0, height: 0 };
    }

    /**
     * Find element by CSS selector (legacy method)
     */
    async findElement(selector: string): Promise<any> {
        const result = await this.executeScript(
            `(function() {
        const el = document.querySelector('${selector.replace(/'/g, "\\'")}');
        if (!el) return null;
        return {
          tagName: el.tagName,
          id: el.id,
          className: el.className,
          text: el.textContent,
        };
      })()`
        );

        if (!result) {
            throw new Error(`Element not found: ${selector}`);
        }

        return result;
    }

    /**
     * Click element by CSS selector
     */
    async click(selector: string): Promise<void> {
        await this.executeScript(`document.querySelector('${selector.replace(/'/g, "\\'")}').click()`);
    }

    /**
     * Click at specific coordinates
     */
    async clickAtCoordinates(x: number, y: number): Promise<void> {
        await this.sendCommand('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x,
            y,
            button: 'left',
            clickCount: 1
        });
        await this.sendCommand('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x,
            y,
            button: 'left',
            clickCount: 1
        });
    }

    /**
     * Find element by XPath and return its bounds
     */
    async findElementByXPath(xpath: string): Promise<{ x: number; y: number; width: number; height: number } | null> {
        const script = `
            (function() {
                const result = document.evaluate('${xpath.replace(/'/g, "\\'")}', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                const el = result.singleNodeValue;
                if (!el) return null;
                const rect = el.getBoundingClientRect();
                const dpr = window.devicePixelRatio || 1;
                return {
                    x: Math.round((rect.left + window.scrollX) * dpr),
                    y: Math.round((rect.top + window.scrollY) * dpr),
                    width: Math.round(rect.width * dpr),
                    height: Math.round(rect.height * dpr)
                };
            })()
        `;
        return await this.executeScript(script);
    }

    /**
     * Get element text
     */
    async getText(selector: string): Promise<string> {
        return await this.executeScript(`document.querySelector('${selector.replace(/'/g, "\\'")}').textContent`);
    }

    /**
     * Set element value
     */
    async setValue(selector: string, value: string): Promise<void> {
        await this.executeScript(
            `(function() {
        const el = document.querySelector('${selector.replace(/'/g, "\\'")}');
        el.value = '${value.replace(/'/g, "\\'")}';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      })()`
        );
    }

    /**
     * Send keys to an element by its cached element ID
     */
    async sendKeys(elementId: string, text: string): Promise<void> {
        // Get the objectId from cache (now we store objectId instead of nodeId)
        const cachedValue = this.elementCache.get(elementId);
        if (!cachedValue) {
            throw new Error(`Element not found in cache: ${elementId}`);
        }

        let objectId: string;

        // Check if cached value is already an objectId (string) or a nodeId (number)
        if (typeof cachedValue === 'string') {
            // Already an objectId
            objectId = cachedValue;
        } else {
            // It's a nodeId, need to resolve it
            const result = await this.sendCommand('DOM.resolveNode', {
                nodeId: cachedValue
            });

            if (!result || !result.object || !result.object.objectId) {
                throw new Error('Failed to resolve element');
            }
            objectId = result.object.objectId;
        }

        // Focus the element and set its value
        await this.sendCommand('Runtime.callFunctionOn', {
            objectId: objectId,
            functionDeclaration: `function(text) { 
                this.focus(); 
                this.value = text;
                this.dispatchEvent(new Event('input', { bubbles: true }));
                this.dispatchEvent(new Event('change', { bubbles: true }));
            }`,
            arguments: [{ value: text }],
            returnByValue: false
        });
    }

    /**
     * Take screenshot
     */
    async takeScreenshot(): Promise<string> {
        const result = await this.sendCommand('Page.captureScreenshot', {
            format: 'png',
        });
        return result.data;
    }

    /**
     * Enable domains
     */
    async enableDomains(): Promise<void> {
        await Promise.all([
            this.sendCommand('Page.enable'),
            this.sendCommand('Runtime.enable'),
            this.sendCommand('DOM.enable'),
        ]);
    }

    /**
     * Close connection
     */
    async close(): Promise<void> {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
            this.connected = false;
            this.pendingCommands.clear();
            this.eventHandlers.clear();
        }
    }

    /**
     * Reconnect to a new WebSocket URL without clearing element cache
     */
    async reconnect(wsUrl: string): Promise<void> {
        this.logger.info(`[CDP] Reconnecting to: ${wsUrl}`);

        // Close existing connection without clearing cache
        if (this.ws) {
            this.ws.close();
            this.ws = null;
            this.connected = false;
            this.pendingCommands.clear();
            this.eventHandlers.clear();
        }

        // Note: elementCache is NOT cleared to preserve element references

        // Establish new connection
        await this.connect(wsUrl);

        // Re-enable domains
        await this.enableDomains();
    }

    /**
     * Check if connected
     */
    isConnected(): boolean {
        return this.connected;
    }
}

/**
 * Get available CDP pages from the browser
 */
export async function getCDPPages(port: number): Promise<CDPPage[]> {
    const url = `http://127.0.0.1:${port}/json`;
    const axios = (await import('axios')).default;
    const response = await axios.get(url);
    return response.data as CDPPage[];
}
