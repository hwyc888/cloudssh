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
  it("registers the physical mouse independently of touch mode", () => {
    expect(displaySource).toContain(
      "const mouse = new Guacamole.Mouse(displayElement);",
    );
    expect(displaySource).toContain(
      "const touchscreen = new Guacamole.Mouse.Touchscreen(displayElement);",
    );
    expect(displaySource).toContain(
      "const touchpad = new Guacamole.Mouse.Touchpad(displayElement);",
    );
  });

  it("switches touch mouse mode without remounting or reconnecting RDP", () => {
    expect(appSource).toContain("key={token}");
    expect(appSource).not.toContain("key={`${token}-${touchMode}`}");
    expect(displaySource).toContain('touchModeRef.current === "touchscreen"');
    expect(displaySource).toContain('touchModeRef.current === "touchpad"');
  });

  it("releases remote mouse buttons when focus is lost", () => {
    const windowBlurHandler = displaySource.slice(
      displaySource.indexOf("const handleWindowBlur"),
      displaySource.indexOf("const handleVisibilityChange"),
    );
    const displayBlurHandler = displaySource.slice(
      displaySource.indexOf("const handleDisplayBlur"),
      displaySource.indexOf('displayElement.addEventListener("focus"'),
    );

    expect(windowBlurHandler).toContain("releaseMouseButtons();");
    expect(displayBlurHandler).toContain("releaseMouseButtons();");
  });
});
