/**
 * CDP-based Context Handler for Oculus Browser
 * Replaces Chromedriver with direct CDP connection
 */

import { CDPClient, getCDPPages, type CDPPage } from './cdp-client';
import type { AppiumLogger } from '@appium/types';
import type { ADB } from 'appium-adb';

export interface WebViewContext {
    name: string;
    cdpClient?: CDPClient;
    page?: CDPPage;
    localPort?: number;
}

export class CDPContextManager {
    private contexts: Map<string, WebViewContext> = new Map();
    private availableContextSockets: Map<string, string> = new Map();
    private currentContext = 'NATIVE_APP';
    private logger: AppiumLogger;
    private adb: ADB;
    private deviceSerial: string;
    private basePort = 10900;
    private cachedViewportDimensions: { width: number; height: number } | null = null;

    constructor(adb: ADB, deviceSerial: string, logger: AppiumLogger) {
        this.adb = adb;
        this.deviceSerial = deviceSerial;
        this.logger = logger;
    }

    /**
     * Get list of available contexts
     */
    async getContexts(): Promise<string[]> {
        this.logger.info('[CDP] Getting available contexts');

        // Always have NATIVE_APP
        const contexts = ['NATIVE_APP'];
        this.availableContextSockets.clear();

        try {
            // Get webview sockets
            const sockets = await this._getWebViewSockets();
            this.logger.info(`[CDP] Found ${sockets.length} webview socket(s): ${JSON.stringify(sockets)}`);

            // Check for suitable sockets
            // We look for chrome_devtools_remote or webview_devtools_remote_*
            // prioritizing chrome_devtools_remote if multiple found (though unlikely for single app usage)
            let socketToUse: string | undefined;

            if (sockets.includes('chrome_devtools_remote')) {
                socketToUse = 'chrome_devtools_remote';
            } else if (sockets.includes('webview_devtools_remote_')) {
                socketToUse = 'webview_devtools_remote_';
            } else {
                // Fallback: try to find any socket that looks like a devtools socket
                socketToUse = sockets.find(s => s.startsWith('webview_devtools_remote') || s.includes('devtools'));
            }

            if (socketToUse) {
                const contextNames = socketToUse === 'chrome_devtools_remote'
                    ? ['WEBVIEW_com.oculus.browser', 'WEBVIEW_chrome']
                    : ['WEBVIEW_com.oculus.browser'];
                for (const contextName of contextNames) {
                    if (!contexts.includes(contextName)) {
                        contexts.push(contextName);
                    }
                    this.availableContextSockets.set(contextName, socketToUse);
                    this.logger.info(`[CDP] Mapped socket '${socketToUse}' to context '${contextName}'`);
                }
            }
        } catch (error) {
            this.logger.error(`[CDP] Failed to get contexts: ${error}`);
        }

        return contexts;
    }

    /**
     * Get active webview sockets
     */
    private async _getWebViewSockets(): Promise<string[]> {
        const output = await this.adb.shell(['cat', '/proc/net/unix']);
        const lines = output.split('\n');

        const sockets: string[] = [];
        for (const line of lines) {
            // Look for @chrome_devtools_remote or @webview_devtools_remote
            if (line.includes('devtools_remote')) {
                const match = line.match(/@([\w.\-]+)/);
                if (match) {
                    const socketName = match[1];
                    if (!sockets.includes(socketName)) {
                        sockets.push(socketName);
                    }
                }
            }
        }

        return sockets;
    }

