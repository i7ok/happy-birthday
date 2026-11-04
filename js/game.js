(() => {
  'use strict';

  const D = window.GAME_DATA;
  const T = D.texts;

  // The stage is the hallway picture (880x1787); positions below are fractions of it.
  const BG_W = 880;
  const BG_H = 1787;
  const HORIZON = 0.374; // eye level of the picture: the farther a person stands, the closer their feet are to it
  const REF_Y = 0.8; // a person whose feet are at this height is drawn at scale 1
  const ADULT_PX = 880; // sprite height (px) of a standing adult; sprites keep their relative sizes
  const ADULT_H = 1.1 * (REF_Y - HORIZON); // adult height at scale 1, fraction of stage height
  const ZOOM = 1.3; // the stage is larger than the screen, so the camera can look up and down
  // Spots, x = centre, y = feet; size follows from y (perspective).
  // The speaker walks up close to the camera; the others wait in one straight line behind.
  const FRONT = { x: 0.6, y: 0.86 };
  const LINE_NEAR = { x: 0.24, y: 0.7 };
  const LINE_FAR = { x: 0.4, y: 0.535 };
  const WAITING = 5;
  const SPOTS = [FRONT].concat(lineSpots(LINE_NEAR, LINE_FAR, WAITING));
  const VISIBLE = SPOTS.length;
  // Brightness by spot: the farther back, the darker. Saturation drops a little with it.
  const SHADE = [1, 0.78, 0.72, 0.67, 0.62, 0.58];
  const BUBBLE_GAP = 24; // bubble bottom to the top of the speaker's head, px (the tail fits in here)
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
  const hint = $('hint');

  let L = null; // stage layout inside #app, px
  let queue = []; // people still in the queue, front first
  let total = 0;
  let done = 0;
  let score = 0;
  let accepting = false;
  let typing = null;
  let fullText = '';
  let typedEl = null;
  let restEl = null;
  let framed = null; // the person the bubble and the camera are set up for
  let cam = 0; // stage top inside #app, px; L.low = looking all the way down
  let camHome = 0; // where the camera rests for the current speaker
  let bubbleY = 0; // bubble top, stage px
  let panned = false; // the player has found out about swiping

  // ---------- helpers ----------
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const shownAge = (age) => (age === '-18' ? '−18' : '+18');

  function ageOf(file) {
    const m = AGE_RE.exec(file);
    if (!m) throw new Error('В имени файла нет _-18, _+18 или _RND: ' + file);
    return m[1].toUpperCase();
  }

  // Spots on a straight line on the floor, one equal step apart: depth grows evenly, scale = 1 / depth.
  function lineSpots(near, far, n) {
    const depth = (y) => (REF_Y - HORIZON) / (y - HORIZON);
    const d0 = depth(near.y);
    const d1 = depth(far.y);
    return Array.from({ length: n }, (_, i) => {
      const y = HORIZON + (REF_Y - HORIZON) / (d0 + ((d1 - d0) * i) / (n - 1));
      const t = (near.y - y) / (near.y - far.y);
      return { x: near.x + (far.x - near.x) * t, y };
    });
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
    // after the intro: everyone with a fixed age in random order, then all the RND ones, also shuffled
    const isRnd = (file) => ageOf(file) === 'RND';
    const order = shuffle(D.characters.filter((f) => !isRnd(f))).concat(shuffle(D.characters.filter(isRnd)));
    const people = D.intro
      .map((c) => ({ file: c.file, phrase: c.phrase }))
      .concat(order.map((file) => ({ file, phrase: phrase() })));
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
    const k = Math.max(w / BG_W, h / BG_H) * ZOOM;
    const sw = BG_W * k;
    const sh = BG_H * k;
    L = { w, h, sw, sh, left: (w - sw) / 2, low: h - sh };
    stage.style.width = sw + 'px';
    stage.style.height = sh + 'px';
  }

  // Vertical camera: moves the stage (and the bubble with it) between the floor and the ceiling.
  function setCamera(top) {
    const lo = L.low;
    const hi = Math.max(0, camHome); // a tall speaker may need a bit of ceiling above the picture
    cam = Math.min(Math.max(top, lo), hi);
    stage.style.transform = `translate(${L.left}px, ${cam}px)`;
    bubble.style.top = bubbleY + cam + 'px';
  }

  function spotScale(i) {
    const s = SPOTS[Math.min(i, VISIBLE - 1)];
    return (s.y - HORIZON) / (REF_Y - HORIZON);
  }

  function size(p) {
    p.h = ADULT_H * L.sh * (p.nh / ADULT_PX);
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
    const b = SHADE[Math.min(i, SHADE.length - 1)];
    p.el.firstChild.style.filter = `brightness(${b}) saturate(${(0.5 + b / 2).toFixed(2)})`;
  }

  function relayout() {
    computeLayout();
    app.classList.add('no-anim');
    queue.forEach((p, i) => {
      if (p.el) {
        size(p);
        place(p, i);
      }
    });
    if (framed && framed === queue[0]) positionBubble(framed);
    setCamera(camHome);
    app.getBoundingClientRect();
    app.classList.remove('no-anim');
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

  // ---------- speech bubble + camera framing ----------
  // The bubble always sits above the speaker's head, never on top of them. The camera rests where
  // the bubble just clears the HUD, or as low as it goes if the speaker is short.
  function positionBubble(p) {
    const s = SPOTS[0];
    const headX = L.left + s.x * L.sw; // #app px
    const headY = s.y * L.sh - p.h * spotScale(0); // top of the sprite, stage px
    bubble.style.left = '0px'; // measure at full available width
    const bw = bubble.offsetWidth;
    const bh = bubble.offsetHeight;
    const minTop = hud.offsetTop + hud.offsetHeight + 10;
    bubbleY = headY - BUBBLE_GAP - bh;
    camHome = Math.max(L.low, minTop - bubbleY);
    const left = Math.min(Math.max(headX - bw / 2, 12), L.w - bw - 12);
    bubble.style.left = left + 'px';
    bubble.style.setProperty('--tail-x', Math.min(Math.max(headX - left, 26), bw - 26) + 'px');
  }

  // Puts p's phrase into the (still hidden) bubble and points the camera at p.
  function frame(p) {
    clearInterval(typing);
    fullText = p.phrase;
    typedEl = document.createElement('span');
    restEl = document.createElement('span');
    restEl.className = 'rest'; // the untyped part keeps its place, so the bubble does not grow while typing
    restEl.textContent = fullText;
    bubbleText.replaceChildren(typedEl, restEl);
    positionBubble(p);
    setCamera(camHome);
    framed = p;
  }

  function say() {
    clearInterval(typing);
    bubble.classList.add('show');
    let n = 0;
    typing = setInterval(() => {
      n++;
      typedEl.textContent = fullText.slice(0, n);
      restEl.textContent = fullText.slice(n);
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
    if (framed !== p) frame(p);
    say();
    if (!panned) hint.classList.add('show');
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
    hint.classList.remove('show');
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
    // the speaker steps out to the right, away from the line
    const x = s.x * L.sw - leaving.w / 2 + L.w * 0.9;
    const y = s.y * L.sh - leaving.h + L.sh * 0.04;
    leaving.el.classList.add('walking');
    leaving.el.style.transform = `translate(${x}px, ${y}px) scale(${spotScale(0) * 1.1})`;
    leaving.el.style.opacity = '0';
    setTimeout(() => leaving.el.remove(), 900);

    queue.forEach((p, i) => {
      if (!p.el) return;
      p.el.classList.add('walking');
      place(p, i);
    });
    fillQueue(true);
    if (queue[0] && queue[0].el) frame(queue[0]); // the camera follows the next speaker as they walk up
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
    framed = null;
    scoreEl.textContent = '✓ 0';
    progressEl.textContent = '';
  }

  async function restart() {
    endScreen.classList.add('hidden');
    queueEl.replaceChildren();
    newGame();
    await fillQueue(false);
    if (queue[0] && queue[0].el) frame(queue[0]);
    present();
  }

  async function boot() {
    $('start-title').textContent = T.title;
    $('start-intro').textContent = T.intro;
    $('end-title').textContent = T.endTitle;
    btnAgain.textContent = T.again;
    hint.textContent = T.hint;
    computeLayout();
    setCamera(L.low);
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
    if (queue[0] && queue[0].el) {
      app.classList.add('no-anim');
      frame(queue[0]);
      app.getBoundingClientRect();
      app.classList.remove('no-anim');
    }
    btnStart.textContent = T.start;
    btnStart.disabled = false;
    queue.forEach((p) => load(p.file).catch(() => {})); // warm up the rest
  }

  // ---------- looking up and down ----------
  function look(top) {
    setCamera(top);
    if (!panned && Math.abs(cam - camHome) > 12) {
      panned = true;
      hint.classList.remove('show');
    }
  }

  let drag = null;
  app.addEventListener('pointerdown', (e) => {
    if (drag || e.target.closest('button, .screen:not(.hidden)')) return;
    drag = { id: e.pointerId, y: e.clientY, cam };
    app.classList.add('dragging');
    app.setPointerCapture(e.pointerId);
  });
  app.addEventListener('pointermove', (e) => {
    if (drag && e.pointerId === drag.id) look(drag.cam + e.clientY - drag.y); // swipe up = look down
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    app.classList.remove('dragging');
  };
  app.addEventListener('pointerup', endDrag);
  app.addEventListener('pointercancel', endDrag);
  app.addEventListener('wheel', (e) => {
    e.preventDefault();
    look(cam - e.deltaY);
  }, { passive: false });

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
    else if (e.key === 'ArrowDown') look(cam - 90);
    else if (e.key === 'ArrowUp') look(cam + 90);
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
