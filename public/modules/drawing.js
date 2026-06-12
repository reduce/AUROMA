/**
 * Drawing and Smearing Tools Module
 * Handles all drawing operations, brush tools, and pixel smearing
 * Complete implementations extracted from editor.js
 */

import {
  brushState,
  dragState,
  canvasRefs,
  imageState,
  zoomState,
  selectionState,
  sweeperState,
  inputState,
  teleportState,
  recordingState,
  effectStates,
  animationState,
  activeEffects,
  rotationState,
  flipState,
  stickerImages,
  originalDimensions,
  recordingState as recState
} from './state.js';

import { applyEffects, toggleEffect, isPixelInBrushShape as effectsIsPixelInBrushShape } from './effects.js';
import { saveState } from './history.js';
import { getCanvasCoordinates } from './canvasManager.js';
import { effectMap, keyLabels, getKeyboardContainer } from './constants.js';
import { rgbToHsl, hslToRgb } from './utils.js';
import { redrawCanvas, clampView } from './zoom.js';
import { renderMarchingAnts, syncSelectionCanvasPosition, captureSelection, isPointInSelection } from './selection.js';

// Global handlers for recording (these may need to be imported or defined elsewhere)
// For now, we'll assume they're available via window or need to be imported
let recordMovement, startMovementRecording, playPianoEffect;

// Initialize global handlers if available
if (typeof window !== 'undefined') {
  recordMovement = window.recordMovement || (() => {});
  startMovementRecording = window.startMovementRecording || (() => {});
  playPianoEffect = window.playPianoEffect || (() => {});
}

// Helper to access state variables
const getStateValue = (path) => {
  const parts = path.split('.');
  let value = window;
  for (const part of parts) {
    value = value?.[part];
    if (value === undefined) break;
  }
  return value;
};

// Helper functions to access state (use these instead of direct aliases for mutation)
// For reading, we can use direct references. For mutation, always use state objects.

// Canvas references — populated by initializeDrawing() AFTER state.initializeCanvasRefs()
// runs. Per ADR-0001, modules must not read canvasRefs at import time: at import the
// refs are still null, and an eager `const {...} = canvasRefs` would capture those nulls
// permanently. These are assigned once in initializeDrawing() and read inside handlers.
let baseCanvas, baseCtx, paintCanvas, paintCtx, samplerCanvas, samplerCtx;

// Selection canvas elements (module-level variables)
let selectionCanvas = null;
let selectionCtx = null;
let selectionCacheCanvas = null;
let selectionCacheCtx = null;

// Keyboard container — resolved lazily in initializeDrawing() (DOM not ready at import).
let keyboardContainer;

// Helper function to get effect state value
function getEffectState(effectName) {
  const effectMap = {
    'lock': effectStates.isLockHeld,
    'hyphen': effectStates.isHyphenHeld,
    'brighten': effectStates.isBrightenHeld,
    'darken': effectStates.isDarkenHeld,
    'neon': effectStates.isNeonHeld,
    'original': effectStates.isOriginalHeld,
    'emoji': effectStates.isEmojiHeld,
    'trash': effectStates.isTrashHeld,
    'flag': effectStates.isFlagHeld,
    'chromaticShift': effectStates.isChromaticShiftHeld,
    'teleport': effectStates.isTeleportHeld,
    'caustics': effectStates.isCausticsHeld,
    'fractalStretch': effectStates.isFractalStretchHeld,
    'neonBend': effectStates.isNeonBendHeld,
    'glitchTide': effectStates.isGlitchTideHeld,
    'binaryRain': effectStates.isBinaryRainHeld,
    'photoCRT': effectStates.isPhotoCRTHeld,
    'pointBreak': effectStates.isPointBreakHeld,
    'scatter': effectStates.isScatterHeld,
    'ditherVibe': effectStates.isDitherVibeHeld,
    'flickerNegative': effectStates.isFlickerNegativeHeld
  };
  return effectMap[effectName] || false;
}

/**
 * Update brush size
 * @param {number} value - New brush size
 */
export function updateBrushSize(value) {
  let newSize = Math.max(1, Math.min(700, parseInt(value)));
  brushState.brushSize = newSize;
  brushState.baseBrushSize = newSize;
  if (document.getElementById('brushSizeSlider')) {
    document.getElementById('brushSizeSlider').value = newSize;
  }
  if (document.getElementById('sizeValue')) {
    document.getElementById('sizeValue').textContent = newSize;
  }
  if (isRecording && currentMovement) {
    if (recordMovement) {
      recordMovement('size', { size: newSize });
    }
  }
}

/**
 * Check if pixel is within brush shape
 * This version is used by drawing functions
 */
export function isPixelInBrushShape(px, py, centerX, centerY, halfBrush) {
  // Adjust for rotation
  const relX = px - centerX;
  const relY = py - centerY;
  const cosRot = Math.cos(-brushState.brushRotation); // Inverse rotation
  const sinRot = Math.sin(-brushState.brushRotation);
  let adjX = relX * cosRot - relY * sinRot;
  let adjY = relX * sinRot + relY * cosRot;

  // Apply flipping
  if (flipState.isFlipVerticalActive) {
    adjY = -adjY;
  }
  if (flipState.isFlipHorizontalActive) {
    adjX = -adjX;
  }

  const dx = Math.abs(adjX);
  const dy = Math.abs(adjY);

  if (brushState.brushShape === 'box') return dx <= halfBrush && dy <= halfBrush;
  if (brushState.brushShape === 'circle') return Math.sqrt(dx * dx + dy * dy) <= halfBrush;
  if (brushState.brushShape === 'rectangle') return dx <= halfBrush * 1.5 && dy <= halfBrush * 0.5;
  if (brushState.brushShape === 'triangle') {
    const height = halfBrush * 1.414;
    const slope = height / halfBrush;
    return dy <= height / 2 && dy >= -height / 2 && dx <= (height / 2 - Math.abs(dy)) / slope;
  }
  if (brushState.brushShape === 'melt') return dx <= halfBrush && dy <= halfBrush;
  if (brushState.brushShape === 'tv') return dx <= halfBrush && dy <= halfBrush;
  if (brushState.brushShape === 'negative') return dx <= halfBrush && dy <= halfBrush;
  if (brushState.brushShape === 'brokenScreen') return dx <= halfBrush && dy <= halfBrush;
  if (brushState.brushShape === 'jazzScatter') return dx <= halfBrush && dy <= halfBrush;
  return false; // Sweeper and oilbarrel handled separately
}

/**
 * Apply scatter effect by drawing multiple smaller copies
 */
export function applyScatterEffect(currentX, currentY, lastX, lastY, canvasId, ctx) {
  if (!isScatterHeld) return;

  const copyCount = Math.floor(8 + Math.random() * 5); // 8-12 copies
  const scatterRadius = brushState.brushSize * 0.75; // 1.5x radius for spread
  const originalBrushSize = brushState.brushSize;
  const originalRotation = brushState.brushRotation;
  const halfBrush = originalBrushSize / 2;

  // Use the main brush's position as the source for scattered copies
  const sourceX = currentX;
  const sourceY = currentY;

  for (let i = 0; i < copyCount; i++) {
    // Random size (5%-30% of original)
    const scale = 0.05 + Math.random() * 0.25;
    brushState.brushSize = Math.max(3, originalBrushSize * scale); // Minimum 3px for visibility
    // Position around brush, outside boundaries
    const minDistance = halfBrush + brushState.brushSize / 2; // Start outside original brush
    const distance = minDistance + Math.random() * scatterRadius;
    const offsetAngle = Math.random() * 2 * Math.PI; // Full 360° spread
    const scatterX = currentX + Math.cos(offsetAngle) * distance;
    const scatterY = currentY + Math.sin(offsetAngle) * distance;
    // Slight random rotation
    brushState.brushRotation = originalRotation + (Math.random() - 0.5) * 0.5;

    // Draw scatter point if within canvas and outside original brush
    if (scatterX >= 0 && scatterX < ctx.canvas.width && scatterY >= 0 && scatterY < ctx.canvas.height &&
        !isPixelInBrushShape(scatterX, scatterY, currentX, currentY, halfBrush)) {
      // Temporarily disable scatter to prevent recursion
      const wasScatterHeld = isScatterHeld;
      effectStates.isScatterHeld = false;
      smearPixels(scatterX, scatterY, canvasId, sourceX, sourceY, undefined, ctx.canvas);
      effectStates.isScatterHeld = wasScatterHeld;
    }
  }

  // Restore original state
  brushState.brushSize = originalBrushSize;
  brushState.brushRotation = originalRotation;
}

/**
 * Continue drag outside canvas (for mouse events)
 */
export function continueDragOutsideCanvas(e) {
  if (dragState.isDragging && e.buttons === 1 && touchPoints.length > 0) {
    const targetCanvas = touchPoints[0].target;
    const fakeEvent = {
      clientX: e.clientX,
      clientY: e.clientY,
      target: targetCanvas,
      type: 'mousemove',
      preventDefault: function() {},
      touches: null
    };
    drag(fakeEvent);
  }
}

/**
 * End drag outside canvas (for mouse events)
 */
export function endDragOutsideCanvas(e) {
  if (dragState.isDragging) {
    document.removeEventListener('mousemove', continueDragOutsideCanvas);
    document.removeEventListener('mouseup', endDragOutsideCanvas);
    const targetCanvas = touchPoints.length > 0 ? touchPoints[0].target : baseCanvas;
    const fakeEvent = {
      clientX: e.clientX,
      clientY: e.clientY,
      target: targetCanvas,
      type: 'mouseup',
      preventDefault: function() {},
      touches: []
    };
    endDrag(fakeEvent);
  }
}




// Large drawing functions with state references updated




/**
 * startDrag
 */
