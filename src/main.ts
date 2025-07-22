import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { Actor } from 'apify';
import { FingerprintGenerator } from 'fingerprint-generator';
import { FingerprintInjector } from 'fingerprint-injector';
import { updateCursorInUrl } from './helpers.js';

interface TikTokApiResponse {
    cursor: string;
    hasMore: boolean;
    itemList: Array<{ id: string }>;
}

interface ScrapingConfig {
    username: string;
    maxVideos: number;
    delayRange: { min: number; max: number };
    viewport: { width: number; height: number };
}

class TikTokScraper {
    private browser: Browser | null = null;
    private context: BrowserContext | null = null;
    private page: Page | null = null;
    private config: ScrapingConfig;

    constructor(config: ScrapingConfig) {
        this.config = config;
    }

    async initialize(): Promise<void> {
        await Actor.init();
        Actor.config.set('headless', false);

        const fingerprint = this.generateFingerprint();
        this.browser = await this.launchBrowser(fingerprint);
        this.context = await this.createContext(this.browser, fingerprint);
        
        await this.setupStealthMode();
        await this.injectFingerprint(fingerprint);
        await this.addTikTokCookies();
        await this.setupRouteBlocking();
        
        this.page = await this.createPage();
    }

    private generateFingerprint() {
        const fingerprintGenerator = new FingerprintGenerator({
            browsers: [{ name: 'chrome', minVersion: 100 }],
            devices: ['desktop'],
            operatingSystems: ['windows'],
        });

        return fingerprintGenerator.getFingerprint({
            locales: ['en-US'],
            screen: {
                minWidth: this.config.viewport.width,
                maxWidth: this.config.viewport.width,
                minHeight: this.config.viewport.height,
                maxHeight: this.config.viewport.height,
            },
        });
    }

    private async launchBrowser(fingerprint: any): Promise<Browser> {
        return await chromium.launch({
            headless: Actor.config.get('headless'),
            args: [
                '--disable-blink-features=AutomationControlled',
                '--disable-infobars',
                '--disable-web-security',
                '--disable-extensions',
                '--disable-default-apps',
                '--disable-popup-blocking',
                '--disable-notifications',
                '--disable-translate',
                '--no-sandbox',
                '--mute-audio',
                '--disable-gpu',
                `--window-size=${this.config.viewport.width},${this.config.viewport.height}`,
                `--lang=${fingerprint.fingerprint.navigator.language}`,
            ],
        });
    }

    private async createContext(browser: Browser, fingerprint: any): Promise<BrowserContext> {
        return await browser.newContext({
            userAgent: fingerprint.fingerprint.userAgent,
            locale: fingerprint.fingerprint.navigator.language,
            viewport: this.config.viewport,
            timezoneId: 'America/New_York',
        });
    }

