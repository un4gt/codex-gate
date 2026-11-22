import Box from "@mui/material/Box";
import { useEffect, useRef, useState } from "react";
import faviconFrames from "./littleGateFavicon.frames.json";

const staticLogo = "/little-gate-logo.svg";
const animatedLogo = "/little-gate-logo.webp";
const reducedMotion = "(prefers-reduced-motion: reduce)";
const logoLoopMs = 2160;

export function LittleGateLogo({ size }: { size: number }) {
  const picture = useRef<HTMLPictureElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const element = picture.current;
    if (!element) return;

    let inViewport = typeof IntersectionObserver === "undefined";
    const syncVisibility = () => setVisible(inViewport && !document.hidden);
    const observer = inViewport
      ? null
      : new IntersectionObserver(([entry]) => {
          inViewport = entry.isIntersecting;
          syncVisibility();
        });
    observer?.observe(element);
    document.addEventListener("visibilitychange", syncVisibility);
    syncVisibility();
    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", syncVisibility);
    };
  }, []);

  return (
    <Box
      component="picture"
      ref={picture}
      aria-hidden="true"
      sx={{ display: "block", flexShrink: 0, width: size, height: size }}
    >
      <Box component="source" media={reducedMotion} srcSet={staticLogo} />
      <Box
        component="img"
        src={visible ? animatedLogo : staticLogo}
        alt=""
        width={size}
        height={size}
        sx={{ display: "block" }}
      />
    </Box>
  );
}

export function useLittleGateFavicon() {
  useEffect(() => {
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!icon || typeof window.matchMedia !== "function") return;

    const initialHref = icon.getAttribute("href") ?? staticLogo;
    const initialType = icon.type;
    const preference = window.matchMedia(reducedMotion);
    let timer: number | undefined;
    let frame = 0;

    const stop = () => {
      if (timer === undefined) return;
      window.clearInterval(timer);
      timer = undefined;
      icon.type = initialType;
      icon.setAttribute("href", initialHref);
    };
    const nextFrame = () => {
      const href = `data:image/png;base64,${faviconFrames[frame]}`;
      if (icon.getAttribute("href") !== href) icon.setAttribute("href", href);
      frame = (frame + 1) % faviconFrames.length;
    };
    const syncPlayback = () => {
      if (document.hidden || preference.matches) {
        stop();
        return;
      }
      if (timer !== undefined) return;
      icon.type = "image/png";
      nextFrame();
      timer = window.setInterval(nextFrame, logoLoopMs / faviconFrames.length);
    };

    document.addEventListener("visibilitychange", syncPlayback);
    preference.addEventListener("change", syncPlayback);
    syncPlayback();
    return () => {
      document.removeEventListener("visibilitychange", syncPlayback);
      preference.removeEventListener("change", syncPlayback);
      stop();
    };
  }, []);
}
