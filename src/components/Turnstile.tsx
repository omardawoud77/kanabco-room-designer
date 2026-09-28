"use client";

import { useEffect, useRef, useState } from "react";

type TurnstileApi = {
  render: (
    element: HTMLElement,
    options: {
      sitekey: string;
      action: "room_design";
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": () => void;
      theme: "light";
    },
  ) => string;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

type Props = {
  siteKey: string;
  localTestMode: boolean;
  onTokenChange: (token: string | null) => void;
  resetNonce: number;
};

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

export function Turnstile({ siteKey, localTestMode, onTokenChange, resetNonce }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const callbackRef = useRef(onTokenChange);
  const localMintGeneration = useRef(0);
  const [failed, setFailed] = useState(false);
  const [localTestReady, setLocalTestReady] = useState(false);
  const [preparingLocalTest, setPreparingLocalTest] = useState(false);
  const showLocalTestMode = process.env.NODE_ENV === "development" && localTestMode && siteKey === "1x00000000000000000000AA";

  useEffect(() => {
    callbackRef.current = onTokenChange;
  }, [onTokenChange]);

  useEffect(() => {
    if (!siteKey || showLocalTestMode) return;
    let cancelled = false;
    let script: HTMLScriptElement | null = null;
    setFailed(false);

    const onError = () => {
      if (!cancelled) setFailed(true);
    };

    const render = () => {
      if (cancelled || !hostRef.current || !window.turnstile || widgetIdRef.current) return;
      try {
        widgetIdRef.current = window.turnstile.render(hostRef.current, {
          sitekey: siteKey,
          action: "room_design",
          theme: "light",
          callback: (token) => {
            setFailed(false);
            callbackRef.current(token);
          },
          "expired-callback": () => callbackRef.current(null),
          "error-callback": () => {
            callbackRef.current(null);
            setFailed(true);
          },
        });
      } catch {
        setFailed(true);
      }
    };

    if (window.turnstile) {
      render();
    } else {
      script = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_URL}"]`);
      if (!script) {
        script = document.createElement("script");
        script.src = SCRIPT_URL;
        script.async = true;
        script.defer = true;
        document.head.appendChild(script);
      }
      script.addEventListener("load", render);
      script.addEventListener("error", onError);
    }

    return () => {
      cancelled = true;
      script?.removeEventListener("load", render);
      script?.removeEventListener("error", onError);
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
  }, [siteKey, showLocalTestMode]);

  useEffect(() => {
    if (resetNonce > 0 && widgetIdRef.current && window.turnstile) {
      window.turnstile.reset(widgetIdRef.current);
      callbackRef.current(null);
    }
    if (resetNonce > 0) {
      localMintGeneration.current += 1;
      setLocalTestReady(false);
      setPreparingLocalTest(false);
    }
  }, [resetNonce]);

  async function prepareLocalTest() {
    if (!showLocalTestMode || preparingLocalTest) return;
    const generation = ++localMintGeneration.current;
    callbackRef.current(null);
    setLocalTestReady(false);
    setPreparingLocalTest(true);
    setFailed(false);
    try {
      const response = await fetch("/api/local-turnstile", {
        method: "POST",
        credentials: "same-origin",
        headers: { "X-Requested-With": "website" },
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Local verification unavailable");
      const data: unknown = await response.json();
      if (!data || typeof data !== "object" || typeof (data as { token?: unknown }).token !== "string") {
        throw new Error("Local verification unavailable");
      }
      if (generation !== localMintGeneration.current) return;
      callbackRef.current((data as { token: string }).token);
      setLocalTestReady(true);
    } catch {
      if (generation === localMintGeneration.current) setFailed(true);
    } finally {
      if (generation === localMintGeneration.current) setPreparingLocalTest(false);
    }
  }

  return (
    <div className="turnstile-control">
      {!showLocalTestMode && <div ref={hostRef} aria-label="Security verification" />}
      {failed && (
        <p role="alert" className="field-error">
          {showLocalTestMode ? "Local test verification could not be prepared. Check the local server and try again." : "Verification could not load. Check your connection and refresh the page."}
        </p>
      )}
      {showLocalTestMode && (
        <div className="local-test-control">
          <button type="button" disabled={preparingLocalTest} onClick={() => { void prepareLocalTest(); }}>
            {preparingLocalTest ? "Preparing local verification…" : "Use local test verification"}
          </button>
          <span role="status">{localTestReady ? "Test token ready for one local request." : "Development only · Cloudflare test keys"}</span>
        </div>
      )}
    </div>
  );
}
