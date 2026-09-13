import {
  useEffect,
  useRef,
  useState,
  useImperativeHandle,
  forwardRef,
  useCallback,
} from "react";
import Guacamole from "guacamole-common-js";
import { useTranslation } from "react-i18next";
import { getGuacamoleToken, isElectron } from "@/main-axios.ts";
import { SimpleLoader } from "@/lib/SimpleLoader.tsx";
import { getBasePath } from "@/lib/base-path.ts";
import { buildGuacamoleWebSocketBaseUrl } from "./guacamole-websocket-url.ts";
import {
  resolveConnectionOrigin,
  buildOriginWsUrl,
} from "@/lib/connection-origin.ts";
import {
  isFirefoxBrowser,
  isPasteShortcut,
  pasteTextToRemote,
} from "./guacamole-clipboard.ts";
import { getGuacamoleDisplaySize } from "./guacamole-display-size.ts";

export type GuacamoleConnectionType = "rdp" | "vnc" | "telnet";

export interface GuacamoleConnectionConfig {
  token?: string;
  protocol?: GuacamoleConnectionType;
  type?: GuacamoleConnectionType;
  hostname?: string;
  port?: number;
  username?: string;
  password?: string;
  domain?: string;
  width?: number;
  height?: number;
  dpi?: number;
  [key: string]: unknown;
}

export interface GuacamoleDisplayHandle {
  disconnect: () => void;
  isConnected: () => boolean;
  refreshViewport: () => void;
  sendKey: (keysym: number, pressed: boolean) => void;
  sendMouse: (x: number, y: number, buttonMask: number) => void;
  setClipboard: (data: string) => void;
}

export type GuacamoleTouchMode = "touchscreen" | "touchpad";

interface GuacamoleDisplayProps {
  connectionConfig: GuacamoleConnectionConfig;
  isVisible: boolean;
  touchMode?: GuacamoleTouchMode | null;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: string) => void;
}

const isDev = import.meta.env.DEV;

export const GuacamoleDisplay = forwardRef<
  GuacamoleDisplayHandle,
  GuacamoleDisplayProps
