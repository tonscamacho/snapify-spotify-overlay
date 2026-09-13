import { useEffect } from "react";
import { ensureLensMaps } from "../lib/lens";

/**
 * Hidden SVG lens maps for Chromium only. Never display:none: a
 * display:none subtree tears down the filter primitives. Zero-size
 * with absolute positioning keeps them alive without layout cost.
 * One filter per size bucket because padding math depends on box size.
 */
export default function LensDefs() {
  useEffect(() => {
    ensureLensMaps();
  }, []);

  const common = {
    x: "-20%",
    y: "-20%",
    width: "140%",
    height: "260%",
    colorInterpolationFilters: "sRGB" as const,
  };

  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true" focusable="false">
      <filter id="lg-lens-sm" {...common}>
        <feImage id="lgMap-sm" x="0" y="0" width="248" height="180" preserveAspectRatio="none" result="map" />
        <feDisplacementMap
          id="lgDisp-sm"
          in="SourceGraphic"
          in2="map"
          scale="40"
          xChannelSelector="R"
          yChannelSelector="G"
        />
      </filter>
      <filter id="lg-lens-md" {...common}>
        <feImage id="lgMap-md" x="0" y="0" width="360" height="420" preserveAspectRatio="none" result="map" />
        <feDisplacementMap
          id="lgDisp-md"
          in="SourceGraphic"
          in2="map"
          scale="42"
          xChannelSelector="R"
          yChannelSelector="G"
        />
      </filter>
      <filter id="lg-lens-lg" {...common}>
        <feImage id="lgMap-lg" x="0" y="0" width="480" height="640" preserveAspectRatio="none" result="map" />
        <feDisplacementMap
          id="lgDisp-lg"
          in="SourceGraphic"
          in2="map"
          scale="48"
          xChannelSelector="R"
          yChannelSelector="G"
        />
      </filter>
    </svg>
  );
}
