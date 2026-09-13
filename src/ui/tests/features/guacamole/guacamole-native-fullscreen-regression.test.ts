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
  it("requests fullscreen on the RDP container instead of the whole app", () => {
    expect(appSource).toContain("fullscreenContainerRef");
    expect(appSource).toContain(
      'await container.requestFullscreen({ navigationUI: "hide" });',
    );
    expect(appSource).toContain(
      'document.addEventListener("fullscreenchange", handleFullscreenChange);',
    );
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

  it("refreshes viewport geometry after fullscreen without changing mouse ownership", () => {
    const fullscreenHandler = appSource.slice(
      appSource.indexOf("const handleFullscreenChange"),
      appSource.indexOf('document.addEventListener("fullscreenchange"'),
    );

    expect(fullscreenHandler).toContain("if (!isVisible) return;");
    expect(fullscreenHandler).toContain(
      "displayRef.current?.refreshViewport()",
    );
    expect(fullscreenHandler).toContain("requestAnimationFrame");
    expect(fullscreenHandler).toContain("window.setTimeout");
    expect(displaySource).toContain("refreshViewport: () => void;");
    expect(displaySource).toContain(
      "client.sendSize(size.width, size.height);",
    );
    expect(displaySource).toContain("rescaleDisplay(true);");
    expect(displaySource).not.toContain("reconcileInput");
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
