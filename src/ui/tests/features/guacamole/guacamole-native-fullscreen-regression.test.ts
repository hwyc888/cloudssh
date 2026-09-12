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

  it("uses best-effort keyboard lock and releases it on fullscreen exit", () => {
    expect(appSource).toContain('"AltLeft"');
    expect(appSource).toContain('"MetaLeft"');
    expect(appSource).toContain('"Tab"');
    expect(appSource).toContain("if (!isFullscreen) unlockKeyboard();");
  });

  it("exposes the true fullscreen control only for RDP", () => {
    expect(toolbarSource).toContain('protocol === "rdp"');
    expect(toolbarSource).toContain("onToggleFullscreen");
    expect(toolbarSource).toContain('t("guacamole.toolbar.enterFullscreen")');
    expect(toolbarSource).toContain('t("guacamole.toolbar.exitFullscreen")');
  });

  it("restores input focus only for the visible RDP after any fullscreen transition", () => {
    const fullscreenHandler = appSource.slice(
      appSource.indexOf("const handleFullscreenChange"),
      appSource.indexOf('document.addEventListener("fullscreenchange"'),
    );

    expect(fullscreenHandler).toContain("if (isVisible)");
    expect(fullscreenHandler).toContain("displayRef.current?.focus()");
    expect(displaySource).toContain("focus: () => {");
    expect(displaySource).toContain("hasKeyboardFocusRef.current = true;");
    expect(displaySource).toContain("refreshKeyboardHandlers();");
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