export function startDrag(e) {

// Add this debug block:
const debugCanvas = e.target === baseCanvas ? 'base' : 
                   e.target === paintCanvas ? 'paint' : 
                   e.target === samplerCanvas ? 'sampler' : 'unknown';
if (debugCanvas !== 'unknown') {
    const state = zoomState.canvasStates[debugCanvas];
}

const targetCanvas = e.target === baseCanvas ? baseCanvas :
                    e.target === paintCanvas ? paintCanvas :
                    e.target === samplerCanvas ? samplerCanvas : null;

// Skip if target is a button, within leftControls, or not a canvas
if (!targetCanvas || e.target.closest('#leftControls') || e.target.classList.contains('brush-icon') || e.target.closest('.control-icon')) {
    return;
}


e.preventDefault();
const touches = e.touches || (e.type === 'mousedown' ? [e] : []);

// Filter touches to only those targeting canvases
const validTouches = Array.from(touches).filter(touch => 
    touch.target === baseCanvas || touch.target === paintCanvas || touch.target === samplerCanvas
);

if (validTouches.length === 0) {
    return;
}

const canvasId = targetCanvas === baseCanvas ? 'base' : targetCanvas === paintCanvas ? 'paint' : 'sampler';
const ctx = canvasId === 'base' ? baseCtx : canvasId === 'paint' ? paintCtx : canvasId === 'sampler' ? samplerCtx : null;
const state = zoomState.canvasStates[canvasId];

if (!zoomState.isZooming && state.targetLocked) {
state.targetLocked = false;
// Don't clear zoom pivot if canvas is still zoomed
if (state.zoomLevel === 1) {
    state.zoomPivotX = 0;
    state.zoomPivotY = 0;
}
}

if (!ctx) {
    console.error('No context for canvas:', canvasId);
    return;
}

// Ensure mouse-toggled effects are applied for touch drags
const isTouchEvent = !!e.touches;
const isMouseEvent = !isTouchEvent && e.type === 'mousedown';
if (isTouchEvent && activeEffects.size > 0) {
    activeEffects.forEach(key => {
        const effect = Object.keys(effectMap).find(e => effectMap[e].key.toLowerCase() === key);
        if (effect) {
            const effectName = effect.charAt(0).toUpperCase() + effect.slice(1);
            const isEffectActive = getEffectState(effectName.toLowerCase());
            if (!isEffectActive) {
                toggleEffect(effect, true);
            }
        }
    });
}

// Prevent default behaviors
const canvasContainer = document.getElementById('canvasContainer');
canvasContainer.style.touchAction = 'none';
document.body.style.touchAction = 'none';

// Reset rotation unless arrow keys or multi-finger gesture
const isStickerMode = brushState.brushShape === 'stickerMode';
const minTouchPoints = isStickerMode ? 3 : 4;
if (!rotationState.isRotatingLeft && !rotationState.isRotatingRight && validTouches.length < minTouchPoints) {
    brushState.brushRotation = 0;
    rotationState.isIntentionalRotation = false;
}

// Initialize recording
if (recordingState.isRecording && !dragState.isDragging) {
    startMovementRecording();
    recordingState.currentMovement.activeEffects = [...activeEffects].map(k => keyLabels.find(kl => kl.key.toLowerCase() === k)?.effect).filter(e => e);
}

const keyboardRect = keyboardContainer.getBoundingClientRect();

// NEW: Always check if canvas is zoomed, not just if zoom tool is active
const isCanvasZoomed = state.zoomLevel !== 1;

// CRITICAL FIX: Force hide selection canvas when trying to zoom
if (zoomState.isZooming && selectionCanvas) {
selectionCanvas.style.display = 'none';
selectionCanvas.style.pointerEvents = 'none';
selectionCanvas.style.zIndex = '-1'; // Force it behind everything
}

// Handle zoom tool mode (when actively zooming)
if (zoomState.isZooming) {
    if (validTouches.length > 1) { 
        zoomState.isZooming = false; 
        zoomBtn.classList.remove('active'); 
    }

    let canvasTouch = validTouches[0];
    if (canvasTouch.target.id === 'zoomBtn' && validTouches.length > 1) {
        canvasTouch = validTouches[1];
    }
    if (!canvasTouch || canvasTouch.target !== targetCanvas) {
        if (validTouches.length > 1) {
            setTimeout(() => {
                startDrag(e);
            }, 50);
        }
        return;
    }

    const coords = getCanvasCoordinates(e, canvasTouch);
    if (isNaN(coords.x) || isNaN(coords.y) || (coords.x === 0 && coords.y === 0)) {
        console.warn('Invalid or (0,0) zoom target coords:', coords);
        return;
    }

    state.targetLocked = true;

    state.targetX = coords.x;
    state.targetY = coords.y;
    state.zoomPivotX = coords.x;
    state.zoomPivotY = coords.y;

    const newTouchPoint = {
        id: canvasTouch.identifier || `mouse0`,
        x: coords.x,
        y: coords.y,
        clientX: canvasTouch.clientX,
        clientY: canvasTouch.clientY,
        target: canvasTouch.target,
        lastX: coords.x,
        lastY: coords.y,
        startTime: Date.now(),
        isMouse: !e.touches
    };
    
    const existingIndex = inputState.touchPoints.findIndex(tp => tp.id === newTouchPoint.id);
    if (existingIndex >= 0) {
        inputState.touchPoints[existingIndex] = newTouchPoint;
    } else {
        inputState.touchPoints.push(newTouchPoint);
    }
    inputState.lastTouchPoints = [...inputState.touchPoints];

    if (!dragState.isDragging) {
        dragState.isDragging = true;
        dragState.shouldSaveState = true;
    }
    return;
}

// NEW: If canvas is zoomed but we're not in zoom tool mode, 
// we need to ensure coordinates are properly transformed
if (isCanvasZoomed) {
    // The getCanvasCoordinates function should handle zoom transformation
    // but we need to verify zoom pivot is set
    if (!state.zoomPivotX || !state.zoomPivotY) {
        console.warn('Canvas is zoomed but zoom pivot not set - using canvas center');
        state.zoomPivotX = targetCanvas.width / 2;
        state.zoomPivotY = targetCanvas.height / 2;
    }
}

// Handle selection tools
if (brushState.brushShape === 'squareSelection' || brushState.brushShape === 'basquiatSelection' || brushState.brushShape === 'circleSelection') {
// CRITICAL FIX: Check zoom mode FIRST before any selection logic
if (zoomState.isZooming) {
    return; // Exit early - don't process selection when zooming
}

const coords = getCanvasCoordinates(e, validTouches[0]);
if (isNaN(coords.x) || isNaN(coords.y) || !coords.valid) {
    console.error('Invalid selection coords:', coords);
    return;
}

    // Allow brush strokes to continue even when dragging outside canvas bounds
    function addGlobalDragListeners() {
        removeGlobalDragListeners();
        
        globalMouseMoveHandler = (e) => {
            if (dragState.isDragging && !zoomState.isZooming && e.buttons === 1) {
                drag(e);
            }
        };
        
        globalTouchMoveHandler = (e) => {
            if (dragState.isDragging && !zoomState.isZooming) {
                drag(e);
            }
        };
        
        document.addEventListener('mousemove', globalMouseMoveHandler, { passive: false });
        document.addEventListener('touchmove', globalTouchMoveHandler, { passive: false });
    }

    function removeGlobalDragListeners() {
        if (globalMouseMoveHandler) {
            document.removeEventListener('mousemove', globalMouseMoveHandler);
            globalMouseMoveHandler = null;
        }
        if (globalTouchMoveHandler) {
            document.removeEventListener('touchmove', globalTouchMoveHandler);
            globalTouchMoveHandler = null;
        }
    }


    if (!selectionState.selectionType) {
        selectionState.selectionType = brushState.brushShape === 'squareSelection' ? 'square' : brushState.brushShape === 'circleSelection' ? 'circle' : 'multipoint';
    }

if (!selectionCanvas || selectionCanvas.dataset.targetCanvasId !== targetCanvas.id) {
    if (selectionCanvas && selectionCanvas.parentNode) {
        selectionCanvas.parentNode.removeChild(selectionCanvas);
    }
    selectionCanvas = document.createElement('canvas');
    selectionCanvas.id = 'selectionCanvas';
    selectionCanvas.width = targetCanvas.width;
    selectionCanvas.height = targetCanvas.height;
    selectionCtx = selectionCanvas.getContext('2d', { alpha: true });
    selectionCanvas.style.position = 'absolute';
    selectionCanvas.style.zIndex = '2000';
    selectionCanvas.style.pointerEvents = 'none';
    selectionCanvas.style.display = 'block';
    selectionCanvas.dataset.targetCanvasId = targetCanvas.id;
    document.getElementById('canvasContainer').appendChild(selectionCanvas);
    syncSelectionCanvasPosition(targetCanvas);
    selectionCtx.clearRect(0, 0, selectionCanvas.width, selectionCanvas.height);
} else {
    selectionCanvas.width = targetCanvas.width;
    selectionCanvas.height = targetCanvas.height;
    selectionCanvas.dataset.targetCanvasId = targetCanvas.id;
    syncSelectionCanvasPosition(targetCanvas);
    selectionCtx.clearRect(0, 0, selectionCanvas.width, selectionCanvas.height);
}

if (zoomState.isZooming) {
    return;
}

if (recordingState.isRecording) {
    recordMovement('smear', {
        lastX: coords.x,
        lastY: coords.y,
        currentX: coords.x,
        currentY: coords.y,
        canvasId
    });
}

if (selectionState.isSelectionActive && selectionCanvas.dataset.targetCanvasId === targetCanvas.id) {
const isInside = isPointInSelection(coords.x, coords.y, brushState.brushShape);
if (isInside) {
    // Save state before dragging existing selection (new line added)
    saveState(true);
    // Initialize touch point with correct dragState.lastX, dragState.lastY
    inputState.touchPoints = [{
        id: validTouches[0].identifier || 'mouse0',
        x: coords.x,
        y: coords.y,
        target: targetCanvas,
        lastX: inputState.lastTouchPoints.find(tp => tp.id === (validTouches[0].identifier || 'mouse0'))?.x || coords.x,
        lastY: inputState.lastTouchPoints.find(tp => tp.id === (validTouches[0].identifier || 'mouse0'))?.y || coords.y,
        startTime: Date.now(),
        isMouse: isMouseEvent
    }];
    inputState.lastTouchPoints = [...inputState.touchPoints];
    dragState.isDragging = true;
    selectionState.isDraggingSelection = true;
    renderMarchingAnts();
    return;
} else {
    saveState(true);
    selectionState.isSelectionActive = false;
    selectionState.isSelecting = true;
    selectionState.isDraggingSelection = false;
    selectionState.selectedImageData = null;
    selectionState.selectionBounds = null;
    selectionState.selectionStart = null;
    selectionState.selectionEnd = null;
    selectionState.multipointPath = [];
    selectionCacheCanvas = null;
    selectionCtx.clearRect(0, 0, selectionCanvas.width, selectionCanvas.height);
}
}

if (brushState.brushShape === 'basquiatSelection' && validTouches.length === 1) {
if (zoomState.isZooming) {
    return;
}
        const currentTime = Date.now();
        if (isNaN(coords.x) || isNaN(coords.y)) {
            console.warn('Invalid coords for multipoint selection:', coords);
            return;
        }


        const maxPoints = isMouseEvent ? 20 : 40;

        if (selectionState.multipointPath.length > 2) {
            const firstPoint = selectionState.multipointPath[0];
            const distance = Math.sqrt(
                Math.pow(coords.x - firstPoint.x, 2) + Math.pow(coords.y - firstPoint.y, 2)
            );
            const proximityThreshold = isMouseEvent ? 15 : 35;
            if (distance < proximityThreshold) {
                window.lastCloseTime = currentTime;
                window.lastTapTime = currentTime;
                window.lastTouchId = isTouchEvent ? validTouches[0].identifier : 'mouse0';
                if (!window.lastEffectTime || currentTime - window.lastEffectTime >= 50) {
                    try {
                        playPianoEffect({ note: 64, velocity: 100, articulation: 'legato' }, currentTime);
                        window.lastEffectTime = currentTime;
                    } catch (e) {
                        console.error('Failed to play closure piano effect:', e);
                    }
                }
                selectionState.isSelecting = false;
                selectionState.isSelectionActive = true;
                selectionState.selectionBounds = calculatePolygonBounds(selectionState.multipointPath);
                selectionState.selectedImageData = captureSelection(targetCanvas, selectionState.multipointPath, 'multipoint');
                if (!selectionState.selectedImageData) {
                    console.error('Failed to capture multipoint selection');
                    selectionState.isSelectionActive = false;
                    selectionState.multipointPath = [];
                    return;
                }
                saveState(true);
                renderMarchingAnts();
                return;
            }
        }

        if (isTouchEvent && window.lastTouchId === validTouches[0].identifier && currentTime - window.lastTouchTime < 200) {
            return;
        }
        window.lastTouchId = isTouchEvent ? validTouches[0].identifier : 'mouse0';
        window.lastTouchTime = currentTime;

        if (isTouchEvent && window.lastTapTime && currentTime - window.lastTapTime < 200) {
            return;
        }

        if (isTouchEvent && selectionState.isSelectionActive && currentTime - window.lastCloseTime < 200) {
            return;
        }

        if (selectionState.multipointPath.length < maxPoints) {
            
            selectionState.multipointPath.push({ x: coords.x, y: coords.y });
            let pointsAdded = 1;
            if (!window.lastEffectTime || currentTime - window.lastEffectTime >= 50) {
                try {
                    playPianoEffect({ note: 60, velocity: 60, articulation: 'staccato' }, currentTime);
                    window.lastEffectTime = currentTime;
                } catch (e) {
                    console.error('Failed to play point piano effect:', e);
                }
            }
            if (isTouchEvent && selectionState.multipointPath.length < maxPoints - 1) {
                selectionState.multipointPath.push({ x: coords.x, y: coords.y });
                pointsAdded = 2;
                if (!window.lastEffectTime || currentTime - window.lastEffectTime >= 50) {
                    try {
                        playPianoEffect({ note: 60, velocity: 60, articulation: 'staccato' }, currentTime);
                        window.lastEffectTime = currentTime;
                    } catch (e) {
                        console.error('Failed to play second point piano effect:', e);
                    }
                }
            } else if (isTouchEvent && selectionState.multipointPath.length === maxPoints - 1) {
            } else if (isMouseEvent) {
            }
            window.lastTapTime = isTouchEvent ? currentTime : 0;
            selectionState.isSelecting = true;
            selectionState.selectionType = 'multipoint';

            if (selectionState.multipointPath.length >= maxPoints) {
                selectionState.multipointPath = selectionState.multipointPath.slice(0, maxPoints);
                if (!window.lastEffectTime || currentTime - window.lastEffectTime >= 50) {
                    try {
                        playPianoEffect({ note: 64, velocity: 100, articulation: 'legato' }, currentTime);
                        window.lastEffectTime = currentTime;
                    } catch (e) {
                        console.error('Failed to play auto-closure piano effect:', e);
                    }
                }
                window.lastCloseTime = currentTime;
                window.lastTapTime = currentTime;
                selectionState.isSelecting = false;
                selectionState.isSelectionActive = true;
                selectionState.selectionBounds = calculatePolygonBounds(selectionState.multipointPath);
                selectionState.selectedImageData = captureSelection(targetCanvas, selectionState.multipointPath, 'multipoint');
                if (!selectionState.selectedImageData) {
                    console.error('Failed to capture multipoint selection');
                    selectionState.isSelectionActive = false;
                    selectionState.multipointPath = [];
                    return;
                }
                saveState(true);
                renderMarchingAnts();
                return;
            }

            renderMarchingAnts();
            if (recordingState.isRecording) {
                recordMovement('smear', {
                    lastX: coords.x,
                    lastY: coords.y,
                    currentX: coords.x,
                    currentY: coords.y,
                    canvasId
                });
            }
        } else if (isTouchEvent) {
            selectionState.multipointPath = selectionState.multipointPath.slice(0, maxPoints);
            if (!window.lastEffectTime || currentTime - window.lastEffectTime >= 50) {
                try {
                    playPianoEffect({ note: 64, velocity: 100, articulation: 'legato' }, currentTime);
                    window.lastEffectTime = currentTime;
                } catch (e) {
                    console.error('Failed to play auto-closure piano effect:', e);
                }
            }
            window.lastCloseTime = currentTime;
            window.lastTapTime = currentTime;
            selectionState.isSelecting = false;
            selectionState.isSelectionActive = true;
            selectionState.selectionBounds = calculatePolygonBounds(selectionState.multipointPath);
            selectionState.selectedImageData = captureSelection(targetCanvas, selectionState.multipointPath, 'multipoint');
            if (!selectionState.selectedImageData) {
                console.error('Failed to capture multipoint selection');
                selectionState.isSelectionActive = false;
                selectionState.multipointPath = [];
                return;
            }
inputState.lastTouchPoints = [...inputState.touchPoints];

selectionState.isSelecting = true;
selectionState.isSelectionActive = false;
selectionState.isDraggingSelection = false; // Reset for new selection

if (brushState.brushShape === 'squareSelection') {
    selectionState.selectionStart = { x: coords.x, y: coords.y };
    selectionState.selectionEnd = { x: coords.x, y: coords.y };
    selectionState.selectionType = 'square';
} else if (brushState.brushShape === 'circleSelection') {
    selectionState.selectionStart = { x: coords.x, y: coords.y };
    selectionState.selectionEnd = { x: coords.x, y: coords.y };
    selectionState.selectionType = 'circle';
    // Ensure selection canvas is properly initialized
    if (selectionCanvas) {
        selectionCanvas.width = targetCanvas.width;
        selectionCanvas.height = targetCanvas.height;
        selectionCanvas.dataset.targetCanvasId = targetCanvas.id;
        syncSelectionCanvasPosition(targetCanvas);
        selectionCtx.clearRect(0, 0, selectionCanvas.width, selectionCanvas.height);
    }
} else {
    selectionState.multipointPath = [{ x: coords.x, y: coords.y }];
    selectionState.selectionType = 'multipoint';
}
renderMarchingAnts();
return;
}

// Existing drawing logic with enhanced filtering
inputState.touchPoints = validTouches
    .slice(0, 6)
    .filter(touch => {
        if (dragState.isDragging) return true;
        const clientX = touch.clientX;
        const clientY = touch.clientY;
        const isOverKeys = clientX >= keyboardRect.left && clientX <= keyboardRect.right && 
                          clientY >= keyboardRect.top && clientY <= keyboardRect.bottom;
        return !isOverKeys && touch.target === targetCanvas;
    })
    .map((touch, index) => {
        const coords = getCanvasCoordinates(e, touch);
        if (isNaN(coords.x) || isNaN(coords.y) || !coords.valid) {
            console.error('Invalid touch coords:', coords, 'Touch:', touch);
            return null;
        }
        return {
            id: touch.identifier || `mouse${index}`,
            x: coords.x,
            y: coords.y,
            target: touch.target,
            lastX: coords.x,
            lastY: coords.y,
            startTime: Date.now(),
            isMouse: !e.touches
        };
    })
    .filter(tp => tp !== null);

if (inputState.touchPoints.length === 0) {
    return;
}

if (!dragState.isDragging) {
// Save state before starting any operation
saveState(true); // Force save to ensure each drag gets its own undo state
dragState.isDragging = true;
dragState.hasCanvasChanged = false;
dragState.shouldSaveState = true;

// Add document-level mouse tracking for seamless dragging outside canvas
if (!e.touches) {
    document.addEventListener('mousemove', continueDragOutsideCanvas, { passive: false });
    document.addEventListener('mouseup', endDragOutsideCanvas, { passive: false });
}
}
inputState.lastTouchPoints = [...inputState.touchPoints];

const normalBrushes = ['box', 'circle', 'rectangle', 'triangle', 'tv', 'negative'];
if (normalBrushes.includes(brushState.brushShape)) {
    const firstFinger = inputState.touchPoints[0];
    teleportState.teleportFirstFinger = firstFinger.id;
    if (effectStates.isPaintMode) {
        dragState.lastX = firstFinger.x;
        dragState.lastY = firstFinger.y;
        smearPixels(firstFinger.x, firstFinger.y, canvasId);
        dragState.hasCanvasChanged = true;
        if (recordingState.isRecording) {
            recordMovement('smear', {
                lastX: firstFinger.lastX,
                lastY: firstFinger.lastY,
                currentX: firstFinger.x,
                currentY: firstFinger.y,
                canvasId,
                activeEffects: [...activeEffects].map(k => keyLabels.find(kl => kl.key.toLowerCase() === k)?.effect).filter(e => e)
            });
        }
    } else if (effectStates.isTeleportHeld) {
        teleportState.teleportSourceX = firstFinger.x;
        teleportState.teleportSourceY = firstFinger.y;
        teleportState.teleportCanvasId = canvasId;
        teleportState.teleportFirstFinger = firstFinger.id;

        teleportState.teleportDestinations = [];
        inputState.touchPoints.forEach((point, index) => {
            if (point.id === firstFinger.id) return;
            if (point.x === 0 && point.y === 0) {
                return;
            }
            const destCanvasId = point.target === baseCanvas ? 'base' : point.target === paintCanvas ? 'paint' : 'sampler';
            teleportState.teleportDestinations.push({
                canvasId: destCanvasId,
                x: point.x,
                y: point.y,
                lastX: point.x,
                lastY: point.y,
                fingerId: point.id,
                sourceOffsetX: point.x - firstFinger.x,
                sourceOffsetY: point.y - firstFinger.y,
                isSameCanvas: destCanvasId === canvasId
            });
        });

        teleportState.teleportDestinations.forEach(dest => {
            const sourceCanvas = firstFinger.target;
            smearPixels(dest.x, dest.y, dest.canvasId, teleportState.teleportSourceX, teleportState.teleportSourceY, undefined, sourceCanvas);
            dragState.hasCanvasChanged = true;
            if (recordingState.isRecording) {
                recordMovement('smear', {
                    lastX: dest.lastX || dest.x,
                    lastY: dest.lastY || dest.y,
                    currentX: dest.x,
                    currentY: dest.y,
                    canvasId: dest.canvasId,
                    fingerId: dest.fingerId,
                    isTeleportClone: true,
                    isSameCanvas: dest.isSameCanvas,
                    activeEffects: [...activeEffects].map(k => keyLabels.find(kl => kl.key.toLowerCase() === k)?.effect).filter(e => e)
                });
            }
        });
    } else {
        dragState.lastX = firstFinger.x;
        dragState.lastY = firstFinger.y;
        if (inputState.touchPoints.length >= 3 && !firstFinger.isMouse) {
            const thirdFinger = inputState.touchPoints[2];
            const sourceCanvas = thirdFinger.target;
            const sourceCanvasId = sourceCanvas === baseCanvas ? 'base' : sourceCanvas === paintCanvas ? 'paint' : 'sampler';
            if (thirdFinger.x === 0 && thirdFinger.y === 0) {
                smearPixels(firstFinger.x, firstFinger.y, canvasId);
                dragState.hasCanvasChanged = true;
            } else {
                const sourceCtx = sourceCanvas === baseCanvas ? baseCtx : sourceCanvas === paintCanvas ? paintCtx : samplerCtx;
                try {
                    const pixelData = sourceCtx.getImageData(Math.round(thirdFinger.x), Math.round(thirdFinger.y), 1, 1).data;
                    smearPixels(firstFinger.x, firstFinger.y, canvasId, thirdFinger.x, thirdFinger.y, undefined, sourceCanvas);
                    dragState.hasCanvasChanged = true;
                } catch (e) {
                    console.error(`Failed to get pixel data at (${thirdFinger.x}, ${thirdFinger.y}) on ${sourceCanvasId}:`, e);
                    smearPixels(firstFinger.x, firstFinger.y, canvasId);
                    dragState.hasCanvasChanged = true;
                }
            }
            thirdFinger.lastX = thirdFinger.x;
            thirdFinger.lastY = thirdFinger.y;
            if (recordingState.isRecording) {
                recordMovement('smear', {
                    lastX: firstFinger.lastX,
                    lastY: firstFinger.lastY,
                    currentX: firstFinger.x,
                    currentY: firstFinger.y,
                    sourceX: thirdFinger.x,
                    sourceY: thirdFinger.y,
                    sourceCanvasId: sourceCanvasId,
                    canvasId,
                    isReverseTeleport: true,
                    activeEffects: [...activeEffects].map(k => keyLabels.find(kl => kl.key.toLowerCase() === k)?.effect).filter(e => e)
                });
            }
        } else {
            smearPixels(firstFinger.x, firstFinger.y, canvasId);
            dragState.hasCanvasChanged = true;
            if (recordingState.isRecording) {
                recordMovement('smear', {
                    lastX: firstFinger.lastX,
                    lastY: firstFinger.lastY,
                    currentX: firstFinger.x,
                    currentY: firstFinger.y,
                    canvasId,
                    activeEffects: [...activeEffects].map(k => keyLabels.find(kl => kl.key.toLowerCase() === k)?.effect).filter(e => e)
                });
            }
        }
    }
} else if (brushState.brushShape === 'sweeper' || brushState.brushShape === 'oilbarrel') {
const isTouchEvent = !!e.touches;
if (inputState.touchPoints[0].isMouse) {
    // Mouse input: Single anchor point with lag for sweeper, or oilbarrel drag
    brushState.brushRotation = 0;
    sweeperState.mouseAnchorStart = { x: inputState.touchPoints[0].x, y: inputState.touchPoints[0].y, target: inputState.touchPoints[0].target };
    if (brushState.brushShape === 'oilbarrel') {
        dragState.oilbarrelDragState = {
startX: inputState.touchPoints[0].x,  // Use raw coordinates
startY: inputState.touchPoints[0].y,  // Use raw coordinates
endX: inputState.touchPoints[0].x,
endY: inputState.touchPoints[0].y,
canvasId: canvasId,
ctx: ctx,
targetCanvas: targetCanvas
};

        sweeperState.anchorPoints = [
            { x: inputState.touchPoints[0].x, y: inputState.touchPoints[0].y, target: inputState.touchPoints[0].target, lastX: inputState.touchPoints[0].x, lastY: inputState.touchPoints[0].y },
            { x: inputState.touchPoints[0].x, y: inputState.touchPoints[0].y, target: inputState.touchPoints[0].target, lastX: inputState.touchPoints[0].x, lastY: inputState.touchPoints[0].y }
        ];
        if (sweeperState.anchorPoints.every(p => !isNaN(p.x) && !isNaN(p.y) && (p.x !== 0 || p.y !== 0))) {
            dragState.isDraggingOilbarrel = true;
            if (dragState.oilbarrelRafId) cancelAnimationFrame(dragState.oilbarrelRafId);
            dragState.oilbarrelRafId = requestAnimationFrame(renderOilbarrelMouse);
            if (recordingState.isRecording) {
                // FIXED: Enhanced mouse recording with complete anchor state
                recordMovement('smear', {
                    lastX: sweeperState.anchorPoints[0]?.lastX || sweeperState.anchorPoints[0]?.x,
                    lastY: sweeperState.anchorPoints[0]?.lastY || sweeperState.anchorPoints[0]?.y,
                    currentX: sweeperState.anchorPoints[1]?.x,
                    currentY: sweeperState.anchorPoints[1]?.y,
                    canvasId,
                    brushShape: brushState.brushShape,
                    anchorPoints: sweeperState.anchorPoints.map((p, index) => ({ 
                        x: p.x, 
                        y: p.y, 
                        lastX: p.lastX || p.x,
                        lastY: p.lastY || p.y,
                        fingerId: `mouse_${index}`,
                        target: p.target?.id || 'canvas'
                    })),
                    fingerCount: 1,
                    inputType: 'mouse',
                    gestureId: Date.now(),
                    activeEffects: [...activeEffects].map(k => keyLabels.find(kl => kl.key.toLowerCase() === k)?.effect).filter(e => e)
                });
            }
        } else {
        }
    } else {
        sweeperState.anchorPoints = [
            { x: inputState.touchPoints[0].x, y: inputState.touchPoints[0].y, target: inputState.touchPoints[0].target, lastX: inputState.touchPoints[0].x, lastY: inputState.touchPoints[0].y },
            { x: inputState.touchPoints[0].x, y: inputState.touchPoints[0].y, target: inputState.touchPoints[0].target, lastX: inputState.touchPoints[0].x, lastY: inputState.touchPoints[0].y }
        ];
        if (sweeperState.anchorPoints.every(p => !isNaN(p.x) && !isNaN(p.y) && (p.x !== 0 || p.y !== 0))) {
            drawSweeperLines(canvasId);
            dragState.hasCanvasChanged = true;
            if (recordingState.isRecording) {
                // Record as single coordinated gesture
                recordMovement('smear', {
                    lastX: sweeperState.anchorPoints[0].x,
                    lastY: sweeperState.anchorPoints[0].y,
                    currentX: sweeperState.anchorPoints[1].x,
                    currentY: sweeperState.anchorPoints[1].y,
                    canvasId,
                    brushShape: brushState.brushShape,
                    anchorPoints: sweeperState.anchorPoints.map(p => ({ x: p.x, y: p.y })),
                    fingerCount: 1,
                    inputType: 'mouse',
                    gestureId: Date.now(), // Unique ID for this gesture
                    activeEffects: [...activeEffects].map(k => keyLabels.find(kl => kl.key.toLowerCase() === k)?.effect).filter(e => e)
                });
            }
        } else {
        }
    }
} else if (isTouchEvent && inputState.touchPoints.length >= 1 && inputState.touchPoints.length <= 5) {
    // Touch input: 1–5 fingers for dynamic multi-point lines
    sweeperState.anchorPoints = inputState.touchPoints.slice(0, 5).map(point => ({
        x: point.x,
        y: point.y,
        target: point.target,
        lastX: point.x,
        lastY: point.y,
        id: point.id
    }));
    if (sweeperState.anchorPoints.every(p => !isNaN(p.x) && !isNaN(p.y) && (p.x !== 0 || p.y !== 0))) {
        if (brushState.brushShape === 'oilbarrel') {
            dragState.oilbarrelDragState = {
                startX: sweeperState.anchorPoints[0].x,
                startY: sweeperState.anchorPoints[0].y,
                endX: sweeperState.anchorPoints[sweeperState.anchorPoints.length - 1].x,
                endY: sweeperState.anchorPoints[sweeperState.anchorPoints.length - 1].y,
                canvasId: canvasId,
                ctx: ctx,
                targetCanvas: targetCanvas
            };
            dragState.isDraggingOilbarrel = true;
            if (dragState.oilbarrelRafId) cancelAnimationFrame(dragState.oilbarrelRafId);
            dragState.oilbarrelRafId = requestAnimationFrame(renderOilbarrelMouse);
        } else {
            drawSweeperLines(canvasId);
            dragState.hasCanvasChanged = true;
        }
        if (recordingState.isRecording) {
        // FIXED: Enhanced recording with complete anchor point data
        const gestureId = Date.now();
        recordMovement('smear', {
            lastX: sweeperState.anchorPoints[0]?.lastX || sweeperState.anchorPoints[0]?.x,
            lastY: sweeperState.anchorPoints[0]?.lastY || sweeperState.anchorPoints[0]?.y,
            currentX: sweeperState.anchorPoints[0]?.x,
            currentY: sweeperState.anchorPoints[0]?.y,
            canvasId,
            brushShape: brushState.brushShape,
            anchorPoints: sweeperState.anchorPoints.map((p, index) => ({ 
                x: p.x, 
                y: p.y, 
                lastX: p.lastX || p.x, 
                lastY: p.lastY || p.y,
                fingerId: p.id || `finger_${index}`,
                target: p.target?.id || 'canvas'
            })),
            fingerCount: sweeperState.anchorPoints.length,
            inputType: 'touch',
            gestureId: gestureId,
            activeEffects: [...activeEffects].map(k => keyLabels.find(kl => kl.key.toLowerCase() === k)?.effect).filter(e => e)
        });
    }
    } else {
    }
} else {
}
} else if (brushState.brushShape === 'aestheticLines') {

sweeperState.mouseAnchorStart = { x: inputState.touchPoints[0].x, y: inputState.touchPoints[0].y, target: inputState.touchPoints[0].target };
sweeperState.anchorPoints = [
    { x: inputState.touchPoints[0].x, y: inputState.touchPoints[0].y, target: inputState.touchPoints[0].target, lastX: inputState.touchPoints[0].x, lastY: inputState.touchPoints[0].y },
    { x: inputState.touchPoints[0].x, y: inputState.touchPoints[0].y, target: inputState.touchPoints[0].target, lastX: inputState.touchPoints[0].x, lastY: inputState.touchPoints[0].y }
];


if (sweeperState.anchorPoints.every(p => !isNaN(p.x) && !isNaN(p.y) && (p.x !== 0 || p.y !== 0))) {
    drawAestheticLines(canvasId);
    dragState.hasCanvasChanged = true;
} else {
}
if (recordingState.isRecording && dragState.hasCanvasChanged) {
    // FIXED: Record anchor points for initial touch
    recordMovement('smear', {
        lastX: inputState.touchPoints[0].x,
        lastY: inputState.touchPoints[0].y,
        currentX: inputState.touchPoints[0].x,
        currentY: inputState.touchPoints[0].y,
        canvasId,
        brushShape: 'aestheticLines',
        // FIXED: Include anchor points
        anchorPoints: sweeperState.anchorPoints.map((p, index) => ({
            x: p.x,
            y: p.y,
            lastX: p.lastX || p.x,
            lastY: p.lastY || p.y,
            fingerId: `aesthetic_start_${index}`,
            target: p.target?.id || 'canvas',
            index: index
        })),
        mouseAnchorStart: sweeperState.mouseAnchorStart ? {
            x: sweeperState.mouseAnchorStart.x,
            y: sweeperState.mouseAnchorStart.y,
            target: sweeperState.mouseAnchorStart.target?.id || 'canvas'
        } : undefined,
        fingerCount: sweeperState.anchorPoints.length,
        inputType: inputState.touchPoints[0]?.isMouse ? 'mouse' : 'touch',
        gestureId: Date.now(),
        activeEffects: [...activeEffects].map(k => keyLabels.find(kl => kl.key.toLowerCase() === k)?.effect).filter(e => e)
    });
}
} // FIXED STICKER MODE SECTION FOR STARTDRAG AND DRAG FUNCTIONS
// Replace the existing stickerMode sections with this code

else if (brushState.brushShape === 'stickerMode') {
const activeStamps = brushState.stampOrder.filter(slot => stickerImages[slot]);

if (effectStates.isTeleportHeld && inputState.touchPoints.length >= 1) {
    // Separate original and clone fingers
    const maxStamps = activeStamps.length;
    const originalFingers = inputState.touchPoints.slice(0, maxStamps);
    const cloneFingers = inputState.touchPoints.slice(maxStamps);
    

    // Process original stamps first
    for (let i = 0; i < originalFingers.length && i < activeStamps.length; i++) {
        const point = originalFingers[i];
        const slot = activeStamps[i];
        
        if (point.x === 0 && point.y === 0) {
            continue;
        }
        
        const canvasId = point.target === baseCanvas ? 'base' : point.target === paintCanvas ? 'paint' : 'sampler';
        
        if (stickerImages[slot]) {
            smearPixels(point.x, point.y, canvasId, undefined, undefined, slot);
            dragState.hasCanvasChanged = true;
            
            point.lastX = point.x;
            point.lastY = point.y;
            
            if (recordingState.isRecording) {
                recordMovement('smear', {
                    lastX: point.lastX,
                    lastY: point.lastY,
                    currentX: point.x,
                    currentY: point.y,
                    canvasId,
                    stickerSlot: slot,
                    brushShape: 'stickerMode',
                    fingerIndex: i + 1,
                    activeEffects: [...activeEffects].map(k => keyLabels.find(kl => kl.key.toLowerCase() === k)?.effect).filter(e => e)
                });
            }
        }
    }

    // Process clone stamps - each clone corresponds to an original
    for (let i = 0; i < cloneFingers.length && i < activeStamps.length; i++) {
        const clonePoint = cloneFingers[i];
        const originalPoint = originalFingers[i]; // Corresponding original
        const slot = activeStamps[i];
        
        if (!originalPoint || !clonePoint) continue;
        
        if (clonePoint.x === 0 && clonePoint.y === 0) {
            continue;
        }
        
        const cloneCanvasId = clonePoint.target === baseCanvas ? 'base' : clonePoint.target === paintCanvas ? 'paint' : 'sampler';
        const originalCanvasId = originalPoint.target === baseCanvas ? 'base' : originalPoint.target === paintCanvas ? 'paint' : 'sampler';
        
        if (stickerImages[slot]) {
            if (cloneCanvasId !== originalCanvasId) {
                // Cross-canvas clone - use original position as source
                smearPixels(clonePoint.x, clonePoint.y, cloneCanvasId, originalPoint.x, originalPoint.y, slot, originalPoint.target);
                dragState.hasCanvasChanged = true;
            } else {
                // Same canvas clone - draw normally
                smearPixels(clonePoint.x, clonePoint.y, cloneCanvasId, undefined, undefined, slot);
                dragState.hasCanvasChanged = true;
            }
            
            clonePoint.dragState.lastX = clonePoint.x;
            clonePoint.dragState.lastY = clonePoint.y;
            
            if (recordingState.isRecording) {
                recordMovement('smear', {
                    lastX: clonePoint.dragState.lastX,
                    lastY: clonePoint.dragState.lastY,
                    currentX: clonePoint.x,
                    currentY: clonePoint.y,
                    canvasId: cloneCanvasId,
                    stickerSlot: slot,
                    brushShape: 'stickerMode',
                    isTeleportClone: cloneCanvasId !== originalCanvasId,
                    sourceCanvasId: originalCanvasId,
                    sourceX: originalPoint.x,
                    sourceY: originalPoint.y,
                    fingerIndex: maxStamps + i + 1,
                    activeEffects: [...activeEffects].map(k => keyLabels.find(kl => kl.key.toLowerCase() === k)?.effect).filter(e => e)
                });
            }
        }
    }

    // Handle resize and rotation fingers (after stamps and clones)
    const totalStampFingers = originalFingers.length + cloneFingers.length;
    
    if (totalStampFingers < inputState.touchPoints.length) {
        const resizeFinger = inputState.touchPoints[totalStampFingers];
        if (resizeFinger) {
            const deltaY = (resizeFinger.y - resizeFinger.dragState.lastY) * 0.5;
            const newSize = Math.max(1, Math.min(700, brushState.brushSize + deltaY * 2));
            if (!isNaN(newSize)) {
                isGestureResizing = true;
                updateBrushSize(newSize);
                isGestureResizing = false;
                if (recordingState.isRecording && recordingState.currentMovement) recordingState.currentMovement.size = brushState.brushSize;
            }
            resizeFinger.dragState.lastX = resizeFinger.x;
            resizeFinger.dragState.lastY = resizeFinger.y;
        }
    }

    if (totalStampFingers + 1 < inputState.touchPoints.length) {
        const rotateFinger = inputState.touchPoints[totalStampFingers + 1];
        if (rotateFinger) {
            const rotateDeltaY = (rotateFinger.y - rotateFinger.dragState.lastY) * 0.005;
            brushState.brushRotation += rotateDeltaY;
            if (recordingState.isRecording && recordingState.currentMovement) recordingState.currentMovement.rotation = brushState.brushRotation;
            rotateFinger.dragState.lastX = rotateFinger.x;
            rotateFinger.dragState.lastY = rotateFinger.y;
        }
    }

} else {
    // Normal mode (no teleport) - unchanged
    const maxStamps = Math.min(activeStamps.length, inputState.touchPoints.length);
    for (let i = 0; i < maxStamps; i++) {
        const slot = activeStamps[i % activeStamps.length];
        const point = inputState.touchPoints[i];
        if (point.x === 0 && point.y === 0) {
            continue;
        }
        const canvasId = point.target === baseCanvas ? 'base' : point.target === paintCanvas ? 'paint' : 'sampler';
        if (stickerImages[slot]) {
            smearPixels(point.x, point.y, canvasId, undefined, undefined, slot);
            dragState.hasCanvasChanged = true;
            point.lastX = point.x;
            point.lastY = point.y;
            if (recordingState.isRecording) {
                recordMovement('smear', {
                    lastX: point.lastX,
                    lastY: point.lastY,
                    currentX: point.x,
                    currentY: point.y,
                    canvasId,
                    stickerSlot: slot,
                    brushShape: 'stickerMode',
                    fingerIndex: i + 1,
                    activeEffects: [...activeEffects].map(k => keyLabels.find(kl => kl.key.toLowerCase() === k)?.effect).filter(e => e)
                });
            }
        }
    }

    const stampCount = maxStamps;
    if (stampCount < inputState.touchPoints.length) {
        const resizeFinger = inputState.touchPoints[stampCount];
        if (resizeFinger) {
            const deltaY = (resizeFinger.y - resizeFinger.dragState.lastY) * 0.5;
            const newSize = Math.max(1, Math.min(700, brushState.brushSize + deltaY * 2));
            if (!isNaN(newSize)) {
                isGestureResizing = true;
                updateBrushSize(newSize);
                isGestureResizing = false;
                if (recordingState.isRecording && recordingState.currentMovement) recordingState.currentMovement.size = brushState.brushSize;
            }
            resizeFinger.dragState.lastX = resizeFinger.x;
            resizeFinger.dragState.lastY = resizeFinger.y;
        }
    }

    if (stampCount + 1 < inputState.touchPoints.length) {
        const rotateFinger = inputState.touchPoints[stampCount + 1];
        if (rotateFinger) {
            const rotateDeltaY = (rotateFinger.y - rotateFinger.dragState.lastY) * 0.005;
            brushState.brushRotation += rotateDeltaY;
            if (recordingState.isRecording && recordingState.currentMovement) recordingState.currentMovement.rotation = brushState.brushRotation;
            rotateFinger.dragState.lastX = rotateFinger.x;
            rotateFinger.dragState.lastY = rotateFinger.y;
        }
    }
}
} else if (brushState.brushShape === 'melt' || brushState.brushShape === 'brokenScreen' || brushState.brushShape === 'jazzScatter') {
    const firstFinger = inputState.touchPoints[0];
    if (firstFinger) {
        if (firstFinger.x === 0 && firstFinger.y === 0) {
            return;
        }
        smearPixels(firstFinger.x, firstFinger.y, canvasId);
        dragState.hasCanvasChanged = true;
        dragState.lastX = firstFinger.x;
        dragState.lastY = firstFinger.y;
        firstFinger.lastX = firstFinger.x;
        firstFinger.lastY = firstFinger.y;

        let meltDirection = 1;
        if (brushState.brushShape !== 'jazzScatter' && inputState.touchPoints.length >= 2) {
            const secondFinger = inputState.touchPoints[1];
            meltDirection = secondFinger.y < firstFinger.y ? -1 : 1;
            secondFinger.dragState.lastX = secondFinger.x;
            secondFinger.dragState.lastY = secondFinger.y;

            if (inputState.touchPoints.length >= 3) {
                const thirdFinger = inputState.touchPoints[2];
                const deltaY = (thirdFinger.y - thirdFinger.dragState.lastY) * 0.5;
                const newSize = Math.max(1, Math.min(700, brushState.brushSize + deltaY * 2));
                if (!isNaN(newSize)) {
                    isGestureResizing = true;
                    updateBrushSize(newSize);
                    isGestureResizing = false;
                    if (recordingState.isRecording && recordingState.currentMovement) recordingState.currentMovement.size = brushState.brushSize;
                }
                thirdFinger.dragState.lastX = thirdFinger.x;
                thirdFinger.dragState.lastY = thirdFinger.y;

                if (inputState.touchPoints.length >= 4) {
                    const fourthFinger = inputState.touchPoints[3];
                    if (fourthFinger) {
                        const rotateDeltaY = (fourthFinger.y - fourthFinger.dragState.lastY) * 0.005;
                        brushState.brushRotation += rotateDeltaY;
                        if (recordingState.isRecording && recordingState.currentMovement) recordingState.currentMovement.rotation = brushState.brushRotation;
                        fourthFinger.dragState.lastX = fourthFinger.x;
                        fourthFinger.dragState.lastY = fourthFinger.y;
                    }
                }
            }
        }
        if (recordingState.isRecording) {
            recordMovement('smear', {
                lastX: firstFinger.lastX,
                lastY: firstFinger.lastY,
                currentX: firstFinger.x,
                currentY: firstFinger.y,
                canvasId,
                activeEffects: [...activeEffects].map(k => keyLabels.find(kl => kl.key.toLowerCase() === k)?.effect).filter(e => e)
            });
        }
    }
}
}
} // close squareSelection/circleSelection/basquiatSelection branch (was unbalanced — see ADR-0003)
} // close startDrag


