import { describe, expect, test } from 'bun:test'
import { parseAnsiSgr } from './bash-result'

describe('parseAnsiSgr', () => {
  test('Given plain text without ANSI When parsing Then returns single plain segment', () => {
    expect(parseAnsiSgr('hello world')).toEqual([
      { text: 'hello world', style: {} },
    ])
  })

  test('Given empty string When parsing Then returns empty array', () => {
    expect(parseAnsiSgr('')).toEqual([])
  })

  test('Given red foreground escape When parsing Then applies fg color', () => {
    expect(parseAnsiSgr('\x1b[31mred\x1b[0m')).toEqual([
      { text: 'red', style: { fg: '#c91b00' } },
    ])
  })

  test('Given bold + color combined codes When parsing Then applies both styles', () => {
    expect(parseAnsiSgr('\x1b[1;32mbold green\x1b[0m')).toEqual([
      { text: 'bold green', style: { bold: true, fg: '#00c200' } },
    ])
  })

  test('Given style change mid-text When parsing Then splits into styled segments', () => {
    expect(parseAnsiSgr('a\x1b[31mb\x1b[0mc')).toEqual([
      { text: 'a', style: {} },
      { text: 'b', style: { fg: '#c91b00' } },
      { text: 'c', style: {} },
    ])
  })

  test('Given 256-color escape (38;5;n) When parsing Then resolves palette color', () => {
    expect(parseAnsiSgr('\x1b[38;5;196mhi\x1b[0m')).toEqual([
      { text: 'hi', style: { fg: 'rgb(255,0,0)' } },
    ])
  })

  test('Given truecolor escape (38;2;r;g;b) When parsing Then resolves rgb color', () => {
    expect(parseAnsiSgr('\x1b[38;2;255;128;0morange\x1b[0m')).toEqual([
      { text: 'orange', style: { fg: 'rgb(255,128,0)' } },
    ])
  })

  test('Given background color escape When parsing Then applies bg color', () => {
    expect(parseAnsiSgr('\x1b[44mblue bg\x1b[0m')).toEqual([
      { text: 'blue bg', style: { bg: '#0225c7' } },
    ])
  })

  test('Given bare ESC m (code 0) When parsing Then resets style', () => {
    expect(parseAnsiSgr('\x1b[31mred\x1b[mnormal')).toEqual([
      { text: 'red', style: { fg: '#c91b00' } },
      { text: 'normal', style: {} },
    ])
  })

  test('Given non-color SGR like underline When parsing Then applies text decoration', () => {
    expect(parseAnsiSgr('\x1b[4munderlined\x1b[0m')).toEqual([
      { text: 'underlined', style: { underline: true } },
    ])
  })
})
