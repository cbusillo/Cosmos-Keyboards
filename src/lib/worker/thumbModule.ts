/**
 * Removable thumb module: each half's case and bottom plate are cut along a vertical seam between the
 * finger keys and the thumb keys, so the thumb cluster prints as its own piece.
 *
 * Two straps under the seam join the two halves of the bottom plate. Each strap bolts to the main
 * plate through a snug hole and to the module plate through an oversized hole under a large washer,
 * so the module can slide and turn a few millimeters before the bolts are tightened. Shims between a
 * strap and the module plate raise or tilt the module. For bigger changes, edit the thumb cluster and
 * reprint only the module.
 *
 * Everything here works in the plate's own frame: u along geo.worldX, v along geo.worldY.
 *
 * Licensed under the AGPL-3.0, like the rest of Cosmos. See the LICENSE file.
 */

import { socketSize } from '$lib/geometry/socketsParts'
import { draw, drawPolysides, makeBox, makeCylinder, type Solid } from 'replicad'
import type { Cuttleform, CuttleKey, Geometry } from './config'
import { combine } from './modeling'
import { Splitter } from './modeling/splitter'
import Trsf, { Vector } from './modeling/transformation'

/** Clearance kept between the seam and any switch socket, in mm. */
const SOCKET_CLEARANCE = 0.5

/** M3 hardware holding the straps to the plates. */
export const STRAP = {
  thickness: 5,
  width: 16,
  /** Bolt distance from the seam on each side, in mm. */
  boltFromSeam: 10,
  holeDiameter: 3.4,
  /** The module-side hole leaves this much play in every direction, in mm. */
  play: 4,
  /** Distance from the plate's edge to each strap, along the seam, in mm. */
  inset: 14,
  bossDiameter: 9,
  bossHeight: 4.5,
  nutAcrossFlats: 5.7, // M3 nut is 5.5 mm across flats, plus printing clearance
  nutDepth: 2.8, // M3 nut is 2.4 mm thick
}

export interface Seam {
  /** Unit direction across the seam, from the finger keys toward the thumb keys. */
  normal: [number, number]
  /** Unit direction along the seam. */
  along: [number, number]
  /**
   * The seam's center line bends around the keys: at each distance t along the seam, its center sits
   * s across it. Points are [t, s], sorted by t, in mm.
   */
  profile: [number, number][]
  gap: number
}

export type SeamResult = { seam: Seam } | { error: string }

const isThumb = (k: CuttleKey) => k.cluster == 'thumbs'

/** Points outlining a key's socket (top and bottom, edges sampled), in the key's own frame. */
function socketOutline(k: CuttleKey): [number, number, number][] {
  const size = socketSize(k)
  const pts: [number, number, number][] = []
  if (Array.isArray(size)) {
    const [w, h, d] = size
    const N = 6
    for (const z of [-d, 0]) {
      for (let i = 0; i < N; i++) {
        const f = i / N
        pts.push([-w / 2 + w * f, -h / 2, z], [w / 2, -h / 2 + h * f, z], [w / 2 - w * f, h / 2, z], [-w / 2, h / 2 - h * f, z])
      }
    }
    return pts
  }
  const n = 32
  for (const z of [-size.height, 0]) {
    for (let i = 0; i < n; i++) pts.push([size.radiusX * Math.cos((2 * Math.PI * i) / n), size.radiusY * Math.sin((2 * Math.PI * i) / n), z])
  }
  return pts
}

/** Center-line offset across the seam at distance t along it. */
export function seamOffsetAt(seam: Seam, t: number) {
  const p = seam.profile
  if (t <= p[0][0]) return p[0][1]
  if (t >= p[p.length - 1][0]) return p[p.length - 1][1]
  let i = 1
  while (p[i][0] < t) i++
  const [t0, s0] = p[i - 1]
  const [t1, s1] = p[i]
  return s0 + ((t - t0) / (t1 - t0)) * (s1 - s0)
}

const toSeam = (seam: Seam, p: [number, number]) => [p[0] * seam.along[0] + p[1] * seam.along[1], p[0] * seam.normal[0] + p[1] * seam.normal[1]] as [number, number]
const fromSeam = (seam: Seam, t: number, s: number) => [seam.along[0] * t + seam.normal[0] * s, seam.along[1] * t + seam.normal[1] * s] as [number, number]