/**
 * drag
 */
export function drag(e) {
e.preventDefault();
const touches = e.touches || [e];

// Filter touches to only those targeting canvases
const validTouches = Array.from(touches).filter(touch => 
    touch.target === baseCanvas || touch.target === paintCanvas || touch.target === samplerCanvas
);

if (validTouches.length === 0) {
    return;
}

const targetCanvas = validTouches[0].target;
const canvasId = targetCanvas === baseCanvas ? 'base' : targetCanvas === paintCanvas ? 'paint' : 'sampler';
const ctx = canvasId === 'base' ? baseCtx : canvasId === 'paint' ? paintCtx : canvasId === 'sampler' ? samplerCtx : null;

if (!ctx) {
    console.error('No context for canvas:', canvasId);
    return;
}

// Update touch points, only rejecting truly invalid coordinates (not (0,0) which could be valid)
inputState.touchPoints = validTouches
    .slice(0, 10)
    .map((touch, index) => {
        const coords = getCanvasCoordinates({ ...e, target: targetCanvas }, touch);
        if (isNaN(coords.x) || isNaN(coords.y) || !coords.valid) {
            console.error('Invalid drag coordinates:', coords, 'Touch:', touch);
            return null;
        }
        const existing = inputState.lastTouchPoints.find(tp => tp.id === (touch.identifier || `mouse${index}`)) || {};
        return {
            id: touch.identifier || `mouse${index}`,
            x: coords.x, // No clamping
            y: coords.y, // No clamping
            clientX: touch.clientX,
            clientY: touch.clientY,
            target: targetCanvas,
            lastX: existing.x !== undefined ? existing.x : coords.x,
            lastY: existing.y !== undefined ? existing.y : coords.y,
            startTime: existing.startTime || Date.now(),
            isMouse: !e.touches
        };
    })
    .filter(tp => tp !== null);

if (inputState.touchPoints.length === 0) {

// Apply active effects without triggering brush actions
if (dragState.isDragging) {
    const activeEffectList = [...activeEffects]
        .map(k => keyLabels.find(kl => kl.key.toLowerCase() === k)?.effect)
        .filter(e => e);
    activeEffectList.forEach(effect => {
        toggleEffect(effect, true);
    });
}

// Zoom mode (keep clamping for pan/zoom)
// FIXED ZOOM TOOL WITHIN THE DRAG FUNCTION

if (zoomState.isZooming) {
if (validTouches.length !== 1) {
    return;
}
const touch = validTouches[0];
const canvasKey = canvasId;
const state = zoomState.canvasStates[canvasKey];

// REMOVED the re-locking logic that was keeping the pivot locked
if (!state.targetLocked) {
    return;
}

const currentX = touch.clientX;
const currentY = touch.clientY;
const lastX = inputState.lastTouchPoints[0]?.clientX || currentX;
const lastY = inputState.lastTouchPoints[0]?.clientY || currentY;
const deltaY = currentY - lastY;
const zoomSpeed = 0.005;
const zoomFactor = deltaY > 0 ? 1 / (1 + zoomSpeed * Math.abs(deltaY)) : 1 + zoomSpeed * Math.abs(deltaY);
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

// FIXED: Check if we're approaching zoom level 1 (full view)
const isReturningToFullView = newZoomLevel <= 1.1 && oldZoomLevel > 1.1;

if (isReturningToFullView) {
    // Reset to full view
    state.zoomLevel = 1;
    state.panX = 0;
    state.panY = 0;
    // Clear the zoom pivot to prevent re-locking
    state.zoomPivotX = 0;
    state.zoomPivotY = 0;
    state.targetLocked = false;
} else if (oldZoomLevel !== newZoomLevel && oldZoomLevel !== 0) {
    const pivotX = state.zoomPivotX;
    const pivotY = state.zoomPivotY;
    const contentX = (pivotX - state.panX) / oldZoomLevel;
    const contentY = (pivotY - state.panY) / oldZoomLevel;
    state.zoomLevel = newZoomLevel;
    state.panX = pivotX - contentX * newZoomLevel;
    state.panY = pivotY - contentY * newZoomLevel;
    const { panX, panY } = clampView(state, targetCanvas, pivotX, pivotY);
    state.panX = panX;
    state.panY = panY;
} else {
    state.zoomLevel = newZoomLevel;
}

// FIXED: Use the dedicated redrawCanvas function instead of inline drawing
if (!state.isRedrawing) {
    state.isRedrawing = true;
    if (state.redrawRequest) cancelAnimationFrame(state.redrawRequest);
    state.redrawRequest = requestAnimationFrame(() => {
        try {
            // Ensure imageState.currentImageData is up to date
            if (!imageState.currentImageData[canvasKey] || imageState.currentImageData[canvasKey].width !== targetCanvas.width || imageState.currentImageData[canvasKey].height !== targetCanvas.height) {
                imageState.currentImageData[canvasKey] = ctx.getImageData(0, 0, targetCanvas.width, targetCanvas.height);
            }
            
            // Use the centralized redraw function
            redrawCanvas(canvasKey, targetCanvas, ctx, state);
            
        } catch (error) {
            console.error('Error during zoom redraw:', error);
        } finally {
            state.redrawRequest = null;
            state.isRedrawing = false;
        }
    });
}

        inputState.lastTouchPoints = [{
        id: touch.identifier || `mouse0`,
        clientX: currentX,
        clientY: currentY,
        x: getCanvasCoordinates(e, touch)?.x || 0,
        y: getCanvasCoordinates(e, touch)?.y || 0,
        target: targetCanvas,
        lastX: getCanvasCoordinates(e, touch)?.x || 0,
        lastY: getCanvasCoordinates(e, touch)?.y || 0,
        startTime: Date.now(),
        isMouse: !e.touches
    }];
return;
}


// Selection tools
if (brushState.brushShape === 'squareSelection' || brushState.brushShape === 'basquiatSelection' || brushState.brushShape === 'circleSelection') {
if (zoomState.isZooming) {
    return;
}
const now = Date.now();
if (now - selectionState.lastDragTime < selectionState.dragThrottleMs) return;
selectionState.lastDragTime = now;

if (selectionState.isSelecting && (brushState.brushShape === 'squareSelection' || brushState.brushShape === 'circleSelection')) {
    const coords = getCanvasCoordinates({ ...e, target: targetCanvas }, validTouches[0]);
    if (coords.x === 0 && coords.y === 0) {
        return;
    }
    selectionState.selectionEnd = { x: coords.x, y: coords.y };
    renderMarchingAnts();
} else if ((selectionState.isSelectionActive || selectionState.isDraggingSelection) && selectionCanvas.dataset.targetCanvasId === targetCanvas.id) {
let avgDeltaX = 0, avgDeltaY = 0, validPoints = 0;
inputState.touchPoints.forEach(point => {
    if (isPointInSelection(point.x, point.y, brushState.brushShape)) {
        avgDeltaX += point.x - point.lastX;
        avgDeltaY += point.y - point.lastY;
        validPoints++;
    }
});
if (validPoints === 0) {
    return;
}
avgDeltaX /= validPoints;
avgDeltaY /= validPoints;

if (selectionState.selectedImageData && selectionState.selectionBounds) {
    if (!selectionCacheCanvas) {
        selectionCacheCanvas = document.createElement('canvas');
        selectionCacheCanvas.width = selectionState.selectedImageData.width;
        selectionCacheCanvas.height = selectionState.selectedImageData.height;
        selectionCacheCtx = selectionCacheCanvas.getContext('2d', { alpha: true });
        selectionCacheCtx.putImageData(selectionState.selectedImageData, 0, 0);
    }

    const newX = selectionState.selectionBounds.xMin + avgDeltaX;
    const newY = selectionState.selectionBounds.yMin + avgDeltaY;

    // CRITICAL FIX: Restore the original canvas state before drawing selection at new position
    if (imageState.currentImageData[canvasId]) {
        ctx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
        ctx.putImageData(imageState.currentImageData[canvasId], 0, 0);
    }

    const pixels = [];
        const width = selectionState.selectedImageData.width;
        const height = selectionState.selectedImageData.height;
        const data = selectionState.selectedImageData.data;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i = (y * width + x) * 4;
                if (data[i + 3] > 0) {
                    let canvasX = x + newX;
                    let canvasY = y + newY;
                    if (brushState.brushRotation !== 0) {
                        const relX = canvasX - (newX + width / 2);
                        const relY = canvasY - (newY + height / 2);
                        const cosRot = Math.cos(brushState.brushRotation);
                        const sinRot = Math.sin(brushState.brushRotation);
                        canvasX = newX + width / 2 + (relX * cosRot - relY * sinRot);
                        canvasY = newY + height / 2 + (relX * sinRot + relY * cosRot);
                    }
                    if (flipState.isFlipVerticalActive) {
                        canvasY = newY + height - (canvasY - newY);
                    }
                    pixels.push({
                        r: data[i],
                        g: data[i + 1],
                        b: data[i + 2],
                        x: canvasX,
                        y: canvasY
                    });
                }
            }
        }

        applyEffects(pixels, avgDeltaX, avgDeltaY, selectionState.selectionBounds.xMin, selectionState.selectionBounds.yMin, newX, newY);

        ctx.save();
        if (brushState.brushShape === 'basquiatSelection') {
            ctx.beginPath();
            selectionState.multipointPath.forEach((point, index) => {
                const px = point.x + avgDeltaX;
                const py = point.y + avgDeltaY;
                if (index === 0) ctx.moveTo(px, py);
                else ctx.lineTo(px, py);
            });
            ctx.closePath();
            ctx.clip();
        } else if (brushState.brushShape === 'squareSelection') {
            ctx.beginPath();
            ctx.rect(newX, newY, width, height);
            ctx.clip();
        } else if (brushState.brushShape === 'circleSelection') {
            ctx.beginPath();
            ctx.ellipse(
                newX + width / 2,
                newY + height / 2,
                width / 2,
                height / 2,
                0,
                0,
                2 * Math.PI
            );
            ctx.clip();
        }

        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = targetCanvas.width;
        tempCanvas.height = targetCanvas.height;
        const tempCtx = tempCanvas.getContext('2d');
        const tempImageData = tempCtx.createImageData(tempCanvas.width, tempCanvas.height);
        const tempData = tempImageData.data;

        pixels.forEach(pixel => {
            const px = Math.round(pixel.x);
            const py = Math.round(pixel.y);
            if (px >= 0 && px < tempCanvas.width && py >= 0 && py < tempCanvas.height) {
                const i = (py * tempCanvas.width + px) * 4;
                tempData[i] = pixel.r;
                tempData[i + 1] = pixel.g;
                tempData[i + 2] = pixel.b;
                tempData[i + 3] = 255;
            }
        });

tempCtx.putImageData(tempImageData, 0, 0);
    ctx.drawImage(tempCanvas, 0, 0);
    ctx.restore();

    // CRITICAL FIX: Update imageState.currentImageData after drawing the selection
    imageState.currentImageData[canvasId] = ctx.getImageData(0, 0, targetCanvas.width, targetCanvas.height);
    dragState.hasCanvasChanged = true;

    selectionState.selectionBounds.xMin += avgDeltaX;
        selectionState.selectionBounds.xMax += avgDeltaX;
        selectionState.selectionBounds.yMin += avgDeltaY;
        selectionState.selectionBounds.yMax += avgDeltaY;
        selectionState.selectionBounds.centroidX += avgDeltaX;
        selectionState.selectionBounds.centroidY += avgDeltaY;
        if (brushState.brushShape === 'squareSelection' || brushState.brushShape === 'circleSelection') {
            selectionState.selectionStart.x += avgDeltaX;
            selectionState.selectionStart.y += avgDeltaY;
            selectionState.selectionEnd.x += avgDeltaX;
            selectionState.selectionEnd.y += avgDeltaY;
        } else {
            selectionState.multipointPath = selectionState.multipointPath.map(p => ({
                x: p.x + avgDeltaX,
                y: p.y + avgDeltaY
            }));
        }

        if (recordingState.isRecording) {
            inputState.touchPoints.forEach(point => {
                recordMovement('smear', {
                    lastX: point.lastX,
                    lastY: point.lastY,
                    currentX: point.x,
                    currentY: point.y,
                    fingerId: point.id,
                    canvasId,
                    activeEffects: [...activeEffects].map(k => keyLabels.find(kl => kl.key.toLowerCase() === k)?.effect).filter(e => e)
                });
            });
        }
    }

    inputState.touchPoints.forEach(point => {
        point.lastX = point.x;
        point.lastY = point.y;
    });
    inputState.lastTouchPoints = [...inputState.touchPoints];
    renderMarchingAnts();
}
return;
}

