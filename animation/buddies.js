/* Transcripto speaker buddies — markup + GSAP actions (pop, talk, react, cheer) for four character styles.
   Actions add tweens to any timeline, so the same character works in a scroll-scrubbed scene or a looping preview. */
(function () {
  'use strict';

  var FACE = function (dy) {
    return '<g class="bd-face" transform="translate(0 ' + dy + ')">' +
      '<g class="bd-eyes"><g class="bd-blink">' +
        '<ellipse class="bd-eye" cx="39" cy="58" rx="4.6" ry="5.8"/><ellipse class="bd-eye" cx="61" cy="58" rx="4.6" ry="5.8"/>' +
        '<circle class="bd-glint" cx="40.8" cy="55.6" r="1.8"/><circle class="bd-glint" cx="62.8" cy="55.6" r="1.8"/>' +
      '</g></g>' +
      '<ellipse class="bd-blush" cx="28.5" cy="67" rx="5.6" ry="3.3"/><ellipse class="bd-blush" cx="71.5" cy="67" rx="5.6" ry="3.3"/>' +
      '<path class="bd-mouth" d="M45 66.5 Q47.5 69.5 50 66.8 Q52.5 69.5 55 66.5"/>' +
      '<g class="bd-mouth-o"><ellipse cx="50" cy="69" rx="4.6" ry="5"/><ellipse class="bd-tongue" cx="50" cy="71.6" rx="2.8" ry="1.8"/></g>' +
    '</g>';
  };
  var SPARKS = '<g class="bd-fx">' +
    '<path class="bd-spark" d="M14 26l2.2 5 5 2.2-5 2.2-2.2 5-2.2-5-5-2.2 5-2.2Z"/>' +
    '<path class="bd-spark" d="M86 22l1.8 4 4 1.8-4 1.8-1.8 4-1.8-4-4-1.8 4-1.8Z"/>' +
    '<path class="bd-spark" d="M80 78l1.4 3.2 3.2 1.4-3.2 1.4-1.4 3.2-1.4-3.2-3.2-1.4 3.2-1.4Z"/>' +
    '<g class="bd-bang"><circle cx="84" cy="18" r="9" fill="#fff" stroke="#0a1133" stroke-width="1.6"/><path d="M84 12.5v6.5" stroke="#0a1133" stroke-width="3" stroke-linecap="round"/><circle cx="84" cy="23.2" r="1.8" fill="#0a1133"/></g>' +
  '</g>';

  var BODIES = {
    // squishy rice-cake with a shine
    mochi: function () {
      return '<path class="bd-fill" d="M50 24C73 24 88 41 88 63C88 82 72 91 50 91S12 82 12 63C12 41 27 24 50 24Z"/>' +
        '<path class="bd-shade" d="M13 68C17 83 31 91 50 91S83 83 87 68C81 79 67 85 50 85S19 79 13 68Z"/>' +
        '<ellipse class="bd-light" cx="33" cy="38" rx="11" ry="6" transform="rotate(-28 33 38)"/><circle class="bd-light" cx="46.5" cy="31" r="2.6"/>' +
        FACE(0);
    },
    // a little microphone: grille cap, collar, stubby arms
    mic: function () {
      return '<g class="bd-arm-l"><ellipse class="bd-dark" cx="30" cy="80" rx="5.5" ry="4.5"/></g>' +
        '<g class="bd-arm-r"><ellipse class="bd-dark" cx="70" cy="80" rx="5.5" ry="4.5"/></g>' +
        '<rect class="bd-dark" x="40" y="70" width="20" height="22" rx="8"/>' +
        '<circle class="bd-fill" cx="50" cy="47" r="30"/>' +
        '<path class="bd-pale" d="M21.5 38A30 30 0 0 1 78.5 38Z"/>' +
        '<g fill="#b9c6de"><circle cx="34" cy="31" r="1.6"/><circle cx="42" cy="26" r="1.6"/><circle cx="50" cy="24" r="1.6"/><circle cx="58" cy="26" r="1.6"/><circle cx="66" cy="31" r="1.6"/><circle cx="38" cy="34" r="1.6"/><circle cx="46" cy="31" r="1.6"/><circle cx="54" cy="31" r="1.6"/><circle cx="62" cy="34" r="1.6"/></g>' +
        '<rect x="31" y="70" width="38" height="6" rx="3" fill="#fff"/>' +
        '<path class="bd-shade" d="M22 56C25 69 36 77 50 77S75 69 78 56C73 66 63 71 50 71S27 66 22 56Z"/>' +
        FACE(-3) +
        '<g class="bd-arcs"><path d="M86 42Q91 49 86 56"/><path d="M92 36Q100 49 92 62"/></g>';
    },
    // a speech bubble that types "..." while it talks
    bubbly: function () {
      return '<path class="bd-fill" d="M24 32H76C85 32 92 39 92 48V66C92 75 85 82 76 82H47L31 94L34 82H24C15 82 8 75 8 66V48C8 39 15 32 24 32Z"/>' +
        '<path class="bd-shade" d="M8 64C8 74 15 82 24 82H34L32.8 88.4 47 82H76C85 82 92 74 92 64C90 72 84 76 76 76H24C16 76 10 72 8 64Z"/>' +
        '<ellipse class="bd-light" cx="25" cy="41" rx="9" ry="4.2"/>' +
        FACE(-1) +
        '<g class="bd-dots"><circle cx="38" cy="20" r="4.2"/><circle cx="50" cy="20" r="4.2"/><circle cx="62" cy="20" r="4.2"/></g>';
    },
    // a jelly bean with a sprout that wiggles
    sprout: function () {
      return '<g class="bd-leafs"><g class="bd-wiggle"><path class="bd-stem" d="M50 30Q48.5 22 51 15"/>' +
          '<path class="bd-leaf" d="M50.5 17C40 7 28 12 32 21C38 26 47 22 50.5 17Z"/><path class="bd-leaf-2" d="M51.5 16C60 4 75 8 71 18C65 23 56 21 51.5 16Z"/></g></g>' +
        '<ellipse class="bd-dark" cx="39" cy="91" rx="7.5" ry="3.8"/><ellipse class="bd-dark" cx="61" cy="91" rx="7.5" ry="3.8"/>' +
        '<rect class="bd-fill" x="19" y="27" width="62" height="63" rx="31"/>' +
        '<path class="bd-shade" d="M19.5 66C22 80 34 90 50 90S78 80 80.5 66C76 77 65 84 50 84S24 77 19.5 66Z"/>' +
        '<ellipse class="bd-light" cx="33" cy="42" rx="6" ry="10" transform="rotate(25 33 42)"/>' +
        FACE(0);
    }
  };

  var STYLES = [
    { id: 'mochi', name: 'Mochi', note: 'โมจิก้อนนุ่ม ยุบพองตอนหายใจ เด้งดึ๋งตอนพูด' },
    { id: 'mic', name: 'Mic-chan', note: 'ไมโครโฟนตัวจิ๋ว โยกตัว มีคลื่นเสียงออกข้างหัว' },
    { id: 'bubbly', name: 'Bubbly', note: 'ฟองคำพูดลอยได้ มีจุด … เด้งตอนกำลังพูด' },
    { id: 'sprout', name: 'Sprout', note: 'ถั่วเจลลี่มีต้นอ่อนบนหัว ใบกระดิกตลอด' }
  ];

  function markup(style, n) {
    var body = BODIES[style] || BODIES.mochi;
    return '<svg class="bd bd-' + (BODIES[style] ? style : 'mochi') + '" style="--n:' + (n || 0) + '" viewBox="0 0 100 100" aria-hidden="true">' +
      '<ellipse class="bd-ground" cx="50" cy="94" rx="27" ry="4.5"/>' +
      '<g class="bd-act"><g class="bd-idle"><g class="bd-body">' + body() + '</g></g></g>' + SPARKS + '</svg>';
  }

  function parts(root) {
    var q = function (s) { return root.querySelector(s); };
    var qa = function (s) { return Array.prototype.slice.call(root.querySelectorAll(s)); };
    return {
      act: q('.bd-act'), body: q('.bd-body'), eyes: q('.bd-eyes'), mouth: q('.bd-mouth'), mouthO: q('.bd-mouth-o'), ground: q('.bd-ground'),
      arcs: qa('.bd-arcs path'), dots: qa('.bd-dots circle'), leafs: q('.bd-leafs'), armL: q('.bd-arm-l'), armR: q('.bd-arm-r'),
      sparks: qa('.bd-spark'), bang: q('.bd-bang')
    };
  }

  function init(root) {
    var p = parts(root);
    gsap.set([p.act, p.body], { transformOrigin: '50% 100%' });
    gsap.set(p.eyes, { transformOrigin: '50% 50%' });
    gsap.set(p.mouthO, { scale: 0, transformOrigin: '50% 30%' });
    gsap.set(p.arcs.concat(p.dots, p.sparks, p.bang ? [p.bang] : []), { autoAlpha: 0, transformOrigin: '50% 50%' });
    if (p.leafs) gsap.set(p.leafs, { transformOrigin: '50% 100%' });
    if (p.armL) gsap.set([p.armL, p.armR], { transformOrigin: '50% 50%' });
    return p;
  }

  /* springs in from nothing and lands with a squish */
  function pop(tl, root, at) {
    var p = parts(root);
    tl.fromTo(p.act, { scale: 0, y: 26, rotate: -12 }, { scale: 1, y: 0, rotate: 0, duration: 0.45, ease: 'back.out(2.6)', immediateRender: true }, at);
    tl.to(p.body, { scaleX: 1.16, scaleY: 0.84, duration: 0.09, yoyo: true, repeat: 1, ease: 'sine.inOut' }, at + 0.36);
  }

  /* talks for `dur`: mouth opens and closes, body bounces, style extras join in */
  function talk(tl, root, at, dur) {
    var p = parts(root);
    var syll = Math.max(1, Math.round(dur / 0.2)), half = dur / (syll * 2);
    tl.set(p.mouth, { autoAlpha: 0 }, at);
    tl.set(p.mouth, { autoAlpha: 1 }, at + dur);
    tl.to(p.mouthO, { scale: 1, duration: half, yoyo: true, repeat: syll * 2 - 1, ease: 'sine.inOut' }, at);
    tl.to(p.body, { scaleY: 1.08, scaleX: 0.94, duration: half, yoyo: true, repeat: syll * 2 - 1, ease: 'sine.inOut' }, at);
    var beats = Math.max(1, Math.round(dur / 0.4)), bhalf = dur / (beats * 2);
    if (p.arcs.length) tl.fromTo(p.arcs, { autoAlpha: 0, scale: 0.5, x: -5 }, { autoAlpha: 1, scale: 1.15, x: 3, duration: bhalf, stagger: 0.06, yoyo: true, repeat: beats * 2 - 1, ease: 'sine.out', immediateRender: false }, at);
    if (p.dots.length) {
      tl.to(p.dots, { autoAlpha: 1, duration: 0.08 }, at);
      tl.to(p.dots, { y: -6, duration: bhalf, stagger: 0.07, yoyo: true, repeat: beats * 2 - 1, ease: 'sine.inOut' }, at);
      tl.to(p.dots, { autoAlpha: 0, duration: 0.08 }, at + dur);
    }
    if (p.leafs) tl.to(p.leafs, { rotate: 16, duration: half, yoyo: true, repeat: syll * 2 - 1, ease: 'sine.inOut' }, at);
    if (p.armR) tl.to(p.armR, { rotate: -35, x: 3, y: -9, duration: bhalf, yoyo: true, repeat: beats * 2 - 1, ease: 'sine.inOut' }, at);
  }

  /* surprised — used when the host renames this speaker */
  function react(tl, root, at) {
    var p = parts(root);
    tl.to(p.eyes, { scale: 1.35, duration: 0.14, yoyo: true, repeat: 1, ease: 'back.out(3)' }, at);
    tl.to(p.act, { y: -10, duration: 0.14, yoyo: true, repeat: 1, ease: 'power2.out' }, at);
    tl.fromTo(p.bang, { autoAlpha: 0, scale: 0.3, rotate: -20 }, { autoAlpha: 1, scale: 1, rotate: 0, duration: 0.2, ease: 'back.out(3)', immediateRender: false }, at);
    tl.to(p.bang, { autoAlpha: 0, scale: 0.6, duration: 0.15 }, at + 0.55);
  }

  /* happy jump with sparkles */
  function cheer(tl, root, at) {
    var p = parts(root);
    tl.to(p.body, { scaleX: 1.14, scaleY: 0.86, duration: 0.1, ease: 'power2.out' }, at);
    tl.to(p.act, { y: -24, duration: 0.24, ease: 'power2.out' }, at + 0.1);
    tl.to(p.body, { scaleX: 0.92, scaleY: 1.1, duration: 0.12 }, at + 0.1);
    tl.to(p.act, { y: 0, duration: 0.22, ease: 'power2.in' }, at + 0.34);
    tl.to(p.body, { scaleX: 1.14, scaleY: 0.86, duration: 0.08, yoyo: true, repeat: 1, ease: 'sine.inOut' }, at + 0.54);
    tl.to(p.body, { scaleX: 1, scaleY: 1, duration: 0.01 }, at + 0.72);
    tl.fromTo(p.sparks, { autoAlpha: 0, scale: 0.2 }, { autoAlpha: 1, scale: 1.3, rotate: 90, stagger: 0.05, duration: 0.25, ease: 'back.out(2)', immediateRender: false }, at + 0.15);
    tl.to(p.sparks, { autoAlpha: 0, scale: 0.4, duration: 0.2, stagger: 0.05 }, at + 0.55);
    if (p.leafs) tl.fromTo(p.leafs, { rotate: 0 }, { rotate: 360, duration: 0.5, ease: 'power2.inOut', immediateRender: false }, at + 0.1);
    if (p.armL) { tl.to([p.armL, p.armR], { y: -16, duration: 0.2, yoyo: true, repeat: 1, ease: 'power2.out' }, at + 0.1); }
    if (p.dots.length) tl.fromTo(p.dots, { autoAlpha: 1, y: 0 }, { autoAlpha: 0, y: -14, stagger: 0.06, duration: 0.35, immediateRender: false }, at + 0.1);
  }

  /* quick happy hop, e.g. when the waveform takes the speaker's colour */
  function hop(tl, root, at) {
    var p = parts(root);
    tl.to(p.act, { y: -9, duration: 0.12, yoyo: true, repeat: 1, ease: 'power2.out' }, at);
    tl.to(p.body, { scaleX: 1.1, scaleY: 0.9, duration: 0.06, yoyo: true, repeat: 1 }, at + 0.22);
  }

  window.TXB = { STYLES: STYLES, markup: markup, init: init, pop: pop, talk: talk, react: react, cheer: cheer, hop: hop };
})();
