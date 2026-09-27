/* Touch input stays independent of the desktop mouse and keyboard bindings. */
(function (global) {
  'use strict';

  global.createMobileControls = function createMobileControls(options) {
    const canvas = options.canvas;
    const byId = id => document.getElementById(id);
    const panel = byId('mobile-controls');
    const stick = byId('move-stick');
    const knob = byId('move-knob');
    const suction = byId('mobile-suction');
    const jump = byId('mobile-jump');
    const resetCamera = byId('mobile-reset');
    const helpToggle = byId('mobile-help-toggle');
    const coach = byId('mobile-coach');
    const coachClose = byId('mobile-coach-close');
    const coarse = global.matchMedia('(pointer: coarse)');
    const listeners = [];
    const pointers = new Map();
    let enabled = false;
    let destroyed = false;
    let movePointer = null;
    let lookPointer = null;
    let suctionPointer = null;
    let keyboardSuction = false;
    let sucking = false;
    let coachVisible = false;
    let previousPlaying = false;
    let lastMoveX = 0;
    let lastMoveY = 0;

    const emit = (name, ...args) => {
      if (typeof options[name] === 'function') options[name](...args);
    };
    const isPlaying = () => !destroyed && !!options.isPlaying();
    const isTouch = event => event.pointerType === 'touch' || event.pointerType === 'pen';
    const listen = (target, type, handler, config) => {
      if (!target) return;
      target.addEventListener(type, handler, config);
      listeners.push(() => target.removeEventListener(type, handler, config));
    };
    const stop = event => {
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
    };
    const capture = (element, pointerId) => {
      try { element.setPointerCapture(pointerId); } catch (_) { /* Pointer already ended. */ }
    };
    const releaseCapture = (element, pointerId) => {
      try {
        if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
      } catch (_) { /* Navigation can remove the active element. */ }
    };
    const move = (x, y) => {
      if (x === lastMoveX && y === lastMoveY) return;
      lastMoveX = x;
      lastMoveY = y;
      emit('onMove', x, y);
    };
    const setSuction = active => {
      if (suction) {
        suction.classList.toggle('is-active', active);
        suction.setAttribute('aria-pressed', String(active));
        suction.setAttribute('aria-label', active ? 'Пылесос работает. Отпустите, чтобы остановить' : 'Удерживайте, чтобы пылесосить');
        const label = suction.querySelector('[data-suction-label]');
        if (label) label.textContent = active ? 'Тянем…' : 'Пылесос';
      }
      if (sucking === active) return;
      sucking = active;
      emit('onSuction', active);
    };
    const showCoach = visible => {
      if (coach) coach.hidden = !visible;
      if (helpToggle) helpToggle.setAttribute('aria-expanded', String(visible));
      if (coachVisible !== visible) {
        coachVisible = visible;
        emit('onHelpChange', visible);
      }
    };
    const dismissCoach = () => showCoach(false);

    function setEnabled(next) {
      if (enabled === next || destroyed) return;
      enabled = next;
      document.body.classList.toggle('touch-controls', enabled);
      emit('onModeChange', enabled);
      refresh();
    }

    function clearPointer(pointerId, cancelled) {
      const state = pointers.get(pointerId);
      if (!state) return;
      // Remove before releasing capture: lostpointercapture may run synchronously.
      pointers.delete(pointerId);
      if (state.kind === 'move') {
        movePointer = null;
        move(0, 0);
        if (knob) knob.style.transform = 'translate(0px, 0px)';
        if (stick) stick.classList.remove('is-active');
      } else if (state.kind === 'suction') {
        suctionPointer = null;
        setSuction(keyboardSuction && isPlaying());
      } else if (state.kind === 'look') {
        lookPointer = null;
        if (!cancelled && !state.dragging && performance.now() - state.started < 450 && isPlaying()) {
          emit('onAim', state.lastX, state.lastY);
        }
      } else if (state.kind === 'jump' && jump) {
        jump.classList.remove('is-active');
      }
      releaseCapture(state.element, pointerId);
    }

    function reset() {
      keyboardSuction = false;
      for (const pointerId of Array.from(pointers.keys())) clearPointer(pointerId, true);
      movePointer = lookPointer = suctionPointer = null;
      move(0, 0);
      setSuction(false);
      if (knob) knob.style.transform = 'translate(0px, 0px)';
      if (stick) stick.classList.remove('is-active');
      if (jump) jump.classList.remove('is-active');
    }

    function refresh() {
      if (destroyed) return;
      const playing = isPlaying();
      if (!playing && (previousPlaying || pointers.size || sucking || lastMoveX || lastMoveY)) reset();
      if (panel) panel.hidden = !(enabled && playing);
      previousPlaying = playing;
    }

    function controlStart(event, kind, element) {
      if (event.pointerType === 'mouse' && event.button !== 0) return false;
      if (isTouch(event)) setEnabled(true);
      if (!enabled) return false;
      stop(event);
      if (!isPlaying()) return false;
      emit('onInteract');
      pointers.set(event.pointerId, { kind, element });
      capture(element, event.pointerId);
      return true;
    }

    function updateStick(event, state) {
      const dx = event.clientX - state.centerX;
      const dy = event.clientY - state.centerY;
      const length = Math.hypot(dx, dy);
      const clampedLength = Math.min(length, state.radius);
      const ux = length > 0 ? dx / length : 0;
      const uy = length > 0 ? dy / length : 0;
      const intensity = Math.max(0, (clampedLength / state.radius - 0.13) / 0.87);
      if (knob) knob.style.transform = `translate(${ux * clampedLength}px, ${uy * clampedLength}px)`;
      move(ux * intensity, uy * intensity);
    }

    // Capture activation early enough that the game's legacy handlers can ignore touch.
    listen(document, 'pointerdown', event => {
      if (isTouch(event)) setEnabled(true);
    }, { capture: true, passive: true });

    listen(stick, 'pointerdown', event => {
      if (movePointer !== null) { stop(event); return; }
      if (!controlStart(event, 'move', stick)) return;
      movePointer = event.pointerId;
      const rect = stick.getBoundingClientRect();
      const knobRect = knob ? knob.getBoundingClientRect() : { width: 0, height: 0 };
      const state = pointers.get(event.pointerId);
      state.centerX = rect.left + rect.width / 2;
      state.centerY = rect.top + rect.height / 2;
      state.radius = Math.max(18, (Math.min(rect.width, rect.height) - Math.max(knobRect.width, knobRect.height)) / 2);
      stick.classList.add('is-active');
      updateStick(event, state);
    }, { passive: false });

    listen(suction, 'pointerdown', event => {
      if (suctionPointer !== null) { stop(event); return; }
      if (!controlStart(event, 'suction', suction)) return;
      suctionPointer = event.pointerId;
      setSuction(true);
    }, { passive: false });

    listen(jump, 'pointerdown', event => {
      if (!controlStart(event, 'jump', jump)) return;
      jump.classList.add('is-active');
      emit('onJump');
    }, { passive: false });

    listen(canvas, 'pointerdown', event => {
      if (!isTouch(event)) return;
      stop(event);
      setEnabled(true);
      if (!isPlaying() || lookPointer !== null) return;
      emit('onInteract');
      lookPointer = event.pointerId;
      pointers.set(event.pointerId, {
        kind: 'look', element: canvas, startX: event.clientX, startY: event.clientY,
        lastX: event.clientX, lastY: event.clientY, started: performance.now(), dragging: false,
      });
      capture(canvas, event.pointerId);
    }, { passive: false });

    listen(global, 'pointermove', event => {
      const state = pointers.get(event.pointerId);
      if (!state) return;
      stop(event);
      if (!isPlaying()) { reset(); return; }
      if (state.kind === 'move') updateStick(event, state);
      if (state.kind !== 'look') return;
      let dx = event.clientX - state.lastX;
      let dy = event.clientY - state.lastY;
      if (!state.dragging && Math.hypot(event.clientX - state.startX, event.clientY - state.startY) >= 6) {
        state.dragging = true;
        dx = event.clientX - state.startX;
        dy = event.clientY - state.startY;
        const rect = canvas.getBoundingClientRect();
        emit('onAim', rect.left + rect.width / 2, rect.top + rect.height / 2);
      }
      state.lastX = event.clientX;
      state.lastY = event.clientY;
      if (state.dragging && (dx || dy)) emit('onLook', dx, dy);
    }, { passive: false });

    listen(global, 'pointerup', event => {
      const state = pointers.get(event.pointerId);
      if (!state) return;
      stop(event);
      if (state.kind === 'look') {
        state.lastX = event.clientX;
        state.lastY = event.clientY;
      }
      clearPointer(event.pointerId, false);
    }, { passive: false });
    listen(global, 'pointercancel', event => {
      if (!pointers.has(event.pointerId)) return;
      stop(event);
      clearPointer(event.pointerId, true);
    }, { passive: false });
    [canvas, stick, suction, jump].forEach(element => {
      listen(element, 'lostpointercapture', event => clearPointer(event.pointerId, true));
    });

    // Pointer actions fire on press; a keyboard-generated click has detail === 0.
    [suction, jump].forEach(element => {
      listen(element, 'click', event => {
        stop(event);
        if (element === jump && event.detail === 0 && enabled && isPlaying()) {
          emit('onInteract');
          emit('onJump');
        }
      });
    });
    listen(suction, 'keydown', event => {
      if (event.code !== 'Space' && event.code !== 'Enter') return;
      stop(event);
      if (!enabled || !isPlaying() || event.repeat) return;
      keyboardSuction = true;
      emit('onInteract');
      setSuction(true);
    });
    listen(suction, 'keyup', event => {
      if (event.code !== 'Space' && event.code !== 'Enter') return;
      stop(event);
      keyboardSuction = false;
      setSuction(suctionPointer !== null && isPlaying());
    });
    listen(suction, 'blur', () => {
      keyboardSuction = false;
      setSuction(suctionPointer !== null && isPlaying());
    });
    // Mobile browsers may omit compatibility clicks for a second finger, or
    // deliver one after pointerup. Execute tap actions once on pointerdown and
    // consume only that touch's compatibility click before desktop handlers.
    const bindTapAction = (element, action, legacyClick) => {
      let lastTouchTime = -Infinity;
      listen(element, 'pointerdown', event => {
        if (!isTouch(event)) return;
        stop(event);
        setEnabled(true);
        lastTouchTime = performance.now();
        action();
      }, { passive: false });
      listen(element, 'click', event => {
        const touchClick = isTouch(event) || event.sourceCapabilities?.firesTouchEvents;
        const oldBrowserTouchClick = !event.pointerType && event.detail > 0 &&
          performance.now() - lastTouchTime < 900;
        if (touchClick || oldBrowserTouchClick) {
          stop(event);
          event.stopImmediatePropagation();
          return;
        }
        if (legacyClick) return;
        stop(event);
        action();
      }, { capture: true });
    };
    bindTapAction(resetCamera, () => {
      if (!enabled || !isPlaying()) return;
      emit('onInteract');
      emit('onResetCamera');
    });
    bindTapAction(helpToggle, () => {
      if (!enabled || !coach) return;
      if (coach.hidden) showCoach(true);
      else dismissCoach();
    });
    bindTapAction(coachClose, dismissCoach);
    bindTapAction(byId('pause'), () => emit('onPause'), true);
    bindTapAction(byId('sound-toggle'), () => emit('onToggleSound'), true);

    const viewportChanged = () => {
      reset();
      const smallTouchScreen = navigator.maxTouchPoints > 0 && Math.min(global.innerWidth, global.innerHeight) <= 1024;
      if (coarse.matches || smallTouchScreen) setEnabled(true);
      refresh();
    };
    listen(global, 'blur', reset);
    listen(global, 'pagehide', reset);
    listen(global, 'orientationchange', viewportChanged);
    listen(global, 'resize', viewportChanged);
    listen(document, 'visibilitychange', () => { if (document.hidden) reset(); });
    listen(coarse, 'change', viewportChanged);

    setSuction(false);
    showCoach(false);
    viewportChanged();

    return {
      get enabled() { return enabled; },
      reset,
      refresh,
      destroy() {
        if (destroyed) return;
        reset();
        showCoach(false);
        destroyed = true;
        listeners.splice(0).forEach(remove => remove());
        if (panel) panel.hidden = true;
        document.body.classList.remove('touch-controls');
        if (enabled) emit('onModeChange', false);
        enabled = false;
      },
    };
  };
})(window);
