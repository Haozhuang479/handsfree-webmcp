/*! handsfree.js v0.6.3 — voice + gesture input layer for WebMCP-instrumented pages.
 *
 *  <script src="/handsfree.js" defer></script>            ← the one line
 *
 *  What it does
 *   1. Discovers the page's WebMCP tools (document.modelContext.registerTool)
 *      — via the page's own registry (window.WebMCP) if it has one, otherwise
 *      by wrapping registerTool itself (so load this before app scripts).
 *   2. Voice: Web Speech API transcript → rule-based router → tool call.
 *   3. Gesture: MediaPipe HandLandmarker (CDN, on-device). The index finger is
 *      a cursor projected on the page; the outer left/right bands are scroll
 *      zones (upper half up, lower half down, faster towards the edges); a
 *      fist clicks what the cursor is over. Hands, zones and actions are drawn
 *      on a translucent grey particle overlay.
 *   4. A dock (hand / mic toggles, live transcript, feedback) styled after
 *      NILE's UI: ink pill, mint on-state, line icons, no shadows.
 *
 *  Routing needs no LLM: tool annotations.handsfree.role ('text-sink' |
 *  'scroll'), annotations.handsfree.phrases, built-in intents, tool names as
 *  words, then the text-sink as fallback.
 *
 *  Config: window.HANDSFREE_CONFIG = {...} before this script, or data-*
 *  attributes on the script tag (data-voice="false", data-lang="zh-CN",
 *  data-wake="hey shop", data-speak="false", data-gesture="false").
 */
