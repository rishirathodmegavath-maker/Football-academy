import { z } from "zod";
// Zod compiles faster parsers with `new Function`, after probing whether the
// browser allows it. Under a strict Content-Security-Policy the probe is blocked
// and REPORTED as a violation even though Zod catches it. In the browser we skip
// the probe and the compilation; the server keeps both. Import this module
// before any module that creates schemas in code that also runs in the browser.
if (typeof window !== "undefined") z.config({ jitless: true });
