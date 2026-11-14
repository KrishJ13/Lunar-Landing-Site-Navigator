import { MOON_RADIUS_KM, discRadius, surfaceAt } from './geometry.js'

export const TILE_SIZE = 256
const DETAIL_SIZE = 32
export const TABLE_SIDE = 32
const SLOT_COUNT = 112
const TILE_CONCURRENCY = 6
const BASE = 'https://trek.nasa.gov/tiles/Moon'
export const POLAR_ORIGIN_M = 1095930
export const WAC_POLAR_MIN = 60
export const NAC_POLAR_MIN = 85.5
export const EQ = { zone: 'EQ', name: 'LRO_WAC_Mosaic_Global_303ppd_v02', extension: 'jpg', minLevel: 3, maxLevel: 8, firstRow: 0 }
export const NORTH = { zone: 'NP', name: 'LRO_WAC_Mosaic_NPole60_100mp', extension: 'png', minLevel: 2, maxLevel: 4, firstRow: 6, latitude: WAC_POLAR_MIN }
const SOUTH = { ...NORTH, zone: 'SP', name: 'LRO_WAC_Mosaic_SPole60_100mp' }
export const NORTH_NAC = { ...NORTH, name: 'LRO_NAC_AvgMosaic_NPole855_1mp', minLevel: 4, maxLevel: 11, firstRow: 9, latitude: NAC_POLAR_MIN }
export const SOUTH_NAC = { ...NORTH_NAC, zone: 'SP', name: 'LRO_NAC_AvgMosaic_SPole855_1mp', firstRow: 17 }
const TABLE_ROWS = (SOUTH_NAC.firstRow + SOUTH_NAC.maxLevel - SOUTH_NAC.minLevel + 1) * TABLE_SIDE
const DEG = Math.PI / 180

function project(normal, layer) {
  const [x, y, z] = normal
  if (!layer.latitude) {
    return [0.5 + Math.atan2(y, x) / (2 * Math.PI), 0.5 - Math.atan2(z, Math.hypot(x, y)) / Math.PI]
  }
  // The NASA grids use spherical polar stereographic, longitude zero on
  // the central meridian. Convert northing into a downward image row here.
  const scale = MOON_RADIUS_KM * 1000 / (POLAR_ORIGIN_M * (1 + Math.abs(z)))
  return [0.5 + y * scale, 0.5 + Math.sign(z) * x * scale]
}

function chooseLevel(layer, radius, camera) {
  const cameraScale = Math.sqrt((camera.distance + 1) / (camera.distance - 1))
  const pixelsPerRadian = radius / cameraScale
  // Polar capabilities list an extra horizontal half. Valid polar imagery
  // occupies the square around the published origin and uses the same
  // metres per pixel on both axes.
  const worldWidth = layer.latitude ? 2 * POLAR_ORIGIN_M / (MOON_RADIUS_KM * 1000) : 2 * Math.PI
  return Math.max(layer.minLevel, Math.min(layer.maxLevel,
    Math.ceil(Math.log2(worldWidth * pixelsPerRadian / ((layer.latitude ? 1 : 2) * TILE_SIZE))),
  ))
}

function visibleTiles(camera, width, height, zoom) {
  const radius = discRadius(width, height, zoom)
  const levels = [EQ, NORTH, NORTH_NAC].map((layer) => chooseLevel(layer, radius, camera))
  const requests = new Map()
  const left = Math.max(0, width / 2 - radius)
  const right = Math.min(width, width / 2 + radius)
  const top = Math.max(0, height / 2 - radius)
  const bottom = Math.min(height, height / 2 + radius)
  const columns = Math.max(1, Math.ceil((right - left) / 40))
  const rows = Math.max(1, Math.ceil((bottom - top) / 40))

  for (let row = 0; row <= rows; row++) {
    for (let col = 0; col <= columns; col++) {
      const x = left + (right - left) * col / columns
      const y = top + (bottom - top) * row / rows
      const surface = surfaceAt(x, y, width, height, zoom, camera)
      if (!surface) continue
      const z = surface[2]
      const absZ = Math.abs(z)
      const distance = Math.hypot(x - width / 2, y - height / 2) / Math.min(width, height)
      if (absZ < Math.sin(86 * DEG)) add(EQ, levels[0], surface, distance)
      if (absZ >= Math.sin(WAC_POLAR_MIN * DEG)) add(z > 0 ? NORTH : SOUTH, levels[1], surface, distance)
      if (absZ >= Math.sin(NAC_POLAR_MIN * DEG) && zoom >= 6) {
        const layer = z > 0 ? NORTH_NAC : SOUTH_NAC
        add(layer, levels[2], surface, distance)
      }
    }
  }
  return {
    // The shader samples an existing parent while finer tiles stream in.
    levels,
    requests: [...requests.values()].sort((a, b) => a.priority - b.priority).slice(0, SLOT_COUNT),
  }

  function add(layer, level, normal, distance) {
    const [u, v] = project(normal, layer)
    for (let coarse = Math.max(layer.minLevel, level - 2); coarse <= level; coarse++) {
      const dimension = 2 ** coarse
      const columns = layer.latitude ? dimension : 2 * dimension
      const tileX = Math.floor(u * columns)
      const tileY = layer.latitude ? Math.floor(v * dimension) : Math.min(dimension - 1, Math.floor(v * dimension))
      const col = layer.latitude ? tileX : (tileX + columns) % columns
      if (col < 0 || col >= columns || tileY < 0 || tileY >= dimension) continue
      const key = `${layer.name}/${coarse}/${tileY}/${col}`
      const priority = distance + (coarse === level ? 0 : 0.45 + 0.06 * (level - coarse)) - (layer === NORTH_NAC || layer === SOUTH_NAC ? 0.12 : 0)
      if ((requests.get(key)?.priority ?? Infinity) <= priority) continue
      requests.set(key, { key, col, row: tileY, level: coarse, layer, priority })
    }
  }
}

