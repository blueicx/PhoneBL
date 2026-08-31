'use strict';

function calculateGalleryWindow(total, scrollTop, viewportHeight, rowHeight, overscanRows = 3, columns = 1) {
  const itemCount = Math.max(0, Number(total) || 0);
  if (!itemCount) return { start: 0, end: 0 };
  const safeColumns = Math.max(1, Math.floor(Number(columns) || 1));
  const safeRowHeight = Math.max(1, Number(rowHeight) || 1);
  const overscan = Math.max(0, Math.floor(Number(overscanRows) || 0));
  const firstRow = Math.max(0, Math.floor((Number(scrollTop) || 0) / safeRowHeight) - overscan);
  const visibleRows = Math.ceil((Number(viewportHeight) || safeRowHeight) / safeRowHeight) + overscan * 2;
  return {
    start: Math.min(itemCount, firstRow * safeColumns),
    end: Math.min(itemCount, (firstRow + visibleRows) * safeColumns)
  };
}

module.exports = { calculateGalleryWindow };
