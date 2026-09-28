// Turn the current document back into file text.
//
// Top-level blocks that are structurally identical to a block read from the
// file are emitted as their original source slice (table padding, bullet
// characters, setext headings, CRLF, escapes … all untouched). Only blocks the
// user actually changed go through the serializer. The whitespace between
// blocks and the file's trailing newline are preserved as well.
import type { Node as PMNode } from 'prosemirror-model'
import type { SourceInfo } from './parse'
import { serializeBlock } from './serialize'

function sameNode(a: PMNode, b: PMNode) {
  return a === b || a.eq(b)
}

/** Longest common subsequence alignment of original vs current blocks. */
export function alignBlocks(orig: PMNode[], cur: PMNode[]): [number, number][] {
  const N = orig.length, M = cur.length
  const pairs: [number, number][] = []
  let s = 0
  while (s < N && s < M && sameNode(orig[s], cur[s])) { pairs.push([s, s]); s++ }
  let e = 0
  while (e < N - s && e < M - s && sameNode(orig[N - 1 - e], cur[M - 1 - e])) e++
  const on = N - s - e, cm = M - s - e
  const mid: [number, number][] = []
  if (on > 0 && cm > 0) {
    if (on * cm <= 2_000_000) {
      const w = cm + 1
      const dp = new Uint32Array((on + 1) * w)
      for (let i = on - 1; i >= 0; i--) {
        for (let j = cm - 1; j >= 0; j--) {
          dp[i * w + j] = sameNode(orig[s + i], cur[s + j])
            ? dp[(i + 1) * w + j + 1] + 1
            : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1])
        }
      }
      let i = 0, j = 0
      while (i < on && j < cm) {
        if (sameNode(orig[s + i], cur[s + j])) { mid.push([s + i, s + j]); i++; j++ }
        else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++
        else j++
      }
    } else {
      let last = -1
      for (let j = 0; j < cm; j++) {
        for (let i = last + 1; i < Math.min(on, last + 64); i++) {
          if (sameNode(orig[s + i], cur[s + j])) { mid.push([s + i, s + j]); last = i; break }
        }
      }
    }
  }
  for (const p of mid) pairs.push(p)
  for (let k = e - 1; k >= 0; k--) pairs.push([N - 1 - k, M - 1 - k])
  return pairs
}

function ensureBlank(gap: string, sep: string) {
  return (gap.match(/\n/g) || []).length >= 2 ? gap : sep
}

export interface ComposeResult {
  text: string
  /** Source table describing `text`, for use as the new baseline after saving. */
  info: SourceInfo
  /** character offset of each top-level block of the current doc (for caret mapping) */
  offsets: number[]
}

export function composeMarkdown(doc: PMNode, info: SourceInfo): ComposeResult {
  const EOL = info.eol
  const SEP = EOL + EOL
  const conv = (s: string) => (EOL === '\n' ? s : s.replace(/\n/g, EOL))
  const ctx = { env: info.env }
  const orig = info.nodes
  const N = orig.length
  const cur: PMNode[] = []
  doc.forEach(n => cur.push(n))
  const M = cur.length

  const outNodes: PMNode[] = []
  const outSrcs: string[] = []
  const outGaps: string[] = []
  const nodeIndex: number[] = [] // current index -> out index
  const setGap = (g: string) => { if (outSrcs.length) outGaps[outSrcs.length - 1] = g }
  const push = (k: number, src: string) => {
    nodeIndex[k] = outSrcs.length
    outNodes.push(cur[k]); outSrcs.push(src); outGaps.push('')
  }

  const anchors: [number, number][] = [[-1, -1], ...alignBlocks(orig, cur), [N, M]]
  for (let a = 0; a < anchors.length - 1; a++) {
    const [aj, ak] = anchors[a]
    const [bj, bk] = anchors[a + 1]
    if (aj >= 0) push(ak, info.srcs[aj])
    const changed: { k: number; text: string }[] = []
    for (let k = ak + 1; k < bk; k++) {
      const text = serializeBlock(cur[k], ctx, k > 0 ? cur[k - 1] : null)
      if (text) changed.push({ k, text: conv(text) })
    }
    const deleted = bj - aj - 1
    if (!changed.length) {
      if (aj < 0) continue
      if (!deleted) setGap(info.gaps[aj])
      else setGap(bj >= N ? info.gaps[N - 1] : info.gaps[bj - 1])
      continue
    }
    setGap(aj < 0 ? '' : ensureBlank(info.gaps[aj], SEP))
    changed.forEach((c, i) => {
      if (i) setGap(SEP)
      push(c.k, c.text)
    })
    const trail = bj >= N
      ? (N > 0 ? info.gaps[N - 1] : EOL)
      : (deleted ? ensureBlank(info.gaps[bj - 1], SEP) : SEP)
    setGap(trail)
  }

  // if the trailing text lost its line break (content appended after a file
  // that ended without newline), keep the file as it was: no final newline.
  let text = info.prefix
  const offsets: number[] = new Array(M).fill(-1)
  const outOffsets: number[] = []
  for (let i = 0; i < outSrcs.length; i++) {
    outOffsets.push(text.length)
    text += outSrcs[i] + outGaps[i]
  }
  for (let k = 0; k < M; k++) {
    if (nodeIndex[k] !== undefined) offsets[k] = outOffsets[nodeIndex[k]]
  }
  // blocks that produced no text (empty paragraphs) take the next block's offset
  let next = text.length
  for (let k = M - 1; k >= 0; k--) {
    if (offsets[k] < 0) offsets[k] = next
    else next = offsets[k]
  }

  return {
    text,
    info: { ...info, nodes: outNodes, srcs: outSrcs, gaps: outGaps },
    offsets,
  }
}

/** A source table for a brand-new (empty) document. */
export function emptySourceInfo(eol: '\n' | '\r\n' = '\n'): SourceInfo {
  return { eol, bom: false, prefix: '', nodes: [], srcs: [], gaps: [], env: {} }
}
