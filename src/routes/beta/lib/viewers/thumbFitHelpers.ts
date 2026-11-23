import type { SolvedHand } from '$lib/hand'
import { ballCenterUnderThumb, spreadAngles, type ThumbKeyReach, thumbKeyReach, type ThumbRest, thumbRest, type ThumbRestOptions } from '$lib/thumbfit'
import type { Cuttleform, CuttleKey } from '$lib/worker/config'
import { type CosmosKeyboard, cosmosKeyPosition, mirrorCluster, nthKey, nthPartType, sortClusters } from '$lib/worker/config.cosmos'
import { keyPosition, keyPositionTop } from '$lib/worker/modeling/transformation-ext'
import { Matrix4, Vector3 } from 'three'
import { type HandSide, transformationCenter } from './viewer3dHelpers'

/** Trackball parts, and how far each part's origin sits above its ball's center (see simpleparts.ts). */
const BALL_CENTER_BELOW_ORIGIN: Record<string, number> = { 'trackball': 4, 'trackball-splitball': 0 }
const isTrackballType = (type: string | undefined) => !!type && type in BALL_CENTER_BELOW_ORIGIN

export interface ThumbFit {
  rest: ThumbRest
  /** Where the ball's center should go, in world coordinates. */
  target: Vector3
  /** Where the ball's center is now, in world coordinates. */
  current: Vector3
  diameter: number
  /** Each thumb key, ordered around the ball. */
  keys: ThumbKey[]
}

export interface ThumbKey extends ThumbKeyReach {
  /** Center of the keycap's top, in world coordinates. */
  top: Vector3
  /** The key's origin (where its switch sits), in world coordinates. */
  origin: Vector3
  /**
   * Sideways gap from the ball's widest point to the keycap's nearest edge, in mm, measured across the
   * direction the thumb presses (roughly; caps are treated as round).
   */
  gapToBall: number
}

/** Half the width of a 1u keycap, in mm. */
const HALF_KEYCAP = 9
/** Width of a key's footprint, the larger of its keycap and switch socket with margin, in mm. */
const KEY_FOOTPRINT = 19
/** Space between neighboring thumb keys' footprints, in mm. */
const KEY_CLEARANCE = 1

const isTrackball = (k: CuttleKey) => isTrackballType(k.type)

/** Center of a trackball key, in the config's frame (a split's left half is mirrored into the right's). */
function ballCenter(c: Cuttleform, k: CuttleKey) {
  return keyPosition(c, k, false).pretranslated(0, 0, -BALL_CENTER_BELOW_ORIGIN[k.type]).origin()
}

const mirror = (v: Vector3, side: HandSide, isUnibody: boolean) => side == 'left' && !isUnibody ? v.setX(-v.x) : v

/**
 * Pose a hand's thumb at rest and find where that side's trackball should go.
 * Returns undefined if the side has no trackball, or more than one.
 */
export function fitThumb(hand: SolvedHand, conf: Cuttleform, side: HandSide, isUnibody: boolean, opts: ThumbRestOptions): ThumbFit | undefined {
  const rest = thumbRest(hand, opts)
  const balls = conf.keys.filter(isTrackball)
  if (balls.length != 1) return undefined
  const ball = balls[0]
  // The Split-Ball only takes a 34 mm ball; the plain trackball names its size.
  const diameter = parseFloat((ball as any).variant?.size) || 34
  const current = mirror(ballCenter(conf, ball), side, isUnibody)
  const keys = conf.keys
    .filter((k) => k.cluster == ball.cluster && 'keycap' in k && !isTrackball(k))
    .map((k) => {
      const trsf = keyPositionTop(conf, k, false)
      const top = mirror(trsf.origin(), side, isUnibody)
      const up = mirror(trsf.pretranslated(0, 0, 1).origin(), side, isUnibody).sub(top).normalize()
      const reach = thumbKeyReach(hand, opts, top, up)
      const origin = mirror(keyPosition(conf, k, false).origin(), side, isUnibody)
      const fromAxis = new Vector3().subVectors(top, current)
      fromAxis.addScaledVector(rest.press, -fromAxis.dot(rest.press))
      return { ...reach, top, origin, gapToBall: fromAxis.length() - diameter / 2 - HALF_KEYCAP }
    })
  const around = (v: Vector3) => Math.atan2(v.y - current.y, (v.x - current.x) * (side == 'left' ? -1 : 1))
  keys.sort((a, b) => around(a.top) - around(b.top))
  return { rest: thumbRest(hand, opts), target: ballCenterUnderThumb(rest, diameter), current, diameter, keys }
}

/**
 * Give the left half its own thumb cluster, copied from the right, if it only mirrors the right.
 * Each hand's thumb rests in its own place, so the two balls can't share one cluster.
 */
export function separateLeftThumbs(proto: CosmosKeyboard) {
  if (proto.unibody || proto.clusters.some((c) => c.side == 'left' && c.name == 'thumbs')) return
  const right = proto.clusters.find((c) => c.side == 'right' && c.name == 'thumbs')
  if (!right) return
  proto.clusters.push(mirrorCluster(right, proto))
  sortClusters(proto.clusters)
}

/** Index (as nthKey counts) of the one trackball on a side of the config, if there is exactly one. */
export function trackballIndex(proto: CosmosKeyboard, side: HandSide): number | undefined {
  const found: number[] = []
  let i = 0
  for (const cluster of proto.clusters) {
    for (const column of cluster.clusters) {
      for (const _ of column.keys) {
        if (cluster.side == side && isTrackballType(nthPartType(proto, i, 'key'))) found.push(i)
        i++
      }
    }
  }
  return found.length == 1 ? found[0] : undefined
}