/** Where the case splits, or why it can't. */
export function thumbSeam(c: Cuttleform, geo: Geometry): SeamResult {
  const tm = c.thumbModule
  if (!tm) return { error: 'No thumb module' }
  if (c.shell.type != 'basic' || c.shell.lip) return { error: 'The thumb module needs the Default case without a lip.' }
  const toPlate = (v: Vector) => [v.dot(geo.worldX), v.dot(geo.worldY)] as [number, number]
  const keyed = c.keys.map((k, i) => ({
    k,
    p: toPlate(geo.keyHolesTrsfs[i].origin()),
    outline: socketOutline(k).map(pt => toPlate(geo.keyHolesTrsfs[i].apply(new Vector(...pt)))),
  }))
  const thumbs = keyed.filter(({ k }) => isThumb(k))
  const fingers = keyed.filter(({ k }) => !isThumb(k) && k.cluster != 'center')
  if (!thumbs.length || !fingers.length) return { error: 'The thumb module needs both thumb keys and finger keys on this half.' }

  // Main direction: the straight seam angle (within 80 degrees of straight between the groups) that
  // leaves the most room, turned by the configured angle.
  const mean = (pts: { p: [number, number] }[]) => pts.reduce((a, { p }) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length], [0, 0])
  const [tx, ty] = mean(thumbs)
  const [fx, fy] = mean(fingers)
  const toward = Math.atan2(ty - fy, tx - fx)
  const room = (angle: number) => {
    const dot = (p: [number, number]) => p[0] * Math.cos(angle) + p[1] * Math.sin(angle)
    return Math.min(...thumbs.flatMap(({ outline }) => outline.map(dot))) - Math.max(...fingers.flatMap(({ outline }) => outline.map(dot)))
  }
  let best = toward
  for (let d = -80; d <= 80; d += 1) {
    const a = toward + (d * Math.PI) / 180
    if (room(a) > room(best)) best = a
  }
  const base = best + (tm.angle * Math.PI) / 180
  const normal: [number, number] = [Math.cos(base), Math.sin(base)]
  const along: [number, number] = [-normal[1], normal[0]]
  const frame = { normal, along, profile: [], gap: tm.gap } as Seam

  const fingerPts = fingers.flatMap(({ outline }) => outline.map(p => toSeam(frame, p)))
  const thumbPts = thumbs.flatMap(({ outline }) => outline.map(p => toSeam(frame, p)))
  const all = [...fingerPts, ...thumbPts]
  const tMin = Math.min(...all.map(p => p[0])) - 80
  const tMax = Math.max(...all.map(p => p[0])) + 80
  const half = tm.gap / 2 + SOCKET_CLEARANCE

  // In strips along the seam, center it between the nearest finger and thumb sockets.
  const STEP = 2
  // Center the seam where the nearest finger socket and the nearest thumb socket are equally far away,
  // a dividing line between the two groups. Past the keys it heads out between them, so each group's
  // walls stay with it instead of being sliced lengthwise.
  const nearest = (pts: [number, number][], t: number, s: number) => {
    let best = Infinity
    for (const [pt, ps] of pts) {
      const d = (pt - t) * (pt - t) + (ps - s) * (ps - s)
      if (d < best) best = d
    }
    return Math.sqrt(best)
  }
  const balance = (t: number, s: number) => nearest(fingerPts, t, s) - nearest(thumbPts, t, s)
  const sLo = Math.min(...all.map(p => p[1])) - 80
  const sHi = Math.max(...all.map(p => p[1])) + 80
  const ts: number[] = []
  const filled: number[] = []
  for (let t = tMin; t <= tMax; t += STEP) {
    ts.push(t)
    // Walk from the finger side toward the thumb side until the thumbs become nearer, then refine.
    let lo = sLo
    let hi = sHi
    for (let s = sLo; s <= sHi; s += 4) {
      if (balance(t, s) > 0) {
        hi = s
        lo = s - 4
        break
      }
    }
    for (let k = 0; k < 8; k++) {
      const mid = (lo + hi) / 2
      if (balance(t, mid) > 0) hi = mid
      else lo = mid
    }
    filled.push((lo + hi) / 2)
  }
  // Smooth the bends a little so the seam is easy to print.
  const smooth = filled.map((_, i) => {
    const w = filled.slice(Math.max(0, i - 2), i + 3)
    return w.reduce((a, b) => a + b, 0) / w.length
  })
  // Keep each strip clear of the sockets beside it; interpolating between two clear strips stays clear.
  const bounded = smooth.map((s, i) => {
    const t = ts[i]
    const near = (pts: [number, number][]) => pts.filter(p => Math.abs(p[0] - t) <= STEP).map(p => p[1])
    const lo = Math.max(-Infinity, ...near(fingerPts).map(v => v + half))
    const hi = Math.min(Infinity, ...near(thumbPts).map(v => v - half))
    const v = s + tm.offset
    return lo <= hi ? Math.min(Math.max(v, lo), hi) : (lo + hi) / 2
  })
  const seam: Seam = { ...frame, profile: ts.map((t, i) => [t, bounded[i]]) }

  // Every socket must sit fully on its own side, clear of the seam.
  const worstFinger = Math.max(...fingerPts.map(([t, s]) => s - seamOffsetAt(seam, t)))
  const worstThumb = Math.min(...thumbPts.map(([t, s]) => s - seamOffsetAt(seam, t)))
  if (worstFinger > -half || worstThumb < half) {
    const space = worstThumb - worstFinger - 2 * SOCKET_CLEARANCE
    return {
      error: space <= 0
        ? `A thumb key and a finger key sit too close for a seam here. Move the thumb cluster about ${(tm.gap - space).toFixed(0)} mm away from the fingers, or turn the seam.`
        : `The seam needs ${tm.gap} mm but the keys leave about ${space.toFixed(0)} mm where they are closest. Narrow the seam, adjust its offset, or move the thumb cluster.`,
    }
  }
  return { seam }
}

