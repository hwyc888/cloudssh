export interface GuacamolePointerRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface GuacamolePointerButtons {
  left: boolean;
  middle: boolean;
  right: boolean;
}

export const GUACAMOLE_WHEEL_THRESHOLD = 53;
export const GUACAMOLE_WHEEL_PIXELS_PER_LINE = 18;
export const GUACAMOLE_WHEEL_PIXELS_PER_PAGE =
  GUACAMOLE_WHEEL_PIXELS_PER_LINE * 16;

export function mapClientPointToRemote(
  rect: GuacamolePointerRect,
  remoteWidth: number,
  remoteHeight: number,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  if (
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    !Number.isFinite(remoteWidth) ||
    !Number.isFinite(remoteHeight) ||
    remoteWidth <= 0 ||
    remoteHeight <= 0
  ) {
    return null;
  }

  const maxX = Math.max(0, Math.round(remoteWidth) - 1);
  const maxY = Math.max(0, Math.round(remoteHeight) - 1);
  const x = Math.round(((clientX - rect.left) / rect.width) * remoteWidth);
  const y = Math.round(((clientY - rect.top) / rect.height) * remoteHeight);

  return {
    x: Math.min(maxX, Math.max(0, x)),
    y: Math.min(maxY, Math.max(0, y)),
  };
}

export function domButtonsToGuacamole(
  buttons: number,
): GuacamolePointerButtons {
  return {
    left: (buttons & 1) !== 0,
    middle: (buttons & 4) !== 0,
    right: (buttons & 2) !== 0,
  };
}

export function normalizeWheelDelta(deltaY: number, deltaMode: number): number {
  if (!Number.isFinite(deltaY)) return 0;
  if (deltaMode === 1) return deltaY * GUACAMOLE_WHEEL_PIXELS_PER_LINE;
  if (deltaMode === 2) return deltaY * GUACAMOLE_WHEEL_PIXELS_PER_PAGE;
  return deltaY;
}