export function createTrekMaps(gl, signal, redraw) {
  const atlas = gl.createTexture()
  const table = gl.createTexture()
  const canvas = document.createElement('canvas')
  canvas.width = DETAIL_SIZE
  canvas.height = DETAIL_SIZE
  const preview = canvas.getContext('2d')
  const loaded = new Map()
  const failed = new Map()
  const pending = new Map()
  const entries = new Int32Array(TABLE_SIDE * TABLE_ROWS * 4)
  let wanted = new Map()
  let queue = []
  let loading = 0
  let timer
  let disposed = false
  let tableDirty = true
  const maxLevel = 3

  gl.activeTexture(gl.TEXTURE4)
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, atlas)
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, maxLevel + 1, gl.RGBA8, TILE_SIZE, TILE_SIZE, SLOT_COUNT)
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAX_LEVEL, maxLevel)
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_NEAREST)
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

  gl.activeTexture(gl.TEXTURE5)
  gl.bindTexture(gl.TEXTURE_2D, table)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32I, TABLE_SIDE, TABLE_ROWS, 0, gl.RGBA_INTEGER, gl.INT, entries)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)

  function loadNext() {
    while (!disposed && loading < TILE_CONCURRENCY && queue.length) {
      const tile = queue.shift()
      loading++
      const controller = new AbortController()
      pending.set(tile.key, controller)
      load(tile, controller.signal).catch(() => {
        if (controller.signal.aborted) return
        if (failed.size >= 384) failed.delete(failed.keys().next().value)
        failed.set(tile.key, Date.now() + 60_000)
      }).finally(() => {
        pending.delete(tile.key)
        loading--
        loadNext()
      })
    }
  }

  async function load(tile, requestSignal) {
    const { layer, level, row, col, key } = tile
    const url = `${BASE}/${layer.zone}/${layer.name}/1.0.0/default/default028mm/${level}/${row}/${col}.${layer.extension}`
    const response = await fetch(url, { signal: AbortSignal.any([signal, requestSignal, AbortSignal.timeout(10_000)]) })
    if (!response.ok) throw new Error(`Moon Trek returned ${response.status}`)
    const image = await createImageBitmap(await response.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
    try {
      if (disposed || gl.isContextLost() || !wanted.has(key) || image.width !== TILE_SIZE || image.height !== TILE_SIZE) return
      let slot = loaded.size
      if (loaded.size >= SLOT_COUNT) {
        const stale = [...loaded].find(([old]) => !wanted.has(old))
        if (!stale) return
        loaded.delete(stale[0])
        slot = stale[1].slot
      }

      // Store the raw tile and a small area-filtered copy. Their ratio adds
      // fine photographic detail without replacing the shader's lighting.
      preview.clearRect(0, 0, DETAIL_SIZE, DETAIL_SIZE)
      preview.drawImage(image, 0, 0, DETAIL_SIZE, DETAIL_SIZE)
      gl.activeTexture(gl.TEXTURE4)
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, atlas)
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, slot, TILE_SIZE, TILE_SIZE, 1, gl.RGBA, gl.UNSIGNED_BYTE, image)
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, maxLevel, 0, 0, slot, DETAIL_SIZE, DETAIL_SIZE, 1, gl.RGBA, gl.UNSIGNED_BYTE, preview.getImageData(0, 0, DETAIL_SIZE, DETAIL_SIZE))
      loaded.set(key, { slot })
      tableDirty = true
      redraw()
    } finally {
      image.close()
    }
  }

  let currentView
  let levels = [EQ.minLevel, NORTH.minLevel, NORTH_NAC.minLevel]

  return {
    update(camera, width, height, zoom) {
      if (!currentView || currentView.camera !== camera || currentView.width !== width || currentView.height !== height || currentView.zoom !== zoom) {
        currentView = { camera, width, height, zoom }
        tableDirty = true
        const next = visibleTiles(camera, width, height, zoom)
        levels = next.levels
        wanted = new Map(next.requests.map((tile) => [tile.key, tile]))
        queue = []
        clearTimeout(timer)
        timer = setTimeout(() => {
          for (const [key, controller] of pending) {
            if (!wanted.has(key)) controller.abort()
          }
          queue = next.requests.filter(({ key }) => !loaded.has(key) && !pending.has(key) && !(failed.get(key) > Date.now()))
          loadNext()
        }, 100)
      }

      if (!tableDirty) return levels
      tableDirty = false
      // Each level has its own hashed block. Check full tile indices in the
      // shader so a collision can only cause a lower-resolution fallback.
      entries.fill(0)
      for (const tile of [...wanted.values()].reverse()) {
        const entry = loaded.get(tile.key)
        if (!entry) continue
        const band = tile.layer.firstRow + tile.level - tile.layer.minLevel
        const index = 4 * ((band * TABLE_SIDE + tile.row % TABLE_SIDE) * TABLE_SIDE + tile.col % TABLE_SIDE)
        entries[index] = tile.col
        entries[index + 1] = tile.row
        entries[index + 2] = entry.slot + 1
      }
      gl.activeTexture(gl.TEXTURE5)
      gl.bindTexture(gl.TEXTURE_2D, table)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TABLE_SIDE, TABLE_ROWS, gl.RGBA_INTEGER, gl.INT, entries)
      return levels
    },
    dispose() {
      disposed = true
      clearTimeout(timer)
      for (const controller of pending.values()) controller.abort()
      gl.deleteTexture(atlas)
      gl.deleteTexture(table)
    },
  }
}
