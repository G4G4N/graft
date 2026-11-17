// Landing page: replay the recorded 16-agent runs (Graft vs Git) on one shared time axis,
// plus hover tooltips for the build-time chart. No dependencies.
(() => {
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const fmt = (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`);
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- tooltips for [data-tip] marks
  const tip = document.getElementById("tip");
  for (const el of document.querySelectorAll("[data-tip]")) {
    el.addEventListener("pointermove", (e) => {
      tip.textContent = "";
      el.dataset.tip.split("|").forEach((line, i) => {
        if (i) tip.appendChild(document.createElement("br"));
        tip.appendChild(document.createTextNode(line));
      });
      tip.hidden = false;
      const r = tip.getBoundingClientRect();
      let x = e.clientX + 14, y = e.clientY + 14;
      if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 14;
      if (y + r.height > innerHeight - 8) y = e.clientY - r.height - 14;
      tip.style.left = `${x}px`;
      tip.style.top = `${y}px`;
    });
    el.addEventListener("pointerleave", () => (tip.hidden = true));
  }

  // ---------- race replay
  const clock = document.getElementById("race-clock");
  if (!clock) return;
  const opVar = (op) =>
    /reset|abort/.test(op) ? "--op-reset" : /rebase|pull/.test(op) ? "--op-rebase" : /push/.test(op) ? "--op-push" : /read|resolve|sync|status|diff|fetch/.test(op) ? "--op-read" : "--op-commit";

  fetch("/data/race.json")
    .then((r) => r.json())
    .then(start)
    .catch(() => (clock.textContent = "replay unavailable"));

  function start(data) {
    const teams = ["graft", "git"].map((k) => ({
      key: k,
      ...data[k],
      cv: document.getElementById(`lane-${k}`),
      count: document.getElementById(`count-${k}`),
      done: document.getElementById(`done-${k}`),
      lands: data[k].rows.filter((r) => r[3] === 4).map((r) => r[0] + r[1]).sort((a, b) => a - b),
    }));
    const maxT = Math.max(...teams.map((t) => t.wallMs));
    let speed = 1;
    let t0 = 0; // performance.now() at replay time 0
    let raf = 0;
    let T = maxT; // first frame: the finished state, complete at rest

    function draw() {
      for (const tm of teams) {
        const cv = tm.cv;
        const dpr = devicePixelRatio || 1;
        const W = cv.clientWidth || 600, H = cv.clientHeight || 132;
        if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
        const g = cv.getContext("2d");
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, W, H);
        const n = tm.agents, pad = 6, gap = 1.5;
        const laneH = (H - pad * 2 - gap * (n - 1)) / n;
        const x = (t) => 4 + (t / maxT) * (W - 8);
        // finish line for this team
        if (T >= tm.wallMs) {
          g.fillStyle = css(tm.key === "graft" ? "--graft" : "--git");
          g.globalAlpha = 0.35;
          g.fillRect(x(tm.wallMs), 0, 2, H);
          g.globalAlpha = 1;
        }
        for (const [t, ms, a, kind, op] of tm.rows) {
          if (t > T || kind === 4) continue;
          const y = pad + a * (laneH + gap);
          const end = Math.min(t + ms, T);
          if (kind === 0) {
            g.fillStyle = css("--op-think");
            g.fillRect(x(t), y, Math.max(1, x(end) - x(t)), laneH);
          } else if (kind === 1) {
            g.fillStyle = css(opVar(op));
            g.fillRect(x(t), y, Math.max(1.5, x(end) - x(t)), laneH);
          } else if (kind === 2) {
            g.fillStyle = css("--op-mark");
            g.fillRect(x(t) - 0.75, y - 1, 1.5, laneH + 2);
          }
        }
        // playhead
        if (T < maxT) {
          g.fillStyle = css("--ink");
          g.globalAlpha = 0.5;
          g.fillRect(x(T), 0, 1, H);
          g.globalAlpha = 1;
        }
        const landed = tm.lands.filter((v) => v <= T).length;
        tm.count.textContent = `${landed} / ${tm.lands.length} landed`;
        const finished = T >= tm.wallMs;
        tm.done.hidden = !finished;
        if (finished) tm.done.textContent = `✓ app finished in ${fmt(tm.wallMs)}`;
      }
      clock.textContent = `t = ${(T / 1000).toFixed(1)} s`;
    }

    function frame(now) {
      T = Math.min(maxT, (now - t0) * speed);
      draw();
      if (T < maxT) raf = requestAnimationFrame(frame);
    }
    function play(fromT = 0) {
      cancelAnimationFrame(raf);
      t0 = performance.now() - fromT / speed;
      raf = requestAnimationFrame(frame);
    }

    draw();
    document.getElementById("race-replay").addEventListener("click", () => play(0));
    const speedBtn = document.getElementById("race-speed");
    speedBtn.addEventListener("click", () => {
      const cur = T < maxT ? T : 0;
      speed = speed === 1 ? 8 : 1;
      speedBtn.setAttribute("aria-pressed", String(speed === 8));
      if (cur > 0) play(cur);
    });
    addEventListener("resize", draw);
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", draw);
    new MutationObserver(draw).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    if (!reduce) {
      // Start the replay the first time the card is on screen.
      const io = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          setTimeout(() => play(0), 600);
        }
      });
      io.observe(document.getElementById("race"));
    }
  }
})();