>(function GuacamoleDisplay(
  { connectionConfig, isVisible, touchMode, onConnect, onDisconnect, onError },
  ref,
) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const displayRef = useRef<HTMLDivElement>(null);
  const displayElementRef = useRef<HTMLElement | null>(null);
  const clientRef = useRef<Guacamole.Client | null>(null);
  const keyboardRef = useRef<Guacamole.Keyboard | null>(null);
  const isVisibleRef = useRef(isVisible);
  isVisibleRef.current = isVisible;
  const touchModeRef = useRef<GuacamoleTouchMode | null>(touchMode ?? null);
  touchModeRef.current = touchMode ?? null;
  const resizeTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const inputCleanupRef = useRef<(() => void) | null>(null);
  const hasKeyboardFocusRef = useRef(false);
  const windowFocusedRef = useRef(
    typeof document === "undefined" ? true : document.hasFocus(),
  );
  const lastMousePositionRef = useRef({ x: 0, y: 0, hasPosition: false });
  const pressedRemoteKeysRef = useRef(new Set<number>());
  const hasInitiatedRef = useRef(false);
  const isMountedRef = useRef(false);
  const isConnectingRef = useRef(false);
  const [isReady, setIsReady] = useState(false);
  const [hasError, setHasError] = useState(false);

  const releaseMouseButtons = useCallback(() => {
    const client = clientRef.current;
    const position = lastMousePositionRef.current;
    if (!client || !position.hasPosition) return;

    client.sendMouseState(
      new Guacamole.Mouse.State(
        position.x,
        position.y,
        false,
        false,
        false,
        false,
        false,
      ) as Guacamole.Mouse.State,
    );
  }, []);

  const releaseRemoteKeys = useCallback(() => {
    const client = clientRef.current;
    const keyboard = keyboardRef.current;

    if (client) {
      for (const keysym of pressedRemoteKeysRef.current) {
        client.sendKeyEvent(0, keysym);
      }
    }
    pressedRemoteKeysRef.current.clear();

    if (keyboard) {
      keyboard.onkeydown = null;
      keyboard.onkeyup = null;
      keyboard.reset();
    }
  }, []);

  const disconnectClient = useCallback(() => {
    const client = clientRef.current;

    inputCleanupRef.current?.();
    inputCleanupRef.current = null;
    releaseRemoteKeys();
    keyboardRef.current = null;
    hasKeyboardFocusRef.current = false;

    clientRef.current = null;
    displayElementRef.current = null;
    isConnectingRef.current = false;
    if (!client) return;

    try {
      client.disconnect();
    } catch (error) {
      console.warn("Failed to disconnect Guacamole client", error);
    }
  }, [releaseRemoteKeys]);

  const getWebSocketConnection = useCallback(
    async (
      containerWidth: number,
      containerHeight: number,
    ): Promise<{ url: string; query: string } | null> => {
      try {
        let token: string;
        const connectionProtocol =
          connectionConfig.protocol ?? connectionConfig.type;

        if (connectionConfig.token) {
          token = connectionConfig.token;
        } else {
          const data = await getGuacamoleToken({
            protocol: connectionProtocol ?? "rdp",
            hostname: String(connectionConfig.hostname ?? ""),
            port: connectionConfig.port,
            username: connectionConfig.username,
            password: connectionConfig.password,
            domain: connectionConfig.domain,
            security:
              typeof connectionConfig.security === "string"
                ? connectionConfig.security
                : undefined,
            ignoreCert:
              typeof connectionConfig.ignoreCert === "boolean"
                ? connectionConfig.ignoreCert
                : undefined,
            guacamoleConfig: connectionConfig.guacamoleConfig as Parameters<
              typeof getGuacamoleToken
            >[0]["guacamoleConfig"],
          });
          token = data.token;
        }

        const displaySize = getGuacamoleDisplaySize(
          connectionConfig.width ?? containerWidth ?? 1280,
          connectionConfig.height ?? containerHeight ?? 720,
          connectionProtocol,
          window.devicePixelRatio,
          connectionConfig.dpi,
        );

        let wsBase: string | null;
        if (isElectron()) {
          const origin = await resolveConnectionOrigin({
            connectionType: connectionProtocol,
          });
          wsBase = await buildOriginWsUrl({
            origin,
            localPort: 30008,
            localPath: "/guacamole/websocket/",
            remotePath: "/guacamole/websocket/",
            includeLocalJwt: false,
          });
          if (!wsBase) {
            onError?.(t("errors.remoteServerRequired"));
            return null;
          }
        } else {
          wsBase = buildGuacamoleWebSocketBaseUrl({
            isDev,
            isElectronApp: false,
            isEmbeddedApp: false,
            basePath: getBasePath(),
            location: window.location,
          });
        }

        const params = new URLSearchParams({
          token,
          width: String(displaySize.width),
          height: String(displaySize.height),
        });
        if (displaySize.dpi) params.set("dpi", String(displaySize.dpi));
        return { url: wsBase, query: params.toString() };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        onError?.(errorMessage);
        return null;
      }
    },
    [connectionConfig, onError, t],
  );

  const refreshKeyboardHandlers = useCallback(() => {
    const keyboard = keyboardRef.current;
    const client = clientRef.current;
    const displayElement = displayElementRef.current;

    if (!keyboard) return;

    const documentVisible =
      typeof document === "undefined" || document.visibilityState === "visible";
    const shouldCaptureInput =
      !!client &&
      !!displayElement &&
      isVisible &&
      documentVisible &&
      windowFocusedRef.current &&
      hasKeyboardFocusRef.current;

    if (!shouldCaptureInput) {
      releaseRemoteKeys();
      return;
    }

    keyboard.onkeydown = (keysym: number) => {
      if (!clientRef.current) return;
      if (!isVisible || !windowFocusedRef.current) return;

      if (!hasKeyboardFocusRef.current) return;
      clientRef.current.sendKeyEvent(1, keysym);
      pressedRemoteKeysRef.current.add(keysym);
    };

    keyboard.onkeyup = (keysym: number) => {
      if (!clientRef.current) return;
      if (!isVisible || !windowFocusedRef.current) return;

      if (!hasKeyboardFocusRef.current) return;
      clientRef.current.sendKeyEvent(0, keysym);
      pressedRemoteKeysRef.current.delete(keysym);
    };
  }, [isVisible, releaseRemoteKeys]);

  const focusRemoteInput = useCallback(() => {
    const displayElement = displayElementRef.current;
    if (!displayElement || !clientRef.current || !isVisibleRef.current) return;

    const windowFocused =
      document.visibilityState === "visible" && document.hasFocus();
    windowFocusedRef.current = windowFocused;
    if (!windowFocused) return;

    hasKeyboardFocusRef.current = true;
    if (document.activeElement !== displayElement) {
      displayElement.focus({ preventScroll: true });
    }
    refreshKeyboardHandlers();
  }, [refreshKeyboardHandlers]);

  const clearRemoteInputFocus = useCallback(() => {
    const hadRemoteFocus = hasKeyboardFocusRef.current;
    hasKeyboardFocusRef.current = false;
    if (hadRemoteFocus) releaseMouseButtons();
    refreshKeyboardHandlers();
  }, [refreshKeyboardHandlers, releaseMouseButtons]);

  const rescaleDisplay = useCallback((immediate: boolean = false) => {
    if (!clientRef.current || !containerRef.current) return;

    const performRescale = () => {
      if (!clientRef.current || !containerRef.current) return;

      const display = clientRef.current.getDisplay();
      const cWidth = containerRef.current.clientWidth;
      const cHeight = containerRef.current.clientHeight;
      const displayWidth = display.getWidth();
      const displayHeight = display.getHeight();

      if (displayWidth > 0 && displayHeight > 0 && cWidth > 0 && cHeight > 0) {
        const scale = Math.min(cWidth / displayWidth, cHeight / displayHeight);
        display.scale(scale);
      }
    };

    if (immediate) {
      performRescale();
    } else {
      if (resizeTimeoutRef.current) {
        clearTimeout(resizeTimeoutRef.current);
      }
      resizeTimeoutRef.current = setTimeout(performRescale, 200);
    }
  }, []);

  const refreshViewport = useCallback(() => {
    const client = clientRef.current;
    const container = containerRef.current;
    if (!client || !container) return;

    const rect = container.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      const size = getGuacamoleDisplaySize(
        rect.width,
        rect.height,
        connectionConfig.protocol ?? connectionConfig.type,
        window.devicePixelRatio,
        connectionConfig.dpi,
      );
      client.sendSize(size.width, size.height);
      rescaleDisplay(true);
    }
  }, [
    connectionConfig.dpi,
    connectionConfig.protocol,
    connectionConfig.type,
    rescaleDisplay,
  ]);

  useImperativeHandle(ref, () => ({
    disconnect: disconnectClient,
    isConnected: () => isReady && !hasError,
    refreshViewport,
    sendKey: (keysym: number, pressed: boolean) => {
      if (clientRef.current) {
        clientRef.current.sendKeyEvent(pressed ? 1 : 0, keysym);
      }
    },
    sendMouse: (x: number, y: number, buttonMask: number) => {
      if (clientRef.current) {
        lastMousePositionRef.current = { x, y, hasPosition: true };
        clientRef.current.sendMouseState(
          new Guacamole.Mouse.State({
            x,
            y,
            left: !!(buttonMask & 1),
            middle: !!(buttonMask & 2),
            right: !!(buttonMask & 4),
          }),
        );
      }
    },
    setClipboard: (data: string) => {
      if (clientRef.current) {
        const stream = clientRef.current.createClipboardStream("text/plain");
        const writer = new Guacamole.StringWriter(stream);
        writer.sendText(data);
        writer.sendEnd();
      }
    },
  }));

  const connect = useCallback(async () => {
    if (isConnectingRef.current) return;
    isConnectingRef.current = true;
    setIsReady(false);
    setHasError(false);

    // Let layout settle before measuring without depending on animation frames,
    // which may be throttled while Electron windows or tabs are inactive.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (!isMountedRef.current) {
      isConnectingRef.current = false;
      return;
    }

    // The tab's DOM node can still be display:none (and report 0x0) when this
    // tab is restored in the background. Measuring then would force the
    // window-size fallback, which ignores the tab bar and makes the remote
    // resolution too tall (the bottom gets cut off). Poll briefly for a real
    // size before connecting so we capture the actual visible viewport.
    const measureContainer = () => {
      const rect = containerRef.current?.getBoundingClientRect();
      return { width: rect?.width || 0, height: rect?.height || 0 };
    };

    let { width: containerWidth, height: containerHeight } = measureContainer();
    for (
      let attempt = 0;
      (containerWidth < 100 || containerHeight < 100) && attempt < 40;
      attempt++
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      if (!isMountedRef.current) {
        isConnectingRef.current = false;
        return;
      }
      ({ width: containerWidth, height: containerHeight } = measureContainer());
    }

    if (containerWidth < 100 || containerHeight < 100) {
      containerWidth = window.innerWidth || 1280;
      containerHeight = window.innerHeight || 720;
    }

    const wsConnection = await getWebSocketConnection(
      containerWidth,
      containerHeight,
    );
    if (!isMountedRef.current) {
      isConnectingRef.current = false;
      return;
    }
    if (!wsConnection) {
      isConnectingRef.current = false;
      return;
    }

    const tunnel = new Guacamole.WebSocketTunnel(wsConnection.url);
    const client = new Guacamole.Client(tunnel);
    clientRef.current = client;
    let connectWatchdog: ReturnType<typeof setTimeout> | null = null;
    const clearConnectWatchdog = () => {
      if (!connectWatchdog) return;
      clearTimeout(connectWatchdog);
      connectWatchdog = null;
    };

    const display = client.getDisplay();
    const displayElement = display.getElement();
    displayElementRef.current = displayElement;

    if (displayRef.current) {
      displayRef.current.innerHTML = "";
      displayRef.current.appendChild(displayElement);
    }

    displayElement.setAttribute("tabindex", "0");
    displayElement.style.outline = "none";
    // Hide the local cursor only while it is actually over the remote display.
    // Letterbox margins and CloudSSH UI keep the normal local cursor visible.
    displayElement.style.cursor = "none";

    const useNativePasteFallback = isFirefoxBrowser();
    if (useNativePasteFallback) {
      displayElement.addEventListener(
        "keydown",
        (event) => {
          if (isPasteShortcut(event)) {
            event.stopImmediatePropagation();
          }
        },
        true,
      );
      displayElement.addEventListener(
        "paste",
        (event) => {
          if (clientRef.current !== client) return;
          const text = event.clipboardData?.getData("text/plain");
          if (!text) return;

          event.preventDefault();
          event.stopImmediatePropagation();
          pasteTextToRemote(client, text);
        },
        true,
      );
    }

    display.onresize = () => {
      if (!isMountedRef.current || clientRef.current !== client) return;
      rescaleDisplay(true);
      setIsReady(true);
    };

    const protocol = connectionConfig.protocol ?? connectionConfig.type;
    if (protocol === "telnet" && isMountedRef.current) {
      setIsReady(true);
    }

    const sendTouchMouseEvent = (event: Guacamole.Mouse.MouseEvent) => {
      const state = event.state;
      const scale = display.getScale() || 1;
      lastMousePositionRef.current = {
        x: Math.round(state.x / scale),
        y: Math.round(state.y / scale),
        hasPosition: true,
      };
      client.sendMouseState(state, true);
    };

    const touchscreen = new Guacamole.Mouse.Touchscreen(displayElement);
    touchscreen.onEach(["mousedown", "mousemove", "mouseup"], (event) => {
      if (touchModeRef.current === "touchscreen") sendTouchMouseEvent(event);
    });

    const touchpad = new Guacamole.Mouse.Touchpad(displayElement);
    touchpad.onEach(["mousedown", "mousemove", "mouseup"], (event) => {
      if (touchModeRef.current === "touchpad") sendTouchMouseEvent(event);
    });

    const keyboard = new Guacamole.Keyboard(displayElement);
    keyboardRef.current = keyboard;

    // Keep Guacamole.Mouse as the authoritative physical mouse transport.
    // Mouse transport stays independent of keyboard/window focus. This is
    // intentionally the same model Guacamole itself uses: mouse movement is
    // forwarded whenever it reaches the display, while a click establishes
    // keyboard focus. Fullscreen transitions therefore cannot strand mouse
    // ownership in a stale focus state.
    const physicalMouse = new Guacamole.Mouse(displayElement);
    const sendPhysicalMouseState = (state: Guacamole.Mouse.State) => {
      if (clientRef.current !== client || !isVisibleRef.current) return;

      const scale = display.getScale() || 1;
      lastMousePositionRef.current = {
        x: Math.round(state.x / scale),
        y: Math.round(state.y / scale),
        hasPosition: true,
      };

      // Guacamole already knows its exact display scale. Let the client apply
      // that scale itself instead of duplicating coordinate conversion here.
      client.sendMouseState(state, true);
    };
    physicalMouse.onmousedown =
      physicalMouse.onmouseup =
      physicalMouse.onmousemove =
        sendPhysicalMouseState;

    const handleDisplayFocus = () => {
      if (!isVisibleRef.current) return;
      hasKeyboardFocusRef.current = true;
      refreshKeyboardHandlers();
    };

    const handleDisplayBlur = () => {
      clearRemoteInputFocus();
    };

    const handleDisplayPointerStart = () => {
      focusRemoteInput();
    };

    const cleanupCallbacks: Array<() => void> = [];
    const listen = <K extends keyof HTMLElementEventMap>(
      type: K,
      listener: (event: HTMLElementEventMap[K]) => void,
      options?: AddEventListenerOptions | boolean,
    ) => {
      displayElement.addEventListener(type, listener as EventListener, options);
      cleanupCallbacks.push(() =>
        displayElement.removeEventListener(
          type,
          listener as EventListener,
          options,
        ),
      );
    };

    listen("focus", handleDisplayFocus);
    listen("blur", handleDisplayBlur);
    listen("mousedown", handleDisplayPointerStart);
    listen("touchstart", handleDisplayPointerStart, { passive: true });

    inputCleanupRef.current?.();
    inputCleanupRef.current = () => {
      for (const cleanup of cleanupCallbacks) cleanup();
    };
    refreshKeyboardHandlers();

    client.onstatechange = (state: number) => {
      if (!isMountedRef.current || clientRef.current !== client) return;
      switch (state) {
        case 0:
          break;
        case 1:
          break;
        case 2:
          break;
        case 3:
          clearConnectWatchdog();
          isConnectingRef.current = false;
          setIsReady(true);
          onConnect?.();
          if (containerRef.current) {
            const rect = containerRef.current.getBoundingClientRect();
            const size = getGuacamoleDisplaySize(
              rect.width,
              rect.height,
              protocol,
              window.devicePixelRatio,
              connectionConfig.dpi,
            );
            client.sendSize(size.width, size.height);
          }
          rescaleDisplay(false);
          break;
        case 4:
          break;
        case 5:
          clearConnectWatchdog();
          isConnectingRef.current = false;
          setIsReady(false);
          setHasError(true);
          clearRemoteInputFocus();
          onError?.(t("guacamole.connectionError"));
          onDisconnect?.();
          break;
      }
    };

    client.onerror = (error: Guacamole.Status) => {
      if (!isMountedRef.current || clientRef.current !== client) return;
      clearConnectWatchdog();
      const errorMessage = error.message || t("guacamole.connectionError");
      setIsReady(false);
      setHasError(true);
      isConnectingRef.current = false;
      clearRemoteInputFocus();
      onError?.(errorMessage);
    };

    client.onclipboard = (stream: Guacamole.InputStream, mimetype: string) => {
      if (mimetype === "text/plain") {
        const reader = new Guacamole.StringReader(stream);
        let data = "";
        reader.ontext = (text: string) => {
          data += text;
        };
        reader.onend = () => {
          navigator.clipboard?.writeText?.(data).catch(() => {});
        };
      }
    };

    client.onaudio = (stream: Guacamole.InputStream, mimetype: string) => {
      Guacamole.AudioPlayer.getInstance(stream, mimetype);
    };

    client.onfile = (
      stream: Guacamole.InputStream,
      mimetype: string,
      filename: string,
    ) => {
      const reader = new Guacamole.BlobReader(stream, mimetype);
      reader.onend = () => {
        const blob = reader.getBlob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
      };
      stream.sendAck("OK", Guacamole.Status.Code.SUCCESS);
    };

    try {
      connectWatchdog = setTimeout(() => {
        if (
          !isMountedRef.current ||
          clientRef.current !== client ||
          !isConnectingRef.current
        ) {
          return;
        }

        disconnectClient();
        void connect();
      }, 8000);
      client.connect(wsConnection.query);
    } catch (error) {
      clearConnectWatchdog();
      isConnectingRef.current = false;
      if (!isMountedRef.current) return;
      setIsReady(false);
      setHasError(true);
      onError?.(
        error instanceof Error ? error.message : t("guacamole.connectionError"),
      );
    }
  }, [
    getWebSocketConnection,
    onConnect,
    onDisconnect,
    onError,
    refreshKeyboardHandlers,
    rescaleDisplay,
    disconnectClient,
    clearRemoteInputFocus,
    focusRemoteInput,
    connectionConfig.protocol,
    connectionConfig.type,
    connectionConfig.dpi,
    t,
  ]);

  useEffect(() => {
    isMountedRef.current = true;

    if (isVisible && !hasInitiatedRef.current) {
      hasInitiatedRef.current = true;
      connect();
    }
  }, [isVisible, connect]);

  useEffect(() => {
    if (!isVisible) {
      clearRemoteInputFocus();
      return;
    }

    refreshKeyboardHandlers();
  }, [isVisible, clearRemoteInputFocus, refreshKeyboardHandlers]);

  useEffect(() => {
    const handleWindowFocus = () => {
      windowFocusedRef.current = true;
      refreshKeyboardHandlers();
    };

    const handleWindowBlur = () => {
      windowFocusedRef.current = false;
      clearRemoteInputFocus();
    };

    const handleVisibilityChange = () => {
      windowFocusedRef.current =
        document.visibilityState === "visible" && document.hasFocus();
      if (document.visibilityState !== "visible") {
        clearRemoteInputFocus();
        return;
      }

      refreshKeyboardHandlers();
    };

    window.addEventListener("focus", handleWindowFocus);
    window.addEventListener("blur", handleWindowBlur);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("focus", handleWindowFocus);
      window.removeEventListener("blur", handleWindowBlur);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [clearRemoteInputFocus, refreshKeyboardHandlers]);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      hasInitiatedRef.current = false;
      isConnectingRef.current = false;
      if (resizeTimeoutRef.current) {
        clearTimeout(resizeTimeoutRef.current);
      }
      disconnectClient();
      displayElementRef.current = null;
    };
  }, [disconnectClient]);

  useEffect(() => {
    if (!containerRef.current) return;

    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current);
      resizeTimeoutRef.current = setTimeout(() => {
        if (clientRef.current && containerRef.current) {
          const rect = containerRef.current.getBoundingClientRect();
          const size = getGuacamoleDisplaySize(
            rect.width,
            rect.height,
            connectionConfig.protocol ?? connectionConfig.type,
            window.devicePixelRatio,
            connectionConfig.dpi,
          );
          if (rect.width > 0 && rect.height > 0) {
            clientRef.current.sendSize(size.width, size.height);
            rescaleDisplay(true);
          }
        }
      }, 150);
    });

    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
    };
  }, [
    connectionConfig.dpi,
    connectionConfig.protocol,
    connectionConfig.type,
    rescaleDisplay,
  ]);

  const syncClipboard = useCallback(() => {
    const client = clientRef.current;
    if (!client || isFirefoxBrowser() || !navigator.clipboard?.readText) return;
    navigator.clipboard
      .readText()
      .then((text) => {
        if (text) {
          const stream = client.createClipboardStream("text/plain");
          const writer = new Guacamole.StringWriter(stream);
          writer.sendText(text);
          writer.sendEnd();
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (isVisible && isReady) {
      syncClipboard();
    }
  }, [isVisible, isReady, syncClipboard]);

  const connectingMessage = t("guacamole.connecting", {
    type: (
      connectionConfig.protocol ||
      connectionConfig.type ||
      "remote"
    ).toUpperCase(),
  });

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 overflow-hidden"
      style={{ backgroundColor: "var(--bg-base)" }}
    >
      <div
        ref={displayRef}
        className="relative w-full h-full flex items-center justify-center"
        style={{
          visibility: isReady ? "visible" : "hidden",
        }}
      />

      <SimpleLoader
        visible={!isReady && !hasError}
        message={connectingMessage}
      />
    </div>
  );
});