    /**
     * Switch to a context
     */
    async setContext(contextName: string): Promise<void> {
        this.logger.info(`[CDP] Switching to context: ${contextName}`);

        if (contextName === 'NATIVE_APP') {
            // Switch to native
            const currentWebView = this.contexts.get(this.currentContext);
            if (currentWebView?.cdpClient) {
                await currentWebView.cdpClient.close();
            }
            this.currentContext = contextName;
            return;
        }

        // Check if context exists
        let targetContextName = contextName;
        const availableContexts = await this.getContexts();
        if (!availableContexts.includes(targetContextName)) {
            const webviewContexts = availableContexts.filter((name) => name.startsWith('WEBVIEW_'));
            if (targetContextName.startsWith('WEBVIEW_') && webviewContexts.length === 1) {
                this.logger.warn(`[CDP] Requested context '${targetContextName}' not found; using '${webviewContexts[0]}'`);
                targetContextName = webviewContexts[0];
            } else {
                throw new Error(`Context '${targetContextName}' not found. Available contexts: ${availableContexts.join(', ')}`);
            }
        }

        // Connect to webview if not already connected or if connection is dead
        const existingContext = this.contexts.get(targetContextName);
        this.logger.info(`[CDP] Existing context check: exists=${!!existingContext}, connected=${existingContext?.cdpClient?.isConnected()}`);

        if (!existingContext) {
            // No existing context, create new one
            await this._connectToWebView(targetContextName);
        } else if (!existingContext.cdpClient?.isConnected()) {
            // Connection is dead, reconnect without clearing cache
            this.logger.info(`[CDP] Existing connection is dead, reconnecting...`);
            await this._reconnectToWebView(targetContextName, existingContext);
        } else {
            this.logger.info(`[CDP] Reusing existing connection`);
        }

        this.currentContext = targetContextName;
        this.logger.info(`[CDP] Switched to context: ${targetContextName}`);
    }

    /**
     * Reconnect to an existing webview, preserving the CDPClient and its element cache
     */
    private async _reconnectToWebView(contextName: string, existingContext: any): Promise<void> {
        try {
            const socketName = this.availableContextSockets.get(contextName);
            if (!socketName) {
                throw new Error(`No socket mapping found for context ${contextName}`);
            }

            // Allocate new local port
            const localPort = this.basePort;
            this.basePort++;

            // Forward port to the socket
            this.logger.info(`[CDP] Forwarding ${socketName} to localhost:${localPort}`);
            await this.adb.adbExec([
                'forward',
                `tcp:${localPort}`,
                `localabstract:${socketName}`
            ]);

            try {
                // Get pages
                this.logger.info(`[CDP] Fetching pages from http://127.0.0.1:${localPort}/json`);
                const pages = await getCDPPages(localPort);
                if (pages.length === 0) {
                    throw new Error('No CDP pages found');
                }

                // Select the best page (prioritize real web pages over internal Chrome pages)
                const page = this._selectBestPage(pages);
                this.logger.info(`[CDP] Reconnecting to page: ${page.title} (${page.url})`);

                // Reconnect existing CDPClient to preserve element cache
                await existingContext.cdpClient.reconnect(page.webSocketDebuggerUrl);

                // Update context with new page and port info
                existingContext.page = page;
                existingContext.localPort = localPort;

                this.logger.info(`[CDP] Successfully reconnected to ${contextName}`);
            } catch (error) {
                // Clean up port forward on error
                await this.adb.adbExec(['forward', '--remove', `tcp:${localPort}`]);
                throw error;
            }
        } catch (error) {
            throw error;
        }
    }

    /**
     * Filter and select the best page from available CDP pages
     * Prioritizes actual web pages over internal Chrome pages
     */
    private _selectBestPage(pages: CDPPage[]): CDPPage {
        // Filter out internal Chrome pages
        const internalPagePrefixes = [
            'chrome://',
            'chrome-devtools://',
            'about:',
            'data:',
        ];

        // Separate pages into real pages and internal pages
        const realPages = pages.filter(page =>
            !internalPagePrefixes.some(prefix => page.url.startsWith(prefix))
        );

        const internalPages = pages.filter(page =>
            internalPagePrefixes.some(prefix => page.url.startsWith(prefix))
        );

        this.logger.info(`[CDP] Found ${realPages.length} real page(s) and ${internalPages.length} internal page(s)`);

        // Log all pages for debugging
        pages.forEach((page, index) => {
            this.logger.debug(`[CDP] Page ${index}: ${page.title} - ${page.url}`);
        });

        // Prefer real pages
        if (realPages.length > 0) {
            const selectedPage = realPages[0];
            this.logger.info(`[CDP] Selected real page: ${selectedPage.title} (${selectedPage.url})`);
            return selectedPage;
        }

        // Fallback to first page if no real pages found
        this.logger.warn(`[CDP] No real pages found, falling back to first page: ${pages[0].title} (${pages[0].url})`);
        return pages[0];
    }

