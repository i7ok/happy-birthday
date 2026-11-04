(() => {
  'use strict';

  const D = window.GAME_DATA;
  const T = D.texts;

  // The stage is the hallway picture (880x1787); positions below are fractions of it.
  const BG_W = 880;
  const BG_H = 1787;
  const HORIZON = 0.374; // eye level of the picture: the farther a person stands, the closer their feet are to it
  const FRONT_Y = 0.8; // feet of the first person in the queue
  const ADULT_PX = 880; // sprite height (px) of a standing adult; sprites keep their relative sizes
  const ADULT_FRONT = 1.1 * (FRONT_Y - HORIZON); // adult height at the front, fraction of stage height
  // Queue spots, front first: x = centre, y = feet. Size follows from y (perspective).
  const SPOTS = [
    { x: 0.52, y: FRONT_Y },
    { x: 0.25, y: 0.7 },
    { x: 0.82, y: 0.655 },
    { x: 0.37, y: 0.59 },
    { x: 0.47, y: 0.553 },
    { x: 0.53, y: 0.515 },
  ];
  const VISIBLE = SPOTS.length;
  const ASSETS = 'assets/characters/';
  const AGE_RE = /_(-18|\+18|RND)\.(png|webp|jpe?g)$/i;
  const TYPE_MS = 28;
  const REVEAL_MS = 1500;
  const WALK_MS = 750;

  const $ = (id) => document.getElementById(id);
  const app = $('app');
  const stage = $('stage');
  const queueEl = $('queue');
  const hud = $('hud');
  const bubble = $('bubble');
  const bubbleText = $('bubble-text');
  const verdict = $('verdict');
  const btnMinus = $('btn-minus');
  const btnPlus = $('btn-plus');
  const progressEl = $('progress');
  const scoreEl = $('score');
  const startScreen = $('screen-start');
  const endScreen = $('screen-end');
  const btnStart = $('btn-start');
  const btnAgain = $('btn-again');

  let L = null; // stage layout inside #app, px
  let queue = []; // people still in the queue, front first
  let total = 0;
  let done = 0;
  let score = 0;
  let accepting = false;
  let exitSide = 1;
  let typing = null;
  let fullText = '';

  // ---------- helpers ----------
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const shownAge = (age) => (age === '-18' ? '−18' : '+18');

  function ageOf(file) {
    const m = AGE_RE.exec(file);
    if (!m) throw new Error('В имени файла нет _-18, _+18 или _RND: ' + file);
    return m[1].toUpperCase();
  }

  function shuffle(list) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  }

  const images = new Map();
  function load(file) {
    if (!images.has(file)) {
      images.set(file, new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Не загрузилась картинка: ' + file));
        img.src = ASSETS + encodeURIComponent(file);
      }));
    }
    return images.get(file);
  }

  function buildQueue() {
    const phrases = shuffle(D.phrases.slice());
    let next = 0;
    const phrase = () => {
      if (next >= phrases.length) {
        shuffle(phrases);
        next = 0;
      }
      return phrases[next++];
    };
    const people = D.intro
      .map((c) => ({ file: c.file, phrase: c.phrase }))
      .concat(shuffle(D.characters.slice()).map((file) => ({ file, phrase: phrase() })));
    return people.map((p) => {
      const age = ageOf(p.file);
      // RND: the answer is decided per game, so guessing it is a coin toss
      const actual = age === 'RND' ? (Math.random() < 0.5 ? '-18' : '+18') : age;
      return Object.assign(p, { age, actual, el: null, loading: false });
    });
  }

  // ---------- layout ----------
  function computeLayout() {
    const w = app.clientWidth;
    const h = app.clientHeight;
    const k = Math.max(w / BG_W, h / BG_H); // cover, anchored to the bottom (feet stay visible)
    const sw = BG_W * k;
    const sh = BG_H * k;
    L = { w, h, sw, sh, left: (w - sw) / 2, top: h - sh };
    stage.style.width = sw + 'px';
    stage.style.height = sh + 'px';
    stage.style.transform = `translate(${L.left}px, ${L.top}px)`;
  }

  function spotScale(i) {
    const s = SPOTS[Math.min(i, VISIBLE - 1)];
    return (s.y - HORIZON) / (FRONT_Y - HORIZON);
  }

  function size(p) {
    p.h = ADULT_FRONT * L.sh * (p.nh / ADULT_PX);
    p.w = p.h * (p.nw / p.nh);
    p.el.style.width = p.w + 'px';
    p.el.style.height = p.h + 'px';
  }

  function place(p, i) {
    const s = SPOTS[Math.min(i, VISIBLE - 1)];
    const x = s.x * L.sw - p.w / 2;
    const y = s.y * L.sh - p.h;
    p.el.style.transform = `translate(${x}px, ${y}px) scale(${spotScale(i)})`;
    p.el.style.zIndex = String(100 - i);
    p.el.dataset.spot = String(i);
  }

  function relayout() {
    computeLayout();
    queueEl.classList.add('no-anim');
    queue.forEach((p, i) => {
      if (p.el) {
        size(p);
        place(p, i);
      }
    });
    queueEl.getBoundingClientRect();
    queueEl.classList.remove('no-anim');
    if (bubble.classList.contains('show') && queue[0] && queue[0].el) positionBubble(queue[0]);
  }

  // ---------- queue ----------
  async function spawn(p, fadeIn) {
    const img = await load(p.file);
    p.nw = img.naturalWidth;
    p.nh = img.naturalHeight;
    const el = document.createElement('div');
    el.className = 'person';
    const im = document.createElement('img');
    im.src = img.src;
    im.alt = '';
    im.draggable = false;
    el.appendChild(im);
    p.el = el;
    size(p);
    if (fadeIn) {
      el.style.transition = 'none';
      el.style.opacity = '0';
    }
    place(p, queue.indexOf(p)); // the queue may have moved while the image was loading
    queueEl.appendChild(el);
    if (fadeIn) {
      el.getBoundingClientRect();
      el.style.transition = '';
      el.style.opacity = '1';
    }
  }

  async function fillQueue(fadeIn) {
    for (let i = 0; i < Math.min(VISIBLE, queue.length); i++) {
      const p = queue[i];
      if (p.el || p.loading) continue;
      p.loading = true;
      try {
        await spawn(p, fadeIn);
      } catch (err) {
        console.error(err);
        queue.splice(queue.indexOf(p), 1);
        total--;
        i--;
      }
    }
  }

  // ---------- speech bubble ----------
  function positionBubble(p) {
    const s = SPOTS[0];
    const headX = L.left + s.x * L.sw;
    const headY = L.top + s.y * L.sh - p.h; // top of the sprite in #app px
    bubble.style.left = '0px'; // measure at full available width
    const bw = bubble.offsetWidth;
    const bh = bubble.offsetHeight;
    const minTop = hud.offsetTop + hud.offsetHeight + 10;
    const left = Math.min(Math.max(headX - bw / 2, 12), L.w - bw - 12);
    const top = Math.max(headY - bh - 22, minTop);
    bubble.style.left = left + 'px';
    bubble.style.top = top + 'px';
    bubble.style.setProperty('--tail-x', Math.min(Math.max(headX - left, 26), bw - 26) + 'px');
  }

  function say(p) {
    clearInterval(typing);
    fullText = p.phrase;
    const typed = document.createElement('span');
    const rest = document.createElement('span');
    rest.className = 'rest';
    rest.textContent = fullText;
    bubbleText.replaceChildren(typed, rest);
    positionBubble(p);
    bubble.classList.add('show');
    let n = 0;
    typing = setInterval(() => {
      n++;
      typed.textContent = fullText.slice(0, n);
      rest.textContent = fullText.slice(n);
      if (n >= fullText.length) clearInterval(typing);
    }, TYPE_MS);
  }

  function finishTyping() {
    clearInterval(typing);
    bubbleText.textContent = fullText;
  }

  function hideBubble() {
    clearInterval(typing);
    bubble.classList.remove('show');
  }

  // ---------- game flow ----------
  function setAccepting(on) {
    accepting = on;
    btnMinus.disabled = !on;
    btnPlus.disabled = !on;
  }

  async function present() {
    if (!queue.length) return finish();
    if (!queue[0].el) await fillQueue(false);
    const p = queue[0];
    if (!p) return finish();
    progressEl.textContent = `${done + 1} / ${total}`;
    say(p);
    await wait(250);
    setAccepting(true);
  }

  async function answer(guess, btn, tapped) {
    if (!accepting) return;
    setAccepting(false);
    const p = queue[0];
    const ok = guess === p.actual;
    done++;
    if (ok) score++;
    scoreEl.textContent = '✓ ' + score;
    btn.classList.add('picked');
    finishTyping();

    const stamp = document.createElement('div');
    stamp.className = 'stamp ' + (p.actual === '-18' ? 'minus' : 'plus');
    stamp.textContent = shownAge(p.actual);
    p.el.appendChild(stamp);
    verdict.textContent = ok ? T.right : T.wrong;
    verdict.className = (ok ? 'good' : 'bad') + ' show';
    if (tapped && navigator.vibrate) navigator.vibrate(ok ? 30 : [40, 60, 40]);

    await wait(REVEAL_MS);
    btn.classList.remove('picked');
    verdict.className = '';
    hideBubble();
    await advance();
  }

  async function advance() {
    const leaving = queue.shift();
    const s = SPOTS[0];
    const x = s.x * L.sw - leaving.w / 2 + exitSide * L.w * 0.9;
    const y = s.y * L.sh - leaving.h + L.sh * 0.04;
    leaving.el.classList.add('walking');
    leaving.el.style.transform = `translate(${x}px, ${y}px) scale(1.12)`;
    leaving.el.style.opacity = '0';
    exitSide = -exitSide;
    setTimeout(() => leaving.el.remove(), 900);

    queue.forEach((p, i) => {
      if (!p.el) return;
      p.el.classList.add('walking');
      place(p, i);
    });
    fillQueue(true);
    await wait(WALK_MS);
    queue.forEach((p) => p.el && p.el.classList.remove('walking'));
    present();
  }

  function finish() {
    setAccepting(false);
    hideBubble();
    progressEl.textContent = `${total} / ${total}`;
    $('result').textContent = T.result.replace('{score}', score).replace('{total}', total);
    const share = total ? score / total : 0;
    const rating = T.ratings.find(([min]) => share >= min);
    $('rating').textContent = rating ? rating[1] : '';
    makeConfetti();
    endScreen.classList.remove('hidden');
  }

  function makeConfetti() {
    const box = $('confetti');
    if (box.childElementCount) return;
    const colors = ['#ff4f8b', '#3d7bff', '#ffcc33', '#2fd06b', '#a259ff', '#ff8a3d'];
    for (let i = 0; i < 70; i++) {
      const c = document.createElement('i');
      c.style.left = Math.random() * 100 + '%';
      c.style.background = colors[i % colors.length];
      c.style.animationDuration = 2.6 + Math.random() * 2.4 + 's';
      c.style.animationDelay = -Math.random() * 5 + 's';
      c.style.setProperty('--drift', Math.random() * 80 - 40 + 'px');
      c.style.setProperty('--spin', Math.random() * 720 - 360 + 'deg');
      box.appendChild(c);
    }
  }

  function newGame() {
    queue = buildQueue();
    total = queue.length;
    done = 0;
    score = 0;
    exitSide = 1;
    scoreEl.textContent = '✓ 0';
    progressEl.textContent = '';
  }

  async function restart() {
    endScreen.classList.add('hidden');
    queueEl.replaceChildren();
    newGame();
    await fillQueue(false);
    present();
  }

  async function boot() {
    $('start-title').textContent = T.title;
    $('start-intro').textContent = T.intro;
    $('end-title').textContent = T.endTitle;
    btnAgain.textContent = T.again;
    computeLayout();
    newGame();

    const first = queue.slice(0, VISIBLE).map((p) => p.file);
    const need = first.length + 1;
    let ready = 0;
    const tick = () => {
      ready++;
      btnStart.textContent = `Загрузка… ${Math.round((100 * ready) / need)}%`;
    };
    const bg = $('bg');
    const bgReady = bg.complete && bg.naturalWidth
      ? Promise.resolve()
      : new Promise((resolve) => { bg.onload = resolve; bg.onerror = resolve; });
    await Promise.all([bgReady.then(tick), ...first.map((f) => load(f).then(tick, tick))]);
    await fillQueue(false);
    btnStart.textContent = T.start;
    btnStart.disabled = false;
    queue.forEach((p) => load(p.file).catch(() => {})); // warm up the rest
  }

  // ---------- input ----------
  btnStart.addEventListener('click', () => {
    startScreen.classList.add('hidden');
    present();
  });
  btnAgain.addEventListener('click', restart);
  btnMinus.addEventListener('click', () => answer('-18', btnMinus, true));
  btnPlus.addEventListener('click', () => answer('+18', btnPlus, true));
  document.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (e.key === 'ArrowLeft') answer('-18', btnMinus);
    else if (e.key === 'ArrowRight') answer('+18', btnPlus);
    else if (e.key === 'Enter') {
      if (!startScreen.classList.contains('hidden') && !btnStart.disabled) btnStart.click();
      else if (!endScreen.classList.contains('hidden')) btnAgain.click();
    }
  });
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(relayout, 80);
  });

  boot().catch((err) => {
    console.error(err);
    btnStart.textContent = 'Ошибка загрузки';
  });
})();
