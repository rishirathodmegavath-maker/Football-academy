// The invoice and receipt PDFs are rendered with pdf-lib and fontkit, which load
// on first use. Measured cold, that load is 1-1.5 s of a 2.8-4.2 s render in a
// full run (about 0.5 s alone) because every core is busy, and a render once
// exceeded the 5 s test limit. Call this from a beforeAll hook so the load is
// paid outside a test's time limit; tests still render real PDFs and keep all
// of their assertions.
export async function warmPdfRenderer(): Promise<void> {
  await Promise.all([
    import("pdf-lib"),
    import("@pdf-lib/fontkit"),
    import("@/server/finance-document"),
  ]);
}
