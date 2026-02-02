import { CssConverter } from '../css-converter';
import type { Element as AppiumElement } from '@appium/types';
import type { FindElementOpts } from 'appium-android-driver';
import type { AndroidUiautomator2Driver } from '../driver';

// we override the xpath search for this first-visible-child selector, which
// looks like /*[@firstVisible="true"]
const MAGIC_FIRST_VIS_CHILD_SEL = /\/\*\[@firstVisible ?= ?('|")true\1\]/;

const MAGIC_SCROLLABLE_SEL = /\/\/\*\[@scrollable ?= ?('|")true\1\]/;
const MAGIC_SCROLLABLE_BY = 'new UiSelector().scrollable(true)';

/**
 * Overrides helpers.doFindElementOrEls functionality of appium-android-driver.
 * Handles special xpath selectors and CSS selector conversion.
 * @param params - Element finding options including strategy, selector, context, and multiple flag.
 * @returns A single element if `params.multiple` is false, or an array of elements if true.
 */
export async function doFindElementOrEls(
  this: AndroidUiautomator2Driver,
  params: FindElementOpts & { multiple: true },
): Promise<AppiumElement[]>;
export async function doFindElementOrEls(
  this: AndroidUiautomator2Driver,
  params: FindElementOpts & { multiple: false },
): Promise<AppiumElement>;
export async function doFindElementOrEls(
  this: AndroidUiautomator2Driver,
  params: FindElementOpts,
): Promise<AppiumElement | AppiumElement[]> {
  // Check if we're using CDP context manager for web context
  const cdpManager = (this as any).cdpContextManager;
  const isWebContext = cdpManager && cdpManager.getCurrentContext() !== 'NATIVE_APP';

  // Check for native-only locator strategies
  const isNativeOnlyStrategy = params.strategy === '-android uiautomator';

  if (isWebContext && isNativeOnlyStrategy) {
    // UiAutomator locators don't work in webview contexts
    throw new Error(
      `The locator strategy '${params.strategy}' is only supported in NATIVE_APP context. ` +
      `Current context is '${cdpManager.getCurrentContext()}'. ` +
      `Please switch to NATIVE_APP context or use a web-compatible locator strategy (xpath, css selector, id, etc.).`
    );
  }

  if (isWebContext) {
    const cdpClient = cdpManager.getCurrentCDPClient();
    if (cdpClient) {
      this.log.info(`[CDP] Finding element(s) via CDP with strategy '${params.strategy}' and selector '${params.selector}'`);
      try {
        if (params.multiple) {
          return await cdpClient.findElementsByStrategy(params.strategy, params.selector);
        } else {
          return await cdpClient.findElementByStrategy(params.strategy, params.selector);
        }
      } catch (e) {
        this.log.error(`[CDP] Failed to find element: ${e.message}`);
        throw e;
      }
    }
  }

  const uiautomator2 = this.uiautomator2;
  if (params.strategy === 'xpath' && MAGIC_FIRST_VIS_CHILD_SEL.test(params.selector)) {
    const elementId = params.context;
    return (await uiautomator2.jwproxy.command(`/appium/element/${elementId}/first_visible`, 'GET', {})) as AppiumElement;
  }
  if (params.strategy === 'xpath' && MAGIC_SCROLLABLE_SEL.test(params.selector)) {
    params.strategy = '-android uiautomator';
    params.selector = MAGIC_SCROLLABLE_BY;
  }
  if (params.strategy === 'css selector') {
    params.strategy = '-android uiautomator';
    params.selector = new CssConverter(params.selector, this.opts.appPackage).toUiAutomatorSelector();
  }
  return (await uiautomator2.jwproxy.command(`/element${params.multiple ? 's' : ''}`, 'POST', params)) as
    | AppiumElement
    | AppiumElement[];
}

