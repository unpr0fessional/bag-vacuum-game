/* A fixed-length hose, sampled once per pose and shared by rendering and gameplay. */
(function (global) {
  'use strict';
  const THREE = global.THREE;
  const V3 = THREE.Vector3;
  const EPS = 1e-9;

  class FixedLengthHoseCurve extends THREE.Curve {
    constructor(samples = 96) {
      super();
      this.type = 'FixedLengthHoseCurve';
      this.samples = Math.max(32, Math.floor(samples));
      this.points = Array.from({ length: this.samples * 2 + 2 }, () => new V3());
      this.cumulativeLengths = new Float64Array(this.points.length);
      this._bump = new Float64Array(this.samples + 1);
      for (let i = 0; i <= this.samples; i++) {
        const t = i / this.samples;
        this._bump[i] = 16 * t * t * (1 - t) * (1 - t);
      }
      const span = () => ({
        p0: new V3(), p1: new V3(), p2: new V3(), p3: new V3(),
        base: new Float64Array((this.samples + 1) * 3),
        bend: new V3(), sag: 0, length: 0
      });
      this._rear = span();
      this._front = span();
      this._axis = new V3(0, 0, 1);
      this._forward = new V3(0, 0, 1);
      this._gripStart = new V3();
      this._gripEnd = new V3();
      this._desired = new V3();
      this._tip = new V3();
      this._tangentA = new V3();
      this._tangentB = new V3();
      this._length = 1;
      this._result = { tip: this._tip, outOfReach: false, length: 1, rearLength: 0, frontLength: 1 };
      // TubeGeometry asks for points before the first game update.
      for (let i = 0; i < this.points.length; i++) {
        this.points[i].set(0, 0, i / (this.points.length - 1));
        this.cumulativeLengths[i] = i / (this.points.length - 1);
      }
    }

    _buildBase(span) {
      const { p0, p1, p2, p3, base } = span;
      for (let i = 0; i <= this.samples; i++) {
        const t = i / this.samples, s = 1 - t;
        const a = s * s * s, b = 3 * s * s * t, c = 3 * s * t * t, d = t * t * t;
        const j = i * 3;
        base[j] = a * p0.x + b * p1.x + c * p2.x + d * p3.x;
        base[j + 1] = a * p0.y + b * p1.y + c * p2.y + d * p3.y;
        base[j + 2] = a * p0.z + b * p1.z + c * p2.z + d * p3.z;
      }
      return this._spanLength(span, 0);
    }

    _spanLength(span, sag) {
      const { base, bend } = span;
      let lastX = base[0], lastY = base[1], lastZ = base[2], length = 0;
      for (let i = 1; i <= this.samples; i++) {
        const j = i * 3, offset = this._bump[i] * sag;
        const x = base[j] + bend.x * offset;
        const y = base[j + 1] + bend.y * offset;
        const z = base[j + 2] + bend.z * offset;
        const dx = x - lastX, dy = y - lastY, dz = z - lastZ;
        length += Math.sqrt(dx * dx + dy * dy + dz * dz);
        lastX = x; lastY = y; lastZ = z;
      }
      return length;
    }

    _fitSlack(span, budget) {
      const baseLength = this._spanLength(span, 0);
      if (budget <= baseLength + 1e-9) {
        span.sag = 0;
        span.length = baseLength;
        return;
      }
      let low = 0, high = Math.max(0.025, budget * 0.5);
      while (this._spanLength(span, high) < budget) high *= 2;
      // Length is convex in the bump amplitude. Starting below the budget
      // brackets its increasing root even when a tiny bump first straightens a bend.
      for (let i = 0; i < 27; i++) {
        const middle = (low + high) * 0.5;
        if (this._spanLength(span, middle) > budget) high = middle;
        else low = middle;
      }
      span.sag = (low + high) * 0.5;
      span.length = this._spanLength(span, span.sag);
    }

    _frontBase(fraction, budget) {
      const span = this._front;
      span.p0.copy(this._gripEnd);
      span.p3.lerpVectors(this._gripEnd, this._desired, fraction);
      const distance = span.p0.distanceTo(span.p3);
      // A small asymmetric loop keeps coincident targets well-defined.
      const handle = Math.min(0.055, budget * 0.055) + distance * 0.18;
      span.p1.copy(span.p0).addScaledVector(this._axis, handle);
      span.p2.copy(span.p3);
      span.p2.y += handle * 0.8;
      return this._buildBase(span);
    }

    solve({ outlet, hand, axis, front, target, length = 2.42, rearLength = 1.25, gripLength = 0.17 }) {
      if (!(Number.isFinite(length) && length > 0 && Number.isFinite(gripLength) && gripLength >= 0 && gripLength < length)) {
        throw new RangeError('FixedLengthHoseCurve requires 0 <= gripLength < length.');
      }
      for (const point of [outlet, hand, target, axis, front]) {
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) {
          throw new TypeError('FixedLengthHoseCurve requires finite outlet, hand, target, axis and front vectors.');
        }
      }
      this._axis.copy(axis);
      if (this._axis.lengthSq() < EPS) this._axis.set(0, 0, 1);
      else this._axis.normalize();
      this._forward.copy(front).setY(0);
      if (this._forward.lengthSq() < EPS) this._forward.set(0, 0, 1);
      else this._forward.normalize();
      this._gripStart.copy(hand).addScaledVector(this._axis, -gripLength * 0.5);
      this._gripEnd.copy(hand).addScaledVector(this._axis, gripLength * 0.5);
      this._desired.copy(target);

      const rear = this._rear, forward = this._front;
      const freeLength = length - gripLength;
      const rearChord = outlet.distanceTo(this._gripStart);
      if (rearChord > freeLength + 1e-8) {
        throw new RangeError('Hose length is shorter than the outlet-to-hand distance plus its grip.');
      }
      rear.p0.copy(outlet);
      rear.p3.copy(this._gripStart);
      const rearHandle = Math.min(0.18, rearChord * 0.24);
      rear.p1.copy(outlet).addScaledVector(this._forward, rearHandle);
      rear.p2.copy(this._gripStart).addScaledVector(this._axis, -rearHandle);
      rear.bend.copy(this._forward).multiplyScalar(0.4).setY(-1).normalize();
      let rearMinimum = this._buildBase(rear);
      // An unusual arm pose may need the rest of the hose. Reduce the rear
      // tangent handles only when even borrowing the entire front cannot fit.
      if (rearMinimum > freeLength) {
        let low = 0, high = 1;
        for (let i = 0; i < 27; i++) {
          const factor = (low + high) * 0.5;
          rear.p1.copy(outlet).addScaledVector(this._forward, rearHandle * factor);
          rear.p2.copy(this._gripStart).addScaledVector(this._axis, -rearHandle * factor);
          if (this._buildBase(rear) > freeLength) high = factor;
          else low = factor;
        }
        rear.p1.copy(outlet).addScaledVector(this._forward, rearHandle * low);
        rear.p2.copy(this._gripStart).addScaledVector(this._axis, -rearHandle * low);
        rearMinimum = this._buildBase(rear);
      }
      const requestedRear = Number.isFinite(rearLength) ? rearLength : 1.25;
      const rearBudget = Math.min(freeLength, Math.max(rearMinimum, requestedRear));
      this._fitSlack(rear, rearBudget);
      let lowest = Infinity;
      for (let i = 0; i <= this.samples; i++) {
        lowest = Math.min(lowest, rear.base[i * 3 + 1] + rear.bend.y * this._bump[i] * rear.sag);
      }
      // Store excess behind the hand as a forward loop instead of pushing it
      // through the floor. The grip and bag port stay in exactly the same place.
      if (lowest < 0.045) {
        rear.bend.copy(this._forward).setY(0.15).normalize();
        this._fitSlack(rear, rearBudget);
      }

      const frontBudget = Math.max(0, freeLength - rearBudget);
      forward.bend.copy(this._forward).multiplyScalar(0.18).setY(1).normalize();
      const desiredBaseLength = this._frontBase(1, frontBudget);
      let fraction = 1;
      if (desiredBaseLength > frontBudget + 1e-9) {
        let low = 0, high = 1;
        for (let i = 0; i < 25; i++) {
          const middle = (low + high) * 0.5;
          if (this._frontBase(middle, frontBudget) > frontBudget) high = middle;
          else low = middle;
        }
        fraction = low;
        this._frontBase(fraction, frontBudget);
      }
      this._fitSlack(forward, frontBudget);
      this._tip.copy(forward.p3);

      let index = 0;
      for (let i = 0; i <= this.samples; i++, index++) {
        const j = i * 3;
        this.points[index].set(rear.base[j], rear.base[j + 1], rear.base[j + 2]);
        this.points[index].addScaledVector(rear.bend, this._bump[i] * rear.sag);
      }
      this.points[index++].copy(this._gripEnd);
      for (let i = 1; i <= this.samples; i++, index++) {
        const j = i * 3;
        this.points[index].set(forward.base[j], forward.base[j + 1], forward.base[j + 2]);
        this.points[index].addScaledVector(forward.bend, this._bump[i] * forward.sag);
      }
      this.cumulativeLengths[0] = 0;
      for (let i = 1; i < this.points.length; i++) {
        this.cumulativeLengths[i] = this.cumulativeLengths[i - 1] + this.points[i].distanceTo(this.points[i - 1]);
      }
      this._length = this.cumulativeLengths[this.points.length - 1];
      this._result.outOfReach = this._tip.distanceToSquared(target) > 0.000001;
      this._result.length = this._length;
      this._result.rearLength = rear.length;
      this._result.frontLength = forward.length;
      return this._result;
    }

    _segment(distance) {
      let low = 0, high = this.cumulativeLengths.length - 1;
      while (low + 1 < high) {
        const middle = (low + high) >>> 1;
        if (this.cumulativeLengths[middle] <= distance) low = middle;
        else high = middle;
      }
      return low;
    }

    getPoint(t, target = new V3()) { return this.getPointAt(t, target); }

    getPointAt(u, target = new V3()) {
      const distance = THREE.MathUtils.clamp(u, 0, 1) * this._length;
      const index = this._segment(distance);
      const start = this.cumulativeLengths[index], end = this.cumulativeLengths[index + 1];
      return target.lerpVectors(this.points[index], this.points[index + 1], end > start ? (distance - start) / (end - start) : 0);
    }

    getTangent(t, target = new V3()) { return this.getTangentAt(t, target); }

    getTangentAt(u, target = new V3()) {
      // A small symmetric finite difference smooths the sampled span joins.
      const delta = Math.min(0.0005, 0.001 / Math.max(this._length, 0.001));
      const t = THREE.MathUtils.clamp(u, 0, 1);
      this.getPointAt(Math.max(0, t - delta), this._tangentA);
      this.getPointAt(Math.min(1, t + delta), this._tangentB);
      target.subVectors(this._tangentB, this._tangentA);
      if (target.lengthSq() < EPS * EPS) return target.copy(this._axis);
      return target.normalize();
    }

    getLength() { return this._length; }
    getUtoTmapping(u, distance) { return distance === undefined ? u : distance / this._length; }
    updateArcLengths() { this.needsUpdate = false; }
  }

  global.FixedLengthHoseCurve = FixedLengthHoseCurve;
})(window);
