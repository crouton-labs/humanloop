export interface InboxLayout {
  mode: 'two-column' | 'list' | 'detail' | 'minimum';
  listWidth: number;
  detailWidth: number;
  height: number;
}

/** Pure geometry for the centralized inbox surface. */
export function inboxLayout(cols: number, rows: number, screen: 'list' | 'detail' = 'list'): InboxLayout {
  if (cols < 60 || rows < 18) return { mode: 'minimum', listWidth: cols, detailWidth: 0, height: rows };
  if (cols < 96) return { mode: screen, listWidth: cols, detailWidth: cols, height: rows };
  const listWidth = Math.max(30, Math.min(44, Math.floor(cols / 3)));
  return { mode: 'two-column', listWidth, detailWidth: cols - listWidth - 1, height: rows };
}
