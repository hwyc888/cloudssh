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

  it("reclaims keyboard ownership whenever the physical mouse enters or moves inside RDP", () => {
    expect(displaySource).toContain('listen("mouseenter", claimRemoteInput)');
    expect(displaySource).toContain('listen("mousemove", claimRemoteInput)');
    expect(displaySource).toContain('listen("mousedown", claimRemoteInput)');
    expect(displaySource).toContain(
      "pointerInsideDisplayRef.current = true;\n      focusRemoteInput();",
    );
    expect(displaySource).not.toContain(
      "hasKeyboardFocusRef.current || displayIsFocused",
    );
    expect(displaySource).toContain("hasKeyboardFocusRef.current;");
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

  it("releases remote input ownership whenever the mouse/window leaves RDP", () => {
    expect(displaySource).toContain('listen("mouseleave", releaseRemoteInput)');
    expect(displaySource).toContain(
      "pointerInsideDisplayRef.current = false;\n      clearRemoteInputFocus(false);",
    );

    const windowBlurHandler = displaySource.slice(
      displaySource.indexOf("const handleWindowBlur"),
      displaySource.indexOf("const handleVisibilityChange"),
    );
    expect(windowBlurHandler).toContain("rememberRemoteOwnership();");
    expect(windowBlurHandler).toContain("clearRemoteInputFocus(true);");
    expect(displaySource).toContain("releaseMouseButtons();");
  });

  it("reconciles current mouse hit-testing after window, fullscreen, or layout changes", () => {
    expect(displaySource).toContain("document.elementFromPoint");
    expect(displaySource).toContain("displayElement.contains(hit)");
    expect(displaySource).toContain("reconcileInput: () => void;");
    expect(displaySource).toContain(
      "updateGlobalPointer(event.clientX, event.clientY);\n      reconcileInput();",
    );
    expect(displaySource).toContain(
      'window.addEventListener("mousemove", handleGlobalMouse, true)',
    );
    expect(appSource).toContain("displayRef.current?.refreshViewport()");
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
