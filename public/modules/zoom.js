/**
 * Zoom and Pan Module
 * Handles canvas zoom and pan functionality
 * Complete implementations extracted from editor.js
 */

import { 
  zoomState, 
  canvasRefs, 
  imageState,
  originalDimensions
} from './state.js';
import { disableSelectionButtons, enableSelectionButtons } from './ui.js';
import { clearSelectionState } from './selection.js';

/**
 * Handle zoom wheel event
 * Complete implementation from editor.js lines 5634-5715
 * @param {WheelEvent} e - Wheel event
 */
export function handleZoomWheel(e) {
  if (!zoomState.isZooming) return;
  
  e.preventDefault();
  const targetCanvas = e.target === canvasRefs.baseCanvas ? canvasRefs.baseCanvas : 
                       e.target === canvasRefs.paintCanvas ? canvasRefs.paintCanvas : 
                       e.target === canvasRefs.samplerCanvas ? canvasRefs.samplerCanvas : null;
  
  if (!targetCanvas) {
    console.log('Wheel zoom skipped - Invalid target:', { target: e.target });
    return;
  }
  
  const canvasKey = targetCanvas === canvasRefs.baseCanvas ? 'base' : 
                    targetCanvas === canvasRefs.paintCanvas ? 'paint' : 'sampler';
  const state = zoomState.canvasStates[canvasKey];
  if (!state) return;
  
  const ctx = targetCanvas.getContext('2d');
  const zoomSpeed = 0.01;
  const zoomFactor = e.deltaY > 0 ? 1 / (1 + zoomSpeed * Math.abs(e.deltaY)) : 1 + zoomSpeed * Math.abs(e.deltaY);
  const imageWidth = originalDimensions.originalWidths[canvasKey] || targetCanvas.width;
  const imageHeight = originalDimensions.originalHeights[canvasKey] || targetCanvas.height;
  const maxZoom = Math.min(imageWidth / targetCanvas.width, imageHeight / targetCanvas.height) * 4;
  const minZoom = 0.1;
  const oldZoomLevel = state.zoomLevel;
  let newZoomLevel = state.zoomLevel * zoomFactor;

  // Safety: Ensure zoom bounds are enforced
  newZoomLevel = Math.max(minZoom, Math.min(maxZoom, newZoomLevel));

  // Additional safety: Prevent infinite zooming
  if (newZoomLevel > 100) {
    console.warn(`Zoom level ${newZoomLevel} too high, clamping to 100`);
    newZoomLevel = 100;
  }

  state.hasZoomedIn = newZoomLevel > 1;

  // Check if returning to full view
  const isReturningToFullView = newZoomLevel <= 1.1 && oldZoomLevel > 1.1;

  if (isReturningToFullView) {
    // Reset to full view
    state.zoomLevel = 1;
    state.panX = 0;
    state.panY = 0;
    state.zoomPivotX = 0;
    state.zoomPivotY = 0;
    state.targetLocked = false;
    console.log(`Wheel zoom returned to full view for ${canvasKey}`);
    enableSelectionButtons();
  } else if (oldZoomLevel !== newZoomLevel && oldZoomLevel !== 0) {
    // Get cursor position in canvas coordinates
    const rect = targetCanvas.getBoundingClientRect();
    const style = getComputedStyle(targetCanvas);
    const borderLeft = parseFloat(style.borderLeftWidth) || 0;
    const borderTop = parseFloat(style.borderTopWidth) || 0;
    const scaleX = targetCanvas.width / (rect.width - borderLeft - parseFloat(style.borderRightWidth || 0));
    const scaleY = targetCanvas.height / (rect.height - borderTop - parseFloat(style.borderBottomWidth || 0));
    const cursorX = (e.clientX - rect.left - borderLeft) * scaleX;
    const cursorY = (e.clientY - rect.top - borderTop) * scaleY;

    // Calculate the content point under the cursor
    const contentX = (cursorX - state.panX) / oldZoomLevel;
    const contentY = (cursorY - state.panY) / oldZoomLevel;

    // Update zoom and pan to keep the content point fixed
    state.zoomLevel = newZoomLevel;
    state.panX = cursorX - contentX * newZoomLevel;
    state.panY = cursorY - contentY * newZoomLevel;

    // Clamp with cursor awareness
    const { panX, panY } = clampView(state, targetCanvas, cursorX, cursorY);
    state.panX = panX;
    state.panY = panY;

    console.log(`Wheel zoom on ${canvasKey}: zoomLevel=${newZoomLevel.toFixed(3)}, pan=(${state.panX.toFixed(1)}, ${state.panY.toFixed(1)})`);
    
    // Disable selection buttons if zoomed
    if (state.hasZoomedIn) {
      disableSelectionButtons();
    } else {
      enableSelectionButtons();
    }
  } else {
    state.zoomLevel = newZoomLevel;
  }

  // Redraw immediately
  redrawCanvas(canvasKey, targetCanvas, ctx, state);
}

