// Run: npm test
import assert from 'node:assert/strict'
import test from 'node:test'
import { globeUrl, nextSlot, readJourney, siteUrl, utcMinute, wrapLongitude } from './journey.js'

test('site URL round-trips coordinates, name and window', () => {
  const site = { lat: -89.45, lon: 222.69, diameterKm: 12, name: 'Shackleton connecting ridge' }
  const url = siteUrl(site, { startUtc: '2026-11-15T06:30:00Z', hours: 72, stepMinutes: 15, eyeHeightM: 1.8, mastHeightM: 2 })
  assert.ok(url.startsWith('./skyline-v3.html?'))
  const back = readJourney(url.slice(url.indexOf('?')))
  assert.deepEqual(back.site, site)
  assert.equal(back.startUtc, '2026-11-15T06:30:00Z')
  assert.equal(back.hours, 72)
  assert.equal(back.stepMinutes, 15)
  assert.equal(back.eyeHeightM, 1.8)
  assert.equal(back.mastHeightM, 2)
})

test('globe URL carries the site and the time back', () => {
  const url = globeUrl({ lat: 0.67408, lon: 23.47297, diameterKm: 10, name: 'Apollo 11' }, '2026-11-16T03:15:00Z')
  const back = readJourney(url.slice(url.indexOf('?')))
  assert.equal(back.site.lat, 0.67408)
  assert.equal(back.site.lon, 23.47297)
  assert.equal(back.timeUtc, '2026-11-16T03:15:00Z')
  assert.equal(globeUrl(null), './')
})

test('invalid parameters are dropped, never guessed', () => {
  const j = readJourney('?lat=95&lon=10&start=2026-11-15T06:30&hours=-1&step=5&d=500')
  assert.equal(j.site, null)
  assert.equal(j.startUtc, null) // no explicit UTC "Z": rejected
  assert.equal(j.hours, null)
  assert.equal(j.stepMinutes, null)
  const k = readJourney('?lat=10&lon=abc')
  assert.equal(k.site, null)
  const d = readJourney('?lat=10&lon=20&d=500')
  assert.equal(d.site.diameterKm, null)
})

test('longitude wraps to (-180, 180] and times format to the minute in UTC', () => {
  assert.equal(wrapLongitude(222.69).toFixed(2), '-137.31')
  assert.equal(wrapLongitude(-180), 180)
  assert.equal(wrapLongitude(23.5), 23.5)
  assert.equal(utcMinute('2026-11-15T06:30:59Z'), '2026-11-15T06:30Z')
  assert.equal(utcMinute('nonsense'), null)
})

test('nextSlot fills A, then B, then replaces B', () => {
  assert.equal(nextSlot({ A: null, B: null }), 'A')
  assert.equal(nextSlot({ A: {}, B: null }), 'B')
  assert.equal(nextSlot({ A: {}, B: {} }), 'B')
})

test('comparison journey carries the slot and Site B', () => {
  const a = { lat: -89.45, lon: 222.69, diameterKm: 12, name: null }
  const b = { lat: -85.99, lon: 2.9, diameterKm: 10, name: null }
  const url = siteUrl(a, { startUtc: '2026-11-15T06:30:00Z', hours: 72, slot: 'A', compare: b })
  const back = readJourney(url.slice(url.indexOf('?')))
  assert.equal(back.slot, 'A')
  assert.deepEqual(back.compare, b)
  const globe = globeUrl(a, '2026-11-15T06:30:00Z', b)
  assert.deepEqual(readJourney(globe.slice(globe.indexOf('?'))).compare, b)
  assert.equal(readJourney('?lat=1&lon=2&slot=C').slot, null)
  assert.equal(readJourney('?lat=1&lon=2').compare, null)
})
