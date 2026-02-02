import type { Rect, Size } from '@appium/types';
import type { AndroidUiautomator2Driver } from '../driver';
import type { RelativeRect } from './types';

/**
 * Gets the status bar height in pixels.
 * @returns The status bar height in pixels.
 */
export async function getStatusBarHeight(this: AndroidUiautomator2Driver): Promise<number> {
  if (this.opts.appPackage === 'com.oculus.browser') {
    return 0;
  }
  const { statusBar } = (await this.uiautomator2.jwproxy.command(`/appium/device/system_bars`, 'GET', {})) as {
    statusBar: number;
  };
  return statusBar;
}

/**
 * Gets the device pixel ratio.
 * @returns The device pixel ratio as a string.
 */
export async function getDevicePixelRatio(this: AndroidUiautomator2Driver): Promise<string> {
  return String(await this.uiautomator2.jwproxy.command('/appium/device/pixel_ratio', 'GET', {}));
}

/**
 * Gets the viewport rectangle coordinates.
 * @returns The viewport rectangle (left, top, width, height), accounting for status bar height.
 */
export async function getViewPortRect(this: AndroidUiautomator2Driver): Promise<RelativeRect> {
  let deviceScreenSize = await this.getWindowSize();

  // For Oculus Browser, use CDP to get actual page dimensions
  if (this.opts.appPackage === 'com.oculus.browser') {
    const cdpManager = (this as any).cdpContextManager;

    // First, try to use cached dimensions if available
    const cachedDimensions = cdpManager?.getCachedViewportDimensions();
    if (cachedDimensions) {
      this.log.info(`[CDP] Using cached viewport dimensions: ${cachedDimensions.width}x${cachedDimensions.height}`);
      deviceScreenSize = cachedDimensions;
    } else {
      // No cache, need to get from CDP
      const cdpClient = cdpManager?.getAnyCDPClient();
      if (cdpClient) {
        // Retry logic for page load - CDP may return 0 dimensions initially
        let attempts = 0;
        const maxAttempts = 5;
        const delayMs = 1000;

        this.log.info('[CDP] Attempting to retrieve viewport dimensions from CDP...');

        while (attempts < maxAttempts) {
          try {
            // Reconnect if not connected
            if (!cdpClient.isConnected()) {
              this.log.info(`[CDP] CDP client not connected, attempting to reconnect...`);
              if (cdpManager) {
                const contexts = await cdpManager.getContexts();
                const webviewContext = contexts.find((c: string) => c.startsWith('WEBVIEW_'));
                if (webviewContext) {
                  const savedContext = cdpManager.currentContext;
                  await cdpManager.setContext(webviewContext);
                  // Get dimensions while connected
                  const rect = await cdpClient.getWindowRect();
                  const width = rect.width;
                  const height = rect.height;
                  // Switch back to original context
                  await cdpManager.setContext(savedContext);

                  if (!isNaN(width) && !isNaN(height) && width > 0 && height > 0) {
                    this.log.info(`[CDP] Successfully retrieved viewport dimensions: ${width}x${height}`);
                    cdpManager.updateCachedViewportDimensions(width, height);
                    deviceScreenSize = { width, height };
                    break;
                  }
                }
              }
            } else {
              const rect = await cdpClient.getWindowRect();
              const width = rect.width;
              const height = rect.height;

              this.log.info(`[CDP] Attempt ${attempts + 1}/${maxAttempts}: Got dimensions ${width}x${height}`);

              if (!isNaN(width) && !isNaN(height) && width > 0 && height > 0) {
                this.log.info(`[CDP] Successfully retrieved viewport dimensions: ${width}x${height}`);
                cdpManager.updateCachedViewportDimensions(width, height);
                deviceScreenSize = { width, height };
                break;
              }
            }

            // Invalid dimensions, wait and retry
            attempts++;
            if (attempts < maxAttempts) {
              this.log.info(`[CDP] Invalid dimensions, waiting ${delayMs}ms before retry...`);
              await new Promise(resolve => setTimeout(resolve, delayMs));
            }
          } catch (e) {
            this.log.warn(`[CDP] Attempt ${attempts + 1} failed: ${e.message}`);
            attempts++;
            if (attempts < maxAttempts) {
              await new Promise(resolve => setTimeout(resolve, delayMs));
            } else {
              this.log.warn(`[CDP] Failed to get CDP viewport after ${maxAttempts} attempts: ${e.message}`);
            }
          }
        }
      } else {
        this.log.warn('[CDP] CDP client not available, falling back to device dimensions');
      }
    }
  }
  const windowSize = deviceScreenSize;
  const statusBarHeight = await this.getStatusBarHeight();
  // android returns the upscaled window size, so to get the true size of the
  // rect we have to downscale
  return {
    left: 0,
    top: statusBarHeight,
    width: windowSize.width,
    height: windowSize.height - statusBarHeight,
  };
}

/**
 * Returns the viewport coordinates.
 * @returns The viewport rectangle (left, top, width, height).
 */
export async function mobileViewPortRect(this: AndroidUiautomator2Driver): Promise<RelativeRect> {
  return await this.getViewPortRect();
}

/**
 * Gets the window rectangle (W3C endpoint).
 * @returns The window rectangle (x, y, width, height).
 */
export async function getWindowRect(this: AndroidUiautomator2Driver): Promise<Rect> {
  const { width, height } = await this.getWindowSize();
  return {
    width,
    height,
    x: 0,
    y: 0,
  };
}

/**
 * Gets the display density.
 * @returns The display density value.
 */
export async function getDisplayDensity(this: AndroidUiautomator2Driver): Promise<number> {
  return (await this.uiautomator2.jwproxy.command('/appium/device/display_density', 'GET', {})) as number;
}

/**
 * Gets the window size.
 * @returns The window size (width, height).
 */
export async function getWindowSize(this: AndroidUiautomator2Driver): Promise<Size> {
  return (await this.uiautomator2.jwproxy.command('/window/current/size', 'GET', {})) as Size;
}