/**
 * Redraw canvas with current zoom and pan
 * Complete implementation from editor.js lines 12933-12986
 * @param {string} canvasKey - Canvas identifier
 * @param {HTMLCanvasElement} canvas - Canvas element
 * @param {CanvasRenderingContext2D} ctx - Canvas context
 * @param {Object} state - Canvas zoom state
 */
export function redrawCanvas(canvasKey, canvas, ctx, state) {
  if (!state.offscreenCanvas || state.offscreenCanvas.width !== canvas.width || state.offscreenCanvas.height !== canvas.height) {
    console.warn(`Invalid offscreenCanvas for ${canvasKey}, reinitializing`);
    state.offscreenCanvas = document.createElement('canvas');
    state.offscreenCanvas.width = canvas.width;
    state.offscreenCanvas.height = canvas.height;
    const offscreenCtx = state.offscreenCanvas.getContext('2d', { alpha: true });
    offscreenCtx.imageSmoothingEnabled = true;
    offscreenCtx.imageSmoothingQuality = 'high';
  }
  const offscreenCtx = state.offscreenCanvas.getContext('2d', { alpha: true });

  // Sync offscreen canvas
  let imageData = imageState.currentImageData[canvasKey];
  if (!imageData || imageData.width !== canvas.width || imageData.height !== canvas.height) {
    // Get unzoomed content by resetting transform
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    imageState.currentImageData[canvasKey] = imageData;
    console.log(`Refreshed currentImageData for ${canvasKey} in redrawCanvas with unzoomed data`);
    
    // Restore transform if needed
    if (state.zoomLevel !== 1 || state.panX !== 0 || state.panY !== 0) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.translate(state.panX, state.panY);
      ctx.scale(state.zoomLevel, state.zoomLevel);
      ctx.putImageData(imageData, 0, 0);
      ctx.restore();
    }
  }
  offscreenCtx.clearRect(0, 0, canvas.width, canvas.height);
  offscreenCtx.putImageData(imageData, 0, 0);

  // Draw with transformations
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(state.panX || 0, state.panY || 0);
  const appliedZoomLevel = state.zoomLevel || 1;
  ctx.scale(appliedZoomLevel, appliedZoomLevel);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(state.offscreenCanvas, 0, 0);
  ctx.restore();

  // Enhanced logging
  console.log(`Redraw for ${canvasKey}: zoomLevel=${appliedZoomLevel.toFixed(6)}, pan=(${state.panX || 0}, ${state.panY || 0}), hasContent=${imageData.data.some(v => v !== 0)}`);
}

/**
 * Reset zoom for a canvas
 * @param {string} canvasId - Canvas identifier
 */
