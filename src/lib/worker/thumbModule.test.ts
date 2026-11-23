import defaultConfig from '$assets/cuttleform.json' with { type: 'json' }
import { expect, test } from 'bun:test'
import { cuttleConf, type Cuttleform, newGeometry } from './config'
import { fromCosmosConfig, toCosmosConfig } from './config.cosmos'
import { decodeConfigIdk, encodeCosmosConfig, serializeCosmosConfig } from './config.serialize'
import { Vector } from './modeling/transformation'
import ETrsf from './modeling/transformation-ext'
import { screwsPerSide, seamOffsetAt, strapBolts, thumbSeam } from './thumbModule'

function defaultWithModule(): Cuttleform {
  const conf = cuttleConf(defaultConfig.options as any)
  return { ...conf, thumbModule: { gap: 4, angle: 0, offset: 0 } }
}

/** The default keyboard's thumb keys sit only about 1 mm from its finger keys; move them away. */
function separatedDefault(distance = 12): Cuttleform {
  const conf = defaultWithModule()
  const geo = newGeometry(conf)
  const mean = (thumbs: boolean) => {
    const pts = conf.keys.map((k, i) => ({ k, o: geo.keyHolesTrsfs[i].origin() })).filter(({ k }) => (k.cluster == 'thumbs') == thumbs)
    return pts.reduce((a, { o }) => a.add(o.clone().multiplyScalar(1 / pts.length)), new Vector())
  }
  const dir = mean(true).sub(mean(false)).setZ(0).normalize().multiplyScalar(distance)
  for (const k of conf.keys) if (k.cluster == 'thumbs') k.position = new ETrsf(k.position.history).translate(dir.x, dir.y, 0)
  return conf
}

/** Distance of a key's origin from the seam's center line, positive toward the thumbs. */
function across(conf: Cuttleform, i: number) {
  const geo = newGeometry(conf)
  const result = thumbSeam(conf, geo)
  if (!('seam' in result)) throw new Error(result.error)
  const { seam } = result
  const o = geo.keyHolesTrsfs[i].origin()
  const p = [o.dot(geo.worldX), o.dot(geo.worldY)]
  const t = p[0] * seam.along[0] + p[1] * seam.along[1]
  const s = p[0] * seam.normal[0] + p[1] * seam.normal[1]
  return s - seamOffsetAt(seam, t)
}

test('the default keyboard refuses a seam where its thumb and finger keys nearly touch', () => {
  const conf = defaultWithModule()
  expect('error' in thumbSeam(conf, newGeometry(conf))).toBe(true)
})

test('a separated thumb cluster splits with every thumb key on the module and every finger key on the main case', () => {
  const conf = separatedDefault()
  const geo = newGeometry(conf)
  const result = thumbSeam(conf, geo)
  expect('seam' in result).toBe(true)
  conf.keys.forEach((k, i) => {
    if (k.cluster == 'thumbs') expect(across(conf, i)).toBeGreaterThan(2)
    else expect(across(conf, i)).toBeLessThan(-2)
  })
  if ('seam' in result) {
    expect(strapBolts(geo, result.seam, 'main').length).toBeGreaterThan(0)
    const screws = screwsPerSide(geo, result.seam)
    expect(screws.main + screws.module).toBeLessThanOrEqual(geo.screwPositions.length)
  }
})

test('a thumb key sitting on a finger key leaves no room for a seam', () => {
  const conf = defaultWithModule()
  const finger = conf.keys.find(k => k.cluster != 'thumbs')!
  const thumb = conf.keys.find(k => k.cluster == 'thumbs')!
  thumb.position = new ETrsf(finger.position.history).translate(new Vector(1, 1, 0).xyz())
  const result = thumbSeam(conf, newGeometry(conf))
  expect('error' in result).toBe(true)
})

test('the thumb module setting survives encoding and reaches the model config', () => {
  const config = cuttleConf(defaultConfig.options as any)
  const cosmos = toCosmosConfig(config, 'right', true)
  cosmos.wristRestPosition = 0n
  cosmos.thumbModule = { gap: 3.5, angle: -12, offset: 1.5 }
  const decoded = decodeConfigIdk(serializeCosmosConfig(encodeCosmosConfig(cosmos)))
  expect(decoded.thumbModule).toEqual({ gap: 3.5, angle: -12, offset: 1.5 })
  expect(fromCosmosConfig(decoded).right!.thumbModule).toEqual(decoded.thumbModule)
})
