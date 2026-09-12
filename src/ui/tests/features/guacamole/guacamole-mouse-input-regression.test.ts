import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "src/ui/features/guacamole/GuacamoleDisplay.tsx"),
  "utf8",
);

describe("Guacamole mouse input regression guards", () => {
  it("registers the physical mouse independently of touch mode", () => {
    const mouseRegistration = source.indexOf(
      "const mouse = new Guacamole.Mouse(displayElement);",
    );
    const touchModeBranch = source.indexOf('if (touchMode === "touchscreen")');

    expect(mouseRegistration).toBeGreaterThan(-1);
    expect(touchModeBranch).toBeGreaterThan(-1);
    expect(mouseRegistration).toBeLessThan(touchModeBranch);
  });

  it("releases remote mouse buttons when focus is lost", () => {
    const windowBlurHandler = source.slice(
      source.indexOf("const handleWindowBlur"),
      source.indexOf("const handleVisibilityChange"),
    );
    const displayBlurHandler = source.slice(
      source.indexOf("const handleDisplayBlur"),
      source.indexOf('displayElement.addEventListener("focus"'),
    );

    expect(windowBlurHandler).toContain("releaseMouseButtons();");
    expect(displayBlurHandler).toContain("releaseMouseButtons();");
  });
});