// Normal brushes
const normalBrushes = ['box', 'circle', 'rectangle', 'triangle', 'tv', 'negative'];
if (normalBrushes.includes(brushState.brushShape)) {
const firstFinger = inputState.touchPoints.find(tp => tp.id === teleportState.teleportFirstFinger) || inputState.touchPoints[0];
if (firstFinger) {
    const firstCanvasId = firstFinger.target === baseCanvas ? 'base' : firstFinger.target === paintCanvas ? 'paint' : 'sampler';
    const ctx = firstCanvasId === 'base' ? baseCtx : firstCanvasId === 'paint' ? paintCtx : samplerCtx;
    if (effectStates.isPaintMode && firstCanvasId === 'paint') {
        smearPixels(firstFinger.x, firstFinger.y, firstCanvasId);
        // Save paintCanvas strokes
        imageState.currentImageData[firstCanvasId] = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
        dragState.hasCanvasChanged = true;
        dragState.lastX = firstFinger.x;
        dragState.lastY = firstFinger.y;
        firstFinger.lastX = firstFinger.x;
        firstFinger.lastY = firstFinger.y;
        if (recordingState.isRecording) {
            recordMovement('smear', {
                lastX: firstFinger.lastX,
                lastY: firstFinger.lastY,
                currentX: firstFinger.x,
                currentY: firstFinger.y,
                canvasId: firstCanvasId,
                activeEffects: [...activeEffects].map(k => keyLabels.find(kl => kl.key.toLowerCase() === k)?.effect).filter(e => e)
            });
        }
    } else {
        smearPixels(firstFinger.x, firstFinger.y, firstCanvasId);
        dragState.hasCanvasChanged = true;
        dragState.lastX = firstFinger.x;
        dragState.lastY = firstFinger.y;
        firstFinger.lastX = firstFinger.x;
        firstFinger.lastY = firstFinger.y;
        if (recordingState.isRecording) {
            recordMovement('smear', {
                lastX: firstFinger.lastX,
                lastY: firstFinger.lastY,
                currentX: firstFinger.x,
                currentY: firstFinger.y,
                canvasId: firstCanvasId,
                activeEffects: [...activeEffects].map(k => keyLabels.find(kl => kl.key.toLowerCase() === k)?.effect).filter(e => e)
            });
        }

            if (inputState.touchPoints.length >= 2 && effectStates.isTeleportHeld && !firstFinger.isMouse) {
                if (firstFinger.id === teleportState.teleportFirstFinger) {
                    teleportState.teleportSourceX = firstFinger.x;
                    teleportState.teleportSourceY = firstFinger.y;
                    teleportState.teleportCanvasId = firstCanvasId;
                }

                teleportState.teleportDestinations = teleportState.teleportDestinations.filter(dest => 
                    inputState.touchPoints.some(tp => tp.id === dest.fingerId)
                );
                inputState.touchPoints.forEach(point => {
                    if (point.id !== teleportState.teleportFirstFinger) {
                        const destCanvasId = point.target === baseCanvas ? 'base' : point.target === paintCanvas ? 'paint' : 'sampler';
                        let dest = teleportState.teleportDestinations.find(d => d.fingerId === point.id);
                        if (!dest) {
                            dest = {
                                canvasId: destCanvasId,
                                x: point.x,
                                y: point.y,
                                lastX: point.x,
                                lastY: point.y,
                                fingerId: point.id,
                                sourceOffsetX: point.x - firstFinger.x,
                                sourceOffsetY: point.y - firstFinger.y,
                                isSameCanvas: destCanvasId === teleportState.teleportCanvasId
                            };
                            teleportState.teleportDestinations.push(dest);
                        } else {
                            dest.dragState.lastX = dest.x;
                            dest.dragState.lastY = dest.y;
                            dest.x = point.x;
                            dest.y = point.y;
                            dest.sourceOffsetX = point.x - firstFinger.x;
                            dest.sourceOffsetY = point.y - firstFinger.y;
                            dest.isSameCanvas = destCanvasId === teleportState.teleportCanvasId;
                        }

                        if (teleportState.teleportSourceX !== null && teleportState.teleportSourceY !== null) {
                            smearPixels(dest.x, dest.y, dest.canvasId, teleportState.teleportSourceX, teleportState.teleportSourceY, undefined, firstFinger.target);
                            dragState.hasCanvasChanged = true;
                            if (recordingState.isRecording) {
                                recordMovement('smear', {
                                    lastX: dest.dragState.lastX,
                                    lastY: dest.dragState.lastY,
                                    currentX: dest.x,
                                    currentY: dest.y,
                                    canvasId: dest.canvasId,
                                    fingerId: dest.fingerId,
                                    isTeleportClone: true,
                                    isSameCanvas: dest.isSameCanvas,
                                    activeEffects: [...activeEffects].map(k => keyLabels.find(kl => kl.key.toLowerCase() === k)?.effect).filter(e => e)
                                });
                            }
                        }
                        point.lastX = point.x;
                        point.lastY = point.y;
                    }
                });
            } else if (inputState.touchPoints.length >= 2) {
                const secondFinger = inputState.touchPoints[1];
                if (secondFinger) {
                    const deltaY = secondFinger.y - secondFinger.dragState.lastY;
                    const sizeAdjustment = deltaY * 0.3;
                    const newSize = Math.max(1, Math.min(700, brushState.brushSize + sizeAdjustment));
                    if (newSize !== brushState.brushSize) {
                        isGestureResizing = true;
                        updateBrushSize(newSize);
                        isGestureResizing = false;
                        if (recordingState.isRecording && recordingState.currentMovement && !zoomState.isZooming && brushState.brushShape !== 'squareSelection' && brushState.brushShape !== 'basquiatSelection') {
                            const timestamp = performance.now() - recordingState.currentMovement.startTime;
                            recordMovement('size', {
                                size: newSize,
                                fingerId: secondFinger.id,
                                timestamp: timestamp,
                                fingerRole: 'sizeAdjust'
                            });
                            recordingState.currentMovement.lastSize = newSize;
                        }
                    }
                    secondFinger.dragState.lastX = secondFinger.x;
                    secondFinger.dragState.lastY = secondFinger.y;
                }

                if (inputState.touchPoints.length >= 3) {
                    if (inputState.touchPoints.length >= 4) {
                        const fourthFinger = inputState.touchPoints[3];
                        if (fourthFinger) {
                            const rotateDeltaY = (fourthFinger.y - fourthFinger.dragState.lastY) * 0.005;
                            brushState.brushRotation += rotateDeltaY;
                            rotationState.isIntentionalRotation = true;
                            fourthFinger.dragState.lastX = fourthFinger.x;
                            fourthFinger.dragState.lastY = fourthFinger.y;
                        }
                    }
                }
                if (recordingState.isRecording && !zoomState.isZooming && brushState.brushShape !== 'squareSelection' && brushState.brushShape !== 'basquiatSelection') {
                    const firstFinger = inputState.touchPoints.find(tp => tp.id === teleportState.teleportFirstFinger) || inputState.touchPoints[0];
                    if (firstFinger && (firstFinger.x !== firstFinger.lastX || firstFinger.y !== firstFinger.lastY)) {
                        const timestamp = performance.now() - recordingState.currentMovement.startTime;
                        recordMovement('smear', {
                            lastX: firstFinger.lastX,
                            lastY: firstFinger.lastY,
                            currentX: firstFinger.x,
                            currentY: firstFinger.y,
                            fingerId: firstFinger.id,
                            canvasId: firstCanvasId,
                            size: brushState.brushSize,
                            rotation: brushState.brushRotation,
                            brushShape: brushState.brushShape,
                            timestamp: timestamp,
                            fingerRole: 'primary',
                            activeEffects: [...activeEffects].map(k => keyLabels.find(kl => kl.key.toLowerCase() === k)?.effect).filter(e => e)
                        });
                    }
                }
            }
        }
    }
} else if (brushState.brushShape === 'sweeper' || brushState.brushShape === 'oilbarrel') {
    const isTouchEvent = !!e.touches;
    if (inputState.touchPoints[0].isMouse && sweeperState.mouseAnchorStart) {
        // Mouse input: Single anchor with lag for sweeper, or oilbarrel drag
        const cursorX = inputState.touchPoints[0].x;
        const cursorY = inputState.touchPoints[0].y;
        if (cursorX === 0 && cursorY === 0) {
            return;
        }
        if (brushState.brushShape === 'oilbarrel') {
dragState.oilbarrelDragState.endX = cursorX;
dragState.oilbarrelDragState.endY = cursorY;


inputState.touchPoints[0].dragState.lastX = cursorX;
inputState.touchPoints[0].dragState.lastY = cursorY;


inputState.touchPoints[0].dragState.lastX = cursorX;
inputState.touchPoints[0].dragState.lastY = cursorY;
            sweeperState.anchorPoints = [
                { x: dragState.oilbarrelDragState.startX, y: dragState.oilbarrelDragState.startY, target: targetCanvas },
                { x: dragState.oilbarrelDragState.endX, y: dragState.oilbarrelDragState.endY, target: targetCanvas, lastX: cursorX, lastY: cursorY }
            ];
            if (sweeperState.anchorPoints.every(p => !isNaN(p.x) && !isNaN(p.y))) {
                dragState.hasCanvasChanged = true;
                if (recordingState.isRecording) {
                    recordMovement('smear', {
                        lastX: dragState.oilbarrelDragState.startX,
                        lastY: dragState.oilbarrelDragState.startY,
                        currentX: dragState.oilbarrelDragState.endX,
                        currentY: dragState.oilbarrelDragState.endY,
                        fingerId: inputState.touchPoints[0].id,
                        canvasId,
                        brushShape: brushState.brushShape,
                        anchorPoints: sweeperState.anchorPoints.map(p => ({ x: p.x, y: p.y })),
                        activeEffects: [...activeEffects].map(k => keyLabels.find(kl => kl.key.toLowerCase() === k)?.effect).filter(e => e)
                    });
                }
            } else {
            }
        } else {
            const firstAnchor = sweeperState.anchorPoints[0] || { x: cursorX, y: cursorY, target: targetCanvas };
            const dx = cursorX - firstAnchor.x;
            const dy = cursorY - firstAnchor.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            const lagSpeed = 0.1 + Math.min(distance / 200, 0.4);
            firstAnchor.x += dx * lagSpeed;
            firstAnchor.y += dy * lagSpeed;
            sweeperState.anchorPoints = [
                firstAnchor,
                { x: cursorX, y: cursorY, target: targetCanvas, lastX: cursorX, lastY: cursorY }
            ];
            if (sweeperState.anchorPoints.every(p => !isNaN(p.x) && !isNaN(p.y))) {
                drawSweeperLines(canvasId);
                dragState.hasCanvasChanged = true;
                if (recordingState.isRecording) {
                    recordMovement('smear', {
                        lastX: firstAnchor.x,
                        lastY: firstAnchor.y,
                        currentX: cursorX,
                        currentY: cursorY,
                        fingerId: inputState.touchPoints[0].id,
                        canvasId,
                        brushShape: brushState.brushShape,
                        anchorPoints: sweeperState.anchorPoints.map(p => ({ x: p.x, y: p.y })),
                        activeEffects: [...activeEffects].map(k => keyLabels.find(kl => kl.key.toLowerCase() === k)?.effect).filter(e => e)
                    });
                }
            } else {
            }
        }
    } else if (isTouchEvent && inputState.touchPoints.length >= 1 && inputState.touchPoints.length <= 5) {
        // Touch input: 1–5 fingers for dynamic multi-point lines
        sweeperState.anchorPoints = inputState.touchPoints.slice(0, 5).map(point => ({
            x: point.x,
            y: point.y,
            target: point.target,
            lastX: point.lastX || point.x,
            lastY: point.lastY || point.y,
            id: point.id
        }));
        if (sweeperState.anchorPoints.every(p => !isNaN(p.x) && !isNaN(p.y) && (p.x !== 0 || p.y !== 0))) {
            if (brushState.brushShape === 'oilbarrel') {
                dragState.oilbarrelDragState.startX = sweeperState.anchorPoints[0].x;
                dragState.oilbarrelDragState.startY = sweeperState.anchorPoints[0].y;
                dragState.oilbarrelDragState.endX = sweeperState.anchorPoints[sweeperState.anchorPoints.length - 1].x;
                dragState.oilbarrelDragState.endY = sweeperState.anchorPoints[sweeperState.anchorPoints.length - 1].y;
                dragState.hasCanvasChanged = true;
            } else {
                drawSweeperLines(canvasId);
                dragState.hasCanvasChanged = true;
            }
            if (recordingState.isRecording) {
                sweeperState.anchorPoints.forEach((point, i) => {
                    const nextPoint = sweeperState.anchorPoints[i + 1];
                    recordMovement('smear', {
                        lastX: point.lastX,
                        lastY: point.lastY,
                        currentX: point.x,
                        currentY: point.y,
                        nextX: nextPoint ? nextPoint.x : undefined,
                        nextY: nextPoint ? nextPoint.y : undefined,
                        fingerId: point.id,
                        canvasId,
                        brushShape: brushState.brushShape,
                        anchorPoints: sweeperState.anchorPoints.map(p => ({ x: p.x, y: p.y })),
                        activeEffects: [...activeEffects].map(k => keyLabels.find(kl => kl.key.toLowerCase() === k)?.effect).filter(e => e)
                    });
                });
            }
        } else {
        }
    } else {
        return;
    }
    inputState.touchPoints.forEach(point => {
        point.lastX = point.x;
        point.lastY = point.y;
    });
    inputState.lastTouchPoints = [...inputState.touchPoints];
} else if (brushState.brushShape === 'aestheticLines') {
const state = zoomState.canvasStates[canvasId];
if (state && state.zoomLevel !== 1) {
    // Transform anchor points to canvas space
    sweeperState.anchorPoints = sweeperState.anchorPoints.map(point => ({
        ...point,
        x: (point.x - state.panX) / state.zoomLevel,
        y: (point.y - state.panY) / state.zoomLevel
    }));
    
    // Also transform sweeperState.mouseAnchorStart
    sweeperState.mouseAnchorStart = {
        ...sweeperState.mouseAnchorStart,
        x: (sweeperState.mouseAnchorStart.x - state.panX) / state.zoomLevel,
        y: (sweeperState.mouseAnchorStart.y - state.panY) / state.zoomLevel
    };
}

drawAestheticLines(canvasId);
dragState.hasCanvasChanged = true;
if (recordingState.isRecording) {
    // FIXED: Record anchor points like sweeper/oilbarrel do
    recordMovement('smear', {
        lastX: sweeperState.mouseAnchorStart.x,
        lastY: sweeperState.mouseAnchorStart.y,
        currentX: cursorX,
        currentY: cursorY,
        fingerId: inputState.touchPoints[0].id,
        canvasId,
        brushShape: 'aestheticLines',
        // FIXED: Include anchor points in recording
        anchorPoints: sweeperState.anchorPoints.map((p, index) => ({
            x: p.x,
            y: p.y,
            lastX: p.lastX || p.x,
            lastY: p.lastY || p.y,
            fingerId: p.id || `aesthetic_${index}`,
            target: p.target?.id || 'canvas',
            index: index
        })),
        // FIXED: Include mouse anchor state for proper replay
        mouseAnchorStart: {
            x: sweeperState.mouseAnchorStart.x,
            y: sweeperState.mouseAnchorStart.y,
            target: sweeperState.mouseAnchorStart.target?.id || 'canvas'
        },
        fingerCount: sweeperState.anchorPoints.length,
        inputType: inputState.touchPoints[0]?.isMouse ? 'mouse' : 'touch',
        gestureId: Date.now(),
        activeEffects: [...activeEffects].map(k => keyLabels.find(kl => kl.key.toLowerCase() === k)?.effect).filter(e => e)
    });
}
} else if (brushState.brushShape === 'stickerMode') {
    const activeStamps = brushState.stampOrder.filter(slot => stickerImages[slot]);

    if (effectStates.isTeleportHeld && inputState.touchPoints.length >= 2) {
        const firstFinger = inputState.touchPoints.find(tp => tp.id === teleportState.teleportFirstFinger) || inputState.touchPoints[0];
        const sourceCanvasId = firstFinger.target === baseCanvas ? 'base' : firstFinger.target === paintCanvas ? 'paint' : 'sampler';
        if (firstFinger.id === teleportState.teleportFirstFinger) {
            teleportState.teleportSourceX = firstFinger.x;
            teleportState.teleportSourceY = firstFinger.y;
            teleportState.teleportCanvasId = sourceCanvasId;
        }
        const stampCount = Math.min(activeStamps.length, inputState.touchPoints.length);
        for (let i = 0; i < stampCount; i++) {
            const slot = activeStamps[i];
            const point = inputState.touchPoints[i];
            if (point && point.target === firstFinger.target) {
                if (point.x === 0 && point.y === 0) {
                    continue;
                }
                smearPixels(point.x, point.y, sourceCanvasId, undefined, undefined, slot);
                dragState.hasCanvasChanged = true;
                point.lastX = point.x;
                point.lastY = point.y;
                if (recordingState.isRecording) {
                    recordMovement('smear', {
                        lastX: point.lastX,
                        lastY: point.lastY,
                        currentX: point.x,
                        currentY: point.y,
                        fingerId: point.id,
                        canvasId: sourceCanvasId,
                        stickerSlot: slot,
                        brushShape: 'stickerMode',
                        activeEffects: [...activeEffects].map(k => keyLabels.find(kl => kl.key.toLowerCase() === k)?.effect).filter(e => e)
                    });
                }
            }
        }
        const cloneStartIndex = stampCount;
        const maxClones = Math.min(stampCount, inputState.touchPoints.length - cloneStartIndex);
        for (let i = 0; i < maxClones; i++) {
            const clonePoint = inputState.touchPoints[cloneStartIndex + i];
            const sourcePoint = inputState.touchPoints[i];
            const cloneStampSlot = activeStamps[i];
            if (clonePoint && sourcePoint && cloneStampSlot !== undefined && stickerImages[cloneStampSlot]) {
                if (clonePoint.x === 0 && clonePoint.y === 0) {
                    continue;
                }
                const destCanvasId = clonePoint.target === baseCanvas ? 'base' : clonePoint.target === paintCanvas ? 'paint' : 'sampler';
                const sourceX = sourcePoint.x;
                const sourceY = sourcePoint.y;
                if (!isNaN(sourceX) && !isNaN(sourceY)) {
                    smearPixels(clonePoint.x, clonePoint.y, destCanvasId, sourceX, sourceY, cloneStampSlot, sourcePoint.target);
                    dragState.hasCanvasChanged = true;
                    clonePoint.dragState.lastX = clonePoint.x;
                    clonePoint.dragState.lastY = clonePoint.y;
                    if (recordingState.isRecording) {
                        recordMovement('smear', {
                            lastX: clonePoint.dragState.lastX,
                            lastY: clonePoint.dragState.lastY,
                            currentX: clonePoint.x,
                            currentY: clonePoint.y,
                            fingerId: clonePoint.id,
                            canvasId: destCanvasId,
                            stickerSlot: cloneStampSlot,
                            brushShape: 'stickerMode',
                            isTeleportClone: true,
                            sourceCanvasId: sourceCanvasId,
                            sourceX: sourceX,
                            sourceY: sourceY,
                            fingerIndex: cloneStartIndex + i + 1,
                            activeEffects: [...activeEffects].map(k => keyLabels.find(kl => kl.key.toLowerCase() === k)?.effect).filter(e => e)
                        });
                    }
                } else {
                    console.warn(`Invalid source coordinates for clone stamp ${cloneStampSlot}: (${sourceX}, ${sourceY})`);
                }
            }
        }
        const cloneResizeIndex = cloneStartIndex + maxClones;
        if (cloneResizeIndex < inputState.touchPoints.length) {
            const cloneResizeFinger = inputState.touchPoints[cloneResizeIndex];
            if (cloneResizeFinger && cloneResizeFinger.target !== firstFinger.target) {
                const deltaY = (cloneResizeFinger.y - cloneResizeFinger.dragState.lastY) * 0.5;
                const newSize = Math.max(1, Math.min(700, brushState.cloneBrushSize + deltaY * 2));
                brushState.cloneBrushSize = newSize;
                cloneResizeFinger.dragState.lastX = cloneResizeFinger.x;
                cloneResizeFinger.dragState.lastY = cloneResizeFinger.y;
            }
        }
        const cloneRotateIndex = cloneResizeIndex + 1;
        if (cloneRotateIndex < inputState.touchPoints.length) {
            const cloneRotateFinger = inputState.touchPoints[cloneRotateIndex];
            if (cloneRotateFinger && cloneRotateFinger.target !== firstFinger.target) {
                const rotateDeltaY = (cloneRotateFinger.y - cloneRotateFinger.dragState.lastY) * 0.005;
                brushState.cloneBrushRotation += rotateDeltaY;
                cloneRotateFinger.dragState.lastX = cloneRotateFinger.x;
                cloneRotateFinger.dragState.lastY = cloneRotateFinger.y;
            }
        }
    } else {
        for (let i = 0; i < activeStamps.length && i < inputState.touchPoints.length; i++) {
            const slot = activeStamps[i];
            const point = inputState.touchPoints[i];
            if (point) {
                if (point.x === 0 && point.y === 0) {
                    continue;
                }
                smearPixels(point.x, point.y, canvasId, undefined, undefined, slot);
                dragState.hasCanvasChanged = true;
                point.lastX = point.x;
                point.lastY = point.y;
                if (recordingState.isRecording) {
                    recordMovement('smear', {
                        lastX: point.lastX,
                        lastY: point.lastY,
                        currentX: point.x,
                        currentY: point.y,
                        fingerId: point.id,
                        canvasId,
                        stickerSlot: slot,
                        brushShape: 'stickerMode',
                        activeEffects: [...activeEffects].map(k => keyLabels.find(kl => kl.key.toLowerCase() === k)?.effect).filter(e => e)
                    });
                }
            }
        }
        const stampCount = activeStamps.length;
        if (stampCount < inputState.touchPoints.length) {
            const resizeFinger = inputState.touchPoints[stampCount];
            if (resizeFinger) {
                const deltaY = (resizeFinger.y - resizeFinger.dragState.lastY) * 0.5;
                const newSize = Math.max(1, Math.min(700, brushState.brushSize + deltaY * 2));
                isGestureResizing = true;
                updateBrushSize(newSize);
                isGestureResizing = false;
                resizeFinger.dragState.lastX = resizeFinger.x;
                resizeFinger.dragState.lastY = resizeFinger.y;
            }
        }
        if (stampCount + 1 < inputState.touchPoints.length) {
            const rotateFinger = inputState.touchPoints[stampCount + 1];
            if (rotateFinger) {
                const rotateDeltaY = (rotateFinger.y - rotateFinger.dragState.lastY) * 0.005;
                brushState.brushRotation += rotateDeltaY;
                rotateFinger.dragState.lastX = rotateFinger.x;
                rotateFinger.dragState.lastY = rotateFinger.y;
            }
        }
    }
} else if (brushState.brushShape === 'melt' || brushState.brushShape === 'brokenScreen' || brushState.brushShape === 'jazzScatter') {
    const firstFinger = inputState.touchPoints[0];
    if (firstFinger) {
        if (firstFinger.x === 0 && firstFinger.y === 0) {
            return;
        }
        smearPixels(firstFinger.x, firstFinger.y, canvasId);
        dragState.hasCanvasChanged = true;
        dragState.lastX = firstFinger.x;
        dragState.lastY = firstFinger.y;
        firstFinger.lastX = firstFinger.x;
        firstFinger.lastY = firstFinger.y;

        let meltDirection = 1;
        if (brushState.brushShape !== 'jazzScatter' && inputState.touchPoints.length >= 2) {
            const secondFinger = inputState.touchPoints[1];
            meltDirection = secondFinger.y < firstFinger.y ? -1 : 1;
            secondFinger.dragState.lastX = secondFinger.x;
            secondFinger.dragState.lastY = secondFinger.y;

            if (inputState.touchPoints.length >= 3) {
                const thirdFinger = inputState.touchPoints[2];
                const deltaY = (thirdFinger.y - thirdFinger.dragState.lastY) * 0.5;
                const newSize = Math.max(1, Math.min(700, brushState.brushSize + deltaY * 2));
                isGestureResizing = true;
                updateBrushSize(newSize);
                isGestureResizing = false;
                thirdFinger.dragState.lastX = thirdFinger.x;
                thirdFinger.dragState.lastY = thirdFinger.y;

                if (inputState.touchPoints.length >= 4) {
                    const fourthFinger = inputState.touchPoints[3];
                    if (fourthFinger) {
                        const rotateDeltaY = (fourthFinger.y - fourthFinger.dragState.lastY) * 0.005;
                        brushState.brushRotation += rotateDeltaY;
                        fourthFinger.lastX = fourthFinger.x;
                        fourthFinger.lastY = fourthFinger.y;
                    }
                }
            }
        }
        if (recordingState.isRecording && !zoomState.isZooming && brushState.brushShape !== 'squareSelection' && brushState.brushShape !== 'basquiatSelection') {
            if (firstFinger && (firstFinger.x !== firstFinger.lastX || firstFinger.y !== firstFinger.lastY)) {
                recordMovement('smear', {
                    lastX: firstFinger.lastX,
                    lastY: firstFinger.lastY,
                    currentX: firstFinger.x,
                    currentY: firstFinger.y,
                    fingerId: firstFinger.id,
                    canvasId: canvasId,
                    size: brushState.brushSize,
                    rotation: brushState.brushRotation,
                    brushShape: brushState.brushShape,
                    timestamp: performance.now() - recordingState.currentMovement.startTime,
                    fingerRole: 'primary',
                    activeEffects: [...activeEffects].map(k => keyLabels.find(kl => kl.key.toLowerCase() === k)?.effect).filter(e => e)
                });
            }
            if (inputState.touchPoints.length >= 2) {
                const secondFinger = inputState.touchPoints[1];
                if (secondFinger && brushState.brushSize !== recordingState.currentMovement.lastSize) {
                    recordMovement('size', {
                        size: brushState.brushSize,
                        fingerId: secondFinger.id,
                        timestamp: performance.now() - recordingState.currentMovement.startTime
                    });
                }
            }
        }
    }
}

