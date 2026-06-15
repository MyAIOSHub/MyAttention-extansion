function r(n){const t=typeof n=="number"?n:typeof n=="string"?Number(n):Number.NaN;return Number.isFinite(t)?Math.min(5e3,Math.max(0,Math.round(t))):0}export{r as n};
