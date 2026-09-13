import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const displaySource = readFileSync(
  join(process.cwd(), "src/ui/features/guacamole/GuacamoleDisplay.tsx"),
  "utf8",
);
const appSource = readFileSync(
  join(process.cwd(), "src/ui/features/guacamole/GuacamoleApp.tsx"),
  "utf8",
);

describe("Guacamole mouse input regression guards", () => {
  it("keeps Guacamole.Mouse as the authoritative physical mouse transport", () => {
    expect(displaySource).toContain(
      "const physicalMouse = new Guacamole.Mouse(displayElement);",
    );
    expect(displaySource).toContain(
      "physicalMouse.onmousedown =\n      physicalMouse.onmouseup =\n      physicalMouse.onmousemove =\n        sendPhysicalMouseState;",
    );
    expect(displaySource).toContain("const scale = display.getScale() || 1;");
    expect(displaySource).toContain("client.sendMouseState(state, true);");
    expect(displaySource).not.toContain("setPointerCapture(");
    expect(displaySource).not.toContain(
      "sendPhysicalMouseState(\n      clientX",
    );
  });

  it("switches touch mouse mode without remounting or reconnecting RDP", () => {
    expect(appSource).toContain("key={token}");
    expect(appSource).not.toContain("key={`${token}-${touchMode}`}");
    expect(displaySource).toContain('touchModeRef.current === "touchscreen"');
    expect(displaySource).toContain('touchModeRef.current === "touchpad"');
  });

  it("keeps mouse transport independent from keyboard focus and only focuses on an actual click", () => {
    expect(displaySource).toContain(
      'listen("mousedown", handleDisplayPointerStart)',
    );
    expect(displaySource).toContain(
      'listen("touchstart", handleDisplayPointerStart, { passive: true })',
    );
    expect(displaySource).not.toContain(
      'listen("mouseenter", claimRemoteInput)',
    );
    expect(displaySource).not.toContain(
      'listen("mousemove", claimRemoteInput)',
    );
    expect(displaySource).not.toContain("document.elementFromPoint");
    expect(displaySource).not.toContain(
      'window.addEventListener("mousemove", handleGlobalMouse, true)',
    );
  });

  it("releases pressed remote modifier keys before local input takes over", () => {
    expect(displaySource).toContain("pressedRemoteKeysRef.current.add(keysym)");
    expect(displaySource).toContain(
      "pressedRemoteKeysRef.current.delete(keysym)",
    );
    expect(displaySource).toContain(
      "for (const keysym of pressedRemoteKeysRef.current)",
    );
    expect(displaySource).toContain("client.sendKeyEvent(0, keysym)");
    expect(displaySource).toContain("pressedRemoteKeysRef.current.clear()");
  });

  it("releases remote keyboard/buttons when browser focus leaves RDP without installing global mouse capture", () => {
    const windowBlurHandler = displaySource.slice(
      displaySource.indexOf("const handleWindowBlur"),
      displaySource.indexOf("const handleVisibilityChange"),
    );
    expect(windowBlurHandler).toContain("clearRemoteInputFocus();");
    expect(displaySource).toContain("releaseMouseButtons();");
    expect(displaySource).not.toContain("lastClientPointerRef");
    expect(displaySource).not.toContain("pointerInsideDisplayRef");
  });

  it("keeps fullscreen/layout changes limited to viewport refresh instead of mouse ownership", () => {
    expect(appSource).toContain("displayRef.current?.refreshViewport()");
    expect(displaySource).toContain("refreshViewport: () => void;");
    expect(displaySource).not.toContain("reconcileInput");
    expect(displaySource).not.toContain("elementFromPoint");
  });

  it("does not perform clipboard reads whenever the mouse merely re-enters RDP", () => {
    expect(displaySource).not.toContain(
      'container.addEventListener("mouseenter", handleFocus)',
    );
  });

  it("keeps the local cursor available outside the actual remote display", () => {
    expect(displaySource).toContain('displayElement.style.cursor = "none";');
    expect(displaySource).not.toContain('cursor: isReady ? "none" : "default"');
  });

  it("does not replace the proven mouse transport with Pointer Events", () => {
    expect(displaySource).not.toContain('listen("pointermove"');
    expect(displaySource).not.toContain('listen("pointerdown"');
    expect(displaySource).not.toContain("event.pointerType");
    expect(displaySource).not.toContain("requestPointerLock");
  });
});
