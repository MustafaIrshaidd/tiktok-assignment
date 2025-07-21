import { chromium } from 'playwright';
import { Actor } from 'apify';
import { FingerprintGenerator } from 'fingerprint-generator';
import { FingerprintInjector } from 'fingerprint-injector';
import 'dotenv/config';
import { updateCursorInUrl } from './helpers.js';

await Actor.init();
Actor.config.set('headless', false);

// Enhanced proxy configuration
const proxyConfiguration = await Actor.createProxyConfiguration({
    groups: ['RESIDENTIAL'],
    countryCode: 'US',
});
const proxyInfo = await proxyConfiguration.newProxyInfo();
const proxyUrl = new URL(proxyInfo.url);

// Enhanced fingerprint generation
const fingerprintGenerator = new FingerprintGenerator({
    browsers: [{ name: 'chrome', minVersion: 100 }],
    devices: ['desktop'],
    operatingSystems: ['windows'],
});
const fingerprint = fingerprintGenerator.getFingerprint({
    locales: ['en-US'],
    // Screen options must be passed in the correct format
    screen: {
        minWidth: 1920,
        maxWidth: 1920,
        minHeight: 1080,
        maxHeight: 1080,
    },
});

// Launch browser with enhanced stealth args
const browser = await chromium.launch({
    headless: Actor.config.get('headless'),
    //   proxy: {
    //     server: `${proxyUrl.hostname}:${proxyUrl.port}`,
    //     username: proxyUrl.username,
    //     password: proxyUrl.password,
    //   },
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
        `--window-size=${1920},${1080}`,
        `--lang=${fingerprint.fingerprint.navigator.language}`,
    ],
});

const context = await browser.newContext({
    userAgent: fingerprint.fingerprint.userAgent,
    locale: fingerprint.fingerprint.navigator.language,
    viewport: {
        width: 1920,
        height: 1080,
    },
    timezoneId: 'America/New_York',
});

// Enhanced stealth patching
await context.addInitScript(() => {
    // Basic patches
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
        // UNMASKED_VENDOR_WEBGL
        if (parameter === 37445) return 'Google Inc. (NVIDIA)';
        // UNMASKED_RENDERER_WEBGL
        if (parameter === 37446) return 'ANGLE (NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0)';
        return getParameter.call(this, parameter);
    };

    // Timezone patch
    const originalGetTimezoneOffset = Date.prototype.getTimezoneOffset;
    Date.prototype.getTimezoneOffset = function () {
        return 300; // For EST
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

// Inject fingerprint
const injector = new FingerprintInjector();
await injector.attachFingerprintToPlaywright(context, fingerprint);

// Add realistic cookies before navigation
await context.addCookies([
    {
        name: 'tt_webid',
        value: '7' + Math.random().toString(36).substring(2, 19),
        domain: '.tiktok.com',
        path: '/',
        expires: Math.floor(Date.now() / 1000) + 86400, // 1 day from now in seconds
        httpOnly: true,
        secure: true,
    },
    {
        name: 'tt_csrf_token',
        value: Math.random().toString(36).substring(2, 10),
        domain: '.tiktok.com',
        path: '/',
        expires: Math.floor(Date.now() / 1000) + 86400, // 1 day from now in seconds
        httpOnly: true,
        secure: true,
    },
]);

// Block detection scripts
await context.route('**/*', (route) => {
    if (route.request().url().includes('tiktok.com/_captcha')) {
        return route.abort();
    }
    return route.continue();
});

// Create page and add human-like behavior
const page = await context.newPage();
await page.setViewportSize({
    width: 1920,
    height: 1080,
});

// Human-like interaction functions
const humanDelay = () => page.waitForTimeout(1000 + Math.random() * 3000);
const moveMouseRandomly = async () => {
    const width = fingerprint.fingerprint.screen.width;
    const height = fingerprint.fingerprint.screen.height;
    await page.mouse.move(
        Math.floor(width * 0.3 + Math.random() * width * 0.4),
        Math.floor(height * 0.3 + Math.random() * height * 0.4),
    );
    await humanDelay();
};

// Navigate to TikTok with human-like behavior
try {
    // Wait for the first item_list response
    const responsePromise = page.waitForResponse(
        (response) => response.url().includes('/api/post/item_list') && response.status() === 200,
    );

    const username= 'pubity'

    await page.goto(`https://www.tiktok.com/@${username}`, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
    });

    await moveMouseRandomly();
    //   await page.mouse.wheel(0, 500); // Scroll a bit
    await humanDelay();

    const response = await responsePromise;

    const firstItemListUrl = response.url();
    let json = await response.json();

    let cursor = json.cursor;
    let hasMore = json.hasMore;
    let items = json.itemList;

    console.log('✅ TikTok loaded successfully');

    const results = [...items.map(c=>c.id)];

    // Loop to paginate via page.evaluate()
    while (hasMore) {
        console.log('cursor:', cursor, '\nURL:', firstItemListUrl, '\nItems:', items.length);
        const nextUrl = updateCursorInUrl(firstItemListUrl, cursor);

        const result = await page.evaluate(async (apiUrl) => {
            const res = await fetch(apiUrl, {
                credentials: 'include', // include cookies/session
            });

            if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);

            const data = await res.json();

            return {
                cursor: data.cursor,
                hasMore: data.hasMore,
                items: data.itemList,
            };
        }, nextUrl);

        results.push(...result.items.map(c=>c.id));

        // // Exit condition if something goes wrong
        // if (!result.cursor || !Array.isArray(result.items)) {
        //     console.log('❌ Invalid result, stopping');
        //     break;
        // }

        if (results.length > 300) break;

        console.log(results.length)

        // Update state
        cursor = result.cursor;
        hasMore = result.hasMore;

        await page.waitForTimeout(3000 + Math.random() * 2000);
    }

    const uniqueResults = Array.from(new Set(results))

    console.log(JSON.stringify(uniqueResults))

    console.log(uniqueResults.map(id=> `https://www.tiktok.com/@${username}/video/${id}?lang=en`))




    // You can add your interaction logic here
} catch (error) {
    console.error('❌ Error loading TikTok:', error);

    // Take screenshot for debugging
    await page.screenshot({ path: 'error.png', fullPage: true });
    console.log('Screenshot saved to error.png');
}

// Close browser
await browser.close();
await Actor.exit();
