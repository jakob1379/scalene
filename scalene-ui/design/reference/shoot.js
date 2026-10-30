// Screenshots for concept A. Usage: node shoot.js [only-name-substring]
const { chromium } = require("playwright");
const path = require("path");
const DIR = __dirname;
const url = (f, q = "") => "file://" + path.join(DIR, f) + q;
const only = process.argv[2] || "";

async function settle(p, ms = 2200) { await p.waitForTimeout(ms); }
async function revealAll(p) {
  // scroll through the page so below-the-fold sections play their (one-time) reveal, then return to top
  const h = await p.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < h; y += 500) { await p.evaluate((yy) => window.scrollTo(0, yy), y); await p.waitForTimeout(90); }
  await p.waitForTimeout(1100);
  await p.evaluate(() => window.scrollTo(0, 0)); await p.waitForTimeout(250);
}
async function scrollTo(p, sel, offset = 0) {
  await p.evaluate(([s, o]) => { const el = document.querySelector(s); const top = el.getBoundingClientRect().top + scrollY - (parseInt(getComputedStyle(document.documentElement).getPropertyValue("--topbar-h")) || 52) - 12 + o; window.scrollTo(0, top); }, [sel, offset]);
  await p.waitForTimeout(350);
}

(async () => {
  const b = await chromium.launch();
  const errors = [];
  const page = async (vw, vh, scheme, file = "index.html", q = "", opts = {}) => {
    const ctx = await b.newContext({ viewport: { width: vw, height: vh }, colorScheme: scheme, deviceScaleFactor: opts.dpr || 1, isMobile: !!opts.mobile, hasTouch: !!opts.mobile });
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push(file + ": " + e.message));
    p.on("console", (m) => { if (m.type() === "error") errors.push(file + " console: " + m.text()); });
    await p.goto(url(file, q));
    return p;
  };
  const jobs = {
    async "shot-anim"() { // mid-animation frame of the hero (scope sweep + count-up in flight)
      const p = await page(1440, 900, "dark");
      await p.waitForTimeout(520);
      await p.screenshot({ path: path.join(DIR, "shot-anim.png") });
    },
    async "shot-desktop-dark"() {
      const p = await page(1440, 900, "dark"); await settle(p);
      await p.screenshot({ path: path.join(DIR, "shot-desktop-dark.png") });
    },
    async "shot-desktop-light"() {
      const p = await page(1440, 900, "light"); await settle(p);
      await p.screenshot({ path: path.join(DIR, "shot-desktop-light.png") });
    },
    async "shot-desktop-full-light"() {
      const p = await page(1440, 900, "light"); await settle(p, 1500); await revealAll(p);
      const h = await p.evaluate(() => document.documentElement.scrollHeight);
      await p.setViewportSize({ width: 1440, height: h }); await p.waitForTimeout(900);
      const h2 = await p.evaluate(() => document.documentElement.scrollHeight);
      if (h2 !== h) { await p.setViewportSize({ width: 1440, height: h2 }); await p.waitForTimeout(600); }
      await p.screenshot({ path: path.join(DIR, "shot-desktop-full-light.png") });
    },
    async "shot-desktop-full-dark"() {
      const p = await page(1440, 900, "dark"); await settle(p, 1500); await revealAll(p);
      const h = await p.evaluate(() => document.documentElement.scrollHeight);
      await p.setViewportSize({ width: 1440, height: h }); await p.waitForTimeout(900);
      const h2 = await p.evaluate(() => document.documentElement.scrollHeight);
      if (h2 !== h) { await p.setViewportSize({ width: 1440, height: h2 }); await p.waitForTimeout(600); }
      await p.screenshot({ path: path.join(DIR, "shot-desktop-full-dark.png") });
    },
    async "shot-wide"() {
      const p = await page(2560, 1440, "dark"); await settle(p);
      await p.screenshot({ path: path.join(DIR, "shot-wide.png") });
    },
    async "shot-mobile"() {
      const p = await page(390, 844, "dark", "index.html", "", { mobile: true, dpr: 2 }); await settle(p);
      await p.screenshot({ path: path.join(DIR, "shot-mobile.png") });
      await revealAll(p);
      await scrollTo(p, "#hotspots"); await p.screenshot({ path: path.join(DIR, "shot-mobile-2.png") });
      await scrollTo(p, "#code", 120); await p.screenshot({ path: path.join(DIR, "shot-mobile-3.png") });
    },
    async "shot-iframe"() {
      const p = await page(1000, 400, "light"); await settle(p);
      await p.screenshot({ path: path.join(DIR, "shot-iframe.png") });
    },
    async "shot-flame"() {
      const p = await page(1440, 900, "dark"); await settle(p, 1200); await revealAll(p);
      await scrollTo(p, "#stacks"); await p.waitForTimeout(700);
      const box = await p.locator("#fl-cv").boundingBox();
      await p.mouse.move(box.x + box.width * 0.42, box.y + 22 * 2 + 10); await p.waitForTimeout(300);
      await p.screenshot({ path: path.join(DIR, "shot-flame.png") });
      // zoomed: click a frame (train:165 subtree)
      await p.mouse.click(box.x + box.width * 0.30, box.y + 22 * 1 + 10); await p.waitForTimeout(600);
      await p.mouse.move(box.x + box.width * 0.5, box.y + 22 * 5 + 10); await p.waitForTimeout(250);
      await p.screenshot({ path: path.join(DIR, "shot-flame-zoom.png") });
    },
    async "shot-timeline"() {
      const p = await page(1440, 900, "dark"); await settle(p, 1200); await revealAll(p);
      await scrollTo(p, "#timeline"); await p.waitForTimeout(900);
      const box = await p.locator("#tl-cv").boundingBox();
      await p.mouse.move(box.x + box.width * 0.62, box.y + 120); await p.waitForTimeout(300);
      await p.screenshot({ path: path.join(DIR, "shot-timeline.png") });
    },
    async "shot-code"() {
      const p = await page(1440, 900, "dark"); await settle(p, 1200); await revealAll(p);
      await p.click('#hs-list .hs[data-i="0"]'); await p.waitForTimeout(900);
      const row = p.locator('#lines .lrow[data-no="173"]');
      await row.hover(); await p.waitForTimeout(200);
      await p.click('#lines .lrow[data-no="173"] [data-a="opt"]'); await p.waitForTimeout(400);
      await p.mouse.move(1430, 890); await p.waitForTimeout(150);
      await scrollTo(p, '#lines .lrow[data-no="152"]', -40);
      await p.screenshot({ path: path.join(DIR, "shot-code-ai.png") });
      await scrollTo(p, '#lines .lrow[data-no="106"]', -40);
      await p.hover('#lines .lrow[data-no="120"]'); await p.waitForTimeout(200);
      await p.screenshot({ path: path.join(DIR, "shot-code.png") });
    },
    async "shot-scope-hover"() {
      const p = await page(1440, 900, "dark"); await settle(p);
      await p.hover('#hs-list .hs[data-i="2"]'); await p.waitForTimeout(150);
      await p.screenshot({ path: path.join(DIR, "shot-link.png") });
      const box = await p.locator("#scope").boundingBox();
      await p.mouse.move(box.x + box.width * 0.55, box.y + 140); await p.waitForTimeout(200);
      await p.screenshot({ path: path.join(DIR, "shot-scope-hover.png") });
    },
    async "shot-ai"() {
      const p = await page(1440, 900, "light"); await settle(p, 1200);
      await p.click("#ai-btn"); await p.waitForTimeout(500);
      await p.screenshot({ path: path.join(DIR, "shot-ai.png") });
    },
    async "shot-async"() {
      const p = await page(1440, 900, "dark", "index-async.html"); await settle(p);
      await p.screenshot({ path: path.join(DIR, "shot-async.png") });
    },
    async "shot-cpu"() {
      const p = await page(1440, 900, "light", "index-cpu.html"); await settle(p);
      await p.screenshot({ path: path.join(DIR, "shot-cpu.png") });
    },
    async "shot-empty"() {
      const p = await page(1440, 900, "dark", "index-empty.html"); await settle(p, 600);
      await p.screenshot({ path: path.join(DIR, "shot-empty.png") });
    },
  };
  for (const [name, fn] of Object.entries(jobs)) {
    if (only && !name.includes(only)) continue;
    const t0 = Date.now(); await fn(); console.log(name, Date.now() - t0, "ms");
  }
  console.log(errors.length ? "ERRORS:\n" + errors.join("\n") : "no page errors");
  await b.close();
})();
