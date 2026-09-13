import Guacamole from "guacamole-common-js";
import { afterEach, describe, expect, it } from "vitest";

const mounted: HTMLElement[] = [];

afterEach(() => {
  for (const element of mounted.splice(0)) element.remove();
});

describe("Guacamole physical mouse runtime", () => {
  it("delivers real DOM mouse movement and button state through Guacamole.Mouse", () => {
    const element = document.createElement("div");
    document.body.appendChild(element);
    mounted.push(element);

    const mouse = new Guacamole.Mouse(element);
    const moves: Array<{ x: number; y: number }> = [];
    const downs: boolean[] = [];
    const ups: boolean[] = [];

    mouse.onmousemove = (state) => moves.push({ x: state.x, y: state.y });
    mouse.onmousedown = (state) => downs.push(state.left);
    mouse.onmouseup = (state) => ups.push(state.left);

    element.dispatchEvent(
      new MouseEvent("mousemove", {
        clientX: 320,
        clientY: 180,
        bubbles: true,
      }),
    );
    element.dispatchEvent(
      new MouseEvent("mousedown", {
        clientX: 320,
        clientY: 180,
        button: 0,
        buttons: 1,
        bubbles: true,
      }),
    );
    element.dispatchEvent(
      new MouseEvent("mouseup", {
        clientX: 320,
        clientY: 180,
        button: 0,
        buttons: 0,
        bubbles: true,
      }),
    );

    expect(moves).toEqual([{ x: 320, y: 180 }]);
    expect(downs).toEqual([true]);
    expect(ups).toEqual([false]);
  });
});
