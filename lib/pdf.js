// PDF capture through the public webview API. It stays disabled unless the packaged smoke test has run:
// a PDF is a print rendering, not an identical screenshot of the screen.
const pdfFail = (code, message) => Object.assign(new Error(message), { code })
export const PDF_POLICY = Object.freeze({ enabledByDefault: false, requiresPackagedSmokeTest: true, identicalToScreenshot: false })
export const PDF_LIMITS = Object.freeze({ maxBytes: 32 * 1024 * 1024, pageSizes: ['A4', 'A3', 'A5', 'Legal', 'Letter', 'Tabloid'] })
/** Build validated print options; refuses anything the webview API does not accept. */
export function printOptions({ landscape = false, pageSize = 'A4', printBackground = true, scale = 1, margins = {} } = {}) {
  if (typeof landscape !== 'boolean' || typeof printBackground !== 'boolean') throw pdfFail('INVALID_ARGUMENT', 'landscape and printBackground must be booleans.')
  if (!PDF_LIMITS.pageSizes.includes(pageSize)) throw pdfFail('INVALID_ARGUMENT', `pageSize must be one of ${PDF_LIMITS.pageSizes.join(', ')}.`)
  if (!Number.isFinite(scale) || scale < 0.1 || scale > 2) throw pdfFail('INVALID_ARGUMENT', 'scale must be 0.1–2.')
  const clean = {}
  for (const key of ['top', 'bottom', 'left', 'right']) {
    const value = margins?.[key]
    if (value === undefined) continue
    if (!Number.isFinite(value) || value < 0 || value > 2) throw pdfFail('INVALID_ARGUMENT', `margin ${key} must be 0–2 inches.`)
    clean[key] = value
  }
  return { landscape, pageSize, printBackground, scale, ...(Object.keys(clean).length ? { margins: clean } : {}), headerTemplate: '', footerTemplate: '' }
}
/** Wrap the webview print call: bounded bytes, explicit failure, and a note that it is not a screenshot. */
export async function capturePdf(webview, options) {
  if (!webview || typeof webview.printToPDF !== 'function') throw pdfFail('CAPABILITY_UNAVAILABLE', 'printToPDF is not available on this webview.')
  const print = printOptions(options)
  const buffer = await webview.printToPDF(print)
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer ?? [])
  if (bytes.byteLength === 0) throw pdfFail('PDF_FAILED', 'The webview returned no PDF.')
  if (bytes.byteLength > PDF_LIMITS.maxBytes) throw pdfFail('PDF_TOO_LARGE', 'PDF exceeds the size bound.')
  return { bytes, mediaType: 'application/pdf', options: print, identicalToScreenshot: false, note: 'Print rendering, not an identical screen capture.' }
}
/** Gate used by the Client: PDF stays unavailable until the packaged smoke test is recorded. */
export function pdfAvailable({ smokeTested } = {}) {
  return smokeTested === true
}