inputState.lastTouchPoints = [...inputState.touchPoints];
}
}


/**
 * endDrag
 */
export function endDrag(e) {
const paintBefore = paintCtx.getImageData(0, 0, paintCanvas.width, paintCanvas.height);

e.preventDefault();


const touches = e.touches || (e.type === 'mouseup' ? [] : e.touches);
if (touches.length > 0) {
    return;
}

// Define canvasId early
let activeCanvasKey = 'base';
let targetCanvas = baseCanvas;
if (inputState.touchPoints.length > 0) {
    targetCanvas = inputState.touchPoints[0].target;
    activeCanvasKey = targetCanvas === baseCanvas ? 'base' : targetCanvas === paintCanvas ? 'paint' : 'sampler';
}
const canvasId = activeCanvasKey;
const ctx = canvasId === 'base' ? baseCtx : canvasId === 'paint' ? paintCtx : canvasId === 'sampler' ? samplerCtx : null;

if (!ctx) {
    console.error('No context for canvas:', canvasId);
    return;
}


// Clear canvas backup cache when drag ends
if (brushState.brushShape === 'sweeper' || brushState.brushShape === 'oilbarrel') {
window.canvasBackupsCache = null;
window.lastBackupCanvasId = null;
}

if (zoomState.isZooming) {
const canvasKey = canvasId;
const state = zoomState.canvasStates[canvasKey];
if (!state) {
    return;
}
// Safety check: if targetLocked is stuck, reset it
if (!state.targetLocked && (state.zoomLevel > 1.1 || state.panX !== 0 || state.panY !== 0)) {
    state.targetLocked = false;
    state.zoomPivotX = 0;
    state.zoomPivotY = 0;
    return;
}
if (!state.targetLocked) {
    return;
}

const touch = e.changedTouches ? e.changedTouches[0] : { clientX: e.clientX, clientY: e.clientY };
const currentX = touch.clientX;
const currentY = touch.clientY;
const lastX = inputState.lastTouchPoints[0]?.clientX || state.zoomPivotX;
const lastY = inputState.lastTouchPoints[0]?.clientY || state.zoomPivotY;
const deltaY = currentY - lastY;

// Ignore small deltaY to prevent snapping
const deltaYThreshold = 2; // Pixels
if (Math.abs(deltaY) < deltaYThreshold) {
    return;
}

const zoomSpeed = 0.02;
const zoomFactor = deltaY > 0 ? 1 / (1 + zoomSpeed * Math.abs(deltaY)) : 1 + zoomSpeed * Math.abs(deltaY);
const imageWidth = originalDimensions.originalWidths[canvasKey] || targetCanvas.width;
const imageHeight = originalDimensions.originalHeights[canvasKey] || targetCanvas.height;
const maxZoom = Math.min(imageWidth / targetCanvas.width, imageHeight / targetCanvas.height) * 4;
const minZoom = 0.1;
const oldZoomLevel = state.zoomLevel;
let newZoomLevel = state.zoomLevel * zoomFactor;

// Apply zoom
newZoomLevel = Math.max(minZoom, Math.min(maxZoom, newZoomLevel));
state.hasZoomedIn = newZoomLevel > 1;

// FIXED: Only update pan if zoom actually changed
if (Math.abs(oldZoomLevel - newZoomLevel) > 0.001 && oldZoomLevel > 0) {
    const pivotX = state.zoomPivotX;
    const pivotY = state.zoomPivotY;
    const contentX = (pivotX - state.panX) / oldZoomLevel;
    const contentY = (pivotY - state.panY) / oldZoomLevel;
    state.zoomLevel = newZoomLevel;
    state.panX = pivotX - contentX * newZoomLevel;
    state.panY = pivotY - contentY * newZoomLevel;
    const { panX, panY } = clampView(state, targetCanvas, pivotX, pivotY);
    state.panX = panX;
    state.panY = panY;
    
    // Redraw immediately
    redrawCanvas(canvasKey, targetCanvas, ctx, state);
} else {
    // Zoom didn't change enough - just update the level without touching pan
    state.zoomLevel = newZoomLevel;
}

// Update touch points
inputState.lastTouchPoints = [{
    id: touch.identifier || `mouse0`,
    clientX: currentX,
    clientY: currentY,
    x: getCanvasCoordinates(e, touch)?.x || 0,
    y: getCanvasCoordinates(e, touch)?.y || 0,
    target: targetCanvas,
    lastX: currentX,
    lastY: currentY,
    startTime: Date.now(),
    isMouse: !e.touches
}];

return;
}

// Handle painting case
if (selectionCanvas && selectionCtx && selectionCanvas.dataset.targetCanvasId === targetCanvas.id) {
    selectionCtx.clearRect(0, 0, selectionCanvas.width, selectionCanvas.height);
}

// Safety: Ensure zoom state is properly managed when switching from zoom to painting
if (zoomState.isZooming && canvasId) {
    const state = zoomState.canvasStates[canvasId];
    if (state && (state.zoomLevel > 1.1 || state.panX !== 0 || state.panY !== 0)) {
        // Don't reset zoom here - let the user control it
    }
}

if (canvasId === 'paint' && imageState.currentImageData.paint) {
    paintCtx.putImageData(imageState.currentImageData.paint, 0, 0);
}

if (brushState.brushShape !== 'squareSelection' && brushState.brushShape !== 'basquiatSelection' && brushState.brushShape !== 'circleSelection') {
    selectionCacheCanvas = null;
    selectionCacheCtx = null;
    selectionState.selectedImageData = null;
    activeEffects.forEach(key => {
        const effect = Object.keys(effectMap).find(e => effectMap[e].key.toLowerCase() === key);
        if (effect) {
            toggleEffect(effect, false);
        }
    });
    activeEffects.clear();
}

if (dragState.isDragging) {

// SIMPLE FIX: Don't reset dragState.isDragging when canvas is zoomed and we're painting
const state = zoomState.canvasStates[canvasId];
const isZoomedPainting = state && state.zoomLevel > 1.1 && !zoomState.isZooming;

if (isZoomedPainting) {
    // Don't reset dragState.isDragging - let it persist for next stroke
    dragState.shouldSaveState = true;
} else {
    // Normal case - reset dragState.isDragging
    dragState.isDragging = false;
    dragState.shouldSaveState = true;
}
}

if (dragState.isDraggingOilbarrel && brushState.brushShape === 'oilbarrel') {
if (dragState.oilbarrelRafId) {
    cancelAnimationFrame(dragState.oilbarrelRafId);
    dragState.oilbarrelRafId = null;
}
dragState.isDraggingOilbarrel = false;  // ADD THIS
dragState.oilbarrelDragState = null;     // AND THIS
}

const canvasContainer = document.getElementById('canvasContainer');
canvasContainer.style.touchAction = 'pan-x';
document.body.style.touchAction = 'pan-y';

if (zoomState.isZooming) {
// Don't finalize any selections while zooming
} else if ((selectionState.isSelecting || typeof selectionState.isDraggingSelection !== 'undefined' && selectionState.isDraggingSelection) && (brushState.brushShape === 'squareSelection' || brushState.brushShape === 'circleSelection') && selectionState.selectionStart && selectionState.selectionEnd) {        
selectionState.isSelecting = false;
selectionState.isSelectionActive = true;
selectionState.selectionBounds = {
    xMin: Math.min(selectionState.selectionStart.x, selectionState.selectionEnd.x),
    xMax: Math.max(selectionState.selectionStart.x, selectionState.selectionEnd.x),
    yMin: Math.min(selectionState.selectionStart.y, selectionState.selectionEnd.y),
    yMax: Math.max(selectionState.selectionStart.y, selectionState.selectionEnd.y)
};
selectionState.selectedImageData = captureSelection(targetCanvas, selectionState.selectionBounds, brushState.brushShape === 'squareSelection' ? 'square' : 'circle');
if (!selectionState.selectedImageData) {
    console.error(`Failed to capture ${brushState.brushShape} selection`);
    selectionState.isSelectionActive = false;
    selectionState.selectionStart = null;
    selectionState.selectionEnd = null;
    return;
}
if (selectionCanvas) {
    selectionCanvas.style.display = 'block';
    selectionCanvas.style.visibility = 'visible';
    syncSelectionCanvasPosition(targetCanvas);
}
renderMarchingAnts();

// CRITICAL: Immediately save state after selection creation/drag
const targetCanvasId = targetCanvas === baseCanvas ? 'base' : targetCanvas === paintCanvas ? 'paint' : 'sampler';
saveState(true, targetCanvasId);
}

// Handle basquiat selection (uses selectionState.multipointPath instead of selectionState.selectionStart/selectionState.selectionEnd)
// Only finalize if we're dragging an existing selection, NOT if we're still adding points
if ((typeof selectionState.isDraggingSelection !== 'undefined' && selectionState.isDraggingSelection) && brushState.brushShape === 'basquiatSelection' && selectionState.multipointPath && selectionState.multipointPath.length >= 3 && selectionState.isSelectionActive) {
selectionState.isSelecting = false;
selectionState.isSelectionActive = true;

// Calculate bounds from selectionState.multipointPath
const bounds = calculatePolygonBounds(selectionState.multipointPath);
selectionState.selectionBounds = {
    xMin: bounds.xMin,
    xMax: bounds.xMax,
    yMin: bounds.yMin,
    yMax: bounds.yMax,
    path: selectionState.multipointPath // Store the path for basquiat
};

selectionState.selectedImageData = captureSelection(targetCanvas, selectionState.multipointPath, 'multipoint');
if (!selectionState.selectedImageData) {
    console.error(`Failed to capture basquiatSelection`);
    selectionState.isSelectionActive = false;
    selectionState.multipointPath = [];
    return;
}
if (selectionCanvas) {
    selectionCanvas.style.display = 'block';
    selectionCanvas.style.visibility = 'visible';
    syncSelectionCanvasPosition(targetCanvas);
}
renderMarchingAnts();

// CRITICAL: Immediately save state after basquiat selection creation/drag
const targetCanvasId = targetCanvas === baseCanvas ? 'base' : targetCanvas === paintCanvas ? 'paint' : 'sampler';
saveState(true, targetCanvasId);
}



// Don't reset brush size - let it persist between operations
sizeValue.textContent = brushState.brushSize;


sweeperState.anchorPoints = [];
smearAnchor = null;
teleportChain = [];
inputState.touchPoints = [];
inputState.lastTouchPoints = [];
teleportState.teleportSourceX = null;
teleportState.teleportSourceY = null;
teleportState.teleportCanvasId = null;
teleportState.teleportDestinations = [];
crossTeleportSourceCanvas = null;
crossTeleportSourceX = null;
crossTeleportSourceY = null;
dragState.lastX = undefined;
dragState.lastY = undefined;
vhsNoiseLevel = 0;

// Update imageState.currentImageData with unzoomed data
const baseState = zoomState.canvasStates['base'];
if (canvasId && !(brushState.brushShape === 'squareSelection' || brushState.brushShape === 'basquiatSelection' || brushState.brushShape === 'circleSelection')) {
const canvas = canvasId === 'base' ? baseCanvas : canvasId === 'paint' ? paintCanvas : samplerCanvas;
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const canvasState = zoomState.canvasStates[canvasId];

if (ctx && canvasState && imageState.currentImageData[canvasId]) {
    // Update the offscreen canvas with the new content
    if (!canvasState.offscreenCanvas || canvasState.offscreenCanvas.width !== canvas.width || canvasState.offscreenCanvas.height !== canvas.height) {
        canvasState.offscreenCanvas = document.createElement('canvas');
        canvasState.offscreenCanvas.width = canvas.width;
        canvasState.offscreenCanvas.height = canvas.height;
    }
    const offscreenCtx = canvasState.offscreenCanvas.getContext('2d', { alpha: true });
    offscreenCtx.putImageData(imageState.currentImageData[canvasId], 0, 0);
    
    // Only redraw if zoom level has changed or if we need to update the display
    if (canvasState.zoomLevel !== 1 || canvasState.panX !== 0 || canvasState.panY !== 0) {
        // Maintain the current zoom view
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.save();
        ctx.translate(canvasState.panX, canvasState.panY);
        ctx.scale(canvasState.zoomLevel, canvasState.zoomLevel);
        ctx.drawImage(canvasState.offscreenCanvas, 0, 0);
        ctx.restore();
    }
    
}
}
removeGlobalDragListeners();

}

function calculatePolygonBounds(points) {
const xMin = Math.min(...points.map(p => p.x));
const xMax = Math.max(...points.map(p => p.x));
const yMin = Math.min(...points.map(p => p.y));
const yMax = Math.max(...points.map(p => p.y));
return { xMin, xMax, yMin, yMax };
}





// Handle mouse wheel/touchpad zoom
function handleZoomWheel(e) {
if (!zoomState.isZooming) return;
e.preventDefault();
const targetCanvas = e.target === baseCanvas ? baseCanvas : e.target === paintCanvas ? paintCanvas : e.target === samplerCanvas ? samplerCanvas : null;
if (!targetCanvas) {
    return;
}
const canvasKey = targetCanvas === baseCanvas ? 'base' : targetCanvas === paintCanvas ? 'paint' : 'sampler';
const state = zoomState.canvasStates[canvasKey];
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

// FIXED: Check if returning to full view
const isReturningToFullView = newZoomLevel <= 1.1 && oldZoomLevel > 1.1;

if (isReturningToFullView) {
    // Reset to full view
    state.zoomLevel = 1;
    state.panX = 0;
    state.panY = 0;
    state.zoomPivotX = 0;
    state.zoomPivotY = 0;
    state.targetLocked = false;
} else if (oldZoomLevel !== newZoomLevel && oldZoomLevel !== 0) {
    // Get cursor position in canvas coordinates
    const rect = targetCanvas.getBoundingClientRect();
    const style = getComputedStyle(targetCanvas);
    const borderLeft = parseFloat(style.borderLeftWidth) || 0;
    const borderTop = parseFloat(style.borderTopWidth) || 0;
    const scaleX = targetCanvas.width / (rect.width - borderLeft - parseFloat(style.borderRightWidth));
    const scaleY = targetCanvas.height / (rect.height - borderTop - parseFloat(style.borderBottomWidth));
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
} else {
    state.zoomLevel = newZoomLevel;
}


if (!state.isRedrawing) {
    state.isRedrawing = true;
    if (state.redrawRequest) cancelAnimationFrame(state.redrawRequest);
    state.redrawRequest = requestAnimationFrame(() => {
        try {
            redrawCanvas(canvasKey, targetCanvas, ctx, state);
        } catch (error) {
            console.error('Error during wheel zoom redraw:', error);
        } finally {
            state.redrawRequest = null;
            state.isRedrawing = false;
        }
    });
}
}

/**
 * Initialize drawing — owns the entire canvas pointer/wheel/touch event loop.
 *
 * Per ADR-0001 this runs at boot (called from main.js AFTER
 * State.initializeCanvasRefs()), not at import time. It resolves the canvas
 * bindings from the now-populated canvasRefs, then attaches the one shared
 * interaction loop. A mousedown/touchstart means draw, select, or zoom-pan
 * depending on brush shape / zoom mode — that branching lives inside
 * startDrag/drag/endDrag, so the listeners here are a thin guarded layer
 * (guards ported faithfully from editor.js:8292-8487).
 */
export function initializeDrawing() {
  baseCanvas = canvasRefs.baseCanvas;
  baseCtx = canvasRefs.baseCtx;
  paintCanvas = canvasRefs.paintCanvas;
  paintCtx = canvasRefs.paintCtx;
  samplerCanvas = canvasRefs.samplerCanvas;
  samplerCtx = canvasRefs.samplerCtx;
  keyboardContainer = getKeyboardContainer();

  const isSelectionShape = () =>
    brushState.brushShape === 'squareSelection' || brushState.brushShape === 'basquiatSelection';

  [baseCanvas, paintCanvas, samplerCanvas].forEach(canvas => {
    if (!canvas) return;

    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        if (isSelectionShape()) e.stopPropagation();
        startDrag(e);
      }
    });

    canvas.addEventListener('mousemove', (e) => {
      if (zoomState.isZooming) {
        drag(e);
      } else if (e.buttons === 1) {
        if (isSelectionShape()) e.stopPropagation();
        drag(e);
      }
    });

    canvas.addEventListener('mouseup', (e) => {
      if (isSelectionShape()) e.stopPropagation();
      endDrag(e);
    });

    canvas.addEventListener('wheel', handleZoomWheel, { passive: false });

    canvas.addEventListener('touchstart', (e) => {
      if (isSelectionShape()) e.stopPropagation();
      startDrag(e);
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
      if (dragState.isDragging) {
        if (isSelectionShape()) e.stopPropagation();
        drag(e);
      }
    }, { passive: false });

    canvas.addEventListener('touchend', (e) => {
      if (dragState.isDragging) {
        if (isSelectionShape()) e.stopPropagation();
        endDrag(e);
      }
    }, { passive: false });

    canvas.addEventListener('touchcancel', (e) => {
      if (dragState.isDragging) endDrag(e);
    }, { passive: false });
  });
}

let mouseZoomState = {
isMouseZooming: false,
startY: 0,
lastZoomTime: 0
};

