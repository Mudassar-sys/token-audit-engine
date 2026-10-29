/** Save a Blob as a file through a temporary object URL. Nothing leaves the browser. */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.rel = 'noopener'
  a.hidden = true
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export function saveJson(value: unknown, fileName: string): void {
  saveBlob(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }), fileName)
}

/** File-name-safe stem of a source file name. */
export function fileStem(name: string): string {
  const base = name.replace(/\.[^.]+$/, '')
  return base.replace(/[^\w.-]+/g, '-').slice(0, 80) || 'audit'
}
