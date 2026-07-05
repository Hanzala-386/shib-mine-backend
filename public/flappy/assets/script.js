
(function () {
    'use strict';

    // ─── Canvas Setup ───
    const canvas = document.getElementById('gameCanvas');
    const ctx = canvas.getContext('2d');
    const container = document.getElementById('gameContainer');

    // ─── Constants ───
    const W = 400;
    const H = 640;
    const GRAVITY = 0.42;
    const JUMP_FORCE = -7.0;
    const BIRD_RADIUS = 14;
    const PIPE_WIDTH = 52;
    const PIPE_GAP = 165;
    const PIPE_SPEED = 2.8;
    const GROUND_HEIGHT = 48;
    const GROUND_Y = H - GROUND_HEIGHT;
    // Extra headroom above the raw hitbox radius: the drawn bird's
    // wingtip can swing further up than the collision circle during
    // a flap, so the top clamp needs a bit more margin than the
    // radius alone to keep the whole sprite on-screen.
    const BIRD_TOP_CLAMP = BIRD_RADIUS + 20;
    // Minimum clear space reserved above the gap (so the top pipe
    // never shrinks down to almost nothing near the very top) and
    // below the gap (so the bottom pipe never crowds the ground).
    const PIPE_TOP_MARGIN = 90;
    const PIPE_BOTTOM_MARGIN = 90;

    const dpr = 1; // no supersampling — keeps frame pacing smooth and consistent, matching the original feel

    function resizeCanvas() {
        const vw = container.clientWidth || window.innerWidth || 400;
        const vh = container.clientHeight || window.innerHeight || 640;
        const aspect = W / H;

        // Fill 100% of the container's width by default — true
        // mobile, edge-to-edge — but never let the resulting height
        // exceed the viewport. On real phones in portrait this cap
        // is never hit, so it's always full width. On short/wide
        // windows (desktop/laptop browsers) it shrinks the width to
        // keep the full game visible instead of letting the
        // overflow:hidden container crop the top and bottom off.
        let displayW = vw;
        let displayH = displayW / aspect;
        if (displayH > vh) {
            displayH = vh;
            displayW = displayH * aspect;
        }

        canvas.style.width = displayW + 'px';
        canvas.style.height = displayH + 'px';

        // Bump internal pixel resolution so the canvas still looks
        // crisp on high-DPI phones, while game logic keeps using the
        // fixed W x H (400 x 640) coordinate space via the scale
        // transform below.
        canvas.width = Math.round(displayW * dpr);
        canvas.height = Math.round(displayH * dpr);
        ctx.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0);
    }
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    window.addEventListener('orientationchange', resizeCanvas);
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', resizeCanvas);
    }

    // ─── State ───
    // 'preload' -> 'intro' (how-to-play shown) -> 'ready' (idle, waiting for first tap)
    // -> 'playing' -> 'paused' (overlay shown mid-game) -> 'playing' / 'over'
    let gameState = 'preload';
    let modalMode = 'intro';
    let score = 0;
    let bestScore = parseInt(localStorage.getItem('flappyBounceBest')) || 0;
    let frameCount = 0;
    let shakeAmount = 0;
    let flashAlpha = 0;
    const MAX_LIVES = 3;
    let lives = MAX_LIVES;
    let invincibleTimer = 0; // frames of grace/flicker after a non-fatal hit

    // ─── Arcade PvP adapter (drop-in, no-op offline) ───
    let serverFrozen = false; // set when the server ends the PvP match remotely
    if (window.Arcade) window.Arcade.onFreeze(function () {
        serverFrozen = true;
        setGameOver(); // stop the local sim cleanly on a server FREEZE_INPUT
    });

    // ─── Bird ───
    const bird = {
        x: 70,
        y: H / 2,
        vy: 0,
        radius: BIRD_RADIUS,
        rotation: 0,
        squash: 1,
        wingPhase: 0,
    };

    // ─── Pipes ───
    let pipes = [];
    let pipeTimer = 0;
    let lastGapY = null;
    const PIPE_SPAWN_INTERVAL = 90;

    // ─── Parallax layers ───
    let mountains = [];
    let clouds = [];
    let stars = [];

    // ─── Effects ───
    let particles = [];
    let textParticles = [];
    let rings = [];
    let trail = [];
    let confetti = [];

    // ─── Input ───
    let jumpQueued = false;

    // ─── DOM ───
    const scoreDisplay = document.getElementById('scoreDisplay');
    const finalScoreEl = document.getElementById('finalScore');
    const bestScoreEl = document.getElementById('bestScore');
    const gameOverOverlay = document.getElementById('gameOverOverlay');
    const restartBtn = document.getElementById('restartBtn');
    const medalIcon = document.getElementById('medalIcon');
    const medalLabel = document.getElementById('medalLabel');
    const newBestBadge = document.getElementById('newBestBadge');
    const livesDisplay = document.getElementById('livesDisplay');
    const heartEls = Array.from(livesDisplay.querySelectorAll('.heart-icon'));

    const preloaderEl = document.getElementById('preloader');
    const preloaderFill = document.getElementById('preloaderFill');
    const preloaderPercent = document.getElementById('preloaderPercent');
    const preloaderTip = document.getElementById('preloaderTip');

    const howtoOverlay = document.getElementById('howtoOverlay');
    const howtoTitle = document.getElementById('howtoTitle');
    const startBtn = document.getElementById('startBtn');

    const birdSelectOverlay = document.getElementById('birdSelectOverlay');
    const birdOptionEls = Array.from(document.querySelectorAll('.bird-option'));
    const birdSelectContinueBtn = document.getElementById('birdSelectContinueBtn');

    const muteBtn = document.getElementById('muteBtn');
    const helpBtn = document.getElementById('helpBtn');

    // ─── Helpers ───
    function rand(min, max) { return Math.random() * (max - min) + min; }
    function randInt(min, max) { return Math.floor(rand(min, max + 1)); }
    function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

    // ════════════════════════════════════════════
    //  AUDIO ENGINE (procedural, Web Audio API)
    // ════════════════════════════════════════════
    let audioCtx = null;
    let soundEnabled = localStorage.getItem('flappyBounceSound') !== 'off';

    function getAudioCtx() {
        if (!audioCtx) {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return null;
            audioCtx = new AC();
        }
        if (audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
        return audioCtx;
    }

    function playTone(opts) {
        if (!soundEnabled) return;
        const ac = getAudioCtx();
        if (!ac) return;
        const freq = opts.freq || 440;
        const type = opts.type || 'sine';
        const duration = opts.duration || 0.15;
        const volume = opts.volume !== undefined ? opts.volume : 0.3;
        const slideTo = opts.slideTo || null;
        const delay = opts.delay || 0;

        const t0 = ac.currentTime + delay;
        const osc = ac.createOscillator();
        const gain = ac.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, t0);
        if (slideTo) {
            osc.frequency.exponentialRampToValueAtTime(Math.max(slideTo, 1), t0 + duration);
        }
        gain.gain.setValueAtTime(volume, t0);
        gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
        osc.connect(gain).connect(ac.destination);
        osc.start(t0);
        osc.stop(t0 + duration + 0.05);
    }

    function playNoise(duration, volume) {
        if (!soundEnabled) return;
        const ac = getAudioCtx();
        if (!ac) return;
        const bufferSize = Math.floor(ac.sampleRate * duration);
        const buffer = ac.createBuffer(1, bufferSize, ac.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
        }
        const noise = ac.createBufferSource();
        noise.buffer = buffer;
        const gain = ac.createGain();
        gain.gain.setValueAtTime(volume, ac.currentTime);
        noise.connect(gain).connect(ac.destination);
        noise.start();
    }

    function playFlap() {
        playTone({ freq: 380, slideTo: 620, type: 'sine', duration: 0.11, volume: 0.22 });
    }

    function playScore() {
        playTone({ freq: 660, type: 'triangle', duration: 0.1, volume: 0.28 });
        playTone({ freq: 880, type: 'triangle', duration: 0.16, volume: 0.28, delay: 0.08 });
    }

    function playHit() {
        playTone({ freq: 170, slideTo: 40, type: 'sawtooth', duration: 0.3, volume: 0.32 });
        playNoise(0.2, 0.18);
    }

    function playGameOver() {
        playTone({ freq: 300, slideTo: 150, type: 'square', duration: 0.4, volume: 0.22 });
        playTone({ freq: 220, slideTo: 90, type: 'square', duration: 0.5, volume: 0.18, delay: 0.16 });
    }

    function playClick() {
        playTone({ freq: 500, slideTo: 720, type: 'sine', duration: 0.08, volume: 0.18 });
    }

    function playSwoosh() {
        playNoise(0.22, 0.07);
    }

    function updateMuteBtn() {
        muteBtn.textContent = soundEnabled ? '🔊' : '🔇';
    }
    updateMuteBtn();

    // ════════════════════════════════════════════
    //  BACKGROUND LAYERS
    // ════════════════════════════════════════════
    function initStars() {
        stars = [];
        for (let i = 0; i < 40; i++) {
            stars.push({
                x: rand(0, W),
                y: rand(0, H * 0.7),
                size: rand(0.5, 2),
                alpha: rand(0.2, 0.8),
            });
        }
    }
    initStars();

    function initMountains() {
        mountains = [];
        const layers = [
            { count: 6, color: '#3a5a7a', yBase: H * 0.6, height: 120, width: 200, speed: 0.08 },
            { count: 4, color: '#2c4a6a', yBase: H * 0.65, height: 90, width: 160, speed: 0.12 },
            { count: 3, color: '#1e3a5a', yBase: H * 0.7, height: 60, width: 120, speed: 0.18 },
        ];
        for (const layer of layers) {
            for (let i = 0; i < layer.count; i++) {
                const x = i * (W / layer.count) + rand(-20, 20);
                mountains.push({
                    x: x,
                    y: layer.yBase,
                    w: layer.width + rand(-30, 30),
                    h: layer.height + rand(-20, 20),
                    color: layer.color,
                    speed: layer.speed,
                });
            }
        }
    }
    initMountains();

    function initClouds() {
        clouds = [];
        for (let i = 0; i < 8; i++) {
            clouds.push({
                x: rand(-40, W + 40),
                y: rand(10, H * 0.5),
                w: rand(60, 140),
                speed: rand(0.1, 0.35),
                opacity: rand(0.25, 0.6),
                puff: rand(4, 8),
            });
        }
    }
    initClouds();

    function updateBackgroundOnly() {
        for (const m of mountains) {
            m.x -= m.speed * 0.3;
            if (m.x + m.w < -20) m.x = W + rand(-20, 20);
        }
        for (const c of clouds) {
            c.x -= c.speed * 0.5;
            if (c.x + c.w < -20) {
                c.x = W + 20;
                c.y = rand(10, H * 0.5);
                c.w = rand(60, 140);
            }
        }
        for (const s of stars) {
            s.x -= 0.02;
            if (s.x < -5) s.x = W + 5;
        }
    }

    // ════════════════════════════════════════════
    //  PARTICLES / EFFECTS
    // ════════════════════════════════════════════
    function spawnParticles(x, y, count, color, spread) {
        for (let i = 0; i < count; i++) {
            const angle = rand(0, Math.PI * 2);
            const speed = rand(0.5, 3);
            particles.push({
                x: x,
                y: y,
                vx: Math.cos(angle) * speed * spread,
                vy: Math.sin(angle) * speed * spread - 0.5,
                life: 1,
                decay: rand(0.01, 0.025),
                size: rand(3, 8),
                color: color || `hsl(${randInt(30, 60)}, 80%, 60%)`,
            });
        }
    }

    function updateParticles() {
        for (let i = particles.length - 1; i >= 0; i--) {
            const p = particles[i];
            p.x += p.vx;
            p.y += p.vy;
            p.vy += 0.05;
            p.life -= p.decay;
            if (p.life <= 0) particles.splice(i, 1);
        }
    }

    function spawnTextParticle(x, y, text, color) {
        textParticles.push({ x, y, text, color, life: 1 });
    }

    function updateTextParticles() {
        for (let i = textParticles.length - 1; i >= 0; i--) {
            const t = textParticles[i];
            t.y -= 1.1;
            t.life -= 0.018;
            if (t.life <= 0) textParticles.splice(i, 1);
        }
    }

    function spawnRing(x, y) {
        rings.push({ x, y, radius: 8, alpha: 0.85 });
    }

    function updateRings() {
        for (let i = rings.length - 1; i >= 0; i--) {
            const r = rings[i];
            r.radius += 2.6;
            r.alpha -= 0.035;
            if (r.alpha <= 0) rings.splice(i, 1);
        }
    }

    function updateTrail() {
        trail.push({ x: bird.x, y: bird.y, alpha: 0.5 });
        if (trail.length > 12) trail.shift();
        for (const t of trail) t.alpha *= 0.85;
    }

    function spawnConfetti(count) {
        const colors = ['#FFD700', '#FF6B6B', '#4ECDC4', '#A78BFA', '#FFA940', '#ffffff'];
        for (let i = 0; i < count; i++) {
            confetti.push({
                x: rand(0, W),
                y: rand(-60, -10),
                vx: rand(-1.4, 1.4),
                vy: rand(1, 2.6),
                w: rand(6, 12),
                h: rand(8, 16),
                rotation: rand(0, Math.PI * 2),
                vr: rand(-0.2, 0.2),
                color: colors[randInt(0, colors.length - 1)],
                life: 1,
            });
        }
    }

    function updateConfetti() {
        for (let i = confetti.length - 1; i >= 0; i--) {
            const c = confetti[i];
            c.x += c.vx;
            c.y += c.vy;
            c.vy += 0.1;
            c.rotation += c.vr;
            c.life -= 0.006;
            if (c.life <= 0 || c.y > H + 30) confetti.splice(i, 1);
        }
    }

    function decayEffects() {
        if (shakeAmount > 0) {
            shakeAmount *= 0.88;
            if (shakeAmount < 0.15) shakeAmount = 0;
        }
        if (flashAlpha > 0) {
            flashAlpha -= 0.045;
            if (flashAlpha < 0) flashAlpha = 0;
        }
    }

    // ════════════════════════════════════════════
    //  PIPES
    // ════════════════════════════════════════════
    function createPipe() {
        // gapY is the vertical center of the opening. Clamp it so the
        // gap always sits at least PIPE_TOP_MARGIN below the top edge
        // and PIPE_BOTTOM_MARGIN above the ground — every pipe ends
        // up with a clean, fair, passable opening, never crowded
        // against the top or the ground.
        const minGapY = PIPE_TOP_MARGIN + PIPE_GAP / 2;
        const maxGapY = GROUND_Y - PIPE_BOTTOM_MARGIN - PIPE_GAP / 2;

        // Also keep each gap within easy reach of the previous one,
        // so the bird is never asked to cover an unreasonably large
        // vertical distance between two consecutive pipes.
        const MAX_GAP_SHIFT = 130;
        let gapY;
        if (lastGapY === null) {
            gapY = rand(minGapY, maxGapY);
        } else {
            const low = clamp(lastGapY - MAX_GAP_SHIFT, minGapY, maxGapY);
            const high = clamp(lastGapY + MAX_GAP_SHIFT, minGapY, maxGapY);
            gapY = rand(low, high);
        }
        lastGapY = gapY;

        const topHeight = gapY - PIPE_GAP / 2;
        const bottomY = gapY + PIPE_GAP / 2;
        return {
            x: W + 20,
            topHeight: topHeight,
            bottomY: bottomY,
            width: PIPE_WIDTH,
            scored: false,
        };
    }

    // ════════════════════════════════════════════
    //  MEDALS
    // ════════════════════════════════════════════
    function getMedal(s) {
        if (s >= 40) return { icon: '🏆', label: 'Legendary Flyer' };
        if (s >= 20) return { icon: '🥈', label: 'Sky Master' };
        if (s >= 10) return { icon: '🥉', label: 'Rising Flyer' };
        return { icon: '🐣', label: 'Keep Practicing!' };
    }

    // ════════════════════════════════════════════
    //  LIVES (3-chance system)
    // ════════════════════════════════════════════
    function updateLivesDisplay(justLostIndex) {
        heartEls.forEach((el, i) => {
            if (i < lives) {
                el.classList.remove('lost');
                el.textContent = '❤️';
            } else {
                el.classList.add('lost');
                el.textContent = '💔';
            }
        });
        if (justLostIndex !== undefined && heartEls[justLostIndex]) {
            const el = heartEls[justLostIndex];
            el.classList.remove('just-lost');
            void el.offsetWidth;
            el.classList.add('just-lost');
        }
    }

    // Clears any pipe currently overlapping the bird's column so a
    // respawned bird can't be hit again by the very same pipe.
    function clearPipesNearBird() {
        const buffer = 60;
        pipes = pipes.filter((p) => !(p.x < bird.x + buffer && p.x + p.width > bird.x - buffer));
    }

    function respawnBird() {
        bird.y = H / 2;
        bird.vy = 0;
        bird.rotation = 0;
        bird.squash = 1;
    }

    // Called on a ground or pipe collision. Spends one of the
    // player's 3 chances; only triggers the real game-over once all
    // chances are gone.
    function handleHit() {
        if (gameState !== 'playing') return;
        // ─── Arcade PvP: sudden death — first collision is fatal (1 life) ───
        if (window.Arcade && window.Arcade.isMatch && window.Arcade.isMatch()) {
            lives = 0;
            updateLivesDisplay(0);
            setGameOver();
            return;
        }
        lives--;

        if (lives <= 0) {
            updateLivesDisplay(0);
            setGameOver();
            return;
        }

        updateLivesDisplay(lives);
        shakeAmount = 9;
        flashAlpha = 0.32;
        spawnParticles(bird.x, bird.y, 22, '#FF6B6B', 0.9);
        spawnTextParticle(bird.x, bird.y - 28, '-1 ❤', '#FF6B6B');
        playHit();
        clearPipesNearBird();
        respawnBird();
        invincibleTimer = 50;
    }

    // ════════════════════════════════════════════
    //  RESET / SCORE DISPLAY
    // ════════════════════════════════════════════
    function resetGame(toState) {
        bird.y = H / 2;
        bird.vy = 0;
        bird.rotation = 0;
        bird.squash = 1;
        bird.wingPhase = 0;
        pipes = [];
        pipeTimer = 0;
        lastGapY = null;
        particles = [];
        textParticles = [];
        rings = [];
        trail = [];
        confetti = [];
        score = 0;
        jumpQueued = false;
        shakeAmount = 0;
        flashAlpha = 0;
        // Arcade PvP = server-defined lives (sudden-death 1); practice keeps MAX_LIVES.
        lives = (window.Arcade && window.Arcade.isMatch && window.Arcade.isMatch())
            ? window.Arcade.maxLives(MAX_LIVES)
            : MAX_LIVES;
        invincibleTimer = 0;
        updateLivesDisplay();
        gameOverOverlay.classList.remove('active');
        newBestBadge.classList.remove('active');
        scoreDisplay.textContent = '0';
        gameState = toState || 'ready';
    }

    // ════════════════════════════════════════════
    //  GAME OVER
    // ════════════════════════════════════════════
    function setGameOver() {
        if (gameState === 'over') return;
        gameState = 'over';
        if (window.Arcade && !serverFrozen) window.Arcade.onPlayerOut(score); // arcade: report locked final score

        shakeAmount = 14;
        flashAlpha = 0.5;
        spawnParticles(bird.x, bird.y, 40, '#FF6B6B', 1.2);
        spawnParticles(bird.x, bird.y, 20, '#FFD700', 0.8);
        playHit();
        setTimeout(playGameOver, 180);

        const isNewBest = score > bestScore;
        if (isNewBest) {
            bestScore = score;
            localStorage.setItem('flappyBounceBest', String(bestScore));
            spawnConfetti(55);
        }

        const medal = getMedal(score);
        medalIcon.textContent = medal.icon;
        medalLabel.textContent = medal.label;
        newBestBadge.classList.toggle('active', isNewBest);
        finalScoreEl.textContent = score;
        bestScoreEl.textContent = bestScore;

        setTimeout(() => gameOverOverlay.classList.add('active'), 380);
    }

    // ════════════════════════════════════════════
    //  UPDATE
    // ════════════════════════════════════════════
    function idleBirdMotion() {
        bird.y = H / 2 + Math.sin(frameCount * 0.05) * 10;
        bird.rotation = Math.sin(frameCount * 0.05) * 0.08;
        bird.vy = 0;
        bird.wingPhase += 0.12;
    }

    function update() {
        if (gameState === 'paused') return;

        frameCount++;
        updateBackgroundOnly();
        updateParticles();
        updateTextParticles();
        updateRings();
        if (confetti.length) updateConfetti();
        decayEffects();

        if (gameState === 'preload') return;

        if (gameState === 'intro' || gameState === 'ready' || gameState === 'birdselect') {
            idleBirdMotion();
            return;
        }

        if (gameState === 'over') return;

        // ─── gameState === 'playing' ───
        if (invincibleTimer > 0) invincibleTimer--;

        bird.vy += GRAVITY;
        bird.y += bird.vy;
        bird.rotation = clamp(bird.vy * 0.06, -0.6, 0.8);

        if (Math.abs(bird.vy) > 1) {
            bird.squash = Math.min(1 + Math.abs(bird.vy) * 0.008, 1.25);
        } else {
            bird.squash += (1 - bird.squash) * 0.1;
        }

        bird.wingPhase += (bird.vy < 0 ? 0.5 : 0.2);

        if (jumpQueued) {
            bird.vy = JUMP_FORCE;
            bird.squash = 0.7;
            bird.wingPhase = -1.35;
            spawnParticles(bird.x, bird.y + 10, 8, '#FFE9A8', 0.5);
            jumpQueued = false;
        }

        updateTrail();

        if (bird.y + bird.radius > GROUND_Y) {
            bird.y = GROUND_Y - bird.radius;
            if (invincibleTimer <= 0) {
                handleHit();
                return;
            }
        }
        if (bird.y - BIRD_TOP_CLAMP < 0) {
            bird.y = BIRD_TOP_CLAMP;
            bird.vy = 0;
        }

        pipeTimer++;
        if (pipeTimer >= PIPE_SPAWN_INTERVAL) {
            pipes.push(createPipe());
            pipeTimer = 0;
        }

        for (let i = pipes.length - 1; i >= 0; i--) {
            const p = pipes[i];
            p.x -= PIPE_SPEED;

            if (p.x + p.width < -10) {
                pipes.splice(i, 1);
                continue;
            }

            const birdLeft = bird.x - bird.radius;
            const birdRight = bird.x + bird.radius;
            const birdTop = bird.y - bird.radius;
            const birdBottom = bird.y + bird.radius;
            const pipeLeft = p.x;
            const pipeRight = p.x + p.width;

            if (invincibleTimer <= 0 && birdRight > pipeLeft && birdLeft < pipeRight) {
                if (birdTop < p.topHeight || birdBottom > p.bottomY) {
                    handleHit();
                    return;
                }
            }

            if (!p.scored && bird.x > p.x + p.width / 2) {
                p.scored = true;
                score++;
                if (window.Arcade) window.Arcade.onScore(score); // arcade: broadcast live score
                scoreDisplay.textContent = score;
                scoreDisplay.classList.remove('bump');
                void scoreDisplay.offsetWidth;
                scoreDisplay.classList.add('bump');
                spawnParticles(bird.x, bird.y, 12, '#FFD700', 0.6);
                spawnRing(bird.x, bird.y);
                spawnTextParticle(bird.x, bird.y - 24, '+1', '#FFD700');
                playScore();
            }
        }
    }

    // ════════════════════════════════════════════
    //  DRAW
    // ════════════════════════════════════════════
    function drawSun() {
        const sunX = W * 0.78;
        const sunY = H * 0.22;
        const pulse = 1 + Math.sin(frameCount * 0.02) * 0.08;
        const r = 48 * pulse;
        const grad = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, r * 2.2);
        grad.addColorStop(0, 'rgba(255,210,120,0.85)');
        grad.addColorStop(0.4, 'rgba(255,170,80,0.32)');
        grad.addColorStop(1, 'rgba(255,170,80,0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(sunX, sunY, r * 2.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,235,180,0.95)';
        ctx.beginPath();
        ctx.arc(sunX, sunY, r * 0.48, 0, Math.PI * 2);
        ctx.fill();
    }

    function drawTrail() {
        for (let i = 0; i < trail.length; i++) {
            const t = trail[i];
            ctx.globalAlpha = t.alpha * 0.5;
            ctx.fillStyle = '#FFD27A';
            ctx.beginPath();
            ctx.arc(t.x, t.y, bird.radius * (0.5 + (i / trail.length) * 0.4), 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    }

    function drawRings() {
        for (const r of rings) {
            ctx.globalAlpha = Math.max(r.alpha, 0);
            ctx.strokeStyle = '#FFD700';
            ctx.lineWidth = 3;
            ctx.shadowColor = '#FFD700';
            ctx.shadowBlur = 15;
            ctx.beginPath();
            ctx.arc(r.x, r.y, r.radius, 0, Math.PI * 2);
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
        ctx.shadowBlur = 0;
    }

    function drawTextParticles() {
        ctx.textAlign = 'center';
        ctx.font = "700 22px 'Poppins', sans-serif";
        for (const t of textParticles) {
            ctx.globalAlpha = Math.max(t.life, 0);
            ctx.fillStyle = t.color;
            ctx.shadowColor = t.color;
            ctx.shadowBlur = 12;
            ctx.fillText(t.text, t.x, t.y);
        }
        ctx.globalAlpha = 1;
        ctx.shadowBlur = 0;
    }

    function drawConfetti() {
        for (const c of confetti) {
            ctx.save();
            ctx.globalAlpha = Math.max(c.life, 0);
            ctx.translate(c.x, c.y);
            ctx.rotate(c.rotation);
            ctx.fillStyle = c.color;
            ctx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
            ctx.restore();
        }
        ctx.globalAlpha = 1;
    }

    function drawReadyHint() {
        ctx.save();
        ctx.textAlign = 'center';
        ctx.globalAlpha = 0.75 + Math.sin(frameCount * 0.08) * 0.25;
        ctx.fillStyle = '#fff';
        ctx.font = "700 21px 'Poppins', sans-serif";
        ctx.shadowColor = 'rgba(0,0,0,0.4)';
        ctx.shadowBlur = 10;
        ctx.fillText('TAP TO START', W / 2, H / 2 + 86);
        ctx.font = '30px sans-serif';
        ctx.fillText('👆', W / 2, H / 2 + 128 + Math.sin(frameCount * 0.1) * 6);
        ctx.restore();
    }

    function drawVignette() {
        const grad = ctx.createRadialGradient(W / 2, H / 2, H * 0.32, W / 2, H / 2, H * 0.78);
        grad.addColorStop(0, 'rgba(0,0,0,0)');
        grad.addColorStop(1, 'rgba(0,0,0,0.35)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, H);
    }

    // ════════════════════════════════════════════
    //  BIRD SKINS — 3 selectable color variants of the same
    //  layered "real bird" silhouette
    // ════════════════════════════════════════════
    const BIRD_SKINS = [
        {
            id: 'blue',
            name: 'Skyler',
            glow: 'rgba(74, 144, 226, 0.45)',
            tailDark: '#16315E', tailLight: '#3D6FC2',
            bodyBack: '#2C5BA0', bodyMid: '#4A90E2', bodyBreast1: '#F2A65A', bodyBreast2: '#EE8C4F', bodyBelly: '#FFF6EC',
            legs: '#D98A3D',
            headLight: '#6BA6EE', headDark: '#2C5BA0',
            cheek: 'rgba(238,140,79,0.55)',
            beakDark: '#4A4A4A', beakLight: '#6B6B6B',
            wingFrontLight: '#6BA6EE', wingFrontMid: '#3D6FC2', wingFrontDark: '#1A3A6E',
            wingBackLight: 'rgba(28,55,100,0.55)', wingBackDark: 'rgba(14,30,60,0.45)',
            wingLine: 'rgba(12,28,58,0.45)',
        },
        {
            id: 'red',
            name: 'Blaze',
            glow: 'rgba(226, 74, 90, 0.45)',
            tailDark: '#5A0F22', tailLight: '#D7263D',
            bodyBack: '#7A1530', bodyMid: '#D7263D', bodyBreast1: '#FFC25C', bodyBreast2: '#FFA73D', bodyBelly: '#FFF3E0',
            legs: '#C9742E',
            headLight: '#FF6B81', headDark: '#7A1530',
            cheek: 'rgba(40,20,20,0.45)',
            beakDark: '#C9601E', beakLight: '#E8893F',
            wingFrontLight: '#FF6B81', wingFrontMid: '#D7263D', wingFrontDark: '#5A0F22',
            wingBackLight: 'rgba(90,20,40,0.55)', wingBackDark: 'rgba(50,10,25,0.45)',
            wingLine: 'rgba(50,10,20,0.45)',
        },
        {
            id: 'green',
            name: 'Sunny',
            glow: 'rgba(120, 200, 80, 0.45)',
            tailDark: '#1B5E20', tailLight: '#4CAF50',
            bodyBack: '#2F6B3A', bodyMid: '#4CAF50', bodyBreast1: '#FFD93D', bodyBreast2: '#FFC107', bodyBelly: '#FFFDE7',
            legs: '#D9893F',
            headLight: '#8BD957', headDark: '#2F6B3A',
            cheek: 'rgba(255,235,59,0.55)',
            beakDark: '#D9893F', beakLight: '#F0B26B',
            wingFrontLight: '#FFEB3B', wingFrontMid: '#4CAF50', wingFrontDark: '#1B5E20',
            wingBackLight: 'rgba(20,60,30,0.55)', wingBackDark: 'rgba(10,35,18,0.45)',
            wingLine: 'rgba(10,40,15,0.45)',
        },
    ];

    let selectedSkinIndex = clamp(parseInt(localStorage.getItem('flappyBounceBirdSkin')) || 0, 0, BIRD_SKINS.length - 1);

    // ════════════════════════════════════════════
    //  BIRD — layered, animated, "real bird" silhouette.
    //  paintBird() is context-agnostic so it can render both the
    //  live game bird and the small selection-screen previews.
    // ════════════════════════════════════════════
    function drawWingBlade(c, s, flapAngle, isBack, skin) {
        c.save();
        // shoulder pivot — slightly behind & above body center
        c.translate(-s * 0.08, -s * 0.12);
        c.rotate(flapAngle * (isBack ? 0.65 : 1));
        if (isBack) c.scale(0.82, 0.82);

        const wingLen = s * 1.2;
        const wingWidth = s * 0.6;

        const grad = c.createLinearGradient(0, 0, wingWidth * 0.4, wingLen);
        if (isBack) {
            grad.addColorStop(0, skin.wingBackLight);
            grad.addColorStop(1, skin.wingBackDark);
        } else {
            grad.addColorStop(0, skin.wingFrontLight);
            grad.addColorStop(0.5, skin.wingFrontMid);
            grad.addColorStop(1, skin.wingFrontDark);
        }
        c.fillStyle = grad;

        c.beginPath();
        c.moveTo(0, 0);
        c.quadraticCurveTo(wingWidth * 0.85, wingLen * 0.32, wingWidth * 0.18, wingLen);
        c.quadraticCurveTo(-wingWidth * 0.3, wingLen * 0.5, 0, 0);
        c.closePath();
        c.fill();

        if (!isBack) {
            // flight-feather separation lines for texture
            c.strokeStyle = skin.wingLine;
            c.lineWidth = Math.max(0.8, s * 0.035);
            for (let i = 1; i <= 3; i++) {
                const t = i / 4;
                c.beginPath();
                c.moveTo(wingWidth * 0.08 * t, wingLen * 0.12 * t);
                c.lineTo(wingWidth * (0.18 - 0.12 * t), wingLen * (0.42 + t * 0.5));
                c.stroke();
            }
        }
        c.restore();
    }

    function paintBird(c, s, flap, skin) {
        const flapAngle = flap * 0.95;

        c.shadowColor = skin.glow;
        c.shadowBlur = 22;

        // ── Tail (fanned feathers) ──
        c.save();
        c.translate(-s * 1.0, s * 0.02);
        c.rotate(flap * 0.12);
        const tailGrad = c.createLinearGradient(-s * 0.85, 0, 0, 0);
        tailGrad.addColorStop(0, skin.tailDark);
        tailGrad.addColorStop(1, skin.tailLight);
        c.fillStyle = tailGrad;
        for (let i = -1; i <= 1; i++) {
            c.beginPath();
            c.moveTo(0, i * s * 0.1);
            c.quadraticCurveTo(-s * 0.5, i * s * 0.32, -s * 0.92, i * s * 0.4);
            c.quadraticCurveTo(-s * 0.55, i * s * 0.12, 0, i * s * 0.02);
            c.closePath();
            c.fill();
        }
        c.restore();

        // ── Back wing (depth layer, behind body) ──
        drawWingBlade(c, s, flapAngle, true, skin);

        // ── Body (back -> breast -> belly) ──
        c.shadowBlur = 0;
        const bodyGrad = c.createLinearGradient(0, -s * 0.9, 0, s * 0.85);
        bodyGrad.addColorStop(0, skin.bodyBack);
        bodyGrad.addColorStop(0.32, skin.bodyMid);
        bodyGrad.addColorStop(0.48, skin.bodyBreast1);
        bodyGrad.addColorStop(0.72, skin.bodyBreast2);
        bodyGrad.addColorStop(1, skin.bodyBelly);
        c.fillStyle = bodyGrad;
        c.beginPath();
        c.moveTo(-s * 1.05, 0);
        c.quadraticCurveTo(-s * 0.55, -s * 0.92, s * 0.32, -s * 0.74);
        c.quadraticCurveTo(s * 0.8, -s * 0.5, s * 0.92, -s * 0.04);
        c.quadraticCurveTo(s * 0.82, s * 0.52, s * 0.22, s * 0.78);
        c.quadraticCurveTo(-s * 0.38, s * 0.82, -s * 1.05, s * 0.28);
        c.closePath();
        c.fill();

        // subtle belly sheen
        const sheen = c.createRadialGradient(s * 0.1, s * 0.4, s * 0.05, s * 0.1, s * 0.4, s * 0.6);
        sheen.addColorStop(0, 'rgba(255,255,255,0.35)');
        sheen.addColorStop(1, 'rgba(255,255,255,0)');
        c.fillStyle = sheen;
        c.beginPath();
        c.ellipse(s * 0.05, s * 0.35, s * 0.45, s * 0.32, 0, 0, Math.PI * 2);
        c.fill();

        // ── Front wing (full color, on top, flaps) ──
        drawWingBlade(c, s, flapAngle, false, skin);

        // ── Tiny tucked legs ──
        c.strokeStyle = skin.legs;
        c.lineWidth = Math.max(1.1, s * 0.055);
        c.lineCap = 'round';
        c.beginPath();
        c.moveTo(-s * 0.08, s * 0.72);
        c.lineTo(-s * 0.02, s * 0.95);
        c.moveTo(s * 0.16, s * 0.72);
        c.lineTo(s * 0.22, s * 0.95);
        c.stroke();

        // ── Head ──
        c.save();
        c.translate(s * 0.58, -s * 0.48);
        const headGrad = c.createRadialGradient(-s * 0.12, -s * 0.14, s * 0.05, 0, 0, s * 0.44);
        headGrad.addColorStop(0, skin.headLight);
        headGrad.addColorStop(1, skin.headDark);
        c.fillStyle = headGrad;
        c.beginPath();
        c.arc(0, 0, s * 0.42, 0, Math.PI * 2);
        c.fill();

        // cheek patch (real-bird detail)
        c.fillStyle = skin.cheek;
        c.beginPath();
        c.ellipse(-s * 0.02, s * 0.18, s * 0.22, s * 0.16, 0, 0, Math.PI * 2);
        c.fill();

        // beak (two-tone cone)
        c.fillStyle = skin.beakDark;
        c.beginPath();
        c.moveTo(s * 0.34, -s * 0.08);
        c.lineTo(s * 0.66, s * 0.02);
        c.lineTo(s * 0.34, s * 0.12);
        c.closePath();
        c.fill();
        c.fillStyle = skin.beakLight;
        c.beginPath();
        c.moveTo(s * 0.34, s * 0.02);
        c.lineTo(s * 0.58, s * 0.05);
        c.lineTo(s * 0.34, s * 0.12);
        c.closePath();
        c.fill();

        // eye with highlight
        c.fillStyle = '#15182a';
        c.beginPath();
        c.arc(s * 0.13, -s * 0.06, s * 0.09, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = 'rgba(255,255,255,0.85)';
        c.beginPath();
        c.arc(s * 0.16, -s * 0.1, s * 0.03, 0, Math.PI * 2);
        c.fill();
        c.restore(); // head
    }

    function drawBird() {
        const s = bird.radius * bird.squash * 0.625; // visual scale unit — 50% smaller than before
        const flap = Math.sin(bird.wingPhase); // -1 (up) .. 1 (down)
        const skin = BIRD_SKINS[selectedSkinIndex];

        ctx.save();
        ctx.translate(bird.x, bird.y);
        ctx.rotate(bird.rotation);
        paintBird(ctx, s, flap, skin);
        ctx.restore(); // outer bird transform
    }

    function draw() {
        ctx.clearRect(0, 0, W, H);

        ctx.save();
        if (shakeAmount > 0) {
            ctx.translate(rand(-shakeAmount, shakeAmount), rand(-shakeAmount, shakeAmount));
        }

        // ─── Sky gradient ───
        const skyGrad = ctx.createLinearGradient(0, 0, 0, H);
        skyGrad.addColorStop(0, '#0b1a33');
        skyGrad.addColorStop(0.3, '#1b3b5c');
        skyGrad.addColorStop(0.6, '#4a7a9c');
        skyGrad.addColorStop(0.85, '#87CEEB');
        skyGrad.addColorStop(1, '#c9e8f0');
        ctx.fillStyle = skyGrad;
        ctx.fillRect(0, 0, W, H);

        drawSun();

        // ─── Stars ───
        for (const s of stars) {
            ctx.globalAlpha = s.alpha * (0.6 + 0.4 * Math.sin(frameCount * 0.02 + s.x));
            ctx.fillStyle = '#fff';
            ctx.beginPath();
            ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;

        // ─── Mountains ───
        for (const m of mountains) {
            ctx.fillStyle = m.color;
            ctx.beginPath();
            ctx.moveTo(m.x, m.y);
            ctx.quadraticCurveTo(m.x + m.w * 0.3, m.y - m.h * 0.7, m.x + m.w * 0.5, m.y - m.h);
            ctx.quadraticCurveTo(m.x + m.w * 0.7, m.y - m.h * 0.6, m.x + m.w, m.y);
            ctx.closePath();
            ctx.fill();
            ctx.fillStyle = 'rgba(255,255,255,0.08)';
            ctx.beginPath();
            ctx.moveTo(m.x + m.w * 0.35, m.y - m.h * 0.5);
            ctx.quadraticCurveTo(m.x + m.w * 0.5, m.y - m.h * 0.8, m.x + m.w * 0.65, m.y - m.h * 0.45);
            ctx.closePath();
            ctx.fill();
        }

        // ─── Clouds ───
        for (const c of clouds) {
            ctx.globalAlpha = c.opacity * 0.8;
            ctx.fillStyle = '#f0f8ff';
            const cx = c.x;
            const cy = c.y;
            const pw = c.w;
            const ph = pw * 0.3;
            ctx.beginPath();
            ctx.ellipse(cx + pw * 0.1, cy + ph * 0.2, pw * 0.4, ph * 0.5, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.ellipse(cx + pw * 0.5, cy + ph * 0.15, pw * 0.35, ph * 0.45, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.ellipse(cx - pw * 0.15, cy + ph * 0.25, pw * 0.3, ph * 0.4, 0, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;

        // ─── Pipes ───
        for (const p of pipes) {
            const x = p.x;
            const w = p.width;
            const topH = p.topHeight;
            const gradTop = ctx.createLinearGradient(x, 0, x + w, 0);
            gradTop.addColorStop(0, '#1b5e20');
            gradTop.addColorStop(0.3, '#2e7d32');
            gradTop.addColorStop(0.7, '#388e3c');
            gradTop.addColorStop(1, '#1b5e20');
            ctx.fillStyle = gradTop;
            ctx.shadowColor = 'rgba(0,0,0,0.25)';
            ctx.shadowBlur = 12;
            ctx.shadowOffsetY = 4;
            ctx.fillRect(x, 0, w, topH);
            ctx.fillStyle = '#2e7d32';
            ctx.shadowBlur = 8;
            ctx.fillRect(x - 8, topH - 18, w + 16, 18);
            ctx.shadowBlur = 0;
            ctx.fillStyle = 'rgba(255,255,255,0.08)';
            ctx.fillRect(x + 6, 0, 6, topH);
            ctx.strokeStyle = 'rgba(255,215,0,0.35)';
            ctx.lineWidth = 2;
            ctx.shadowColor = 'rgba(255,215,0,0.4)';
            ctx.shadowBlur = 6;
            ctx.strokeRect(x - 8, topH - 18, w + 16, 18);
            ctx.shadowBlur = 0;

            const bottomY = p.bottomY;
            const bottomH = H - bottomY;
            const gradBot = ctx.createLinearGradient(x, bottomY, x + w, bottomY);
            gradBot.addColorStop(0, '#1b5e20');
            gradBot.addColorStop(0.3, '#2e7d32');
            gradBot.addColorStop(0.7, '#388e3c');
            gradBot.addColorStop(1, '#1b5e20');
            ctx.fillStyle = gradBot;
            ctx.shadowColor = 'rgba(0,0,0,0.25)';
            ctx.shadowBlur = 12;
            ctx.shadowOffsetY = -2;
            ctx.fillRect(x, bottomY, w, bottomH);
            ctx.fillStyle = '#2e7d32';
            ctx.shadowBlur = 8;
            ctx.fillRect(x - 8, bottomY, w + 16, 18);
            ctx.shadowBlur = 0;
            ctx.fillStyle = 'rgba(255,255,255,0.08)';
            ctx.fillRect(x + 6, bottomY, 6, bottomH);
            ctx.strokeStyle = 'rgba(255,215,0,0.35)';
            ctx.lineWidth = 2;
            ctx.shadowColor = 'rgba(255,215,0,0.4)';
            ctx.shadowBlur = 6;
            ctx.strokeRect(x - 8, bottomY, w + 16, 18);
            ctx.shadowBlur = 0;
        }

        // ─── Ground ───
        ctx.shadowBlur = 0;
        const groundGrad = ctx.createLinearGradient(0, GROUND_Y, 0, H);
        groundGrad.addColorStop(0, '#6B8E23');
        groundGrad.addColorStop(0.3, '#556B2F');
        groundGrad.addColorStop(1, '#2d3a1a');
        ctx.fillStyle = groundGrad;
        ctx.fillRect(0, GROUND_Y, W, GROUND_HEIGHT);
        ctx.fillStyle = '#8cb84b';
        ctx.fillRect(0, GROUND_Y, W, 4);
        ctx.strokeStyle = '#7aa83a';
        ctx.lineWidth = 2;
        for (let i = 0; i < W; i += 8) {
            const height = 4 + Math.sin(i * 0.5 + frameCount * 0.02) * 2;
            ctx.beginPath();
            ctx.moveTo(i, GROUND_Y);
            ctx.lineTo(i + 1, GROUND_Y - height);
            ctx.stroke();
        }

        // ─── Trail (only while flying) ───
        if (gameState === 'playing') drawTrail();

        // ─── Particles ───
        for (const p of particles) {
            ctx.globalAlpha = p.life;
            ctx.fillStyle = p.color;
            ctx.shadowBlur = 10;
            ctx.shadowColor = p.color;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size * p.life * 0.8, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
        ctx.shadowBlur = 0;

        // ─── Rings ───
        drawRings();

        // ─── Bird ───
        // Flicker during the brief post-hit grace period so it's
        // clear the bird is temporarily invincible.
        const isFlickerHidden = invincibleTimer > 0 && Math.floor(frameCount / 4) % 2 === 1;
        if (!isFlickerHidden) drawBird();

        // ─── Score popups ───
        drawTextParticles();

        // ─── Confetti ───
        if (gameState === 'over' && confetti.length) drawConfetti();

        // ─── Ready hint ───
        if (gameState === 'ready') drawReadyHint();

        ctx.fillStyle = 'rgba(0,0,0,0.05)';
        ctx.fillRect(0, GROUND_Y + 4, W, 6);

        ctx.restore(); // end shake transform

        drawVignette();

        if (flashAlpha > 0) {
            ctx.fillStyle = `rgba(255,255,255,${flashAlpha})`;
            ctx.fillRect(0, 0, W, H);
        }
    }

    // ─── Game loop ───
    function gameLoop() {
        update();
        draw();
        requestAnimationFrame(gameLoop);
    }

    // ─── Input ───
    function handleInput(e) {
        if (gameState === 'preload' || gameState === 'intro' || gameState === 'paused' || gameState === 'over' || gameState === 'birdselect') return;
        e.preventDefault();
        getAudioCtx();
        if (gameState === 'ready') {
            gameState = 'playing';
        }
        jumpQueued = true;
        bird.vy = JUMP_FORCE * 0.6;
        bird.squash = 0.8;
        playFlap();
    }

    canvas.addEventListener('mousedown', handleInput);
    canvas.addEventListener('touchstart', handleInput, { passive: false });

    document.addEventListener('keydown', (e) => {
        if (e.code === 'Space' || e.key === ' ') {
            e.preventDefault();
            handleInput(e);
        }
    });

    // ─── Restart ───
    function doRestart() {
        getAudioCtx();
        playClick();
        resetGame('ready');
    }
    restartBtn.addEventListener('click', (e) => { e.stopPropagation(); doRestart(); });
    restartBtn.addEventListener('touchend', (e) => { e.preventDefault(); e.stopPropagation(); doRestart(); });

    // ─── How to play / Pause modal ───
    // ─── Bird selection ───
    function renderBirdPreviews() {
        BIRD_SKINS.forEach((skin, i) => {
            const canvasEl = document.getElementById('birdPreview' + i);
            if (!canvasEl) return;
            const pctx = canvasEl.getContext('2d');
            const w = canvasEl.width;
            const h = canvasEl.height;
            pctx.clearRect(0, 0, w, h);
            pctx.save();
            pctx.translate(w / 2, h / 2 + 6);
            pctx.rotate(-0.08);
            const previewScale = BIRD_RADIUS * 1.55; // bigger/clearer than in-game size for a selection thumbnail
            paintBird(pctx, previewScale, 0.4, skin);
            pctx.restore();
        });
    }

    function setSelectedSkin(i) {
        selectedSkinIndex = i;
        localStorage.setItem('flappyBounceBirdSkin', String(i));
        birdOptionEls.forEach((el) => {
            el.classList.toggle('selected', parseInt(el.dataset.skin, 10) === i);
        });
    }

    function showBirdSelect() {
        gameState = 'birdselect';
        renderBirdPreviews();
        setSelectedSkin(selectedSkinIndex);
        birdSelectOverlay.classList.add('active');
    }

    birdOptionEls.forEach((el) => {
        const i = parseInt(el.dataset.skin, 10);
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            getAudioCtx();
            playClick();
            setSelectedSkin(i);
        });
    });

    function finishBirdSelect() {
        birdSelectOverlay.classList.remove('active');
        showHowToPlay('intro');
    }
    birdSelectContinueBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        getAudioCtx();
        playClick();
        finishBirdSelect();
    });
    birdSelectContinueBtn.addEventListener('touchend', (e) => {
        e.preventDefault();
        e.stopPropagation();
        getAudioCtx();
        playClick();
        finishBirdSelect();
    });

    function showHowToPlay(mode) {
        modalMode = mode;
        if (mode === 'intro') {
            howtoTitle.textContent = 'How To Play';
            startBtn.textContent = "Let's Fly 🚀";
            gameState = 'intro';
        } else {
            howtoTitle.textContent = 'Paused';
            startBtn.textContent = 'Resume ▶';
        }
        howtoOverlay.classList.add('active');
        playSwoosh();
    }

    function hideHowToPlay() {
        howtoOverlay.classList.remove('active');
        gameState = (modalMode === 'paused') ? 'playing' : 'ready';
    }

    startBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        getAudioCtx();
        playClick();
        hideHowToPlay();
    });
    startBtn.addEventListener('touchend', (e) => {
        e.preventDefault();
        e.stopPropagation();
        getAudioCtx();
        playClick();
        hideHowToPlay();
    });

    helpBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (gameState === 'playing') {
            playClick();
            gameState = 'paused';
            showHowToPlay('paused');
        } else if (gameState === 'ready') {
            playClick();
            showHowToPlay('intro');
        }
    });

    muteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        soundEnabled = !soundEnabled;
        localStorage.setItem('flappyBounceSound', soundEnabled ? 'on' : 'off');
        updateMuteBtn();
        if (soundEnabled) {
            getAudioCtx();
            playClick();
        }
    });

    // ─── Preloader ───
    function runPreloader() {
        const tips = [
            'Polishing feathers...',
            'Inflating pipes...',
            'Warming up wings...',
            'Calibrating gravity...',
            'Tuning the wind...',
            'Charging the sunset...',
        ];
        let tipIndex = 0;
        preloaderTip.textContent = tips[0];
        const tipInterval = setInterval(() => {
            tipIndex = (tipIndex + 1) % tips.length;
            preloaderTip.textContent = tips[tipIndex];
        }, 450);

        const totalDuration = 1700;
        const startTime = performance.now();

        function step(now) {
            const elapsed = now - startTime;
            const progress = Math.min(100, (elapsed / totalDuration) * 100);
            preloaderFill.style.width = progress + '%';
            preloaderPercent.textContent = Math.floor(progress) + '%';
            if (progress < 100) {
                requestAnimationFrame(step);
            } else {
                clearInterval(tipInterval);
                setTimeout(() => {
                    preloaderEl.classList.add('fade-out');
                    setTimeout(() => {
                        preloaderEl.style.display = 'none';
                        showBirdSelect();
                    }, 600);
                }, 200);
            }
        }
        requestAnimationFrame(step);
    }

    // ─── Start ───
    resetGame('preload');
    runPreloader();
    gameLoop();

})();