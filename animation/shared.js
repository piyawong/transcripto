/* Transcripto scene prototypes — shared runtime: icon sprite, scrubbed timeline, step chips, text helpers.
   Each direction calls TX.run((tl, env) => { ... }) and owns its own choreography. */
(function () {
  'use strict';
  var SPRITE = '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>' +
    '<symbol id="i-mic" viewBox="0 0 24 24"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/></symbol>' +
    '<symbol id="i-file" viewBox="0 0 24 24"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/></symbol>' +
    '<symbol id="i-music" viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></symbol>' +
    '<symbol id="i-check" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></symbol>' +
    '<symbol id="i-download" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></symbol>' +
    '<symbol id="i-pencil" viewBox="0 0 24 24"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></symbol>' +
    '<symbol id="i-copy" viewBox="0 0 24 24"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></symbol>' +
    '<symbol id="i-refresh" viewBox="0 0 24 24"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></symbol>' +
    '<symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></symbol>' +
    '<symbol id="i-play" viewBox="0 0 24 24"><path d="M6 4l14 8-14 8Z"/></symbol>' +
    '<symbol id="i-pause" viewBox="0 0 24 24"><path d="M8 5v14"/><path d="M16 5v14"/></symbol>' +
    '<symbol id="i-cc" viewBox="0 0 24 24"><rect width="18" height="14" x="3" y="5" rx="2"/><path d="M7 15h4"/><path d="M15 15h2"/><path d="M7 11h2"/><path d="M13 11h4"/></symbol>' +
    '<symbol id="i-upload" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/></symbol>' +
    '<symbol id="i-sparkle" viewBox="0 0 24 24"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z"/><path d="M19 17l.8 2.2L22 20l-2.2.8L19 23l-.8-2.2L16 20l2.2-.8Z"/></symbol>' +
    '</defs></svg>';

  function seg(text) {
    try { return Array.from(new Intl.Segmenter('th', { granularity: 'grapheme' }).segment(text), function (s) { return s.segment; }); }
    catch (e) { return null; }
  }
  /* writer that reveals the first `p` share of an element's text on grapheme boundaries */
  function typer(el) {
    var full = el.textContent, parts = seg(full), shown = -1;
    return function (p) {
      p = Math.max(0, Math.min(1, p));
      var n = parts ? Math.floor(p * parts.length) : (p >= 1 ? 1 : 0);
      if (n === shown) return;
      shown = n;
      el.textContent = parts ? parts.slice(0, n).join('') : (n ? full : '');
    };
  }
  /* wraps every word (space-separated chunk) of an element in <span class="w"> for karaoke highlight */
  function words(el) {
    var parts = el.textContent.split(/(\s+)/);
    el.innerHTML = parts.map(function (w) { return /^\s+$/.test(w) ? w : '<span class="w">' + w + '</span>'; }).join('');
    return Array.prototype.slice.call(el.querySelectorAll('.w'));
  }
  var progress = function (t, a, b) { return (t - a) / (b - a); };

  function run(build) {
    document.body.insertAdjacentHTML('afterbegin', SPRITE);
    var root = document.documentElement;
    var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!window.gsap || !window.ScrollTrigger) { root.classList.add('static'); return; }
    gsap.registerPlugin(ScrollTrigger);
    var steps = Array.prototype.slice.call(document.querySelectorAll('[data-step-at]')).map(function (el) { return { el: el, at: parseFloat(el.dataset.stepAt) }; });

    var mm = gsap.matchMedia();
    mm.add({ desktop: '(min-width: 768px)', mobile: '(max-width: 767px)' }, function (ctx) {
      var tl = gsap.timeline({ paused: true, defaults: { ease: 'power2.inOut', duration: 1 } });
      var appliers = [];
      var env = { mobile: ctx.conditions.mobile, onTime: function (fn) { appliers.push(fn); } };
      build(tl, env);
      var apply = function () {
        var t = tl.time();
        steps.forEach(function (s, i) {
          var next = steps[i + 1];
          s.el.classList.toggle('is-on', t >= s.at && (!next || t < next.at));
          s.el.classList.toggle('is-done', !!next && t >= next.at);
        });
        appliers.forEach(function (fn) { fn(t); });
      };
      tl.eventCallback('onUpdate', apply);
      if (reduce) {
        root.classList.add('static');
        tl.progress(1);
        apply();
        return;
      }
      root.classList.add('live');
      apply();
      window.TX.st = ScrollTrigger.create({ trigger: '.story', start: 'top top', end: 'bottom bottom', animation: tl, scrub: 1 }); // read by the screenshot check
    });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { ScrollTrigger.refresh(); });
  }

  window.TX = { run: run, typer: typer, words: words, progress: progress, seg: seg };
})();