function handleMouseZoomDrag(e) {
if (!zoomState.isZooming) return;

if (e.type === 'mousedown' && e.button === 0) {
    mouseZoomState.isMouseZooming = true;
    mouseZoomState.startY = e.clientY;
    e.preventDefault();
    return;
}

if (e.type === 'mousemove') {
    // Only zoom if actively mouse-zooming
    if (!mouseZoomState.isMouseZooming) {
        return;
    }
    
    const deltaY = e.clientY - mouseZoomState.startY;
    const now = Date.now();
    
    if (now - mouseZoomState.lastZoomTime < 16) return;
    mouseZoomState.lastZoomTime = now;
    
    const targetCanvas = e.target;
    if (targetCanvas === baseCanvas || targetCanvas === paintCanvas || targetCanvas === samplerCanvas) {
        const zoomEvent = {
            target: targetCanvas,
            deltaY: deltaY * 0.5,
            clientX: e.clientX,
            clientY: e.clientY,
            preventDefault: () => {}
        };
        performZoom(zoomEvent);
    }
    e.preventDefault();
    return;
}

if (e.type === 'mouseup') {
    mouseZoomState.isMouseZooming = false;
    return;
}
}

let touchpadState = {
isDoubleTapping: false,
lastTapTime: 0,
startY: 0,
isActivelyZooming: false
};

function handleTouchpadZoom(e) {
if (!zoomState.isZooming) return;

if (e.type === 'touchstart' && e.touches.length === 1) {
    const now = Date.now();
    const timeSinceLastTap = now - touchpadState.lastTapTime;
    
    if (timeSinceLastTap < 300) { // Double-tap detected
        touchpadState.isActivelyZooming = true;
        touchpadState.startY = e.touches[0].clientY;
        e.preventDefault();
    }
    touchpadState.lastTapTime = now;
    return;
}

if (e.type === 'touchmove' && touchpadState.isActivelyZooming && e.touches.length === 1) {
    const deltaY = e.touches[0].clientY - touchpadState.startY;
    
    const zoomEvent = {
        target: e.target,
        deltaY: deltaY * 0.3,
        clientX: e.touches[0].clientX,
        clientY: e.touches[0].clientY,
        preventDefault: () => {}
    };
    
    performZoom(zoomEvent);
    e.preventDefault();
    return;
}

if (e.type === 'touchend') {
    touchpadState.isActivelyZooming = false;
    // Keep zoomState.isZooming = true so tool stays on
    return;
}
}

function performZoom(e) {
const targetCanvas = e.target;
if (!targetCanvas || (!targetCanvas === baseCanvas && !targetCanvas === paintCanvas && !targetCanvas === samplerCanvas)) return;

const canvasKey = targetCanvas === baseCanvas ? 'base' : targetCanvas === paintCanvas ? 'paint' : 'sampler';
const state = zoomState.canvasStates[canvasKey];
const ctx = targetCanvas.getContext('2d');

const zoomSpeed = 0.01;
const zoomFactor = e.deltaY > 0 ? 1 / (1 + zoomSpeed * Math.abs(e.deltaY)) : 1 + zoomSpeed * Math.abs(e.deltaY);

const oldZoomLevel = state.zoomLevel;
const newZoomLevel = Math.max(0.1, Math.min(4, state.zoomLevel * zoomFactor));
state.hasZoomedIn = newZoomLevel > 1;

if (oldZoomLevel !== newZoomLevel && oldZoomLevel !== 0) {
    const rect = targetCanvas.getBoundingClientRect();
    const cursorX = (e.clientX - rect.left) * (targetCanvas.width / rect.width);
    const cursorY = (e.clientY - rect.top) * (targetCanvas.height / rect.height);
    
    const contentX = (cursorX - state.panX) / oldZoomLevel;
    const contentY = (cursorY - state.panY) / oldZoomLevel;
    
    state.zoomLevel = newZoomLevel;
    state.panX = cursorX - contentX * newZoomLevel;
    state.panY = cursorY - contentY * newZoomLevel;
    
    const { panX, panY } = clampView(state, targetCanvas, cursorX, cursorY);
    state.panX = panX;
    state.panY = panY;
    
    // Trigger redraw
    if (!state.isRedrawing) {
        state.isRedrawing = true;
        requestAnimationFrame(() => {
            // Use existing redraw logic from handleZoomWheel
            state.isRedrawing = false;
        });
    }
}
}

function animateSweeperPlayback(smearData, startTime, duration) {
const currentTime = Date.now();
const elapsed = currentTime - startTime;
const progress = Math.min(elapsed / duration, 1.0);

// Calculate how many anchor points to show
const totalPoints = smearData.sweeperState.anchorPoints.length;
const pointsToShow = Math.max(2, Math.floor(progress * totalPoints));

// Set sweeperState.anchorPoints to only the progressive portion
sweeperState.anchorPoints = smearData.sweeperState.anchorPoints.slice(0, pointsToShow);
inputState.lastTouchPoints = smearData.sweeperState.anchorPoints.slice(0, pointsToShow).map(p => ({x: p.lastX, y: p.lastY}));

// Draw with limited anchor points
drawSweeperLines(smearData.canvasId);

if (progress < 1.0) {
    requestAnimationFrame(() => animateSweeperPlayback(smearData, startTime, duration));
}
}












/**
 * Smear pixels from one location to another
 * @param {number} currentX - Current X position
 * @param {number} currentY - Current Y position
 * @param {string} canvasId - Canvas identifier
 * @param {number} sourceX - Source X position (optional)
 * @param {number} sourceY - Source Y position (optional)
 * @param {string} stickerSlot - Sticker slot identifier (optional)
 * @param {HTMLCanvasElement} sourceCanvas - Source canvas element (optional)
 */
export function smearPixels(currentX, currentY, canvasId, sourceX, sourceY, stickerSlot, sourceCanvas) {
const targetCtx = canvasId === 'base' ? baseCtx : canvasId === 'paint' ? paintCtx : samplerCtx;
const sourceCtx = sourceCanvas ? (sourceCanvas === baseCanvas ? baseCtx : sourceCanvas === paintCanvas ? paintCtx : samplerCtx) : targetCtx;
const sourceCanvasObj = sourceCanvas || targetCtx.canvas;
const state = zoomState.canvasStates[canvasId];

if (isNaN(currentX) || isNaN(currentY)) {
    console.error('Invalid coordinates in smearPixels:', { currentX, currentY });
    return;
}
if (isNaN(brushState.brushSize) || brushState.brushSize <= 0) {
    console.error('Invalid brushState.brushSize in smearPixels:', brushState.brushSize);
    brushState.brushSize = brushState.baseBrushSize || 50;
}

// Get zoom and pan from canvas state
const zoomLevel = Math.max(0.1, state.zoomLevel || 1);
const panX = state.panX || 0;
const panY = state.panY || 0;

// Transform input coordinates to canvas space (already done in getCanvasCoordinates)
// CurrentX and currentY are in canvas space, so no further transformation needed here
const mappedX = currentX;
const mappedY = currentY;

// Transform source coordinates to canvas space if provided
let mappedSourceX = sourceX;
let mappedSourceY = sourceY;
if (sourceX !== undefined && sourceY !== undefined) {
    // Source coordinates are in screen space, transform to canvas space
    mappedSourceX = (sourceX - panX) / zoomLevel;
    mappedSourceY = (sourceY - panY) / zoomLevel;
}

// Use brush size directly - coordinates are already transformed
const mappedBrushSize = brushState.brushSize;
const halfBrush = mappedBrushSize / 2;

// Calculate bounds in canvas space
const xMin = Math.max(0, Math.floor(mappedX - halfBrush));
const xMax = Math.min(targetCtx.canvas.width - 1, Math.ceil(mappedX + halfBrush));
const yMin = Math.max(0, Math.floor(mappedY - halfBrush));
const yMax = Math.min(targetCtx.canvas.height - 1, Math.ceil(mappedY + halfBrush));

// Initialize offscreen canvas for painting
if (!state.offscreenCanvas || state.offscreenCanvas.width !== targetCtx.canvas.width || state.offscreenCanvas.height !== targetCtx.canvas.height) {
state.offscreenCanvas = document.createElement('canvas');
state.offscreenCanvas.width = targetCtx.canvas.width;
state.offscreenCanvas.height = targetCtx.canvas.height;
const offscreenCtx = state.offscreenCanvas.getContext('2d', { alpha: true });
offscreenCtx.imageSmoothingEnabled = true;
offscreenCtx.imageSmoothingQuality = 'high';

// Get unzoomed content from the display canvas
targetCtx.save();
targetCtx.setTransform(1, 0, 0, 1, 0, 0); // Reset transform
const unzoomedData = targetCtx.getImageData(0, 0, targetCtx.canvas.width, targetCtx.canvas.height);
targetCtx.restore();

// Initialize offscreen with unzoomed content
offscreenCtx.putImageData(unzoomedData, 0, 0);

// Update imageState.currentImageData with the correct unzoomed data
imageState.currentImageData[canvasId] = unzoomedData;
}
const offscreenCtx = state.offscreenCanvas.getContext('2d', { alpha: true });

// Create temporary canvas for brush application
const tempCanvas = document.createElement('canvas');
tempCanvas.width = Math.max(1, xMax - xMin);
tempCanvas.height = Math.max(1, yMax - yMin);
const tempCtx = tempCanvas.getContext('2d', { alpha: true });
tempCtx.clearRect(0, 0, tempCanvas.width, tempCanvas.height);

let pixels = [];
const isTeleportClone = effectStates.isTeleportHeld && sourceCanvas && sourceCanvas !== targetCtx.canvas;
const step = effectStates.isDitherVibeHeld && brushState.brushShape !== 'stickerMode' && mappedBrushSize > 50 ? Math.ceil(mappedBrushSize / 50) : 1;

if (brushState.brushShape === 'stickerMode') {
    let stampPixels = [];
    if (stickerSlot && stickerImages[stickerSlot]) {
        let stickerImg = stickerImages[stickerSlot];
        if (flipState.isFlipHorizontalActive && flippedStampImages[stickerSlot]?.horizontal) {
            stickerImg = flippedStampImages[stickerSlot].horizontal;
        } else if (flipState.isFlipVerticalActive && flippedStampImages[stickerSlot]?.vertical) {
            stickerImg = flippedStampImages[stickerSlot].vertical;
        }
        const aspectRatio = stickerImg.height / stickerImg.width;
        let stickerWidth = stickerImg.width;
        let stickerHeight = stickerImg.height;
        const effectiveSize = isTeleportClone ? brushState.cloneBrushSize : brushState.brushSize;
        const effectiveRotation = isTeleportClone ? brushState.cloneBrushRotation : brushState.brushRotation;
        if (stickerWidth > stickerHeight) {
stickerWidth = effectiveSize;
stickerHeight = effectiveSize * aspectRatio;
} else {
stickerHeight = effectiveSize;
stickerWidth = effectiveSize / aspectRatio;
}
        const drawX = mappedX;
        const drawY = mappedY;
        const offsetX = Math.round(drawX - stickerWidth / 2);
        const offsetY = Math.round(drawY - stickerHeight / 2);

        if (isTeleportClone && (isNaN(mappedSourceX) || isNaN(mappedSourceY) || 
            mappedSourceX < 0 || mappedSourceY < 0 || mappedSourceX >= sourceCanvasObj.width || mappedSourceY >= sourceCanvasObj.height)) {
            console.warn('Invalid teleport source coordinates for stamp cloning, skipping:', { mappedSourceX, mappedSourceY, canvasId });
            return;
        }

        tempCtx.save();
        tempCtx.translate(drawX - offsetX, drawY - offsetY);
        tempCtx.rotate(effectiveRotation);
        tempCtx.drawImage(stickerImg, -stickerWidth / 2, -stickerHeight / 2, stickerWidth, stickerHeight);
        tempCtx.restore();


        const stampData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
        for (let y = 0; y < tempCanvas.height; y++) {
            for (let x = 0; x < tempCanvas.width; x++) {
                const i = (y * tempCanvas.width + x) * 4;
                if (stampData.data[i + 3] > 0) {
                    const canvasX = x + offsetX;
                    const canvasY = y + offsetY;
                    if (canvasX >= 0 && canvasX < targetCtx.canvas.width && canvasY >= 0 && canvasY < targetCtx.canvas.height) {
                        stampPixels.push({
                            r: stampData.data[i],
                            g: stampData.data[i + 1],
                            b: stampData.data[i + 2],
                            x: canvasX,
                            y: canvasY
                        });
                    }
                }
            }
        }
    }
    if (stampPixels.length > 0) {
        applyEffects(stampPixels, 0, 0, dragState.lastX || mappedX, dragState.lastY || mappedY, mappedX, mappedY);
        pixels = stampPixels;
    }
} else if (brushState.brushShape === 'melt' || (brushState.brushShape === 'melt' && effectStates.isTeleportHeld)) {
    const firstFinger = inputState.touchPoints.find(tp => tp.id === teleportState.teleportFirstFinger) || inputState.touchPoints[0];
    let meltDirection = 1;
    let endY = targetCtx.canvas.height - 1;
    if (inputState.touchPoints.length >= 2) {
        const secondFinger = inputState.touchPoints[1];
        meltDirection = secondFinger.y < firstFinger.y ? -1 : 1;
        endY = meltDirection === 1 ? targetCtx.canvas.height - 1 : 0;
    }
    const drawX = isTeleportClone ? mappedSourceX : mappedX;
    const drawY = isTeleportClone ? mappedSourceY : mappedY;
    const effectiveHalfBrush = Math.max(halfBrush, 3);
    const effectiveXMin = Math.max(0, Math.floor(drawX - effectiveHalfBrush));
    const effectiveXMax = Math.min(sourceCanvasObj.width - 1, Math.ceil(drawX + effectiveHalfBrush));
    const effectiveYMin = Math.max(0, Math.floor(drawY - effectiveHalfBrush));
    const effectiveYMax = Math.min(sourceCanvasObj.height - 1, Math.ceil(drawY + effectiveHalfBrush));

    const renderYMin = Math.max(0, Math.floor(drawY - effectiveHalfBrush));
    const renderYMax = meltDirection === 1 ? sourceCanvasObj.height : Math.ceil(drawY + effectiveHalfBrush);
    tempCanvas.width = effectiveXMax - effectiveXMin;
    tempCanvas.height = renderYMax - renderYMin;
    tempCtx.clearRect(0, 0, tempCanvas.width, tempCanvas.height);

    let sourceImageData;
    try {
        sourceImageData = sourceCtx.getImageData(effectiveXMin, effectiveYMin, effectiveXMax - effectiveXMin, effectiveYMax - effectiveYMin);
    } catch (e) {
        console.error(`Failed to get sourceImageData for melt:`, e);
        return;
    }
    const sourceData = sourceImageData.data;
    const maxPixels = effectStates.isDitherVibeHeld ? 50000 : 100000;
    let pixelCount = 0;
    let sourcePixels = [];
    for (let y = 0; y < effectiveYMax - effectiveYMin; y += step) {
        for (let x = 0; x < effectiveXMax - effectiveXMin; x += step) {
            if (pixelCount >= maxPixels) break;
            const canvasX = x + effectiveXMin;
            const canvasY = y + effectiveYMin;
            if (isPixelInBrushShape(canvasX, canvasY, drawX, drawY, effectiveHalfBrush)) {
                const srcIndex = (y * (effectiveXMax - effectiveXMin) + x) * 4;
                const r = sourceData[srcIndex] || 0;
                const g = sourceData[srcIndex + 1] || 0;
                const b = sourceData[srcIndex + 2] || 0;
                if (r || g || b || sourceData[srcIndex + 3] > 0) {
                    sourcePixels.push({ r, g, b, x: canvasX, y: canvasY });
                    pixelCount++;
                }
            }
        }
    }
    pixelCount = 0;
    sourcePixels.forEach(pixel => {
        if (pixelCount >= maxPixels) return;
        const cosRot = Math.cos(brushState.brushRotation);
        const sinRot = Math.sin(brushState.brushRotation);
        const relX = pixel.x - drawX;
        const relY = pixel.y - drawY;
        const rotatedX = relX * cosRot - relY * sinRot;
        const rotatedY = relX * sinRot + relY * cosRot;
        const baseDestX = Math.round(drawX + rotatedX);
        const baseDestY = Math.round(drawY + rotatedY);
        const bleedDistance = Math.abs(endY - baseDestY);
        const steps = Math.ceil(bleedDistance / 5);
        const stepY = meltDirection * bleedDistance / steps;
        for (let i = 0; i <= steps; i += step) {
            if (pixelCount >= maxPixels) break;
            const destX = baseDestX;
            let destY = Math.round(baseDestY + stepY * i);
            if (meltDirection === -1 && destY < 0) destY = 0;
            const finalX = isTeleportClone ? mappedX + (destX - mappedSourceX) : destX;
            const finalY = isTeleportClone ? mappedY + (destY - mappedSourceY) : destY;
            if (finalX >= 0 && finalX < targetCtx.canvas.width && finalY >= 0 && finalY < targetCtx.canvas.height) {
                pixels.push({ r: pixel.r, g: pixel.b, b: pixel.b, x: finalX, y: finalY });
                pixelCount++;
            }
        }
    });
} else if (brushState.brushShape === 'brokenScreen' || (brushState.brushShape === 'brokenScreen' && effectStates.isTeleportHeld)) {
    let holdTime;
    if (recordingState.isRecording && recordingState.currentMovement) {
        holdTime = recordingState.currentMovement.holdTime || 0.5;
    } else {
        const firstFinger = inputState.touchPoints.find(tp => tp.id === teleportState.teleportFirstFinger) || inputState.touchPoints[0];
        holdTime = firstFinger ? (Date.now() - firstFinger.startTime) / 1000 : 0.5;
    }
    const meltSpeed = 5000 * holdTime;
    let meltDirection = 1;
    if (inputState.touchPoints.length >= 2) {
        const secondFinger = inputState.touchPoints[1];
        meltDirection = secondFinger.y < (inputState.touchPoints[0]?.y || mappedY) ? -1 : 1;
    }
    const drawX = isTeleportClone ? mappedSourceX : mappedX;
    const drawY = isTeleportClone ? mappedSourceY : mappedY;
    let sourceImageData;
    try {
        sourceImageData = sourceCtx.getImageData(xMin, yMin, xMax - xMin, yMax - yMin);
    } catch (e) {
        console.error(`Failed to get sourceImageData for brokenScreen:`, e);
        return;
    }
    const sourceData = sourceImageData.data;
    const maxPixels = effectStates.isDitherVibeHeld ? 50000 : 100000;
    let pixelCount = 0;
    for (let y = 0; y < yMax - yMin; y += step) {
        for (let x = 0; x < xMax - xMin; x += step) {
            if (pixelCount >= maxPixels) break;
            const canvasX = x + xMin;
            const canvasY = y + yMin;
            if (isPixelInBrushShape(canvasX, canvasY, drawX, drawY, halfBrush)) {
                const srcIndex = (y * (xMax - xMin) + x) * 4;
                const r = sourceData[srcIndex] || 0;
                const g = sourceData[srcIndex + 1] || 0;
                const b = sourceData[srcIndex + 2] || 0;
                if (r || g || b || sourceData[srcIndex + 3] > 0) {
                    const cosRot = Math.cos(brushState.brushRotation);
                    const sinRot = Math.sin(brushState.brushRotation);
                    const relX = canvasX - drawX;
                    const relY = canvasY - drawY;
                    const rotatedX = relX * cosRot - relY * sinRot;
                    const rotatedY = relX * sinRot + relY * cosRot;
                    const baseDestX = Math.round(drawX + rotatedX);
                    const baseDestY = Math.round(drawY + rotatedY);
                    const baseYForDistance = drawY + relY;
                    const endY = meltDirection === 1 ? sourceCanvasObj.height - 1 : 0;
                    const bleedDistance = Math.min(meltSpeed, Math.abs(endY - baseYForDistance));
                    const steps = Math.ceil(bleedDistance);
                    const stepY = meltDirection * bleedDistance / steps;
                    for (let i = 0; i <= steps; i += step) {
                        if (pixelCount >= maxPixels) break;
                        const destX = baseDestX;
                        let destY = Math.round(baseDestY + stepY * i);
                        if (meltDirection === 1 && destY > endY) destY = endY;
                        if (meltDirection === -1 && destY < endY) destY = endY;
                        const finalX = isTeleportClone ? mappedX + (destX - mappedSourceX) : destX;
                        const finalY = isTeleportClone ? mappedY + (destY - mappedSourceY) : destY;
                        if (finalX >= 0 && finalX < targetCtx.canvas.width && finalY >= 0 && finalY < targetCtx.canvas.height) {
                            pixels.push({ r, g, b, x: finalX, y: finalY });
                            pixelCount++;
                        }
                    }
                }
            }
        }
    }
    if (recordingState.isRecording && recordingState.currentMovement) {
        recordingState.currentMovement.holdTime = holdTime;
    }
} else if (brushState.brushShape === 'jazzScatter') {
const drawX = isTeleportClone ? mappedSourceX : mappedX;
const drawY = isTeleportClone ? mappedSourceY : mappedY;
const sampleRadius = halfBrush * 0.5;
const sampleXMin = Math.max(0, Math.floor(drawX - sampleRadius));
const sampleXMax = Math.min(sourceCanvasObj.width - 1, Math.ceil(drawX + sampleRadius));
const sampleYMin = Math.max(0, Math.floor(drawY - sampleRadius));
const sampleYMax = Math.min(sourceCanvasObj.height - 1, Math.ceil(drawY + sampleRadius));
let sourceImageData;
try {
    sourceImageData = sourceCtx.getImageData(sampleXMin, sampleYMin, sampleXMax - sampleXMin, sampleYMax - sampleYMin);
} catch (e) {
    console.error('Failed to get sourceImageData for jazzScatter:', e);
    sourceImageData = sourceCtx.createImageData(sampleXMax - sampleXMin, sampleYMax - sampleYMin);
    for (let i = 0; i < sourceImageData.data.length; i += 4) {
        sourceImageData.data[i] = 255;
        sourceImageData.data[i + 1] = 20;
        sourceImageData.data[i + 2] = 147;
        sourceImageData.data[i + 3] = 255;
    }
}
const sourceData = sourceImageData.data;
const colorCounts = {};
for (let i = 0; i < sourceData.length; i += 4) {
    if (sourceData[i + 3] > 0) {
        const r = sourceData[i];
        const g = sourceData[i + 1];
        const b = sourceData[i + 2];
        const colorKey = `${r},${g},${b}`;
        colorCounts[colorKey] = (colorCounts[colorKey] || 0) + 1;
    }
}
const sortedColors = Object.entries(colorCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([colorKey]) => {
        const [r, g, b] = colorKey.split(',').map(Number);
        return { r, g, b };
    });
const dominantColors = sortedColors.length > 0 ? sortedColors : [{ r: 255, g: 20, b: 147 }];
const numShapes = Math.floor(Math.random() * 20) + 5; // Reduced to 5-25 for sparse scatter
const scatterRadius = halfBrush * 5.0; // Increased to 5.0 for very wide scatter
for (let i = 0; i < numShapes; i++) {
    const width = mappedBrushSize * (0.1 + Math.random() * 0.3);
    const height = mappedBrushSize * (0.1 + Math.random() * 0.3);
    const angle = Math.random() * 2 * Math.PI;
    const distance = Math.pow(Math.random(), 2.0) * scatterRadius; // Stronger bias for irregular spread
    let shapeX = drawX + Math.cos(angle) * distance;
    let shapeY = drawY + Math.sin(angle) * distance;
    let posOffsetX = 0;
    let posOffsetY = 0;
    const time = Date.now() * 0.001;
    if (effectStates.isFractalStretchHeld) {
        const dx = shapeX - drawX;
        const dy = shapeY - drawY;
        posOffsetX = Math.sin(time + dx * 0.1) * halfBrush * 0.5;
        posOffsetY = Math.cos(time + dy * 0.1) * halfBrush * 0.5;
        shapeX += posOffsetX;
        shapeY += posOffsetY;
    }
    if (effectStates.isGlitchTideHeld) {
        const dy = shapeY - drawY;
        posOffsetX = Math.sin(time + dy * 0.3) * mappedBrushSize * 0.5;
        posOffsetY = Math.random() * halfBrush * 0.2;
        shapeX += posOffsetX;
        shapeY += posOffsetY;
    }
    const finalX = isTeleportClone ? mappedX + (shapeX - mappedSourceX) : shapeX;
    const finalY = isTeleportClone ? mappedY + (shapeY - mappedSourceY) : shapeY;
    if (finalX < 0 || finalX >= targetCtx.canvas.width || finalY < 0 || finalY >= targetCtx.canvas.height) {
        continue;
    }
    const color = dominantColors[i % dominantColors.length];
    const effectPixel = [{ r: color.r, g: color.g, b: color.b, x: finalX, y: finalY, a: 255 }];
    applyEffects(effectPixel, 0, 0, drawX, drawY, mappedX, mappedY);
    const effectColor = effectPixel[0];
    tempCtx.fillStyle = `rgb(${effectColor.r},${effectColor.g},${effectColor.b})`;
    tempCtx.save();
    tempCtx.translate(finalX - xMin, finalY - yMin);
    tempCtx.rotate(brushState.brushRotation);
    tempCtx.fillRect(-width / 2, -height / 2, width, height);
    tempCtx.restore();
}
const shapeData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
for (let y = 0; y < tempCanvas.height; y += step) {
    for (let x = 0; x < tempCanvas.width; x += step) {
        const i = (y * tempCanvas.width + x) * 4;
        if (shapeData.data[i + 3] > 0) {
            const canvasX = x + xMin;
            const canvasY = y + yMin;
            pixels.push({ r: shapeData.data[i], g: shapeData.data[i + 1], b: shapeData.data[i + 2], x: canvasX, y: canvasY });
        }
    }
}
} else if (flippedBrushSnapshot && (flipState.isFlipHorizontalActive || flipState.isFlipVerticalActive)) {
    for (let y = 0; y < flippedBrushHeight; y += step) {
        for (let x = 0; x < flippedBrushWidth; x += step) {
            const srcIndex = (y * flippedBrushWidth + x) * 4;
            const r = flippedBrushSnapshot.data[srcIndex];
            const g = flippedBrushSnapshot.data[srcIndex + 1];
            const b = flippedBrushSnapshot.data[srcIndex + 2];
            const relX = x - flippedBrushWidth / 2;
            const relY = y - flippedBrushHeight / 2;
            const rotatedX = relX * Math.cos(brushState.brushRotation) - relY * Math.sin(brushState.brushRotation);
            const rotatedY = relX * Math.sin(brushState.brushRotation) + relY * Math.cos(brushState.brushRotation);
            const destX = Math.round(mappedX + rotatedX);
            const destY = Math.round(mappedY + rotatedY);
            if (destX >= xMin && destX < xMax && destY >= yMin && destY < yMax && 
                isPixelInBrushShape(destX, destY, mappedX, mappedY, halfBrush)) {
                pixels.push({ r, g, b, x: destX, y: destY });
            }
        }
    }
} else if (brushState.brushShape === 'tv') {
    let sourceImageData;
    try {
        sourceImageData = sourceCtx.getImageData(xMin, yMin, xMax - xMin, yMax - yMin);
    } catch (e) {
        console.error(`Failed to get sourceImageData for tv:`, e);
        return;
    }
    const sourceData = sourceImageData.data;
    for (let y = 0; y < yMax - yMin; y += step) {
        for (let x = 0; x < xMax - xMin; x += step) {
            const canvasX = x + xMin;
            const canvasY = y + yMin;
            if (isPixelInBrushShape(canvasX, canvasY, mappedX, mappedY, halfBrush)) {
                const srcIndex = (y * (xMax - xMin) + x) * 4;
                let gray = 128;
                if (sourceData[srcIndex + 3] > 0) {
                    gray = (sourceData[srcIndex] + sourceData[srcIndex + 1] + sourceData[srcIndex + 2]) / 3;
                }
                const noise = (Math.random() - 0.5) * 50;
                const relX = canvasX - mappedX;
                const relY = canvasY - mappedY;
                const rotatedX = relX * Math.cos(brushState.brushRotation) - relY * Math.sin(brushState.brushRotation);
                const rotatedY = relX * Math.sin(brushState.brushRotation) + relY * Math.cos(brushState.brushRotation);
                const destX = Math.round(mappedX + rotatedX);
                const destY = Math.round(mappedY + rotatedY);
                if (destX >= 0 && destX < targetCtx.canvas.width && destY >= 0 && destY < targetCtx.canvas.height) {
                    pixels.push({ r: gray + noise, g: gray + noise, b: gray + noise, x: destX, y: destY });
                }
            }
        }
    }
} else if (brushState.brushShape === 'negative') {
    let sourceImageData;
    try {
        sourceImageData = sourceCtx.getImageData(xMin, yMin, xMax - xMin, yMax - yMin);
    } catch (e) {
        console.error(`Failed to get sourceImageData for negative:`, e);
        return;
    }
    const sourceData = sourceImageData.data;
    for (let y = 0; y < yMax - yMin; y += step) {
        for (let x = 0; x < xMax - xMin; x += step) {
            const canvasX = x + xMin;
            const canvasY = y + yMin;
            if (isPixelInBrushShape(canvasX, canvasY, mappedX, mappedY, halfBrush)) {
                const srcIndex = (y * (xMax - xMin) + x) * 4;
                const r = 255 - (sourceData[srcIndex] || 0);
                const g = 255 - (sourceData[srcIndex + 1] || 0);
                const b = 255 - (sourceData[srcIndex + 2] || 0);
                const relX = canvasX - mappedX;
                const relY = canvasY - mappedY;
                const rotatedX = relX * Math.cos(brushState.brushRotation) - relY * Math.sin(brushState.brushRotation);
                const rotatedY = relX * Math.sin(brushState.brushRotation) + relY * Math.cos(brushState.brushRotation);
                const destX = Math.round(mappedX + rotatedX);
                const destY = Math.round(mappedY + rotatedY);
                if (destX >= 0 && destX < targetCtx.canvas.width && destY >= 0 && destY < targetCtx.canvas.height) {
                    pixels.push({ r, g, b, x: destX, y: destY });
                }
            }
        }
    }
} else if (effectStates.isPaintMode) {
    if (!['box', 'circle', 'rectangle', 'triangle'].includes(brushState.brushShape)) {
        brushState.brushShape = 'box';
        Object.values(brushButtons).forEach(btn => btn.classList.remove('selected'));
        brushButtons.box.classList.add('selected');
    }
    for (let y = yMin; y < yMax; y += step) {
        for (let x = xMin; x < xMax; x += step) {
            if (isPixelInBrushShape(x, y, mappedX, mappedY, halfBrush)) {
                const relX = x - mappedX;
                const relY = y - mappedY;
                const rotatedX = relX * Math.cos(brushState.brushRotation) - relY * Math.sin(brushState.brushRotation);
                const rotatedY = relX * Math.sin(brushState.brushRotation) + relY * Math.cos(brushState.brushRotation);
                const destX = Math.round(mappedX + rotatedX);
                const destY = Math.round(mappedY + rotatedY);
                if (destX >= 0 && destX < targetCtx.canvas.width && destY >= 0 && destY < targetCtx.canvas.height) {
                    pixels.push({ r: brushState.paintColor.r, g: brushState.paintColor.g, b: brushState.paintColor.b, x: destX, y: destY });
                }
            }
        }
    }
} else if (mappedSourceX !== undefined && mappedSourceY !== undefined && !isTeleportClone && inputState.touchPoints.length >= 3) {
    const srcXMin = Math.max(0, Math.floor(mappedSourceX - halfBrush));
    const srcXMax = Math.min(sourceCanvasObj.width, Math.ceil(mappedSourceX + halfBrush));
    const srcYMin = Math.max(0, Math.floor(mappedSourceY - halfBrush));
    const srcYMax = Math.min(sourceCanvasObj.height, Math.ceil(mappedSourceY + halfBrush));
    const srcWidth = srcXMax - srcXMin;
    const srcHeight = srcYMax - srcYMin;

    if (srcWidth <= 0 || srcHeight <= 0) {
        console.warn('Invalid reverse teleport source dimensions:', { srcXMin, srcXMax, srcYMin, srcYMax, canvasId });
        return;
    }

    let sourceImageData;
    try {
        sourceImageData = sourceCtx.getImageData(srcXMin, srcYMin, srcWidth, srcHeight);
    } catch (e) {
        console.error('Failed to get source image data for reverse teleport:', e);
        return;
    }

    const sourceData = sourceImageData.data;
    let pixelCount = 0;
    for (let y = yMin; y < yMax; y += step) {
        for (let x = xMin; x < xMax; x += step) {
            if (isPixelInBrushShape(x, y, mappedX, mappedY, halfBrush)) {
                const relX = x - mappedX;
                const relY = y - mappedY;
                const cosRot = Math.cos(brushState.brushRotation);
                const sinRot = Math.sin(brushState.brushRotation);
                const rotatedX = relX * cosRot - relY * sinRot;
                const rotatedY = relX * sinRot + relY * cosRot;
                const srcX = Math.round(mappedSourceX + rotatedX - srcXMin);
                const srcY = Math.round(mappedSourceY + rotatedY - srcYMin);

                if (srcX >= 0 && srcX < srcWidth && srcY >= 0 && srcY < srcHeight) {
                    const srcIndex = (srcY * srcWidth + srcX) * 4;
                    if (sourceData[srcIndex + 3] > 0) {
                        const r = sourceData[srcIndex] || 0;
                        const g = sourceData[srcIndex + 1] || 0;
                        const b = sourceData[srcIndex + 2] || 0;
                        pixels.push({ r, g, b, x, y });
                        pixelCount++;
                    }
                }
            }
        }
    }
} else {
    let srcXBase = isTeleportClone ? mappedSourceX : (dragState.lastX !== undefined ? dragState.lastX : mappedX);
    let srcYBase = isTeleportClone ? mappedSourceY : (dragState.lastY !== undefined ? dragState.lastY : mappedY);
    if (isTeleportClone && (isNaN(srcXBase) || isNaN(srcYBase) || srcXBase < 0 || srcYBase < 0 || 
        srcXBase >= sourceCanvasObj.width || srcYBase >= sourceCanvasObj.height)) {
        return;
    }
    const srcXMin = Math.max(0, Math.floor(srcXBase - halfBrush));
    const srcXMax = Math.min(sourceCanvasObj.width - 1, Math.ceil(srcXBase + halfBrush));
    const srcYMin = Math.max(0, Math.floor(srcYBase - halfBrush));
    const srcYMax = Math.min(sourceCanvasObj.height - 1, Math.ceil(srcYBase + halfBrush));
    const srcWidth = srcXMax - srcXMin;
    const srcHeight = srcYMax - srcYMin;
    let sourceImageData;
    try {
        sourceImageData = sourceCtx.getImageData(srcXMin, srcYMin, srcWidth, srcHeight);
    } catch (e) {
        console.error(`Failed to get sourceImageData:`, e);
        return;
    }
    const sourceData = sourceImageData.data;
    let pixelCount = 0;
    for (let y = 0; y < yMax - yMin; y += step) {
        for (let x = 0; x < xMax - xMin; x += step) {
            const canvasX = x + xMin;
            const canvasY = y + yMin;
            if (isPixelInBrushShape(canvasX, canvasY, mappedX, mappedY, halfBrush)) {
                let relX = canvasX - mappedX;
                let relY = canvasY - mappedY;
                if (flipState.isFlipVerticalActive) relY = -relY;
                let srcX = Math.round(srcXBase + relX);
                let srcY = Math.round(srcYBase + relY);
                srcX = Math.max(srcXMin, Math.min(srcXMax - 1, srcX));
                srcY = Math.max(srcYMin, Math.min(srcYMax - 1, srcY));
                const srcIndex = ((srcY - srcYMin) * srcWidth + (srcX - srcXMin)) * 4;
                const r = sourceData[srcIndex] || 0;
                const g = sourceData[srcIndex + 1] || 0;
                const b = sourceData[srcIndex + 2] || 0;
                if (sourceData[srcIndex + 3] > 0) {
                    const rotatedX = relX * Math.cos(brushState.brushRotation) - relY * Math.sin(brushState.brushRotation);
                    const rotatedY = relX * Math.sin(brushState.brushRotation) + relY * Math.cos(brushState.brushRotation);
                    const destX = Math.round(mappedX + rotatedX);
                    const destY = Math.round(mappedY + rotatedY);
                    if (destX >= xMin && destX < xMax && destY >= yMin && destY < yMax) {
                        pixels.push({ r, g, b, x: destX, y: destY });
                        pixelCount++;
                    }
                }
            }
        }
    }
}
}


