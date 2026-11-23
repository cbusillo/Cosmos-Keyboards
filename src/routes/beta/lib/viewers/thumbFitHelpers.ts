import type { SolvedHand } from '$lib/hand'
import { ballCenterUnderThumb, type ThumbRest, thumbRest, type ThumbRestOptions } from '$lib/thumbfit'
import type { Cuttleform, CuttleKey } from '$lib/worker/config'
import { type CosmosKeyboard, mirrorCluster, nthPartType, sortClusters } from '$lib/worker/config.cosmos'
import { keyPosition } from '$lib/worker/modeling/transformation-ext'
import { Matrix4, Vector3 } from 'three'
import { type HandSide, transformationCenter } from './viewer3dHelpers'

/** The trackball part's origin is this far above the ball's center (see trackball-gen.ts). */
const BALL_CENTER_BELOW_ORIGIN = 4

export interface ThumbFit {
  rest: ThumbRest
  /** Where the ball's center should go, in world coordinates. */
  target: Vector3
  /** Where the ball's center is now, in world coordinates. */
  current: Vector3
  diameter: number
}

const isTrackball = (k: CuttleKey) => k.type == 'trackball'

/** Center of a trackball key, in the config's frame (a split's left half is mirrored into the right's). */
function ballCenter(c: Cuttleform, k: CuttleKey) {
  return keyPosition(c, k, false).pretranslated(0, 0, -BALL_CENTER_BELOW_ORIGIN).origin()
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
  const diameter = parseFloat((ball as any).variant?.size) || 34
  return {
    rest,
    target: ballCenterUnderThumb(rest, diameter),
    current: mirror(ballCenter(conf, ball), side, isUnibody),
    diameter,
  }
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
        if (cluster.side == side && nthPartType(proto, i, 'key') == 'trackball') found.push(i)
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
