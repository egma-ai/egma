/** SGR mouse clicks, enabled only while a screen has something clickable. */

import { useEffect, useRef } from "react";
import { useStdin, useStdout } from "ink";

import { mousePressesIn, type MousePress } from "./mouse-input.ts";

const ENABLE_MOUSE = "\u001B[?1000h\u001B[?1006h";
const DISABLE_MOUSE = "\u001B[?1006l\u001B[?1000l";
/**
 * Report terminal clicks while mounted and restore the terminal mode on exit.
 * Terminals without SGR mouse support ignore the mode sequences; keyboard use
 * remains complete in either case.
 */
export function useMousePress(onPress: (press: MousePress) => void): void {
  const { stdin } = useStdin();
  const { stdout } = useStdout();
  const onPressRef = useRef(onPress);
  onPressRef.current = onPress;

  useEffect(() => {
    if (stdin.isTTY !== true || stdout.isTTY !== true) return;

    let pending = "";
    const onData = (data: Buffer | string): void => {
      const whole = pending + data.toString();
      for (const press of mousePressesIn(whole)) onPressRef.current(press);

      const lastStart = whole.lastIndexOf("\u001B[<");
      const tail = lastStart < 0 ? "" : whole.slice(lastStart);
      pending = /[Mm]/u.test(tail) ? "" : tail.slice(0, 64);
    };

    stdout.write(ENABLE_MOUSE);
    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
      stdout.write(DISABLE_MOUSE);
    };
  }, [stdin, stdout]);
}