(function () {
  if (window.Handsfree) return;

  // ---------------- config ----------------
  const script = document.currentScript;
  const ds = script?.dataset || {};
  const bool = (v, d) => (v == null ? d : !(v === 'false' || v === '0' || v === 'off'));
  const CFG = Object.assign({
    voice: true, gesture: true, speak: false, lang: null, wake: null, // lang: null = follow the browser (zh → zh-CN, else en-US); speak: no spoken feedback by default
    textTool: null, scrollTool: null, autostart: false, position: 'bottom-right',
    mediapipe: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14',
    model: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
    // gesture tuning
    cursorSmoothing: 0.5,
    // control region: a hand in the lower-left (left hand) or lower-right (right hand) part of the camera
    // frame drives the whole viewport, so the arm can rest low. Values are fractions of the mirrored frame.
    region: { left: { x0: 0.03, x1: 0.55 }, right: { x0: 0.45, x1: 0.97 }, y0: 0.4, y1: 0.97 }, sideHysteresis: 0.06,
    zoneWidth: 0.16,      // left/right scroll zones: outer 16 % of the viewport on each side
    dotSpacing: 14,       // dot-field spacing (px): a fine grid over the whole viewport
    zoneColor: null,      // scroll-zone tint; defaults to the page's --mint (teal-green) or #00e0ac
    zoneDeadband: 0.08,   // no scrolling within ±8 % of the vertical centre of a zone
    maxScrollSpeed: 1500, // px/s at the very top/bottom of a zone
    fistFrames: 3, fistOpenFrames: 2, clickCooldownMs: 600, // fist = click: closed hand for fistFrames detections, then open again before the next click
    detectEvery: 2, maxDpr: 1.5, // performance: run the hand model every other frame, cap overlay resolution
    waveDistance: 0.2, waveSpeed: 1.2, waveWindowMs: 300, waveCooldownMs: 900, // open-hand wave: right = back, left = forward
    accent: null,         // overlay colour; default is a translucent grey (see fx)
  }, window.HANDSFREE_CONFIG || {}, {
    ...(ds.voice != null && { voice: bool(ds.voice, true) }), ...(ds.gesture != null && { gesture: bool(ds.gesture, true) }),
    ...(ds.speak != null && { speak: bool(ds.speak, true) }), ...(ds.lang && { lang: ds.lang }), ...(ds.wake && { wake: ds.wake }),
    ...(ds.textTool && { textTool: ds.textTool }), ...(ds.scrollTool && { scrollTool: ds.scrollTool }), ...(ds.autostart != null && { autostart: bool(ds.autostart, false) }),
  });
  if (!CFG.lang) { const nl = (navigator.language || 'en-US'); CFG.lang = /^zh/i.test(nl) ? (/(tw|hk|hant)/i.test(nl) ? 'zh-TW' : 'zh-CN') : /^(ja|ko|fr|de|es|it|pt)/i.test(nl) ? nl : 'en-US'; }
  const cssVar = (name, fallback) => { try { const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); return v || fallback; } catch { return fallback; } };
  const ACCENT = () => CFG.accent || '#8b8b8a'; // translucent grey by default; a page may pass accent to recolour
  const ZONE = () => CFG.zoneColor || cssVar('--mint-deep', '') || cssVar('--mint', '#00e0ac');

  // ---------------- tool discovery ----------------
  const own = new Map();
  function installWrapper() {
    const mc = document.modelContext || navigator.modelContext;
    if (mc && !mc.__handsfreeWrapped) {
      const orig = mc.registerTool.bind(mc);
      // keep the draft signature: registerTool(tool, {signal, exposedTo}); an aborted signal unregisters
      mc.registerTool = (def, options) => { own.set(def.name, def); options?.signal?.addEventListener('abort', () => own.delete(def.name), { once: true }); return orig(def, options); };
      const origUn = mc.unregisterTool?.bind(mc);
      mc.unregisterTool = (n) => { own.delete(n); return origUn?.(n); };
      const origPc = mc.provideContext?.bind(mc);
      mc.provideContext = (ctx) => { for (const t of ctx?.tools || []) own.set(t.name, t); return origPc ? origPc(ctx) : undefined; };
      mc.__handsfreeWrapped = true;
    } else if (!mc) {
      const poly = {
        polyfill: true, __handsfreeWrapped: true,
        registerTool: (def, options) => { own.set(def.name, def); options?.signal?.addEventListener('abort', () => own.delete(def.name), { once: true }); return Promise.resolve(); },
        getTools: () => Promise.resolve([...own.values()].map((d) => ({ name: d.name, title: d.title, description: d.description, inputSchema: d.inputSchema, annotations: d.annotations || {}, window, origin: location.origin }))),
        executeTool: async (tool, input = {}, options = {}) => { const d = own.get(typeof tool === 'string' ? tool : tool?.name); if (!d) throw new Error('unknown tool'); return JSON.stringify((await d.execute(input, { signal: options.signal || new AbortController().signal })) ?? null); },
        unregisterTool: (n) => own.delete(n),
        provideContext: (ctx) => { for (const t of ctx?.tools || []) own.set(t.name, t); },
        clearContext: () => own.clear(),
      };
      Object.defineProperty(document, 'modelContext', { value: poly, configurable: true, writable: true });
    }
  }
  installWrapper();
  const registry = () => window.WebMCP?.listTools ? window.WebMCP : null;
  const listTools = () => registry() ? registry().listTools() : [...own.values()].map((d) => ({ name: d.name, description: d.description, inputSchema: d.inputSchema, annotations: d.annotations || {} }));
  async function callTool(name, input) {
    if (registry()) return registry().callTool(name, input, { via: 'handsfree' });
    const def = own.get(name); if (!def) throw new Error('unknown tool ' + name);
    return def.execute(input, { signal: new AbortController().signal });
  }
  const hf = (t) => t.annotations?.handsfree || {};
  const hasProp = (t, k) => k in (t.inputSchema?.properties || {});
  const firstStringProp = (t) => { const props = t.inputSchema?.properties || {}; const req = t.inputSchema?.required || []; return req.find((k) => props[k]?.type === 'string') || Object.keys(props).find((k) => props[k]?.type === 'string') || 'text'; };
  const findByRole = (role) => listTools().find((t) => hf(t).role === role);
  const textSink = () => (CFG.textTool && listTools().find((t) => t.name === CFG.textTool)) || findByRole('text-sink') || listTools().find((t) => /^(ask|search|query|prompt|chat|command)/.test(t.name));
  const scrollTool = () => (CFG.scrollTool && listTools().find((t) => t.name === CFG.scrollTool)) || findByRole('scroll') || listTools().find((t) => /scroll/.test(t.name));
  const focusTool = () => listTools().find((t) => t.name === 'focus_product' || t.name === 'focus_item') || listTools().find((t) => /focus|select|highlight/.test(t.name) && hasProp(t, 'target'));
  const openTool = () => listTools().find((t) => t.name === 'open_product' || t.name === 'open_item') || listTools().find((t) => /^open|details|learn_more/.test(t.name));
  const buyTool = () => listTools().find((t) => t.name === 'buy_now') || listTools().find((t) => /buy|checkout|purchase|add_to_cart/.test(t.name));
  const homeTool = () => listTools().find((t) => /^(show_home|go_home|home)$/.test(t.name));

  // ---------------- router ----------------
  const NUM = { one: 1, first: 1, two: 2, second: 2, three: 3, third: 3, four: 4, fourth: 4, five: 5, fifth: 5, six: 6, sixth: 6, seven: 7, seventh: 7, eight: 8, eighth: 8, nine: 9, ninth: 9, ten: 10, tenth: 10 };
  const WORDNUM = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000 };
  /** "fifty", "twenty five", "two hundred", "a hundred" → digits (used for prices; ordinals are left alone) */
  const wordsToNumber = (t) => t.replace(/\b(?:a |one )?hundred\b/g, '100').replace(/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[ -](one|two|three|four|five|six|seven|eight|nine)\b/g, (m, a, b) => String(WORDNUM[a] + WORDNUM[b])).replace(/\b(ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b(?= ?(?:dollars?|bucks?|usd|\$)|\b(?=\s*(?:dollars?|bucks?)))/g, (m) => String(WORDNUM[m]));
  /** Speech engines write "for" as "4", "to" as "2", "landing page" as "landing-page", drop the "$": undo the common ones. */
  const asrFix = (s) => s
    .replace(/\b(page|search|look|looking|page|gifts?|ideas?|something|things?|stuff)\s+4\s+/g, '$1 for ')
    .replace(/\b(go|back|scroll|jump)\s+2\s+/g, '$1 to ')
    .replace(/\blanding[- ]page\b/g, 'landing page')
    .replace(/\b(\d+)\s*(?:dollars?|bucks?|usd)\b/g, '$$$1')
    .replace(/\bdlp\b/g, 'landing page for');
  const ZH = [
    [/^(?:请)?(?:向下|往下|下)(?:滚|滑|翻)(?:动|一点|一些)?$/, 'scroll down'], [/^(?:请)?(?:向上|往上|上)(?:滚|滑|翻)(?:动|一点|一些)?$/, 'scroll up'], [/^(?:回到)?(?:顶部|最上面)$/, 'top'], [/^(?:到)?(?:底部|最下面)$/, 'bottom'],
    [/^(?:返回|后退|退出|回去|关闭|关掉)$/, 'back'], [/^(?:前进)$/, 'forward'], [/^(?:下一个|下一件|下一张)$/, 'next'], [/^(?:上一个|上一件|上一张)$/, 'previous'], [/^(?:第一个|第一件)$/, 'first'],
    [/^(?:打开|看看|查看)(?:它|这个|这件|详情)?$/, 'open it'], [/^(?:购买|买|买它|买这个|结账|下单)$/, 'buy it'], [/^(?:是|是的|好|好的|确认|确定|可以)$/, 'yes'], [/^(?:不|不要|取消|算了|不用)$/, 'no'],
    [/^(?:帮助|怎么用|能说什么)$/, 'help'], [/^(?:停|停止|暂停|别听了)$/, 'stop'], [/^(?:更多|加载更多|再来一些|下一页)$/, 'more'], [/^(?:首页|回首页|主页|回到首页)$/, 'go home'],
    [/^(?:便宜(?:点|一点|的)?|再便宜点|太贵了)$/, 'cheaper'], [/^(?:贵(?:点|一点)|更好的|高端(?:点|一点)?)$/, 'pricier'], [/^(?:品牌|所有品牌|看品牌|品牌页)$/, 'brands'], [/^(?:全部|浏览全部|看全部|所有商品)$/, 'browse everything'], [/^(?:这是什么|介绍一下|描述一下)$/, 'what is this'],
    [/^(?:试试运气|刮卡|抽奖|刮一刮)(?:[:：,，]?\s*(.+))?$/, (m) => 'try my luck' + (m[1] ? ' with ' + m[1] : '')],
    [/^(?:落地页|着陆页|做个页面|生成页面|做一个页面)[:：,，]?\s*(.+)$/, (m) => 'landing page for ' + m[1]], [/^(?:最便宜的|便宜的)\s*(.+)$/, (m) => 'cheapest ' + m[1]], [/^(?:最贵的)\s*(.+)$/, (m) => 'most expensive ' + m[1]],
    [/^(?:搜索|搜|找|查找|找一下|我想要|我想买|我要买|我需要|给我找|有没有|看看有没有)[:：,，]?\s*(.+)$/, (m) => 'find ' + m[1]],
  ];
  const ZHW = [['跑步鞋', 'running shoes'], ['跑鞋', 'running shoes'], ['运动鞋', 'sneakers'], ['鞋子', 'shoes'], ['鞋', 'shoes'], ['台灯', 'desk lamp'], ['灯具', 'lamp'], ['灯', 'lamp'], ['耳机', 'headphones'], ['耳塞', 'earbuds'], ['音箱', 'speaker'], ['充电器', 'charger'], ['手机壳', 'phone case'],
    ['蜡烛', 'candle'], ['香薰', 'candle'], ['毯子', 'blanket'], ['抱枕', 'pillow'], ['枕头', 'pillow'], ['床单', 'sheets'], ['地毯', 'rug'], ['沙发', 'sofa'], ['椅子', 'chair'], ['桌子', 'desk'], ['家居', 'home'], ['装饰', 'decor'], ['收纳', 'storage'],
    ['狗零食', 'dog treats'], ['狗粮', 'dog food'], ['狗玩具', 'dog toys'], ['牵引绳', 'dog leash'], ['狗', 'dog'], ['猫', 'cat'], ['宠物', 'pet'], ['礼物', 'gifts'], ['礼品', 'gifts'], ['护肤', 'skincare'], ['精华', 'serum'], ['面霜', 'moisturizer'], ['洗面奶', 'cleanser'], ['化妆', 'makeup'], ['口红', 'lipstick'], ['防晒', 'sunscreen'],
    ['外套', 'jacket'], ['夹克', 'jacket'], ['大衣', 'coat'], ['卫衣', 'hoodie'], ['T恤', 't-shirt'], ['连衣裙', 'dress'], ['裙子', 'dress'], ['裤子', 'pants'], ['帽子', 'hat'], ['包包', 'bag'], ['背包', 'backpack'], ['钱包', 'wallet'], ['手表', 'watch'], ['太阳镜', 'sunglasses'], ['首饰', 'jewelry'], ['项链', 'necklace'], ['耳环', 'earrings'],
    ['杯子', 'mug'], ['水杯', 'water bottle'], ['保温杯', 'tumbler'], ['咖啡', 'coffee'], ['茶', 'tea'], ['厨房', 'kitchen'], ['锅', 'pan'], ['刀', 'knife'], ['玩具', 'toys'], ['游戏', 'games'], ['键盘', 'keyboard'], ['鼠标', 'mouse'], ['露营', 'camping'], ['徒步', 'hiking'], ['户外', 'outdoor'], ['瑜伽', 'yoga'], ['健身', 'fitness'], ['维生素', 'vitamins'], ['保健品', 'supplements'], ['蛋白粉', 'protein powder'],
    ['秋季', 'fall'], ['秋天', 'fall'], ['冬季', 'winter'], ['冬天', 'winter'], ['夏天', 'summer'], ['舒适', 'cozy'], ['温暖', 'warm'], ['简约', 'minimalist'], ['复古', 'vintage'], ['有机', 'organic'], ['天然', 'natural'], ['便宜', 'cheap'], ['高端', 'premium'],
    ['妈妈', 'mom'], ['母亲', 'mom'], ['爸爸', 'dad'], ['父亲', 'dad'], ['男士', 'men'], ['男生', 'men'], ['女士', 'women'], ['女生', 'women'], ['儿童', 'kids'], ['小孩', 'kids'], ['宝宝', 'baby'], ['婴儿', 'baby'], ['朋友', 'friend'], ['新手', 'starter'], ['套装', 'kit'], ['的', ' '], ['和', ' and '], ['或', ' or '], ['给', ' for '], ['送', ' for '], ['以下', ' under '], ['以内', ' under '], ['美元', ' dollars'], ['块', ' dollars'], ['元', ' dollars']];
  const zhWords = (t) => {
    let x = t.replace(/(\d+)\s*(?:美元|美金|块钱|块|元|刀)?\s*(?:以内|以下|之内|内)/g, ' under $$$1 ').replace(/(\d+)\s*(?:美元|美金|块钱|块|元|刀)?\s*(?:以上|起)/g, ' over $$$1 ').replace(/(\d+)\s*(?:到|至|-)\s*(\d+)\s*(?:美元|美金|块|元)?/g, ' between $$$1 and $$$2 ');
    for (const [zh, en] of ZHW) x = x.split(zh).join(' ' + en + ' ');
    return x.replace(/[\u3400-\u9fff]+/g, ' ').replace(/\s+/g, ' ').trim();
  };
  const zhToIntent = (t) => { const x = t.replace(/[。！？、，,.!?]/g, '').trim(); for (const [re, to] of ZH) { const m = x.match(re); if (m) { const out = typeof to === 'function' ? to(m) : to; return hasCJK(out) ? zhWords(out) : out; } } return zhWords(x); };
  const hasCJK = (t) => /[\u3400-\u9fff]/.test(t);
  const norm = (s) => { let t = s.trim(); if (hasCJK(t)) t = zhToIntent(t); return wordsToNumber(asrFix(t.toLowerCase().replace(/[.,!?;:]/g, ' ').replace(/\s+/g, ' ').trim())); };
  const ordinal = (s) => { const m = s.match(/\b(?:number|no|the)?\s*(\d+|one|two|three|four|five|six|seven|eight|nine|ten|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/); return m ? (NUM[m[1]] || +m[1]) : undefined; };
  let pending = null;
  const viaTool = async (t, input, label) => { if (!t) return { error: `no tool for "${label}"` }; if (hf(t).confirm) return askConfirm(t.name, input, label); return exec(t.name, input); };
  const targetFrom = (s) => (/next/.test(s) ? 'next' : /prev|previous|back/.test(s) ? 'prev' : /first/.test(s) ? 'first' : /last/.test(s) ? 'last' : ordinal(s) ?? 'focused');
  const ITEM = '(?: one| item| product| card| result)?';
  const NUMW = '\\d+|one|two|three|four|five|six|seven|eight|nine|ten|first|second|third|fourth|fifth|next|previous|prev|last';
  const BUILTIN = [
    { re: /^(?:please )?(?:scroll|go|move|page) ?(down|up)(?: a (?:bit|little))?$|^(down|up)$/, run: (m) => scroll(m[1] || m[2]) },
    { re: /^(?:scroll |go )?(?:to (?:the )?)?(top|bottom)(?: of (?:the )?page)?$/, run: (m) => scroll(m[1]) },
    { re: /^(?:go )?back$|^close(?: it| this| that| the panel)?$|^dismiss$|^never ?mind$/, run: () => goBack() },
    { re: /^(?:go )?forward$/, run: () => (history.forward(), ui.flash('forward'), { did: 'history.forward' }) },
    { re: /^(?:browse|show|see)(?: me)?(?: everything| all| the whole catalog| all products)$|^everything$/, run: () => viaTool(listTools().find((t) => /browse/.test(t.name)), {}, 'browse') },
    { re: /^(?:cheaper|less expensive|lower price|something cheaper|too expensive)(?: ones?| options?)?$/, run: () => viaTool(listTools().find((t) => t.name === 'refine_results'), { direction: 'cheaper' }, 'cheaper') },
    { re: /^(?:more expensive|pricier|premium|higher end|nicer|better quality)(?: ones?| options?)?$/, run: () => viaTool(listTools().find((t) => t.name === 'refine_results'), { direction: 'pricier' }, 'pricier') },
    { re: /^(?:more|more results|next page|keep going|show more)$/, run: () => viaTool(listTools().find((t) => t.name === 'load_more'), {}, 'more') },
    { re: /^(?:what is this|what's this|describe (?:it|this)|tell me about (?:it|this|that))$/, run: () => viaTool(listTools().find((t) => t.name === 'describe_focused'), {}, 'describe') },
    { re: new RegExp(`^(?:go to |select |focus |highlight )?(next|previous|prev|first|last)${ITEM}$`), run: (m) => viaTool(focusTool(), { target: targetFrom(m[1]) }, m[1]) },
    { re: /^(?:go to |select |focus |highlight )?(?:number |no |the )?(\d+|one|two|three|four|five|six|seven|eight|nine|ten|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)(?:th| one| item| product)?$/, run: (m) => viaTool(focusTool(), { target: ordinal(m[0]) }, 'number ' + ordinal(m[0])) },
    { re: new RegExp(`^(?:open|show|view|details|learn more)(?: it| this| that| details| page)?(?: (?:for |of )?(?:the )?(?:number |no )?(${NUMW})${ITEM})?$`), run: (m) => viaTool(openTool(), { target: m[1] ? targetFrom(m[1]) : 'focused' }, 'open') },
    { re: new RegExp(`^(?:buy|purchase|checkout|check out)(?: it| this| that| now| this one)?(?: (?:the )?(?:number |no )?(${NUMW})${ITEM})?$`), run: (m) => viaTool(buyTool(), { target: m[1] ? targetFrom(m[1]) : 'focused' }, 'buy') },
    { re: /^(?:yes|yeah|yep|confirm|do it|ok|okay|sure)$/, run: () => confirmPending(true) },
    { re: /^(?:no|nope|cancel|never mind|stop that)$/, run: () => confirmPending(false) },
    { re: /^(?:stop|pause|quiet|mute)(?: listening)?$/, run: () => (voice.stop(), { did: 'voice.stop' }) },
    { re: /^(?:help|what can i say|commands)$/, run: () => helpToast() },
    { re: /^(?:switch to|speak|use) (chinese|mandarin|english|japanese|korean|french|german|spanish)$/, run: (m) => ({ did: 'setLang', lang: voice.setLang({ chinese: 'zh-CN', mandarin: 'zh-CN', english: 'en-US', japanese: 'ja-JP', korean: 'ko-KR', french: 'fr-FR', german: 'de-DE', spanish: 'es-ES' }[m[1]]) }) },
  ];
  async function route(rawText, source = 'text') {
    let text = norm(rawText); if (!text) return null;
    if (CFG.wake) { const w = norm(CFG.wake); if (!text.startsWith(w)) return null; text = text.slice(w.length).trim(); }
    const LEAD = /^(?:hey|hi|ok|okay|please|can you|could you|would you|will you|i want to|i'd like to|i would like to|let's|let us|now|um|uh|so|just|i want you to|can i|could i|may i)\s+/;
    while (LEAD.test(text)) text = text.replace(LEAD, '');
    text = text.replace(/\s+(?:please|thanks|thank you|for me|now)$/, '').trim();
    // "go to the brands page", "open the brands", "take me to browse", "see the brands" → the tool words themselves
    const NAV = /^(?:go to|go back to|take me to|bring me to|navigate to|open|open up|show|see|view|switch to|jump to)\s+(?:the\s+|my\s+)?(.+?)(?:\s+(?:page|section|tab|screen|view))?$/;
    const navm = text.match(NAV);
    if (navm && listTools().some((t) => [t.name.replace(/[_-]+/g, ' '), ...(hf(t).phrases || [])].some((ph) => norm(ph) === navm[1] || navm[1].startsWith(norm(ph) + ' ')))) text = navm[1];
    ui.transcript(text);
    for (const b of BUILTIN) { const m = text.match(b.re); if (m) return finish(await b.run(m), text); }
    const tools = listTools(); const cands = [];
    for (const t of tools) {
      const phrases = [...(hf(t).phrases || []), t.name.replace(/[_-]+/g, ' ')];
      for (const p of phrases) { const np = norm(p); if (text === np || text.startsWith(np + ' ')) cands.push({ t, p: np, rest: text.slice(np.length).trim() }); }
    }
    cands.sort((a, b) => b.p.length - a.p.length);
    if (cands.length) {
      const { t, rest } = cands[0]; const input = buildInput(t, rest, text);
      // a matched phrase with a required string still missing ("open landing page" with no theme) must not call the tool
      const missing = (t.inputSchema?.required || []).find((k) => input[k] == null || input[k] === '');
      if (missing) { const hint = `Say "${cands[0].p} …" followed by the ${missing}`; ui.flash(hint, 'ask', 4000); say(`What ${missing}?`); return finish({ needs: missing, tool: t.name }, text); }
      if (hf(t).confirm) return askConfirm(t.name, input, `${t.name.replace(/_/g, ' ')}${rest ? ' ' + rest : ''}`);
      return finish(await exec(t.name, input), text);
    }
    const sink = textSink();
    if (!sink) return finish({ error: 'no text-sink tool registered' }, text);
    return finish(await exec(sink.name, { [firstStringProp(sink)]: hasCJK(rawText) ? text : rawText.trim() }), text);
  }
  function buildInput(t, rest, full) {
    const props = t.inputSchema?.properties || {}; const input = {};
    if ('target' in props) input.target = rest.includes('next') ? 'next' : /prev|previous|last one|back one/.test(rest) ? 'prev' : rest === 'first' || /first one/.test(rest) ? 'first' : ordinal(rest) ?? (rest || 'focused');
    if ('direction' in props) input.direction = /up/.test(full) ? 'up' : /top/.test(full) ? 'top' : /bottom/.test(full) ? 'bottom' : 'down';
    const sp = firstStringProp(t);
    const tidy = rest.replace(/^(?:a|an|the|some|any)\s+/, '').replace(/\b(?:something|anything|some|stuff|things?)\b\s*/g, '').replace(/\s+/g, ' ').trim();
    if (props[sp] && !(sp in input) && tidy) input[sp] = tidy;
    for (const [k, v] of Object.entries(props)) if (v.enum && !(k in input)) { const hit = v.enum.find((e) => full.includes(String(e).toLowerCase())); if (hit) input[k] = hit; }
    if (props.sort && !input.sort) { if (/\b(?:cheapest|lowest price|low to high|least expensive)\b/.test(full)) input.sort = 'price_asc'; else if (/\b(?:most expensive|priciest|highest price|high to low)\b/.test(full)) input.sort = 'price_desc'; if (input.sort && typeof input[sp] === 'string') input[sp] = input[sp].replace(/\b(?:cheapest|lowest price|low to high|least expensive|most expensive|priciest|highest price|high to low)\b/g, '').replace(/\s+/g, ' ').trim(); }
    const priceRe = /\b(?:under|below|less than|max(?:imum)?|up to|no more than|cheaper than)\s*\$?\s*(\d+(?:\.\d+)?)\b(?:\s*(?:dollars?|bucks?))?/;
    const minRe = /\b(?:over|above|more than|min(?:imum)?|at least)\s*\$?\s*(\d+(?:\.\d+)?)\b(?:\s*(?:dollars?|bucks?))?/;
    const betweenRe = /\bbetween\s*\$?(\d+)\s*(?:and|to|-)\s*\$?(\d+)\b/;
    if (props.max_price || props.min_price) {
      let m;
      if ((m = full.match(betweenRe))) { if (props.min_price) input.min_price = +m[1]; if (props.max_price) input.max_price = +m[2]; }
      else { if (props.max_price && (m = full.match(priceRe))) input.max_price = +m[1]; if (props.min_price && (m = full.match(minRe))) input.min_price = +m[1]; }
      if (typeof input[sp] === 'string') input[sp] = input[sp].replace(betweenRe, '').replace(priceRe, '').replace(minRe, '').replace(/\s+/g, ' ').trim() || input[sp];
    }
    return input;
  }
  async function scroll(dir, amount) {
    const t = scrollTool();
    if (t) return exec(t.name, amount ? { direction: dir, amount } : { direction: dir });
    const h = innerHeight * (amount || 0.8), behavior = document.hidden ? 'instant' : 'smooth';
    if (dir === 'top') scrollTo({ top: 0, behavior }); else if (dir === 'bottom') scrollTo({ top: document.body.scrollHeight, behavior }); else scrollBy({ top: dir === 'down' ? h : -h, behavior });
    return { did: 'window.scroll', dir };
  }
  async function goBack() {
    // 1. an open panel/sheet closes first: a visible [data-hf-dismiss] control, or a tool annotated role 'dismiss'
    const dismiss = [...document.querySelectorAll('[data-hf-dismiss]')].find((el) => el.offsetParent !== null);
    if (dismiss) { dismiss.click(); ui.flash('closed'); return { did: 'dismiss' }; }
    const dt = findByRole('dismiss'); if (dt) { const r = await callTool(dt.name, {}); if (r?.closed) { ui.flash('closed'); return { tool: dt.name, result: r }; } }
    // 2. otherwise the page's own notion of "back" (history, then the home tool)
    if (history.length > 1 && location.hash && location.hash !== '#/') { history.back(); ui.flash('back'); return { did: 'history.back' }; }
    const h = homeTool(); if (h) return exec(h.name, {});
    history.back(); return { did: 'history.back' };
  }
  async function exec(name, input) {
    ui.flash(`${name.replace(/_/g, ' ')}${input && Object.keys(input).length ? ' · ' + Object.values(input).filter((v) => typeof v !== 'object').join(' ') : ''}`);
    try { const r = await callTool(name, input); say(feedbackFor(name, r)); return { tool: name, input, result: r }; }
    catch (e) { ui.flash('✗ ' + e.message, 'err'); return { tool: name, input, error: e.message }; }
  }
  function askConfirm(name, input, label) { pending = { name, input }; ui.flash(`Say "yes" to ${label}`, 'ask'); say(`Say yes to ${label}`); return { pending: name }; }
  async function confirmPending(ok) { const p = pending; pending = null; if (!p) return { did: 'nothing pending' }; if (!ok) { ui.flash('Cancelled'); return { cancelled: p.name }; } return exec(p.name, p.input); }
  function finish(result, text) { window.dispatchEvent(new CustomEvent('handsfree:routed', { detail: { text, result } })); return result; }
  function feedbackFor(name, r) {
    if (!r || typeof r !== 'object') return '';
    if (r.focused != null) return r.title ? `${r.focused}. ${r.title.slice(0, 40)}` : '';
    if (r.returned != null) return `${r.returned} results`;
    if (r.count != null) return `${r.count} picks`;
    if (r.opened) return 'Opening';
    if (r.loaded != null) return r.loaded ? `${r.loaded} more` : 'No more';
    return '';
  }
  function helpToast() { const names = listTools().map((t) => t.name.replace(/_/g, ' ')); ui.flash('Try: scroll down · next · open it · buy it · back · ' + names.slice(0, 3).join(' · '), 'ask', 6000); return { tools: names }; }

  // ---------------- speech out ----------------
  let lastSaid = 0;
  function say(text) {
    if (!CFG.speak || !text || !('speechSynthesis' in window)) return;
    if (Date.now() - lastSaid < 400) speechSynthesis.cancel();
    lastSaid = Date.now();
    const u = new SpeechSynthesisUtterance(text); u.lang = CFG.lang; u.rate = 1.1; u.volume = .8;
    voice.muteFor(Math.min(4000, 400 + text.length * 60));
    speechSynthesis.speak(u);
  }

  // ---------------- voice in ----------------
  const voice = (() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    let rec = null, on = false, muteUntil = 0, restartT;
    function start() {
      if (!SR) { ui.flash('Speech recognition not available in this browser', 'err'); return false; }
      if (on) return true;
      rec = new SR(); rec.lang = CFG.lang; rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1;
      rec.onresult = (e) => {
        if (Date.now() < muteUntil) return;
        let interim = '', final = '';
        for (let i = e.resultIndex; i < e.results.length; i++) { const r = e.results[i]; if (r.isFinal) final += r[0].transcript; else interim += r[0].transcript; }
        if (interim) { ui.transcript(interim, true); window.dispatchEvent(new CustomEvent('handsfree:transcript', { detail: { text: interim, final: false, source: 'mic' } })); }
        if (final.trim()) { window.dispatchEvent(new CustomEvent('handsfree:transcript', { detail: { text: final.trim(), final: true, source: 'mic' } })); fx.label(final.trim(), null); route(final, 'voice'); }
      };
      const REASON = { 'not-allowed': 'Microphone permission denied — allow the mic for this site', 'service-not-allowed': 'Speech service blocked by the browser', 'audio-capture': 'No microphone found', network: 'Speech recognition needs internet (Chrome sends audio to Google)', 'language-not-supported': `Language ${CFG.lang} not supported` };
      const voiceEvent = (state, detail) => window.dispatchEvent(new CustomEvent('handsfree:voice', { detail: { state, detail } }));
      rec.onstart = () => voiceEvent('listening', CFG.lang);
      rec.onaudiostart = () => voiceEvent('audio', 'microphone open');
      rec.onspeechstart = () => voiceEvent('speech', 'speech detected');
      rec.onerror = (e) => { voiceEvent('error', e.error); if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'audio-capture') { ui.flash(REASON[e.error], 'err', 6000); stop(); } else if (e.error !== 'no-speech' && e.error !== 'aborted') ui.flash(REASON[e.error] || 'voice: ' + e.error, 'err', 5000); };
      rec.onend = () => { voiceEvent('ended', on ? 'restarting' : 'stopped'); if (on) restartT = setTimeout(() => { try { rec.start(); } catch {} }, 250); };
      try { rec.start(); } catch (e) { ui.flash('voice: ' + e.message, 'err'); return false; }
      on = true; ui.setVoice(true); ui.flash(`Listening (${CFG.lang})${CFG.wake ? ` · say "${CFG.wake}" first` : ''}`);
      meterStart();
      return true;
    }
    // microphone level meter: proves audio is being captured even when recognition returns nothing
    let meterStream = null, meterCtx = null, meterRaf = 0;
    async function meterStart() {
      try {
        meterStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        meterCtx = new (window.AudioContext || window.webkitAudioContext)(); const src = meterCtx.createMediaStreamSource(meterStream); const an = meterCtx.createAnalyser(); an.fftSize = 512; src.connect(an);
        const buf = new Uint8Array(an.frequencyBinCount);
        const tick = () => { if (!on) return; an.getByteTimeDomainData(buf); let sum = 0; for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; } ui.level(Math.min(1, Math.sqrt(sum / buf.length) * 4)); meterRaf = requestAnimationFrame(tick); };
        tick();
      } catch (e) { ui.flash('Mic level: ' + (e.name === 'NotAllowedError' ? 'permission denied' : e.message), 'err', 5000); }
    }
    function meterStop() { cancelAnimationFrame(meterRaf); meterStream?.getTracks().forEach((t) => t.stop()); meterStream = null; try { meterCtx?.close(); } catch {} meterCtx = null; ui.level(0); }
    function stop() { on = false; clearTimeout(restartT); try { rec?.stop(); } catch {} meterStop(); ui.setVoice(false); }
    /** Diagnostics: push a transcript through the exact voice path without a microphone. */
    function feed(text) { window.dispatchEvent(new CustomEvent('handsfree:transcript', { detail: { text, final: true, source: 'feed' } })); ui.transcript(text); return route(text, 'voice'); }
    function setLang(l) { CFG.lang = l; if (on) { stop(); start(); } ui.flash('Voice language: ' + l); return l; }
    return { start, stop, toggle: () => (on ? stop() : start()), feed, setLang, get lang() { return CFG.lang; }, get on() { return on; }, muteFor: (ms) => { muteUntil = Date.now() + ms; }, supported: !!SR };
  })();

  // ---------------- overlay: translucent particle projection ----------------
  const fx = (() => {
    let canvas, ctx, raf, on = false, dpr = 1;
    const particles = [];      // {x,y,vx,vy,life,ttl,size,kind}
    const trails = new Map();  // key → [{x,y,t}]
    let cursor = null, cursorMode = 'none', labelState = null, ring = null, hand = null, zones = null; // zones: {active:'up'|'down'|null, side:'left'|'right'|null, strength:0..1}
    const rgba = (hex, a) => { const h = hex.replace('#', ''); const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };
    function mount() {
      if (canvas) return;
      canvas = document.createElement('canvas'); canvas.className = 'hf-overlay'; canvas.setAttribute('aria-hidden', 'true');
      Object.assign(canvas.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: 2147482990 });
      document.body.appendChild(canvas); ctx = canvas.getContext('2d'); resize(); addEventListener('resize', resize);
    }
    let staticLayer = null, staticKey = '';
    function resize() { dpr = Math.min(CFG.maxDpr || 1.5, devicePixelRatio || 1); canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); staticKey = ''; }
    /** The grid without the cursor bump changes only with size / which band is hot / which half is active:
     *  render it once into an offscreen canvas and blit it every frame. */
    function staticGrid() {
      const key = [innerWidth, innerHeight, zones?.side, zones?.active, ACCENT(), ZONE()].join('|');
      if (staticLayer && staticKey === key) return staticLayer;
      const off = staticLayer || document.createElement('canvas'); off.width = innerWidth * dpr; off.height = innerHeight * dpr;
      const c = off.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, innerWidth, innerHeight);
      const A = ACCENT(), Z = ZONE(), zw = innerWidth * CFG.zoneWidth, half = innerHeight / 2, sp = CFG.dotSpacing;
      for (const side of ['left', 'right']) {
        const x0 = side === 'left' ? 0 : innerWidth - zw, hot = zones?.side === side;
        c.fillStyle = rgba(Z, hot ? .16 : .08); c.fillRect(x0, 0, zw, innerHeight);
        if (zones?.active && hot) { const g = c.createLinearGradient(0, zones.active === 'up' ? 0 : half, 0, zones.active === 'up' ? half : innerHeight); g.addColorStop(0, rgba(Z, zones.active === 'up' ? .28 : 0)); g.addColorStop(1, rgba(Z, zones.active === 'up' ? 0 : .28)); c.fillStyle = g; c.fillRect(x0, zones.active === 'up' ? 0 : half, zw, half); }
        c.strokeStyle = rgba(Z, hot ? .7 : .35); c.lineWidth = 1.5; c.beginPath(); const ex = side === 'left' ? zw + .5 : x0 - .5; c.moveTo(ex, 0); c.lineTo(ex, innerHeight); c.stroke();
        c.strokeStyle = rgba(Z, .35); c.setLineDash([3, 7]); c.beginPath(); c.moveTo(x0, half); c.lineTo(x0 + zw, half); c.stroke(); c.setLineDash([]);
        c.strokeStyle = rgba(Z, hot ? 1 : .6); c.lineWidth = 2.5; c.lineCap = 'round'; c.lineJoin = 'round';
        const mx = x0 + zw / 2;
        c.beginPath(); c.moveTo(mx - 10, 34); c.lineTo(mx, 24); c.lineTo(mx + 10, 34); c.stroke();
        c.beginPath(); c.moveTo(mx - 10, innerHeight - 34); c.lineTo(mx, innerHeight - 24); c.lineTo(mx + 10, innerHeight - 34); c.stroke();
      }
      // dots, batched: one path per (colour, alpha, radius) bucket instead of one fill per dot
      const buckets = new Map();
      for (let x = sp / 2; x < innerWidth; x += sp) {
        const inBand = x < zw || x > innerWidth - zw, side = x < zw ? 'left' : 'right', hot = inBand && zones?.side === side;
        for (let y = sp / 2; y < innerHeight; y += sp) {
          let r = .9, al = .045, col = A;
          if (inBand) { const dir = y < half ? 'up' : 'down', rel = ((y % half) / half) * 2 - 1, edge = Math.max(0, dir === 'up' ? -rel : rel); col = Z; r = 1.1 + edge * 1.5; al = .16 + edge * .25 + (hot ? .15 : 0) + (hot && zones.active === dir ? .2 : 0); }
          const k = col + '|' + al.toFixed(2) + '|' + r.toFixed(1); let b = buckets.get(k); if (!b) { b = { col, al, r, pts: [] }; buckets.set(k, b); } b.pts.push(x, y);
        }
      }
      for (const b of buckets.values()) { c.fillStyle = rgba(b.col, Math.min(.95, b.al)); c.beginPath(); for (let i = 0; i < b.pts.length; i += 2) { c.moveTo(b.pts[i] + b.r, b.pts[i + 1]); c.arc(b.pts[i], b.pts[i + 1], b.r, 0, Math.PI * 2); } c.fill(); }
      staticLayer = off; staticKey = key; return off;
    }
    function start() { mount(); on = true; canvas.style.display = 'block'; loop(); }
    function stop() { on = false; cancelAnimationFrame(raf); if (canvas) { ctx.clearRect(0, 0, innerWidth, innerHeight); canvas.style.display = 'none'; } trails.clear(); particles.length = 0; cursor = null; hand = null; }
    function setHand(points, mode) { hand = points; cursorMode = mode; const now = performance.now(); if (!points) return; for (const [k, p] of Object.entries(points)) { const arr = trails.get(k) || []; arr.push({ x: p.x, y: p.y, t: now }); while (arr.length > 14) arr.shift(); trails.set(k, arr); } }
    function setCursor(p) { cursor = p; }
    function setZones(z) { zones = z; }
    function label(text, at, ms = 1100) { labelState = { text, at: at || cursor || { x: innerWidth - 120, y: innerHeight - 90 }, t0: performance.now(), ms }; if (!on) { start(); setTimeout(() => { if (!gesture.on) stop(); }, ms + 100); } }
    function burst(kind, at, dir) {
      const p = at || cursor || { x: innerWidth / 2, y: innerHeight / 2 };
      if (kind === 'swipe') {
        const n = 70, along = dir === 'down' || dir === 'up';
        for (let i = 0; i < n; i++) {
          const spread = (Math.random() - .5) * (along ? innerWidth * .5 : innerHeight * .45);
          const speed = 260 + Math.random() * 520;
          particles.push({ x: along ? p.x + spread : p.x, y: along ? p.y : p.y + spread, vx: dir === 'left' ? -speed : dir === 'right' ? speed : (Math.random() - .5) * 40, vy: dir === 'down' ? speed : dir === 'up' ? -speed : (Math.random() - .5) * 40, life: 0, ttl: 520 + Math.random() * 380, size: 1.5 + Math.random() * 3, kind: 'stream' });
        }
        ring = null;
      } else if (kind === 'flow') {
        // a few particles per frame while a scroll zone is active, drifting in the scroll direction
        for (let i = 0; i < 3; i++) { const sp = 120 + Math.random() * 260; particles.push({ x: p.x + (Math.random() - .5) * 60, y: p.y + (Math.random() - .5) * 30, vx: (Math.random() - .5) * 30, vy: dir === 'down' ? sp : -sp, life: 0, ttl: 380 + Math.random() * 260, size: 1 + Math.random() * 2.5, kind: 'stream' }); }
        return;
      } else if (kind === 'click') {
        ring = { x: p.x, y: p.y, t0: performance.now(), ms: 520 };
      } else if (kind === 'back') {
        for (let i = 0; i < 60; i++) { const s = 240 + Math.random() * 420; particles.push({ x: p.x + Math.random() * 60, y: p.y + (Math.random() - .5) * innerHeight * .35, vx: -s, vy: (Math.random() - .5) * 60, life: 0, ttl: 500 + Math.random() * 400, size: 1.5 + Math.random() * 3, kind: 'stream' }); }
        ring = { x: p.x, y: p.y, t0: performance.now(), ms: 420, arrow: 'left' };
      }
      if (!on) { start(); setTimeout(() => { if (!gesture.on) stop(); }, 1200); }
    }
    let last = 0;
    function loop() { if (!on) return; raf = requestAnimationFrame(loop); render(); }
    function render() {
      if (!ctx) return;
      const now = performance.now(); const dt = Math.min(48, now - (last || now)) / 1000; last = now;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      const A = ACCENT();
      // static grid + zones (cached), then only the dots near the cursor are redrawn with the bump
      if (hand) {
        ctx.drawImage(staticGrid(), 0, 0, innerWidth, innerHeight);
        if (cursor) {
          const cx = cursor.x, cy = cursor.y, zw = innerWidth * CFG.zoneWidth, half = innerHeight / 2, sp = CFG.dotSpacing, Z = ZONE(), RAD = 170;
          const x0 = Math.max(sp / 2, Math.floor((cx - RAD) / sp) * sp + sp / 2), x1 = Math.min(innerWidth, cx + RAD), y0 = Math.max(sp / 2, Math.floor((cy - RAD) / sp) * sp + sp / 2), y1 = Math.min(innerHeight, cy + RAD);
          for (let x = x0; x <= x1; x += sp) {
            const inBand = x < zw || x > innerWidth - zw, side = x < zw ? 'left' : 'right', hot = inBand && zones?.side === side;
            for (let y = y0; y <= y1; y += sp) {
              const d2 = (x - cx) ** 2 + (y - cy) ** 2; if (d2 > RAD * RAD) continue;
              let r = .9, al = .045, col = A;
              if (inBand) { const dir = y < half ? 'up' : 'down', rel = ((y % half) / half) * 2 - 1, edge = Math.max(0, dir === 'up' ? -rel : rel); col = Z; r = 1.1 + edge * 1.5; al = .16 + edge * .25 + (hot ? .15 : 0) + (hot && zones?.active === dir ? .2 : 0); }
              const bump = Math.exp(-d2 / (2 * 68 * 68)); r += bump * 5.5; al += bump * .7;
              ctx.fillStyle = rgba(col, Math.min(.95, al)); ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
            }
          }
        }
      }
      ctx.globalCompositeOperation = 'source-over';
      // (fingertip trails, palm glow and flying particles were removed: only the grid, the zones, the cursor and a click ring remain)
      // click / back ring
      if (ring) { const k = (now - ring.t0) / ring.ms; if (k > 1) ring = null; else { ctx.strokeStyle = rgba(A, (1 - k) * .9); ctx.lineWidth = 2.5 * (1 - k) + .5; ctx.beginPath(); ctx.arc(ring.x, ring.y, 14 + k * 46, 0, Math.PI * 2); ctx.stroke(); } }
      // cursor: bold ring (white core, ink outline, soft halo) so it reads on any background; filled when making a fist
      if (cursor && cursorMode !== 'none') {
        const fist = cursorMode === 'tap', R = fist ? 13 : 20;
        ctx.lineWidth = 6; ctx.strokeStyle = rgba('#0b0b0c', .55); ctx.beginPath(); ctx.arc(cursor.x, cursor.y, R, 0, Math.PI * 2); ctx.stroke();
        ctx.lineWidth = 3; ctx.strokeStyle = rgba('#ffffff', .98); ctx.beginPath(); ctx.arc(cursor.x, cursor.y, R, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = fist ? rgba(ZONE(), .95) : rgba('#ffffff', .95); ctx.beginPath(); ctx.arc(cursor.x, cursor.y, fist ? 7 : 4, 0, Math.PI * 2); ctx.fill();
        if (!fist) { ctx.fillStyle = rgba('#0b0b0c', .8); ctx.beginPath(); ctx.arc(cursor.x, cursor.y, 2, 0, Math.PI * 2); ctx.fill(); }
      }
      // label
      if (labelState) {
        const k = (now - labelState.t0) / labelState.ms; if (k > 1) labelState = null; else {
          const a = k < .15 ? k / .15 : k > .75 ? (1 - k) / .25 : 1;
          ctx.font = '600 13px "General Sans", "DM Sans", system-ui, sans-serif'; const w = ctx.measureText(labelState.text).width + 24;
          const x = Math.min(innerWidth - w - 12, Math.max(12, labelState.at.x + 22)), y = Math.max(12, labelState.at.y - 44 - k * 18);
          ctx.fillStyle = rgba('#0b0b0c', .82 * a); roundRect(x, y, w, 30, 15); ctx.fill();
          ctx.fillStyle = rgba('#ffffff', a); ctx.textBaseline = 'middle'; ctx.fillText(labelState.text, x + 12, y + 15);
        }
      }
    }
    function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
    return { start, stop, render, setHand, setCursor, setZones, burst, label, get on() { return on; } };
  })();

  // ---------------- gesture in ----------------
  // Index finger = cursor. The outer left/right bands of the viewport are scroll zones: upper half scrolls up,
  // lower half scrolls down, faster the further the cursor is from the band's vertical centre. A fist = click
  // on whatever the cursor is over. No swipes: everything is position-based, so it is calm and predictable.
  const gesture = (() => {
    let on = false, stream, video, landmarker, raf, cursor = null, lastClick = 0, hoverEl = null, lostFrames = 0, lastT = 0, flowT = 0, lastZone = null, wave = [], lastWave = 0, cursorT = 0, frameNo = 0;
    // tap detector: the index finger, held out alone, bends quickly (extension ratio dips) and straightens again
    // fist detector: all four fingers folded for a few detections → one click at the position the hand had when it closed
    const fist = { closed: 0, open: 0, fired: false, anchor: null };
    function detectFist(isFist, at) {
      if (isFist) { fist.open = 0; if (++fist.closed === 1) fist.anchor = at; if (fist.closed >= CFG.fistFrames && !fist.fired) { fist.fired = true; return 'click'; } return fist.closed === 1 ? 'down' : null; }
      if (++fist.open >= CFG.fistOpenFrames) { fist.closed = 0; fist.fired = false; fist.anchor = null; }
      return null;
    }
    const resetTap = () => { fist.closed = 0; fist.open = 0; fist.fired = false; fist.anchor = null; };
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const up = (lm, tip, pip, mcp) => dist(lm[tip], lm[0]) > dist(lm[pip], lm[0]) * 1.08 && lm[tip].y < lm[mcp].y;
    let side = 'right'; // which lower corner of the frame the hand is working from
    const pickSide = (mx) => { const h = CFG.sideHysteresis; if (side === 'right' && mx < 0.5 - h) side = 'left'; else if (side === 'left' && mx > 0.5 + h) side = 'right'; return side; };
    const map = (p) => { const R = CFG.region, rx = R[side]; const nx = Math.min(1, Math.max(0, ((1 - p.x) - rx.x0) / (rx.x1 - rx.x0))), ny = Math.min(1, Math.max(0, (p.y - R.y0) / (R.y1 - R.y0))); return { x: nx * innerWidth, y: ny * innerHeight }; };
    async function start() {
      if (on) return true;
      if (!navigator.mediaDevices?.getUserMedia) { ui.flash('Camera not available', 'err'); return false; }
      ui.flash('Loading hand tracker…');
      try {
        const vision = await import(`${CFG.mediapipe}/vision_bundle.mjs`);
        const files = await vision.FilesetResolver.forVisionTasks(`${CFG.mediapipe}/wasm`);
        landmarker = landmarker || await vision.HandLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: CFG.model, delegate: 'GPU' }, runningMode: 'VIDEO', numHands: 1 });
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' }, audio: false });
      } catch (e) { ui.flash('gesture: ' + (e.message || e), 'err'); return false; }
      video = ui.video(); video.srcObject = stream; await video.play();
      on = true; ui.setGesture(true); fx.start(); fx.setZones({ active: null, side: null, strength: 0 });
      ui.flash('Rest your hand low · point to aim · fist to click · teal bands scroll · wave right = back, left = forward');
      lastT = performance.now(); loop();
      return true;
    }
    /** Which scroll zone (if any) the cursor is in, and how hard. */
    function zoneAt(p) {
      const zw = innerWidth * CFG.zoneWidth;
      const side = p.x < zw ? 'left' : p.x > innerWidth - zw ? 'right' : null;
      if (!side) return { active: null, side: null, strength: 0 };
      const half = innerHeight / 2, rel = ((p.y % half) / half) * 2 - 1; // -1 top of band … +1 bottom of band
      const dir = p.y < half ? 'up' : 'down';
      // strength grows from the band's centre outward: up-band → towards the top edge, down-band → towards the bottom edge
      const raw = dir === 'up' ? -rel : rel; // 1 at the outer edge, -1 at the inner edge
      const strength = Math.max(0, (raw - CFG.zoneDeadband) / (1 - CFG.zoneDeadband));
      return { active: strength > 0 ? dir : null, side, strength: Math.pow(strength, 1.4) };
    }
    function loop() {
      if (!on) return;
      raf = requestAnimationFrame(loop);
      const now = performance.now(), dt = Math.min(.05, (now - lastT) / 1000); lastT = now;
      if (video.readyState < 2) return;
      if ((frameNo++ % (CFG.detectEvery || 1)) !== 0) return; // skip frames: the model is the expensive part
      const res = landmarker.detectForVideo(video, now);
      const lm = res?.landmarks?.[0];
      if (!lm) { if (++lostFrames > 6) { if (cursor) window.dispatchEvent(new CustomEvent('handsfree:handlost')); cursor = null; fx.setHand(null, 'none'); fx.setCursor(null); fx.setZones({ active: null, side: null, strength: 0 }); ui.hand(false); setHover(null); resetTap(); } return; }
      lostFrames = 0; ui.hand(true);
      const fingers = [up(lm, 8, 6, 5), up(lm, 12, 10, 9), up(lm, 16, 14, 13), up(lm, 20, 18, 17)];
      const nUp = fingers.filter(Boolean).length;
      const size = dist(lm[0], lm[9]) || 0.1;
      const closed = nUp === 0 && dist(lm[8], lm[0]) / size < 1.25;   // all fingers folded and the index tip pulled in: a fist
      const pointing = fingers[0] && !fingers[1] && !fingers[2] && !fingers[3];
      const mode = closed ? 'tap' : nUp >= 3 ? 'open' : pointing ? 'point' : 'other';
      const isFist = closed;
      pickSide(1 - lm[9].x);
      const tips = { thumb: map(lm[4]), index: map(lm[8]), middle: map(lm[12]), ringf: map(lm[16]), pinky: map(lm[20]), palm: map({ x: (lm[0].x + lm[5].x + lm[9].x + lm[13].x + lm[17].x) / 5, y: (lm[0].y + lm[5].y + lm[9].y + lm[13].y + lm[17].y) / 5 }) };
      fx.setHand(tips, mode);
      // cursor follows the index tip; while the hand is closed it holds the position it had when the fist formed
      const target = isFist ? (fist.anchor || cursor || tips.palm) : tips.index;
      const prev = cursor;
      cursor = cursor ? { x: cursor.x + (target.x - cursor.x) * CFG.cursorSmoothing, y: cursor.y + (target.y - cursor.y) * CFG.cursorSmoothing } : target;
      fx.setCursor(cursor);
      if (prev && gesture.onCursor) gesture.onCursor(Math.hypot(cursor.x - prev.x, cursor.y - prev.y), mode);
      // open-hand wave (fast horizontal sweep of the palm, mirrored so it matches what the user sees): right = back, left = forward
      const palmN = { x: 1 - lm[9].x, y: lm[9].y, t: now };
      if (mode === 'open') { wave.push(palmN); wave = wave.filter((p) => now - p.t <= CFG.waveWindowMs); } else wave = [];
      if (mode === 'open' && wave.length >= 4 && now - lastWave > CFG.waveCooldownMs) {
        const a0 = wave[0], dx = palmN.x - a0.x, dy = palmN.y - a0.y, sp = Math.hypot(dx, dy) / Math.max((now - a0.t) / 1000, .05);
        if (Math.abs(dx) > CFG.waveDistance && Math.abs(dx) > Math.abs(dy) * 2.5 && sp > CFG.waveSpeed) { lastWave = now; wave = []; waveTo(dx > 0 ? 'right' : 'left'); }
      }
      if (now - cursorT > 33) { cursorT = now; window.dispatchEvent(new CustomEvent('handsfree:cursor', { detail: { x: cursor.x, y: cursor.y, mode } })); }
      // scroll zones (not while making a fist, and not while the cursor rests on a horizontal scroller such as a product rail —
      // pages mark those with data-hf-scroll="x" and handle hover-to-scroll themselves)
      const overX = !!document.elementFromPoint(cursor.x, cursor.y)?.closest('[data-hf-scroll="x"]');
      const z = isFist || overX ? { active: null, side: null, strength: 0 } : zoneAt(cursor);
      fx.setZones(z);
      if (z.active) {
        const v = CFG.maxScrollSpeed * z.strength * (z.active === 'down' ? 1 : -1);
        scrollBy({ top: v * dt, left: 0, behavior: 'instant' }); // per-frame steps must not start CSS smooth animations
        if (lastZone !== z.active) { lastZone = z.active; ui.flash(`${z.active === 'down' ? '↓' : '↑'} scrolling`); window.dispatchEvent(new CustomEvent('handsfree:gesture', { detail: { gesture: 'scroll-' + z.active, at: cursor } })); }
        setHover(null);
      } else {
        lastZone = null;
        if (!isFist) setHover(elementAt(cursor));
      }
      // fist = click (a closed hand held for a few detections; open it before the next click)
      const f = detectFist(isFist, cursor);
      if (f === 'click' && now - lastClick > CFG.clickCooldownMs) { lastClick = now; click(fist.anchor); }
    }
    async function waveTo(dir) {
      window.dispatchEvent(new CustomEvent('handsfree:gesture', { detail: { gesture: 'wave-' + dir, at: cursor } }));
      fx.burst('click', cursor);
      if (dir === 'right') { fx.label('back', cursor); ui.flash('→ back'); return goBack(); }
      fx.label('forward', cursor); ui.flash('← forward'); history.forward(); return { did: 'history.forward' };
    }
    function elementAt(p) { const el = document.elementFromPoint(p.x, p.y); if (!el || el.closest('.hf-dock, .hf-overlay')) return null; return el.closest('[data-pid], article, a[href], button, [role="button"], input, .chip') || null; }
    function setHover(el) { if (el === hoverEl) return; hoverEl?.classList.remove('hf-hover'); hoverEl = el; el?.classList.add('hf-hover'); }
    async function click(at) {
      const pos = at || cursor;
      window.dispatchEvent(new CustomEvent('handsfree:gesture', { detail: { gesture: 'fist-click', at: pos } }));
      fx.burst('click', pos);
      const el = elementAt(pos) || hoverEl;
      if (el?.dataset?.pid && focusTool()) {
        fx.label('open', pos); ui.flash('◎ open');
        await exec(focusTool().name, { target: el.dataset.pid });
        return viaTool(openTool(), { target: el.dataset.pid }, 'open');
      }
      if (el) {
        fx.label('click', pos); ui.flash('◎ click');
        // a synthetic click carries no user activation, so target=_blank links would be popup-blocked: navigate this tab instead
        const a = el.closest('a[href]');
        if (a && a.target === '_blank' && !navigator.userActivation?.isActive) { location.assign(a.href); return { did: 'navigate', href: a.href }; }
        el.click(); return { did: 'click', target: el.tagName };
      }
      fx.label('open', pos); return viaTool(openTool(), {}, 'open');
    }
    function stop() { on = false; cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); setHover(null); fx.stop(); ui.setGesture(false); ui.hand(false); cursor = null; }
    const api = { start, stop, toggle: () => (on ? stop() : start()), zoneAt, detectFist, onCursor: null, get on() { return on; } };
    return api;
  })();

  // ---------------- gesture tutorial (a short walkthrough; the camera and the gesture engine start only when it ends) ----------------
  const tutorial = (() => {
    const svgViewport = (band) => `<svg viewBox="0 0 220 132" class="hf-diag"><rect x="6" y="6" width="208" height="120" rx="12" fill="none" stroke="currentColor" stroke-opacity=".35"/>
      <rect x="6" y="6" width="38" height="60" rx="10" fill="currentColor" fill-opacity="${band === 'up' ? .28 : .08}"/><rect x="6" y="66" width="38" height="60" rx="10" fill="currentColor" fill-opacity="${band === 'down' ? .28 : .08}"/>
      <rect x="176" y="6" width="38" height="60" rx="10" fill="currentColor" fill-opacity="${band === 'up' ? .28 : .08}"/><rect x="176" y="66" width="38" height="60" rx="10" fill="currentColor" fill-opacity="${band === 'down' ? .28 : .08}"/>
      <path d="M20 26l5-6 5 6M190 26l5-6 5 6M20 106l5 6 5-6M190 106l5 6 5-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M6 66h38M176 66h38" stroke="currentColor" stroke-opacity=".4" stroke-dasharray="3 5"/>
      <g opacity=".9"><rect x="66" y="30" width="40" height="52" rx="8" fill="currentColor" fill-opacity=".12"/><rect x="114" y="30" width="40" height="52" rx="8" fill="currentColor" fill-opacity=".12"/></g>${band ? `<circle cx="${band === 'up' ? 25 : 195}" cy="${band === 'up' ? 22 : 110}" r="9" fill="none" stroke="currentColor" stroke-width="2"/>` : '<circle cx="86" cy="56" r="9" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="86" cy="56" r="2.5" fill="currentColor"/>'}</svg>`;
    const svgHand = (kind) => kind === 'point'
      ? `<svg viewBox="0 0 64 64" class="hf-hand" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M26 34V12a4 4 0 0 1 8 0v20"/><path d="M34 32v-2a4 4 0 0 1 8 0v6M42 34a4 4 0 0 1 8 0v8M50 40a4 4 0 0 1 6 3v6a14 14 0 0 1-14 14h-6a14 14 0 0 1-11-5.5L14 42a4 4 0 0 1 6.4-4.8L26 42"/></svg>`
      : `<svg viewBox="0 0 64 64" class="hf-hand" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 30v-4a4 4 0 0 1 8 0v4M26 28v-4a4 4 0 0 1 8 0v4M34 28v-3a4 4 0 0 1 8 0v3M42 30a4 4 0 0 1 8 0v10a14 14 0 0 1-14 14h-6a14 14 0 0 1-12-7l-4-7a4 4 0 0 1 6.8-4.2L22 38"/><path d="M18 30h32v6H18z" fill="currentColor" fill-opacity=".15" stroke="none"/></svg>`;
    const STEPS = [
      { title: 'Point to aim', text: 'Hold up your index finger in front of the camera. A grey ring follows your fingertip across the page; whatever it rests on gets outlined.', diagram: () => svgViewport(null) },
      { title: 'Rest the ring in a side band to scroll', text: 'The left and right edges are scroll bands. Upper half scrolls up, lower half scrolls down — the further from the middle line, the faster. Bring the ring back to the centre to stop.', diagram: () => svgViewport('down') },
      { title: 'Make a fist to click', text: 'Aim with your index finger, then close your hand into a fist: the card under the cursor opens in a panel, a fist on any button or link clicks it. Open the hand again before the next click. Wave your open hand right to go back, left to go forward.', diagram: () => svgHand('fist') },
      { title: 'Ready to try', text: 'Hand tracking runs on this device, nothing is uploaded. Your browser will ask for camera permission once. Voice works too — the mic in the dock.', diagram: () => svgHand('point'), final: true },
    ];
    let box, idx = 0;
    const done = () => { try { return localStorage.getItem('handsfree.tutorial') === 'done'; } catch { return false; } };
    const css = `
    .hf-tut{position:fixed;left:50%;bottom:112px;transform:translateX(-50%);z-index:2147483001;width:min(560px,calc(100% - 32px));background:var(--ink,#0b0b0c);color:#fff;border:1px solid var(--line-ink,rgba(255,255,255,.12));border-radius:18px;padding:18px 18px 16px;font:15px/1.4 "DM Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:grid;grid-template-columns:150px 1fr;gap:16px;align-items:center}
    .hf-tut[hidden]{display:none}
    .hf-tut .hf-diag,.hf-tut .hf-hand{width:150px;height:auto;color:#fff;display:block}
    .hf-tut .hf-hand{width:96px;margin:0 auto}
    .hf-tut h3{font-family:"General Sans","DM Sans",sans-serif;font-weight:600;font-size:19px;letter-spacing:-.02em;margin:0 0 6px}
    .hf-tut p{margin:0;color:rgba(255,255,255,.7);font-size:14px}
    .hf-tut .hf-steps{font-family:"Geist Mono",monospace;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--mint,#00ffc3);margin-bottom:8px}
    .hf-tut .hf-dots{display:flex;gap:6px;margin:12px 0 10px}.hf-tut .hf-dots i{width:18px;height:3px;border-radius:2px;background:rgba(255,255,255,.14)}.hf-tut .hf-dots i.on{background:var(--mint,#00ffc3)}
    .hf-tut .hf-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
    .hf-tut button{font:600 13px "General Sans","DM Sans",sans-serif;border-radius:999px;padding:8px 16px;border:1px solid rgba(255,255,255,.2);background:transparent;color:#fff;cursor:pointer}
    .hf-tut button.hf-primary{background:var(--mint,#00ffc3);color:#000;border-color:var(--mint,#00ffc3)}
    .hf-tut .hf-skip{margin-left:auto;color:rgba(255,255,255,.55);border:0}
    @media(max-width:600px){.hf-tut{grid-template-columns:1fr}.hf-tut .hf-diag{width:100%}}`;
    function start(at = 0) {
      if (!box) { const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style); box = document.createElement('div'); box.className = 'hf-tut'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', 'Gesture tutorial'); document.body.appendChild(box); }
      idx = at; box.hidden = false; render(); return true;
    }
    function render() {
      const s = STEPS[idx]; if (!s) return close(true);
      const primary = s.final ? (gesture.on ? 'Done' : 'Enable gestures') : 'Next';
      box.innerHTML = `<div>${s.diagram()}</div><div><div class="hf-steps">Gesture tutorial · ${idx + 1} / ${STEPS.length}</div><h3>${s.title}</h3><p>${s.text}</p><div class="hf-dots">${STEPS.map((_, i) => `<i class="${i <= idx ? 'on' : ''}"></i>`).join('')}</div><div class="hf-row">${idx > 0 ? '<button data-t="prev">Back</button>' : ''}<button class="hf-primary" data-t="${s.final ? 'finish' : 'next'}">${primary}</button>${!s.final ? '<button class="hf-skip" data-t="skip">Skip</button>' : ''}</div></div>`;
      box.querySelectorAll('button').forEach((b) => b.addEventListener('click', async () => {
        const t = b.dataset.t;
        if (t === 'next') { idx++; render(); }
        else if (t === 'prev') { idx--; render(); }
        else if (t === 'finish') { close(true); if (!gesture.on) await gesture.start(); } // a real click: the camera prompt is allowed here
        else close(false); // skip: the walkthrough is dismissed but not marked done, so the next tap on the hand shows it again
      }));
    }
    function close(markDone) { if (box) box.hidden = true; if (markDone) { try { localStorage.setItem('handsfree.tutorial', 'done'); } catch {} } }
    function reset() { try { localStorage.removeItem('handsfree.tutorial'); } catch {} }
    return { start, close, reset, get done() { return done(); }, get step() { return idx; }, get open() { return !!box && !box.hidden; } };
  })();

  // ---------------- UI (NILE dock) ----------------
  const ui = (() => {
    const ICON = {
      hand: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 12.5V5.6a1.6 1.6 0 0 1 3.2 0V11M11.2 11V4.1a1.6 1.6 0 0 1 3.2 0V11M14.4 11V5.6a1.6 1.6 0 0 1 3.2 0V12M17.6 12V8.6a1.6 1.6 0 0 1 3.2 0V15a6.5 6.5 0 0 1-6.5 6.5h-1.6a6.5 6.5 0 0 1-5.4-2.9L4 13.9a1.7 1.7 0 0 1 2.7-2L8 13.4"/></svg>',
      mic: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6"/></svg>',
    };
    const css = `
    .hf-dock{position:fixed;z-index:2147483000;display:flex;position:fixed;align-items:center;gap:8px;padding:6px 6px 6px 16px;border-radius:999px;background:var(--ink,#0b0b0c);color:#fff;border:1px solid var(--line-ink,rgba(255,255,255,.12));font:500 13px/1.3 "DM Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;box-shadow:none;${CFG.position.includes('left') ? 'left:20px' : 'right:20px'};${CFG.position.includes('top') ? 'top:20px' : 'bottom:20px'}}
    .hf-btn{width:40px;height:40px;border-radius:50%;border:1px solid var(--line-ink,rgba(255,255,255,.12));background:transparent;color:#fff;cursor:pointer;display:grid;place-items:center;padding:0;transition:background .2s,color .2s,border-color .2s}
    .hf-btn:hover{border-color:#fff}
    .hf-btn.on{background:var(--mint,#00ffc3);border-color:var(--mint,#00ffc3);color:#000}
    .hf-btn.on.live{animation:hfp 1.6s infinite}
    @keyframes hfp{0%{box-shadow:0 0 0 0 rgba(0,255,195,.45)}70%{box-shadow:0 0 0 9px rgba(0,255,195,0)}100%{box-shadow:0 0 0 0 rgba(0,255,195,0)}}
    .hf-txt{max-width:300px;padding-right:6px;color:rgba(255,255,255,.72);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:"General Sans","DM Sans",sans-serif;font-weight:600;font-size:13px}
    .hf-txt.interim{color:rgba(255,255,255,.45);font-weight:500}.hf-txt.err{color:#ff8a80}.hf-txt.ask{color:var(--mint,#00ffc3)}
    .hf-level{position:absolute;left:14px;right:14px;bottom:3px;height:2px;border-radius:2px;background:rgba(255,255,255,.12);overflow:hidden;opacity:0;transition:opacity .2s}
    .hf-level.on{opacity:1}.hf-level i{display:block;height:100%;width:0;background:var(--mint,#00ffc3);transition:width .08s}
    .hf-cam{width:72px;height:54px;border-radius:14px;object-fit:cover;transform:scaleX(-1);background:#000;display:none;outline:2px solid transparent;outline-offset:-2px;transition:outline-color .2s}
    .hf-cam.show{display:block}.hf-cam.hand{outline-color:var(--mint,#00ffc3)}
    .hf-hover{outline:2px solid var(--mint-deep,#00e0ac)!important;outline-offset:2px}
    @media (max-width:600px){.hf-txt{display:none}}`;
    let dock, mic, hand, txt, cam, flashT;
    function mount() {
      if (dock) return;
      const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
      dock = document.createElement('div'); dock.className = 'hf-dock'; dock.setAttribute('aria-label', 'Handsfree controls');
      cam = document.createElement('video'); cam.className = 'hf-cam'; cam.muted = true; cam.playsInline = true;
      txt = document.createElement('span'); txt.className = 'hf-txt'; txt.textContent = 'handsfree';
      const lvl = document.createElement('div'); lvl.className = 'hf-level'; lvl.innerHTML = '<i></i>'; dock.append(cam, txt, lvl); dock._lvl = lvl;
      if (CFG.gesture) { hand = btn(ICON.hand, 'Hand gestures (camera): point to aim, fist to click, side bands scroll, wave right = back / left = forward', () => { if (gesture.on) return gesture.stop(); if (!tutorial.done) return tutorial.start(); gesture.start(); }); dock.append(hand); }
      if (CFG.voice) { mic = btn(ICON.mic, 'Voice control (microphone)', () => voice.toggle()); dock.append(mic); }
      document.body.appendChild(dock);
    }
    const btn = (svg, title, fn) => { const b = document.createElement('button'); b.className = 'hf-btn'; b.type = 'button'; b.title = title; b.setAttribute('aria-label', title); b.innerHTML = svg; b.addEventListener('click', fn); return b; };
    function flash(text, kind = '', ms = 2600) { clearTimeout(flashT); txt.textContent = text; txt.className = 'hf-txt ' + kind; flashT = setTimeout(() => { txt.textContent = voice.on ? 'listening…' : gesture.on ? 'watching…' : 'handsfree'; txt.className = 'hf-txt'; }, ms); }
    function transcript(t, interim = false) { clearTimeout(flashT); txt.textContent = interim ? t : '“' + t + '”'; txt.className = 'hf-txt' + (interim ? ' interim' : ''); }
    return { mount, flash, transcript, level: (v) => { const l = dock?._lvl; if (!l) return; l.classList.toggle('on', v > 0); l.firstChild.style.width = Math.round(v * 100) + '%'; }, video: () => (cam.classList.add('show'), cam), hand: (b) => cam?.classList.toggle('hand', b), setVoice: (b) => { mic?.classList.toggle('on', b); mic?.classList.toggle('live', b); if (!b) dock?._lvl?.classList.remove('on'); }, setGesture: (b) => { hand?.classList.toggle('on', b); hand?.classList.toggle('live', b); if (!b) cam.classList.remove('show'); } };
  })();

  // ---------------- boot ----------------
  function boot() {
    ui.mount();
    if (CFG.autostart && CFG.voice) voice.start();
    console.info(`[handsfree] v0.6.3 ready · tools: ${listTools().map((t) => t.name).join(', ') || '(none yet)'} · voice:${voice.supported} · registry:${registry() ? 'WebMCP' : 'wrapper'}`);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.Handsfree = { route, tools: listTools, voice, gesture, fx, tutorial, say, config: CFG, version: '0.6.3' };
})();
