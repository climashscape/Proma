import { describe, expect, test } from 'bun:test'
import { buildWslBashArgs, windowsPathToWslPath, extractPartialResultText } from './pi-agent-adapter'

describe('Pi WSL Bash', () => {
  test('Given a Windows workspace path When building WSL Bash arguments Then uses its mounted Linux path', () => {
    expect(buildWslBashArgs(
      { wslDistro: 'Ubuntu-24.04' },
      'C:\\Users\\alice\\Workspace\\project',
      'pwd',
      undefined,
    )).toEqual([
      '--distribution',
      'Ubuntu-24.04',
      '--cd',
      '/mnt/c/Users/alice/Workspace/project',
      '--exec',
      'bash',
      '-lc',
      'pwd',
    ])
  })

  test('Given a Linux path When converting for WSL Then leaves it unchanged', () => {
    expect(windowsPathToWslPath('/home/alice/project')).toBe('/home/alice/project')
  })
})

describe('extractPartialResultText', () => {
  test('Given Pi SDK partialResult with text content When extracting Then returns the text', () => {
    expect(extractPartialResultText({
      content: [{ type: 'text', text: 'Compiling...\n' }],
    })).toBe('Compiling...\n')
  })

  test('Given multiple text blocks When extracting Then joins them', () => {
    expect(extractPartialResultText({
      content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b\n' }],
    })).toBe('ab\n')
  })

  test('Given empty content When extracting Then returns undefined', () => {
    expect(extractPartialResultText({ content: [] })).toBeUndefined()
  })

  test('Given no content field When extracting Then returns undefined', () => {
    expect(extractPartialResultText({ details: {} })).toBeUndefined()
  })

  test('Given non-text blocks only When extracting Then returns undefined', () => {
    expect(extractPartialResultText({ content: [{ type: 'image', source: 'x' }] })).toBeUndefined()
  })

  test('Given null When extracting Then returns undefined', () => {
    expect(extractPartialResultText(null)).toBeUndefined()
  })

  test('Given empty string text When extracting Then returns undefined', () => {
    expect(extractPartialResultText({ content: [{ type: 'text', text: '' }] })).toBeUndefined()
  })
})