    /**
     * Connect to webview via CDP
     */
    private async _connectToWebView(contextName: string): Promise<void> {
        this.logger.info(`[CDP] Connecting to webview: ${contextName}`);

        // Allocate local port
        const localPort = this.basePort;
        this.basePort++;

        // Get the socket name (default to chrome_devtools_remote if not found in map)
        const socketName = this.availableContextSockets.get(contextName) || 'chrome_devtools_remote';

        // Forward port to the socket
        this.logger.info(`[CDP] Forwarding ${socketName} to localhost:${localPort}`);
        await this.adb.adbExec([
            'forward',
            `tcp:${localPort}`,
            `localabstract:${socketName}`
        ]);

        try {
            // Get list of pages
            this.logger.info(`[CDP] Fetching pages from http://127.0.0.1:${localPort}/json`);
            const pages = await getCDPPages(localPort);

            if (pages.length === 0) {
                throw new Error('No CDP pages found');
            }

            // Select the best page (prioritize real web pages over internal Chrome pages)
            const page = this._selectBestPage(pages);
            this.logger.info(`[CDP] Connecting to page: ${page.title} (${page.url})`);

            // Create CDP client
            const cdpClient = new CDPClient(localPort, this.logger);
            await cdpClient.connect(page.webSocketDebuggerUrl);

            // Enable required domains
            await cdpClient.enableDomains();

            // Store context
            this.contexts.set(contextName, {
                name: contextName,
                cdpClient,
                page,
                localPort,
            });

            this.logger.info(`[CDP] Successfully connected to ${contextName}`);
        } catch (error) {
            // Clean up port forward on error
            await this.adb.adbExec(['forward', '--remove', `tcp:${localPort}`]);
            throw error;
        }
    }

    /**
     * Get current context name
     */
    getCurrentContext(): string {
        return this.currentContext;
    }

    /**
     * Get CDP client for a specific context
     */
    getClient(contextName: string): CDPClient | null {
        if (contextName === 'NATIVE_APP') {
            return null;
        }

        const context = this.contexts.get(contextName);
        return context?.cdpClient || null;
    }

    /**
     * Get CDP client for current context
     */
    getCurrentCDPClient(): CDPClient | null {
        if (this.currentContext === 'NATIVE_APP') {
            return null;
        }

        const context = this.contexts.get(this.currentContext);
        return context?.cdpClient || null;
    }

    /**
     * Get any available CDP client, regardless of current context
     * Useful for getting viewport info even when in NATIVE_APP
     * Returns the client even if not connected, as it can be used to get cached info
     */
    getAnyCDPClient(): CDPClient | null {
        // First check current context
        const currentClient = this.getCurrentCDPClient();
        if (currentClient) {
            return currentClient;
        }

        // If in NATIVE_APP, return any CDP client (even if not connected)
        for (const context of this.contexts.values()) {
            if (context.cdpClient) {
                return context.cdpClient;
            }
        }

        return null;
    }

    /**
     * Get cached viewport dimensions (if available)
     */
    getCachedViewportDimensions(): { width: number; height: number } | null {
        return this.cachedViewportDimensions;
    }

    /**
     * Update cached viewport dimensions
     * Should be called after successfully getting dimensions from CDP
     */
    updateCachedViewportDimensions(width: number, height: number): void {
        this.logger.info(`[CDP] Caching viewport dimensions: ${width}x${height}`);
        this.cachedViewportDimensions = { width, height };
    }

    /**
     * Execute command in current context
     */
    async executeInContext(command: () => Promise<any>): Promise<any> {
        const cdpClient = this.getCurrentCDPClient();

        if (!cdpClient) {
            throw new Error('Not in webview context. Current context: ' + this.currentContext);
        }

        if (!cdpClient.isConnected()) {
            throw new Error('CDP client not connected');
        }

        return await command();
    }

    /**
     * Clean up all contexts
     */
    async cleanup(): Promise<void> {
        this.logger.info('[CDP] Cleaning up all contexts');

        for (const [name, context] of this.contexts.entries()) {
            if (context.cdpClient) {
                await context.cdpClient.close();
            }

            if (context.localPort) {
                try {
                    await this.adb.adbExec(['forward', '--remove', `tcp:${context.localPort}`]);
                } catch (error) {
                    this.logger.warn(`[CDP] Failed to remove port forward: ${error}`);
                }
            }
        }

        this.contexts.clear();
        this.currentContext = 'NATIVE_APP';
    }
}
