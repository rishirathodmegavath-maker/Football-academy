import Image from "next/image";

/**
 * The official Sportozen platform symbol (public/brand/sportozen-logo.png, supplied by the owner).
 * Platform branding only: an academy's own crest or logo is separate (see portal-shell.tsx).
 * Decorative: the wordmark beside it carries the name. Size it with CSS (height; width follows).
 */
export function SportozenSymbol({ className = "" }: { className?: string }) {
  return (
    <Image
      className={`sportozen-symbol ${className}`.trim()}
      src="/brand/sportozen-logo.png"
      alt=""
      width={259}
      height={313}
      unoptimized
      priority
    />
  );
}
