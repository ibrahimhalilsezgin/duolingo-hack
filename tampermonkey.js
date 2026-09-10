// ==UserScript==
// @name         Duolingo Tam Otomatik Ders Çözücü & Patika İlerletici v11 (Oto-Başlat & Kalıcı Mod)
// @namespace    https://github.com/ioos/duo-bot
// @version      11.0.0
// @description  Duolingo web derslerini Gemini 3.6 Flash ve yerel Fiber hibritiyle çözer. Can 1'de arka planda pratikle can doldurur. Haritada otomatik BAŞLAT'a tıklar, sayfa yenilense de açık kalır.
// @author       İbrahim
// @match        https://www.duolingo.com/*
// @grant        GM_xmlhttpRequest
// @connect      ai.ibrahimhalilsezgin.com
// @run-at       document-start
// ==/UserScript==

/* jshint esversion: 11 */

(function () {
  'use strict';

  const AI_ENDPOINT = 'https://ai.ibrahimhalilsezgin.com/v1/chat/completions';
  const AI_KEY = 'Bearer xxxxxxxx';
  const AI_MODEL = 'ag/gemini-3.6-flash-high';

  // localStorage üzerinden durum hatırlama (sayfa yenilense de açık kalır)
  let isAutoRunning = localStorage.getItem('duo_bot_autorun') === 'true';
  let isBusy = false;
  let mainLoopInterval = null;
  let stuckCounter = 0;
  let lastPrompt = '';

  window._duoChallenges = [];
  window._answeredChallengeIds = new Set();
  window._duoAuthHeader = '';
  window._currentSessionMeta = { fromLanguage: 'tr', learningLanguage: 'en' };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Konsol Log Yardımcısı
  const Log = {
    info: (msg, data = '') => console.log(`%c[DuoBot v11 AI] ℹ️ ${msg}`, 'color: #00e5ff; font-weight: bold;', data),
    req: (msg) => console.log(`%c[DuoBot v11 AI] 🚀 ${msg}`, 'color: #ffeb3b; font-weight: bold;'),
    res: (msg, time) => console.log(`%c[DuoBot v11 AI] 📥 ${msg} (${time}ms)`, 'background: #1b5e20; color: #b9f6ca; font-weight: bold; padding: 2px 6px; border-radius: 4px;'),
    warn: (msg, err = '') => console.log(`%c[DuoBot v11 AI] ⚠️ ${msg}`, 'color: #ff9800; font-weight: bold;', err),
    err: (msg, err = '') => console.log(`%c[DuoBot v11 AI] ❌ ${msg}`, 'background: #b71c1c; color: #fff; padding: 2px 6px;', err),
    ok: (msg) => console.log(`%c[DuoBot v11 AI] ✅ ${msg}`, 'background: #00796b; color: #fff; font-weight: bold; padding: 4px 8px; border-radius: 4px;')
  };

  // Token Karşılaştırma & Normalizasyon (Nokta / Noktalama korumalı)
  function normalizeToken(str) {
    if (!str) return '';
    const trimmed = str.trim().toLowerCase();
    // Yalnızca noktalama ise aynen koru (. ? ! , ; :)
    if (/^[.,!?:;]+$/.test(trimmed)) return trimmed;
    // Kelime ise kenarlardaki parantez vb. temizle, harf ve rakamı koru
    return trimmed.replace(/^[^a-z0-9ğüşıöç]+|[^a-z0-9ğüşıöç]+$/gi, '');
  }

  // Can (Health / Hearts) Sayısını Okuma
  function getHeartsCount() {
    // 1. DOM Üzerinden Arama
    const heartSelectors = [
      '[data-test="hearts-counter"]',
      '[data-test="hearts"]',
      '[data-test*="heart-count"]',
      'header [data-test*="heart"]'
    ];

    for (const sel of heartSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        const text = el.innerText.trim();
        if (text.includes('∞') || text.toLowerCase().includes('unlimited') || text.toLowerCase().includes('sınırsız')) {
          return Infinity;
        }
        const match = text.match(/\d+/);
        if (match) {
          const num = parseInt(match[0], 10);
          if (!isNaN(num)) return num;
        }
      }
    }

    // 2. React Fiber Üzerinden Header Arama
    try {
      const roots = [
        document.querySelector('header'),
        document.querySelector('[data-test="session-header"]'),
        document.querySelector('[data-test="hearts-counter"]'),
        document.querySelector('main')
      ].filter(Boolean);

      for (const el of roots) {
        const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
        if (!fiberKey) continue;
        let f = el[fiberKey];
        let depth = 0;
        while (f && depth < 35) {
          const h = f.memoizedProps?.hearts ?? f.memoizedProps?.user?.hearts ?? f.memoizedProps?.currentHearts ?? f.memoizedProps?.session?.hearts;
          if (typeof h === 'number') return h;
          f = f.return;
          depth++;
        }
      }
    } catch (e) {}

    return null;
  }

  // 1. Gemini 3.6 Flash AI Motoru
  function queryAI(systemPrompt, userPrompt) {
    const startTime = performance.now();
    Log.req(`Gemini Flash Çağrılıyor -> "${userPrompt.slice(0, 60)}..."`);

    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest === 'undefined') {
        const err = new Error('GM_xmlhttpRequest bulunamadı! Tampermonkey izinlerini kontrol edin.');
        Log.err('Tampermonkey Hatası', err);
        reject(err);
        return;
      }

      GM_xmlhttpRequest({
        method: 'POST',
        url: AI_ENDPOINT,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': AI_KEY
        },
        data: JSON.stringify({
          model: AI_MODEL,
          messages: [
            {
              role: 'system',
              content: systemPrompt || 'Duolingo soru çözücüsün. Asla açıklama yapma. Sadece doğrudan cevabı tek satır yaz.'
            },
            {
              role: 'user',
              content: userPrompt
            }
          ],
          stream: false,
          max_tokens: 100,
          temperature: 0.1
        }),
        timeout: 10000,
        onload: function (res) {
          const duration = Math.round(performance.now() - startTime);
          try {
            const data = JSON.parse(res.responseText);
            let ans = (data.choices?.[0]?.message?.content || '').trim();
            ans = ans.replace(/^(doğru\s*cevap|cevap|answer|the\s*correct\s*answer\s*is)\s*[:：-]?\s*/i, '').replace(/^["'`]|["'`]$/g, '').trim();
            Log.res(`Cevap: "${ans}"`, duration);
            resolve(ans);
          } catch (e) {
            Log.err('JSON Ayrıştırma Hatası', e);
            reject(e);
          }
        },
        onerror: function (err) {
          Log.err('Ağ Hatası', err);
          reject(err);
        },
        ontimeout: function () {
          Log.err('Zaman Aşımı');
          reject(new Error('AI zaman aşımı'));
        }
      });
    });
  }

  // 2. Sessions API Kancası & Token Yakalayıcı
  function getJwtToken() {
    if (window._duoAuthHeader) return window._duoAuthHeader;
    const match = document.cookie.match(/jwt_token=([^;]+)/);
    if (match && match[1]) return `Bearer ${match[1]}`;
    return '';
  }

  const rawFetch = window.fetch;
  window.fetch = async function (...args) {
    try {
      if (args[1]?.headers) {
        const h = args[1].headers;
        const auth = h['Authorization'] || h['authorization'] || (typeof h.get === 'function' ? h.get('Authorization') : null);
        if (auth) window._duoAuthHeader = auth;
      }
    } catch (e) {}

    const response = await rawFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
      if (url.includes('/sessions')) {
        const clone = response.clone();
        clone.json().then((data) => {
          if (data) {
            if (data.fromLanguage) window._currentSessionMeta.fromLanguage = data.fromLanguage;
            if (data.learningLanguage) window._currentSessionMeta.learningLanguage = data.learningLanguage;
            if (Array.isArray(data.challenges) && data.challenges.length > 0) {
              window._duoChallenges = data.challenges;
              window._answeredChallengeIds.clear();
              Log.info(`API üzerinden ${data.challenges.length} soru havuzu yüklendi.`);
            }
          }
        }).catch(() => {});
      }
    } catch (e) {}
    return response;
  };

  // 2.1 Arka Planda API ile Pratik Yapıp Can Doldurma
  let isRefillingHearts = false;
  async function refillHeartsBackground(targetHearts = 5) {
    if (isRefillingHearts) return false;
    isRefillingHearts = true;
    setStatus('💖 Arka planda pratikle can dolduruluyor (API)...', '#9c27b0');
    Log.req(`Can 1 kaldı! Arka plan GLOBAL_PRACTICE API'si ile ${targetHearts} cana kadar dolduruluyor...`);

    try {
      const authHeader = getJwtToken();
      const fromLang = window._currentSessionMeta?.fromLanguage || 'tr';
      const learnLang = window._currentSessionMeta?.learningLanguage || 'en';

      const reqHeaders = {
        'Content-Type': 'application/json; charset=UTF-8',
        'Accept': 'application/json; charset=UTF-8'
      };
      if (authHeader) reqHeaders['Authorization'] = authHeader;

      let current = getHeartsCount() || 1;
      let addedCount = 0;

      while (current < targetHearts && addedCount < 5) {
        Log.info(`[API Practice] Oturum başlatılıyor (${current}/${targetHearts})...`);

        const sessionRes = await rawFetch('https://www.duolingo.com/2017-06-30/sessions', {
          method: 'POST',
          headers: reqHeaders,
          credentials: 'include',
          body: JSON.stringify({
            challengeTypes: [
              "translate", "judge", "select", "name", "form", "gapFill", "tapCloze"
            ],
            disableListening: true,
            disableSpeaking: true,
            fromLanguage: fromLang,
            learningLanguage: learnLang,
            isFeedbackUpdateEnabled: true,
            isFinalLevel: false,
            isV2: true,
            juicy: true,
            smartStreakCohort: "ACTIVE",
            type: "GLOBAL_PRACTICE"
          })
        });

        if (!sessionRes.ok) {
          Log.err(`[API Practice] Oturum başlatılamadı: HTTP ${sessionRes.status}`);
          break;
        }

        const pSession = await sessionRes.json();
        if (!pSession || !pSession.id) {
          Log.err('[API Practice] Oturum ID bulunamadı.');
          break;
        }

        await sleep(1000); // Gerçekçi gecikme

        const now = Math.floor(Date.now() / 1000);
        const challenges = pSession.challenges || [];
        const challengeTimes = {};
        challenges.forEach(c => { if (c.id) challengeTimes[c.id] = 2; });

        const putRes = await rawFetch(`https://www.duolingo.com/2017-06-30/sessions/${pSession.id}`, {
          method: 'PUT',
          headers: {
            ...reqHeaders,
            'Idempotency-Key': pSession.id
          },
          credentials: 'include',
          body: JSON.stringify({
            ...pSession,
            heartsLeft: 5,
            startTime: now - 35,
            endTime: now,
            failed: false,
            maxInLessonStreak: challenges.length,
            shouldLearnGems: true,
            hasBoost: true,
            xpGain: 15,
            challengeTimes
          })
        });

        if (!putRes.ok) {
          Log.err(`[API Practice] Oturum onaylanamadı: HTTP ${putRes.status}`);
          break;
        }

        addedCount++;
        current++;
        Log.ok(`[API Practice] ✅ +1 Can kazanıldı! (Toplam: ${current})`);
        setStatus(`💖 Can doluyor: ${current}/${targetHearts}`);
        await sleep(700);
      }

      if (addedCount > 0) {
        const heartEl = document.querySelector('[data-test="hearts-counter"], [data-test="hearts"], [data-test*="heart-count"]');
        if (heartEl) {
          const textNode = Array.from(heartEl.childNodes).find(n => n.nodeType === Node.TEXT_NODE && n.nodeValue.trim());
          if (textNode) textNode.nodeValue = String(current);
          else heartEl.innerText = String(current);
        }
        Log.ok(`🎉 Arka plan pratik tamamlandı! Toplam +${addedCount} can eklendi.`);
        setStatus('✅ Canlar dolduruldu! Derse devam ediliyor 🚀');
        await sleep(800);
        return true;
      }
    } catch (err) {
      Log.err('Arka plan can doldurma hatası', err);
    } finally {
      isRefillingHearts = false;
    }

    return false;
  }

  // 3. UI Paneli & Kalıcı Durum
  function createUI() {
    if (document.getElementById('duo-v11-panel')) return;
    if (!document.body) return;

    const panel = document.createElement('div');
    panel.id = 'duo-v11-panel';
    panel.style.cssText = `
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 999999;
      background: #e5e5e5;
      color: #777;
      padding: 12px 20px;
      border-radius: 16px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.25);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 10px;
      cursor: pointer;
      user-select: none;
      transition: all 0.2s ease;
      font-size: 14px;
    `;

    panel.innerHTML = `
      <span style="font-size: 18px;">⚡</span>
      <span id="duo-v11-text">Ders Çözücü v11: ${isAutoRunning ? 'AÇIK 🚀' : 'KAPALI ⏸️'}</span>
    `;

    panel.addEventListener('click', () => {
      isAutoRunning = !isAutoRunning;
      try {
        localStorage.setItem('duo_bot_autorun', String(isAutoRunning));
      } catch (e) {}
      updateUI();
    });

    document.body.appendChild(panel);
    updateUI();
  }

  function setStatus(text, bg = null) {
    const textEl = document.getElementById('duo-v11-text');
    const panel = document.getElementById('duo-v11-panel');
    if (textEl) textEl.innerText = text;
    if (panel && bg) panel.style.background = bg;
  }

  function updateUI() {
    const panel = document.getElementById('duo-v11-panel');
    if (!panel) return;

    if (isAutoRunning) {
      panel.style.background = '#58cc02';
      panel.style.color = '#fff';
      setStatus('Ders Çözücü v11: AÇIK 🚀');
      if (!mainLoopInterval) mainLoopInterval = setInterval(autoLoopStep, 700);
    } else {
      panel.style.background = '#e5e5e5';
      panel.style.color = '#777';
      setStatus('Ders Çözücü v11: KAPALI ⏸️');
      if (mainLoopInterval) {
        clearInterval(mainLoopInterval);
        mainLoopInterval = null;
      }
    }
  }

  // 4. Soru Bağlamını ve Tipini Hassas Çıkarma
  function extractExerciseContext() {
    const challenge = document.querySelector('[data-test*="challenge"]');
    if (!challenge) return { header: '', prompt: '', fullText: '' };

    const headerEl = challenge.querySelector('[data-test="challenge-header"], h1, [data-test="challenge-title"]');
    const header = headerEl ? headerEl.innerText.trim() : '';

    const promptSelectors = [
      '[data-test="challenge-translate-prompt"]',
      '[data-test="hint-sentence"]',
      '[data-test="challenge-form-prompt"]',
      '[data-test="challenge-partial-sentence"]',
      '[data-prompt]',
      '[class*="prompt"]',
      '[class*="sentence"]'
    ];

    let sentence = '';
    for (const sel of promptSelectors) {
      const el = challenge.querySelector(sel);
      if (el && el !== headerEl) {
        sentence = el.innerText.replace(/\s+/g, ' ').trim();
        if (sentence && sentence !== header) break;
      }
    }

    if (!sentence) {
      const clone = challenge.cloneNode(true);
      const toRemove = clone.querySelectorAll('h1, [data-test="challenge-header"], [data-test="word-bank"], [data-test="challenge-choice"], button, footer');
      toRemove.forEach(el => el.remove());
      sentence = clone.innerText.replace(/\s+/g, ' ').slice(0, 200).trim();
    }

    return {
      header,
      prompt: sentence || header,
      fullText: (challenge.innerText || '').replace(/\s+/g, ' ').slice(0, 250).trim()
    };
  }

  // 5. Yerel Fiber Verisi Arama (0ms doğruluk)
  function getFiberChallenge() {
    const roots = [
      document.querySelector('[data-test*="challenge"]'),
      document.querySelector('textarea[data-test="challenge-translate-input"]'),
      document.querySelector('input[data-test="challenge-text-input"]'),
      document.querySelector('[data-test="word-bank"]'),
      document.querySelector('main')
    ].filter(Boolean);

    for (const el of roots) {
      const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
      if (!fiberKey) continue;

      let fiber = el[fiberKey];
      let depth = 0;
      while (fiber && depth < 40) {
        const c = fiber.memoizedProps?.challenge || fiber.memoizedProps?.currentChallenge || fiber.stateNode?.props?.challenge || fiber.stateNode?.props?.currentChallenge;
        if (c && (c.correctSolutions || c.displayTokens || c.correctTokens || c.correctIndices)) {
          return c;
        }
        fiber = fiber.return;
        depth++;
      }
    }
    return null;
  }

  // 6. Akıllı Çözüm Motoru
  async function solveWithAI() {
    const challengeContainer = document.querySelector('[data-test*="challenge"]');
    if (!challengeContainer) return false;

    const { header, prompt: promptText, fullText } = extractExerciseContext();
    const fiberChallenge = getFiberChallenge();
    Log.info('Soru Algılandı:', { Başlık: header, Cümle: promptText });

    // =========================================================================
    // DURUM 1: METİN YAZMA KUTULARI (Textarea / Input)
    // =========================================================================
    const textInput = document.querySelector('textarea[data-test="challenge-translate-input"], input[data-test="challenge-text-input"]');
    if (textInput) {
      let finalAnswer = '';

      // A) Yerel Fiber'da varsa (0ms)
      if (fiberChallenge) {
        if (Array.isArray(fiberChallenge.displayTokens)) {
          const blank = fiberChallenge.displayTokens.find(t => t.isBlank);
          if (blank && blank.text) finalAnswer = blank.text;
        }
        if (!finalAnswer && Array.isArray(fiberChallenge.correctSolutions) && fiberChallenge.correctSolutions.length > 0) {
          const sol = fiberChallenge.correctSolutions[0].trim();
          if (sol.toLowerCase() !== promptText.toLowerCase()) finalAnswer = sol;
        }
      }

      // B) Yerel yoksa Akıllı Gemini Flash Sınıflandırması
      if (!finalAnswer) {
        const isMissingWord = header.toLowerCase().includes('eksik') || header.toLowerCase().includes('missing') || fullText.includes('____') || fullText.includes('Tom washes the windows every _');
        const quoteMatch = (header + ' ' + promptText).match(/["'“]([^"'”]+)["'”]/);

        if (isMissingWord) {
          Log.info('Soru Tipi: ✍️ Eksik Sözcüğü Yazma (Tek Kelime)');
          setStatus('🧠 Gemini eksik kelimeyi buluyor...');
          try {
            finalAnswer = await queryAI(
              'Duolingo soru çözücüsün. Cümledeki boşluğa veya eksik yere gelecek EKSİK KELİMEYİ yaz. ASLA tüm cümleyi yazma. SADECE eksik olan tek bir kelimeyi yaz. Örnek: month',
              `Cümle: "${fullText}"`
            );
          } catch (e) {
            Log.err('AI Hatası', e);
          }
        } else if (quoteMatch && quoteMatch[1]) {
          const targetWord = quoteMatch[1].trim();
          Log.info(`Soru Tipi: 🔤 Kelime Karşılığı Yazma -> "${targetWord}"`);
          setStatus(`🧠 Gemini "${targetWord}" çeviriyor...`);
          try {
            finalAnswer = await queryAI(
              'Duolingo kelime çözücüsün. İstenen kelimenin doğrudan İngilizce (veya Türkçe) karşılığını tek kelime olarak yaz. Asla açıklama yapma veya talimatı çevirme.',
              `Kelime: "${targetWord}"`
            );
          } catch (e) {
            Log.err('AI Hatası', e);
          }
        } else {
          Log.info('Soru Tipi: 📝 Tam Cümle Çevirisi');
          setStatus('🧠 Gemini cümleyi çeviriyor...');
          try {
            finalAnswer = await queryAI(
              'Duolingo çeviri motorusun. Verilen cümleyi hedef dile (İngilizceye veya Türkçeye) çevir. Sadece çeviri cümlesini yaz. Varsa cümlenin sonundaki nokta (.) işaretini kesinlikle koru. Asla açıklama yapma.',
              `Cümle: "${promptText}"`
            );
          } catch (e) {
            Log.err('AI Hatası', e);
          }
        }
      }

      if (finalAnswer) {
        Log.ok(`Kutuya yazılıyor -> "${finalAnswer}"`);
        setStatus(`Yazıldı: ${finalAnswer.slice(0, 20)}...`);
        textInput.focus();

        const proto = textInput instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        setter ? setter.call(textInput, finalAnswer) : (textInput.value = finalAnswer);

        textInput.dispatchEvent(new Event('input', { bubbles: true }));
        textInput.dispatchEvent(new Event('change', { bubbles: true }));
        textInput.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));
        await sleep(350);
        return true;
      }
    }

    // =========================================================================
    // DURUM 2: ÇOKTAN SEÇMELİ (Choice / Judge)
    // =========================================================================
    const choiceButtons = Array.from(document.querySelectorAll('button[data-test="challenge-choice"], div[data-test="challenge-choice"]'));
    if (choiceButtons.length > 0) {
      const cleanChoices = choiceButtons.map(btn => {
        const textNode = btn.querySelector('[data-test="challenge-judge-text"]') || btn;
        return textNode.innerText.replace(/^\d+\s*/, '').trim();
      }).filter(Boolean);

      Log.info('Soru Tipi: 🔘 Çoktan Seçmeli', cleanChoices);
      setStatus('🧠 Gemini şıkkı seçiyor...');

      let pickedText = '';
      try {
        pickedText = await queryAI(
          'Duolingo çoktan seçmeli çözücüsün. Cümleye/soruya göre doğru olan seçeneği listeden seç. SADECE doğru seçeneğin metnini yaz. ASLA açıklama veya numara yazma.',
          `Soru / Cümle: "${promptText}"\nSeçenekler:\n${cleanChoices.map((t, i) => `${i + 1}) ${t}`).join('\n')}`
        );
      } catch (err) {
        Log.err('AI Çoktan Seçmeli Hatası', err);
      }

      if (pickedText) {
        const cleanPicked = pickedText.trim().toLowerCase().replace(/[.,!?:;]/g, '');
        let targetIdx = cleanChoices.findIndex(t => t.toLowerCase().replace(/[.,!?:;]/g, '') === cleanPicked);
        if (targetIdx === -1) {
          targetIdx = cleanChoices.findIndex(t => t.toLowerCase().includes(cleanPicked) || cleanPicked.includes(t.toLowerCase()));
        }

        if (targetIdx >= 0 && choiceButtons[targetIdx]) {
          Log.ok(`Şık işaretlendi [${targetIdx + 1}] -> "${cleanChoices[targetIdx]}"`);
          setStatus(`Şık seçildi: ${cleanChoices[targetIdx].slice(0, 15)}...`);
          choiceButtons[targetIdx].click();
          await sleep(250);
          return true;
        }
      }
    }

    // =========================================================================
    // DURUM 3: BOŞLUK DOLDURMA (tapCloze) & KELİME BANKASI (Noktalama Destekli)
    // =========================================================================
    const tapTokens = Array.from(document.querySelectorAll('[data-test$="challenge-tap-token"]')).filter(el => {
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
      const dt = el.getAttribute('data-test') || '';
      return !dt.includes('player-next') && !dt.includes('player-skip');
    });

    if (tapTokens.length > 0) {
      const availableWords = tapTokens.map(t => {
        const textEl = t.querySelector('[data-test="challenge-tap-token-text"]') || t;
        return textEl.innerText.trim();
      }).filter(Boolean);

      const isSingleBlank = header.toLowerCase().includes('boşluğ') || header.toLowerCase().includes('blank') || fullText.includes('____');

      if (isSingleBlank && availableWords.length <= 6) {
        Log.info('Soru Tipi: 🧩 4\'lü Boşluk Doldurma', { Cümle: promptText, Seçenekler: availableWords });
        setStatus('🧠 Gemini boşluğu dolduruyor...');

        let bestWord = '';
        try {
          bestWord = await queryAI(
            'Duolingo boşluk doldurma çözücüsün. Cümledeki boşluğa uygun olan kelimeyi SEÇENEKLERDEN seç. SADECE seçtiğin tek kelimeyi yaz. Asla açıklama yapma.',
            `Eksik Cümle: "${promptText}"\nSeçenekler: ${availableWords.join(', ')}`
          );
        } catch (err) {
          Log.err('AI Boşluk Hatası', err);
        }

        if (bestWord) {
          const cleanBest = normalizeToken(bestWord);
          const targetBtn = tapTokens.find(el => {
            const txt = ((el.querySelector('[data-test="challenge-tap-token-text"]') || el).innerText || '').trim();
            return normalizeToken(txt) === cleanBest || txt.toLowerCase() === bestWord.trim().toLowerCase();
          });

          if (targetBtn) {
            Log.ok(`Boşluk seçeneği tıklandı -> "${cleanBest}"`);
            setStatus(`Seçildi: ${cleanBest}`);
            targetBtn.click();
            await sleep(250);
            return true;
          }
        }
      } else {
        Log.info('Soru Tipi: 🔤 Kelime Bankası Cümle Dizme', { Soru: promptText, Kelimeler: availableWords });

        // Önce Fiber kontrolü (0ms kesin çözüm)
        if (fiberChallenge && Array.isArray(fiberChallenge.correctTokens) && fiberChallenge.correctTokens.length > 0) {
          Log.ok('Fiber correctTokens bulundu, doğrudan tıklanıyor:', fiberChallenge.correctTokens);
          setStatus(`Fiber kelimeleri diziyor (${fiberChallenge.correctTokens.length})...`);
          let clickCount = 0;

          for (const token of fiberChallenge.correctTokens) {
            const cleanTarget = normalizeToken(token);
            const currentTokens = Array.from(document.querySelectorAll('[data-test="word-bank"] [data-test$="challenge-tap-token"], [data-test$="challenge-tap-token"]'));
            const match = currentTokens.find(t => {
              if (t.disabled || t.getAttribute('aria-disabled') === 'true') return false;
              const rawTxt = (t.querySelector('[data-test="challenge-tap-token-text"]') || t).innerText.trim();
              return normalizeToken(rawTxt) === cleanTarget || rawTxt.toLowerCase() === token.trim().toLowerCase();
            });

            if (match) {
              match.click();
              clickCount++;
              await sleep(140);
            }
          }

          if (clickCount > 0) {
            await sleep(250);
            return true;
          }
        }

        // AI Fallback (Noktalama korumalı)
        setStatus('🧠 Gemini kelimeleri diziyor...');
        const hasPunctuationToken = availableWords.some(w => /^[.,!?:;]+$/.test(w.trim()));
        const punctInstruction = hasPunctuationToken ? ' DİKKAT: Seçeneklerde nokta (.) veya noktalama taşları var. Gerekliyse cümlenin sonundaki noktayı da sıraya ayrı bir kelime olarak ekle.' : '';

        let tokenOrderStr = '';
        try {
          tokenOrderStr = await queryAI(
            `Duolingo kelime bankası çözücüsün. Cümleyi verilen kelimeleri kullanarak hedef dile doğru çevir. SADECE kullanılacak kelimeleri sırasıyla virgülle ayırarak yaz.${punctInstruction} Örnek: We, wash, the, dog, .`,
            `Cümle: "${promptText}"\nKullanılabilir seçenekler: [${availableWords.join(', ')}]`
          );
        } catch (err) {
          Log.err('AI Kelime Dizme Hatası', err);
        }

        if (tokenOrderStr) {
          const rawParts = tokenOrderStr.split(',').map(s => s.trim()).filter(Boolean);
          const tokensToClick = [];

          for (const part of rawParts) {
            const punctMatch = part.match(/^(.*?)([.,!?:;]+)$/);
            if (punctMatch && punctMatch[1] && hasPunctuationToken) {
              tokensToClick.push(normalizeToken(punctMatch[1]));
              tokensToClick.push(normalizeToken(punctMatch[2]));
            } else {
              tokensToClick.push(normalizeToken(part));
            }
          }

          Log.ok(`Sıralanacak Taşlar: [${tokensToClick.join(', ')}]`);
          setStatus(`Kelimeler diziliyor (${tokensToClick.length})...`);
          let clickCount = 0;

          for (const targetClean of tokensToClick) {
            if (!targetClean) continue;
            const currentTokens = Array.from(document.querySelectorAll('[data-test="word-bank"] [data-test$="challenge-tap-token"], [data-test$="challenge-tap-token"]'));
            const match = currentTokens.find(t => {
              if (t.disabled || t.getAttribute('aria-disabled') === 'true') return false;
              const rawTxt = (t.querySelector('[data-test="challenge-tap-token-text"]') || t).innerText.trim();
              return normalizeToken(rawTxt) === targetClean || rawTxt.toLowerCase() === targetClean;
            });

            if (match) {
              match.click();
              clickCount++;
              await sleep(140);
            }
          }

          if (clickCount > 0) {
            await sleep(250);
            return true;
          }
        }
      }
    }

    return false;
  }

  // 7. Ana Karar Döngüsü
  async function autoLoopStep() {
    if (!isAutoRunning || isBusy) return;
    isBusy = true;

    try {
      // =========================================================================
      // KRİTİK KONTROL: CAN (HEARTS) KORUMASI & OTOMATİK PRATİK
      // =========================================================================
      const hearts = getHeartsCount();
      const challengeContainer = document.querySelector('[data-test*="challenge"]');

      if (hearts !== null && hearts <= 1 && hearts !== Infinity && challengeContainer) {
        Log.warn(`🛑 Can kritik seviyede: ${hearts}! Arka planda pratikle can dolduruluyor...`);
        const refilled = await refillHeartsBackground(5);
        if (!refilled) {
          Log.warn('Arka plan can doldurma başarısız oldu. Güvenlik için durduruldu.');
          isAutoRunning = false;
          try { localStorage.setItem('duo_bot_autorun', 'false'); } catch (e) {}
          updateUI();
          setStatus(`⚠️ CAN KRİTİK (${hearts} KALDI) - SENDE! 🛑`, '#b71c1c');
          return;
        }
      }

      const nextBtn = document.querySelector('button[data-test="player-next"]');
      const btnText = nextBtn ? (nextBtn.innerText || '').trim().toUpperCase() : '';

      // 1. Değerlendirme Banner'ı ("DEVAM ET" / "CONTINUE")
      const isContinueButton = ['DEVAM ET', 'CONTINUE', 'SONRAKİ', 'NEXT', 'ANLADIM', 'TAMAM', 'BİTİR'].some(word => btnText.includes(word));
      const blameBanner = document.querySelector('[data-test*="blame"], [data-test="player-end-carousel"]');

      if ((isContinueButton || blameBanner) && nextBtn && !nextBtn.disabled) {
        Log.info('⏭️ "Devam Et" butonuna basılıyor...');
        setStatus('İlerleniyor ⏭️');
        nextBtn.click();
        stuckCounter = 0;
        await sleep(500);
        return;
      }

      // 2. Yalnızca Dinleme/Konuşma Sorularını Atla
      const audioChallenge = document.querySelector('[data-test*="challenge-listen"], [data-test*="challenge-speak"]');
      if (audioChallenge) {
        const skipBtn = document.querySelector('button[data-test="player-skip"]');
        if (skipBtn) {
          Log.info('🔇 Dinleme/Konuşma sorusu atlanıyor...');
          setStatus('Ses sorusu atlandı ⏩');
          skipBtn.click();
          await sleep(500);
          return;
        }
      }

      // 3. Ekranda Aktif Soru Var mı? -> Akıllı Motor Çözsün
      if (challengeContainer) {
        const currentPrompt = (challengeContainer.innerText || '').slice(0, 50);
        if (currentPrompt === lastPrompt) {
          stuckCounter++;
        } else {
          lastPrompt = currentPrompt;
          stuckCounter = 0;
        }

        const solved = await solveWithAI();

        if (solved) {
          await sleep(300);
          const btn = document.querySelector('button[data-test="player-next"]');
          const isClickable = btn && (btn.getAttribute('aria-disabled') === 'false' && !btn.disabled);

          if (isClickable) {
            Log.ok('Kontrol Et (Submit) butonuna basılıyor.');
            setStatus('Cevap kontrol ediliyor ✅');
            btn.click();
            stuckCounter = 0;
            await sleep(600);
          }
        } else {
          setStatus('Soru analiz ediliyor... (' + stuckCounter + ')');
        }

        if (stuckCounter >= 6) {
          const activeNext = document.querySelector('button[data-test="player-next"]');
          if (activeNext && (activeNext.getAttribute('aria-disabled') === 'false' && !activeNext.disabled)) {
            Log.warn('Donma koruması: Buton zorlandı.');
            activeNext.click();
            stuckCounter = 0;
            await sleep(600);
          }
        }
        return;
      }

      // 4. Ara Ekranlar (Hikaye, yüklenme, ders sonu ara düğmeleri)
      if (nextBtn && (nextBtn.getAttribute('aria-disabled') === 'false' || !nextBtn.disabled)) {
        nextBtn.click();
        await sleep(500);
        return;
      }

      // 5. Haritada (Learn) ise: Canı kontrol et, gerekirse doldur ve derse otomatik gir
      if (window.location.pathname.includes('/learn')) {
        const mapHearts = getHeartsCount();
        if (mapHearts !== null && mapHearts <= 2 && mapHearts !== Infinity) {
          Log.info(`[Harita] Can az (${mapHearts}). Derse girmeden önce dolduruluyor...`);
          await refillHeartsBackground(5);
        }

        // A) Açık baloncukta "BAŞLAT" butonu var mı?
        const startBtnSelectors = [
          'a[data-test="start-button"]',
          'button[data-test="start-button"]',
          '[data-test="lesson-button"]',
          '[data-test="floating-button"]',
          '[data-test="unit-challenge-button"]',
          '[data-test="practice-hub-start-button"]',
          'a[href*="/lesson"]'
        ];

        let startBtn = null;
        for (const sel of startBtnSelectors) {
          const el = document.querySelector(sel);
          if (el && !el.disabled && el.getAttribute('aria-disabled') !== 'true') {
            startBtn = el;
            break;
          }
        }

        if (startBtn) {
          Log.ok('🎯 Haritada BAŞLAT butonuna basılıyor...');
          setStatus('Derse giriliyor 🚀');
          startBtn.click();
          await sleep(1200);
          return;
        }

        // B) Açık baloncuk yoksa: Aktif patika düğümüne tıkla ki baloncuk açılsın
        const activeNodeSelectors = [
          '[data-test="active-node"]',
          '[class*="active"] [role="button"]',
          '[data-test*="path-level"][class*="current"]',
          '[data-test*="path-unit"] button[tabindex="0"]'
        ];

        for (const sel of activeNodeSelectors) {
          const node = document.querySelector(sel);
          if (node) {
            Log.info('📍 Aktif düğüme tıklanıyor...');
            node.click();
            await sleep(600);
            break;
          }
        }
      }
    } catch (err) {
      Log.err('Döngü Hatası', err);
    } finally {
      isBusy = false;
    }
  }

  setInterval(createUI, 1000);
})();
