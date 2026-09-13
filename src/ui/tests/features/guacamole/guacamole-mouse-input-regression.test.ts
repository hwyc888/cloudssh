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
  it("uses native pointer events for physical mouse/pen input on modern browsers", () => {
    expect(displaySource).toContain(
      'if (typeof window.PointerEvent === "function")',
    );
    expect(displaySource).toContain(
      'listen("pointerenter", handlePointerEnter)',
    );
    expect(displaySource).toContain('listen("pointermove", handlePointerMove)');
    expect(displaySource).toContain('listen("pointerdown", handlePointerDown)');
    expect(displaySource).toContain('listen("pointerup", handlePointerUp)');
    expect(displaySource).toContain(
      'listen("pointerleave", handlePointerLeave)',
    );
    expect(displaySource).toContain('event.pointerType !== "touch"');
    expect(displaySource).toContain(
      "const fallbackMouse = new Guacamole.Mouse(displayElement);",
    );
  });

  it("switches touch mouse mode without remounting or reconnecting RDP", () => {
    expect(appSource).toContain("key={token}");
    expect(appSource).not.toContain("key={`${token}-${touchMode}`}");
    expect(displaySource).toContain('touchModeRef.current === "touchscreen"');
    expect(displaySource).toContain('touchModeRef.current === "touchpad"');
  });

  it("reactivates RDP input from pointer movement instead of depending on stale DOM focus", () => {
    const activatePointer = displaySource.slice(
      displaySource.indexOf("const activatePhysicalPointer"),
      displaySource.indexOf("const handleDisplayFocus"),
    );

    expect(activatePointer).toContain(
      "pointerInsideDisplayRef.current = true;",
    );
    expect(activatePointer).toContain("focusRemoteInput();");
    expect(activatePointer).toContain("sendPhysicalMouseState");
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

  it("releases remote input ownership whenever the pointer/window leaves RDP", () => {
    const pointerLeaveHandler = displaySource.slice(
      displaySource.indexOf("const handlePointerLeave"),
      displaySource.indexOf("const handlePointerCancel"),
    );
    const windowBlurHandler = displaySource.slice(
      displaySource.indexOf("const handleWindowBlur"),
      displaySource.indexOf("const handleVisibilityChange"),
    );

    expect(pointerLeaveHandler).toContain(
      "pointerInsideDisplayRef.current = false;",
    );
    expect(pointerLeaveHandler).toContain("clearRemoteInputFocus(false);");
    expect(displaySource).toContain('listen("lostpointercapture", () => {');
    expect(displaySource).toContain(
      "releaseMouseButtons();\n        reconcileInput();",
    );
    expect(windowBlurHandler).toContain("rememberRemoteOwnership();");
    expect(windowBlurHandler).toContain("clearRemoteInputFocus(true);");
    expect(displaySource).toContain("releaseMouseButtons();");
  });

  it("reconciles current pointer hit-testing after local, window, fullscreen, or layout changes", () => {
    expect(displaySource).toContain("document.elementFromPoint");
    expect(displaySource).toContain("displayElement.contains(hit)");
    expect(displaySource).toContain("reconcileInput: () => void;");
    expect(displaySource).toContain(
      "updateGlobalPointer(event.clientX, event.clientY);\n      reconcileInput();",
    );
    expect(appSource).toContain("displayRef.current?.reconcileInput()");
  });

  it("maps physical mouse coordinates from the current rendered display geometry", () => {
    expect(displaySource).toContain("mapClientPointToRemote(");
    expect(displaySource).toContain("displayElement.getBoundingClientRect()");
    expect(displaySource).toContain("display.getWidth()");
    expect(displaySource).toContain("display.getHeight()");
  });
});