/** The pose of the cluster holding the n^th key, shifted by `delta`, as the viewer's move tool reports it. */
export function shiftedClusterMatrix(proto: CosmosKeyboard, index: number, delta: Vector3) {
  const m = transformationCenter(index, proto, 'cluster').evaluate({ flat: false }).Matrix4()
  return new Matrix4().makeTranslation(delta.x, delta.y, delta.z).multiply(m)
}

/**
 * The move from the current ball center to the target, in the frame cosmosKeyPosition uses.
 * That frame matches the hands' world frame on both halves: unlike the Cuttleform keys read in
 * fitThumb, the left half's Cosmos clusters are not mirrored.
 */
export function configDelta(fit: ThumbFit) {
  return new Vector3().subVectors(fit.target, fit.current)
}

export interface ArrangeOptions {
  /** Gap from the ball's surface to each keycap's nearest edge, in mm. */
  gap: number
  /** Key tops sit this far past the resting pad, in the direction it presses, in mm. */
  depth: number
  /** Turns the whole group of buttons around the ball, in degrees. */
  turn: number
}

/**
 * The ball's cup is about 4 mm wider than the ball (see socketsParts.ts) and sits level with the key
 * sockets, so a 6 mm gap leaves the sockets clear of it.
 */
export const DEFAULT_ARRANGE: ArrangeOptions = { gap: 6, depth: 3, turn: 0 }

/** World position of the n^th proto key's origin, as cosmosKeyPosition places it. */
function protoKeyMatrix(proto: CosmosKeyboard, n: number) {
  const { key, column, cluster } = nthKey(proto, n)
  return cosmosKeyPosition(key, column, cluster, proto).evaluate({ flat: false }).Matrix4()
}

/**
 * New poses for one side's thumb keys: each keeps its direction around the ball, moves in to
 * `gap` from the ball, sits `depth` past the resting pad, and faces the way the pad presses.
 * Returns proto key indices with matrices for setPose(…, 'key', …).
 */
export function arrangeThumbKeys(proto: CosmosKeyboard, side: HandSide, fit: ThumbFit, opts: ArrangeOptions) {
  const ballIndex = trackballIndex(proto, side)
  if (ballIndex === undefined) return []
  // cosmosKeyPosition and the hands share axes but may differ by a translation; the ball's center anchors it.
  const ballType = nthPartType(proto, ballIndex, 'key')
  const ballCenterProto = new Vector3(0, 0, -BALL_CENTER_BELOW_ORIGIN[ballType]).applyMatrix4(protoKeyMatrix(proto, ballIndex))
  const toProto = new Vector3().subVectors(ballCenterProto, fit.current)
  const indices: number[] = []
  let i = 0
  for (const cluster of proto.clusters) {
    for (const column of cluster.clusters) {
      for (const _ of column.keys) {
        if (cluster.side == side && cluster.name == 'thumbs' && i != ballIndex && !isTrackballType(nthPartType(proto, i, 'key'))) indices.push(i)
        i++
      }
    }
  }
  const press = fit.rest.press
  const pad = fit.rest.pad
  const radius = fit.diameter / 2 + opts.gap + HALF_KEYCAP

  // Directions around the ball, measured in the plane across the press direction.
  const u = new Vector3().subVectors(fit.keys[0]?.top ?? pad, fit.current)
  u.addScaledVector(press, -u.dot(press)).normalize()
  const v = new Vector3().crossVectors(press, u)
  const angleOf = (p: Vector3) => {
    const d = new Vector3().subVectors(p, fit.current)
    return Math.atan2(d.dot(v), d.dot(u))
  }

  const keys = indices.flatMap((index) => {
    const m = protoKeyMatrix(proto, index)
    // Match the proto key with the analyzed key at the same place, in world space.
    const origin = new Vector3().setFromMatrixPosition(m).sub(toProto)
    const key = fit.keys.reduce((best, k) => (k.origin.distanceTo(origin) < best.origin.distanceTo(origin) ? k : best), fit.keys[0])
    return key ? [{ index, m, key, angle: angleOf(key.top) }] : []
  })
  // Neighbors fan out from the ball, so their inner corners are closest: space them for that edge.
  const innerRadius = radius - KEY_FOOTPRINT / 2
  spreadAngles(keys, 2 * Math.asin(Math.min(1, (KEY_FOOTPRINT + KEY_CLEARANCE) / (2 * innerRadius))))

  return keys.map(({ index, m, key, angle: spread }) => {
    // The left hand is a mirror image, so the same turn goes the other way around its ball.
    const angle = spread + ((side == 'left' ? -1 : 1) * opts.turn * Math.PI) / 180
    const out = u.clone().multiplyScalar(Math.cos(angle)).addScaledVector(v, Math.sin(angle))
    const targetTop = pad.clone().addScaledVector(press, opts.depth).addScaledVector(out, radius)

    // Face the key along the press, with its rows running out from the ball so neighbors meet edge to edge.
    const current = new Matrix4().extractRotation(m)
    const z = press.clone().negate()
    const y = out
    const x = new Vector3().crossVectors(y, z)
    if (current.determinant() < 0) x.negate()
    const turn = new Matrix4().makeBasis(x, y, z).multiply(current.clone().transpose())

    const topProto = key.top.clone().add(toProto)
    const targetProto = targetTop.clone().add(toProto)
    const move = new Matrix4().makeTranslation(targetProto.x, targetProto.y, targetProto.z)
      .multiply(turn)
      .multiply(new Matrix4().makeTranslation(-topProto.x, -topProto.y, -topProto.z))
    return { index, matrix: move.multiply(m) }
  })
}