    private async setupStealthMode(): Promise<void> {
        if (!this.context) throw new Error('Context not initialized');

        await this.context.addInitScript(() => {
            // Basic stealth patches
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            
            Object.defineProperty(navigator, 'plugins', {
                get: () => [
                    { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer' },
                    { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer' },
                    { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer' },
                ],
            });
            
            Object.defineProperty(navigator, 'languages', {
                get: () => ['en-US', 'en'],
            });

            // WebGL patches
            const getParameter = WebGLRenderingContext.prototype.getParameter;
            WebGLRenderingContext.prototype.getParameter = function (parameter: number) {
                if (parameter === 37445) return 'Google Inc. (NVIDIA)';
                if (parameter === 37446) return 'ANGLE (NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0)';
                return getParameter.call(this, parameter);
            };
            
            // Timezone patch
            Date.prototype.getTimezoneOffset = function () {
                return 300; // EST
            };
            
            // Permissions patches
            const originalPermissionsQuery = navigator.permissions.query;
            navigator.permissions.query = async (parameters: PermissionDescriptor) => {
                if (parameters.name === 'notifications') {
                    return Promise.resolve({
                        state: Notification.permission,
                        onchange: null,
                        addEventListener: () => {},
                        removeEventListener: () => {},
                        dispatchEvent: () => true,
                    } as unknown as PermissionStatus);
                }
                return originalPermissionsQuery(parameters);
            };
            
            // Chrome runtime patch
            (window as any).chrome = {
                runtime: {
                    sendMessage: () => Promise.resolve({}),
                    connect: () => ({ onMessage: { addListener: () => {} } }),
                },
            };
        });
    }

    private async injectFingerprint(fingerprint: any): Promise<void> {
        if (!this.context) throw new Error('Context not initialized');
        
        const injector = new FingerprintInjector();
        await injector.attachFingerprintToPlaywright(this.context, fingerprint);
    }

    private async addTikTokCookies(): Promise<void> {
        if (!this.context) throw new Error('Context not initialized');

        const expirationTime = Math.floor(Date.now() / 1000) + 86400; // 1 day from now

        await this.context.addCookies([
            {
                name: 'tt_webid',
                value: '7' + Math.random().toString(36).substring(2, 19),
                domain: '.tiktok.com',
                path: '/',
                expires: expirationTime,
                httpOnly: true,
                secure: true,
            },
            {
                name: 'tt_csrf_token',
                value: Math.random().toString(36).substring(2, 10),
                domain: '.tiktok.com',
                path: '/',
                expires: expirationTime,
                httpOnly: true,
                secure: true,
            },
        ]);
    }

    private async setupRouteBlocking(): Promise<void> {
        if (!this.context) throw new Error('Context not initialized');

        await this.context.route('**/*', (route) => {
            if (route.request().url().includes('tiktok.com/_captcha')) {
                return route.abort();
            }
            return route.continue();
        });
    }

    private async createPage(): Promise<Page> {
        if (!this.context) throw new Error('Context not initialized');

        const page = await this.context.newPage();
        await page.setViewportSize(this.config.viewport);
        return page;
    }

    private async fetchApiData(url: string): Promise<TikTokApiResponse> {
        if (!this.page) throw new Error('Page not initialized');

        return await this.page.evaluate(async (apiUrl) => {
            const res = await fetch(apiUrl, {
                credentials: 'include',
            });

            if (!res.ok) {
                throw new Error(`Failed to fetch: ${res.status}`);
            }

            return await res.json();
        }, url);
    }

    async scrapeUserVideos(): Promise<string[]> {
        if (!this.page) throw new Error('Page not initialized');

        try {
            console.log(`🚀 Starting scrape for @${this.config.username}`);

            // Wait for the initial API response
            const responsePromise = this.page.waitForResponse(
                (response) => 
                    response.url().includes('/api/post/item_list') && 
                    response.status() === 200,
            );

            await this.page.goto(`https://www.tiktok.com/@${this.config.username}`, {
                waitUntil: 'domcontentloaded',
                timeout: 60000,
            });

            const initialResponse = await responsePromise;
            const firstApiUrl = initialResponse.url();
            let apiData = await initialResponse.json() as TikTokApiResponse;

            const allVideoIds: string[] = [...apiData.itemList.map(item => item.id)];

            console.log('✅ TikTok loaded successfully');
            console.log(`📊 Initial batch: ${apiData.itemList.length} videos`);

            // Paginate through remaining videos
            while (apiData.hasMore && allVideoIds.length < this.config.maxVideos) {
                console.log(`📄 Cursor: ${apiData.cursor}, Total videos: ${allVideoIds.length}`);

                const nextUrl = updateCursorInUrl(firstApiUrl, apiData.cursor);
                apiData = await this.fetchApiData(nextUrl);

                allVideoIds.push(...apiData.itemList.map(item => item.id));

                // Random delay between requests
                await this.page.waitForTimeout(3000 + Math.random() * 2000);
            }

            const uniqueVideoIds = Array.from(new Set(allVideoIds));
            console.log(`✅ Scraping completed: ${uniqueVideoIds.length} unique videos found`);

            return uniqueVideoIds;

        } catch (error) {
            console.error('❌ Error during scraping:', error);
            await this.takeErrorScreenshot();
            throw error;
        }
    }

    private async takeErrorScreenshot(): Promise<void> {
        if (!this.page) return;
        
        try {
            await this.page.screenshot({ path: 'error.png', fullPage: true });
            console.log('📸 Screenshot saved to error.png');
        } catch (screenshotError) {
            console.error('❌ Failed to take screenshot:', screenshotError);
        }
    }

    generateVideoUrls(videoIds: string[]): string[] {
        return videoIds.map(id => 
            `https://www.tiktok.com/@${this.config.username}/video/${id}?lang=en`
        );
    }

    async cleanup(): Promise<void> {
        if (this.browser) {
            await this.browser.close();
        }
        await Actor.exit();
    }
}

async function main() {
    const scraper = new TikTokScraper({
        username: 'pubity',
        maxVideos: 300,
        delayRange: { min: 1000, max: 4000 },
        viewport: { width: 1920, height: 1080 },
    });

    try {
        await scraper.initialize();
        const videoIds = await scraper.scrapeUserVideos();
        const videoUrls = scraper.generateVideoUrls(videoIds);

        console.log('📋 Video IDs:', JSON.stringify(videoIds));
        console.log('🔗 Video URLs:');
        videoUrls.forEach(url => console.log(url));

    } finally {
        await scraper.cleanup();
    }
}

// Run the scraper
main().catch(console.error);