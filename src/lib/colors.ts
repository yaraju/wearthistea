export const COLOR_MAP: Record<string, string> = {
  "Black": "#000000",
  "White": "#FFFFFF",
  "Almond": "#E9DABF",
  "Navy Blue": "#1B223E",
  "Royal Blue": "#002366",
  "Red": "#D32F2F",
  "Maroon": "#800000",
  "Grey": "#9E9E9E",
  "Charcoal": "#333333",
  "Yellow": "#FBC02D",
  "Orange": "#F57C00",
  "Green": "#2E7D32",
  "Purple": "#7B1FA2",
  "Pink": "#F06292",
  "Sky Blue": "#81D4FA",
  "Olive Green": "#556B2F",
  "Sand": "#C2B280",
  "Bottle Green": "#006A4E",
};

export function getColorCode(color: string): string {
  if (!color) return "transparent";
  const normalized = color.trim();
  // Case-insensitive lookup
  const key = Object.keys(COLOR_MAP).find(k => k.toLowerCase() === normalized.toLowerCase());
  if (key) return COLOR_MAP[key];
  
  // Basic fallbacks for CSS color names
  return normalized.toLowerCase().replace(/\s+/g, '');
}
