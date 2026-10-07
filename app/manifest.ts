import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "devin-web",
    short_name: "devin-web",
    description: "Web interface for Devin CLI sessions",
    start_url: "/",
    display: "standalone",
    background_color: "#090b11",
    theme_color: "#090b11",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  };
}
