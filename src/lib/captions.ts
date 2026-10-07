import type { Word } from './types';

export interface CaptionPage {
  words: Word[];
  start: number;
  /** time the page stays on screen until */
  end: number;
}

const GAP_BREAK = 0.9; // a pause this long starts a new page
const HOLD = 0.6; // keep the last page up briefly after speech stops

/**
 * Groups words into short pages (a few words at a time, never the whole transcript). Pages break when full,
 * after a long pause, or after sentence-ending punctuation once the page is at least half full.
 */
export function buildPages(words: Word[], wordsPerPage: number): CaptionPage[] {
  const pages: CaptionPage[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (cur.length) pages.push({ words: cur, start: cur[0].start, end: cur[cur.length - 1].end });
    cur = [];
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const prev = cur[cur.length - 1];
    if (prev && (w.start - prev.end > GAP_BREAK || cur.length >= wordsPerPage)) flush();
    else if (prev && /[.!?]$/.test(prev.text) && cur.length >= Math.ceil(wordsPerPage / 2)) flush();
    cur.push(w);
  }
  flush();
  // Each page stays until the next one starts (bridging short gaps), or HOLD after its last word.
  for (let i = 0; i < pages.length; i++) {
    const next = pages[i + 1];
    let end = pages[i].end + HOLD;
    if (next && (end > next.start || next.start - end < 0.25)) end = next.start;
    pages[i].end = Math.max(end, pages[i].start + 0.05);
  }
  return pages;
}

/** Binary search for the page visible at time t. */
export function pageAt(pages: CaptionPage[], t: number): CaptionPage | null {
  let lo = 0;
  let hi = pages.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = pages[mid];
    if (t < p.start) hi = mid - 1;
    else if (t >= p.end) lo = mid + 1;
    else return p;
  }
  return null;
}

/** Index of the word being spoken at t within a page (the last word that has started), or -1. */
export function activeWordIndex(page: CaptionPage, t: number): number {
  let idx = -1;
  for (let i = 0; i < page.words.length; i++) if (page.words[i].start <= t) idx = i;
  return idx;
}

/** Binary search over a sorted word list: the word being spoken at t (for transcript highlighting). */
export function wordAt(words: Word[], t: number): number {
  let lo = 0;
  let hi = words.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].start <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (ans >= 0 && t > words[ans].end + 0.5) return -1;
  return ans;
}
