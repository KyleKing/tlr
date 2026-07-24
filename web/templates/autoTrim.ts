export function autoTrim(html: string): string {
  const trimmedLines = html.split("\n").map((line) => line.replace(/^\s+/, ""))
  return trimmedLines.join("\n").replace(/\n{2,}/g, "\n").trim()
}