export function resetZoom(canvasId) {
  const state = zoomState.canvasStates[canvasId];
  const canvas = canvasRefs[`${canvasId}Canvas`];
  const ctx = canvasRefs[`${canvasId}Ctx`];
  
  if (state && canvas && ctx) {
    state.zoomLevel = 1;
    state.panX = 0;
    state.panY = 0;
    state.hasZoomedIn = false;
    state.targetLocked = false;
    state.zoomPivotX = 0;
    state.zoomPivotY = 0;
    
    redrawCanvas(canvasId, canvas, ctx, state);
    enableSelectionButtons();
    
    console.log(`Zoom reset for ${canvasId}`);
  }
}

/**
 * Reset zoom for all canvases
 */
export function resetAllZoom() {
  ['base', 'paint', 'sampler'].forEach(canvasId => {
    const canvas = canvasRefs[`${canvasId}Canvas`];
    const ctx = canvasRefs[`${canvasId}Ctx`];
    const state = zoomState.canvasStates[canvasId];
    if (canvas && ctx && state) {
      resetZoom(canvasId);
    }
  });
}

/**
 * Clamp view to prevent panning outside canvas
 * Complete implementation from editor.js lines 13051-13104
 * @param {Object} state - Canvas zoom state
 * @param {HTMLCanvasElement} canvas - Canvas element
 * @param {number} cursorX - Cursor X position (optional)
 * @param {number} cursorY - Cursor Y position (optional)
 * @returns {Object} - { panX, panY }
 */
export function clampView(state, canvas, cursorX = null, cursorY = null) {
  const zoomLevel = state.zoomLevel;
  const canvasWidth = canvas.width;
  const canvasHeight = canvas.height;

  // Calculate the scaled dimensions of the canvas content
  const scaledWidth = canvasWidth * zoomLevel;
  const scaledHeight = canvasHeight * zoomLevel;

  // Viewport is the canvas display area
  const viewportWidth = canvasWidth;
  const viewportHeight = canvasHeight;

  let panX = state.panX;
  let panY = state.panY;

  // Special handling for zoom level 1 (full view)
  if (state.zoomLevel <= 1.01) {
    // Center the canvas at full view
    panX = 0;
    panY = 0;
    return { panX, panY };
  }

  // Calculate pan bounds to allow all canvas edges in the viewport
  const maxPanX = Math.max(0, scaledWidth - viewportWidth);
  const minPanX = Math.min(0, viewportWidth - scaledWidth);
  const maxPanY = scaledHeight - viewportHeight + 10;
  const minPanY = Math.min(0, viewportHeight - scaledHeight);

  // Clamp pan to keep content within viewport
  panX = Math.max(minPanX, Math.min(maxPanX, panX));
  panY = Math.max(minPanY, Math.min(maxPanY, panY));

  // Adjust pan to keep cursor's content point in view if provided
  if (cursorX !== null && cursorY !== null && state.zoomLevel > 1.01) {
    const contentX = (cursorX - panX) / state.zoomLevel;
    const contentY = (cursorY - panY) / state.zoomLevel;

    // Prioritize edge visibility when cursor is near them
    if (contentY > canvasHeight - 20 || contentY < 20 || contentX < 20 || contentX > canvasWidth - 20) {
      const desiredPanX = cursorX - contentX * state.zoomLevel;
      let desiredPanY = cursorY - contentY * state.zoomLevel;
      // Allow extra panning for bottom edge
      if (contentY > canvasHeight - 20) {
        desiredPanY = Math.min(desiredPanY, maxPanY);
      }
      panX = Math.max(minPanX, Math.min(maxPanX, desiredPanX));
      panY = Math.max(minPanY, Math.min(maxPanY, desiredPanY));
    }
  }

  return { panX, panY };
}

/**
 * Returns true if any modal is currently visible. Used to suppress zoom
 * shortcuts while a modal is open. Ported from editor.js:14098.
 */