/**
 * drawSweeperLines
 */
export function drawSweeperLines(canvasId) {
sweeperState.anchorPoints.slice(0, 3).forEach((point, i) => {
});

const targetCtx = canvasId === 'base' ? baseCtx : canvasId === 'paint' ? paintCtx : samplerCtx;
const targetCanvas = canvasId === 'base' ? baseCanvas : canvasId === 'paint' ? paintCanvas : samplerCanvas;
const state = zoomState.canvasStates[canvasId];

// Get zoom parameters
const zoomLevel = state.zoomLevel || 1;
const panX = state.panX || 0;
const panY = state.panY || 0;

if (sweeperState.anchorPoints.length < 2) {
    if (sweeperState.anchorPoints.length === 1) smearPixels(sweeperState.anchorPoints[0].x, sweeperState.anchorPoints[0].y, canvasId);
    return;
}

// Transform anchor points from screen space to canvas space if zoomed
const transformedAnchorPoints = sweeperState.anchorPoints.map(point => {
    if (zoomLevel !== 1) {
        return {
            ...point,
            x: (point.x - panX) / zoomLevel,
            y: (point.y - panY) / zoomLevel
        };
    }
    return point;
});

// Transform inputState.lastTouchPoints as well
const transformedLastTouchPoints = inputState.lastTouchPoints.map(point => {
    if (!point) return null;
    if (zoomLevel !== 1) {
        return {
            ...point,
            x: (point.x - panX) / zoomLevel,
            y: (point.y - panY) / zoomLevel
        };
    }
    return point;
});

// Cache canvas backups (only create once per drag)
if (!window.canvasBackupsCache || window.lastBackupCanvasId !== canvasId) {
window.canvasBackupsCache = {};
['base', 'paint', 'sampler'].forEach(key => {
    if (key !== canvasId) {
        const ctx = key === 'base' ? baseCtx : key === 'paint' ? paintCtx : samplerCtx;
        const state = zoomState.canvasStates[key];
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        window.canvasBackupsCache[key] = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
        // Restore zoom if needed
        if (state.zoomLevel !== 1 || state.panX !== 0 || state.panY !== 0) {
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
            ctx.fillStyle = '#FFFFFF';
            ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
            ctx.save();
            ctx.translate(state.panX, state.panY);
            ctx.scale(state.zoomLevel, state.zoomLevel);
            ctx.putImageData(window.canvasBackupsCache[key], 0, 0);
            ctx.restore();
        }
    }
});
window.lastBackupCanvasId = canvasId;
}
const canvasBackups = window.canvasBackupsCache;

// Initialize offscreen canvas for zoom-aware painting
if (!state.offscreenCanvas || state.offscreenCanvas.width !== targetCtx.canvas.width || state.offscreenCanvas.height !== targetCtx.canvas.height) {
    state.offscreenCanvas = document.createElement('canvas');
    state.offscreenCanvas.width = targetCtx.canvas.width;
    state.offscreenCanvas.height = targetCtx.canvas.height;
    const offscreenCtx = state.offscreenCanvas.getContext('2d', { alpha: true });
    offscreenCtx.imageSmoothingEnabled = true;
    offscreenCtx.imageSmoothingQuality = 'high';
    if (imageState.currentImageData[canvasId]) {
        offscreenCtx.putImageData(imageState.currentImageData[canvasId], 0, 0);
    }
}
const offscreenCtx = state.offscreenCanvas.getContext('2d', { alpha: true });

// Calculate bounds using ORIGINAL brush size (no scaling needed in canvas space)
const width = Math.max(1, brushState.brushSize);
const halfWidth = Math.floor(width / 2);
let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;

// Use transformed points for bounds calculation
transformedAnchorPoints.forEach(point => {
    if (isNaN(point.x) || isNaN(point.y)) {
        console.error('NaN in anchor point:', point);
        return;
    }
    xMin = Math.min(xMin, Math.floor(point.x - halfWidth));
    xMax = Math.max(xMax, Math.ceil(point.x + halfWidth));
    yMin = Math.min(yMin, Math.floor(point.y - halfWidth));
    yMax = Math.max(yMax, Math.ceil(point.y + halfWidth));
});

xMin = Math.floor(xMin);
xMax = Math.ceil(xMax);
yMin = Math.floor(yMin);
yMax = Math.ceil(yMax);

const canvas = targetCtx.canvas;
xMin = Math.max(0, xMin);
yMin = Math.max(0, yMin);
xMax = Math.min(canvas.width, xMax);
yMax = Math.min(canvas.height, yMax);

if (xMax <= xMin || yMax <= yMin) {
    console.error('Invalid bounds in drawSweeperLines:', { xMin, xMax, yMin, yMax });
    // Restore non-target canvases
    Object.keys(canvasBackups).forEach(key => {
        if (canvasBackups[key]) {
            const restoreCtx = key === 'base' ? baseCtx : key === 'paint' ? paintCtx : samplerCtx;
            restoreCtx.putImageData(canvasBackups[key], 0, 0);
            imageState.currentImageData[key] = canvasBackups[key];
        }
    });
    return;
}

// Create temporary canvas for line rendering
const tempCanvas = document.createElement('canvas');
tempCanvas.width = Math.max(1, xMax - xMin);
tempCanvas.height = Math.max(1, yMax - yMin);
const tempCtx = tempCanvas.getContext('2d', { alpha: true });
tempCtx.clearRect(0, 0, tempCanvas.width, tempCanvas.height);

// Get source data from offscreen canvas
const sourceImageData = offscreenCtx.getImageData(0, 0, targetCtx.canvas.width, targetCtx.canvas.height);
const destImageData = tempCtx.createImageData(tempCanvas.width, tempCanvas.height);

// Use transformed points for smear operations
for (let i = 0; i < transformedAnchorPoints.length - 1; i++) {
    const start = transformedLastTouchPoints[i] || transformedAnchorPoints[i];
    const end = transformedLastTouchPoints[i + 1] || transformedAnchorPoints[i + 1];
    const newStart = transformedAnchorPoints[i];
    const newEnd = transformedAnchorPoints[i + 1];
    smearLine(canvasId, start.x, start.y, end.x, end.y, newStart.x, newStart.y, newEnd.x, newEnd.y, sourceImageData, destImageData, xMin, yMin, xMax, yMax);
}

// Apply result to temporary canvas
tempCtx.putImageData(destImageData, 0, 0);

// Update offscreen canvas
const visibleLeft = Math.max(0, xMin);
const visibleTop = Math.max(0, yMin);
const visibleRight = Math.min(targetCtx.canvas.width, xMax);
const visibleBottom = Math.min(targetCtx.canvas.height, yMax);


if (visibleRight > visibleLeft && visibleBottom > visibleTop) {
    const sourceX = visibleLeft - xMin;
    const sourceY = visibleTop - yMin;
    const sourceWidth = visibleRight - visibleLeft;
    const sourceHeight = visibleBottom - visibleTop;


    // Check if tempCanvas has visible content
    const tempImageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
    let nonTransparentPixels = 0;
    for (let i = 3; i < tempImageData.data.length; i += 4) {
        if (tempImageData.data[i] > 0) nonTransparentPixels++;
    }

    offscreenCtx.drawImage(
        tempCanvas,
        sourceX, sourceY, sourceWidth, sourceHeight,
        visibleLeft, visibleTop, sourceWidth, sourceHeight
    );
}

imageState.currentImageData[canvasId] = offscreenCtx.getImageData(0, 0, targetCtx.canvas.width, targetCtx.canvas.height);


// Restore non-target canvases
Object.keys(canvasBackups).forEach(key => {
    if (canvasBackups[key]) {
        const restoreCtx = key === 'base' ? baseCtx : key === 'paint' ? paintCtx : samplerCtx;
        restoreCtx.putImageData(canvasBackups[key], 0, 0);
        imageState.currentImageData[key] = canvasBackups[key];
    }
});

// Update the offscreen canvas with the new content
offscreenCtx.drawImage(tempCanvas, xMin, yMin);

// Always redraw with zoom transformation
targetCtx.setTransform(1, 0, 0, 1, 0, 0);
targetCtx.clearRect(0, 0, targetCtx.canvas.width, targetCtx.canvas.height);
targetCtx.fillStyle = '#FFFFFF';
targetCtx.fillRect(0, 0, targetCtx.canvas.width, targetCtx.canvas.height);
targetCtx.save();
targetCtx.beginPath();
targetCtx.rect(0, 0, targetCtx.canvas.width, targetCtx.canvas.height);
targetCtx.clip();
targetCtx.translate(panX, panY);
targetCtx.scale(zoomLevel, zoomLevel);
targetCtx.imageSmoothingEnabled = true;
targetCtx.imageSmoothingQuality = 'high';
targetCtx.drawImage(state.offscreenCanvas, 0, 0);
targetCtx.restore();

dragState.hasCanvasChanged = true;

if (recordingState.isRecording) {
    // Record with ORIGINAL anchor points (not transformed)
    recordMovement('smear', {
        lastX: inputState.lastTouchPoints[0]?.x || sweeperState.anchorPoints[0]?.x,
        lastY: inputState.lastTouchPoints[0]?.y || sweeperState.anchorPoints[0]?.y,
        currentX: sweeperState.anchorPoints[0]?.x,
        currentY: sweeperState.anchorPoints[0]?.y,
        canvasId,
        brushShape: brushState.brushShape,
        anchorPoints: sweeperState.anchorPoints.map((p, index) => ({
            x: p.x,
            y: p.y,
            lastX: inputState.lastTouchPoints[index]?.x || p.x,
            lastY: inputState.lastTouchPoints[index]?.y || p.y,
            fingerId: p.id || p.fingerId || `anchor_${index}`,
            target: p.target?.id || 'canvas',
            index: index
        })),
        mouseAnchorStart: sweeperState.mouseAnchorStart ? {
            x: sweeperState.mouseAnchorStart.x,
            y: sweeperState.mouseAnchorStart.y,
            target: sweeperState.mouseAnchorStart.target?.id || 'canvas'
        } : undefined,
        inputType: inputState.touchPoints[0]?.isMouse ? 'mouse' : 'touch',
        fingerCount: sweeperState.anchorPoints.length,
        activeEffects: [...activeEffects].map(k => keyLabels.find(kl => kl.key.toLowerCase() === k)?.effect).filter(e => e)
    });
}

}

