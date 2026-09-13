import { describe, expect, it } from "vitest";
import {
  GUACAMOLE_WHEEL_PIXELS_PER_LINE,
  GUACAMOLE_WHEEL_PIXELS_PER_PAGE,
  domButtonsToGuacamole,
  mapClientPointToRemote,
  normalizeWheelDelta,
} from "../../../features/guacamole/guacamole-pointer-input.ts";

describe("guacamole pointer input geometry", () => {
  it("maps the same visual point correctly before and after fullscreen resizing", () => {
    expect(
      mapClientPointToRemote(
        { left: 0, top: 0, width: 1920, height: 1080 },
        1920,
        1080,
        960,
        540,
      ),
    ).toEqual({ x: 960, y: 540 });

    expect(
      mapClientPointToRemote(
        { left: 120, top: 80, width: 960, height: 540 },
        1920,
        1080,
        600,
        350,
      ),
    ).toEqual({ x: 960, y: 540 });
  });

  it("clamps points to the current remote desktop bounds", () => {
    expect(
      mapClientPointToRemote(
        { left: 100, top: 100, width: 800, height: 600 },
        1600,
        1200,
        -500,
        5000,
      ),
    ).toEqual({ x: 0, y: 1199 });
  });

  it("rejects invalid geometry instead of emitting unusable coordinates", () => {
    expect(
      mapClientPointToRemote(
        { left: 0, top: 0, width: 0, height: 600 },
        1920,
        1080,
        1,
        1,
      ),
    ).toBeNull();
    expect(
      mapClientPointToRemote(
        { left: 0, top: 0, width: 800, height: 600 },
        0,
        1080,
        1,
        1,
      ),
    ).toBeNull();
  });

  it("maps DOM mouse button bits to Guacamole button order", () => {
    expect(domButtonsToGuacamole(1)).toEqual({
      left: true,
      middle: false,
      right: false,
    });
    expect(domButtonsToGuacamole(2)).toEqual({
      left: false,
      middle: false,
      right: true,
    });
    expect(domButtonsToGuacamole(4)).toEqual({
      left: false,
      middle: true,
      right: false,
    });
    expect(domButtonsToGuacamole(7)).toEqual({
      left: true,
      middle: true,
      right: true,
    });
  });

  it("normalizes line/page wheel deltas without depending on browser mode", () => {
    expect(normalizeWheelDelta(2, 0)).toBe(2);
    expect(normalizeWheelDelta(2, 1)).toBe(2 * GUACAMOLE_WHEEL_PIXELS_PER_LINE);
    expect(normalizeWheelDelta(2, 2)).toBe(2 * GUACAMOLE_WHEEL_PIXELS_PER_PAGE);
  });
});
