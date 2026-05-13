import type {AndroidUiautomator2Driver} from '../driver';

/**
 * Returns true if CDP should be used for the current webview context.
 * This is also used by the constructor's override layer; keeping the
 * predicate in one place avoids drift.
 */
function isCDPWebviewContext(driver: AndroidUiautomator2Driver): boolean {
  // @ts-expect-error - cdpContextManager is private
  const mgr = driver.cdpContextManager;
  if (!mgr) {
    return false;
  }
  const useCDP =
    driver.opts.useCDP === true || driver.opts.appPackage === 'com.oculus.browser';
  if (!useCDP) {
    return false;
  }
  return driver.curContext !== 'NATIVE_APP' && driver.curContext != null;
}

/**
 * Sets the URL for the current app. In a CDP-managed webview context this
 * navigates the page; otherwise it falls back to launching the URI as an
 * Android deep link.
 * @param url - The URL to navigate to.
 */
export async function setUrl(this: AndroidUiautomator2Driver, url: string): Promise<void> {
  if (isCDPWebviewContext(this)) {
    // @ts-expect-error - cdpContextManager is private
    const cdpClient = this.cdpContextManager.getCurrentCDPClient();
    if (cdpClient) {
      this.log.debug(`[CDP] setUrl via CDP: ${url}`);
      await cdpClient.navigate(url);
      return;
    }
  }
  await this.adb.startUri(url, this.opts.appPackage as string);
}

/**
 * Returns the current URL. Only meaningful in a CDP-managed webview context.
 */
export async function getUrl(this: AndroidUiautomator2Driver): Promise<string> {
  if (isCDPWebviewContext(this)) {
    // @ts-expect-error - cdpContextManager is private
    const cdpClient = this.cdpContextManager.getCurrentCDPClient();
    if (cdpClient) {
      this.log.debug('[CDP] getUrl via CDP');
      return await cdpClient.getUrl();
    }
  }
  throw new Error('getUrl is not supported in the current context');
}

/**
 * Returns the current page title. Only meaningful in a CDP-managed webview context.
 */
export async function title(this: AndroidUiautomator2Driver): Promise<string> {
  if (isCDPWebviewContext(this)) {
    // @ts-expect-error - cdpContextManager is private
    const cdpClient = this.cdpContextManager.getCurrentCDPClient();
    if (cdpClient) {
      this.log.debug('[CDP] title via CDP');
      return await cdpClient.getTitle();
    }
  }
  throw new Error('title is not supported in the current context');
}

/**
 * Navigates forward in browser history (CDP webview only).
 */
export async function forward(this: AndroidUiautomator2Driver): Promise<void> {
  if (isCDPWebviewContext(this)) {
    // @ts-expect-error - cdpContextManager is private
    const cdpClient = this.cdpContextManager.getCurrentCDPClient();
    if (cdpClient) {
      this.log.debug('[CDP] forward via CDP');
      await cdpClient.forward();
      return;
    }
  }
  throw new Error('forward is not supported in the current context');
}

/**
 * Reloads the current page (CDP webview only).
 */
export async function refresh(this: AndroidUiautomator2Driver): Promise<void> {
  if (isCDPWebviewContext(this)) {
    // @ts-expect-error - cdpContextManager is private
    const cdpClient = this.cdpContextManager.getCurrentCDPClient();
    if (cdpClient) {
      this.log.debug('[CDP] refresh via CDP');
      await cdpClient.reload();
      return;
    }
  }
  throw new Error('refresh is not supported in the current context');
}

/**
 * Starts a URL that takes users directly to specific content in the app.
 * @param url - The deep link URL to start.
 * @param pkg - Optional package name to start the URI with. If not provided, uses the current app package.
 * @param waitForLaunch - If false, adb won't wait for the started activity to return control. Defaults to true.
 */
export async function mobileDeepLink(
  this: AndroidUiautomator2Driver,
  url: string,
  pkg?: string,
  waitForLaunch: boolean = true,
): Promise<void> {
  return await this.adb.startUri(url, pkg, {waitForLaunch});
}

/**
 * Navigates back. In a CDP-managed webview context this calls
 * window.history.back(); otherwise it sends KEYCODE_BACK.
 */
export async function back(this: AndroidUiautomator2Driver): Promise<void> {
  if (isCDPWebviewContext(this)) {
    // @ts-expect-error - cdpContextManager is private
    const cdpClient = this.cdpContextManager.getCurrentCDPClient();
    if (cdpClient) {
      this.log.debug('[CDP] back via CDP');
      await cdpClient.back();
      return;
    }
  }
  await this.adb.keyevent(4);
}