export function isAnyModalOpen() {
  const allModalIds = [
    'aboutModal', 'randomizerModal', 'recordModal',
    'printerModal', 'saveModal', 'resolutionModal',
    'colorPickerModal', 'nftModal', 'networkModal',
    'ethereumContractModal', 'erc721MetadataModal',
    'erc1155MetadataModal', 'tezosMetadataModal',
    'roninMetadataModal', 'auroma25Modal'
  ];
  return allModalIds.some(modalId => {
    const modal = document.getElementById(modalId);
    if (!modal) return false;
    return getComputedStyle(modal).display !== 'none';
  });
}

/**
 * Minimal zoom-mode entry (ADR-0002 stub).
 *
 * Sets the state that the extracted drag/draw paths read (zoomState.isZooming,
 * per-canvas target-locks), clears selection, and disables selection buttons.
 * The deep interactive double-click / pan-pivot internals (~130 lines of the
 * original enterZoomMode) are deferred — wheel-zoom (handleZoomWheel) already
 * provides working zoom.
 */
export function enterZoomMode() {
  if (zoomState.isZooming) return;
  clearSelectionState();
  disableSelectionButtons();
  zoomState.isZooming = true;
  Object.keys(zoomState.canvasStates).forEach(key => {
    const s = zoomState.canvasStates[key];
    s.targetLocked = false;
    s.targetX = 0;
    s.targetY = 0;
    s.zoomPivotX = 0;
    s.zoomPivotY = 0;
  });
  const zoomBtn = document.getElementById('zoomBtn');
  if (zoomBtn) zoomBtn.classList.add('active');
}

/**
 * Minimal zoom-mode exit (ADR-0002 stub). Mirrors enterZoomMode: clears the
 * zoom flag, re-enables selection buttons, clears selection state, and (unless
 * preserving) clears per-canvas target-locks. Handler-removal from the deep
 * version is unnecessary because the stub entry never attaches those handlers.
 */
export function exitZoomMode(preserveZoom = false) {
  if (!zoomState.isZooming) return;
  zoomState.isZooming = false;
  enableSelectionButtons();
  clearSelectionState();
  if (!preserveZoom) {
    Object.keys(zoomState.canvasStates).forEach(key => {
      const s = zoomState.canvasStates[key];
      s.targetLocked = false;
      s.zoomPivotX = 0;
      s.zoomPivotY = 0;
    });
  }
  const zoomBtn = document.getElementById('zoomBtn');
  if (zoomBtn) zoomBtn.classList.remove('active');
}

/**
 * Wire the zoom button (click + touch) to toggle zoom mode, plus a global-click
 * detoggle. Per ADR-0001 this runs at boot, not at import time. The canvas wheel
 * listener is owned by initializeDrawing(); this owns only the button + detoggle.
 */
export function initializeZoom() {
  const zoomBtn = document.getElementById('zoomBtn');
  if (!zoomBtn) return;

  const toggle = () => (zoomState.isZooming ? exitZoomMode(true) : enterZoomMode());

  zoomBtn.addEventListener('click', (e) => {
    if (e.button === 0) { e.preventDefault(); toggle(); }
  });
  zoomBtn.addEventListener('touchend', (e) => { e.preventDefault(); toggle(); }, { passive: false });
  zoomBtn.addEventListener('touchcancel', () => exitZoomMode());

  // Global-click detoggle: leaving zoom when clicking outside the canvas/controls.
  document.addEventListener('click', (e) => {
    if (!zoomState.isZooming || e.button !== 0) return;
    if (e.target === zoomBtn || zoomBtn.contains(e.target)) return;
    if (e.target === canvasRefs.baseCanvas || e.target === canvasRefs.paintCanvas ||
        e.target === canvasRefs.samplerCanvas || !e.target.closest('#leftControls')) {
      return;
    }
    exitZoomMode();
  });
}

// Expose for backward compatibility
if (typeof window !== 'undefined') {
  window.handleZoomWheel = handleZoomWheel;
  window.resetZoom = resetZoom;
  window.resetAllZoom = resetAllZoom;
  window.redrawCanvas = redrawCanvas;
  window.clampView = clampView;
}
