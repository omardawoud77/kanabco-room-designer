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
  onTokenChange: (token: string | null) => void;
  resetNonce: number;
};

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

export function Turnstile({ siteKey, onTokenChange, resetNonce }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const callbackRef = useRef(onTokenChange);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    callbackRef.current = onTokenChange;
  }, [onTokenChange]);

  useEffect(() => {
    if (!siteKey) return;
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
  }, [siteKey]);

  useEffect(() => {
    if (resetNonce > 0 && widgetIdRef.current && window.turnstile) {
      window.turnstile.reset(widgetIdRef.current);
      callbackRef.current(null);
    }
  }, [resetNonce]);

  return (
    <div className="turnstile-control">
      <div ref={hostRef} aria-label="Security verification" />
      {failed && (
        <p role="alert" className="field-error">
          Verification could not load. Check your connection and refresh the page.
        </p>
      )}
    </div>
  );
}
