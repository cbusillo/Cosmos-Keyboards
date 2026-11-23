import { expect, test } from 'bun:test'
import { Matrix4, Vector3 } from 'three'
import { type Finger, type Joint, type Joints, SolvedHand } from './hand'
import { DEFAULT_THUMB_REST, thumbRest } from './thumbfit'

/** A finger whose bones run straight from its base, pointing along `dir` in the hand's xz plane. */
function finger(base: Vector3, angle: number, degrees: [1 | 2, 1 | 2, 1 | 2]): Joint[] {
  const Vinv = new Matrix4().makeRotationY(-angle)
  return [
    { length: base.length() / 1000, degree: 0, position: base.clone().normalize(), Vinv, V: Vinv.clone().invert() },
    ...degrees.map((degree) => ({ length: 0.03, degree, Vinv: new Matrix4(), V: new Matrix4() })),
  ]
}

function syntheticHand() {
  const joints: Joints = {
    thumb: finger(new Vector3(30, 0, 30), Math.PI / 4, [1, 2, 1]),
    indexFinger: finger(new Vector3(90, 0, 20), 0, [2, 1, 1]),
    middleFinger: finger(new Vector3(90, 0, 0), 0, [2, 1, 1]),
    ringFinger: finger(new Vector3(85, 0, -18), 0, [2, 1, 1]),
    pinky: finger(new Vector3(75, 0, -34), 0, [2, 1, 1]),
  } satisfies Record<Finger, Joint[]>
  return new SolvedHand(joints, new Matrix4())
}

test('swinging the thumb toward the index finger brings it closer', () => {
  const hand = syntheticHand()
  const index = hand.worldPositions('indexFinger', 1000)[1]
  const tip = (swing: number) => thumbRest(hand, { ...DEFAULT_THUMB_REST, swing }).joints[4]
  expect(tip(20).distanceTo(index)).toBeLessThan(tip(0).distanceTo(index))
  expect(tip(-20).distanceTo(index)).toBeGreaterThan(tip(0).distanceTo(index))
})

test('bending the thumb more moves its pad the way the pad presses', () => {
  const hand = syntheticHand()
  const rest = thumbRest(hand, { ...DEFAULT_THUMB_REST, curl: 1 })
  const bent = thumbRest(hand, { ...DEFAULT_THUMB_REST, curl: 1.3 })
  const lastBone = new Vector3().subVectors(rest.joints[4], rest.joints[3]).normalize()
  expect(Math.abs(rest.press.dot(lastBone))).toBeLessThan(1e-6)
  expect(new Vector3().subVectors(bent.pad, rest.pad).dot(rest.press)).toBeGreaterThan(0)
})