/** Maps plate coordinates (u, v, height above the plate's top) to world coordinates. */
function plateToWorld(geo: Geometry) {
  return new Trsf().coordSystemChange(new Vector(), geo.worldX, geo.worldZ).pretranslate(0, 0, geo.bottomZ)
}

/** A tall prism covering one side of the seam, in world coordinates. */
function sidePrism(geo: Geometry, seam: Seam, side: 'main' | 'module') {
  const L = 1000
  const sign = side == 'module' ? 1 : -1
  const edge = seam.profile.map(([t, s]) => fromSeam(seam, t, s + (sign * seam.gap) / 2))
  const t0 = seam.profile[0][0]
  const t1 = seam.profile[seam.profile.length - 1][0]
  const far = [fromSeam(seam, t1, sign * L), fromSeam(seam, t0, sign * L)]
  const pts = [...edge, ...far]
  let d = draw(pts[0])
  for (const p of pts.slice(1)) d = d.lineTo(p)
  const prism = d.close().sketchOnPlane('XY', -L / 2).extrude(L) as Solid
  return plateToWorld(geo).transform(prism)
}

/**
 * The part of a solid on one side of the seam. Uses OpenCascade's splitter, which copes with the
 * stitched key web where a plain boolean intersection fails, then keeps the pieces on that side.
 */
export function splitAtSeam(geo: Geometry, seam: Seam, solid: Solid, side: 'main' | 'module'): Solid | undefined {
  const splitter = new Splitter()
  splitter.addArgument(solid, false)
  splitter.addTool(sidePrism(geo, seam, 'main'))
  splitter.addTool(sidePrism(geo, seam, 'module'))
  splitter.perform()
  const keep: Solid[] = []
  const acrossOf = (v: { x: number; y: number; z: number }) => {
    const p = new Vector(v.x, v.y, v.z)
    const [t, sAcross] = toSeam(seam, [p.dot(geo.worldX), p.dot(geo.worldY)])
    return sAcross - seamOffsetAt(seam, t)
  }
  const EPS = 0.3
  for (const piece of splitter.solidResults()) {
    // Corner points tell the sides apart where a bent strip's center of mass would not.
    const corners = piece.edges.flatMap(e => [e.startPoint, e.endPoint]).map(acrossOf)
    const onModule = Math.max(...corners) > seam.gap / 2 + EPS
    const onMain = Math.min(...corners) < -seam.gap / 2 - EPS
    if (side == 'module' ? onModule && !onMain : onMain && !onModule) keep.push(piece)
    else piece.delete()
  }
  if (!keep.length) return undefined
  return keep.length == 1 ? keep[0] : (combine(keep) as unknown as Solid)
}

