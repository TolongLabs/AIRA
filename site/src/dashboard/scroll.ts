export function scrollSurface(): Element {
  return document.getElementById('workspace') ?? document.scrollingElement ?? document.documentElement
}
