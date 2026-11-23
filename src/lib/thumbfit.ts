/**
 * Thumb fitting: where a scanned thumb comes to rest when the fingers sit on the home row,
 * and where a trackball should go so it lands under that thumb.
 *
 * The rest of the viewer drags the thumb onto a chosen "home" thumb key. This module works the
 * other way round: it poses the thumb from the hand scan alone, then reports where the ball belongs.
 *
 * Model (see hand.ts for the joint frames):
 * - Hand frame: x runs toward the fingertips, +y is the palm side, and flexion is a negative
 *   rotation about each joint's z axis, for fingers and thumb alike.
 * - The thumb's scanned joint frames (all angles zero) are the averaged scan posture, which is
 *   fairly straight. A resting thumb is slightly bent, so by default its three movable joints are
 *   flexed by REST_FLEXION_DEG. `curl` scales that bend, and `swing` moves the thumb toward (+) or
 *   away from (-) the index finger at its middle joint, the only thumb joint the model lets move
 *   side to side. These are starting points, not measurements:
 *   the scan records bone lengths and joint axes, not how a person likes to hold their thumb.
 * - The ball touches the thumb pad: a point on the palm side of the last thumb bone.
 *   The ball's center sits one radius further along the direction the pad presses.
 *
 * Licensed under the AGPL-3.0, like the rest of Cosmos. See the LICENSE file.
 */

import { Vector3 } from 'three'
import type { SolvedHand } from './hand'

/** How far from the last thumb joint, as a fraction of the last bone, the pad's center sits. */
const PAD_ALONG_BONE = 0.55
/** Depth from the thumb bone's axis to the skin of the pad, in mm. */
export const THUMB_PAD_DEPTH = 7
/** Default resting flexion of the thumb's base, middle and last joints, in degrees. */
const REST_FLEXION_DEG = [15, 20, 15]

export interface ThumbRestOptions {
  /** Multiplier on the default resting flexion. 1 is the default; 0 is the straight scan posture. */
  curl: number
  /** Side-to-side rotation at the thumb's middle joint, in degrees. Positive moves it toward the index finger. */
  swing: number
}

export const DEFAULT_THUMB_REST: ThumbRestOptions = { curl: 1, swing: 0 }

export interface ThumbRest {
  /** Joint positions from the wrist to the thumb tip, in world coordinates (mm). */
  joints: Vector3[]
  /** Center of the thumb pad's skin, in world coordinates. */
  pad: Vector3
  /** Unit direction the pad presses in, in world coordinates. */
  press: Vector3
}

/** Sign of a side-to-side rotation that moves the thumb toward the index finger. */
function towardIndex(hand: SolvedHand, flexion: number[]) {
  const index = hand.worldPositions('indexFinger', 1000)[1]
  const tipAt = (swing: number) => poseThumb(hand, flexion, swing)[4].distanceTo(index)
  return tipAt(0.05) < tipAt(-0.05) ? 1 : -1
}

function poseThumb(hand: SolvedHand, flexion: number[], swing: number) {
  hand.fkBy('thumb', (i) => (i == 0 ? [0, 0] : [flexion[i - 1], i == 2 ? swing : 0]))
  return hand.worldPositions('thumb', 1000)
}

function padPoint(joints: Vector3[], palmSide: Vector3) {
  const ip = joints[3]
  const tip = joints[4]
  return new Vector3().lerpVectors(ip, tip, PAD_ALONG_BONE).addScaledVector(palmSide, THUMB_PAD_DEPTH)
}

/**
 * Pose a hand's thumb at rest, leaving the hand's thumb in that pose.
 *
 * @param hand A hand already placed with its fingers on the home row; only its thumb is changed.
 */
export function thumbRest(hand: SolvedHand, opts = DEFAULT_THUMB_REST): ThumbRest {
  const flexion = REST_FLEXION_DEG.map((d) => (-d * opts.curl * Math.PI) / 180)
  const swing = towardIndex(hand, flexion) * (opts.swing * Math.PI) / 180

  // The direction the pad presses is the way the thumb tip moves as the last joint bends further.
  const DELTA = 0.02
  const moved = poseThumb(hand, [flexion[0], flexion[1], flexion[2] - DELTA], swing)
  const rest = poseThumb(hand, flexion, swing)

  const boneDir = new Vector3().subVectors(rest[4], rest[3]).normalize()
  const press = new Vector3().subVectors(moved[4], rest[4])
  press.addScaledVector(boneDir, -press.dot(boneDir)).normalize()

  return { joints: rest, pad: padPoint(rest, press), press }
}

/** Where a ball's center goes so that its top touches the thumb pad. */
export function ballCenterUnderThumb(rest: ThumbRest, ballDiameter: number) {
  return new Vector3().copy(rest.pad).addScaledVector(rest.press, ballDiameter / 2)
}

export interface ThumbKeyReach {
  /** Whether the thumb tip can reach the key's top at all. */
  reachable: boolean
  /** How far the key's top is from the resting thumb pad, in mm. */
  travel: number
  /**
   * Where the key's top sits along the direction the resting pad presses, in mm.
   * Positive: past the pad, so the thumb bends further to reach it. Negative: the thumb lifts.
   */
  depth: number
  /** Angle between the key's press direction and the resting pad's, in degrees. 0 presses straight in. */
  pressAngle: number
  /** How straight the thumb must get to reach the key: 1 is fully extended. */
  stretch: number
}

/**
 * How a thumb resting in `rest` gets to a key. The hand's thumb is left in the rest pose afterwards.
 *
 * @param keyTop Center of the keycap's top, in world coordinates.
 * @param keyUp Unit direction out of the keycap's top, in world coordinates.
 */
export function thumbKeyReach(hand: SolvedHand, opts: ThumbRestOptions, keyTop: Vector3, keyUp: Vector3): ThumbKeyReach {
  const rest = thumbRest(hand, opts)
  const base = rest.joints[1]
  const thumbLength = rest.joints.slice(1).reduce((sum, p, i, ps) => (i ? sum + p.distanceTo(ps[i - 1]) : 0), 0)
  const reachable = hand.ik('thumb', keyTop, 1000) !== false
  thumbRest(hand, opts)

  const toKey = new Vector3().subVectors(keyTop, rest.pad)
  const pressDown = keyUp.clone().negate()
  return {
    reachable,
    travel: toKey.length(),
    depth: toKey.dot(rest.press),
    pressAngle: (Math.acos(Math.max(-1, Math.min(1, pressDown.dot(rest.press)))) * 180) / Math.PI,
    stretch: base.distanceTo(keyTop) / thumbLength,
  }
}

/** Space angles at least `step` apart, keeping their order and their average. */
export function spreadAngles(items: { angle: number }[], step: number) {
  if (items.length < 2) return
  const start = items[0].angle
  // Unwrap relative to the first item so a group that straddles ±180° stays together.
  for (const it of items) it.angle = start + Math.atan2(Math.sin(it.angle - start), Math.cos(it.angle - start))
  items.sort((a, b) => a.angle - b.angle)
  const mean = items.reduce((a, it) => a + it.angle, 0) / items.length
  for (let i = 1; i < items.length; i++) items[i].angle = Math.max(items[i].angle, items[i - 1].angle + step)
  const shift = mean - items.reduce((a, it) => a + it.angle, 0) / items.length
  for (const it of items) it.angle += shift
}
