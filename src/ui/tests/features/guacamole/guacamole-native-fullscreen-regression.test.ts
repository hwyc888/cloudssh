import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(
  join(process.cwd(), "src/ui/features/guacamole/GuacamoleApp.tsx"),
  "utf8",
);
const toolbarSource = readFileSync(
  join(process.cwd(), "src/ui/features/guacamole/GuacamoleToolbar.tsx"),
  "utf8",
);
const displaySource = readFileSync(
  join(process.cwd(), "src/ui/features/guacamole/GuacamoleDisplay.tsx"),
  "utf8",
);

describe("Guacamole native fullscreen regression guards", () => {
  it("keeps the Guacamole mouse target out of the browser fullscreen top layer", () => {
    expect(appSource).toContain("fullscreenContainerRef");
    expect(appSource).toContain(
      "await document.documentElement.requestFullscreen({",
    );
    expect(appSource).not.toContain("await container.requestFullscreen");
    expect(appSource).toContain(
      'document.addEventListener("fullscreenchange", handleFullscreenChange);',
    );
    expect(appSource).toContain('? "fixed inset-0 z-[999] w-screen h-screen"');
  });

  it("never traps local OS/browser switching while fullscreen", () => {
    expect(appSource).not.toContain("KeyboardLockNavigator");
    expect(appSource).not.toContain("keyboard?.lock");
    expect(appSource).not.toContain("requestPointerLock");
    expect(appSource).toContain(
      "The local OS and\n      // browser must always remain reachable",
    );
  });

  it("exposes the true fullscreen control only for RDP", () => {
    expect(toolbarSource).toContain('protocol === "rdp"');
    expect(toolbarSource).toContain("onToggleFullscreen");
    expect(toolbarSource).toContain('t("guacamole.toolbar.enterFullscreen")');
    expect(toolbarSource).toContain('t("guacamole.toolbar.exitFullscreen")');
  });

  it("restores the RDP overlay when fullscreen exits through ESC or browser UI", () => {
    expect(appSource).toContain("rdpFullscreenActiveRef");
    expect(appSource).toContain("rdpOwnsDocumentFullscreenRef");
    expect(appSource).toContain(
      "rdpFullscreenActiveRef.current && !document.fullscreenElement",
    );
    expect(appSource).toContain("setIsNativeFullscreen(false)");
  });

  it("refreshes viewport after the fixed/fullscreen layout changes without changing mouse ownership", () => {
    const layoutEffectStart = appSource.indexOf("useLayoutEffect(() => {");
    const layoutEffectEnd = appSource.indexOf(
      "  useEffect(() => {\n    if (!tabId)",
      layoutEffectStart,
    );
    const layoutEffect = appSource.slice(layoutEffectStart, layoutEffectEnd);

    expect(layoutEffect).toContain("displayRef.current?.refreshViewport()");
    expect(layoutEffect).toContain("requestAnimationFrame");
    expect(layoutEffect).toContain("window.setTimeout");
    expect(layoutEffect).toContain("[isNativeFullscreen, isVisible]");
    expect(displaySource).toContain("refreshViewport: () => void;");
    expect(displaySource).toContain(
      "client.sendSize(size.width, size.height);",
    );
    expect(displaySource).toContain("rescaleDisplay(true);");
    expect(displaySource).not.toContain("reconcileInput");
    expect(displaySource).not.toContain("document.elementFromPoint");
  });

  it("restores RDP input only when fullscreen returns to the normal window", () => {
    const layoutEffectStart = appSource.indexOf("useLayoutEffect(() => {");
    const layoutEffectEnd = appSource.indexOf(
      "  useEffect(() => {\n    if (!tabId)",
      layoutEffectStart,
    );
    const layoutEffect = appSource.slice(layoutEffectStart, layoutEffectEnd);

    expect(layoutEffect).toContain(
      "previousNativeFullscreenRef.current && !isNativeFullscreen",
    );
    expect(layoutEffect).toContain("displayRef.current?.restoreInput()");
    expect(displaySource).toContain("restoreInput: () => void;");
    expect(displaySource).toContain("restoreInputOnWindowFocusRef");
    expect(displaySource).toContain("focusRemoteInput();");
    expect(displaySource).not.toContain("document.elementFromPoint");
  });

  it("keeps remote resolution synchronized when the fullscreen container resizes", () => {
    expect(displaySource).toContain(
      "const resizeObserver = new ResizeObserver",
    );
    expect(displaySource).toContain(
      "clientRef.current.sendSize(size.width, size.height);",
    );
    expect(displaySource).toContain("rescaleDisplay(true);");
  });
});
