import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { STEALTH_INIT_SCRIPT } from "./stealth";

export interface BrowserPoolOptions {
  size?: number;
  headed?: boolean;
  stealth?: boolean;
}

interface BrowserSlot {
  context: BrowserContext;
  busy: boolean;
}

const ACCEPT_LANGUAGE = "zh-CN,zh;q=0.9,en;q=0.8";

/** Lazily starts Chromium and reuses isolated stealth contexts. */
export class BrowserPool {
  private browser: Browser | null = null;
  private slots: BrowserSlot[] = [];
  private waiters: Array<() => void> = [];
  private starting: Promise<void> | null = null;

  readonly size: number;
  readonly headed: boolean;
  readonly stealth: boolean;

  constructor(options: BrowserPoolOptions = {}) {
    this.size = Math.max(1, Math.floor(options.size ?? 2));
    this.headed = options.headed ?? false;
    this.stealth = options.stealth ?? true;
  }

  async withPage<T>(operation: (page: Page) => Promise<T>): Promise<T> {
    const slot = await this.acquire();
    const page = await slot.context.newPage();
    try {
      return await operation(page);
    } finally {
      await page.close().catch(() => undefined);
      slot.busy = false;
      this.waiters.shift()?.();
    }
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    this.slots = [];
    this.starting = null;
    await browser?.close();
  }

  private async acquire(): Promise<BrowserSlot> {
    await this.ensureStarted();
    for (;;) {
      const slot = this.slots.find((candidate) => !candidate.busy);
      if (slot) {
        slot.busy = true;
        return slot;
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.browser?.isConnected() && this.slots.length === this.size) return;
    if (!this.starting) this.starting = this.start();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async start(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
    const browser = await chromium.launch({
      headless: !this.headed,
      channel: this.headed ? undefined : "chromium",
      args: [
        "--lang=zh-CN",
        "--window-size=1365,900",
        ...(this.stealth
          ? ["--disable-blink-features=AutomationControlled"]
          : []),
      ],
      ignoreDefaultArgs: this.stealth ? ["--enable-automation"] : undefined,
    });
    const version = browser.version();
    const major = version.split(".", 1)[0];
    const userAgent =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      `Chrome/${version} Safari/537.36`;
    const slots: BrowserSlot[] = [];
    for (let index = 0; index < this.size; index += 1) {
      const context = await browser.newContext({
        userAgent,
        locale: "zh-CN",
        timezoneId: "Asia/Shanghai",
        viewport: { width: 1365, height: 900 },
        screen: { width: 1920, height: 1080 },
        colorScheme: "light",
        extraHTTPHeaders: { "Accept-Language": ACCEPT_LANGUAGE },
      });
      if (this.stealth) await context.addInitScript(STEALTH_INIT_SCRIPT);
      const page = await context.newPage();
      if (this.stealth) {
        const cdp = await context.newCDPSession(page);
        await cdp.send("Network.setUserAgentOverride", {
          userAgent,
          acceptLanguage: ACCEPT_LANGUAGE,
          platform: "Win32",
          userAgentMetadata: {
            brands: [
              { brand: "Google Chrome", version: major },
              { brand: "Chromium", version: major },
              { brand: "Not_A Brand", version: "99" },
            ],
            fullVersionList: [
              { brand: "Google Chrome", version },
              { brand: "Chromium", version },
              { brand: "Not_A Brand", version: "99.0.0.0" },
            ],
            fullVersion: version,
            platform: "Windows",
            platformVersion: "10.0.0",
            architecture: "x86",
            bitness: "64",
            model: "",
            mobile: false,
            wow64: false,
          },
        });
      }
      await page.close();
      slots.push({ context, busy: false });
    }
    browser.once("disconnected", () => {
      if (this.browser === browser) {
        this.browser = null;
        this.slots = [];
      }
    });
    this.browser = browser;
    this.slots = slots;
  }
}

let defaultPool: BrowserPool | null = null;

export function getDefaultBrowserPool(): BrowserPool {
  defaultPool ??= new BrowserPool({ headed: false });
  return defaultPool;
}
