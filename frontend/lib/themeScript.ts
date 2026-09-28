/**
 * The theme setting (System / Light / Dark), kept in this browser. The script below runs in <head>
 * before the first paint and sets <html data-theme="light|dark"> (and data-theme-pref), so the page
 * never flashes the wrong colors. lib/themeMode.ts keeps it up to date after that. No React here:
 * the root layout (a server component) imports it.
 */

export const THEME_KEY = "bs-theme";

/** Browser bar color per theme (the app background). */
export const THEME_BAR = { light: "#ffffff", dark: "#202124" } as const;

export const THEME_SCRIPT = `(function(){try{var d=document.documentElement,p=null;try{p=localStorage.getItem("${THEME_KEY}")}catch(e){}if(p!=="light"&&p!=="dark")p="system";var t=p==="system"?(window.matchMedia&&matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):p;d.setAttribute("data-theme",t);d.setAttribute("data-theme-pref",p)}catch(e){}})()`;