/**
 * smearLine
 */
export function smearLine(canvasId, prevStartX, prevStartY, prevEndX, prevEndY, startX, startY, endX, endY, sourceImageData, destImageData, xMin, yMin, xMax, yMax) {
const ctx = canvasId === 'base' ? baseCtx : canvasId === 'paint' ? paintCtx : samplerCtx;
const canvas = ctx.canvas;
const state = zoomState.canvasStates[canvasId];
const zoomLevel = Math.max(0.1, state.zoomLevel || 1);
const panX = state.panX || 0;
const panY = state.panY || 0;

const mappedPrevStartX = prevStartX;
const mappedPrevStartY = prevStartY;
const mappedPrevEndX = prevEndX;
const mappedPrevEndY = prevEndY;
const mappedStartX = startX;
const mappedStartY = startY;
const mappedEndX = endX;
const mappedEndY = endY;

const dx = mappedPrevEndX - mappedPrevStartX;
const dy = mappedPrevEndY - mappedPrevStartY;
const length = Math.max(1, Math.sqrt(dx * dx + dy * dy));
const steps = Math.ceil(length);
const stepX = dx / steps;
const stepY = dy / steps;

const width = Math.max(1, brushState.brushSize);
const halfWidth = Math.floor(width / 2);
const normX = length ? -dy / length : 0;
const normY = length ? dx / length : 0;

const deltaX = mappedStartX - mappedPrevStartX;
const deltaY = mappedStartY - mappedPrevStartY;

const sourceData = sourceImageData.data;
const destData = destImageData.data;

let pixels = [];
for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const baseX = mappedPrevStartX + t * dx;
    const baseY = mappedPrevStartY + t * dy;
    for (let w = -halfWidth; w <= halfWidth; w++) {
        let x = baseX + w * normX;
        let y = baseY + w * normY;

        const centerX = (mappedPrevStartX + mappedPrevEndX) / 2;
        const centerY = (mappedPrevStartY + mappedPrevEndY) / 2;
        const relX = x - centerX;
        const relY = y - centerY;
        const cosRot = Math.cos(brushState.brushRotation);
        const sinRot = Math.sin(brushState.brushRotation);
        let rotatedX = relX * cosRot - relY * sinRot;
        let rotatedY = relX * sinRot + relY * cosRot;
        x = centerX + rotatedX;
        y = centerY + rotatedY;

        if (flipState.isFlipVerticalActive) {
            y = centerY + (centerY - y);
        }

        const srcX = Math.round(x);
const srcY = Math.round(y);
// SAFE SAMPLING - use edge pixels when outside canvas
const safeSrcX = Math.max(0, Math.min(srcX, canvas.width - 1));
const safeSrcY = Math.max(0, Math.min(srcY, canvas.height - 1));
const pixelI = (safeSrcY * canvas.width + safeSrcX) * 4;;

        if (sourceData[pixelI + 3] === 0) {
            continue;
        }

        let r = sourceData[pixelI] || 0;
        let g = sourceData[pixelI + 1] || 0;
        let b = sourceData[pixelI + 2] || 0;
        let a = sourceData[pixelI + 3] || 255;

        // Remove iridescent color effect for sweeper
        if (brushState.brushShape === 'oilbarrel') {

            const dist = Math.abs(w) / halfWidth;
            const [h, s, l] = rgbToHsl(r, g, b);
            const hueShift = Math.sin(t * 2 + w * 0.1) * 30 + 16.24;
            const satShift = Math.cos(t * 2) * 20 + 51.87;
            const lightShift = Math.sin(w * 0.1) * 15 + 44.61;
            [r, g, b] = hslToRgb((h + hueShift) % 360, Math.min(100, s + satShift), Math.max(10, Math.min(90, l + lightShift)));
            r = Math.min(255, r + Math.sin(t) * 20);
            g = Math.min(255, g + Math.cos(t) * 20);
        }

        pixels.push({ r, g, b, a, x: srcX, y: srcY });
    }
}

applyEffects(pixels, deltaX, deltaY, mappedPrevStartX, mappedPrevStartY, mappedStartX, mappedStartY);

const hasPositionalEffect = effectStates.isGlitchTideHeld || effectStates.isHyphenHeld || effectStates.isFractalStretchHeld || effectStates.isNeonBendHeld || effectStates.isLockHeld;
pixels.forEach(pixel => {
    let newX = hasPositionalEffect ? Math.round(pixel.x) : Math.round(pixel.x + deltaX);
    let newY = hasPositionalEffect ? Math.round(pixel.y) : Math.round(pixel.y + deltaY);
    newX = Math.max(xMin, Math.min(xMax - 1, newX));
    newY = Math.max(yMin, Math.min(yMax - 1, newY));
    if (newX >= xMin && newX <= xMax && newY >= yMin && newY <= yMax) {
        const destIndex = ((newY - yMin) * (xMax - xMin) + (newX - xMin)) * 4;
        destData[destIndex] = pixel.r;
        destData[destIndex + 1] = pixel.g;
        destData[destIndex + 2] = pixel.b;
        destData[destIndex + 3] = pixel.a;
    }
});
}


/**
 * drawAestheticLines
 */
export function drawAestheticLines(canvasId) {
const targetCtx = canvasId === 'base' ? baseCtx : canvasId === 'paint' ? paintCtx : samplerCtx;
const targetCanvas = canvasId === 'base' ? baseCanvas : canvasId === 'paint' ? paintCanvas : samplerCanvas;
const state = zoomState.canvasStates[canvasId];

// Get zoom parameters
const zoomLevel = state.zoomLevel || 1;
const panX = state.panX || 0;
const panY = state.panY || 0;

if (sweeperState.anchorPoints.length < 2) {
    if (sweeperState.anchorPoints.length === 1) smearPixels(sweeperState.anchorPoints[0].x, sweeperState.anchorPoints[0].y, canvasId);
    return;
}

// Transform anchor points from screen space to canvas space if zoomed
const transformedAnchorPoints = sweeperState.anchorPoints.map(point => {
    if (zoomLevel !== 1) {
        return {
            ...point,
            x: (point.x - panX) / zoomLevel,
            y: (point.y - panY) / zoomLevel
        };
    }
    return point;
});

// Transform inputState.lastTouchPoints as well
const transformedLastTouchPoints = inputState.lastTouchPoints.map(point => {
    if (!point) return null;
    if (zoomLevel !== 1) {
        return {
            ...point,
            x: (point.x - panX) / zoomLevel,
            y: (point.y - panY) / zoomLevel
        };
    }
    return point;
});

// Store non-target canvas states with zoom awareness
const canvasBackups = {};
['base', 'paint', 'sampler'].forEach(key => {
    if (key !== canvasId) {
        const ctx = key === 'base' ? baseCtx : key === 'paint' ? paintCtx : samplerCtx;
        const state = zoomState.canvasStates[key];
        // Get unzoomed content for backup
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        canvasBackups[key] = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
        // Restore zoom transform if needed
        if (state.zoomLevel !== 1 || state.panX !== 0 || state.panY !== 0) {
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
            ctx.fillStyle = '#FFFFFF';
            ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
            ctx.save();
            ctx.translate(state.panX, state.panY);
            ctx.scale(state.zoomLevel, state.zoomLevel);
            ctx.putImageData(canvasBackups[key], 0, 0);
            ctx.restore();
        }
    }
});

// Initialize offscreen canvas for zoom-aware painting
if (!state.offscreenCanvas || state.offscreenCanvas.width !== targetCtx.canvas.width || state.offscreenCanvas.height !== targetCtx.canvas.height) {
    state.offscreenCanvas = document.createElement('canvas');
    state.offscreenCanvas.width = targetCtx.canvas.width;
    state.offscreenCanvas.height = targetCtx.canvas.height;
    const offscreenCtx = state.offscreenCanvas.getContext('2d', { alpha: true });
    offscreenCtx.imageSmoothingEnabled = true;
    offscreenCtx.imageSmoothingQuality = 'high';
    if (imageState.currentImageData[canvasId]) {
        offscreenCtx.putImageData(imageState.currentImageData[canvasId], 0, 0);
    }
}
const offscreenCtx = state.offscreenCanvas.getContext('2d', { alpha: true });

// Calculate bounds using transformed points
const halfBrush = Math.max(brushState.brushSize * 1.5, 5);
let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
transformedAnchorPoints.forEach(point => {
    if (isNaN(point.x) || isNaN(point.y)) {
        console.error('NaN in anchor point:', point);
        return;
    }
    xMin = Math.min(xMin, Math.floor(point.x - halfBrush));
    xMax = Math.max(xMax, Math.ceil(point.x + halfBrush));
    yMin = Math.min(yMin, Math.floor(point.y - halfBrush));
    yMax = Math.max(yMax, Math.ceil(point.y + halfBrush));
});

const visibleXMin = Math.max(0, xMin);
const visibleXMax = Math.min(targetCtx.canvas.width, xMax);
const visibleYMin = Math.max(0, yMin);
const visibleYMax = Math.min(targetCtx.canvas.height, yMax);

// Only fail if completely invalid or no visible area
if (isNaN(xMin) || isNaN(xMax) || isNaN(yMin) || isNaN(yMax) || 
    visibleXMax <= visibleXMin || visibleYMax <= visibleYMin) {
    console.error('Invalid bounds in drawAestheticLines:', { xMin, xMax, yMin, yMax, visibleXMin, visibleXMax, visibleYMin, visibleYMax });
    // Restore non-target canvases
    Object.keys(canvasBackups).forEach(key => {
        if (canvasBackups[key]) {
            const restoreCtx = key === 'base' ? baseCtx : key === 'paint' ? paintCtx : samplerCtx;
            restoreCtx.putImageData(canvasBackups[key], 0, 0);
            imageState.currentImageData[key] = canvasBackups[key];
        }
    });
    return;
}

// Create temp canvas for visible area only
const tempCanvas = document.createElement('canvas');
tempCanvas.width = Math.max(1, visibleXMax - visibleXMin);
tempCanvas.height = Math.max(1, visibleYMax - visibleYMin);
const tempCtx = tempCanvas.getContext('2d', { alpha: true });
tempCtx.clearRect(0, 0, tempCanvas.width, tempCanvas.height);

// Get source data from offscreen canvas
const sourceImageData = offscreenCtx.getImageData(0, 0, targetCtx.canvas.width, targetCtx.canvas.height);
const destImageData = offscreenCtx.getImageData(xMin, yMin, xMax - xMin, yMax - yMin);

// Use transformed points for smear operations
for (let i = 0; i < transformedAnchorPoints.length - 1; i++) {
    const start = transformedLastTouchPoints[i] || transformedAnchorPoints[i];
    const end = transformedLastTouchPoints[i + 1] || transformedAnchorPoints[i + 1];
    const newStart = transformedAnchorPoints[i];
    const newEnd = transformedAnchorPoints[i + 1];
    smearAestheticLines(canvasId, start.x, start.y, end.x, end.y, newStart.x, newStart.y, newEnd.x, newEnd.y, sourceImageData, destImageData, xMin, yMin, xMax, yMax);
}

// Apply result to temporary canvas
tempCtx.putImageData(destImageData, 0, 0);

const tempSample = tempCtx.getImageData(0, 0, Math.min(10, tempCanvas.width), Math.min(10, tempCanvas.height));
for (let y = 0; y < Math.min(10, tempCanvas.height); y++) {
    let row = '';
    for (let x = 0; x < Math.min(10, tempCanvas.width); x++) {
        const i = (y * Math.min(10, tempCanvas.width) + x) * 4;
        const r = tempSample.data[i];
        const g = tempSample.data[i + 1]; 
        const b = tempSample.data[i + 2];
        const a = tempSample.data[i + 3];
        row += a > 0 ? `(${r},${g},${b}) ` : '(TRANSP) ';
    }
}

// Update offscreen canvas
offscreenCtx.drawImage(tempCanvas, xMin, yMin);
// Store the unzoomed content in imageState.currentImageData
imageState.currentImageData[canvasId] = offscreenCtx.getImageData(0, 0, targetCtx.canvas.width, targetCtx.canvas.height);

// Restore non-target canvases
Object.keys(canvasBackups).forEach(key => {
    if (canvasBackups[key]) {
        const restoreCtx = key === 'base' ? baseCtx : key === 'paint' ? paintCtx : samplerCtx;
        restoreCtx.putImageData(canvasBackups[key], 0, 0);
        imageState.currentImageData[key] = canvasBackups[key];
    }
});

// ALWAYS redraw with zoom transformation (removed if (!dragState.isDragging) check)
targetCtx.setTransform(1, 0, 0, 1, 0, 0);
targetCtx.clearRect(0, 0, targetCtx.canvas.width, targetCtx.canvas.height);
targetCtx.fillStyle = '#FFFFFF';
targetCtx.fillRect(0, 0, targetCtx.canvas.width, targetCtx.canvas.height);
targetCtx.save();
targetCtx.beginPath();
targetCtx.rect(0, 0, targetCtx.canvas.width, targetCtx.canvas.height);
targetCtx.clip();
targetCtx.translate(panX, panY);
targetCtx.scale(zoomLevel, zoomLevel);
targetCtx.imageSmoothingEnabled = true;
targetCtx.imageSmoothingQuality = 'high';
targetCtx.drawImage(state.offscreenCanvas, 0, 0);


targetCtx.restore();

dragState.hasCanvasChanged = true;

if (recordingState.isRecording) {
    // Record with ORIGINAL anchor points (not transformed)
    for (let i = 0; i < sweeperState.anchorPoints.length - 1; i++) {
        recordMovement('smear', { 
            lastX: inputState.lastTouchPoints[i]?.x || sweeperState.anchorPoints[i].x, 
            lastY: inputState.lastTouchPoints[i]?.y || sweeperState.anchorPoints[i].y, 
            currentX: sweeperState.anchorPoints[i].x, 
            currentY: sweeperState.anchorPoints[i].y,
            nextX: sweeperState.anchorPoints[i + 1].x,
            nextY: sweeperState.anchorPoints[i + 1].y,
            canvasId
        });
    }
}
}


/**
 * smearAestheticLines
 */
export function smearAestheticLines(canvasId, prevStartX, prevStartY, prevEndX, prevEndY, startX, startY, endX, endY, sourceImageData, destImageData, xMin, yMin, xMax, yMax) {
const ctx = canvasId === 'base' ? baseCtx : canvasId === 'paint' ? paintCtx : samplerCtx;
const canvas = ctx.canvas;

const dx = prevEndX - prevStartX;
const dy = prevEndY - prevStartY;
const length = Math.max(1, Math.sqrt(dx * dx + dy * dy));
const steps = Math.ceil(length);
const stepX = dx / steps;
const stepY = dy / steps;

const halfBrush = Math.max(brushState.brushSize * 1.5, 5);
const normX = length ? -dy / length : 0;
const normY = length ? dx / length : 0;

const deltaX = startX - prevStartX;
const deltaY = startY - prevStartY;
const time = Date.now() * 0.005;

const sourceData = sourceImageData.data;
const destData = destImageData.data;

let pixels = [];
for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const baseX = prevStartX + t * dx;
    const baseY = prevStartY + t * dy;
    for (let w = -halfBrush; w <= halfBrush; w++) {
        const swirlAngle = time + (w / halfBrush) * Math.PI;
        const swirlRadius = Math.sin(time + t * Math.PI) * halfBrush * 0.2;
        const swirlX = Math.cos(swirlAngle) * swirlRadius;
        const swirlY = Math.sin(swirlAngle) * swirlRadius;
        let x = baseX + w * normX + swirlX;
        let y = baseY + w * normY + swirlY;

        // Apply rotation
        const centerX = (prevStartX + prevEndX) / 2;
        const centerY = (prevStartY + prevEndY) / 2;
        const relX = x - centerX;
        const relY = y - centerY;
        const cosRot = Math.cos(brushState.brushRotation);
        const sinRot = Math.sin(brushState.brushRotation);
        let rotatedX = relX * cosRot - relY * sinRot;
        let rotatedY = relX * sinRot + relY * cosRot;
        x = centerX + rotatedX;
        y = centerY + rotatedY;

        // Apply vertical flip
        if (flipState.isFlipVerticalActive) {
            y = centerY + (centerY - y); // Flip around center Y
        }

        const srcX = Math.round(Math.max(0, Math.min(canvas.width - 1, x)));
        const srcY = Math.round(Math.max(0, Math.min(canvas.height - 1, y)));
        const pixelI = (srcY * canvas.width + srcX) * 4;
        let r = sourceData[pixelI] || 0;
        let g = sourceData[pixelI + 1] || 0;
        let b = sourceData[pixelI + 2] || 0;

        const dist = Math.abs(w) / halfBrush;
        const [h, s, l] = rgbToHsl(r, g, b);
        const hueShift = Math.sin(time + t * 3 + w * 0.2) * 50 + 20;
        const satShift = Math.cos(time + t * 3) * 30 + 60;
        const lightShift = Math.sin(time + w * 0.2) * 20 + 50;
        [r, g, b] = hslToRgb((h + hueShift) % 360, Math.min(100, s + satShift), Math.max(20, Math.min(90, l + lightShift)));
        r = Math.min(255, r + Math.sin(time + t * 2) * 30);
        g = Math.min(255, g + Math.cos(time + t * 2) * 30);

        pixels.push({ r, g, b, x: srcX, y: srcY });
    }
}

applyEffects(pixels, deltaX, deltaY, prevStartX, prevStartY, startX, startY);

const hasPositionalEffect = effectStates.isGlitchTideHeld || effectStates.isHyphenHeld || effectStates.isFractalStretchHeld || effectStates.isNeonBendHeld || effectStates.isLockHeld;
pixels.forEach(pixel => {
    let newX = hasPositionalEffect ? Math.round(pixel.x) : Math.round(pixel.x + deltaX);
    let newY = hasPositionalEffect ? Math.round(pixel.y) : Math.round(pixel.y + deltaY);
    newX = Math.max(xMin, Math.min(xMax - 1, newX));
    newY = Math.max(yMin, Math.min(yMax - 1, newY));
    if (newX >= xMin && newX <= xMax && newY >= yMin && newY <= yMax) {
        const destIndex = ((newY - yMin) * (xMax - xMin) + (newX - xMin)) * 4;
        destData[destIndex] = pixel.r;
        destData[destIndex + 1] = pixel.g;
        destData[destIndex + 2] = pixel.b;
        destData[destIndex + 3] = 255;
    }
});
}


/**
 * renderOilbarrelMouse
 */
export function renderOilbarrelMouse() {
if (!dragState.isDraggingOilbarrel || !dragState.oilbarrelDragState.ctx) {
    dragState.oilbarrelRafId = null;
    return;
}

const { startX, startY, endX, endY, canvasId, ctx, targetCanvas } = dragState.oilbarrelDragState;

try {
    // REMOVED: Heavy debug logging
    
    // Only update anchor points, don't recalculate everything
    sweeperState.anchorPoints[0].x = startX;
    sweeperState.anchorPoints[0].y = startY;
    sweeperState.anchorPoints[1].x = endX;
    sweeperState.anchorPoints[1].y = endY;
    
    // Use lighter drawing method
    drawSweeperLines(canvasId);
    dragState.hasCanvasChanged = true;

    // REMOVED: Heavy recording logic during animation
    
} catch (error) {
    console.error('Error in renderOilbarrelMouse:', error);
}

// Reduce frame rate to 30fps instead of 60fps
setTimeout(() => {
    dragState.oilbarrelRafId = requestAnimationFrame(renderOilbarrelMouse);
}, 33);
}