/** Whether a plate point lies inside the case's outline. */
function insidePlate(outline: [number, number][], p: [number, number]) {
  let inside = false
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const [xi, yi] = outline[i]
    const [xj, yj] = outline[j]
    if ((yi > p[1]) != (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Strap centers on the seam with the local direction across it, in plate coordinates. */
export function strapPlacements(geo: Geometry, seam: Seam): { center: [number, number]; across: [number, number] }[] {
  const outline = geo.allWallCriticalPoints().map(w => {
    const o = w.bo.origin()
    return [o.dot(geo.worldX), o.dot(geo.worldY)] as [number, number]
  })
  const inside = seam.profile.filter(([t, s]) => insidePlate(outline, fromSeam(seam, t, s))).map(([t]) => t)
  if (!inside.length) return []
  const lo = Math.min(...inside)
  const hi = Math.max(...inside)
  const at = (t: number) => {
    const ds = (seamOffsetAt(seam, t + 1) - seamOffsetAt(seam, t - 1)) / 2
    // The seam's local tangent is along + ds * normal; across it, toward the thumbs:
    const tan = [seam.along[0] + ds * seam.normal[0], seam.along[1] + ds * seam.normal[1]]
    const len = Math.hypot(tan[0], tan[1])
    const across: [number, number] = [tan[1] / len, -tan[0] / len]
    if (across[0] * seam.normal[0] + across[1] * seam.normal[1] < 0) across.forEach((_, i) => (across[i] = -across[i]))
    return { center: fromSeam(seam, t, seamOffsetAt(seam, t)), across }
  }
  if (hi - lo < 2 * STRAP.inset + STRAP.width) return [at((lo + hi) / 2)]
  return [at(lo + STRAP.inset), at(hi - STRAP.inset)]
}

/** Bolt centers on one side of the seam, in plate coordinates. */
export function strapBolts(geo: Geometry, seam: Seam, side: 'main' | 'module'): [number, number][] {
  const d = (seam.gap / 2 + STRAP.boltFromSeam) * (side == 'module' ? 1 : -1)
  return strapPlacements(geo, seam).map(({ center: [u, v], across: [a, b] }) => [u + a * d, v + b * d])
}

/** Bosses with M3 nut pockets on the plate's inner face, for the strap bolts. Works in plate coordinates. */
export function addStrapBosses(c: Cuttleform, geo: Geometry, plate: Solid): Solid {
  const result = thumbSeam(c, geo)
  if (!('seam' in result)) return plate
  const bolts = [...strapBolts(geo, result.seam, 'main'), ...strapBolts(geo, result.seam, 'module')]
  let out = plate
  for (const [x, y] of bolts) out = out.fuse(makeCylinder(STRAP.bossDiameter / 2, STRAP.bossHeight, [x, y, 0], [0, 0, 1]))
  for (const [x, y] of bolts) {
    out = out.cut(makeCylinder(STRAP.holeDiameter / 2, c.plateThickness + STRAP.bossHeight + 2, [x, y, -c.plateThickness - 1], [0, 0, 1]))
    const nut = drawPolysides(STRAP.nutAcrossFlats / Math.sqrt(3), 6)
      .sketchOnPlane('XY', [x, y, STRAP.bossHeight - STRAP.nutDepth])
      .extrude(STRAP.nutDepth + 1) as Solid
    out = out.cut(nut)
  }
  return out
}

/** The straps, printed separately, in world coordinates under the plate. */
export function makeStraps(c: Cuttleform, geo: Geometry): Solid | undefined {
  const result = thumbSeam(c, geo)
  if (!('seam' in result)) return undefined
  const { seam } = result
  const length = seam.gap + 2 * (STRAP.boltFromSeam + STRAP.width / 2 + STRAP.play)
  const z0 = -c.plateThickness - STRAP.thickness
  let straps: Solid | undefined
  for (const { center: [u, v], across } of strapPlacements(geo, seam)) {
    const frame = new Trsf().coordSystemChange(new Vector(u, v, 0), new Vector(across[0], across[1], 0), new Vector(0, 0, 1))
    const bolt = seam.gap / 2 + STRAP.boltFromSeam
    let strap = makeBox([-length / 2, -STRAP.width / 2, z0], [length / 2, STRAP.width / 2, z0 + STRAP.thickness]) as Solid
    strap = strap.cut(makeCylinder(STRAP.holeDiameter / 2, STRAP.thickness + 2, [-bolt, 0, z0 - 1], [0, 0, 1]))
    strap = strap.cut(makeCylinder(STRAP.holeDiameter / 2 + STRAP.play, STRAP.thickness + 2, [bolt, 0, z0 - 1], [0, 0, 1]))
    strap = frame.transform(strap)
    straps = straps ? (straps.fuse(strap) as Solid) : strap
  }
  return straps ? plateToWorld(geo).transform(straps) : undefined
}

/** How many of the case's plate screws land on each side of the seam. */
export function screwsPerSide(geo: Geometry, seam: Seam) {
  const counts = { main: 0, module: 0 }
  for (const t of geo.screwPositions) {
    const o = t.origin()
    const [tt, ss] = toSeam(seam, [o.dot(geo.worldX), o.dot(geo.worldY)])
    const across = ss - seamOffsetAt(seam, tt)
    if (across > seam.gap / 2) counts.module++
    else if (across < -seam.gap / 2) counts.main++
  }
  return counts
}
