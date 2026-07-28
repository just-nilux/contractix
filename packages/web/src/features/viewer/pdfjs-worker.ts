import { pdfjs } from "react-pdf";

// `?url` gives Vite the emitted asset's URL. Not `?worker`, which returns a
// constructor pdf.js does not want, and not `new URL(bare-specifier,
// import.meta.url)`, which Vite cannot statically resolve for a bare package.
// A wrong choice here fails at build time, which the CI build job catches.
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";

/**
 * Imported once for its side effect, before any `<Document>` mounts. pdf.js
 * parses in a worker; without this it silently falls back to the main thread and
 * a 25 MB scan would freeze the tab.
 */
pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
